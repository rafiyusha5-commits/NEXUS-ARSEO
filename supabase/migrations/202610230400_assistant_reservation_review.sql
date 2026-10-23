-- One FEFO planner, shared by read-only preview and the existing reservation RPC.
begin;
create or replace function private.plan_customer_order_item_fefo(p_sale_item_id uuid,p_claimed jsonb default '[]')
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_item record; b record;
  v_remaining numeric; v_item_pieces numeric; v_balance_pieces numeric;
  v_want numeric; v_take numeric; v_cover numeric; v_pct numeric;
  v_result jsonb := '[]'::jsonb; v_missing text[] := '{}'; v_inexact boolean := false; v_message text;
begin
  if not (select private.has_permission('sales.reserve')) then raise exception 'Нет права резервировать товар'; end if;
  select i.*,s.warehouse_id,s.planned_shipment_date,s.status as sale_status,p.shelf_life_days into v_item
  from public.sale_items i join public.sales s on s.id=i.sale_id join public.products p on p.id=i.product_id
  where i.id=p_sale_item_id;
  if not found or v_item.sale_status not in ('draft','reserved') then raise exception 'Заказ недоступен для резервирования'; end if;
  if exists(select 1 from public.guarantee_letters where sale_id=v_item.sale_id and status in ('approved','sent','accepted')) then
    raise exception 'Нельзя менять партии после утверждения гарантийного письма';
  end if;
  v_remaining := v_item.quantity;
  for b in
    select balance.*, balance.quantity_on_hand-balance.quantity_reserved+coalesce((select sum(r.quantity) from public.inventory_reservations r where r.sale_item_id=p_sale_item_id and r.inventory_balance_id=balance.id and r.status='active'),0)-coalesce((select sum((a->>'quantity')::numeric) from jsonb_array_elements(p_claimed) a where a->>'balance_id'=balance.id::text),0) as free_quantity,batch.batch_number,batch.expiry_date,batch.manufacture_date
    from public.inventory_balances balance join public.inventory_batches batch on batch.id=balance.batch_id
    where batch.product_id=v_item.product_id and balance.warehouse_id=v_item.warehouse_id
      and batch.status='available' and batch.expiry_date>=greatest(v_item.planned_shipment_date,private.business_today())
    order by batch.expiry_date,batch.received_at,batch.id,(balance.uom=v_item.uom) desc,balance.id
  loop
    exit when v_remaining<=0;
    continue when b.free_quantity<=0;
    if b.uom = v_item.uom then
      v_item_pieces := 1; v_balance_pieces := 1;
    else
      v_item_pieces := private.uom_pieces(v_item.product_id, v_item.uom);
      v_balance_pieces := private.uom_pieces(v_item.product_id, b.uom);
      if v_item_pieces is null or v_balance_pieces is null then
        v_missing := v_missing || array(select private.uom_label(u) from unnest(array[v_item.uom, b.uom]) u
                                        where private.uom_pieces(v_item.product_id, u) is null);
        continue;
      end if;
    end if;
    -- Everything in pieces: the products of two scale-3 numbers are exact.
    v_want := least(v_remaining * v_item_pieces, b.free_quantity * v_balance_pieces);
    v_take := v_want / v_balance_pieces;
    v_cover := v_want / v_item_pieces;
    if v_take <> round(v_take, 3) or v_cover <> round(v_cover, 3) then
      v_inexact := true;
      -- Not exact: whole units of the order (4 boxes of 12 from a pallet of 50 is 0.96 pallet) ...
      v_cover := floor(v_want / v_item_pieces);
      v_take := v_cover * v_item_pieces / v_balance_pieces;
      if v_cover <= 0 or v_take <> round(v_take, 3) then
        -- ... or whole units of the balance (2 boxes of 12 for 25 pieces).
        v_take := floor(v_want / v_balance_pieces);
        v_cover := v_take * v_balance_pieces / v_item_pieces;
        if v_take <= 0 or v_cover <> round(v_cover, 3) then
          continue;
        end if;
      end if;
    end if;
    v_take := round(v_take, 3); v_cover := round(v_cover, 3);
    v_pct:=private.sale_shelf_life_pct(b.expiry_date,b.manufacture_date,v_item.shelf_life_days,greatest(v_item.planned_shipment_date,private.business_today()));
    v_result:=v_result||jsonb_build_array(jsonb_build_object('item_id',p_sale_item_id,'balance_id',b.id,'batch_id',b.batch_id,'batch_number',b.batch_number,
      'quantity',v_take,'uom',b.uom,'sale_quantity',v_cover,'remaining_shelf_life_pct',v_pct));
    v_remaining:=v_remaining-v_cover;
  end loop;
  if v_remaining>0 then
    v_message := format('Недостаточный доступный остаток: не хватает %s %s', trim_scale(v_remaining), private.uom_label(v_item.uom));
    if cardinality(v_missing) > 0 then
      v_message := v_message || format('; для пересчёта остатка не задана упаковка товара: %s — укажите количество штук в карточке товара',
        (select string_agg(distinct m, ', ') from unnest(v_missing) m));
    end if;
    if v_inexact then
      v_message := v_message || '; часть остатка учтена в упаковке, которая не делится на заказанное количество без остатка';
    end if;
    raise exception '%', v_message;
  end if;
  return v_result;
end $$;
revoke all on function private.plan_customer_order_item_fefo(uuid,jsonb) from public,anon,authenticated,service_role;

-- Common lock order: order, items, reservations, balances(UUID), batches, products, packaging, letters.
create or replace function private.lock_order_reservation_inputs(p_sale uuid) returns void
language plpgsql security definer set search_path='' as $$begin
 perform 1 from public.sales where id=p_sale for update;
 perform 1 from public.sale_items where sale_id=p_sale order by id for update;
 perform 1 from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id where i.sale_id=p_sale order by r.id for update of r;
 perform 1 from public.inventory_balances b where b.warehouse_id=(select warehouse_id from public.sales where id=p_sale)
  and exists(select 1 from public.inventory_batches x join public.sale_items i on i.product_id=x.product_id where x.id=b.batch_id and i.sale_id=p_sale) order by b.id for update;
 perform 1 from public.inventory_batches x where exists(select 1 from public.sale_items i where i.sale_id=p_sale and i.product_id=x.product_id) order by x.id for share;
 perform 1 from public.products p where exists(select 1 from public.sale_items i where i.sale_id=p_sale and i.product_id=p.id) order by p.id for share;
 perform 1 from public.product_packaging p where exists(select 1 from public.sale_items i where i.sale_id=p_sale and i.product_id=p.product_id) order by p.id for share;
 perform 1 from public.guarantee_letters where sale_id=p_sale order by id for update;
end $$;

create or replace function public.reserve_customer_order_item_fefo(p_sale_item_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare sale uuid; plan jsonb; a jsonb;
begin
 if not private.has_permission('sales.reserve') then raise exception 'Нет права резервировать товар';end if;
 select sale_id into sale from public.sale_items where id=p_sale_item_id;
 perform private.lock_order_reservation_inputs(sale);
 -- Recheck after lock waits. Planner preserves FEFO, exact packaging and low-OSG semantics.
 plan:=private.plan_customer_order_item_fefo(p_sale_item_id);
 delete from public.guarantee_letter_items where guarantee_letter_id in(select id from public.guarantee_letters where sale_id=sale and status='draft');
 perform private.release_sale_item_reservations(p_sale_item_id);
 for a in select value from jsonb_array_elements(plan) loop
  update public.inventory_balances set quantity_reserved=quantity_reserved+(a->>'quantity')::numeric,updated_at=now()
   where id=(a->>'balance_id')::uuid and quantity_on_hand-quantity_reserved>=(a->>'quantity')::numeric;
  if not found then raise exception 'Недостаточный доступный остаток';end if;
  insert into public.inventory_reservations(sale_item_id,inventory_balance_id,batch_id,quantity,uom,sale_quantity,remaining_shelf_life_pct)
   values(p_sale_item_id,(a->>'balance_id')::uuid,(a->>'batch_id')::uuid,(a->>'quantity')::numeric,a->>'uom',(a->>'sale_quantity')::numeric,(a->>'remaining_shelf_life_pct')::numeric);
 end loop;
 update public.sales s set status=case when not exists(select 1 from public.sale_items i where i.sale_id=s.id and i.quantity<>
  (select coalesce(sum(r.sale_quantity),0) from public.inventory_reservations r where r.sale_item_id=i.id and r.status='active')) then 'reserved' else 'draft' end,updated_at=now() where id=sale;
 return coalesce((select jsonb_agg(x.value-'item_id'-'balance_id') from jsonb_array_elements(plan) x),'[]');
end $$;

alter table private.assistant_operations drop constraint if exists assistant_operations_kind_check;
alter table private.assistant_operations add constraint assistant_operations_kind_check check(kind in
 ('inventory_transfer','customer_order_fulfillment','customer_order_create','customer_order_reserve'));
do $$begin
 if to_regprocedure('private.confirm_assistant_prior_operation(uuid,uuid)') is null then
  alter function public.confirm_assistant_operation(uuid,uuid) set schema private;
  alter function private.confirm_assistant_operation(uuid,uuid) rename to confirm_assistant_prior_operation;
 end if;
end $$;
revoke all on function private.confirm_assistant_prior_operation(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function private.require_assistant_reserve_access() returns void
language plpgsql security definer set search_path='' as $$begin
 perform private.require_assistant_draft_access();
 if not private.has_permission('sales.reserve') or not private.has_permission('inventory.view') then
  raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
end $$;

create or replace function private.assistant_reserve_preview(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare sale uuid; s public.sales; snap jsonb; plan jsonb:='[]'; a jsonb; line record; lines jsonb:='[]'; low boolean:=false;
begin
 perform private.require_assistant_reserve_access();
 if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'ASSISTANT_OPERATION_INVALID';end if;
 if (select count(*) from jsonb_object_keys(p_payload))<>1 or not p_payload ? 'sale_id' then raise exception 'ASSISTANT_OPERATION_INVALID';end if;
 begin sale:=(p_payload->>'sale_id')::uuid;exception when invalid_text_representation then raise exception 'ASSISTANT_OPERATION_INVALID';end;
 select * into s from public.sales where id=sale;
 if not found or not private.can_access_counterparty_record('view',s.customer_id) then raise exception 'ASSISTANT_OPERATION_DENIED';end if;
 -- Existing reserves are not silently replaced; their established review workflow remains authoritative.
 if s.status<>'draft' or exists(select 1 from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id where i.sale_id=sale and r.status='active') then
  raise exception 'ASSISTANT_OPERATION_RESERVE_STATE';end if;
 snap:=private.reservation_replacement_snapshot(sale);
 if jsonb_array_length(snap->'items') not between 1 and 100 or jsonb_array_length(snap->'balances')>2000 then raise exception 'ASSISTANT_OPERATION_RESERVE_SIZE';end if;
 for line in select id,required_shelf_life_pct,uom from public.sale_items where sale_id=sale order by id loop
  begin plan:=plan||private.plan_customer_order_item_fefo(line.id,plan);
  exception when others then raise exception 'ASSISTANT_OPERATION_RESERVE_BLOCKED';end;
 end loop;
 for a in select value from jsonb_array_elements(plan) loop
  select i.required_shelf_life_pct,i.uom,p.internal_sku||' · '||coalesce(p.name->>'ru',p.name->>'en','') as product
   into line from public.sale_items i join public.products p on p.id=i.product_id where i.id=(a->>'item_id')::uuid;
  low:=low or coalesce((a->>'remaining_shelf_life_pct')::numeric<line.required_shelf_life_pct,false);
  lines:=lines||jsonb_build_array(jsonb_build_object('id',(a->>'item_id')||':'||(a->>'balance_id'),'product',line.product,
   'batch',a->>'batch_number','quantity',(a->>'quantity')::numeric,'uom',a->>'uom','sale_quantity',(a->>'sale_quantity')::numeric,'sale_uom',line.uom,
   'expiry',(select expiry_date from public.inventory_batches where id=(a->>'batch_id')::uuid),
   'remaining_shelf_life_pct',(a->>'remaining_shelf_life_pct')::numeric,'required_shelf_life_pct',line.required_shelf_life_pct));
 end loop;
 return jsonb_build_object('order_number',s.sale_number,'customer',(select coalesce(short_name,legal_name) from public.counterparties where id=s.customer_id),
  'warehouse',(select code||' · '||coalesce(name->>'ru',name->>'en','') from public.warehouses where id=s.warehouse_id),
  'planned_date',s.planned_shipment_date,'document_date',private.business_today(),'items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'product',p.internal_sku,'quantity',i.quantity,'uom',i.uom) order by i.id)
    from public.sale_items i join public.products p on p.id=i.product_id where i.sale_id=sale),'[]'),
  'lines',lines,'low_shelf_life',low,'state_stamp',encode(sha256(convert_to(snap::text,'UTF8')),'hex'));
end $$;

create or replace function private.require_assistant_kind_access(p_kind text) returns void
language plpgsql security definer set search_path='' as $$begin
 case p_kind
 when 'inventory_transfer' then perform private.require_assistant_operation_access();
 when 'customer_order_fulfillment' then perform private.require_assistant_order_access();
 when 'customer_order_create' then perform private.require_assistant_draft_access();
 when 'customer_order_reserve' then perform private.require_assistant_reserve_access();
 else raise exception 'ASSISTANT_OPERATION_INVALID';end case;
end $$;
create or replace function private.assistant_operation_preview(p_kind text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 case p_kind
 when 'inventory_transfer' then return private.assistant_transfer_preview(p_payload);
 when 'customer_order_fulfillment' then return private.assistant_order_preview(p_payload);
 when 'customer_order_create' then return private.assistant_draft_preview(p_payload);
 when 'customer_order_reserve' then return private.assistant_reserve_preview(p_payload);
 else raise exception 'ASSISTANT_OPERATION_INVALID';end case;
end $$;

create or replace function public.confirm_assistant_operation(p_request_id uuid,p_review_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations; sale uuid; v jsonb; line record;
begin
 select * into r from private.assistant_operations where id=p_request_id and created_by=auth.uid() for update;
 if not found or p_review_token is null or r.review_token<>p_review_token then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.kind<>'customer_order_reserve' then return private.confirm_assistant_prior_operation(p_request_id,p_review_token);end if;
 perform private.require_assistant_reserve_access();
 if r.result_sale_id is not null then return jsonb_build_object('id',r.id,'kind',r.kind,'status','completed','result_id',r.result_sale_id);end if;
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 sale:=(r.payload->>'sale_id')::uuid;
 perform private.lock_order_reservation_inputs(sale);
 perform private.require_assistant_reserve_access();
 v:=private.assistant_reserve_preview(r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 for line in select id from public.sale_items where sale_id=sale order by id loop
  perform public.reserve_customer_order_item_fefo(line.id);
 end loop;
 if (select count(*) from public.inventory_reservations r2 join public.sale_items i on i.id=r2.sale_item_id where i.sale_id=sale and r2.status='active')<>jsonb_array_length(v->'lines')
  or exists(select 1 from jsonb_array_elements(v->'lines') a where not exists(select 1 from public.inventory_reservations r2
   join public.sale_items i on i.id=r2.sale_item_id where i.sale_id=sale and r2.status='active'
   and i.id::text||':'||r2.inventory_balance_id::text=a->>'id' and r2.quantity=(a->>'quantity')::numeric and r2.sale_quantity=(a->>'sale_quantity')::numeric)) then
  raise exception 'ASSISTANT_OPERATION_STALE';end if;
 -- No confirmation, letter approval, issue or money operation. Low-OSG acceptance is bound to the reviewed receipt.
 update private.assistant_operations set confirmed_at=clock_timestamp(),result_sale_id=sale where id=r.id;
 return jsonb_build_object('id',r.id,'kind',r.kind,'status','completed','result_id',sale);
end $$;
revoke all on function private.lock_order_reservation_inputs(uuid),private.require_assistant_reserve_access(),private.assistant_reserve_preview(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.confirm_assistant_operation(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.confirm_assistant_operation(uuid,uuid) to authenticated;
commit;
