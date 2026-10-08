-- Phase 10A: internal read-only web assistant (first release).
--
-- The assistant reads business data only through the employee's own Supabase session, so the
-- existing RLS and permission checks stay the single source of truth. This migration adds only
-- what the assistant itself needs:
--   * permissions agent.use (internal roles) and agent.view_traces (administrator);
--   * a single settings row with the daily request limit and the monthly money budget;
--   * per-user daily counters and per-month spend, reserved atomically under row locks;
--   * agent_runs: a short masked excerpt, tool names, safe parameters, usage and an error code.
--     Full questions, answers, documents and tool results are never stored.
-- Limits are read from agent_settings, never from RPC arguments, so a direct RPC call cannot
-- raise them. Finishing a run needs a one-time token returned only to the server that reserved it.
-- Rollback without losing history: revoke agent.* from roles and unset AGENT_ENABLED; keep the
-- tables (see docs/ai-assistant.md). Re-running this migration is safe and keeps admin changes.

insert into public.permissions(code,module,action,name,description) values
 ('agent.use','agent','use','Ассистент: вопросы','Вопросы AI-ассистенту о данных, доступных сотруднику по его правам'),
 ('agent.view_traces','agent','view_traces','Ассистент: трассы сотрудников','Просмотр безопасных трасс запросов других сотрудников')
on conflict(code) do update set module=excluded.module,action=excluded.action,name=excluded.name,description=excluded.description;

-- Granted once; a later administrator change is preserved on re-run (do nothing).
insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true from public.app_roles r cross join public.permissions p
where p.code='agent.use' and r.audience='internal' and r.code in (
 'director','executive_director','commercial_director','logistics_director',
 'senior_logistics_manager','logistics_specialist','accountant','marketer','administrator'
)
on conflict(role_id,permission_id) do nothing;
insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true from public.app_roles r cross join public.permissions p
where p.code='agent.view_traces' and r.code='administrator'
on conflict(role_id,permission_id) do nothing;
-- External accounts never use the assistant, whatever was granted by hand.
delete from public.role_permissions rp using public.app_roles r,public.permissions p
where rp.role_id=r.id and rp.permission_id=p.id and p.code like 'agent.%' and r.audience<>'internal';

create table if not exists public.agent_settings(
 id boolean primary key default true check(id),
 daily_request_limit integer not null default 20 check(daily_request_limit between 0 and 1000),
 monthly_budget_usd_micros bigint not null default 0 check(monthly_budget_usd_micros>=0),
 max_run_reserve_usd_micros bigint not null default 0 check(max_run_reserve_usd_micros>=0),
 reservation_ttl_seconds integer not null default 600 check(reservation_ttl_seconds between 60 and 3600),
 updated_at timestamptz not null default now()
);
insert into public.agent_settings(id) values(true) on conflict(id) do nothing;

create table if not exists public.agent_usage_days(
 user_id uuid not null references public.profiles(id) on delete restrict,
 usage_date date not null,
 requests_used integer not null default 0 check(requests_used>=0),
 requests_refunded integer not null default 0 check(requests_refunded>=0),
 updated_at timestamptz not null default now(),
 primary key(user_id,usage_date)
);

create table if not exists public.agent_budget_months(
 budget_month date primary key check(extract(day from budget_month)=1),
 spent_usd_micros bigint not null default 0 check(spent_usd_micros>=0),
 input_tokens bigint not null default 0 check(input_tokens>=0),
 output_tokens bigint not null default 0 check(output_tokens>=0),
 updated_at timestamptz not null default now()
);

create table if not exists public.agent_runs(
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references public.profiles(id) on delete restrict,
 channel text not null check(channel in ('web','telegram')),
 status text not null default 'running' check(status in ('running','completed','failed','rejected')),
 usage_date date not null,
 budget_month date not null,
 question_excerpt text check(question_excerpt is null or length(question_excerpt)<=200),
 tools jsonb not null default '[]'::jsonb check(jsonb_typeof(tools)='array' and pg_column_size(tools)<=16384),
 provider text check(provider is null or provider ~ '^[a-z0-9_.-]{1,40}$'),
 model text check(model is null or length(model) between 1 and 80),
 steps integer not null default 0 check(steps between 0 and 50),
 tool_calls integer not null default 0 check(tool_calls between 0 and 100),
 input_tokens integer not null default 0 check(input_tokens>=0),
 output_tokens integer not null default 0 check(output_tokens>=0),
 reserved_usd_micros bigint not null default 0 check(reserved_usd_micros>=0),
 actual_usd_micros bigint not null default 0 check(actual_usd_micros>=0),
 request_refunded boolean not null default false,
 -- reserved: run in progress; actual: finished with reported usage; estimated: abandoned run charged
 -- its whole reservation; reconciled: an abandoned run finished late, spend corrected to reported usage.
 cost_status text not null default 'reserved',
 error_code text check(error_code is null or error_code ~ '^[A-Z][A-Z_]{1,63}$'),
 finish_token_hash text not null check(finish_token_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz not null default now(),
 finished_at timestamptz,
 check((status='running')=(finished_at is null)),
 check(not request_refunded or status<>'completed')
);
alter table public.agent_runs add column if not exists cost_status text not null default 'reserved';
do $$begin
 if not exists(select 1 from pg_constraint where conname='agent_runs_cost_status_check' and conrelid='public.agent_runs'::regclass) then
  alter table public.agent_runs add constraint agent_runs_cost_status_check
   check(cost_status in ('reserved','actual','estimated','reconciled') and (status='running')=(cost_status='reserved'));
 end if;
end$$;
create index if not exists agent_runs_user_created_idx on public.agent_runs(user_id,created_at desc);
create index if not exists agent_runs_month_status_idx on public.agent_runs(budget_month,status);

do $$declare t text;begin foreach t in array array['agent_settings','agent_usage_days','agent_budget_months','agent_runs'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
end loop;end$$;
grant select on public.agent_settings,public.agent_usage_days,public.agent_budget_months to authenticated;
-- The finish token hash is never readable through the API.
grant select(id,user_id,channel,status,usage_date,budget_month,question_excerpt,tools,provider,model,steps,tool_calls,
 input_tokens,output_tokens,reserved_usd_micros,actual_usd_micros,request_refunded,cost_status,error_code,created_at,finished_at)
 on public.agent_runs to authenticated;

drop policy if exists "trace viewers read agent settings" on public.agent_settings;
create policy "trace viewers read agent settings" on public.agent_settings for select to authenticated
 using((select private.has_permission('agent.view_traces')));
drop policy if exists "own or trace viewers read agent usage" on public.agent_usage_days;
create policy "own or trace viewers read agent usage" on public.agent_usage_days for select to authenticated
 using((user_id=(select auth.uid()) and (select private.has_permission('agent.use'))) or (select private.has_permission('agent.view_traces')));
drop policy if exists "trace viewers read agent budget" on public.agent_budget_months;
create policy "trace viewers read agent budget" on public.agent_budget_months for select to authenticated
 using((select private.has_permission('agent.view_traces')));
drop policy if exists "own or trace viewers read agent runs" on public.agent_runs;
create policy "own or trace viewers read agent runs" on public.agent_runs for select to authenticated
 using((user_id=(select auth.uid()) and (select private.has_permission('agent.use'))) or (select private.has_permission('agent.view_traces')));

drop trigger if exists audit_agent_settings_changes on public.agent_settings;
create trigger audit_agent_settings_changes after insert or update on public.agent_settings
 for each row execute function private.write_access_audit();

-- Kazakhstan business day: the daily limit resets at midnight Asia/Aqtobe (UTC+5).
create or replace function private.agent_local_date() returns date
language sql stable set search_path='' as $$ select (now() at time zone 'Asia/Aqtobe')::date $$;
revoke all on function private.agent_local_date() from public,anon,authenticated,service_role;

-- Everything the trace stores is checked and cleaned here, whoever calls the RPC: the finish token
-- only proves that the caller owns the run, not that the values come from the Nexus server.
-- Free text: control and invisible characters removed, secrets and any chain of 7+ digits (also split
-- by spaces, dots, hyphens, slashes or brackets) masked, long opaque tokens masked, length bounded.
create or replace function private.agent_clean_text(p_text text,p_max integer) returns text
language plpgsql immutable set search_path='' as $$
declare v text:=p_text;
begin
 if v is null then return null;end if;
 v:=regexp_replace(v,'[\u0001-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]','','g');
 v:=regexp_replace(v,'[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]','-','g');
 v:=regexp_replace(v,'[\s\u00a0\u2000-\u200a\u202f\u205f\u3000]+',' ','g');
 v:=translate(v,'０１２３４５６７８９','0123456789');
 v:=regexp_replace(v,'-----BEGIN[A-Z ]*PRIVATE KEY-----.*','[скрыт ключ]','gi');
 v:=regexp_replace(v,'(password|passwd|пароль|token|токен|secret|секрет|api[_ -]?key|ключ api|private[_ -]?key)\s*[:=]\s*\S+','\1=[скрыто]','gi');
 v:=regexp_replace(v,'bearer\s+\S+','Bearer [скрыто]','gi');
 v:=regexp_replace(v,'[a-z][a-z0-9+.-]*://[^\s:/@]+:[^\s@]+@','[скрыто]@','gi');
 v:=regexp_replace(v,'[A-Za-z0-9_+/=.-]{24,}','[скрыто]','g');
 v:=regexp_replace(v,'[0-9](?:[ ._/()+-]{0,3}[0-9]){6,}','[скрыто]','g');
 return nullif(btrim(left(btrim(v),p_max)),'');
end$$;
revoke all on function private.agent_clean_text(text,integer) from public,anon,authenticated,service_role;

-- The tool trace has a fixed shape: unknown tools, keys, parameters or error codes reject the call;
-- the stored value is rebuilt from the checked parts only.
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
       'list_delayed_shipments','get_stock_status','get_my_tasks','get_help','unknown')
     or (e->>'rows') !~ '^(100|[0-9]{1,2})$' or (e->>'ms') !~ '^(120000|1[01][0-9]{4}|[0-9]{1,5})$'
     or (e ? 'error' and (jsonb_typeof(e->'error')<>'string' or (e->>'error') not in
       ('TOOL_CALL_LIMIT','UNKNOWN_TOOL','INVALID_PARAMS','PERMISSION_DENIED','TOOL_TIMEOUT','TOOL_ERROR'))) then
   raise exception 'AGENT_BAD_REQUEST' using errcode='22023';
  end if;
  params:='{}'::jsonb;
  for k,v in select * from jsonb_each(e->'params') loop
   if k in ('query','product_query') and jsonb_typeof(v)='string' then
    params:=params||jsonb_build_object(k,coalesce(private.agent_clean_text(v#>>'{}',60),''));
   elsif k in ('status','type','filter','topic') and jsonb_typeof(v)='string' and (v#>>'{}') ~ '^[a-z_]{1,30}$' then
    params:=params||jsonb_build_object(k,v);
   elsif k='warehouse_code' and jsonb_typeof(v)='string' and (v#>>'{}') ~ '^[A-Z_]{2,20}$' then
    params:=params||jsonb_build_object(k,v);
   elsif k='limit' and jsonb_typeof(v)='number' and (v#>>'{}') ~ '^([1-9]|1[0-9]|20)$' then
    params:=params||jsonb_build_object(k,v);
   elsif k in ('shipment_id','document_id') and jsonb_typeof(v)='string'
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

-- Budget accounting is a server-only operation. An employee's session must not reserve or finish
-- runs: the finish token would be returned to the employee, who could then report invented usage
-- and refunds and exhaust the shared budget without any model call. Both RPCs are executable only
-- by service_role (the Nexus server's secret key). The server passes the employee id it verified
-- from the session; business data is still read only with the employee's own session.
drop function if exists public.agent_reserve_run(text,text,bigint);
drop function if exists public.agent_finish_run(uuid,text,text,text,boolean,text,text,integer,integer,integer,integer,bigint,jsonb);

create or replace function public.agent_reserve_run(p_user_id uuid,p_channel text,p_question_excerpt text,p_reserve_usd_micros bigint)
returns table(run_id uuid,finish_token text,requests_used integer,request_limit integer)
language plpgsql security definer set search_path='' as $$
declare
 v_user uuid:=p_user_id;s public.agent_settings%rowtype;
 v_day date:=private.agent_local_date();v_month date;v_used integer;v_spent bigint;v_active bigint;v_settled bigint;v_token text;v_id uuid;
begin
 -- Active internal employee holding agent.use (deny overrides and role expiry included).
 if v_user is null or not private.user_has_permission(v_user,'agent.use') then raise exception 'AGENT_FORBIDDEN' using errcode='42501';end if;
 if p_channel is null or p_channel not in ('web','telegram') or p_reserve_usd_micros is null or p_reserve_usd_micros<=0
    or (p_question_excerpt is not null and length(p_question_excerpt)>200) then
  raise exception 'AGENT_BAD_REQUEST' using errcode='22023';
 end if;
 v_month:=date_trunc('month',v_day)::date;
 select * into s from public.agent_settings where id;
 if p_reserve_usd_micros>s.max_run_reserve_usd_micros then raise exception 'AGENT_RUN_BUDGET_EXCEEDED' using errcode='P0001';end if;

 -- Lock order (usage day, then budget month) is the same in agent_finish_run.
 insert into public.agent_usage_days(user_id,usage_date) values(v_user,v_day) on conflict do nothing;
 select d.requests_used into v_used from public.agent_usage_days d where d.user_id=v_user and d.usage_date=v_day for update;
 if v_used>=s.daily_request_limit then raise exception 'AGENT_DAILY_LIMIT' using errcode='P0001';end if;

 insert into public.agent_budget_months(budget_month) values(v_month) on conflict do nothing;
 select m.spent_usd_micros into v_spent from public.agent_budget_months m where m.budget_month=v_month for update;
 -- A run still open after the TTL was abandoned (crashed server, lost connection). Its money is never
 -- released silently: the whole reservation is charged as an estimate, because the provider may have
 -- billed up to that amount. A late agent_finish_run replaces the estimate with the reported usage.
 -- The request itself is not returned to the user here: the request and the money are settled apart.
 -- Runs being finished right now are locked and skipped; they keep holding their reservation.
 with stale as (
  select r.id from public.agent_runs r
  where r.budget_month=v_month and r.status='running' and r.created_at<now()-make_interval(secs=>s.reservation_ttl_seconds)
  for update skip locked
 ), settled as (
  update public.agent_runs r set status='failed',error_code='AGENT_ABANDONED',actual_usd_micros=r.reserved_usd_micros,
   cost_status='estimated',finished_at=now()
  from stale where r.id=stale.id returning r.reserved_usd_micros
 ) select coalesce(sum(reserved_usd_micros),0) into v_settled from settled;
 if v_settled>0 then
  update public.agent_budget_months set spent_usd_micros=spent_usd_micros+v_settled,updated_at=now() where budget_month=v_month;
  v_spent:=v_spent+v_settled;
 end if;
 -- Every open run holds its reservation, whatever its age.
 select coalesce(sum(r.reserved_usd_micros),0) into v_active from public.agent_runs r
 where r.budget_month=v_month and r.status='running';
 if v_spent+v_active+p_reserve_usd_micros>s.monthly_budget_usd_micros then raise exception 'AGENT_MONTHLY_BUDGET' using errcode='P0001';end if;

 update public.agent_usage_days set requests_used=v_used+1,updated_at=now() where user_id=v_user and usage_date=v_day;
 v_token:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
 -- The server masks the excerpt; the database cleans it again, so a direct RPC call cannot store
 -- identity or phone numbers or secrets in the trace.
 insert into public.agent_runs(user_id,channel,usage_date,budget_month,question_excerpt,reserved_usd_micros,finish_token_hash)
 values(v_user,p_channel,v_day,v_month,private.agent_clean_text(p_question_excerpt,200),
  p_reserve_usd_micros,encode(sha256(convert_to(v_token,'UTF8')),'hex'))
 returning id into v_id;
 return query select v_id,v_token,v_used+1,s.daily_request_limit;
end$$;

create or replace function public.agent_finish_run(
 p_user_id uuid,p_run_id uuid,p_finish_token text,p_status text,p_error_code text,p_refund boolean,
 p_provider text,p_model text,p_steps integer,p_tool_calls integer,
 p_input_tokens integer,p_output_tokens integer,p_actual_usd_micros bigint,p_tools jsonb
) returns void
language plpgsql security definer set search_path='' as $$
declare r public.agent_runs%rowtype;v_tools jsonb;v_late boolean;v_delta bigint;v_refund boolean:=coalesce(p_refund,false);
begin
 -- Lock order: run, usage day, budget month. agent_reserve_run takes usage day, budget month and
 -- then only skips locked runs, so the two cannot deadlock.
 select * into r from public.agent_runs where id=p_run_id for update;
 -- An open run is finished once; an abandoned one (estimated cost) may be reconciled once.
 if not found or p_user_id is null or r.user_id is distinct from p_user_id or r.cost_status not in ('reserved','estimated')
    or r.finish_token_hash<>encode(sha256(convert_to(coalesce(p_finish_token,''),'UTF8')),'hex') then
  raise exception 'AGENT_RUN_NOT_FOUND' using errcode='42501';
 end if;
 v_late:=r.cost_status='estimated';
 -- Strict checks of every stored value: reject instead of storing anything unexpected.
 if p_status is null or p_status not in ('completed','failed','rejected') or (v_refund and p_status='completed')
    or (p_status='completed' and p_error_code is not null)
    or (p_error_code is not null and p_error_code not in ('AGENT_TIMEOUT','AGENT_PROVIDER_ERROR','AGENT_TOKEN_LIMIT',
      'AGENT_STEP_LIMIT','AGENT_BAD_ANSWER','AGENT_INTERNAL_ERROR','AGENT_FORBIDDEN'))
    or p_provider is null or p_provider !~ '^[a-z][a-z0-9_-]{0,39}$'
    or p_model is null or p_model !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$' or p_model ~ '[0-9]{7}'
    or least(coalesce(p_steps,0),coalesce(p_tool_calls,0),coalesce(p_input_tokens,0),coalesce(p_output_tokens,0))<0
    or coalesce(p_actual_usd_micros,0)<0 then
  raise exception 'AGENT_BAD_REQUEST' using errcode='22023';
 end if;
 v_tools:=private.agent_clean_tools(p_tools);
 -- The caller reports usage, so it is bounded by the run's own reservation: a direct RPC call cannot
 -- inflate the shared monthly spend. The server reserves the worst case with a margin.
 p_actual_usd_micros:=least(coalesce(p_actual_usd_micros,0),r.reserved_usd_micros);
 p_input_tokens:=least(coalesce(p_input_tokens,0),10000000);
 p_output_tokens:=least(coalesce(p_output_tokens,0),10000000);
 p_steps:=least(coalesce(p_steps,0),50);
 p_tool_calls:=least(coalesce(p_tool_calls,0),100);
 -- Returning the request to the user is separate from accounting the money.
 if v_refund and not r.request_refunded then
  update public.agent_usage_days set requests_used=greatest(requests_used-1,0),requests_refunded=requests_refunded+1,updated_at=now()
  where user_id=r.user_id and usage_date=r.usage_date;
 end if;
 -- Tokens and money that the provider actually charged are recorded even for refunded runs. A late
 -- finish only adds the difference to the estimate already charged, so nothing is counted twice.
 v_delta:=p_actual_usd_micros-case when v_late then r.actual_usd_micros else 0 end;
 update public.agent_budget_months set spent_usd_micros=greatest(spent_usd_micros+v_delta,0),
  input_tokens=input_tokens+p_input_tokens,output_tokens=output_tokens+p_output_tokens,updated_at=now()
 where budget_month=r.budget_month;
 update public.agent_runs set status=p_status,error_code=p_error_code,request_refunded=r.request_refunded or v_refund,
  provider=p_provider,model=p_model,steps=p_steps,tool_calls=p_tool_calls,input_tokens=p_input_tokens,output_tokens=p_output_tokens,
  actual_usd_micros=p_actual_usd_micros,tools=v_tools,cost_status=case when v_late then 'reconciled' else 'actual' end,finished_at=now()
 where id=r.id;
end$$;

create or replace function public.my_agent_usage()
returns table(usage_date date,requests_used integer,request_limit integer,budget_configured boolean)
language plpgsql stable security definer set search_path='' as $$
declare v_day date:=private.agent_local_date();
begin
 if not (select private.has_permission('agent.use')) then raise exception 'AGENT_FORBIDDEN' using errcode='42501';end if;
 return query select v_day,
  coalesce((select d.requests_used from public.agent_usage_days d where d.user_id=(select auth.uid()) and d.usage_date=v_day),0),
  s.daily_request_limit,(s.monthly_budget_usd_micros>0 and s.max_run_reserve_usd_micros>0)
 from public.agent_settings s where s.id;
end$$;

do $$declare f text;begin foreach f in array array[
 'public.agent_reserve_run(uuid,text,text,bigint)',
 'public.agent_finish_run(uuid,uuid,text,text,text,boolean,text,text,integer,integer,integer,integer,bigint,jsonb)',
 'public.my_agent_usage()'
] loop execute format('revoke all on function %s from public,anon,authenticated,service_role',f);end loop;end$$;
-- Accounting only by the trusted server; reading one's own usage with the employee session.
grant execute on function public.agent_reserve_run(uuid,text,text,bigint) to service_role;
grant execute on function public.agent_finish_run(uuid,uuid,text,text,text,boolean,text,text,integer,integer,integer,integer,bigint,jsonb) to service_role;
grant execute on function public.my_agent_usage() to authenticated;

comment on table public.agent_runs is 'Assistant run trace: masked excerpt, tool names, safe parameters, usage, error code. No full questions, answers or tool results.';
comment on table public.agent_settings is 'Single row: daily request limit and monthly assistant budget. Changed only from the SQL editor by an administrator.';
