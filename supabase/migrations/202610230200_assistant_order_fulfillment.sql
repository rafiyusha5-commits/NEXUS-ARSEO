-- Extend the same reviewed-operation receipt; reuse the existing fulfillment RPC.
begin;
alter table private.assistant_operations drop constraint if exists assistant_operations_kind_check;
alter table private.assistant_operations add constraint assistant_operations_kind_check check(kind in ('inventory_transfer','customer_order_fulfillment'));
alter table private.assistant_operations add column if not exists result_sale_id uuid references public.sales(id);

-- Preserve the shipped transfer adapter, including its locks and checks. Idempotent migration.
do $$begin
 if to_regprocedure('private.prepare_assistant_transfer(uuid,text,jsonb)') is null then
  alter function public.prepare_assistant_operation(uuid,text,jsonb) set schema private;
  alter function private.prepare_assistant_operation(uuid,text,jsonb) rename to prepare_assistant_transfer;
  alter function public.review_assistant_operation(uuid) set schema private;
  alter function private.review_assistant_operation(uuid) rename to review_assistant_transfer;
  alter function public.confirm_assistant_operation(uuid,uuid) set schema private;
  alter function private.confirm_assistant_operation(uuid,uuid) rename to confirm_assistant_transfer;
 end if;
end $$;
revoke all on function private.prepare_assistant_transfer(uuid,text,jsonb),private.review_assistant_transfer(uuid),private.confirm_assistant_transfer(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function private.require_assistant_order_access() returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.is_active_employee(auth.uid()) or not (
  private.has_permission('agent.use') and private.has_permission('sales.view') and private.has_permission('sales.manage')
  and private.has_permission('inventory.move') and private.has_permission('inventory.view')
  and private.has_permission('products.view') and private.has_permission('warehouses.view') and private.has_permission('customers.view')) then
  raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';
 end if;
end $$;

create or replace function private.assistant_order_preview(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare sale uuid; s public.sales; items jsonb; allocations jsonb; stamp jsonb;
begin
 perform private.require_assistant_order_access();
 if jsonb_typeof(p_payload) is distinct from 'object' or
  (select count(*) from jsonb_object_keys(p_payload))<>1 or not p_payload ? 'sale_id' then
  raise exception 'ASSISTANT_OPERATION_INVALID';end if;
 begin sale:=(p_payload->>'sale_id')::uuid;
 exception when invalid_text_representation then raise exception 'ASSISTANT_OPERATION_INVALID';end;
 select * into s from public.sales where id=sale;
 if not found then raise exception 'ASSISTANT_OPERATION_DENIED';end if;
 if not private.can_access_counterparty_record('view',s.customer_id) then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if s.status<>'confirmed' then raise exception 'ASSISTANT_OPERATION_ORDER_STATE';end if;
 -- No parallel shelf-life or reservation rules: the existing blocker function is authoritative.
 if exists(select 1 from private.customer_order_blockers(s.id)) then raise exception 'ASSISTANT_OPERATION_ORDER_BLOCKED';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'product',p.internal_sku||' · '||coalesce(p.name->>'ru',p.name->>'en',''),
  'quantity',i.quantity,'uom',i.uom) order by i.id),'[]') into items
 from public.sale_items i join public.products p on p.id=i.product_id where i.sale_id=s.id;
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'item_id',i.id,'product',p.internal_sku||' · '||coalesce(p.name->>'ru',p.name->>'en',''),
  'batch',x.batch_number,'quantity',r.quantity,'uom',r.uom,'sale_quantity',r.sale_quantity,'sale_uom',i.uom,'expiry',x.expiry_date)
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

create or replace function public.prepare_assistant_operation(p_request_id uuid,p_kind text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations; v jsonb;
begin
 if p_kind='inventory_transfer' then return private.prepare_assistant_transfer(p_request_id,p_kind,p_payload);end if;
 perform private.require_assistant_order_access();
 if p_request_id is null or p_kind is distinct from 'customer_order_fulfillment' then raise exception 'ASSISTANT_OPERATION_INVALID';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,230100));
 select * into r from private.assistant_operations where id=p_request_id;
 if found then
  if r.created_by<>auth.uid() or r.kind<>p_kind or r.payload is distinct from p_payload then raise exception 'ASSISTANT_OPERATION_DENIED';end if;
 else
  v:=private.assistant_order_preview(p_payload);
  insert into private.assistant_operations(id,created_by,kind,payload,preview) values(p_request_id,auth.uid(),p_kind,p_payload,v);
 end if;
 return jsonb_build_object('id',p_request_id);
end $$;

create or replace function public.review_assistant_operation(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations; v jsonb;
begin
 select * into r from private.assistant_operations where id=p_request_id and created_by=auth.uid();
 if not found then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.kind='inventory_transfer' then return private.review_assistant_transfer(p_request_id)||jsonb_build_object('kind',r.kind);end if;
 perform private.require_assistant_order_access();
 if r.result_sale_id is not null then return jsonb_build_object('id',r.id,'kind',r.kind,'status','completed','result_id',r.result_sale_id);end if;
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 v:=private.assistant_order_preview(r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 return jsonb_build_object('id',r.id,'kind',r.kind,'status','awaiting_confirmation','review_token',r.review_token,
  'preview',v-'state_stamp','expires_at',r.expires_at);
end $$;

create or replace function public.confirm_assistant_operation(p_request_id uuid,p_review_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations; sale uuid; v jsonb;
begin
 select * into r from private.assistant_operations where id=p_request_id and created_by=auth.uid() for update;
 if not found or p_review_token is null or r.review_token<>p_review_token then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.kind='inventory_transfer' then return private.confirm_assistant_transfer(p_request_id,p_review_token)||jsonb_build_object('kind',r.kind);end if;
 perform private.require_assistant_order_access();
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
 perform private.require_assistant_order_access();
 v:=private.assistant_order_preview(r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 -- No new issue/reserve/accounting algorithm. Same RPC as the shipment tab.
 perform public.fulfill_customer_order(sale);
 update private.assistant_operations set confirmed_at=clock_timestamp(),result_sale_id=sale where id=r.id;
 return jsonb_build_object('id',r.id,'kind',r.kind,'status','completed','result_id',sale);
end $$;
revoke all on function private.require_assistant_order_access(),private.assistant_order_preview(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.prepare_assistant_operation(uuid,text,jsonb),public.review_assistant_operation(uuid),public.confirm_assistant_operation(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.prepare_assistant_operation(uuid,text,jsonb),public.review_assistant_operation(uuid),public.confirm_assistant_operation(uuid,uuid) to authenticated;
commit;
