-- Expense drafts only. Native accounting, allocation and payment remain separate.
begin;
alter table private.assistant_operations add column if not exists result_expense_id uuid references public.expenses(id);
alter table private.assistant_operations drop constraint if exists assistant_operations_kind_check;
alter table private.assistant_operations add constraint assistant_operations_kind_check check(kind in
 ('inventory_transfer','customer_order_fulfillment','customer_order_create','customer_order_reserve','customer_order_confirm','shipment_transport_receive','customer_return_create','customer_return_decide','customer_return_cancel','expense_create'));
do $$begin
 if to_regprocedure('private.confirm_assistant_before_expenses(uuid,uuid)') is null then
  alter function public.confirm_assistant_operation(uuid,uuid) set schema private;
  alter function private.confirm_assistant_operation(uuid,uuid) rename to confirm_assistant_before_expenses;
  alter function public.review_assistant_operation(uuid) set schema private;
  alter function private.review_assistant_operation(uuid) rename to review_assistant_before_expenses;
  alter function private.require_assistant_kind_access(text) rename to require_assistant_kind_before_expenses;
  alter function private.assistant_operation_preview(text,jsonb) rename to assistant_preview_before_expenses;
 end if;
end $$;
create or replace function private.require_assistant_expense_access(p jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path='' as $$begin
 if auth.uid() is null or not private.is_active_employee(auth.uid()) or not (
  private.has_permission('agent.use') and private.has_permission('shipments.view')
  and (private.has_permission('finance.manage') or private.has_permission('finance.draft')))
  or (p->>'expense_type'='goods_cost' and not private.has_permission('prices.purchase.view'))
  or (p->>'document_id' is not null and (not private.has_permission('documents.view')
   or not private.can_view_generated_document((p->>'document_id')::uuid)))
  then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if p->>'payee_counterparty_id' is not null and not private.can_access_counterparty_record('view',(p->>'payee_counterparty_id')::uuid)
 then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
end $$;
create or replace function private.assistant_expense_preview(p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.shipments; c public.currencies; cp public.counterparties; d public.documents; links jsonb; matches jsonb; stamp jsonb; k text;
begin
 perform private.require_assistant_expense_access();
 if jsonb_typeof(p) is distinct from 'object' then raise exception 'ASSISTANT_EXPENSE_INVALID';end if;
 if (select count(*) from jsonb_object_keys(p))<>9 or not p ?& array['shipment_id','expense_type','payee_counterparty_id','amount','currency_id','incurred_at','amount_kind','document_id','notes']
 then raise exception 'ASSISTANT_EXPENSE_INVALID';end if;
 foreach k in array array['shipment_id','expense_type','amount','currency_id','incurred_at','amount_kind'] loop
  if jsonb_typeof(p->k) is distinct from 'string' then raise exception 'ASSISTANT_EXPENSE_INVALID';end if;
 end loop;
 foreach k in array array['payee_counterparty_id','document_id','notes'] loop
  if jsonb_typeof(p->k) not in ('string','null') or (jsonb_typeof(p->k)='string' and length(btrim(p->>k))=0)
  then raise exception 'ASSISTANT_EXPENSE_INVALID';end if;
 end loop;
 if p->>'amount' !~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$' or (p->>'amount')::numeric<=0
  or p->>'incurred_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or (p->>'incurred_at')::date::text<>p->>'incurred_at'
  or p->>'amount_kind' not in ('actual','planned') or length(p->>'notes')>500
  or p->>'expense_type' not in ('goods_cost','transport','logistics','broker_fee','customs_duty','tax','stickering','marking','bank_fee','promo','return','other')
 then raise exception 'ASSISTANT_EXPENSE_INVALID';end if;
 perform private.require_assistant_expense_access(p);
 select * into s from public.shipments where id=(p->>'shipment_id')::uuid;
 if not found or s.status='cancelled' then raise exception 'ASSISTANT_EXPENSE_STATE';end if;
 select * into c from public.currencies where id=(p->>'currency_id')::uuid and is_active;
 if not found then raise exception 'ASSISTANT_EXPENSE_STATE';end if;
 if p->>'payee_counterparty_id' is not null then
  select * into cp from public.counterparties where id=(p->>'payee_counterparty_id')::uuid and status='active';
  if not found then raise exception 'ASSISTANT_EXPENSE_STATE';end if;
 end if;
 if p->>'document_id' is not null then
  select * into d from public.documents where id=(p->>'document_id')::uuid and archived_at is null;
  if not found then raise exception 'ASSISTANT_EXPENSE_STATE';end if;
  select jsonb_agg(to_jsonb(l) order by l.id) into links from public.document_links l
   where document_id=d.id and entity_type='shipment' and entity_id=s.id and removed_at is null;
  if links is null then raise exception 'ASSISTANT_EXPENSE_STATE';end if;
 end if;
 -- Only the actor's own matching records are counted; no disclosure of others' expenses.
 select coalesce(jsonb_agg(e.id order by e.id),'[]'::jsonb) into matches from public.expenses e
 where e.created_by=auth.uid() and e.shipment_id=s.id and e.expense_type=p->>'expense_type'
 and e.amount=(p->>'amount')::numeric and e.currency_id=c.id and e.incurred_at=(p->>'incurred_at')::date
 and e.is_planned=(p->>'amount_kind'='planned') and e.payee_counterparty_id is not distinct from cp.id
 and e.document_id is not distinct from d.id and e.notes is not distinct from nullif(btrim(p->>'notes'),'')
 and e.status not in ('cancelled','reversed');
 stamp:=jsonb_build_object('shipment',to_jsonb(s),'currency',to_jsonb(c),'payee',to_jsonb(cp),'document',to_jsonb(d),'links',links,'matches',matches);
 return jsonb_build_object('shipment_number',s.shipment_number,'expense_type',p->>'expense_type',
  'payee',coalesce(cp.short_name,cp.legal_name),'amount',p->>'amount','currency',c.code,'incurred_at',p->>'incurred_at',
  'amount_kind',p->>'amount_kind','document',d.title,'notes',nullif(btrim(p->>'notes'),''),
  'performer',(select full_name from public.profiles where id=auth.uid()),'existing_same_count',jsonb_array_length(matches),
  'state_stamp',encode(sha256(convert_to(stamp::text,'UTF8')),'hex'));
exception when invalid_text_representation or datetime_field_overflow or invalid_datetime_format then raise exception 'ASSISTANT_EXPENSE_INVALID';
end $$;
create or replace function private.require_assistant_kind_access(p_kind text) returns void
language plpgsql security definer set search_path='' as $$begin
 if p_kind='expense_create' then perform private.require_assistant_expense_access();
 else perform private.require_assistant_kind_before_expenses(p_kind);end if;
end $$;
create or replace function private.assistant_operation_preview(p_kind text,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$begin
 if p_kind='expense_create' then return private.assistant_expense_preview(p_payload);
 else return private.assistant_preview_before_expenses(p_kind,p_payload);end if;
end $$;
create or replace function public.review_assistant_operation(p_request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations; v jsonb;
begin
 select * into r from private.assistant_operations where id=p_request_id and created_by=auth.uid();
 if not found then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.kind<>'expense_create' then return private.review_assistant_before_expenses(p_request_id);end if;
 perform private.require_assistant_expense_access(r.payload);
 if r.result_expense_id is not null then return jsonb_build_object('id',r.id,'kind',r.kind,'status','completed','result_id',r.result_expense_id);end if;
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 v:=private.assistant_expense_preview(r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 return jsonb_build_object('id',r.id,'kind',r.kind,'status','awaiting_confirmation','review_token',r.review_token,'preview',v-'state_stamp','expires_at',r.expires_at);
end $$;
create or replace function public.confirm_assistant_operation(p_request_id uuid,p_review_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations; v jsonb; result uuid;
begin
 select * into r from private.assistant_operations where id=p_request_id and created_by=auth.uid() for update;
 if not found or p_review_token is null or r.review_token<>p_review_token then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 if r.kind<>'expense_create' then return private.confirm_assistant_before_expenses(p_request_id,p_review_token);end if;
 perform private.require_assistant_expense_access(r.payload);
 if r.result_expense_id is not null then return public.review_assistant_operation(r.id);end if;
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 -- Costing takes EXCLUSIVE on expenses first. Respect that order before source locks.
 lock table public.expenses in row exclusive mode;
 perform 1 from public.shipments where id=(r.payload->>'shipment_id')::uuid for update;
 perform 1 from public.currencies where id=(r.payload->>'currency_id')::uuid for share;
 perform 1 from public.counterparties where id=(r.payload->>'payee_counterparty_id')::uuid for share;
 perform 1 from public.documents where id=(r.payload->>'document_id')::uuid for share;
 perform 1 from public.document_links where document_id=(r.payload->>'document_id')::uuid
  and entity_type='shipment' and entity_id=(r.payload->>'shipment_id')::uuid and removed_at is null for share;
 perform 1 from public.profiles where id=auth.uid() for share;
 perform private.require_assistant_expense_access(r.payload);
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 v:=private.assistant_expense_preview(r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 begin
  result:=public.create_expense((r.payload->>'shipment_id')::uuid,r.payload->>'expense_type',(r.payload->>'payee_counterparty_id')::uuid,
   (r.payload->>'amount')::numeric,(r.payload->>'currency_id')::uuid,(r.payload->>'incurred_at')::date,
   r.payload->>'amount_kind'='planned',(r.payload->>'document_id')::uuid,r.payload->>'notes');
 exception when others then raise exception 'ASSISTANT_EXPENSE_REFUSED';end;
 update private.assistant_operations set confirmed_at=clock_timestamp(),result_expense_id=result where id=r.id;
 return public.review_assistant_operation(r.id);
end $$;
revoke all on function private.confirm_assistant_before_expenses(uuid,uuid),private.review_assistant_before_expenses(uuid),
 private.require_assistant_kind_before_expenses(text),private.assistant_preview_before_expenses(text,jsonb),
 private.require_assistant_expense_access(jsonb),private.assistant_expense_preview(jsonb),
 private.require_assistant_kind_access(text),private.assistant_operation_preview(text,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.review_assistant_operation(uuid),public.confirm_assistant_operation(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.review_assistant_operation(uuid),public.confirm_assistant_operation(uuid,uuid) to authenticated;
commit;
