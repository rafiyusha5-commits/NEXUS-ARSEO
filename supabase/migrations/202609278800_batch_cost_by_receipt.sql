-- The cost of a batch is the weighted average of its receipts, in a stated unit. Audit 2026-10-13, finding Н6.
--
-- approve_shipment_cost wrote the unit cost of a shipment item into the batches whose source_shipment_item_id was that
-- item. A batch keeps the first item that brought it (receiving the same batch again keeps the source), so:
--   approving the second shipment of a batch did not change the batch;
--   approving the first one set its price for the goods of the second one too;
--   one number "per unit" was stored for a batch whose stock is in pieces and in boxes.
--
-- Now the cost lives at the receipt: each receipt movement is a shipment item, a quantity and a unit, and the approved
-- calculation of that item gives its cost per that unit. The batch carries the weighted average over all its receipts:
--   in the unit of the receipts when they share one, else per piece (converted through the product packaging);
--   only when every receipt has an approved cost, in one currency; otherwise no cost (it waits for the approval).
-- It is recalculated when a receipt comes and when a calculation is approved. A batch with no receipt movement
-- (created before movements were recorded) keeps the cost of its source item, as before.
begin;

alter table public.inventory_batches
  add column if not exists cost_uom text check (cost_uom in ('piece','box','layer','pallet','truck'));

create or replace function private.refresh_batch_cost(p_batch_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare
  v_batch record;
  v_lines integer; v_missing integer; v_currencies integer; v_uoms integer; v_unconvertible integer;
  v_uom text; v_currency uuid; v_calculation uuid; v_amount numeric; v_quantity numeric; v_pieces numeric;
  v_cost numeric; v_cost_uom text;
begin
  -- The batch row serializes a receipt and an approval of the same batch: each sees the other once it commits.
  select id,product_id,source_shipment_item_id,unit_landed_cost,cost_uom,cost_currency_id,cost_calculation_id into v_batch
  from public.inventory_batches where id=p_batch_id for update;
  if not found then return; end if;

  with receipts as (
    select m.shipment_item_id item,m.uom,sum(case when m.is_reversal then -m.quantity else m.quantity end) quantity
    from public.inventory_movements m where m.batch_id=p_batch_id and m.movement_type='receipt'
    group by m.shipment_item_id,m.uom
    having sum(case when m.is_reversal then -m.quantity else m.quantity end)>0
  ), sources as (
    select item,uom,quantity from receipts
    union all
    select i.id,i.uom,1 from public.shipment_items i where i.id=v_batch.source_shipment_item_id and not exists(select 1 from receipts)
  ), costed as (
    select s.item,s.uom,s.quantity,a.unit_landed_cost cost,a.currency_id,a.calculation_id,a.approved_at,
      private.uom_pieces(v_batch.product_id,s.uom) pieces
    from sources s
    left join lateral (
      select ci.unit_landed_cost,ci.currency_id,c.id calculation_id,c.approved_at
      from public.cost_calculation_items ci join public.cost_calculations c on c.id=ci.calculation_id
      where ci.shipment_item_id=s.item and c.status='approved'
      order by c.approved_at desc nulls last limit 1
    ) a on s.item is not null
  )
  select count(*),count(*) filter (where cost is null),count(distinct currency_id),count(distinct uom),count(*) filter (where pieces is null),
    min(uom),min(currency_id::text)::uuid,
    (array_agg(calculation_id order by approved_at desc nulls last))[1],
    sum(quantity*cost),sum(quantity),sum(quantity*pieces)
  into v_lines,v_missing,v_currencies,v_uoms,v_unconvertible,v_uom,v_currency,v_calculation,v_amount,v_quantity,v_pieces
  from costed;

  if v_lines=0 or v_missing>0 or v_currencies<>1 then
    v_cost:=null; v_cost_uom:=null; v_currency:=null; v_calculation:=null;
  elsif v_uoms=1 then
    v_cost:=round(v_amount/v_quantity,4); v_cost_uom:=v_uom;
  elsif v_unconvertible=0 and v_pieces>0 then
    v_cost:=round(v_amount/v_pieces,4); v_cost_uom:='piece';
  else
    v_cost:=null; v_cost_uom:=null; v_currency:=null; v_calculation:=null;
  end if;

  if v_cost is distinct from v_batch.unit_landed_cost or v_cost_uom is distinct from v_batch.cost_uom
     or v_currency is distinct from v_batch.cost_currency_id or v_calculation is distinct from v_batch.cost_calculation_id then
    update public.inventory_batches set unit_landed_cost=v_cost,cost_uom=v_cost_uom,cost_currency_id=v_currency,
      cost_calculation_id=v_calculation,updated_at=now()
    where id=p_batch_id;
  end if;
end $$;
revoke all on function private.refresh_batch_cost(uuid) from public,anon,authenticated,service_role;

create or replace function private.refresh_batch_cost_on_receipt()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform private.refresh_batch_cost(new.batch_id);
  return null;
end $$;
revoke all on function private.refresh_batch_cost_on_receipt() from public,anon,authenticated,service_role;
drop trigger if exists refresh_batch_cost_on_receipt on public.inventory_movements;
create trigger refresh_batch_cost_on_receipt after insert on public.inventory_movements
  for each row when (new.movement_type='receipt') execute function private.refresh_batch_cost_on_receipt();

create or replace function public.approve_shipment_cost(p_calculation_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare c record;v_batch uuid;begin
 if not (select private.has_permission('costing.approve')) then raise exception 'Нет права утверждать себестоимость';end if;
 if not (select private.has_permission('prices.purchase.view')) then raise exception 'Нет доступа к себестоимости' using errcode='42501';end if;
 lock table public.expenses, public.shipment_items, public.expense_allocations in exclusive mode;
 select * into c from public.cost_calculations where id=p_calculation_id and status='draft' for update;if not found then raise exception 'Расчёт не найден или уже утверждён';end if;
 if c.inputs_digest is null then raise exception 'Расчёт сделан по прежним правилам: рассчитайте новую версию';end if;
 -- Table locks protect both existing rows and new inputs until approval commits.
 -- Do not take expense row locks here: writers can already own them while waiting
 -- for the table lock, which would invert the locking order.
 if c.inputs_digest<>private.shipment_cost_inputs_digest(c.shipment_id) then
  raise exception 'После расчёта изменились расходы или позиции поставки: рассчитайте новую версию';end if;
 update public.cost_calculations set status='superseded' where shipment_id=c.shipment_id and status='approved';
 -- The moment of the approval itself, so two approvals in one transaction (a script, a test) keep their order.
 update public.cost_calculations set status='approved',approved_by=auth.uid(),approved_at=clock_timestamp() where id=c.id;
 -- Every batch this shipment brought, also one received again by another shipment: its average is recalculated.
 for v_batch in
  select m.batch_id from public.inventory_movements m join public.shipment_items i on i.id=m.shipment_item_id
  where i.shipment_id=c.shipment_id and m.movement_type='receipt'
  union
  select b.id from public.inventory_batches b join public.shipment_items i on i.id=b.source_shipment_item_id
  where i.shipment_id=c.shipment_id
  order by 1
 loop
  perform private.refresh_batch_cost(v_batch);
 end loop;
end $$;
revoke all on function public.approve_shipment_cost(uuid) from public,anon,authenticated,service_role;
grant execute on function public.approve_shipment_cost(uuid) to authenticated;

-- The cost of batches with its unit and currency. my_inventory_batch_costs keeps its shape for existing callers.
create or replace function public.my_batch_landed_costs(p_product_id uuid default null)
returns table(batch_id uuid,unit_landed_cost numeric,cost_uom text,cost_currency_id uuid,cost_currency_code text,cost_calculation_id uuid)
language plpgsql stable security definer set search_path='' as $$
begin
 if not (select private.has_permission('inventory.view')) or not (select private.has_permission('prices.purchase.view')) then
  raise exception 'Нет доступа к себестоимости' using errcode='42501';
 end if;
 return query select b.id,b.unit_landed_cost,b.cost_uom,b.cost_currency_id,cur.code::text,b.cost_calculation_id
 from public.inventory_batches b left join public.currencies cur on cur.id=b.cost_currency_id
 where p_product_id is null or b.product_id=p_product_id;
end $$;
revoke all on function public.my_batch_landed_costs(uuid) from public,anon,authenticated,service_role;
grant execute on function public.my_batch_landed_costs(uuid) to authenticated;
comment on function public.my_batch_landed_costs(uuid) is 'Returns landed costs of batches, per cost_uom, only to prices.purchase.view holders';

-- Batches costed by the old rule get the average of their receipts once.
do $$ declare v_batch uuid; begin
 for v_batch in select id from public.inventory_batches order by id loop perform private.refresh_batch_cost(v_batch); end loop;
end $$;

commit;
