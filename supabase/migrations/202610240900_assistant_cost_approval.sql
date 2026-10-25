-- Explicit approval of one reviewed saved calculation, never a payment.
begin;
alter table private.assistant_operations drop constraint if exists assistant_operations_kind_check;
alter table private.assistant_operations add constraint assistant_operations_kind_check check(kind in
 ('inventory_transfer','customer_order_fulfillment','customer_order_create','customer_order_reserve','customer_order_confirm','shipment_transport_receive','customer_return_create','customer_return_decide','customer_return_cancel','expense_create','expense_confirm','expense_allocate','shipment_cost_calculate','shipment_cost_approve'));
do $$begin
 if to_regprocedure('private.confirm_assistant_before_cost_approval(uuid,uuid)') is null then
  alter function public.confirm_assistant_operation(uuid,uuid) set schema private;
  alter function private.confirm_assistant_operation(uuid,uuid) rename to confirm_assistant_before_cost_approval;
  alter function public.review_assistant_operation(uuid) set schema private;
  alter function private.review_assistant_operation(uuid) rename to review_assistant_before_cost_approval;
  alter function private.require_assistant_kind_access(text) rename to require_assistant_kind_before_cost_approval;
  alter function private.assistant_operation_preview(text,jsonb) rename to assistant_preview_before_cost_approval;
 end if;
end $$;
create or replace function private.require_assistant_cost_approval_access() returns void
language plpgsql security definer set search_path='' as $$begin
 if auth.uid() is null or not private.is_active_employee(auth.uid()) or not (
 private.has_permission('agent.use') and private.has_permission('costing.view') and private.has_permission('costing.approve')
 and private.has_permission('prices.purchase.view') and private.has_permission('finance.view')
 and private.has_permission('products.view') and private.has_permission('shipments.view')
 and private.has_permission('documents.view') and private.has_permission('inventory.view'))
 then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
end $$;
create or replace function private.assistant_cost_approval_preview(p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.cost_calculations;s public.shipments;cu public.currencies;lines jsonb;batches jsonb;previous jsonb;stamp jsonb;
begin
 perform private.require_assistant_cost_approval_access();
 if jsonb_typeof(p) is distinct from 'object' then raise exception 'ASSISTANT_COST_APPROVAL_INVALID';end if;
 if (select count(*) from jsonb_object_keys(p))<>1 or jsonb_typeof(p->'calculation_id') is distinct from 'string' then raise exception 'ASSISTANT_COST_APPROVAL_INVALID';end if;
 select * into c from public.cost_calculations where id=(p->>'calculation_id')::uuid;
 if c.id is null or c.status<>'draft' then raise exception 'ASSISTANT_COST_APPROVAL_STATE';end if;
 select * into s from public.shipments where id=c.shipment_id;
 select * into cu from public.currencies where id=c.currency_id;
 if s.status='cancelled' or cu.is_active is not true then raise exception 'ASSISTANT_COST_APPROVAL_STATE';end if;
 if c.inputs_digest is null or c.inputs_digest<>private.shipment_cost_inputs_digest(c.shipment_id) then raise exception 'ASSISTANT_COST_APPROVAL_STALE';end if;
 if exists(select 1 from public.cost_calculation_items where calculation_id=c.id and goods_rate_basis='calculation') then raise exception 'ASSISTANT_COST_APPROVAL_PRELIMINARY';end if;
 if (select count(*) from public.cost_calculation_items where calculation_id=c.id) not between 1 and 200 then raise exception 'ASSISTANT_COST_APPROVAL_LIMIT';end if;
 if (select count(*) from public.inventory_batches b join public.cost_calculation_items i on i.shipment_item_id=b.source_shipment_item_id where i.calculation_id=c.id)>200 then raise exception 'ASSISTANT_COST_APPROVAL_LIMIT';end if;
 select jsonb_agg(jsonb_build_object('item_id',i.shipment_item_id,'product',coalesce(pr.name->>'ru',pr.name->>'en',pr.internal_sku),
 'sku',pr.internal_sku,'quantity',i.quantity::text,'cost_quantity',i.cost_quantity::text,'cost_quantity_basis',i.cost_quantity_basis,
 'uom',si.uom,'goods_amount',i.goods_amount::text,'expenses',i.allocated_expenses::text,'total',i.landed_amount::text,
 'unit_cost',i.unit_landed_cost::text,'rate',i.goods_rate::text,'rate_date',i.goods_rate_date,'rate_basis',i.goods_rate_basis) order by i.shipment_item_id)
 into lines from public.cost_calculation_items i join public.products pr on pr.id=i.product_id
 join public.shipment_items si on si.id=i.shipment_item_id where i.calculation_id=c.id;
 select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'batch',b.batch_number,'product',coalesce(pr.name->>'ru',pr.name->>'en',pr.internal_sku),
 'old_cost',b.unit_landed_cost::text,'old_currency',bc.code,'old_version',old.version_number,
 'new_cost',i.unit_landed_cost::text,'new_currency',cu.code) order by b.id),'[]'::jsonb)
 into batches from public.inventory_batches b join public.cost_calculation_items i on i.shipment_item_id=b.source_shipment_item_id and i.calculation_id=c.id
 join public.products pr on pr.id=i.product_id left join public.currencies bc on bc.id=b.cost_currency_id left join public.cost_calculations old on old.id=b.cost_calculation_id;
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'version',version_number) order by version_number),'[]'::jsonb)
 into previous from public.cost_calculations where shipment_id=c.shipment_id and status='approved';
 stamp:=jsonb_build_object('calculation',to_jsonb(c),'shipment',to_jsonb(s),'currency',to_jsonb(cu),'inputs',private.shipment_cost_inputs_digest(c.shipment_id),
 'lines',(select jsonb_agg(to_jsonb(i) order by id) from public.cost_calculation_items i where calculation_id=c.id),
 'versions',(select jsonb_agg(to_jsonb(v) order by id) from public.cost_calculations v where shipment_id=c.shipment_id),
 'batches',(select jsonb_agg(to_jsonb(b) order by b.id) from public.inventory_batches b join public.cost_calculation_items i on i.shipment_item_id=b.source_shipment_item_id where i.calculation_id=c.id));
 return jsonb_build_object('calculation_id',c.id,'shipment_number',s.shipment_number,'version',c.version_number,'currency',cu.code,
 'goods_total',c.goods_total::text,'expenses_total',c.expenses_total::text,'landed_total',c.landed_total::text,
 'calculated_at',c.calculated_at,'lines',lines,'batches',batches,'previous',previous,
 'performer',(select full_name from public.profiles where id=auth.uid()),'state_stamp',encode(sha256(convert_to(stamp::text,'UTF8')),'hex'));
exception when invalid_text_representation then raise exception 'ASSISTANT_COST_APPROVAL_INVALID';
end $$;
create or replace function private.require_assistant_kind_access(p_kind text) returns void
language plpgsql security definer set search_path='' as $$begin
 if p_kind='shipment_cost_approve' then perform private.require_assistant_cost_approval_access();
 else perform private.require_assistant_kind_before_cost_approval(p_kind);end if;
end $$;
create or replace function private.assistant_operation_preview(p_kind text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 if p_kind='shipment_cost_approve' then return private.assistant_cost_approval_preview(p_payload);
 else return private.assistant_preview_before_cost_approval(p_kind,p_payload);end if;
end $$;
create or replace function public.review_assistant_operation(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations;v jsonb;
begin
 select * into r from private.assistant_operations where id=p_request_id and created_by=auth.uid();
 if not found then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.kind<>'shipment_cost_approve' then return private.review_assistant_before_cost_approval(p_request_id);end if;
 perform private.require_assistant_cost_approval_access();
 if r.result_calculation_id is not null then return jsonb_build_object('id',r.id,'kind',r.kind,'status','completed','result_id',r.result_calculation_id);end if;
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 v:=private.assistant_cost_approval_preview(r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 return jsonb_build_object('id',r.id,'kind',r.kind,'status','awaiting_confirmation','review_token',r.review_token,'preview',v-'state_stamp','expires_at',r.expires_at);
end $$;
create or replace function public.confirm_assistant_operation(p_request_id uuid,p_review_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations;v jsonb;cid uuid;sid uuid;actual jsonb;expected jsonb;
begin
 select * into r from private.assistant_operations where id=p_request_id and created_by=auth.uid() for update;
 if not found or p_review_token is null or r.review_token<>p_review_token then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.kind<>'shipment_cost_approve' then return private.confirm_assistant_before_cost_approval(p_request_id,p_review_token);end if;
 perform private.require_assistant_cost_approval_access();
 if r.result_calculation_id is not null then return public.review_assistant_operation(r.id);end if;
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 lock table public.expenses,public.shipment_items,public.expense_allocations in exclusive mode;
 lock table public.documents,public.document_links,public.document_types,public.exchange_rates,public.products,public.currencies,public.cost_calculation_items in share mode;
 cid:=(r.payload->>'calculation_id')::uuid;
 select shipment_id into sid from public.cost_calculations where id=cid for update;
 lock table public.inventory_batches in share row exclusive mode;
 perform 1 from public.shipments where id=sid for share;
 perform 1 from public.profiles where id=auth.uid() for share;
 perform private.require_assistant_cost_approval_access();
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 v:=private.assistant_cost_approval_preview(r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 begin
  perform public.approve_shipment_cost(cid);
  if not exists(select 1 from public.cost_calculations where id=cid and status='approved' and approved_by=auth.uid() and approved_at is not null)
   or (select count(*) from public.cost_calculations where shipment_id=sid and status='approved')<>1
   or exists(select 1 from jsonb_array_elements(v->'previous')p where not exists(select 1 from public.cost_calculations where id=(p->>'id')::uuid and status='superseded'))
  then raise exception 'Approval differs from preview';end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'cost',b.unit_landed_cost,'currency',b.cost_currency_id,'calculation',b.cost_calculation_id) order by b.id),'[]'::jsonb)
  into actual from public.inventory_batches b join public.cost_calculation_items i on i.shipment_item_id=b.source_shipment_item_id where i.calculation_id=cid;
  select coalesce(jsonb_agg(jsonb_build_object('id',(b->>'id')::uuid,'cost',(b->>'new_cost')::numeric,'currency',(select currency_id from public.cost_calculations where id=cid),'calculation',cid) order by b->>'id'),'[]'::jsonb)
  into expected from jsonb_array_elements(v->'batches')b;
  if actual is distinct from expected then raise exception 'Batch cost differs from preview';end if;
 exception when others then raise exception 'ASSISTANT_COST_APPROVAL_REFUSED';end;
 update private.assistant_operations set confirmed_at=clock_timestamp(),result_calculation_id=cid where id=r.id;
 return public.review_assistant_operation(r.id);
end $$;
revoke all on function private.confirm_assistant_before_cost_approval(uuid,uuid),private.review_assistant_before_cost_approval(uuid),
 private.require_assistant_kind_before_cost_approval(text),private.assistant_preview_before_cost_approval(text,jsonb),
 private.require_assistant_cost_approval_access(),private.assistant_cost_approval_preview(jsonb),
 private.require_assistant_kind_access(text),private.assistant_operation_preview(text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.review_assistant_operation(uuid),public.confirm_assistant_operation(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.review_assistant_operation(uuid),public.confirm_assistant_operation(uuid,uuid) to authenticated;
commit;
