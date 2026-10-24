-- Cancel an entire undecided return through the native RPC after explicit review.
begin;
alter table private.assistant_operations drop constraint if exists assistant_operations_kind_check;
alter table private.assistant_operations add constraint assistant_operations_kind_check check(kind in
 ('inventory_transfer','customer_order_fulfillment','customer_order_create','customer_order_reserve','customer_order_confirm','shipment_transport_receive','customer_return_create','customer_return_decide','customer_return_cancel'));
do $$begin
 if to_regprocedure('private.confirm_assistant_before_cancellations(uuid,uuid)') is null then
  alter function public.confirm_assistant_operation(uuid,uuid) set schema private;
  alter function private.confirm_assistant_operation(uuid,uuid) rename to confirm_assistant_before_cancellations;
  alter function public.review_assistant_operation(uuid) set schema private;
  alter function private.review_assistant_operation(uuid) rename to review_assistant_before_cancellations;
  alter function private.require_assistant_kind_access(text) rename to require_assistant_kind_before_cancellations;
  alter function private.assistant_operation_preview(text,jsonb) rename to assistant_preview_before_cancellations;
 end if;
end $$;
create or replace function public.assistant_return_cancellation_options(p_sale_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare customer uuid;
begin
 perform private.require_assistant_return_access();
 select customer_id into customer from public.sales where id=p_sale_id;
 if not found or not private.can_access_counterparty_record('view',customer) then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('return_id',cr.id,'return_number',cr.return_number,
  'line_count',(select count(*) from public.customer_return_items ri where ri.return_id=cr.id)) order by cr.return_number)
  from public.customer_returns cr where cr.sale_id=p_sale_id and cr.status='quarantine'
  and not exists(select 1 from public.customer_return_items ri where ri.return_id=cr.id and ri.decision is not null)),'[]'::jsonb);
end $$;
create or replace function private.assistant_cancel_preview(p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare cr public.customer_returns; s public.sales; rows jsonb; stamp jsonb; total numeric;
begin
 perform private.require_assistant_return_access();
 if jsonb_typeof(p) is distinct from 'object' then raise exception 'ASSISTANT_CANCEL_INVALID';end if;
 if (select count(*) from jsonb_object_keys(p))<>2 or not p ?& array['return_id','reason']
  or jsonb_typeof(p->'return_id') is distinct from 'string' or jsonb_typeof(p->'reason') is distinct from 'string'
  or length(btrim(p->>'reason')) not between 1 and 500 then raise exception 'ASSISTANT_CANCEL_INVALID';end if;
 select * into cr from public.customer_returns where id=(p->>'return_id')::uuid;
 if not found then raise exception 'ASSISTANT_CANCEL_STATE';end if;
 if not private.can_access_counterparty_record('view',cr.customer_id) then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if cr.status<>'quarantine' or exists(select 1 from public.customer_return_items where return_id=cr.id and decision is not null)
  or (select count(*) from public.customer_return_items where return_id=cr.id) not between 1 and 20
  or exists(select 1 from public.customer_return_items where return_id=cr.id and unit_price is null) then raise exception 'ASSISTANT_CANCEL_STATE';end if;
 select * into s from public.sales where id=cr.sale_id;
 select jsonb_agg(jsonb_build_object('id',ri.id,'product',coalesce(pr.name->>'ru',pr.name->>'en',pr.internal_sku),
  'batch',b.batch_number,'quantity',ri.quantity::text,'uom',ri.uom,'amount',round(ri.quantity*ri.unit_price,2)::text) order by ri.id),
  sum(ri.quantity*ri.unit_price) into rows,total
 from public.customer_return_items ri join public.inventory_batches b on b.id=ri.batch_id join public.products pr on pr.id=b.product_id where ri.return_id=cr.id;
 stamp:=jsonb_build_object('return',to_jsonb(cr),'items',(select jsonb_agg(to_jsonb(x) order by x.id) from public.customer_return_items x where x.return_id=cr.id));
 return jsonb_build_object('return_number',cr.return_number,'order_number',s.sale_number,
  'customer',(select coalesce(short_name,legal_name) from public.counterparties where id=cr.customer_id),
  'warehouse',(select code||' · '||coalesce(name->>'ru',name->>'en','') from public.warehouses where id=cr.warehouse_id),
  'currency',(select code from public.currencies where id=private.sale_currency(s.id)),'total',round(total,2)::text,
  'reason',btrim(p->>'reason'),'document_date',private.business_today(),'lines',rows,
  'performer',(select full_name from public.profiles where id=auth.uid()),
  'state_stamp',encode(sha256(convert_to(stamp::text,'UTF8')),'hex'));
exception when invalid_text_representation then raise exception 'ASSISTANT_CANCEL_INVALID';
end $$;
create or replace function private.require_assistant_kind_access(p_kind text) returns void
language plpgsql security definer set search_path='' as $$begin
 if p_kind='customer_return_cancel' then perform private.require_assistant_return_access();
 else perform private.require_assistant_kind_before_cancellations(p_kind);end if;
end $$;
create or replace function private.assistant_operation_preview(p_kind text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 if p_kind='customer_return_cancel' then return private.assistant_cancel_preview(p_payload);
 else return private.assistant_preview_before_cancellations(p_kind,p_payload);end if;
end $$;
create or replace function public.review_assistant_operation(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations; v jsonb;
begin
 select * into r from private.assistant_operations where id=p_request_id and created_by=auth.uid();
 if not found then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.kind<>'customer_return_cancel' then return private.review_assistant_before_cancellations(p_request_id);end if;
 perform private.require_assistant_return_access();
 if not private.can_access_counterparty_record('view',(select customer_id from public.customer_returns where id=(r.payload->>'return_id')::uuid)) then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.result_return_id is not null then return jsonb_build_object('id',r.id,'kind',r.kind,'status','completed','result_id',r.result_return_id);end if;
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 v:=private.assistant_cancel_preview(r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 return jsonb_build_object('id',r.id,'kind',r.kind,'status','awaiting_confirmation','review_token',r.review_token,'preview',v-'state_stamp','expires_at',r.expires_at);
end $$;
create or replace function public.confirm_assistant_operation(p_request_id uuid,p_review_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations; cr public.customer_returns; v jsonb;
begin
 select * into r from private.assistant_operations where id=p_request_id and created_by=auth.uid() for update;
 if not found or p_review_token is null or r.review_token<>p_review_token then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.kind<>'customer_return_cancel' then return private.confirm_assistant_before_cancellations(p_request_id,p_review_token);end if;
 perform private.require_assistant_return_access();
 if r.result_return_id is not null then return public.review_assistant_operation(r.id);end if;
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 -- Native cancellation locks only the header. Never lock items after this:
 -- a decision may already hold its item while waiting for the same header.
 select * into cr from public.customer_returns where id=(r.payload->>'return_id')::uuid for update;
 perform 1 from public.counterparties where id=cr.customer_id for share;
 perform 1 from public.warehouses where id=cr.warehouse_id for share;
 perform 1 from public.profiles where id=auth.uid() for share;
 perform private.require_assistant_return_access();
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 v:=private.assistant_cancel_preview(r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 begin
  perform public.cancel_customer_return(cr.id,r.payload->>'reason');
 exception when others then raise exception 'ASSISTANT_CANCEL_REFUSED';end;
 update private.assistant_operations set confirmed_at=clock_timestamp(),result_return_id=cr.id where id=r.id;
 return public.review_assistant_operation(r.id);
end $$;
revoke all on function private.confirm_assistant_before_cancellations(uuid,uuid),private.review_assistant_before_cancellations(uuid),
 private.require_assistant_kind_before_cancellations(text),private.assistant_preview_before_cancellations(text,jsonb),
 private.assistant_cancel_preview(jsonb),private.require_assistant_kind_access(text),private.assistant_operation_preview(text,jsonb)
 from public,anon,authenticated,service_role;
revoke all on function public.assistant_return_cancellation_options(uuid),public.review_assistant_operation(uuid),public.confirm_assistant_operation(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.assistant_return_cancellation_options(uuid),public.review_assistant_operation(uuid),public.confirm_assistant_operation(uuid,uuid) to authenticated;
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
       'list_delayed_shipments','get_stock_status','get_return_options','get_return_decisions','get_return_cancellations','find_products','find_drive_documents','get_drive_document','search_system','get_system_record','get_my_tasks','get_help','speech_to_text','unknown')
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
