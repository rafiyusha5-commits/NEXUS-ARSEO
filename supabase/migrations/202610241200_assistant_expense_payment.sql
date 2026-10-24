-- Record full expense payment in accounting only. No bank transfer or payment initiation.
begin;
alter table private.assistant_operations drop constraint if exists assistant_operations_kind_check;
alter table private.assistant_operations add constraint assistant_operations_kind_check check(kind in
 ('inventory_transfer','customer_order_fulfillment','customer_order_create','customer_order_reserve','customer_order_confirm','shipment_transport_receive','customer_return_create','customer_return_decide','customer_return_cancel','expense_create','expense_confirm','expense_allocate','shipment_cost_calculate','shipment_cost_approve','expense_cancel','expense_reverse','expense_mark_paid'));
do $$begin
 if to_regprocedure('private.confirm_assistant_before_expense_payment(uuid,uuid)') is null then
  alter function public.confirm_assistant_operation(uuid,uuid) set schema private;
  alter function private.confirm_assistant_operation(uuid,uuid) rename to confirm_assistant_before_expense_payment;
  alter function public.review_assistant_operation(uuid) set schema private;
  alter function private.review_assistant_operation(uuid) rename to review_assistant_before_expense_payment;
  alter function private.require_assistant_kind_access(text) rename to require_assistant_kind_before_expense_payment;
  alter function private.assistant_operation_preview(text,jsonb) rename to assistant_preview_before_expense_payment;
 end if;
end $$;

create or replace function private.require_assistant_expense_payment_access(p_id uuid default null) returns void
language plpgsql security definer set search_path='' as $$
declare e public.expenses;
begin
 if auth.uid() is null or not private.is_active_employee(auth.uid()) or not (
 private.has_permission('agent.use') and private.has_permission('finance.view') and private.has_permission('finance.pay'))
 then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if p_id is null then return;end if;
 select * into e from public.expenses where id=p_id;
 if not found then raise exception 'ASSISTANT_EXPENSE_PAYMENT_STATE';end if;
 if (e.expense_type='goods_cost' and not private.has_permission('prices.purchase.view'))
 or (e.shipment_id is not null and not private.has_permission('shipments.view'))
 or (e.document_id is not null and not private.has_permission('documents.view'))
 then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if (e.payee_counterparty_id is not null and not private.can_access_counterparty_record('view',e.payee_counterparty_id))
 or (e.attributed_customer_id is not null and not private.can_access_counterparty_record('view',e.attributed_customer_id))
 then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
end $$;
create or replace function private.assistant_expense_payment_preview(p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.expenses; s public.shipments; d public.documents; c public.currencies; cp public.counterparties; customer public.counterparties; stamp jsonb;
begin
 perform private.require_assistant_expense_payment_access();
 if jsonb_typeof(p) is distinct from 'object' then raise exception 'ASSISTANT_EXPENSE_PAYMENT_INVALID';end if;
 if (select count(*) from jsonb_object_keys(p))<>1 or jsonb_typeof(p->'expense_id') is distinct from 'string'
 then raise exception 'ASSISTANT_EXPENSE_PAYMENT_INVALID';end if;
 perform private.require_assistant_expense_payment_access((p->>'expense_id')::uuid);
 select * into e from public.expenses where id=(p->>'expense_id')::uuid;
 if e.status<>'allocated' or e.is_planned or e.paid_at is not null or e.paid_by is not null then raise exception 'ASSISTANT_EXPENSE_PAYMENT_STATE';end if;
 select * into s from public.shipments where id=e.shipment_id;
 select * into d from public.documents where id=e.document_id;
 select * into c from public.currencies where id=e.currency_id;
 select * into cp from public.counterparties where id=e.payee_counterparty_id;
 select * into customer from public.counterparties where id=e.attributed_customer_id;

 stamp:=jsonb_build_object('expense',to_jsonb(e),'shipment',to_jsonb(s),'currency',to_jsonb(c),'payee',to_jsonb(cp),'customer',to_jsonb(customer),'document',to_jsonb(d),
 'allocations',(select jsonb_agg(to_jsonb(a) order by a.id) from public.expense_allocations a where expense_id=e.id),
 'links',(select jsonb_agg(to_jsonb(l) order by l.id) from public.document_links l where document_id=e.document_id and removed_at is null));
 return jsonb_build_object('expense_id',e.id,'status',e.status,'allocation_count',(select count(*) from public.expense_allocations where expense_id=e.id),'shipment_number',s.shipment_number,'customer',coalesce(customer.short_name,customer.legal_name),
 'expense_type',e.expense_type,'payee',coalesce(cp.short_name,cp.legal_name),'amount',e.amount::text,'currency',c.code,
 'incurred_at',e.incurred_at,'amount_kind',case when e.is_planned then 'planned' else 'actual' end,'document',d.title,'notes',e.notes,
 'creator',(select full_name from public.profiles where id=e.created_by),'performer',(select full_name from public.profiles where id=auth.uid()),
 'state_stamp',encode(sha256(convert_to(stamp::text,'UTF8')),'hex'));
exception when invalid_text_representation then raise exception 'ASSISTANT_EXPENSE_PAYMENT_INVALID';
end $$;
create or replace function private.require_assistant_kind_access(p_kind text) returns void
language plpgsql security definer set search_path='' as $$begin
 if p_kind='expense_mark_paid' then perform private.require_assistant_expense_payment_access();
 else perform private.require_assistant_kind_before_expense_payment(p_kind);end if;
end $$;
create or replace function private.assistant_operation_preview(p_kind text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 if p_kind='expense_mark_paid' then return private.assistant_expense_payment_preview(p_payload);
 else return private.assistant_preview_before_expense_payment(p_kind,p_payload);end if;
end $$;
create or replace function public.review_assistant_operation(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations;v jsonb;
begin
 select * into r from private.assistant_operations where id=p_request_id and created_by=auth.uid();
 if not found then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.kind<>'expense_mark_paid' then return private.review_assistant_before_expense_payment(p_request_id);end if;
 perform private.require_assistant_expense_payment_access((r.payload->>'expense_id')::uuid);
 if r.result_expense_id is not null then return jsonb_build_object('id',r.id,'kind',r.kind,'status','completed','result_id',r.result_expense_id);end if;
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 v:=private.assistant_expense_payment_preview(r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_EXPENSE_PAYMENT_STALE';end if;
 return jsonb_build_object('id',r.id,'kind',r.kind,'status','awaiting_confirmation','review_token',r.review_token,'preview',v-'state_stamp','expires_at',r.expires_at);
end $$;
create or replace function public.confirm_assistant_operation(p_request_id uuid,p_review_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations;e public.expenses;v jsonb;after_e public.expenses;allocations_before jsonb;
begin
 select * into r from private.assistant_operations where id=p_request_id and created_by=auth.uid() for update;
 if not found or p_review_token is null or r.review_token<>p_review_token then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.kind<>'expense_mark_paid' then return private.confirm_assistant_before_expense_payment(p_request_id,p_review_token);end if;
 perform private.require_assistant_expense_payment_access((r.payload->>'expense_id')::uuid);
 if r.result_expense_id is not null then return public.review_assistant_operation(r.id);end if;
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 -- Serialize with allocation/costing before acquiring any expense row.
 lock table public.expenses,public.shipment_items,public.expense_allocations in exclusive mode;
 select * into e from public.expenses where id=(r.payload->>'expense_id')::uuid for update;
 perform 1 from public.shipments where id=e.shipment_id for share;
 perform 1 from public.currencies where id=e.currency_id for share;
 perform 1 from public.counterparties where id in(e.payee_counterparty_id,e.attributed_customer_id) order by id for share;
 perform 1 from public.documents where id=e.document_id for share;
 perform 1 from public.document_links where document_id=e.document_id and removed_at is null order by id for share;
 perform 1 from public.profiles where id in(auth.uid(),e.created_by) order by id for share;
 perform private.require_assistant_expense_payment_access(e.id);
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 v:=private.assistant_expense_payment_preview(r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_EXPENSE_PAYMENT_STALE';end if;
 select jsonb_agg(to_jsonb(a) order by a.id) into allocations_before from public.expense_allocations a where expense_id=e.id;
 begin
  perform public.mark_expense_paid(e.id);
  select * into after_e from public.expenses where id=e.id;
  if after_e.status is distinct from 'paid' or after_e.paid_by is distinct from auth.uid()
  or after_e.paid_at is null
  or (to_jsonb(after_e)-array['status','paid_by','paid_at','updated_at'])
     is distinct from (to_jsonb(e)-array['status','paid_by','paid_at','updated_at'])
  or allocations_before is distinct from (select jsonb_agg(to_jsonb(a) order by a.id) from public.expense_allocations a where expense_id=e.id)
  then raise exception 'ASSISTANT_EXPENSE_PAYMENT_REFUSED';end if;
 exception when others then raise exception 'ASSISTANT_EXPENSE_PAYMENT_REFUSED';end;
 update private.assistant_operations set confirmed_at=clock_timestamp(),result_expense_id=e.id where id=r.id;
 return public.review_assistant_operation(r.id);
end $$;
revoke all on function private.confirm_assistant_before_expense_payment(uuid,uuid),private.review_assistant_before_expense_payment(uuid),
 private.require_assistant_kind_before_expense_payment(text),private.assistant_preview_before_expense_payment(text,jsonb),
 private.require_assistant_expense_payment_access(uuid),private.assistant_expense_payment_preview(jsonb),
 private.require_assistant_kind_access(text),private.assistant_operation_preview(text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.review_assistant_operation(uuid),public.confirm_assistant_operation(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.review_assistant_operation(uuid),public.confirm_assistant_operation(uuid,uuid) to authenticated;
commit;
