-- Telegram reliability and the accounting contract of voice and date search.
-- Idempotent: functions are replaced, columns and constraints are added only when missing.

-- 1. The trace and error codes the runner actually produces. Before this migration a voice question
--    (trace entry speech_to_text, error AGENT_SPEECH_ERROR, rejected transcript QUESTION_*) and a
--    date search (params date, date_kind) were refused by agent_finish_run with AGENT_BAD_REQUEST:
--    the run stayed open, its real usage was lost and the TTL charged the whole reservation.
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
       'list_delayed_shipments','get_stock_status','get_my_tasks','get_help','speech_to_text','unknown')
     or (e->>'rows') !~ '^(100|[0-9]{1,2})$' or (e->>'ms') !~ '^(120000|1[01][0-9]{4}|[0-9]{1,5})$'
     or (e ? 'error' and (jsonb_typeof(e->'error')<>'string' or (e->>'error') not in
       ('TOOL_CALL_LIMIT','UNKNOWN_TOOL','INVALID_PARAMS','PERMISSION_DENIED','TOOL_TIMEOUT','TOOL_ERROR'))) then
   raise exception 'AGENT_BAD_REQUEST' using errcode='22023';
  end if;
  params:='{}'::jsonb;
  for k,v in select * from jsonb_each(e->'params') loop
   if k in ('query','product_query') and jsonb_typeof(v)='string' then
    params:=params||jsonb_build_object(k,coalesce(private.agent_clean_text(v#>>'{}',60),''));
   elsif k in ('status','type','filter','topic','date_kind') and jsonb_typeof(v)='string' and (v#>>'{}') ~ '^[a-z_]{1,30}$' then
    params:=params||jsonb_build_object(k,v);
   elsif k='warehouse_code' and jsonb_typeof(v)='string' and (v#>>'{}') ~ '^[A-Z_]{2,20}$' then
    params:=params||jsonb_build_object(k,v);
   elsif k='date' and jsonb_typeof(v)='string' and (v#>>'{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    params:=params||jsonb_build_object(k,v);
   elsif k='duration_seconds' and jsonb_typeof(v)='number' and (v#>>'{}') ~ '^([0-9]|[1-5][0-9]|60)(\.[0-9])?$' then
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
      'AGENT_STEP_LIMIT','AGENT_BAD_ANSWER','AGENT_INTERNAL_ERROR','AGENT_FORBIDDEN',
      'AGENT_SPEECH_ERROR','QUESTION_EMPTY','QUESTION_TOO_LONG','QUESTION_UNSAFE'))
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
revoke all on function public.agent_finish_run(uuid,uuid,text,text,text,boolean,text,text,integer,integer,integer,integer,bigint,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.agent_finish_run(uuid,uuid,text,text,text,boolean,text,text,integer,integer,integer,integer,bigint,jsonb) to service_role;

-- 2. Visible processing state of Telegram updates. No question, transcript or answer is stored.
alter table public.telegram_updates add column if not exists user_id uuid references public.profiles(id) on delete set null;
alter table public.telegram_updates add column if not exists run_id uuid references public.agent_runs(id) on delete set null;
alter table public.telegram_updates add column if not exists stage text not null default 'received';
alter table public.telegram_updates add column if not exists error_code text;
alter table public.telegram_updates add column if not exists updated_at timestamptz not null default now();
alter table public.telegram_updates drop constraint if exists telegram_updates_status_check;
alter table public.telegram_updates add constraint telegram_updates_status_check
 check(status in ('processing','delivery_started','completed','failed','delivery_unknown'));
do $$begin
 if not exists(select 1 from pg_constraint where conname='telegram_updates_stage_check' and conrelid='public.telegram_updates'::regclass) then
  alter table public.telegram_updates add constraint telegram_updates_stage_check
   check(stage in ('received','session','speech','model','access_check','sending','done'));
 end if;
 if not exists(select 1 from pg_constraint where conname='telegram_updates_error_code_check' and conrelid='public.telegram_updates'::regclass) then
  alter table public.telegram_updates add constraint telegram_updates_error_code_check
   check(error_code is null or error_code ~ '^[A-Z][A-Z_]{1,63}$');
 end if;
end$$;
create index if not exists telegram_updates_user_created_idx on public.telegram_updates(user_id,created_at desc);
create index if not exists telegram_updates_open_idx on public.telegram_updates(updated_at) where status in ('processing','delivery_started');

grant select(update_id,user_id,run_id,status,stage,error_code,created_at,updated_at,finished_at) on public.telegram_updates to authenticated;
drop policy if exists "own or trace viewers read Telegram updates" on public.telegram_updates;
create policy "own or trace viewers read Telegram updates" on public.telegram_updates for select to authenticated
 using((user_id=(select auth.uid()) and (select private.has_permission('agent.use'))) or (select private.has_permission('agent.view_traces')));

-- Progress while processing: the stage, the employee, the accounting run and a safe error code.
-- Only the claim holder, and only before the final state.
create or replace function public.telegram_update_progress(p_update_id bigint,p_token text,p_stage text,p_user_id uuid,p_run_id uuid,p_error_code text)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_updated bigint;
begin
 if p_stage is null or p_stage not in ('session','speech','model','access_check','sending')
    or (p_error_code is not null and p_error_code !~ '^[A-Z][A-Z_]{1,63}$') then return false;end if;
 update public.telegram_updates set stage=p_stage,user_id=coalesce(p_user_id,user_id),run_id=coalesce(p_run_id,run_id),
  error_code=coalesce(p_error_code,error_code),updated_at=now()
 where update_id=p_update_id and claim_hash=encode(sha256(convert_to(coalesce(p_token,''),'UTF8')),'hex')
  and status in ('processing','delivery_started')
  and (p_run_id is null or exists(select 1 from public.agent_runs r where r.id=p_run_id and r.user_id=coalesce(p_user_id,telegram_updates.user_id)));
 get diagnostics v_updated=row_count;
 return v_updated=1;
end$$;

-- Final states. delivery_started is the point of no return: from there only completed (Telegram
-- confirmed), failed (Telegram refused, nothing delivered) or delivery_unknown (no answer from
-- Telegram) are possible. Nothing is ever retried automatically.
-- Same signature as in 202609275300; re-apply this migration after re-running 5300.
create or replace function public.telegram_update_status(p_update_id bigint,p_token text,p_status text)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_updated bigint;
begin
 if p_status is null or p_status not in ('completed','failed','delivery_started','delivery_unknown') then return false;end if;
 update public.telegram_updates set status=p_status,
  stage=case when p_status='delivery_started' then 'sending' else 'done' end,updated_at=now(),
  finished_at=case when p_status='delivery_started' then null else now() end
 where update_id=p_update_id and claim_hash=encode(sha256(convert_to(coalesce(p_token,''),'UTF8')),'hex')
  and ((status='processing' and p_status in ('delivery_started','failed'))
   or (status='delivery_started' and p_status in ('completed','failed','delivery_unknown')));
 get diagnostics v_updated=row_count;
 return v_updated=1;
end$$;

do $$declare f text;begin foreach f in array array[
 'public.telegram_update_progress(bigint,text,text,uuid,uuid,text)','public.telegram_update_status(bigint,text,text)'
] loop execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 execute format('grant execute on function %s to service_role',f);end loop;end$$;

comment on table public.telegram_updates is 'Telegram update deduplication and processing state: stage, employee, accounting run and error code. No question, transcript or answer text.';
