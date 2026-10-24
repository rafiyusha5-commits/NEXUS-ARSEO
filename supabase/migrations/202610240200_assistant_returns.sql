-- Reviewed customer return into quarantine. No disposition or payment authority.
begin;
alter table private.assistant_operations add column if not exists result_return_id uuid references public.customer_returns(id);
alter table private.assistant_operations drop constraint if exists assistant_operations_kind_check;
alter table private.assistant_operations add constraint assistant_operations_kind_check check(kind in
 ('inventory_transfer','customer_order_fulfillment','customer_order_create','customer_order_reserve','customer_order_confirm','shipment_transport_receive','customer_return_create'));
do $$begin
 if to_regprocedure('private.confirm_assistant_before_returns(uuid,uuid)') is null then
  alter function public.confirm_assistant_operation(uuid,uuid) set schema private;
  alter function private.confirm_assistant_operation(uuid,uuid) rename to confirm_assistant_before_returns;
  alter function public.review_assistant_operation(uuid) set schema private;
  alter function private.review_assistant_operation(uuid) rename to review_assistant_before_returns;
  alter function private.require_assistant_kind_access(text) rename to require_assistant_kind_before_returns;
  alter function private.assistant_operation_preview(text,jsonb) rename to assistant_preview_before_returns;
 end if;
end $$;

create or replace function private.require_assistant_return_access() returns void
language plpgsql security definer set search_path='' as $$begin
 if auth.uid() is null or not private.is_active_employee(auth.uid()) or not (
  private.has_permission('agent.use') and private.has_permission('sales.view') and private.has_permission('sales.returns')
  and private.has_permission('customers.view') and private.has_permission('products.view')
  and private.has_permission('inventory.view') and private.has_permission('warehouses.view')) then
  raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';
 end if;
end $$;

create or replace function public.assistant_customer_return_options(p_sale_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.sales;
begin
 perform private.require_assistant_return_access();
 select * into s from public.sales where id=p_sale_id;
 if not found or not private.can_access_counterparty_record('view',s.customer_id) then
  raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if s.status<>'shipped' then raise exception 'ASSISTANT_RETURN_STATE';end if;
 return (select coalesce(jsonb_agg(value order by value->>'sale_item_id',value->>'batch_id'),'[]'::jsonb)
  from jsonb_array_elements(public.customer_return_options(s.id)));
end $$;

create or replace function private.assistant_return_preview(p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.sales; opts jsonb; l jsonb; o jsonb; i public.sale_items;
 rows jsonb:='[]'; seen text[]:='{}'; k text; q numeric; total numeric:=0; stamp jsonb;
begin
 perform private.require_assistant_return_access();
 if jsonb_typeof(p) is distinct from 'object' then raise exception 'ASSISTANT_RETURN_INVALID';end if;
 if (select count(*) from jsonb_object_keys(p))<>3 or not p ?& array['sale_id','reason','lines']
  or jsonb_typeof(p->'sale_id') is distinct from 'string' or jsonb_typeof(p->'reason') is distinct from 'string'
  or length(btrim(p->>'reason')) not between 1 and 500 or jsonb_typeof(p->'lines') is distinct from 'array' then raise exception 'ASSISTANT_RETURN_INVALID';end if;
 if jsonb_array_length(p->'lines') not between 1 and 20 then raise exception 'ASSISTANT_RETURN_INVALID';end if;
 opts:=public.assistant_customer_return_options((p->>'sale_id')::uuid);
 select * into s from public.sales where id=(p->>'sale_id')::uuid;
 for l in select value from jsonb_array_elements(p->'lines') loop
  if jsonb_typeof(l) is distinct from 'object' then raise exception 'ASSISTANT_RETURN_INVALID';end if;
  if (select count(*) from jsonb_object_keys(l))<>4 or not l ?& array['sale_item_id','batch_id','quantity','reason_code']
   or jsonb_typeof(l->'sale_item_id') is distinct from 'string' or jsonb_typeof(l->'batch_id') is distinct from 'string'
   or jsonb_typeof(l->'quantity') is distinct from 'string' or (l->>'quantity') !~ '^(0|[1-9][0-9]{0,8})(\.[0-9]{1,3})?$'
   or jsonb_typeof(l->'reason_code') is distinct from 'string'
   or l->>'reason_code' not in ('defect','damaged','expiry','wrong_item','refused','other') then raise exception 'ASSISTANT_RETURN_INVALID';end if;
  k:=(l->>'sale_item_id')::uuid::text||':'||(l->>'batch_id')::uuid::text;
  if k=any(seen) then raise exception 'ASSISTANT_RETURN_INVALID';end if;
  seen:=seen||k; q:=(l->>'quantity')::numeric;
  if q<=0 then raise exception 'ASSISTANT_RETURN_INVALID';end if;
  select value into o from jsonb_array_elements(opts) where (value->>'sale_item_id')::uuid=(l->>'sale_item_id')::uuid and (value->>'batch_id')::uuid=(l->>'batch_id')::uuid;
  if not found or q>(o->>'available')::numeric then raise exception 'ASSISTANT_RETURN_STATE';end if;
  select * into i from public.sale_items where id=(l->>'sale_item_id')::uuid and sale_id=s.id;
  -- Do not invent a financial effect for a missing price.
  if not found or i.unit_price is null then raise exception 'ASSISTANT_RETURN_STATE';end if;
  total:=total+q*i.unit_price;
  rows:=rows||jsonb_build_array(o||jsonb_build_object('quantity',q::text,'reason_code',l->>'reason_code','unit_price',i.unit_price::text,'amount',(q*i.unit_price)::text));
 end loop;
 stamp:=jsonb_build_object('sale',to_jsonb(s),'options',opts,
  'items',(select jsonb_agg(to_jsonb(x) order by x.id) from public.sale_items x where x.sale_id=s.id),
  'returns',(select jsonb_agg(to_jsonb(x) order by x.id) from public.customer_returns x where x.sale_id=s.id));
 return jsonb_build_object('order_number',s.sale_number,'sale_id',s.id,
  'customer',(select coalesce(short_name,legal_name) from public.counterparties where id=s.customer_id),
  'warehouse',(select code||' · '||coalesce(name->>'ru',name->>'en','') from public.warehouses where id=s.warehouse_id),
  'currency',(select code from public.currencies where id=s.currency_id),'total',round(total,2)::text,
  'reason',btrim(p->>'reason'),'document_date',private.business_today(),'lines',rows,
  'performer',(select full_name from public.profiles where id=auth.uid()),
  'state_stamp',encode(sha256(convert_to(stamp::text,'UTF8')),'hex'));
exception when invalid_text_representation then raise exception 'ASSISTANT_RETURN_INVALID';
end $$;

create or replace function private.require_assistant_kind_access(p_kind text) returns void
language plpgsql security definer set search_path='' as $$begin
 if p_kind='customer_return_create' then perform private.require_assistant_return_access();
 else perform private.require_assistant_kind_before_returns(p_kind);end if;
end $$;
create or replace function private.assistant_operation_preview(p_kind text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 if p_kind='customer_return_create' then return private.assistant_return_preview(p_payload);
 else return private.assistant_preview_before_returns(p_kind,p_payload);end if;
end $$;
create or replace function public.review_assistant_operation(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations; v jsonb;
begin
 select * into r from private.assistant_operations where id=p_request_id and created_by=auth.uid();
 if not found then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.kind<>'customer_return_create' then return private.review_assistant_before_returns(p_request_id);end if;
 perform private.require_assistant_return_access();
 if not private.can_access_counterparty_record('view',(select customer_id from public.sales where id=(r.payload->>'sale_id')::uuid)) then
  raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.result_return_id is not null then return jsonb_build_object('id',r.id,'kind',r.kind,'status','completed','result_id',r.result_return_id,'sale_id',r.payload->>'sale_id');end if;
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 v:=private.assistant_return_preview(r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 return jsonb_build_object('id',r.id,'kind',r.kind,'status','awaiting_confirmation','review_token',r.review_token,'preview',v-'state_stamp','expires_at',r.expires_at);
end $$;
create or replace function public.confirm_assistant_operation(p_request_id uuid,p_review_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations; s public.sales; v jsonb; result uuid; lines jsonb;
begin
 select * into r from private.assistant_operations where id=p_request_id and created_by=auth.uid() for update;
 if not found or p_review_token is null or r.review_token<>p_review_token then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.kind<>'customer_return_create' then return private.confirm_assistant_before_returns(p_request_id,p_review_token);end if;
 perform private.require_assistant_return_access();
 if r.result_return_id is not null then return public.review_assistant_operation(r.id);end if;
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 -- Same sale lock as native creation serializes distinct proposals and manual returns.
 select * into s from public.sales where id=(r.payload->>'sale_id')::uuid for update;
 perform 1 from public.sale_items where sale_id=s.id order by id for share;
 perform 1 from public.customer_returns where sale_id=s.id order by id for update;
 perform 1 from public.inventory_reservations where sale_item_id in(select id from public.sale_items where sale_id=s.id) order by id for share;
 perform 1 from public.inventory_balances where id in(select inventory_balance_id from public.inventory_reservations where sale_item_id in(select id from public.sale_items where sale_id=s.id)) order by id for share;
 perform 1 from public.products where id in(select product_id from public.sale_items where sale_id=s.id) order by id for share;
 perform 1 from public.product_packaging where product_id in(select product_id from public.sale_items where sale_id=s.id) order by id for share;
 perform 1 from public.inventory_batches where id in(select (value->>'batch_id')::uuid from jsonb_array_elements(r.payload->'lines')) order by id for share;
 perform 1 from public.counterparties where id=s.customer_id for share;
 perform 1 from public.warehouses where id=s.warehouse_id for share;
 perform 1 from public.currencies where id=s.currency_id for share;
 perform 1 from public.profiles where id=auth.uid() for share;
 perform private.require_assistant_return_access();
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 v:=private.assistant_return_preview(r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 select jsonb_agg(value||jsonb_build_object('quantity',(value->>'quantity')::numeric)) into lines from jsonb_array_elements(r.payload->'lines');
 begin
  result:=public.create_customer_return(s.id,lines,r.payload->>'reason');
 exception when others then raise exception 'ASSISTANT_RETURN_REFUSED';end;
 update private.assistant_operations set confirmed_at=clock_timestamp(),result_return_id=result where id=r.id;
 return public.review_assistant_operation(r.id);
end $$;
revoke all on function private.confirm_assistant_before_returns(uuid,uuid),private.review_assistant_before_returns(uuid),
 private.require_assistant_kind_before_returns(text),private.assistant_preview_before_returns(text,jsonb),
 private.require_assistant_return_access(),private.assistant_return_preview(jsonb),
 private.require_assistant_kind_access(text),private.assistant_operation_preview(text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.assistant_customer_return_options(uuid),public.review_assistant_operation(uuid),public.confirm_assistant_operation(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.assistant_customer_return_options(uuid),public.review_assistant_operation(uuid),public.confirm_assistant_operation(uuid,uuid) to authenticated;
create or replace function private.agent_clean_tools(p_tools jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare e jsonb;k text;v jsonb;params jsonb;entry jsonb;result jsonb:='[]'::jsonb;
begin
 if p_tools is null then return result;end if;
 if jsonb_typeof(p_tools)<>'array' or jsonb_array_length(p_tools)>30 then raise exception 'AGENT_BAD_REQUEST' using errcode='22023';end if;
 for e in select x from jsonb_array_elements(p_tools) x loop
  if jsonb_typeof(e)<>'object' then raise exception 'AGENT_BAD_REQUEST' using errcode='22023';end if;
  if exists(select 1 from jsonb_object_keys(e) x where x not in ('name','params','rows','truncated','ms','error'))
     or not (e ? 'name' and e ? 'params' and e ? 'rows' and e ? 'truncated' and e ? 'ms')
     or jsonb_typeof(e->'name')<>'string' or jsonb_typeof(e->'params')<>'object' or jsonb_typeof(e->'rows')<>'number'
     or jsonb_typeof(e->'truncated')<>'boolean' or jsonb_typeof(e->'ms')<>'number' then
   raise exception 'AGENT_BAD_REQUEST' using errcode='22023';
  end if;
  if (e->>'name') not in ('find_shipments','get_shipment','get_shipment_vehicles','get_shipment_documents','get_document_extraction',
       'list_delayed_shipments','get_stock_status','get_return_options','find_products','find_drive_documents','get_drive_document','search_system','get_system_record','get_my_tasks','get_help','speech_to_text','unknown')
     or (e->>'rows') !~ '^(100|[0-9]{1,2})$' or (e->>'ms') !~ '^(120000|1[01][0-9]{4}|[0-9]{1,5})$'
     or (e ? 'error' and (jsonb_typeof(e->'error')<>'string' or (e->>'error') not in
       ('TOOL_CALL_LIMIT','UNKNOWN_TOOL','INVALID_PARAMS','PERMISSION_DENIED','TOOL_TIMEOUT','TOOL_ERROR'))) then
   raise exception 'AGENT_BAD_REQUEST' using errcode='22023';
  end if;
  params:='{}'::jsonb;
  for k,v in select * from jsonb_each(e->'params') loop
   if k in ('query','product_query') and jsonb_typeof(v)='string' then
    params:=params||jsonb_build_object(k,coalesce(private.agent_clean_text(v#>>'{}',60),''));
   elsif k='drive_id' and jsonb_typeof(v)='string' and length(v#>>'{}')<=120 and ((v#>>'{}') ~ '^[A-Za-z0-9_-]{10,120}$' or v#>>'{}'='[скрыто]') then
    params:=params||jsonb_build_object(k,v);
   elsif k in ('status','type','filter','topic','date_kind','section','related_by') and jsonb_typeof(v)='string' and (v#>>'{}') ~ '^[a-z_]{1,40}$' then
    params:=params||jsonb_build_object(k,v);
   elsif k='warehouse_code' and jsonb_typeof(v)='string' and (v#>>'{}') ~ '^[A-Z_]{2,20}$' then
    params:=params||jsonb_build_object(k,v);
   elsif k='fields' and jsonb_typeof(v)='string' and length(v#>>'{}')<=200 and (v#>>'{}') ~ '^[a-z_]+(,[a-z_]+)*$' then
    params:=params||jsonb_build_object(k,v);
   elsif k in ('date','date_to') and jsonb_typeof(v)='string' and (v#>>'{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    params:=params||jsonb_build_object(k,v);
   elsif k='duration_seconds' and jsonb_typeof(v)='number' and (v#>>'{}') ~ '^([0-9]|[1-5][0-9]|60)(\.[0-9])?$' then
    params:=params||jsonb_build_object(k,v);
   elsif k='offset' and jsonb_typeof(v)='number' and (v#>>'{}') ~ '^(10000|[0-9]{1,4})$' then
    params:=params||jsonb_build_object(k,v);
   elsif k='limit' and jsonb_typeof(v)='number' and (v#>>'{}') ~ '^([1-9]|1[0-9]|20)$' then
    params:=params||jsonb_build_object(k,v);
   elsif k in ('sale_id','shipment_id','document_id','record_id','parent_id') and jsonb_typeof(v)='string'
     and (v#>>'{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    params:=params||jsonb_build_object(k,v);
   else
    raise exception 'AGENT_BAD_REQUEST' using errcode='22023';
   end if;
  end loop;
  entry:=jsonb_build_object('name',e->'name','params',params,'rows',e->'rows','truncated',e->'truncated','ms',e->'ms');
  if e ? 'error' then entry:=entry||jsonb_build_object('error',e->'error');end if;
  result:=result||jsonb_build_array(entry);
 end loop;
 return result;
end$$;
revoke all on function private.agent_clean_tools(jsonb) from public,anon,authenticated,service_role;
commit;
