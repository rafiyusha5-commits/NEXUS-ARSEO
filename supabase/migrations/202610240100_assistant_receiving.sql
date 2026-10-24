-- Reviewed receipt of one complete arrived vehicle. Existing receiving RPC owns all stock writes.
begin;
alter table private.assistant_operations add column if not exists result_receipt_id uuid references public.shipment_transport_receipts(id);
alter table private.assistant_operations drop constraint if exists assistant_operations_kind_check;
alter table private.assistant_operations add constraint assistant_operations_kind_check check(kind in
 ('inventory_transfer','customer_order_fulfillment','customer_order_create','customer_order_reserve','customer_order_confirm','shipment_transport_receive'));
do $$begin
 if to_regprocedure('private.confirm_assistant_before_receiving(uuid,uuid)') is null then
  alter function public.confirm_assistant_operation(uuid,uuid) set schema private;
  alter function private.confirm_assistant_operation(uuid,uuid) rename to confirm_assistant_before_receiving;
  alter function public.review_assistant_operation(uuid) set schema private;
  alter function private.review_assistant_operation(uuid) rename to review_assistant_before_receiving;
  alter function private.require_assistant_kind_access(text) rename to require_assistant_kind_before_receiving;
  alter function private.assistant_operation_preview(text,jsonb) rename to assistant_preview_before_receiving;
 end if;
end $$;

create or replace function private.require_assistant_receiving_access() returns void
language plpgsql security definer set search_path='' as $$begin
 if auth.uid() is null or not private.is_active_employee(auth.uid()) or not (
  private.has_permission('agent.use') and private.has_permission('shipments.view')
  and private.has_permission('inventory.receive') and private.has_permission('inventory.view')
  and private.has_permission('products.view') and private.has_permission('warehouses.view')) then
  raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';
 end if;
end $$;

create or replace function private.assistant_receiving_preview(p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t public.shipment_transports; s public.shipments; i public.shipment_items; loc public.warehouse_locations;
 x jsonb; a numeric; d numeric; expected numeric; manufactured date; expiry date; rows jsonb:='[]'; stamp jsonb;
begin
 perform private.require_assistant_receiving_access();
 if jsonb_typeof(p) is distinct from 'object' then raise exception 'ASSISTANT_RECEIVING_INVALID';end if;
 if not p ?& array['transport_id','location_id','lines'] or (select count(*) from jsonb_object_keys(p))<>3
  or jsonb_typeof(p->'transport_id')<>'string' or jsonb_typeof(p->'location_id') not in ('string','null')
  or jsonb_typeof(p->'lines') is distinct from 'array' then raise exception 'ASSISTANT_RECEIVING_INVALID';end if;
 if jsonb_array_length(p->'lines') not between 1 and 20 then raise exception 'ASSISTANT_RECEIVING_INVALID';end if;
 select * into t from public.shipment_transports where id=(p->>'transport_id')::uuid;
 if not found then raise exception 'ASSISTANT_OPERATION_DENIED';end if;
 select * into s from public.shipments where id=t.shipment_id;
 if t.status<>'arrived' or s.is_locked or s.status in ('on_hold','cancelled','closed') or
  exists(select 1 from public.shipment_transport_receipts where shipment_transport_id=t.id) then
  raise exception 'ASSISTANT_RECEIVING_STATE';end if;
 if p->>'location_id' is not null then
  select * into loc from public.warehouse_locations where id=(p->>'location_id')::uuid and warehouse_id=s.destination_warehouse_id and status='active';
  if not found then raise exception 'ASSISTANT_RECEIVING_INVALID';end if;
 end if;
 if (select count(*) from public.shipment_items where shipment_transport_id=t.id)<>jsonb_array_length(p->'lines')
  or (select count(distinct (value->>'item_id')::uuid) from jsonb_array_elements(p->'lines'))<>jsonb_array_length(p->'lines') then
  raise exception 'ASSISTANT_RECEIVING_INVALID';end if;
 for x in select value from jsonb_array_elements(p->'lines') loop
  if jsonb_typeof(x) is distinct from 'object' then raise exception 'ASSISTANT_RECEIVING_INVALID';end if;
  if not x ?& array['item_id','accepted_quantity','damaged_quantity','batch_number','manufacture_date','expiry_date','discrepancy_reason']
   or (select count(*) from jsonb_object_keys(x))<>7 then raise exception 'ASSISTANT_RECEIVING_INVALID';end if;
  if exists(select 1 from jsonb_each(x) kv where jsonb_typeof(kv.value) not in ('string','null'))
   or coalesce(x->>'accepted_quantity','') !~ '^(0|[1-9][0-9]{0,8})(\.[0-9]{1,3})?$'
   or coalesce(x->>'damaged_quantity','') !~ '^(0|[1-9][0-9]{0,8})(\.[0-9]{1,3})?$'
   or length(x->>'batch_number')>80 or length(x->>'discrepancy_reason')>200 then raise exception 'ASSISTANT_RECEIVING_INVALID';end if;
  select * into i from public.shipment_items where id=(x->>'item_id')::uuid and shipment_transport_id=t.id;
  if not found then raise exception 'ASSISTANT_RECEIVING_INVALID';end if;
  a:=(x->>'accepted_quantity')::numeric; d:=(x->>'damaged_quantity')::numeric;
  expected:=coalesce(i.shipped_quantity,i.confirmed_quantity,i.ordered_quantity);
  manufactured:=(x->>'manufacture_date')::date; expiry:=(x->>'expiry_date')::date;
  if (manufactured is not null and to_char(manufactured,'YYYY-MM-DD')<>x->>'manufacture_date')
   or (expiry is not null and to_char(expiry,'YYYY-MM-DD')<>x->>'expiry_date')
   or (a>0 and (nullif(trim(x->>'batch_number'),'') is null or expiry is null))
   or manufactured>expiry or ((a+d<>expected or d>0) and nullif(trim(x->>'discrepancy_reason'),'') is null) then
   raise exception 'ASSISTANT_RECEIVING_INVALID';end if;
  rows:=rows||jsonb_build_array(jsonb_build_object('id',i.id,
   'product',(select internal_sku||' · '||coalesce(name->>'ru',name->>'en','') from public.products where id=i.product_id),
   'quantity',a,'damaged',d,'expected',expected,'basis',case when i.shipped_quantity is not null then 'shipped' when i.confirmed_quantity is not null then 'confirmed' else 'ordered' end,
   'shortage',greatest(expected-a-d,0),'overage',greatest(a+d-expected,0),'uom',i.uom,
   'batch',x->>'batch_number','manufacture_date',manufactured,'expiry',expiry,'reason',x->>'discrepancy_reason'));
 end loop;
 stamp:=jsonb_build_object('shipment',to_jsonb(s),'transport',to_jsonb(t),'location',to_jsonb(loc),
  'items',(select jsonb_agg(to_jsonb(q) order by q.id) from public.shipment_items q where q.shipment_transport_id=t.id),
  'products',(select jsonb_agg(to_jsonb(q) order by q.id) from public.products q where q.id in(select product_id from public.shipment_items where shipment_transport_id=t.id)));
 return jsonb_build_object('shipment_id',s.id,'shipment_number',s.shipment_number,'vehicle',t.sequence_no,
  'warehouse',(select code||' · '||coalesce(name->>'ru',name->>'en','') from public.warehouses where id=s.destination_warehouse_id),
  'location',loc.code,'document_date',private.business_today(),'lines',rows,
  'performer',(select full_name from public.profiles where id=auth.uid()),
  'state_stamp',encode(sha256(convert_to(stamp::text,'UTF8')),'hex'));
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
 raise exception 'ASSISTANT_RECEIVING_INVALID';
end $$;

create or replace function private.require_assistant_kind_access(p_kind text) returns void
language plpgsql security definer set search_path='' as $$begin
 if p_kind='shipment_transport_receive' then perform private.require_assistant_receiving_access();
 else perform private.require_assistant_kind_before_receiving(p_kind);end if;
end $$;
create or replace function private.assistant_operation_preview(p_kind text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 if p_kind='shipment_transport_receive' then return private.assistant_receiving_preview(p_payload);
 else return private.assistant_preview_before_receiving(p_kind,p_payload);end if;
end $$;
create or replace function public.review_assistant_operation(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations; v jsonb;
begin
 select * into r from private.assistant_operations where id=p_request_id and created_by=auth.uid();
 if not found then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.kind<>'shipment_transport_receive' then return private.review_assistant_before_receiving(p_request_id);end if;
 perform private.require_assistant_receiving_access();
 if r.result_receipt_id is not null then return jsonb_build_object('id',r.id,'kind',r.kind,'status','completed','result_id',r.result_receipt_id,'shipment_id',r.preview->>'shipment_id');end if;
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 v:=private.assistant_receiving_preview(r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 return jsonb_build_object('id',r.id,'kind',r.kind,'status','awaiting_confirmation','review_token',r.review_token,'preview',v-'state_stamp','expires_at',r.expires_at);
end $$;
create or replace function public.confirm_assistant_operation(p_request_id uuid,p_review_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations; t uuid; v jsonb; receipt uuid;
begin
 select * into r from private.assistant_operations where id=p_request_id and created_by=auth.uid() for update;
 if not found or p_review_token is null or r.review_token<>p_review_token then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.kind<>'shipment_transport_receive' then return private.confirm_assistant_before_receiving(p_request_id,p_review_token);end if;
 perform private.require_assistant_receiving_access();
 if r.result_receipt_id is not null then return public.review_assistant_operation(r.id);end if;
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 t:=(r.payload->>'transport_id')::uuid;
 -- Freeze the same header rows as the native RPC, then every reviewed line/reference.
 perform 1 from public.shipment_transports tr join public.shipments s on s.id=tr.shipment_id where tr.id=t for update of tr,s;
 perform 1 from public.shipment_items where shipment_transport_id=t order by id for update;
 perform 1 from public.products where id in(select product_id from public.shipment_items where shipment_transport_id=t) order by id for share;
 perform 1 from public.warehouse_locations where id=(r.payload->>'location_id')::uuid for share;
 perform 1 from public.warehouses where id=(select destination_warehouse_id from public.shipments where id=(select shipment_id from public.shipment_transports where id=t)) for share;
 perform 1 from public.profiles where id=auth.uid() for share;
 perform private.require_assistant_receiving_access();
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 v:=private.assistant_receiving_preview(r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 begin
  receipt:=public.receive_shipment_transport(t,(r.payload->>'location_id')::uuid,r.payload->'lines',v->>'performer',null);
 exception when others then raise exception 'ASSISTANT_RECEIVING_REFUSED';end;
 update private.assistant_operations set confirmed_at=clock_timestamp(),result_receipt_id=receipt where id=r.id;
 return public.review_assistant_operation(r.id);
end $$;
revoke all on function private.confirm_assistant_before_receiving(uuid,uuid),private.review_assistant_before_receiving(uuid),
 private.require_assistant_kind_before_receiving(text),private.assistant_preview_before_receiving(text,jsonb),
 private.require_assistant_receiving_access(),private.assistant_receiving_preview(jsonb),
 private.require_assistant_kind_access(text),private.assistant_operation_preview(text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.review_assistant_operation(uuid),public.confirm_assistant_operation(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.review_assistant_operation(uuid),public.confirm_assistant_operation(uuid,uuid) to authenticated;
commit;
