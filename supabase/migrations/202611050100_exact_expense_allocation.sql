-- Exact, reviewed amounts. Existing automatic allocation and costing remain unchanged.
create table if not exists private.expense_allocation_revisions (
 id uuid primary key,
 expense_id uuid not null references public.expenses(id),
 created_by uuid not null references public.profiles(id),
 created_at timestamptz not null default clock_timestamp(),
 currency_id uuid not null references public.currencies(id),
 source_document_id uuid references public.documents(id),
 basis_note text not null check(length(btrim(basis_note)) between 10 and 2000),
 request_payload jsonb not null,
 before_snapshot jsonb not null,
 after_allocations jsonb not null
);
create index if not exists exact_allocation_expense_idx on private.expense_allocation_revisions(expense_id,created_at desc);
create index if not exists exact_allocation_author_idx on private.expense_allocation_revisions(created_by);
create index if not exists exact_allocation_currency_idx on private.expense_allocation_revisions(currency_id);
create index if not exists exact_allocation_source_idx on private.expense_allocation_revisions(source_document_id);
alter table private.expense_allocation_revisions enable row level security;
revoke all on private.expense_allocation_revisions from public,anon,authenticated,service_role;

create or replace function private.exact_allocation_access(p_expense_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare e public.expenses;s public.shipments;
begin
 if auth.uid() is null or not private.is_active_employee(auth.uid()) or not (
 private.has_permission('finance.view') and private.has_permission('prices.purchase.view')
 and private.has_permission('products.view') and private.has_permission('shipments.view')
 and private.has_permission('documents.view')) then raise exception 'Нет доступа к распределению расходов' using errcode='42501';end if;
 select * into e from public.expenses where id=p_expense_id;
 select * into s from public.shipments where id=e.shipment_id;
 if e.id is null or s.id is null or s.status='cancelled' then raise exception 'Расход или поставка недоступны' using errcode='42501';end if;
 if (e.document_id is not null and not private.can_view_generated_document(e.document_id))
 or (e.payee_counterparty_id is not null and not private.can_access_counterparty_record('view',e.payee_counterparty_id))
 or (e.attributed_customer_id is not null and not private.can_access_counterparty_record('view',e.attributed_customer_id))
 then raise exception 'Нет доступа к источнику расхода' using errcode='42501';end if;
end $$;

create or replace function private.exact_allocation_context(p_expense_id uuid,p_currency_id uuid,p_source_document_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.expenses;d public.documents;s public.shipments;rate_value numeric;rate_id uuid;
 lines jsonb;old_rows jsonb;snapshot jsonb;
begin
 perform private.exact_allocation_access(p_expense_id);
 select * into e from public.expenses where id=p_expense_id;
 select * into s from public.shipments where id=e.shipment_id;
 if e.is_planned or e.status not in ('draft','confirmed','allocated','paid') then raise exception 'Нужен действующий фактический расход';end if;
 if not exists(select 1 from public.currencies where id=p_currency_id and is_active)
 or not exists(select 1 from public.currencies where id=e.currency_id and is_active) then raise exception 'Валюта недоступна';end if;
 if p_source_document_id is not null then
  select * into d from public.documents where id=p_source_document_id and archived_at is null and status<>'rejected';
  if d.id is null or not private.can_view_generated_document(d.id) or not exists (
   select 1 from public.document_links l where l.document_id=d.id and l.removed_at is null and
   ((l.entity_type='shipment' and l.entity_id=s.id) or (l.entity_type='shipment_transport' and l.entity_id in(select id from public.shipment_transports where shipment_id=s.id))))
  then raise exception 'Источник не доступен или не связан с поставкой' using errcode='42501';end if;
 end if;
 select f.rate,f.rate_id into rate_value,rate_id from private.finance_rate(e.currency_id,p_currency_id,e.incurred_at) f;
 if rate_value is null then raise exception 'Нет курса на дату расхода';end if;
 select jsonb_agg(jsonb_build_object('item_id',i.id,'sku',p.internal_sku,'name',coalesce(p.name->>'ru',p.name->>'en',p.internal_sku),
 'quantity',coalesce(i.received_quantity,i.shipped_quantity,i.confirmed_quantity,i.ordered_quantity)::text,'uom',i.uom) order by p.internal_sku,i.id)
 into lines from public.shipment_items i join public.products p on p.id=i.product_id
 where i.shipment_id=s.id and coalesce(i.received_quantity,i.shipped_quantity,i.confirmed_quantity,i.ordered_quantity)>0;
 if coalesce(jsonb_array_length(lines),0) not between 1 and 200 then raise exception 'Нужно от 1 до 200 позиций с положительным количеством';end if;
 select coalesce(jsonb_agg(to_jsonb(a) order by a.shipment_item_id,a.id),'[]') into old_rows from public.expense_allocations a where expense_id=e.id;
 snapshot:=jsonb_build_object('expense',to_jsonb(e),'shipment',to_jsonb(s),'source',to_jsonb(d),
 'expense_document',(select to_jsonb(x) from public.documents x where id=e.document_id),
 'source_links',(select jsonb_agg(to_jsonb(l) order by l.id) from public.document_links l where l.document_id in(e.document_id,p_source_document_id)),
 'source_versions',(select jsonb_agg(to_jsonb(v) order by v.id) from public.document_versions v where v.document_id in(e.document_id,p_source_document_id)),
 'items',(select jsonb_agg(to_jsonb(i) order by i.id) from public.shipment_items i where shipment_id=s.id),
 'products',(select jsonb_agg(to_jsonb(p) order by p.id) from public.products p where id in(select product_id from public.shipment_items where shipment_id=s.id)),
 'packaging',(select jsonb_agg(to_jsonb(p) order by p.id) from public.product_packaging p where product_id in(select product_id from public.shipment_items where shipment_id=s.id)),
 'rate',(select to_jsonb(r) from public.exchange_rates r where id=rate_id),'currency',p_currency_id,'allocations',old_rows);
 return jsonb_build_object('expense_id',e.id,'shipment_id',s.id,'shipment_number',s.shipment_number,'expense_type',e.expense_type,
 'amount',e.amount::text,'currency',(select code from public.currencies where id=e.currency_id),'notes',e.notes,'status',e.status,
 'target_currency_id',p_currency_id,'target_currency',(select code from public.currencies where id=p_currency_id),
 'total',round(e.amount*rate_value,2)::numeric(14,2)::text,'rate',rate_value::text,'rate_id',rate_id,
 'source_document_id',d.id,'source_title',d.title,'source_version',d.current_version,'lines',lines,'previous',old_rows,
 'sources',(select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'title',x.title,'current_version',x.current_version) order by x.title,x.id),'[]')
 from public.documents x where x.archived_at is null and x.status<>'rejected' and private.can_view_generated_document(x.id)
 and exists(select 1 from public.document_links l where l.document_id=x.id and l.removed_at is null and
 ((l.entity_type='shipment' and l.entity_id=s.id) or (l.entity_type='shipment_transport' and l.entity_id in(select id from public.shipment_transports where shipment_id=s.id))))),
 'stamp',encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'),'snapshot',snapshot);
end $$;

create or replace function public.exact_expense_allocation_context(p_expense_id uuid,p_currency_id uuid,p_source_document_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c jsonb;h jsonb;
begin
 c:=private.exact_allocation_context(p_expense_id,p_currency_id,p_source_document_id);
 select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'at',r.created_at,'author',p.full_name,'basis_note',r.basis_note,
 'currency',(select code from public.currencies where id=r.currency_id),'lines',r.after_allocations,
 'source_document_id',r.source_document_id,'source_version',r.before_snapshot#>'{source,current_version}') order by r.created_at desc,r.id),'[]')
 into h from private.expense_allocation_revisions r join public.profiles p on p.id=r.created_by
 where r.expense_id=p_expense_id and (r.source_document_id is null or private.can_view_generated_document(r.source_document_id));
 return (c-'snapshot')||jsonb_build_object('history',h);
end $$;

create or replace function public.save_exact_expense_allocation(p_request_id uuid,p_expense_id uuid,p_currency_id uuid,
 p_source_document_id uuid,p_expected_stamp text,p_lines jsonb,p_basis_note text)
returns uuid language plpgsql security definer set search_path='' as $$
declare c jsonb;r jsonb;seen uuid[]:='{}';item_id uuid;amount numeric;total numeric:=0;canonical jsonb:='[]';
 payload jsonb;prior private.expense_allocation_revisions;after_rows jsonb;old_paid jsonb;
begin
 perform private.exact_allocation_access(p_expense_id);
 if not private.has_permission('costing.calculate') then raise exception 'Нет права распределять расходы' using errcode='42501';end if;
 if p_request_id is null or p_expected_stamp is null or p_expected_stamp !~ '^[0-9a-f]{64}$'
 or p_basis_note is null or length(btrim(p_basis_note)) not between 10 and 2000 then raise exception 'Укажите основание и источник распределения';end if;
 if jsonb_typeof(p_lines) is distinct from 'array' then raise exception 'Нужен список товарных строк';end if;
 if jsonb_array_length(p_lines) not between 1 and 200 then raise exception 'Нужно от 1 до 200 строк';end if;
 for r in select value from jsonb_array_elements(p_lines) loop
  if jsonb_typeof(r) is distinct from 'object' or not(r ?& array['item_id','amount']) or r-array['item_id','amount']<>'{}'
   or jsonb_typeof(r->'item_id') is distinct from 'string' or jsonb_typeof(r->'amount') is distinct from 'string'
   or (r->>'amount') !~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$' then raise exception 'Укажите неотрицательные суммы с точностью до сотых';end if;
  item_id:=(r->>'item_id')::uuid;amount:=(r->>'amount')::numeric;
  if item_id=any(seen) then raise exception 'Товарная строка повторяется';end if;
  seen:=array_append(seen,item_id);total:=total+amount;
  canonical:=canonical||jsonb_build_array(jsonb_build_object('item_id',item_id,'amount',amount::numeric(14,2)::text));
 end loop;
 select jsonb_agg(x order by x->>'item_id') into canonical from jsonb_array_elements(canonical) x;
 payload:=jsonb_build_object('expense',p_expense_id,'currency',p_currency_id,'source',p_source_document_id,'stamp',p_expected_stamp,'lines',canonical,'note',btrim(p_basis_note));
 -- Same leading lock order as costing and assistant allocation. No network inside transaction.
 lock table public.expenses,public.shipment_items,public.expense_allocations in exclusive mode;
 lock table public.documents,public.document_links,public.exchange_rates,public.products,public.product_packaging,public.document_versions in share mode;
 perform 1 from public.shipments where id=(select shipment_id from public.expenses where id=p_expense_id) for share;
 perform 1 from public.currencies where id in(p_currency_id,(select currency_id from public.expenses where id=p_expense_id)) order by id for share;
 perform private.exact_allocation_access(p_expense_id);
 if not private.has_permission('costing.calculate') then raise exception 'Нет права распределять расходы' using errcode='42501';end if;
 select * into prior from private.expense_allocation_revisions where id=p_request_id;
 if found then
  if prior.created_by<>auth.uid() or prior.request_payload<>payload then raise exception 'Идентификатор уже использован для другого распределения';end if;
  return prior.id;
 end if;
 c:=private.exact_allocation_context(p_expense_id,p_currency_id,p_source_document_id);
 if c->>'stamp' is distinct from p_expected_stamp then raise exception 'Данные изменились. Откройте распределение заново' using errcode='40001';end if;
 if total<=0 or total<>(c->>'total')::numeric then raise exception 'Сумма строк должна совпадать с положительным расходом: %',c->>'total';end if;
 if jsonb_array_length(c->'lines')<>array_length(seen,1) or exists(select 1 from jsonb_array_elements(c->'lines') x where not((x->>'item_id')::uuid=any(seen)))
 then raise exception 'Укажите каждую доступную позицию этой поставки ровно один раз';end if;
 old_paid:=c#>'{snapshot,expense}';
 if c->>'status'='draft' then perform public.confirm_expense(p_expense_id);end if;
 delete from public.expense_allocations where expense_id=p_expense_id;
 insert into public.expense_allocations(expense_id,shipment_item_id,allocation_method,allocation_basis,allocation_share,allocated_amount,currency_id)
 select p_expense_id,(x->>'item_id')::uuid,'manual',(x->>'amount')::numeric,(x->>'amount')::numeric/total,(x->>'amount')::numeric,p_currency_id
 from jsonb_array_elements(canonical) x;
 update public.expenses set status=case when status='paid' then status else 'allocated' end,exchange_rate_id=(c->>'rate_id')::uuid,updated_at=now() where id=p_expense_id;
 select jsonb_agg(jsonb_build_object('item_id',a.shipment_item_id,'amount',a.allocated_amount::text,'sku',p.internal_sku) order by a.shipment_item_id)
 into after_rows from public.expense_allocations a join public.shipment_items i on i.id=a.shipment_item_id join public.products p on p.id=i.product_id where expense_id=p_expense_id;
 if (select jsonb_agg(jsonb_build_object('item_id',a.shipment_item_id,'amount',a.allocated_amount::text) order by a.shipment_item_id) from public.expense_allocations a where expense_id=p_expense_id) is distinct from canonical
 or (select jsonb_build_array(paid_at,paid_by) from public.expenses where id=p_expense_id) is distinct from jsonb_build_array(old_paid->'paid_at',old_paid->'paid_by') then raise exception 'Результат распределения не совпал с подтверждённым';end if;
 insert into private.expense_allocation_revisions(id,expense_id,created_by,currency_id,source_document_id,basis_note,request_payload,before_snapshot,after_allocations)
 values(p_request_id,p_expense_id,auth.uid(),p_currency_id,p_source_document_id,btrim(p_basis_note),payload,c->'snapshot',after_rows);
 return p_request_id;
exception when invalid_text_representation then raise exception 'Некорректные идентификаторы или суммы';
end $$;

create or replace function private.guard_exact_allocation_history() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'История распределений неизменяема';end $$;
drop trigger if exists exact_allocation_history_guard on private.expense_allocation_revisions;
create trigger exact_allocation_history_guard before update or delete on private.expense_allocation_revisions for each row execute function private.guard_exact_allocation_history();
revoke all on function private.guard_exact_allocation_history(),private.exact_allocation_access(uuid),private.exact_allocation_context(uuid,uuid,uuid),
 public.exact_expense_allocation_context(uuid,uuid,uuid),public.save_exact_expense_allocation(uuid,uuid,uuid,uuid,text,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.exact_expense_allocation_context(uuid,uuid,uuid),public.save_exact_expense_allocation(uuid,uuid,uuid,uuid,text,jsonb,text) to authenticated;
