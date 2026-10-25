-- Reviewed native expense allocation. No payments or cost calculations.
begin;
alter table private.assistant_operations drop constraint if exists assistant_operations_kind_check;
alter table private.assistant_operations add constraint assistant_operations_kind_check check(kind in
 ('inventory_transfer','customer_order_fulfillment','customer_order_create','customer_order_reserve','customer_order_confirm','shipment_transport_receive','customer_return_create','customer_return_decide','customer_return_cancel','expense_create','expense_confirm','expense_allocate'));
do $$begin
 if to_regprocedure('private.confirm_assistant_before_expense_allocation(uuid,uuid)') is null then
  alter function public.confirm_assistant_operation(uuid,uuid) set schema private;
  alter function private.confirm_assistant_operation(uuid,uuid) rename to confirm_assistant_before_expense_allocation;
  alter function public.review_assistant_operation(uuid) set schema private;
  alter function private.review_assistant_operation(uuid) rename to review_assistant_before_expense_allocation;
  alter function private.require_assistant_kind_access(text) rename to require_assistant_kind_before_expense_allocation;
  alter function private.assistant_operation_preview(text,jsonb) rename to assistant_preview_before_expense_allocation;
 end if;
end $$;

create or replace function private.require_assistant_expense_allocation_access(p_id uuid default null) returns void
language plpgsql security definer set search_path='' as $$
declare e public.expenses;
begin
 if auth.uid() is null or not private.is_active_employee(auth.uid()) or not (
 private.has_permission('agent.use') and private.has_permission('finance.view') and private.has_permission('costing.calculate') and private.has_permission('prices.purchase.view') and private.has_permission('products.view') and private.has_permission('shipments.view'))
 then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if p_id is null then return;end if;
 select * into e from public.expenses where id=p_id;
 if not found then raise exception 'ASSISTANT_ALLOCATION_STATE';end if;
 if (e.expense_type='goods_cost' and not private.has_permission('prices.purchase.view'))
 or (e.shipment_id is not null and not private.has_permission('shipments.view'))
 or (e.document_id is not null and (not private.has_permission('documents.view')
  or not private.can_view_generated_document(e.document_id)))
 then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if (e.payee_counterparty_id is not null and not private.can_access_counterparty_record('view',e.payee_counterparty_id))
 or (e.attributed_customer_id is not null and not private.can_access_counterparty_record('view',e.attributed_customer_id))
 then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
end $$;

create or replace function private.assistant_allocation_preview(p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.expenses;s public.shipments;d public.documents;cp public.counterparties;cu public.currencies;target public.currencies;
 rate_id uuid;rate_value numeric;rate_row public.exchange_rates;basis_rows jsonb;lines jsonb:='[]'::jsonb;old_rows jsonb;
 stamp jsonb;r record;total_basis numeric;total_amount numeric;left_amount numeric;part numeric;n integer;idx integer:=0;k text;
begin
 perform private.require_assistant_expense_allocation_access();
 if jsonb_typeof(p) is distinct from 'object' then raise exception 'ASSISTANT_ALLOCATION_INVALID';end if;
 if (select count(*) from jsonb_object_keys(p))<>3 or not p ?& array['expense_id','method','target_currency_id'] then raise exception 'ASSISTANT_ALLOCATION_INVALID';end if;
 foreach k in array array['expense_id','method','target_currency_id'] loop
  if jsonb_typeof(p->k) is distinct from 'string' then raise exception 'ASSISTANT_ALLOCATION_INVALID';end if;
 end loop;
 if p->>'method' not in ('by_quantity','by_weight','by_volume','by_value') then raise exception 'ASSISTANT_ALLOCATION_INVALID';end if;
 perform private.require_assistant_expense_allocation_access((p->>'expense_id')::uuid);
 select * into e from public.expenses where id=(p->>'expense_id')::uuid;
 if e.status not in ('confirmed','allocated','paid') or e.is_planned or e.shipment_id is null then raise exception 'ASSISTANT_ALLOCATION_STATE';end if;
 select * into s from public.shipments where id=e.shipment_id;
 select * into cu from public.currencies where id=e.currency_id;
 select * into target from public.currencies where id=(p->>'target_currency_id')::uuid;
 select * into d from public.documents where id=e.document_id;
 select * into cp from public.counterparties where id=e.payee_counterparty_id;
 if s.status='cancelled' or cu.is_active is not true or target.is_active is not true or d.archived_at is not null or cp.status<>'active' then raise exception 'ASSISTANT_ALLOCATION_STATE';end if;
 select f.rate_id,f.rate into rate_id,rate_value from private.finance_rate(e.currency_id,target.id,e.incurred_at) f;
 if rate_value is null then raise exception 'ASSISTANT_ALLOCATION_RATE';end if;
 select * into rate_row from public.exchange_rates where id=rate_id;
 -- Mirror the unchanged native basis and rounding; verify the committed rows below.
 select jsonb_agg(jsonb_build_object('item_id',i.id,'product',coalesce(pr.name->>'ru',pr.name->>'en',pr.internal_sku),'sku',pr.internal_sku,
 'quantity',q.qty,'uom',i.uom,'quantity_source',case when i.received_quantity is not null then 'received' when i.shipped_quantity is not null then 'shipped' when i.confirmed_quantity is not null then 'confirmed' else 'ordered' end,
 'basis',case p->>'method' when 'by_quantity' then q.qty when 'by_value' then q.qty*i.unit_price when 'by_weight' then q.qty*pack.gross_weight_kg else q.qty*pack.volume_m3 end) order by i.id)
 into basis_rows
 from public.shipment_items i join public.products pr on pr.id=i.product_id
 cross join lateral(select coalesce(i.received_quantity,i.shipped_quantity,i.confirmed_quantity,i.ordered_quantity) qty) q
 left join lateral(select pp.gross_weight_kg,coalesce(pp.volume_m3,(pp.length_cm*pp.width_cm*pp.height_cm)/1000000) volume_m3
 from public.product_packaging pp where pp.product_id=i.product_id and pp.uom=i.uom limit 1)pack on true
 where i.shipment_id=e.shipment_id and q.qty>0;
 n:=coalesce(jsonb_array_length(basis_rows),0);
 if n not between 1 and 200 then raise exception 'ASSISTANT_ALLOCATION_BASIS';end if;
 if exists(select 1 from jsonb_array_elements(basis_rows) b where b->>'basis' is null or (b->>'basis')::numeric<=0) then raise exception 'ASSISTANT_ALLOCATION_BASIS';end if;
 select sum((b->>'basis')::numeric) into total_basis from jsonb_array_elements(basis_rows)b;
 total_amount:=round(e.amount*rate_value,2);left_amount:=total_amount;
 for r in select b as row from jsonb_array_elements(basis_rows)b loop
  idx:=idx+1;
  part:=case when idx=n then left_amount else round(total_amount*(r.row->>'basis')::numeric/total_basis,2) end;
  if part<0 then raise exception 'ASSISTANT_ALLOCATION_BASIS';end if;
  lines:=lines||jsonb_build_array((r.row-'basis'-'quantity')||jsonb_build_object(
   'quantity',r.row->>'quantity','basis',((r.row->>'basis')::numeric)::numeric(18,6)::text,
   'share',((r.row->>'basis')::numeric/total_basis)::numeric(12,9)::text,'amount',part::numeric(14,2)::text));
  if idx<n then left_amount:=left_amount-part;end if;
 end loop;
 select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'item_id',a.shipment_item_id,'product',coalesce(pr.name->>'ru',pr.name->>'en',pr.internal_sku,'Позиция без товара'),
 'amount',a.allocated_amount::text,'currency',c.code,'method',a.allocation_method) order by a.id),'[]'::jsonb) into old_rows
 from public.expense_allocations a left join public.shipment_items i on i.id=a.shipment_item_id left join public.products pr on pr.id=i.product_id
 join public.currencies c on c.id=a.currency_id where a.expense_id=e.id;
 if jsonb_array_length(old_rows)>200 then raise exception 'ASSISTANT_ALLOCATION_BASIS';end if;
 stamp:=jsonb_build_object('expense',to_jsonb(e),'shipment',to_jsonb(s),'document',to_jsonb(d),'payee',to_jsonb(cp),'source_currency',to_jsonb(cu),'target_currency',to_jsonb(target),'rate',to_jsonb(rate_row),
 'items',(select jsonb_agg(to_jsonb(i) order by i.id) from public.shipment_items i where i.shipment_id=e.shipment_id),
 'products',(select jsonb_agg(to_jsonb(pr) order by pr.id) from public.products pr where pr.id in(select product_id from public.shipment_items where shipment_id=e.shipment_id)),
 'packaging',(select jsonb_agg(to_jsonb(pp) order by pp.id) from public.product_packaging pp where pp.product_id in(select product_id from public.shipment_items where shipment_id=e.shipment_id)),
 'allocations',(select jsonb_agg(to_jsonb(a) order by a.id) from public.expense_allocations a where a.expense_id=e.id),
 'links',(select jsonb_agg(to_jsonb(l) order by l.id) from public.document_links l where l.document_id=e.document_id and l.removed_at is null));
 return jsonb_build_object('expense_id',e.id,'shipment_number',s.shipment_number,'expense_type',e.expense_type,'payee',coalesce(cp.short_name,cp.legal_name),
 'amount',e.amount::text,'currency',cu.code,'incurred_at',e.incurred_at,'status',e.status,'document',d.title,'method',p->>'method',
 'target_currency',target.code,'rate',rate_value::text,'rate_date',rate_row.rate_date,'rate_source',rate_row.source,
 'total',total_amount::numeric(14,2)::text,'lines',lines,'previous',old_rows,
 'excluded_count',(select count(*) from public.shipment_items i where i.shipment_id=e.shipment_id and coalesce(i.received_quantity,i.shipped_quantity,i.confirmed_quantity,i.ordered_quantity)<=0),
 'performer',(select full_name from public.profiles where id=auth.uid()),'state_stamp',encode(sha256(convert_to(stamp::text,'UTF8')),'hex'));
exception when invalid_text_representation then raise exception 'ASSISTANT_ALLOCATION_INVALID';
end $$;
create or replace function private.require_assistant_kind_access(p_kind text) returns void
language plpgsql security definer set search_path='' as $$begin
 if p_kind='expense_allocate' then perform private.require_assistant_expense_allocation_access();
 else perform private.require_assistant_kind_before_expense_allocation(p_kind);end if;
end $$;
create or replace function private.assistant_operation_preview(p_kind text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 if p_kind='expense_allocate' then return private.assistant_allocation_preview(p_payload);
 else return private.assistant_preview_before_expense_allocation(p_kind,p_payload);end if;
end $$;
create or replace function public.review_assistant_operation(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations;v jsonb;
begin
 select * into r from private.assistant_operations where id=p_request_id and created_by=auth.uid();
 if not found then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.kind<>'expense_allocate' then return private.review_assistant_before_expense_allocation(p_request_id);end if;
 perform private.require_assistant_expense_allocation_access((r.payload->>'expense_id')::uuid);
 if r.result_expense_id is not null then return jsonb_build_object('id',r.id,'kind',r.kind,'status','completed','result_id',r.result_expense_id);end if;
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 v:=private.assistant_allocation_preview(r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 return jsonb_build_object('id',r.id,'kind',r.kind,'status','awaiting_confirmation','review_token',r.review_token,'preview',v-'state_stamp','expires_at',r.expires_at);
end $$;
create or replace function public.confirm_assistant_operation(p_request_id uuid,p_review_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations;e public.expenses;v jsonb;actual jsonb;expected jsonb;after_e public.expenses;
begin
 select * into r from private.assistant_operations where id=p_request_id and created_by=auth.uid() for update;
 if not found or p_review_token is null or r.review_token<>p_review_token then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.kind<>'expense_allocate' then return private.confirm_assistant_before_expense_allocation(p_request_id,p_review_token);end if;
 perform private.require_assistant_expense_allocation_access((r.payload->>'expense_id')::uuid);
 if r.result_expense_id is not null then return public.review_assistant_operation(r.id);end if;
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 -- Same leading table order as native costing. Freeze inserts as well as updates.
 lock table public.expenses,public.shipment_items,public.expense_allocations in exclusive mode;
 lock table public.documents,public.document_links,public.exchange_rates,public.products,public.product_packaging in share mode;
 select * into e from public.expenses where id=(r.payload->>'expense_id')::uuid for update;
 perform 1 from public.shipments where id=e.shipment_id for share;
 perform 1 from public.currencies where id in(e.currency_id,(r.payload->>'target_currency_id')::uuid) order by id for share;
 perform 1 from public.counterparties where id in(e.payee_counterparty_id,e.attributed_customer_id) order by id for share;
 perform 1 from public.profiles where id=auth.uid() for share;
 perform private.require_assistant_expense_allocation_access(e.id);
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 v:=private.assistant_allocation_preview(r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 begin
  perform public.allocate_expense(e.id,r.payload->>'method',(r.payload->>'target_currency_id')::uuid);
  select jsonb_agg(jsonb_build_object('item',a.shipment_item_id,'basis',a.allocation_basis,'share',a.allocation_share,'amount',a.allocated_amount,'currency',a.currency_id,'method',a.allocation_method) order by a.shipment_item_id)
  into actual from public.expense_allocations a where a.expense_id=e.id;
  select jsonb_agg(jsonb_build_object('item',(l->>'item_id')::uuid,'basis',(l->>'basis')::numeric,'share',(l->>'share')::numeric,'amount',(l->>'amount')::numeric,'currency',(r.payload->>'target_currency_id')::uuid,'method',r.payload->>'method') order by l->>'item_id')
  into expected from jsonb_array_elements(v->'lines')l;
  select * into after_e from public.expenses where id=e.id;
  if actual is distinct from expected or after_e.status<>(case when e.status='confirmed' then 'allocated' else e.status end)
   or after_e.paid_at is distinct from e.paid_at or after_e.paid_by is distinct from e.paid_by
  then raise exception 'Native allocation differs from preview';end if;
 exception when others then raise exception 'ASSISTANT_ALLOCATION_REFUSED';end;
 update private.assistant_operations set confirmed_at=clock_timestamp(),result_expense_id=e.id where id=r.id;
 return public.review_assistant_operation(r.id);
end $$;
revoke all on function private.confirm_assistant_before_expense_allocation(uuid,uuid),private.review_assistant_before_expense_allocation(uuid),
 private.require_assistant_kind_before_expense_allocation(text),private.assistant_preview_before_expense_allocation(text,jsonb),
 private.require_assistant_expense_allocation_access(uuid),private.assistant_allocation_preview(jsonb),
 private.require_assistant_kind_access(text),private.assistant_operation_preview(text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.review_assistant_operation(uuid),public.confirm_assistant_operation(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.review_assistant_operation(uuid),public.confirm_assistant_operation(uuid,uuid) to authenticated;
commit;
