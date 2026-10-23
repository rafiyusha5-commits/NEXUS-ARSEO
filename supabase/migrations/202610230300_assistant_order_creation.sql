-- A reviewed draft, not reservation, confirmation, shipment, or payment.
begin;
alter table private.assistant_operations drop constraint if exists assistant_operations_kind_check;
alter table private.assistant_operations add constraint assistant_operations_kind_check
 check(kind in ('inventory_transfer','customer_order_fulfillment','customer_order_create'));

-- Preserve the tested stock adapters. Future commands extend dispatch, not a queue or stock algorithm.
do $$begin
 if to_regprocedure('private.confirm_assistant_stock_operation(uuid,uuid)') is null then
  alter function public.confirm_assistant_operation(uuid,uuid) set schema private;
  alter function private.confirm_assistant_operation(uuid,uuid) rename to confirm_assistant_stock_operation;
 end if;
end $$;
revoke all on function private.confirm_assistant_stock_operation(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function private.require_assistant_draft_access() returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.is_active_employee(auth.uid()) or not (
  private.has_permission('agent.use') and private.has_permission('sales.view') and private.has_permission('sales.manage')
  and private.has_permission('customers.view') and private.has_permission('products.view') and private.has_permission('warehouses.view')) then
  raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';
 end if;
end $$;

create or replace function private.assistant_draft_preview(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare customer uuid; contract uuid; warehouse uuid; currency uuid; planned date;
 c public.counterparties; ct public.contracts; w public.warehouses; cu public.currencies;
 item jsonb; p public.products; q numeric; price numeric; total numeric:=0; items jsonb:='[]'; stamp jsonb;
begin
 perform private.require_assistant_draft_access();
 if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'ASSISTANT_OPERATION_DRAFT_INVALID';end if;
 if (select count(*) from jsonb_object_keys(p_payload))<>6 or
  not p_payload ?& array['customer_id','contract_id','warehouse_id','currency_id','planned_shipment_date','items'] or
  jsonb_typeof(p_payload->'items') is distinct from 'array' then raise exception 'ASSISTANT_OPERATION_DRAFT_INVALID';end if;
 if jsonb_array_length(p_payload->'items') not between 1 and 25 then raise exception 'ASSISTANT_OPERATION_DRAFT_INVALID';end if;
 begin
  customer:=(p_payload->>'customer_id')::uuid;contract:=(p_payload->>'contract_id')::uuid;
  warehouse:=(p_payload->>'warehouse_id')::uuid;currency:=(p_payload->>'currency_id')::uuid;
  planned:=(p_payload->>'planned_shipment_date')::date;
 exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then raise exception 'ASSISTANT_OPERATION_DRAFT_INVALID';end;
 if customer is null or warehouse is null or currency is null or planned is null or planned<private.business_today()
  or p_payload->>'planned_shipment_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'ASSISTANT_OPERATION_DRAFT_INVALID';end if;
 if not private.can_access_counterparty_record('view',customer) then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 select * into c from public.counterparties where id=customer and status='active' and 'customer'=any(roles);
 if not found then raise exception 'ASSISTANT_OPERATION_DRAFT_SOURCE';end if;
 if contract is not null then
  select * into ct from public.contracts where id=contract and counterparty_id=customer and status='active';
  if not found then raise exception 'ASSISTANT_OPERATION_DRAFT_SOURCE';end if;
 end if;
 select * into w from public.warehouses where id=warehouse and status='active' and not is_virtual;
 if not found then raise exception 'ASSISTANT_OPERATION_DRAFT_SOURCE';end if;
 select * into cu from public.currencies where id=currency and is_active;
 if not found then raise exception 'ASSISTANT_OPERATION_DRAFT_SOURCE';end if;
 -- Row fingerprints stay private. The projection below exposes neither notes nor contact/bank details.
 stamp:=jsonb_build_object('customer',to_jsonb(c),'contract',to_jsonb(ct),'warehouse',to_jsonb(w),'currency',to_jsonb(cu),'products','[]'::jsonb);
 for item in select value from jsonb_array_elements(p_payload->'items') loop
  if jsonb_typeof(item) is distinct from 'object' then raise exception 'ASSISTANT_OPERATION_DRAFT_INVALID';end if;
  if (select count(*) from jsonb_object_keys(item))<>4 or not item ?& array['product_id','quantity','uom','unit_price']
   or jsonb_typeof(item->'quantity') is distinct from 'string' or jsonb_typeof(item->'unit_price') is distinct from 'string'
   or item->>'quantity' !~ '^(0|[1-9][0-9]{0,8})(\.[0-9]{1,3})?$'
   or item->>'unit_price' !~ '^(0|[1-9][0-9]{0,9})(\.[0-9]{1,4})?$'
   or coalesce(item->>'uom','') not in ('piece','box','layer','pallet','truck') then raise exception 'ASSISTANT_OPERATION_DRAFT_INVALID';end if;
  begin
   select * into p from public.products where id=(item->>'product_id')::uuid and status='active';
  exception when invalid_text_representation then raise exception 'ASSISTANT_OPERATION_DRAFT_INVALID';end;
  if not found then raise exception 'ASSISTANT_OPERATION_DRAFT_SOURCE';end if;
  q:=(item->>'quantity')::numeric;price:=(item->>'unit_price')::numeric;
  if q<=0 or exists(select 1 from jsonb_array_elements(items) a where a->>'product_id'=p.id::text and a->>'uom'=item->>'uom') then
   raise exception 'ASSISTANT_OPERATION_DRAFT_INVALID';end if;
  total:=total+q*price;
  items:=items||jsonb_build_array(jsonb_build_object('id',p.id::text||':'||(item->>'uom'),'product_id',p.id,
   'product',p.internal_sku||' · '||coalesce(p.name->>'ru',p.name->>'en',''),'quantity',q::text,'uom',item->>'uom',
   'unit_price',price::text,'line_amount',(q*price)::text,'required_shelf_life_pct',c.min_remaining_shelf_life_pct));
  stamp:=jsonb_set(stamp,'{products}',(stamp->'products')||jsonb_build_array(to_jsonb(p)));
 end loop;
 -- Same rounding as private.sale_amount; checked against that function after creation in the same transaction.
 return jsonb_build_object('customer',coalesce(c.short_name,c.legal_name),'contract',ct.number,
  'contract_currency',(select code from public.currencies where id=ct.currency_id),
  'contract_valid_from',ct.valid_from,'contract_valid_to',ct.valid_to,
  'warehouse',w.code||' · '||coalesce(w.name->>'ru',w.name->>'en',''),
  'currency',cu.code,'planned_date',planned,'document_date',private.business_today(),'items',items,'lines','[]'::jsonb,
  'total',round(total,2)::text,'state_stamp',encode(sha256(convert_to(stamp::text,'UTF8')),'hex'));
end $$;

create or replace function private.require_assistant_kind_access(p_kind text) returns void
language plpgsql security definer set search_path='' as $$begin
 case p_kind
  when 'inventory_transfer' then perform private.require_assistant_operation_access();
  when 'customer_order_fulfillment' then perform private.require_assistant_order_access();
  when 'customer_order_create' then perform private.require_assistant_draft_access();
  else raise exception 'ASSISTANT_OPERATION_INVALID';
 end case;
end $$;
create or replace function private.assistant_operation_preview(p_kind text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 case p_kind
  when 'inventory_transfer' then return private.assistant_transfer_preview(p_payload);
  when 'customer_order_fulfillment' then return private.assistant_order_preview(p_payload);
  when 'customer_order_create' then return private.assistant_draft_preview(p_payload);
  else raise exception 'ASSISTANT_OPERATION_INVALID';
 end case;
end $$;

create or replace function public.prepare_assistant_operation(p_request_id uuid,p_kind text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations; v jsonb;
begin
 perform private.require_assistant_kind_access(p_kind);
 if p_request_id is null then raise exception 'ASSISTANT_OPERATION_INVALID';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,230100));
 select * into r from private.assistant_operations where id=p_request_id;
 if found then
  if r.created_by<>auth.uid() or r.kind<>p_kind or r.payload is distinct from p_payload then raise exception 'ASSISTANT_OPERATION_DENIED';end if;
 else
  v:=private.assistant_operation_preview(p_kind,p_payload);
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
 perform private.require_assistant_kind_access(r.kind);
 if coalesce(r.result_id,r.result_sale_id) is not null then return jsonb_build_object('id',r.id,'kind',r.kind,'status','completed','result_id',coalesce(r.result_id,r.result_sale_id));end if;
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 v:=private.assistant_operation_preview(r.kind,r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 return jsonb_build_object('id',r.id,'kind',r.kind,'status','awaiting_confirmation','review_token',r.review_token,
  'preview',v-'state_stamp'-'stock_stamp'-'packaging_stamp','expires_at',r.expires_at);
end $$;
create or replace function public.confirm_assistant_operation(p_request_id uuid,p_review_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations; v jsonb; sale uuid; item jsonb;
begin
 select * into r from private.assistant_operations where id=p_request_id and created_by=auth.uid() for update;
 if not found or p_review_token is null or r.review_token<>p_review_token then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 perform private.require_assistant_kind_access(r.kind);
 if r.kind<>'customer_order_create' then return private.confirm_assistant_stock_operation(p_request_id,p_review_token);end if;
 if r.result_sale_id is not null then return jsonb_build_object('id',r.id,'kind',r.kind,'status','completed','result_id',r.result_sale_id);end if;
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 -- Shared locks freeze reviewed reference rows; no stock/price-list writes or locks.
 perform 1 from public.products where id in(select (a->>'product_id')::uuid from jsonb_array_elements(r.payload->'items') a) order by id for share;
 perform 1 from public.counterparties where id=(r.payload->>'customer_id')::uuid for share;
 perform 1 from public.contracts where id=(r.payload->>'contract_id')::uuid for share;
 perform 1 from public.warehouses where id=(r.payload->>'warehouse_id')::uuid for share;
 perform 1 from public.currencies where id in((r.payload->>'currency_id')::uuid,
  (select currency_id from public.contracts where id=(r.payload->>'contract_id')::uuid)) order by id for share;
 perform private.require_assistant_draft_access();
 v:=private.assistant_draft_preview(r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 sale:=public.create_customer_order((r.payload->>'customer_id')::uuid,(r.payload->>'contract_id')::uuid,
  (r.payload->>'warehouse_id')::uuid,(r.payload->>'planned_shipment_date')::date,(r.payload->>'currency_id')::uuid,null);
 for item in select value from jsonb_array_elements(r.payload->'items') loop
  perform public.add_customer_order_item(sale,(item->>'product_id')::uuid,(item->>'quantity')::numeric,item->>'uom',(item->>'unit_price')::numeric,null);
 end loop;
 if (select amount from private.sale_amount(sale)) is distinct from (v->>'total')::numeric then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 update private.assistant_operations set confirmed_at=clock_timestamp(),result_sale_id=sale where id=r.id;
 return jsonb_build_object('id',r.id,'kind',r.kind,'status','completed','result_id',sale);
end $$;
revoke all on function private.require_assistant_draft_access(),private.assistant_draft_preview(jsonb),
 private.require_assistant_kind_access(text),private.assistant_operation_preview(text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.prepare_assistant_operation(uuid,text,jsonb),public.review_assistant_operation(uuid),public.confirm_assistant_operation(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.prepare_assistant_operation(uuid,text,jsonb),public.review_assistant_operation(uuid),public.confirm_assistant_operation(uuid,uuid) to authenticated;
commit;
