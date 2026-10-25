-- One whole quarantined return line, using the existing decision RPC.
begin;
alter table private.assistant_operations drop constraint if exists assistant_operations_kind_check;
alter table private.assistant_operations add constraint assistant_operations_kind_check check(kind in
 ('inventory_transfer','customer_order_fulfillment','customer_order_create','customer_order_reserve','customer_order_confirm','shipment_transport_receive','customer_return_create','customer_return_decide'));
do $$begin
 if to_regprocedure('private.confirm_assistant_before_decisions(uuid,uuid)') is null then
  alter function public.confirm_assistant_operation(uuid,uuid) set schema private;
  alter function private.confirm_assistant_operation(uuid,uuid) rename to confirm_assistant_before_decisions;
  alter function public.review_assistant_operation(uuid) set schema private;
  alter function private.review_assistant_operation(uuid) rename to review_assistant_before_decisions;
  alter function private.require_assistant_kind_access(text) rename to require_assistant_kind_before_decisions;
  alter function private.assistant_operation_preview(text,jsonb) rename to assistant_preview_before_decisions;
 end if;
end $$;
create or replace function private.require_assistant_decision_access(p_decision text default null) returns void
language plpgsql security definer set search_path='' as $$begin
 if auth.uid() is null or not private.is_active_employee(auth.uid()) or not (
  private.has_permission('agent.use') and private.has_permission('sales.view') and private.has_permission('customers.view')
  and private.has_permission('inventory.view') and private.has_permission('products.view') and private.has_permission('warehouses.view')) then
  raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if p_decision is null then
  if not (private.has_permission('inventory.receive') or private.has_permission('inventory.write_off')) then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 elsif p_decision not in ('restock','write_off','return_to_supplier') then raise exception 'ASSISTANT_DECISION_INVALID';
 elsif not private.has_permission(case p_decision when 'restock' then 'inventory.receive' else 'inventory.write_off' end) then
  raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';
 end if;
end $$;
create or replace function public.assistant_return_decision_options(p_sale_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare customer uuid;
begin
 perform private.require_assistant_decision_access();
 select customer_id into customer from public.sales where id=p_sale_id;
 if not found or not private.can_access_counterparty_record('view',customer) then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('item_id',ri.id,'return_number',cr.return_number,
  'product_name',coalesce(p.name->>'ru',p.name->>'en',p.internal_sku),'batch_number',b.batch_number,
  'quantity',ri.quantity,'uom',ri.uom,'batch_status',b.status,'expiry_date',b.expiry_date,'warehouse_id',cr.warehouse_id)
  order by cr.return_number,ri.id)
  from public.customer_return_items ri join public.customer_returns cr on cr.id=ri.return_id
  join public.inventory_batches b on b.id=ri.batch_id join public.products p on p.id=b.product_id
  where cr.sale_id=p_sale_id and cr.status='quarantine' and ri.decision is null),'[]'::jsonb);
end $$;
create or replace function private.assistant_decision_preview(p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare ri public.customer_return_items; cr public.customer_returns; b public.inventory_batches; loc public.warehouse_locations;
 decision text; note text; location uuid; stamp jsonb;
begin
 perform private.require_assistant_decision_access();
 if jsonb_typeof(p) is distinct from 'object' then raise exception 'ASSISTANT_DECISION_INVALID';end if;
 if (select count(*) from jsonb_object_keys(p))<>4 or not p ?& array['item_id','decision','location_id','note']
  or jsonb_typeof(p->'item_id') is distinct from 'string' or jsonb_typeof(p->'decision') is distinct from 'string'
  or jsonb_typeof(p->'location_id') not in ('string','null') or jsonb_typeof(p->'note') not in ('string','null') then raise exception 'ASSISTANT_DECISION_INVALID';end if;
 decision:=p->>'decision';note:=nullif(btrim(p->>'note'),'');location:=(p->>'location_id')::uuid;
 perform private.require_assistant_decision_access(decision);
 if (p->>'note' is not null and (note is null or length(note)>500))
  or (decision<>'restock' and (note is null or location is not null)) then raise exception 'ASSISTANT_DECISION_INVALID';end if;
 select * into ri from public.customer_return_items where id=(p->>'item_id')::uuid;
 if not found then raise exception 'ASSISTANT_DECISION_STATE';end if;
 select * into cr from public.customer_returns where id=ri.return_id;
 if not private.can_access_counterparty_record('view',cr.customer_id) then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if cr.status<>'quarantine' or ri.decision is not null then raise exception 'ASSISTANT_DECISION_STATE';end if;
 select * into b from public.inventory_batches where id=ri.batch_id;
 if location is not null then
  select * into loc from public.warehouse_locations where id=location and warehouse_id=cr.warehouse_id and status='active';
  if not found then raise exception 'ASSISTANT_DECISION_STATE';end if;
 end if;
 stamp:=jsonb_build_object('item',to_jsonb(ri),'return',to_jsonb(cr),'batch',to_jsonb(b),'location',to_jsonb(loc));
 return jsonb_build_object('return_id',cr.id,'return_number',cr.return_number,'decision',decision,'note',note,
  'order_number',(select sale_number from public.sales where id=cr.sale_id),
  'customer',(select coalesce(short_name,legal_name) from public.counterparties where id=cr.customer_id),
  'product',(select coalesce(name->>'ru',name->>'en',internal_sku) from public.products where id=b.product_id),
  'batch',b.batch_number,'batch_status',b.status,'expiry',b.expiry_date,'quantity',ri.quantity::text,'uom',ri.uom,
  'warehouse',(select code||' · '||coalesce(name->>'ru',name->>'en','') from public.warehouses where id=cr.warehouse_id),
  'location',loc.code,'document_date',private.business_today(),
  'performer',(select full_name from public.profiles where id=auth.uid()),
  'state_stamp',encode(sha256(convert_to(stamp::text,'UTF8')),'hex'));
exception when invalid_text_representation then raise exception 'ASSISTANT_DECISION_INVALID';
end $$;
create or replace function private.require_assistant_kind_access(p_kind text) returns void
language plpgsql security definer set search_path='' as $$begin
 if p_kind='customer_return_decide' then perform private.require_assistant_decision_access();
 else perform private.require_assistant_kind_before_decisions(p_kind);end if;
end $$;
create or replace function private.assistant_operation_preview(p_kind text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 if p_kind='customer_return_decide' then return private.assistant_decision_preview(p_payload);
 else return private.assistant_preview_before_decisions(p_kind,p_payload);end if;
end $$;
create or replace function public.review_assistant_operation(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations; v jsonb;
begin
 select * into r from private.assistant_operations where id=p_request_id and created_by=auth.uid();
 if not found then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.kind<>'customer_return_decide' then return private.review_assistant_before_decisions(p_request_id);end if;
 perform private.require_assistant_decision_access(r.payload->>'decision');
 if not private.can_access_counterparty_record('view',(select cr.customer_id from public.customer_returns cr join public.customer_return_items ri on ri.return_id=cr.id where ri.id=(r.payload->>'item_id')::uuid)) then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.result_return_id is not null then return jsonb_build_object('id',r.id,'kind',r.kind,'status','completed','result_id',r.result_return_id,'decision',r.payload->>'decision');end if;
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 v:=private.assistant_decision_preview(r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 return jsonb_build_object('id',r.id,'kind',r.kind,'status','awaiting_confirmation','review_token',r.review_token,'preview',v-'state_stamp','expires_at',r.expires_at);
end $$;
create or replace function public.confirm_assistant_operation(p_request_id uuid,p_review_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations; ri public.customer_return_items; cr public.customer_returns; v jsonb;
begin
 select * into r from private.assistant_operations where id=p_request_id and created_by=auth.uid() for update;
 if not found or p_review_token is null or r.review_token<>p_review_token then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.kind<>'customer_return_decide' then return private.confirm_assistant_before_decisions(p_request_id,p_review_token);end if;
 perform private.require_assistant_decision_access(r.payload->>'decision');
 if r.result_return_id is not null then return public.review_assistant_operation(r.id);end if;
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 -- Same item -> return -> batch order as native. Never lock sibling items here.
 select * into ri from public.customer_return_items where id=(r.payload->>'item_id')::uuid for update;
 select * into cr from public.customer_returns where id=ri.return_id for update;
 perform 1 from public.inventory_batches where id=ri.batch_id for update;
 perform 1 from public.products where id=(select product_id from public.inventory_batches where id=ri.batch_id) for share;
 perform 1 from public.warehouse_locations where id=(r.payload->>'location_id')::uuid for share;
 perform 1 from public.warehouses where id=cr.warehouse_id for share;
 perform 1 from public.counterparties where id=cr.customer_id for share;
 perform 1 from public.profiles where id=auth.uid() for share;
 perform private.require_assistant_decision_access(r.payload->>'decision');
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 v:=private.assistant_decision_preview(r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 begin
  perform public.decide_customer_return_item(ri.id,r.payload->>'decision',(r.payload->>'location_id')::uuid,r.payload->>'note');
 exception when others then raise exception 'ASSISTANT_DECISION_REFUSED';end;
 update private.assistant_operations set confirmed_at=clock_timestamp(),result_return_id=cr.id where id=r.id;
 return public.review_assistant_operation(r.id);
end $$;
revoke all on function private.confirm_assistant_before_decisions(uuid,uuid),private.review_assistant_before_decisions(uuid),
 private.require_assistant_kind_before_decisions(text),private.assistant_preview_before_decisions(text,jsonb),
 private.require_assistant_decision_access(text),private.assistant_decision_preview(jsonb),
 private.require_assistant_kind_access(text),private.assistant_operation_preview(text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.assistant_return_decision_options(uuid),public.review_assistant_operation(uuid),public.confirm_assistant_operation(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.assistant_return_decision_options(uuid),public.review_assistant_operation(uuid),public.confirm_assistant_operation(uuid,uuid) to authenticated;
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
       'list_delayed_shipments','get_stock_status','get_return_options','get_return_decisions','find_products','find_drive_documents','get_drive_document','search_system','get_system_record','get_my_tasks','get_help','speech_to_text','unknown')
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
