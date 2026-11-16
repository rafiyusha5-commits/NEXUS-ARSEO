-- Batch cost as the weighted average of its receipts (audit 2026-10-13, finding Н6; replaces PR #36).
--
-- A shipment item is one product in one vehicle, so a batch that arrives in two vehicles of one shipment
-- (or in two shipments) has two receipts with their own approved unit cost. Approval used to write into the
-- batch only the cost of its source item (the first receipt): the expenses of the other vehicle never reached
-- the cost of the stock.
--
-- Rule from this migration on, for future approvals, future receipts and an explicit administrator action:
--   every receipt movement of the batch is costed by the latest approved calculation of its shipment item;
--   the batch gets the weighted average over its receipts, in the receipts' unit when they share one,
--   otherwise per piece through the explicit product packaging;
--   while any receipt has no approved cost, or the costs are in different currencies, the batch has no cost
--   ("себестоимость не утверждена") instead of the cost of one receipt.
-- The calculation rules (customs-declaration rate, paid quantity, exact allocation) are not touched: they
-- define the unit cost of each item; only the step "item cost -> batch cost" changes.
--
-- Batches costed before this migration keep their cost. They are marked cost_basis='source_item' with the
-- unit of their source item; an administrator may recalculate one batch at a time with preview and reason.
-- No existing cost value is changed by this migration.
begin;

alter table public.inventory_batches
  add column if not exists cost_uom text check (cost_uom in ('piece','box','layer','pallet','truck'));

alter table public.inventory_batches
  add column if not exists cost_basis text check (cost_basis in ('source_item','receipts'));

-- Metadata only: the old rule stored the unit cost of the source item, in that item's unit.
update public.inventory_batches b
   set cost_basis = 'source_item',
       cost_uom = i.uom
  from public.shipment_items i
 where i.id = b.source_shipment_item_id
   and b.unit_landed_cost is not null
   and b.cost_basis is null;

insert into public.permissions(code, module, action, name, description)
values ('costing.batch_recalculate', 'costing', 'batch_recalculate', 'Себестоимость: пересчёт партии',
        'Пересчёт себестоимости одной партии по её приходам с предпросмотром и причиной')
on conflict (code) do nothing;

insert into public.role_permissions(role_id, permission_id, granted)
select r.id, p.id, true
  from public.app_roles r
  cross join public.permissions p
 where r.code = 'administrator'
   and p.code = 'costing.batch_recalculate'
on conflict (role_id, permission_id) do nothing;

-- Batches whose cost an approval changes: received by an item of the calculation or created by one.
create or replace function private.calculation_cost_batches(p_calculation_id uuid)
returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.batch_id
    from public.inventory_movements m
    join public.cost_calculation_items ci on ci.shipment_item_id = m.shipment_item_id
   where ci.calculation_id = p_calculation_id
     and m.movement_type = 'receipt'
  union
  select b.id
    from public.inventory_batches b
    join public.cost_calculation_items ci on ci.shipment_item_id = b.source_shipment_item_id
   where ci.calculation_id = p_calculation_id
$$;
revoke all on function private.calculation_cost_batches(uuid) from public, anon, authenticated, service_role;

-- Receipts of a batch with the approved cost of each. With p_assume_calculation_id the items of that
-- calculation use it as if it were approved (the assistant preview shows the result before approval).
create or replace function private.batch_cost_sources(p_batch_id uuid, p_assume_calculation_id uuid default null)
returns table(shipment_item_id uuid, uom text, quantity numeric, unit_cost numeric, currency_id uuid,
              calculation_id uuid, approved_at timestamptz, pieces numeric)
language sql stable security definer set search_path = '' as $$
  with batch as (
    select id, product_id, source_shipment_item_id from public.inventory_batches where id = p_batch_id
  ), receipts as (
    select m.shipment_item_id, m.uom,
           sum(case when m.is_reversal then -m.quantity else m.quantity end) as quantity
      from public.inventory_movements m
     where m.batch_id = p_batch_id
       and m.movement_type = 'receipt'
     group by m.shipment_item_id, m.uom
    having sum(case when m.is_reversal then -m.quantity else m.quantity end) > 0
  ), sources as (
    select r.shipment_item_id, r.uom, r.quantity from receipts r
    union all
    -- A batch created before receipt movements were recorded is costed by its source item, as before.
    select i.id, i.uom, 1::numeric
      from batch b join public.shipment_items i on i.id = b.source_shipment_item_id
     where not exists (select 1 from receipts)
  )
  select s.shipment_item_id, s.uom, s.quantity, a.unit_landed_cost, a.currency_id, a.calculation_id, a.approved_at,
         private.uom_pieces((select product_id from batch), s.uom)
    from sources s
    left join lateral (
      select x.unit_landed_cost, x.currency_id, x.calculation_id, x.approved_at
        from (
          select ci.unit_landed_cost, ci.currency_id, c.id as calculation_id,
                 coalesce(c.approved_at, clock_timestamp()) as approved_at, 0 as priority
            from public.cost_calculation_items ci
            join public.cost_calculations c on c.id = ci.calculation_id
           where ci.shipment_item_id = s.shipment_item_id
             and c.id = p_assume_calculation_id
          union all
          select ci.unit_landed_cost, ci.currency_id, c.id, c.approved_at, 1
            from public.cost_calculation_items ci
            join public.cost_calculations c on c.id = ci.calculation_id
           where ci.shipment_item_id = s.shipment_item_id
             and c.status = 'approved'
             and (p_assume_calculation_id is null
                  or c.shipment_id is distinct from (select shipment_id from public.cost_calculations where id = p_assume_calculation_id))
        ) x
       order by x.priority, x.approved_at desc nulls last
       limit 1
    ) a on s.shipment_item_id is not null
$$;
revoke all on function private.batch_cost_sources(uuid, uuid) from public, anon, authenticated, service_role;

-- The cost a batch should carry under the receipt rule. A null cost means "not approved" or "not comparable".
create or replace function private.batch_cost_target(p_batch_id uuid, p_assume_calculation_id uuid default null)
returns table(unit_landed_cost numeric, cost_uom text, cost_currency_id uuid, cost_calculation_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_lines integer;
  v_missing integer;
  v_currencies integer;
  v_uoms integer;
  v_unconvertible integer;
  v_uom text;
  v_currency uuid;
  v_calculation uuid;
  v_amount numeric;
  v_quantity numeric;
  v_pieces numeric;
begin
  select count(*),
         count(*) filter (where s.unit_cost is null),
         count(distinct s.currency_id),
         count(distinct s.uom),
         count(*) filter (where s.pieces is null),
         min(s.uom),
         min(s.currency_id::text)::uuid,
         (array_agg(s.calculation_id order by s.approved_at desc nulls last, s.calculation_id))[1],
         sum(s.quantity * s.unit_cost),
         sum(s.quantity),
         sum(s.quantity * s.pieces)
    into v_lines, v_missing, v_currencies, v_uoms, v_unconvertible, v_uom, v_currency, v_calculation,
         v_amount, v_quantity, v_pieces
    from private.batch_cost_sources(p_batch_id, p_assume_calculation_id) s;

  if v_lines = 0 or v_missing > 0 or v_currencies <> 1 then
    return query select null::numeric, null::text, null::uuid, null::uuid;
  elsif v_uoms = 1 then
    return query select round(v_amount / v_quantity, 4), v_uom, v_currency, v_calculation;
  elsif v_unconvertible = 0 and v_pieces > 0 then
    return query select round(v_amount / v_pieces, 4), 'piece'::text, v_currency, v_calculation;
  else
    return query select null::numeric, null::text, null::uuid, null::uuid;
  end if;
end $$;
revoke all on function private.batch_cost_target(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function private.refresh_batch_cost(p_batch_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_batch public.inventory_batches;
  v_target record;
begin
  -- The batch row serializes a receipt, an approval and an administrator recalculation of one batch.
  select * into v_batch from public.inventory_batches where id = p_batch_id for update;
  if not found then
    return;
  end if;
  select * into v_target from private.batch_cost_target(p_batch_id);
  if v_target.unit_landed_cost is distinct from v_batch.unit_landed_cost
     or v_target.cost_uom is distinct from v_batch.cost_uom
     or v_target.cost_currency_id is distinct from v_batch.cost_currency_id
     or v_target.cost_calculation_id is distinct from v_batch.cost_calculation_id
     or v_batch.cost_basis is distinct from 'receipts' then
    update public.inventory_batches
       set unit_landed_cost = v_target.unit_landed_cost,
           cost_uom = v_target.cost_uom,
           cost_currency_id = v_target.cost_currency_id,
           cost_calculation_id = v_target.cost_calculation_id,
           cost_basis = 'receipts',
           updated_at = now()
     where id = p_batch_id;
  end if;
end $$;
revoke all on function private.refresh_batch_cost(uuid) from public, anon, authenticated, service_role;

-- A new receipt into a batch: until the new goods are approved the batch has no approved cost.
create or replace function private.refresh_batch_cost_on_receipt()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.refresh_batch_cost(new.batch_id);
  return null;
end $$;
revoke all on function private.refresh_batch_cost_on_receipt() from public, anon, authenticated, service_role;

drop trigger if exists refresh_batch_cost_on_receipt on public.inventory_movements;
create trigger refresh_batch_cost_on_receipt
  after insert on public.inventory_movements
  for each row when (new.movement_type = 'receipt')
  execute function private.refresh_batch_cost_on_receipt();

-- Identical to 202609279100 except the last statement: the batches of the calculation's items are refreshed
-- by the receipt rule instead of copying the cost of the source item.
create or replace function public.approve_shipment_cost(p_calculation_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare c record;v_batch uuid;begin
 if not (select private.has_permission('costing.approve')) then raise exception 'Нет права утверждать себестоимость';end if;
 if not (select private.has_permission('prices.purchase.view')) then raise exception 'Нет доступа к себестоимости' using errcode='42501';end if;
 lock table public.expenses, public.shipment_items, public.expense_allocations in exclusive mode;
 lock table public.documents, public.document_links, public.document_types, public.exchange_rates in share mode;
 select * into c from public.cost_calculations where id=p_calculation_id and status='draft' for update;if not found then raise exception 'Расчёт не найден или уже утверждён';end if;
 if c.inputs_digest is null then raise exception 'Расчёт сделан по прежним правилам: рассчитайте новую версию';end if;
 -- Table locks protect both existing rows and new inputs until approval commits.
 -- Do not take expense row locks here: writers can already own them while waiting
 -- for the table lock, which would invert the locking order.
 if c.inputs_digest<>private.shipment_cost_inputs_digest(c.shipment_id) then
  raise exception 'После расчёта изменились расходы или позиции поставки, декларация или курсы: рассчитайте новую версию';end if;
 if exists(select 1 from public.cost_calculation_items where calculation_id=c.id and goods_rate_basis='calculation') then
  raise exception 'Расчёт предварительный: подтвердите таможенную декларацию с датой и рассчитайте новую версию';end if;
 update public.cost_calculations set status='superseded' where shipment_id=c.shipment_id and status='approved';
 update public.cost_calculations set status='approved',approved_by=auth.uid(),approved_at=now() where id=c.id;
 for v_batch in select b from private.calculation_cost_batches(c.id) b order by b loop
  perform private.refresh_batch_cost(v_batch);
 end loop;
end $$;
revoke all on function public.approve_shipment_cost(uuid) from public, anon, authenticated, service_role;
grant execute on function public.approve_shipment_cost(uuid) to authenticated;

-- The assistant shows every batch the approval changes, with the cost it will get, and checks the result
-- against that preview. Identical to 202610240900 except the batch list and the expected batch cost.
create or replace function private.assistant_cost_approval_preview(p jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c public.cost_calculations;s public.shipments;cu public.currencies;lines jsonb;batches jsonb;previous jsonb;stamp jsonb;
begin
 perform private.require_assistant_cost_approval_access();
 if jsonb_typeof(p) is distinct from 'object' then raise exception 'ASSISTANT_COST_APPROVAL_INVALID';end if;
 if (select count(*) from jsonb_object_keys(p))<>1 or jsonb_typeof(p->'calculation_id') is distinct from 'string' then raise exception 'ASSISTANT_COST_APPROVAL_INVALID';end if;
 select * into c from public.cost_calculations where id=(p->>'calculation_id')::uuid;
 if c.id is null or c.status<>'draft' then raise exception 'ASSISTANT_COST_APPROVAL_STATE';end if;
 select * into s from public.shipments where id=c.shipment_id;
 select * into cu from public.currencies where id=c.currency_id;
 if s.status='cancelled' or cu.is_active is not true then raise exception 'ASSISTANT_COST_APPROVAL_STATE';end if;
 if c.inputs_digest is null or c.inputs_digest<>private.shipment_cost_inputs_digest(c.shipment_id) then raise exception 'ASSISTANT_COST_APPROVAL_STALE';end if;
 if exists(select 1 from public.cost_calculation_items where calculation_id=c.id and goods_rate_basis='calculation') then raise exception 'ASSISTANT_COST_APPROVAL_PRELIMINARY';end if;
 if (select count(*) from public.cost_calculation_items where calculation_id=c.id) not between 1 and 200 then raise exception 'ASSISTANT_COST_APPROVAL_LIMIT';end if;
 if (select count(*) from private.calculation_cost_batches(c.id))>200 then raise exception 'ASSISTANT_COST_APPROVAL_LIMIT';end if;
 select jsonb_agg(jsonb_build_object('item_id',i.shipment_item_id,'product',coalesce(pr.name->>'ru',pr.name->>'en',pr.internal_sku),
 'sku',pr.internal_sku,'quantity',i.quantity::text,'cost_quantity',i.cost_quantity::text,'cost_quantity_basis',i.cost_quantity_basis,
 'uom',si.uom,'goods_amount',i.goods_amount::text,'expenses',i.allocated_expenses::text,'total',i.landed_amount::text,
 'unit_cost',i.unit_landed_cost::text,'rate',i.goods_rate::text,'rate_date',i.goods_rate_date,'rate_basis',i.goods_rate_basis) order by i.shipment_item_id)
 into lines from public.cost_calculation_items i join public.products pr on pr.id=i.product_id
 join public.shipment_items si on si.id=i.shipment_item_id where i.calculation_id=c.id;
 select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'batch',b.batch_number,'product',coalesce(pr.name->>'ru',pr.name->>'en',pr.internal_sku),
 'old_cost',b.unit_landed_cost::text,'old_currency',bc.code,'old_version',old.version_number,
 'new_cost',t.unit_landed_cost::text,'new_currency',nc.code,'new_uom',t.cost_uom,'new_calculation',t.cost_calculation_id) order by b.id),'[]'::jsonb)
 into batches from private.calculation_cost_batches(c.id) sb(id)
 join public.inventory_batches b on b.id=sb.id
 join public.products pr on pr.id=b.product_id
 cross join lateral private.batch_cost_target(b.id,c.id) t
 left join public.currencies bc on bc.id=b.cost_currency_id
 left join public.currencies nc on nc.id=t.cost_currency_id
 left join public.cost_calculations old on old.id=b.cost_calculation_id;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version_number) order by version_number),'[]'::jsonb)
 into previous from public.cost_calculations where shipment_id=c.shipment_id and status='approved';
 stamp:=jsonb_build_object('calculation',to_jsonb(c),'shipment',to_jsonb(s),'currency',to_jsonb(cu),'inputs',private.shipment_cost_inputs_digest(c.shipment_id),
 'lines',(select jsonb_agg(to_jsonb(i) order by id) from public.cost_calculation_items i where calculation_id=c.id),
 'versions',(select jsonb_agg(to_jsonb(v) order by id) from public.cost_calculations v where shipment_id=c.shipment_id),
 'batches',(select jsonb_agg(to_jsonb(b) order by b.id) from private.calculation_cost_batches(c.id) sb(id) join public.inventory_batches b on b.id=sb.id));
 return jsonb_build_object('calculation_id',c.id,'shipment_number',s.shipment_number,'version',c.version_number,'currency',cu.code,
 'goods_total',c.goods_total::text,'expenses_total',c.expenses_total::text,'landed_total',c.landed_total::text,
 'calculated_at',c.calculated_at,'lines',lines,'batches',batches,'previous',previous,
 'performer',(select full_name from public.profiles where id=auth.uid()),'state_stamp',encode(sha256(convert_to(stamp::text,'UTF8')),'hex'));
exception when invalid_text_representation then raise exception 'ASSISTANT_COST_APPROVAL_INVALID';
end $$;
revoke all on function private.assistant_cost_approval_preview(jsonb) from public, anon, authenticated, service_role;

create or replace function private.confirm_assistant_before_expense_cancellation(p_request_id uuid, p_review_token uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r private.assistant_operations;v jsonb;cid uuid;sid uuid;actual jsonb;expected jsonb;
begin
 select * into r from private.assistant_operations where id=p_request_id and created_by=auth.uid() for update;
 if not found or p_review_token is null or r.review_token<>p_review_token then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.kind<>'shipment_cost_approve' then return private.confirm_assistant_before_cost_approval(p_request_id,p_review_token);end if;
 perform private.require_assistant_cost_approval_access();
 if r.result_calculation_id is not null then return public.review_assistant_operation(r.id);end if;
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 lock table public.expenses,public.shipment_items,public.expense_allocations in exclusive mode;
 lock table public.documents,public.document_links,public.document_types,public.exchange_rates,public.products,public.currencies,public.cost_calculation_items in share mode;
 cid:=(r.payload->>'calculation_id')::uuid;
 select shipment_id into sid from public.cost_calculations where id=cid for update;
 lock table public.inventory_batches in share row exclusive mode;
 perform 1 from public.shipments where id=sid for share;
 perform 1 from public.profiles where id=auth.uid() for share;
 perform private.require_assistant_cost_approval_access();
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 v:=private.assistant_cost_approval_preview(r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 begin
  perform public.approve_shipment_cost(cid);
  if not exists(select 1 from public.cost_calculations where id=cid and status='approved' and approved_by=auth.uid() and approved_at is not null)
   or (select count(*) from public.cost_calculations where shipment_id=sid and status='approved')<>1
   or exists(select 1 from jsonb_array_elements(v->'previous')p where not exists(select 1 from public.cost_calculations where id=(p->>'id')::uuid and status='superseded'))
  then raise exception 'Approval differs from preview';end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'cost',b.unit_landed_cost,'uom',b.cost_uom,'currency',b.cost_currency_id,'calculation',b.cost_calculation_id) order by b.id),'[]'::jsonb)
  into actual from private.calculation_cost_batches(cid) sb(id) join public.inventory_batches b on b.id=sb.id;
  select coalesce(jsonb_agg(jsonb_build_object('id',(b->>'id')::uuid,'cost',(b->>'new_cost')::numeric,'uom',b->>'new_uom',
   'currency',(select id from public.currencies where code=b->>'new_currency'),'calculation',(b->>'new_calculation')::uuid) order by b->>'id'),'[]'::jsonb)
  into expected from jsonb_array_elements(v->'batches')b;
  if actual is distinct from expected then raise exception 'Batch cost differs from preview';end if;
 exception when others then raise exception 'ASSISTANT_COST_APPROVAL_REFUSED';end;
 update private.assistant_operations set confirmed_at=clock_timestamp(),result_calculation_id=cid where id=r.id;
 return public.review_assistant_operation(r.id);
end $$;
revoke all on function private.confirm_assistant_before_expense_cancellation(uuid, uuid) from public, anon, authenticated, service_role;

-- Batch cost with its unit, currency and basis. my_inventory_batch_costs keeps its result type for old callers.
create or replace function public.my_batch_landed_costs(p_product_id uuid default null)
returns table(batch_id uuid, unit_landed_cost numeric, cost_uom text, cost_currency_id uuid, cost_currency_code text,
              cost_calculation_id uuid, cost_basis text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (select private.has_permission('inventory.view')) or not (select private.has_permission('prices.purchase.view')) then
    raise exception 'Нет доступа к себестоимости' using errcode = '42501';
  end if;
  return query
    select b.id, b.unit_landed_cost, b.cost_uom, b.cost_currency_id, cur.code::text, b.cost_calculation_id, b.cost_basis
      from public.inventory_batches b
      left join public.currencies cur on cur.id = b.cost_currency_id
     where p_product_id is null or b.product_id = p_product_id;
end $$;
revoke all on function public.my_batch_landed_costs(uuid) from public, anon, authenticated, service_role;
grant execute on function public.my_batch_landed_costs(uuid) to authenticated;

create or replace function private.require_batch_cost_recalculation() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (select private.has_permission('costing.batch_recalculate'))
     or not (select private.has_permission('prices.purchase.view'))
     or not (select private.has_permission('inventory.view')) then
    raise exception 'Нет права пересчитывать себестоимость партии' using errcode = '42501';
  end if;
end $$;
revoke all on function private.require_batch_cost_recalculation() from public, anon, authenticated, service_role;

-- Preview of a recalculation: was, will be, and the receipts it is made of. Writes nothing.
create or replace function public.batch_cost_recalculation_preview(p_batch_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  b public.inventory_batches;
  t record;
  sources jsonb;
  stamp jsonb;
begin
  perform private.require_batch_cost_recalculation();
  select * into b from public.inventory_batches where id = p_batch_id;
  if not found then
    raise exception 'Партия не найдена';
  end if;
  select * into t from private.batch_cost_target(p_batch_id);
  select coalesce(jsonb_agg(jsonb_build_object(
           'shipment_item_id', s.shipment_item_id,
           'shipment_number', sh.shipment_number,
           'vehicle', tr.sequence_no,
           'uom', s.uom,
           'quantity', s.quantity::text,
           'unit_cost', s.unit_cost::text,
           'currency', cur.code,
           'calculation_id', s.calculation_id,
           'calculation_version', c.version_number,
           'approved', s.unit_cost is not null)
         order by sh.shipment_number, tr.sequence_no, s.shipment_item_id), '[]'::jsonb)
    into sources
    from private.batch_cost_sources(p_batch_id) s
    left join public.shipment_items si on si.id = s.shipment_item_id
    left join public.shipments sh on sh.id = si.shipment_id
    left join public.shipment_transports tr on tr.id = si.shipment_transport_id
    left join public.currencies cur on cur.id = s.currency_id
    left join public.cost_calculations c on c.id = s.calculation_id;
  stamp := jsonb_build_object('batch', to_jsonb(b), 'sources', sources);
  return jsonb_build_object(
    'batch_id', b.id,
    'batch_number', b.batch_number,
    'old', jsonb_build_object('cost', b.unit_landed_cost::text, 'uom', b.cost_uom,
                              'currency', (select code from public.currencies where id = b.cost_currency_id),
                              'calculation_id', b.cost_calculation_id, 'basis', b.cost_basis),
    'new', jsonb_build_object('cost', t.unit_landed_cost::text, 'uom', t.cost_uom,
                              'currency', (select code from public.currencies where id = t.cost_currency_id),
                              'calculation_id', t.cost_calculation_id, 'basis', 'receipts'),
    'changes', t.unit_landed_cost is distinct from b.unit_landed_cost
               or t.cost_uom is distinct from b.cost_uom
               or t.cost_currency_id is distinct from b.cost_currency_id
               or t.cost_calculation_id is distinct from b.cost_calculation_id
               or b.cost_basis is distinct from 'receipts',
    'sources', sources,
    'stamp', encode(sha256(convert_to(stamp::text, 'UTF8')), 'hex'));
end $$;
revoke all on function public.batch_cost_recalculation_preview(uuid) from public, anon, authenticated, service_role;
grant execute on function public.batch_cost_recalculation_preview(uuid) to authenticated;

-- One batch, by the receipt rule, with a reason, only if nothing changed since the preview.
create or replace function public.recalculate_batch_cost(p_batch_id uuid, p_stamp text, p_reason text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_reason text := nullif(btrim(p_reason), '');
  v_before public.inventory_batches;
  v_after public.inventory_batches;
  v_preview jsonb;
begin
  perform private.require_batch_cost_recalculation();
  if v_reason is null or length(v_reason) not between 10 and 1000 then
    raise exception 'Укажите причину пересчёта (от 10 до 1000 символов)';
  end if;
  if p_stamp is null or p_stamp !~ '^[0-9a-f]{64}$' then
    raise exception 'Откройте предпросмотр пересчёта заново';
  end if;
  -- Same leading locks as the approval: no calculation input or batch changes under the recalculation.
  lock table public.expenses, public.shipment_items, public.expense_allocations in exclusive mode;
  select * into v_before from public.inventory_batches where id = p_batch_id for update;
  if not found then
    raise exception 'Партия не найдена';
  end if;
  perform private.require_batch_cost_recalculation();
  v_preview := public.batch_cost_recalculation_preview(p_batch_id);
  if v_preview->>'stamp' is distinct from p_stamp then
    raise exception 'Данные партии изменились после предпросмотра. Откройте предпросмотр заново' using errcode = '40001';
  end if;
  if not (v_preview->>'changes')::boolean then
    raise exception 'Себестоимость партии не изменится';
  end if;
  perform private.refresh_batch_cost(p_batch_id);
  select * into v_after from public.inventory_batches where id = p_batch_id;
  insert into public.audit_log(actor_user_id, action, entity_type, entity_id, before_data, after_data, metadata)
  values (auth.uid(), 'batch_cost_recalculation', 'inventory_batches', p_batch_id::text,
          jsonb_build_object('unit_landed_cost', v_before.unit_landed_cost, 'cost_uom', v_before.cost_uom,
                             'cost_currency_id', v_before.cost_currency_id, 'cost_calculation_id', v_before.cost_calculation_id,
                             'cost_basis', v_before.cost_basis),
          jsonb_build_object('unit_landed_cost', v_after.unit_landed_cost, 'cost_uom', v_after.cost_uom,
                             'cost_currency_id', v_after.cost_currency_id, 'cost_calculation_id', v_after.cost_calculation_id,
                             'cost_basis', v_after.cost_basis),
          jsonb_build_object('source', 'batch_cost_recalculation', 'reason', v_reason, 'sources', v_preview->'sources'));
  return v_preview - 'stamp';
end $$;
revoke all on function public.recalculate_batch_cost(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.recalculate_batch_cost(uuid, text, text) to authenticated;

commit;
