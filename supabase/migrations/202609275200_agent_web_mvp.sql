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
 error_code text check(error_code is null or error_code ~ '^[A-Z][A-Z0-9_]{1,63}$'),
 finish_token_hash text not null check(finish_token_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz not null default now(),
 finished_at timestamptz,
 check((status='running')=(finished_at is null)),
 check(not request_refunded or status<>'completed')
);
create index if not exists agent_runs_user_created_idx on public.agent_runs(user_id,created_at desc);
create index if not exists agent_runs_month_status_idx on public.agent_runs(budget_month,status);

do $$declare t text;begin foreach t in array array['agent_settings','agent_usage_days','agent_budget_months','agent_runs'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
end loop;end$$;
grant select on public.agent_settings,public.agent_usage_days,public.agent_budget_months to authenticated;
-- The finish token hash is never readable through the API.
grant select(id,user_id,channel,status,usage_date,budget_month,question_excerpt,tools,provider,model,steps,tool_calls,
 input_tokens,output_tokens,reserved_usd_micros,actual_usd_micros,request_refunded,error_code,created_at,finished_at)
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

-- Kazakhstan business day: the daily limit resets at midnight Asia/Qyzylorda.
create or replace function private.agent_local_date() returns date
language sql stable set search_path='' as $$ select (now() at time zone 'Asia/Qyzylorda')::date $$;
revoke all on function private.agent_local_date() from public,anon,authenticated,service_role;

create or replace function public.agent_reserve_run(p_channel text,p_question_excerpt text,p_reserve_usd_micros bigint)
returns table(run_id uuid,finish_token text,requests_used integer,request_limit integer)
language plpgsql security definer set search_path='' as $$
declare
 v_user uuid:=(select auth.uid());s public.agent_settings%rowtype;
 v_day date:=private.agent_local_date();v_month date;v_used integer;v_spent bigint;v_active bigint;v_token text;v_id uuid;
begin
 if v_user is null or not (select private.has_permission('agent.use')) then raise exception 'AGENT_FORBIDDEN' using errcode='42501';end if;
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
 -- Reservations older than the TTL (a crashed server) stop holding budget but can still be finished
 -- later, so the tokens actually charged are recorded.
 select m.spent_usd_micros into v_spent from public.agent_budget_months m where m.budget_month=v_month for update;
 select coalesce(sum(r.reserved_usd_micros),0) into v_active from public.agent_runs r
 where r.budget_month=v_month and r.status='running' and r.created_at>=now()-make_interval(secs=>s.reservation_ttl_seconds);
 if v_spent+v_active+p_reserve_usd_micros>s.monthly_budget_usd_micros then raise exception 'AGENT_MONTHLY_BUDGET' using errcode='P0001';end if;

 update public.agent_usage_days set requests_used=v_used+1,updated_at=now() where user_id=v_user and usage_date=v_day;
 v_token:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
 insert into public.agent_runs(user_id,channel,usage_date,budget_month,question_excerpt,reserved_usd_micros,finish_token_hash)
 values(v_user,p_channel,v_day,v_month,nullif(btrim(p_question_excerpt),''),p_reserve_usd_micros,encode(sha256(convert_to(v_token,'UTF8')),'hex'))
 returning id into v_id;
 return query select v_id,v_token,v_used+1,s.daily_request_limit;
end$$;

create or replace function public.agent_finish_run(
 p_run_id uuid,p_finish_token text,p_status text,p_error_code text,p_refund boolean,
 p_provider text,p_model text,p_steps integer,p_tool_calls integer,
 p_input_tokens integer,p_output_tokens integer,p_actual_usd_micros bigint,p_tools jsonb
) returns void
language plpgsql security definer set search_path='' as $$
declare r public.agent_runs%rowtype;
begin
 select * into r from public.agent_runs where id=p_run_id for update;
 if not found or r.user_id is distinct from (select auth.uid()) or r.status<>'running'
    or r.finish_token_hash<>encode(sha256(convert_to(coalesce(p_finish_token,''),'UTF8')),'hex') then
  raise exception 'AGENT_RUN_NOT_FOUND' using errcode='42501';
 end if;
 if p_status not in ('completed','failed','rejected') or (coalesce(p_refund,false) and p_status='completed')
    or least(coalesce(p_steps,0),coalesce(p_tool_calls,0),coalesce(p_input_tokens,0),coalesce(p_output_tokens,0))<0
    or coalesce(p_actual_usd_micros,0)<0
    or (p_tools is not null and jsonb_typeof(p_tools)<>'array') then
  raise exception 'AGENT_BAD_REQUEST' using errcode='22023';
 end if;
 if coalesce(p_refund,false) then
  update public.agent_usage_days set requests_used=greatest(requests_used-1,0),requests_refunded=requests_refunded+1,updated_at=now()
  where user_id=r.user_id and usage_date=r.usage_date;
 end if;
 -- Tokens and money that the provider actually charged are recorded even for refunded runs.
 update public.agent_budget_months set spent_usd_micros=spent_usd_micros+coalesce(p_actual_usd_micros,0),
  input_tokens=input_tokens+coalesce(p_input_tokens,0),output_tokens=output_tokens+coalesce(p_output_tokens,0),updated_at=now()
 where budget_month=r.budget_month;
 update public.agent_runs set status=p_status,error_code=p_error_code,request_refunded=coalesce(p_refund,false),
  provider=p_provider,model=p_model,steps=coalesce(p_steps,0),tool_calls=coalesce(p_tool_calls,0),
  input_tokens=coalesce(p_input_tokens,0),output_tokens=coalesce(p_output_tokens,0),
  actual_usd_micros=coalesce(p_actual_usd_micros,0),tools=coalesce(p_tools,'[]'::jsonb),finished_at=now()
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
 'public.agent_reserve_run(text,text,bigint)',
 'public.agent_finish_run(uuid,text,text,text,boolean,text,text,integer,integer,integer,integer,bigint,jsonb)',
 'public.my_agent_usage()'
] loop execute format('revoke all on function %s from public,anon,authenticated,service_role',f);execute format('grant execute on function %s to authenticated',f);end loop;end$$;

comment on table public.agent_runs is 'Assistant run trace: masked excerpt, tool names, safe parameters, usage, error code. No full questions, answers or tool results.';
comment on table public.agent_settings is 'Single row: daily request limit and monthly assistant budget. Changed only from the SQL editor by an administrator.';
