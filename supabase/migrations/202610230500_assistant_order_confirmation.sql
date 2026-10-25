-- Fifth reviewed operation. No issue, reserve replacement, letter approval or credit override.
begin;
create or replace function private.customer_order_allocation_blockers(p_sale_id uuid, p_on_date date, p_confirmation boolean)
returns table(code text, message text, sale_item_id uuid, batch_id uuid)
language plpgsql security definer set search_path='' as $$
declare s public.sales; v_today date; v_ship date; v_expiry_day date; v_line record; v_pct numeric;
begin
  select * into s from public.sales where id=p_sale_id;
  if not found then raise exception 'Заказ не найден'; end if;
  if not p_confirmation and s.status<>'confirmed' then return; end if;
  v_today:=private.business_today();
  -- A new planned date (rescheduling) is checked as confirmation checks it: the batch has to last until then.
  v_ship:=greatest(v_today,coalesce(p_on_date,s.planned_shipment_date));
  v_expiry_day:=case when p_confirmation then v_ship when p_on_date is null then v_today else v_ship end;

  if not exists(select 1 from public.sale_items where sale_id=s.id) then
    return query select 'no_items'::text,'В заказе нет товаров'::text,null::uuid,null::uuid;
  end if;
  return query
    select 'not_reserved'::text,
      format('%s: зарезервировано %s из %s',p.internal_sku,
        rtrim(to_char(coalesce(sum(r.sale_quantity) filter (where r.status='active'),0),'FM999999999990.999'),'.'),
        rtrim(to_char(i.quantity,'FM999999999990.999'),'.')),
      i.id,null::uuid
    from public.sale_items i join public.products p on p.id=i.product_id
    left join public.inventory_reservations r on r.sale_item_id=i.id
    where i.sale_id=s.id
    group by i.id,i.quantity,p.internal_sku
    having i.quantity<>coalesce(sum(r.sale_quantity) filter (where r.status='active'),0)
        or bool_or(r.status='fulfilled');

  for v_line in
    select distinct on (r.sale_item_id,r.batch_id)
      r.sale_item_id,r.batch_id,i.required_shelf_life_pct,p.internal_sku,x.batch_number,x.status batch_status,x.status_reason,
      x.expiry_date,x.manufacture_date,p.shelf_life_days,
      bool_or(r.batch_id<>b.batch_id or i.product_id<>x.product_id or b.warehouse_id<>s.warehouse_id or r.uom<>b.uom)
        over (partition by r.sale_item_id,r.batch_id) mismatch,
      sum(r.sale_quantity) over (partition by r.sale_item_id,r.batch_id) batch_sale_quantity,
      min(r.remaining_shelf_life_pct) over (partition by r.sale_item_id,r.batch_id) batch_shelf_life_pct
    from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
    join public.inventory_balances b on b.id=r.inventory_balance_id join public.inventory_batches x on x.id=r.batch_id
    join public.products p on p.id=i.product_id
    where i.sale_id=s.id and r.status='active'
    order by r.sale_item_id,r.batch_id
  loop
    if v_line.mismatch then
      return query select 'reservation_mismatch'::text,
        format('%s, партия %s: резерв не соответствует товару, складу или единице остатка',v_line.internal_sku,v_line.batch_number),
        v_line.sale_item_id,v_line.batch_id;
    end if;
    if v_line.batch_status<>'available' then
      return query select 'batch_unavailable'::text,
        format('%s, партия %s: %s%s',v_line.internal_sku,v_line.batch_number,
          case v_line.batch_status when 'blocked' then 'заблокирована' when 'quarantine' then 'в карантине'
            when 'depleted' then 'израсходована' else v_line.batch_status end,
          coalesce(' — '||nullif(trim(v_line.status_reason),''),'')),
        v_line.sale_item_id,v_line.batch_id;
    end if;
    if v_line.expiry_date<v_expiry_day then
      return query select 'batch_expired'::text,
        format(case when v_line.expiry_date<v_today then '%s, партия %s: просрочена (годна до %s)' else '%s, партия %s: истечёт до отгрузки (годна до %s)' end,v_line.internal_sku,v_line.batch_number,to_char(v_line.expiry_date,'DD.MM.YYYY')),
        v_line.sale_item_id,v_line.batch_id;
    end if;
    -- A batch on hold or expired has to be replaced anyway; its shelf life adds nothing to say.
    if v_line.batch_status<>'available' or v_line.expiry_date<v_expiry_day then continue; end if;
    v_pct:=private.sale_shelf_life_pct(v_line.expiry_date,v_line.manufacture_date,v_line.shelf_life_days,v_ship);
    if v_line.required_shelf_life_pct is not null and v_pct<v_line.required_shelf_life_pct and not exists(
      select 1 from public.guarantee_letters g join public.guarantee_letter_items gi on gi.guarantee_letter_id=g.id
      where g.sale_id=s.id and g.status in ('approved','sent','accepted') and gi.sale_item_id=v_line.sale_item_id
        and gi.batch_id=v_line.batch_id and gi.quantity=v_line.batch_sale_quantity and gi.required_shelf_life_pct=v_line.required_shelf_life_pct
        and gi.remaining_shelf_life_pct=case when p_confirmation then v_pct else v_line.batch_shelf_life_pct end and v_pct>=gi.remaining_shelf_life_pct
    ) then
      return query select 'shelf_life_letter'::text,
        format('%s, партия %s: остаточный срок %s%% ниже требуемых %s%% — нужно действующее гарантийное письмо на эту партию и количество',
          v_line.internal_sku,v_line.batch_number,rtrim(to_char(v_pct,'FM990.99'),'.'),rtrim(to_char(v_line.required_shelf_life_pct,'FM990.99'),'.')),
        v_line.sale_item_id,v_line.batch_id;
    end if;
  end loop;

  return query
    select distinct 'stock_mismatch'::text,
      format('Партия %s: остаток или резервы на складе не сходятся с резервами заказов',x.batch_number),
      null::uuid,b.batch_id
    from public.inventory_balances b join public.inventory_batches x on x.id=b.batch_id
    where b.id in (select r.inventory_balance_id from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
                   where i.sale_id=s.id and r.status='active')
      and (b.quantity_reserved<>(select coalesce(sum(q.quantity),0) from public.inventory_reservations q
                                 where q.inventory_balance_id=b.id and q.status='active')
        or b.quantity_on_hand<(select coalesce(sum(q.quantity),0) from public.inventory_reservations q join public.sale_items qi on qi.id=q.sale_item_id
                               where q.inventory_balance_id=b.id and q.status='active' and qi.sale_id=s.id));
end $$;

create or replace function private.customer_order_blockers(p_sale_id uuid,p_on_date date default null)
returns table(code text,message text,sale_item_id uuid,batch_id uuid)
language sql security definer set search_path='' as $$
 select * from private.customer_order_allocation_blockers(p_sale_id,p_on_date,false)
$$;
alter table private.assistant_operations drop constraint if exists assistant_operations_kind_check;
alter table private.assistant_operations add constraint assistant_operations_kind_check check(kind in
 ('inventory_transfer','customer_order_fulfillment','customer_order_create','customer_order_reserve','customer_order_confirm'));
do $$begin
 if to_regprocedure('private.confirm_assistant_before_confirmation(uuid,uuid)') is null then
  alter function public.confirm_assistant_operation(uuid,uuid) set schema private;
  alter function private.confirm_assistant_operation(uuid,uuid) rename to confirm_assistant_before_confirmation;
 end if;
end $$;
revoke all on function private.confirm_assistant_before_confirmation(uuid,uuid) from public,anon,authenticated,service_role;
create or replace function private.require_assistant_confirmation_access() returns void
language plpgsql security definer set search_path='' as $$begin
 perform private.require_assistant_draft_access();
 if not private.has_permission('inventory.view') then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
end $$;
create or replace function private.assistant_confirmation_preview(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare sale uuid; s public.sales; items jsonb; allocations jsonb; stamp jsonb;
begin
 perform private.require_assistant_confirmation_access();
 if jsonb_typeof(p_payload) is distinct from 'object' or
  (select count(*) from jsonb_object_keys(p_payload))<>1 or not p_payload ? 'sale_id' then
  raise exception 'ASSISTANT_OPERATION_INVALID';end if;
 begin sale:=(p_payload->>'sale_id')::uuid;
 exception when invalid_text_representation then raise exception 'ASSISTANT_OPERATION_INVALID';end;
 select * into s from public.sales where id=sale;
 if not found then raise exception 'ASSISTANT_OPERATION_DENIED';end if;
 if not private.can_access_counterparty_record('view',s.customer_id) then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if s.status<>'reserved' then raise exception 'ASSISTANT_OPERATION_CONFIRM_STATE';end if;
 -- Same allocation checks as fulfillment, with confirmation's exact current OSG/letter binding.
 if exists(select 1 from private.customer_order_allocation_blockers(s.id,null,true)) then raise exception 'ASSISTANT_OPERATION_CONFIRM_BLOCKED';end if;
 if (select count(*) from public.sale_items where sale_id=s.id)>100 or
  (select count(*) from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id where i.sale_id=s.id and r.status='active')>2000 then raise exception 'ASSISTANT_OPERATION_RESERVE_SIZE';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'product',p.internal_sku||' · '||coalesce(p.name->>'ru',p.name->>'en',''),
  'quantity',i.quantity,'uom',i.uom) order by i.id),'[]') into items
 from public.sale_items i join public.products p on p.id=i.product_id where i.sale_id=s.id;
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'item_id',i.id,'product',p.internal_sku||' · '||coalesce(p.name->>'ru',p.name->>'en',''),
  'batch',x.batch_number,'quantity',r.quantity,'uom',r.uom,'sale_quantity',r.sale_quantity,'sale_uom',i.uom,'expiry',x.expiry_date,'required_shelf_life_pct',i.required_shelf_life_pct,
  'remaining_shelf_life_pct',private.sale_shelf_life_pct(x.expiry_date,x.manufacture_date,p.shelf_life_days,greatest(s.planned_shipment_date,private.business_today())))
  order by r.id),'[]') into allocations
 from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
 join public.products p on p.id=i.product_id join public.inventory_batches x on x.id=r.batch_id
 where i.sale_id=s.id and r.status='active';
 -- Internal fingerprint only. Never return row JSON, prices, private notes, or this hash to the caller.
 stamp:=jsonb_build_object('sale',to_jsonb(s),
  'items',(select jsonb_agg(to_jsonb(i) order by i.id) from public.sale_items i where i.sale_id=s.id),
  'reservations',(select jsonb_agg(to_jsonb(r) order by r.id) from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id where i.sale_id=s.id),
  'balances',(select jsonb_agg(to_jsonb(b) order by b.id) from public.inventory_balances b where b.id in (select r.inventory_balance_id from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id where i.sale_id=s.id)),
  'batches',(select jsonb_agg(to_jsonb(x) order by x.id) from public.inventory_batches x where x.id in (select r.batch_id from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id where i.sale_id=s.id)),
  'letters',(select jsonb_agg(to_jsonb(g) order by g.id) from public.guarantee_letters g where g.sale_id=s.id),
  'letter_items',(select jsonb_agg(to_jsonb(gi) order by gi.id) from public.guarantee_letter_items gi join public.guarantee_letters g on g.id=gi.guarantee_letter_id where g.sale_id=s.id),
  'products',(select jsonb_agg(to_jsonb(p) order by p.id) from public.products p where p.id in(select product_id from public.sale_items where sale_id=s.id)));
 return jsonb_build_object('order_number',s.sale_number,'customer',(select coalesce(short_name,legal_name) from public.counterparties where id=s.customer_id),
  'warehouse',(select code||' · '||coalesce(name->>'ru',name->>'en','') from public.warehouses where id=s.warehouse_id),
  'planned_date',s.planned_shipment_date,'document_date',private.business_today(),'items',items,'lines',allocations,
  'state_stamp',encode(sha256(convert_to(stamp::text,'UTF8')),'hex'));
end $$;


create or replace function private.require_assistant_kind_access(p_kind text) returns void
language plpgsql security definer set search_path='' as $$begin
 case p_kind
 when 'inventory_transfer' then perform private.require_assistant_operation_access();
 when 'customer_order_fulfillment' then perform private.require_assistant_order_access();
 when 'customer_order_create' then perform private.require_assistant_draft_access();
 when 'customer_order_confirm' then perform private.require_assistant_confirmation_access();
 when 'customer_order_reserve' then perform private.require_assistant_reserve_access();
 else raise exception 'ASSISTANT_OPERATION_INVALID';end case;
end $$;
create or replace function private.assistant_operation_preview(p_kind text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 case p_kind
 when 'inventory_transfer' then return private.assistant_transfer_preview(p_payload);
 when 'customer_order_fulfillment' then return private.assistant_order_preview(p_payload);
 when 'customer_order_create' then return private.assistant_draft_preview(p_payload);
 when 'customer_order_confirm' then return private.assistant_confirmation_preview(p_payload);
 when 'customer_order_reserve' then return private.assistant_reserve_preview(p_payload);
 else raise exception 'ASSISTANT_OPERATION_INVALID';end case;
end $$;


create or replace function public.confirm_assistant_operation(p_request_id uuid,p_review_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations; sale uuid; v jsonb;
begin
 select * into r from private.assistant_operations where id=p_request_id and created_by=auth.uid() for update;
 if not found or p_review_token is null or r.review_token<>p_review_token then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.kind<>'customer_order_confirm' then return private.confirm_assistant_before_confirmation(p_request_id,p_review_token);end if;
 perform private.require_assistant_confirmation_access();
 if r.result_sale_id is not null then return jsonb_build_object('id',r.id,'kind',r.kind,'status','completed','result_id',r.result_sale_id);end if;
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 sale:=(r.payload->>'sale_id')::uuid;
 -- Same order as fulfill_customer_order: order -> items -> reservations -> balances -> batches -> letters.
 -- Also freezes facts displayed in the preview until the existing RPC completes.
 perform 1 from public.sales where id=sale for update;
 perform 1 from public.sale_items where sale_id=sale order by id for update;
 perform 1 from public.inventory_reservations r2 join public.sale_items i on i.id=r2.sale_item_id where i.sale_id=sale order by r2.id for update of r2;
 perform 1 from public.inventory_balances where id in(select r2.inventory_balance_id from public.inventory_reservations r2 join public.sale_items i on i.id=r2.sale_item_id where i.sale_id=sale) order by id for update;
 perform 1 from public.inventory_batches where id in(select r2.batch_id from public.inventory_reservations r2 join public.sale_items i on i.id=r2.sale_item_id where i.sale_id=sale) order by id for update;
 perform 1 from public.guarantee_letters where sale_id=sale order by id for update;
 perform 1 from public.guarantee_letter_items gi join public.guarantee_letters g on g.id=gi.guarantee_letter_id where g.sale_id=sale order by gi.id for share of gi;
 perform 1 from public.products where id in(select product_id from public.sale_items where sale_id=sale) order by id for share;
 perform 1 from public.counterparties where id=(select customer_id from public.sales where id=sale) for share;
 perform 1 from public.warehouses where id=(select warehouse_id from public.sales where id=sale) for share;
 perform private.require_assistant_confirmation_access();
 v:=private.assistant_confirmation_preview(r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 -- The existing RPC refreshes OSG, requires exact letters and invokes the receivables guard.
 -- A finance refusal must never expose debt amounts / SQL via the assistant.
 -- Recheck the deadline after all input locks and preview validation.
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 begin perform public.confirm_customer_order(sale);
 exception when others then raise exception 'ASSISTANT_OPERATION_CONFIRM_REFUSED';end;
 update private.assistant_operations set confirmed_at=clock_timestamp(),result_sale_id=sale where id=r.id;
 return jsonb_build_object('id',r.id,'kind',r.kind,'status','completed','result_id',sale);
end $$;

revoke all on function private.customer_order_allocation_blockers(uuid,date,boolean),
 private.require_assistant_confirmation_access(),private.assistant_confirmation_preview(jsonb)
 from public,anon,authenticated,service_role;
revoke all on function public.confirm_assistant_operation(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.confirm_assistant_operation(uuid,uuid) to authenticated;
commit;

