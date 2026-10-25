-- Assistant proposal ledger. No model tool can call confirmation.
begin;
create table if not exists private.assistant_operations (
 id uuid primary key, created_by uuid not null references public.profiles(id),
 kind text not null check(kind in ('inventory_transfer')),
 payload jsonb not null, preview jsonb not null, review_token uuid not null default gen_random_uuid(),
 created_at timestamptz not null default clock_timestamp(), expires_at timestamptz not null default clock_timestamp()+interval '15 minutes',
 confirmed_at timestamptz, result_id uuid references public.inventory_operation_documents(id)
);
alter table private.assistant_operations enable row level security;
revoke all on private.assistant_operations from public,anon,authenticated,service_role;

create or replace function private.require_assistant_operation_access() returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not private.is_active_employee(auth.uid()) or not (
  private.has_permission('agent.use') and private.has_permission('inventory.move') and private.has_permission('inventory.view')
  and private.has_permission('products.view') and private.has_permission('warehouses.view')) then
  raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';
 end if;
end $$;

-- Explicit safe projection; never prices, costs or free-form source document text.
-- Uses the existing unit conversion. Missing packaging is not inferred from weight.
create or replace function private.assistant_transfer_preview(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare product uuid; src uuid; dst uuid; q numeric; remaining numeric; amount numeric;
 stock_uom text; requested_uom text; line record; allocations jsonb:='[]'; sources jsonb;
 product_label text; source_label text; destination_label text;
begin
 perform private.require_assistant_operation_access();
 if jsonb_typeof(p_payload) is distinct from 'object' or
  (select count(*) from jsonb_object_keys(p_payload))<>5 or
  not p_payload ?& array['product_id','from_warehouse_id','to_warehouse_id','quantity','uom'] or
  p_payload->>'quantity' !~ '^(0|[1-9][0-9]{0,8})(\.[0-9]{1,3})?$' then
  raise exception 'ASSISTANT_OPERATION_INVALID';end if;
 begin
  product:=(p_payload->>'product_id')::uuid;src:=(p_payload->>'from_warehouse_id')::uuid;dst:=(p_payload->>'to_warehouse_id')::uuid;
  q:=(p_payload->>'quantity')::numeric; requested_uom:=p_payload->>'uom';
 exception when invalid_text_representation then raise exception 'ASSISTANT_OPERATION_INVALID'; end;
 if product is null or src is null or dst is null or src=dst or q is null or q<=0 or requested_uom is null or
  requested_uom not in ('piece','box','layer','pallet','truck') then raise exception 'ASSISTANT_OPERATION_INVALID';end if;
 select internal_sku||' · '||coalesce(name->>'ru',name->>'en','') into product_label from public.products where id=product and status='active';
 select code||' · '||coalesce(name->>'ru',name->>'en','') into source_label from public.warehouses where id=src and status='active' and not is_virtual;
 select code||' · '||coalesce(name->>'ru',name->>'en','') into destination_label from public.warehouses where id=dst and status='active' and not is_virtual;
 if product_label is null or source_label is null or destination_label is null then raise exception 'ASSISTANT_OPERATION_INVALID';end if;
 -- A mixed-unit stock requires an employee's allocation; do not silently skip a balance.
 select min(b.uom) into stock_uom from public.inventory_balances b join public.inventory_batches x on x.id=b.batch_id
 where x.product_id=product and b.warehouse_id=src and x.status='available' and b.quantity_on_hand>b.quantity_reserved;
 if stock_uom is null then raise exception 'ASSISTANT_OPERATION_STOCK';end if;
 if exists(select 1 from public.inventory_balances b join public.inventory_batches x on x.id=b.batch_id where x.product_id=product
  and b.warehouse_id=src and x.status='available' and b.quantity_on_hand>b.quantity_reserved and b.uom<>stock_uom) then
  raise exception 'ASSISTANT_OPERATION_UNITS';end if;
 remaining:=private.convert_uom(product,q,requested_uom,stock_uom);
 if remaining is null or remaining<=0 then raise exception 'ASSISTANT_OPERATION_UNITS';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'batch_id',x.id,'batch',x.batch_number,'status',x.status,'expiry',x.expiry_date,
  'uom',b.uom,'on_hand',b.quantity_on_hand,'reserved',b.quantity_reserved,'location',b.warehouse_location_id)
  order by x.expiry_date nulls last,x.received_at,x.id,b.id),'[]') into sources
 from public.inventory_balances b join public.inventory_batches x on x.id=b.batch_id where x.product_id=product and b.warehouse_id=src;
 for line in select b.id,x.batch_number,x.expiry_date,b.quantity_on_hand-b.quantity_reserved as available
  from public.inventory_balances b join public.inventory_batches x on x.id=b.batch_id
  where x.product_id=product and b.warehouse_id=src and x.status='available' and b.uom=stock_uom and b.quantity_on_hand>b.quantity_reserved
  order by x.expiry_date nulls last,x.received_at,x.id,b.id loop
  exit when remaining=0;
  amount:=least(remaining,line.available);
  allocations:=allocations||jsonb_build_array(jsonb_build_object('balance_id',line.id,'batch',line.batch_number,'expiry',line.expiry_date,'quantity',amount,'uom',stock_uom));
  remaining:=remaining-amount;
 end loop;
 if remaining<>0 then raise exception 'ASSISTANT_OPERATION_STOCK';end if;
 return jsonb_build_object('product',product_label,'from',source_label,'to',destination_label,'quantity',q,'uom',requested_uom,'document_date',private.business_today(),
  'lines',allocations,'stock_stamp',encode(sha256(convert_to(sources::text,'UTF8')),'hex'),
  'packaging_stamp',encode(sha256(convert_to(coalesce((select jsonb_agg(jsonb_build_object('uom',uom,'units',units_per_parent) order by uom)::text
    from public.product_packaging where product_id=product),'[]'),'UTF8')),'hex'));
end $$;

create or replace function public.prepare_assistant_operation(p_request_id uuid,p_kind text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare row private.assistant_operations; view jsonb;
begin
 perform private.require_assistant_operation_access();
 if p_request_id is null or p_kind is distinct from 'inventory_transfer' then raise exception 'ASSISTANT_OPERATION_INVALID';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,230100));
 select * into row from private.assistant_operations where id=p_request_id;
 if found then
  if row.created_by<>auth.uid() or row.kind<>p_kind or row.payload<>p_payload then raise exception 'ASSISTANT_OPERATION_DENIED';end if;
  -- Return no archived details: current authority/data are checked below.
 else
  view:=private.assistant_transfer_preview(p_payload);
  insert into private.assistant_operations(id,created_by,kind,payload,preview) values(p_request_id,auth.uid(),p_kind,p_payload,view);
 end if;
 return jsonb_build_object('id',p_request_id);
end $$;

create or replace function public.review_assistant_operation(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare row private.assistant_operations; current_preview jsonb;
begin
 perform private.require_assistant_operation_access();
 select * into row from private.assistant_operations where id=p_request_id and created_by=auth.uid();
 if not found then raise exception 'ASSISTANT_OPERATION_DENIED';end if;
 if row.result_id is not null then return jsonb_build_object('id',row.id,'status','completed','result_id',row.result_id);end if;
 if row.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 current_preview:=private.assistant_transfer_preview(row.payload);
 if current_preview<>row.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 return jsonb_build_object('id',row.id,'status','awaiting_confirmation','review_token',row.review_token,'preview',row.preview-'stock_stamp'-'packaging_stamp','expires_at',row.expires_at);
end $$;

create or replace function public.confirm_assistant_operation(p_request_id uuid,p_review_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare row private.assistant_operations; product uuid; src uuid; dst uuid; current_preview jsonb; doc uuid; line jsonb;
begin
 perform private.require_assistant_operation_access();
 select * into row from private.assistant_operations where id=p_request_id and created_by=auth.uid() for update;
 if not found or p_review_token is null or row.review_token<>p_review_token then raise exception 'ASSISTANT_OPERATION_DENIED';end if;
 if row.result_id is not null then return jsonb_build_object('id',row.id,'status','completed','result_id',row.result_id);end if;
 if row.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 product:=(row.payload->>'product_id')::uuid;src:=(row.payload->>'from_warehouse_id')::uuid;dst:=(row.payload->>'to_warehouse_id')::uuid;
 -- Lock BOTH warehouses' balances before the existing posting function can lock a destination.
 -- Same balances -> batches -> products/packaging order as reservation replacement.
 perform 1 from public.inventory_balances b join public.inventory_batches x on x.id=b.batch_id
  where x.product_id=product and b.warehouse_id in(src,dst) order by b.id for update of b;
 perform 1 from public.inventory_batches where product_id=product order by id for share;
 perform 1 from public.products where id=product for share;
 perform 1 from public.product_packaging where product_id=product order by id for share;
 perform 1 from public.warehouses where id in(src,dst) order by id for share;
 perform private.require_assistant_operation_access();
 current_preview:=private.assistant_transfer_preview(row.payload);
 if current_preview<>row.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 -- Recheck the deadline after all input locks and preview validation.
 if row.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 doc:=public.create_inventory_operation_document('transfer',private.business_today(),src,dst,'Ассистент: подтверждено сотрудником',null,null);
 for line in select value from jsonb_array_elements(current_preview->'lines') loop
  perform public.add_inventory_operation_line(doc,(line->>'balance_id')::uuid,null,(line->>'quantity')::numeric,null,null);
 end loop;
 perform public.post_inventory_operation_document(doc);
 update private.assistant_operations set confirmed_at=clock_timestamp(),result_id=doc where id=row.id;
 return jsonb_build_object('id',row.id,'status','completed','result_id',doc);
end $$;

revoke all on function private.require_assistant_operation_access(),private.assistant_transfer_preview(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.prepare_assistant_operation(uuid,text,jsonb),public.review_assistant_operation(uuid),public.confirm_assistant_operation(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.prepare_assistant_operation(uuid,text,jsonb),public.review_assistant_operation(uuid),public.confirm_assistant_operation(uuid,uuid) to authenticated;
commit;
