-- The existing ledger writers and debt rules remain unchanged. Only the guarded import entry point can call them.
revoke execute on function public.import_bank_statement(text,text,text,date,date,text,jsonb),
 public.import_opening_balances(date,jsonb,text) from public,anon,authenticated,service_role;

-- Keep a single bank ledger writer, including its accounting/audit behavior. Its public EXECUTE is revoked
-- above. Only this server workflow may supply the already verified operation key. Reapplication is checked.
do $$ declare definition text; marker text:='continue when exists (select 1 from public.bank_statement_lines where line_key = v_key);'; begin
 definition:=pg_get_functiondef('public.import_bank_statement(text,text,text,date,date,text,jsonb)'::regprocedure);
 if position('_verified_operation_key' in definition)=0 then
   if position(marker in definition)=0 then raise exception 'Bank writer changed: review identity integration before applying'; end if;
   execute replace(definition,marker,'v_key := coalesce(nullif(v_line ->> ''_verified_operation_key'', ''''), v_key); '||marker);
 end if;
end $$;

alter table public.bank_statement_lines add column if not exists operation_key text;
create unique index if not exists bank_statement_operation_unique on public.bank_statement_lines(operation_key) where operation_key is not null;

create table if not exists public.receivables_import_batches (
 id uuid primary key,
 kind text not null check (kind in ('bank','opening')),
 file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
 payload_hash text not null,
 source jsonb not null,
 result jsonb not null,
 created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
 created_at timestamptz not null default now(),
 unique(kind,file_sha256)
);
create table if not exists public.receivables_import_sources (
 batch_id uuid not null references public.receivables_import_batches(id) on delete restrict,
 ordinal integer not null,
 source_row jsonb not null,
 bank_line_id uuid references public.bank_statement_lines(id) on delete restrict,
 opening_balance_id uuid references public.customer_opening_balances(id) on delete restrict,
 primary key(batch_id,ordinal),
 check (num_nonnulls(bank_line_id,opening_balance_id)=1)
);
alter table public.receivables_import_batches enable row level security;
alter table public.receivables_import_sources enable row level security;
revoke all on public.receivables_import_batches,public.receivables_import_sources from public,anon,authenticated,service_role;
grant select on public.receivables_import_batches,public.receivables_import_sources to authenticated;
drop policy if exists "receivables import read" on public.receivables_import_batches;
create policy "receivables import read" on public.receivables_import_batches for select to authenticated
 using ((select private.has_permission('receivables.view')));
drop policy if exists "receivables import read" on public.receivables_import_sources;
create policy "receivables import read" on public.receivables_import_sources for select to authenticated
 using ((select private.has_permission('receivables.view')));

create or replace function private.receivables_import_hash(p_value jsonb) returns text
 language sql immutable set search_path='' as $$ select encode(sha256(convert_to(p_value::text,'UTF8')),'hex') $$;
revoke all on function private.receivables_import_hash(jsonb) from public,anon,authenticated,service_role;

-- One plan, used both by the read-only preview and inside the committing transaction.
create or replace function private.receivables_import_plan(p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
<<ctx>>
declare
 k text:=p->>'kind'; r jsonb; rows jsonb:='[]'; entry jsonb; n int:=0; c uuid; cur uuid;
 bn int; nn int; sn int; bc uuid; nc uuid; sc uuid; sid uuid; why text; issue text;
 key text; old public.bank_statement_lines%rowtype; balance public.customer_opening_balances%rowtype;
 account text; currency text; amount numeric; dt date; orders text[]; matches jsonb; seen text[]:='{}';
 duplicate_batch uuid; totals jsonb;
begin
 if not private.has_permission('receivables.view') or not private.has_permission('receivables.manage') then
   raise exception 'Нет права просмотра и ведения дебиторки' using errcode='42501';
 end if;
 if k is null or k not in ('bank','opening') then raise exception 'Неподдерживаемый формат импорта'; end if;
 if coalesce(p->>'file_sha256','') !~ '^[0-9a-f]{64}$' or nullif(btrim(p->>'file_name'),'') is null then raise exception 'Нет файла или его контрольной суммы'; end if;
 if jsonb_typeof(p->'rows') is distinct from 'array' then raise exception 'Нет строк'; end if;
 if jsonb_array_length(p->'rows') not between 1 and 2000 then raise exception 'Допускается от 1 до 2000 строк'; end if;
 if coalesce(jsonb_array_length(p->'problems'),0)>0 then raise exception 'Исправьте ошибки чтения файла до загрузки'; end if;
 select id into duplicate_batch from public.receivables_import_batches where kind=k and file_sha256=p->>'file_sha256';
 if k='opening' then
   dt := (p->>'as_of')::date;
   if dt is null or dt>private.receivables_today() then raise exception 'Некорректная дата сальдо'; end if;
 end if;
 for r in select value from jsonb_array_elements(p->'rows') loop
   n:=n+1; c:=null; bc:=null; nc:=null; sc:=null; sid:=null; why:=null; issue:=null; key:=null; matches:='[]';
   old:=null; balance:=null;
   currency:=coalesce(r->>'currency',p->>'currency');
   cur:=private.currency_by_code(currency);
   if jsonb_typeof(r->'amount') is distinct from 'number' then raise exception 'Строка %: сумма должна быть числом',n; end if;
   amount:=(r->>'amount')::numeric;
   if amount<>round(amount,2) or abs(amount)>=100000000000000 then raise exception 'Строка %: недопустимая точность или сумма',n; end if;
   if k='bank' then
     dt:=(r->>'doc_date')::date;
     if dt is null or amount<=0 then raise exception 'Строка %: нет даты или положительной суммы',n; end if;
     account:=upper(regexp_replace(coalesce(r->>'recipient_account',p->>'account',''),'\s','','g'));
     if account='' then issue:='Не указан счёт получателя'; end if;
     -- A payment order number is NOT a bank operation ID. No automatic fallback to date/amount/customer.
     if nullif(btrim(r->>'operation_id'),'') is null then issue:='Нужен устойчивый идентификатор операции из банка';
     elsif r->>'identity_source' not in ('bank','manual') or r->>'identity_source' is null then issue:='Укажите источник идентификатора';
     elsif r->>'identity_source'='manual' and length(btrim(coalesce(r->>'reason','')))<5 then issue:='Укажите причину ручного различения операции';
     else key:=private.receivables_import_hash(jsonb_build_array(account,currency,btrim(r->>'operation_id'))); end if;
     if key=any(seen) then issue:='Идентификатор повторяется внутри файла: проверьте исходные строки'; end if;
     seen:=array_append(seen,key);
     select * into old from public.bank_statement_lines where operation_key=key;
     if old.id is not null and (old.amount<>amount or old.doc_date<>dt or old.currency_id<>cur
        or coalesce(old.payer_account,'')<>upper(regexp_replace(coalesce(r->>'payer_account',''),'\s','','g'))) then
       issue:='Идентификатор уже существует с другими реквизитами';
     end if;
     -- Legacy rows have no trustworthy stable identity. Never silently import across that boundary.
     if old.id is null then
       select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'number',l.doc_number,'date',l.doc_date,'amount',l.amount) order by l.id),'[]') into matches
       from public.bank_statement_lines l join public.bank_statement_imports i on i.id=l.import_id
       where l.operation_key is null and l.doc_date=dt and l.amount=ctx.amount and l.currency_id=cur
         and upper(regexp_replace(coalesce(i.account_number,''),'\s','','g'))=account;
       if jsonb_array_length(matches)>0 then
         if length(btrim(coalesce(r->>'reason','')))<5 then issue:='Есть прежние платежи без идентификатора: требуется ручная проверка';
         elsif r->>'legacy_decision'='same' then
           select * into old from public.bank_statement_lines l where l.id=(r->>'legacy_id')::uuid
             and l.id in (select (value->>'id')::uuid from jsonb_array_elements(matches));
           if old.id is null then issue:='Выбранный прежний платёж недоступен или изменился'; end if;
         elsif r->>'legacy_decision' is distinct from 'different' then issue:='Укажите: прежний платёж или отдельная операция'; end if;
       end if;
     end if;
     select count(*),(array_agg(id order by id))[1] into bn,bc from public.counterparties
       where 'customer'=any(roles) and nullif(regexp_replace(coalesce(r->>'payer_bin',''),'\D','','g'),'') is not null
       and regexp_replace(coalesce(tax_id,''),'\D','','g')=regexp_replace(r->>'payer_bin','\D','','g');
     select array_agg(distinct upper(m[1])) into orders from regexp_matches(coalesce(r->>'purpose',''),'(SO-\d{4}-\d{6})','gi') m;
     select count(*),(array_agg(id order by id))[1],(array_agg(customer_id order by id))[1] into sn,sid,sc
       from public.sales where sale_number=any(orders) and status<>'cancelled';
     if bn>1 or sn>1 or coalesce(cardinality(orders),0)>1 then issue:=coalesce(issue,'Неоднозначное совпадение БИН или номера заказа');
     elsif bn=1 and sn=1 and bc<>sc then issue:=coalesce(issue,'БИН и заказ указывают разных покупателей');
     elsif bn=1 then c:=bc; why:='auto_bin';
     elsif sn=1 then c:=sc; why:='auto_order';
     else why:='unmatched'; end if;
     if old.id is not null then c:=old.customer_id; sid:=old.sale_id; why:='duplicate'; end if;
   else
     select count(*),(array_agg(id order by id))[1] into bn,bc from public.counterparties
       where 'customer'=any(roles) and nullif(regexp_replace(coalesce(r->>'bin',''),'\D','','g'),'') is not null
       and regexp_replace(coalesce(tax_id,''),'\D','','g')=regexp_replace(r->>'bin','\D','','g');
     select count(*),(array_agg(id order by id))[1] into nn,nc from public.counterparties where 'customer'=any(roles)
       and lower(btrim(r->>'name')) in (lower(btrim(legal_name)),lower(btrim(short_name)));
     if bn>1 or (bn=0 and nn>1) then issue:='Неоднозначный покупатель';
     elsif bn=1 and nn=1 and bc<>nc then issue:='БИН и название указывают разных покупателей';
     elsif bn=1 then c:=bc; why:='auto_bin';
     elsif nn=1 and nullif(btrim(r->>'bin'),'') is null then c:=nc; why:='exact_name';
     else issue:='Покупатель не найден: проверьте БИН и название'; end if;
     if c is not null then
       -- The accepted format is flat: one balance per customer/currency. Hierarchies are not guessed.
       key:=c::text||':'||cur::text;
       if key=any(seen) then issue:='Повтор покупателя и валюты: структура итогов/договоров неоднозначна'; end if;
       seen:=array_append(seen,key);
       select * into balance from public.customer_opening_balances where customer_id=c and currency_id=cur and superseded_at is null;
       if balance.id is not null then
         if r->>'replace_id' is distinct from balance.id::text or length(btrim(coalesce(r->>'reason','')))<5 then
           issue:=coalesce(issue,'Есть действующее сальдо: проверьте конфликт и подтвердите замену с причиной');
         end if;
       elsif nullif(r->>'replace_id','') is not null then issue:='Прежнее сальдо изменилось'; end if;
     end if;
   end if;
   entry:=jsonb_build_object('ordinal',n,'source_row',r,'currency',currency,'amount',amount,'customer_id',c,
     'customer_name',(select legal_name from public.counterparties where id=c),'match_reason',why,'sale_id',sid,
     'operation_key',key,'existing_line_id',old.id,'legacy_candidates',matches,
     'previous_balance',case when balance.id is null then null else jsonb_build_object('id',balance.id,'amount',balance.amount,'as_of',balance.as_of) end,
     'status',case when issue is not null then 'error' when old.id is not null then 'duplicate' else 'new' end,'problem',issue);
   rows:=rows||jsonb_build_array(entry);
 end loop;
 select coalesce(jsonb_agg(x order by x->>'currency'),'[]') into totals from
   (select jsonb_build_object('currency',value->>'currency','count',count(*),'amount',sum((value->>'amount')::numeric)) x
    from jsonb_array_elements(rows) group by value->>'currency') s;
 return jsonb_build_object('rows',rows,'totals',totals,'existing_batch_id',duplicate_batch,
   'can_confirm',not exists(select 1 from jsonb_array_elements(rows) where value->>'status'='error'),
   'fingerprint',private.receivables_import_hash(jsonb_build_object('payload',p-'file_name','rows',rows)));
end $$;
revoke all on function private.receivables_import_plan(jsonb) from public,anon,authenticated,service_role;

create or replace function public.preview_receivables_import(p_payload jsonb) returns jsonb
 language sql security definer set search_path='' as $$ select private.receivables_import_plan(p_payload) $$;

create or replace function public.confirm_receivables_import(p_request_id uuid,p_payload jsonb,p_fingerprint text) returns jsonb
language plpgsql security definer set search_path='' as $$
<<ctx>>
declare plan jsonb; prior public.receivables_import_batches%rowtype; h text; result jsonb; e jsonb; r jsonb;
 v_id uuid; bank_import uuid; c uuid; cur uuid; new_count int:=0; duplicate_count int:=0; normalized jsonb;
begin
 if not private.has_permission('receivables.view') or not private.has_permission('receivables.manage') then
   raise exception 'Нет права просмотра и ведения дебиторки' using errcode='42501';
 end if;
 if p_request_id is null then raise exception 'Нет идентификатора запроса'; end if;
 -- All financial import commits share this lock. No interleaving of overlap checks, identity assignment or opening replacement.
 perform pg_advisory_xact_lock(726831,1);
 h:=private.receivables_import_hash(p_payload-'file_name');
 select * into prior from public.receivables_import_batches where id=p_request_id
   or (kind=p_payload->>'kind' and file_sha256=p_payload->>'file_sha256') order by id limit 1;
 if prior.id is not null then
   if prior.payload_hash<>h then raise exception 'Файл или запрос уже подтверждён с другими данными: откройте историю импорта'; end if;
   return prior.result;
 end if;
 -- Freeze matching inputs and manual resolutions while using the exact preview plan. Locks also cover legacy privileged imports.
 lock table public.counterparties,public.sales in share mode;
 lock table public.bank_statement_imports,public.bank_statement_lines,public.customer_opening_balances in share row exclusive mode;
 plan:=private.receivables_import_plan(p_payload);
 if not (plan->>'can_confirm')::boolean then raise exception 'Есть ошибки или неразрешённые конфликты: обновите предпросмотр'; end if;
 if p_fingerprint is distinct from plan->>'fingerprint' then raise exception 'Данные изменились после просмотра: обновите предпросмотр'; end if;
 result:=jsonb_build_object('batch_id',p_request_id);
 insert into public.receivables_import_batches(id,kind,file_sha256,payload_hash,source,result)
 values(p_request_id,p_payload->>'kind',p_payload->>'file_sha256',h,p_payload,result);
 for e in select value from jsonb_array_elements(plan->'rows') loop
   r:=e->'source_row'; v_id:=null; c:=(e->>'customer_id')::uuid; cur:=private.currency_by_code(e->>'currency');
   if p_payload->>'kind'='bank' then
     if e->>'existing_line_id' is not null then
       v_id:=(e->>'existing_line_id')::uuid;
       update public.bank_statement_lines set operation_key=e->>'operation_key' where bank_statement_lines.id=v_id and operation_key is null;
       duplicate_count:=duplicate_count+1;
     else
       -- Reuse the existing writer with one guarded row. An internal unique file key prevents its old content hash from deciding identity.
       normalized:=r||jsonb_build_object('_verified_operation_key',e->>'operation_key','payer_account',upper(regexp_replace(coalesce(r->>'payer_account',''),'\s','','g')));
       result:=public.import_bank_statement(p_payload->>'file_name',private.receivables_import_hash(jsonb_build_array(p_request_id,e->>'ordinal')),
         upper(regexp_replace(coalesce(r->>'recipient_account',p_payload->>'account'),'\s','','g')),
         nullif(p_payload->>'period_from','')::date,nullif(p_payload->>'period_to','')::date,e->>'currency',jsonb_build_array(normalized));
       bank_import:=(result->>'import_id')::uuid;
       select l.id into v_id from public.bank_statement_lines l where import_id=bank_import;
       if v_id is null then raise exception 'Похожий платёж найден старым механизмом: требуется проверка, запись отменена'; end if;
       update public.bank_statement_lines set operation_key=e->>'operation_key',
         line_key=e->>'operation_key',customer_id=c,sale_id=(e->>'sale_id')::uuid,
         status=case when c is null then 'unmatched' else 'matched' end,
         matched_how=case when c is null then null else e->>'match_reason' end where bank_statement_lines.id=v_id;
       new_count:=new_count+1;
     end if;
     insert into public.receivables_import_sources values(p_request_id,(e->>'ordinal')::int,r,v_id,null);
   else
     perform public.import_opening_balances((p_payload->>'as_of')::date,jsonb_build_array(r||jsonb_build_object('customer_id',c)),p_payload->>'file_name');
     select b.id into v_id from public.customer_opening_balances b where customer_id=c and currency_id=cur and superseded_at is null;
     insert into public.receivables_import_sources values(p_request_id,(e->>'ordinal')::int,r,null,v_id);
     new_count:=new_count+1;
   end if;
 end loop;
 result:=jsonb_build_object('batch_id',p_request_id,'new',new_count,'duplicates',duplicate_count,'total',jsonb_array_length(plan->'rows'));
 update public.receivables_import_batches set result=ctx.result where receivables_import_batches.id=p_request_id;
 return result;
end $$;
revoke all on function public.preview_receivables_import(jsonb),public.confirm_receivables_import(uuid,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.preview_receivables_import(jsonb),public.confirm_receivables_import(uuid,jsonb,text) to authenticated;
