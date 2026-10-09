-- Telegram reliability: accounting of voice and date search, update state transitions and visibility.
\set ON_ERROR_STOP 1
begin;
create schema if not exists tests;
create or replace function tests.tg_expect_error(p_sql text,p_pattern text) returns void language plpgsql as $$begin
 execute p_sql;raise exception 'expected error but statement succeeded: %',p_sql using errcode='P0099';
exception when sqlstate 'P0099' then raise;when others then if sqlerrm!~p_pattern then raise exception 'expected %, got %',p_pattern,sqlerrm using errcode='P0099';end if;end$$;
grant usage on schema tests to authenticated,service_role;
grant execute on function tests.tg_expect_error(text,text) to authenticated,service_role;

insert into auth.users(id,email,raw_user_meta_data) values
 ('bf540000-0000-4000-8000-000000000001','tgr-employee@test.local','{"full_name":"Telegram employee"}'),
 ('bf540000-0000-4000-8000-000000000002','tgr-other@test.local','{"full_name":"Other employee"}'),
 ('bf540000-0000-4000-8000-000000000003','tgr-admin@test.local','{"full_name":"Trace viewer"}');
insert into public.user_roles(user_id,role_id) select u.id::uuid,r.id from (values
 ('bf540000-0000-4000-8000-000000000001','logistics_specialist'),('bf540000-0000-4000-8000-000000000002','logistics_specialist'),
 ('bf540000-0000-4000-8000-000000000003','administrator'))u(id,code) join public.app_roles r on r.code=u.code;
update public.agent_settings set daily_request_limit=20,monthly_budget_usd_micros=100000000,max_run_reserve_usd_micros=300000;

do $$begin
 assert not has_function_privilege('authenticated','public.telegram_update_progress(bigint,text,text,uuid,uuid,text)','execute')
  and not has_function_privilege('authenticated','public.telegram_update_status(bigint,text,text)','execute'),'employees cannot change update state';
 assert has_function_privilege('service_role','public.telegram_update_progress(bigint,text,text,uuid,uuid,text)','execute'),'server records progress';
 assert not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='telegram_update_status' and p.pronargs<>3),
  'one status function only';
 -- The table never holds texts: no question, transcript or answer column exists.
 assert (select array_agg(column_name::text order by column_name::text) from information_schema.columns where table_schema='public' and table_name='telegram_updates')
  =array['chat_id','claim_hash','created_at','error_code','finished_at','run_id','stage','status','update_id','updated_at','user_id'],'only state columns';
 assert not has_column_privilege('authenticated','public.telegram_updates','claim_hash','select') and not has_column_privilege('authenticated','public.telegram_updates','chat_id','select'),
  'claim hash and chat id are not readable';
end$$;

-- 1. Voice and date search close their runs: before 5400 the database refused these traces.
create temp table tg_runs(n int,run_id uuid,token text);
grant all on tg_runs to service_role;
set local role service_role;
insert into tg_runs select 1,r.run_id,r.finish_token from public.agent_reserve_run('bf540000-0000-4000-8000-000000000001','telegram','Голосовой вопрос Telegram',272000) r;
insert into tg_runs select 2,r.run_id,r.finish_token from public.agent_reserve_run('bf540000-0000-4000-8000-000000000001','telegram','Голосовой вопрос Telegram',272000) r;
insert into tg_runs select 3,r.run_id,r.finish_token from public.agent_reserve_run('bf540000-0000-4000-8000-000000000001','telegram','Голосовой вопрос Telegram',272000) r;
select public.agent_finish_run('bf540000-0000-4000-8000-000000000001',(select run_id from tg_runs where n=1),(select token from tg_runs where n=1),
 'completed',null,false,'openai','gpt-5.6-terra',2,1,2500,250,7225,
 '[{"name":"speech_to_text","params":{"duration_seconds":9},"rows":0,"truncated":false,"ms":0},
   {"name":"find_shipments","params":{"date":"2026-10-15","date_kind":"any","limit":10},"rows":2,"truncated":false,"ms":40}]');
select public.agent_finish_run('bf540000-0000-4000-8000-000000000001',(select run_id from tg_runs where n=2),(select token from tg_runs where n=2),
 'failed','AGENT_SPEECH_ERROR',true,'openai','gpt-5.6-terra',0,0,0,0,20000,'[]');
select public.agent_finish_run('bf540000-0000-4000-8000-000000000001',(select run_id from tg_runs where n=3),(select token from tg_runs where n=3),
 'failed','QUESTION_UNSAFE',true,'openai','gpt-5.6-terra',0,0,0,0,225,'[{"name":"speech_to_text","params":{"duration_seconds":59.9},"rows":0,"truncated":false,"ms":0}]');
-- The voice trace keeps its fixed shape.
insert into tg_runs select 4,r.run_id,r.finish_token from public.agent_reserve_run('bf540000-0000-4000-8000-000000000001','telegram',null,272000) r;
select tests.tg_expect_error(format($q$select public.agent_finish_run('bf540000-0000-4000-8000-000000000001',%L,%L,'completed',null,false,'openai','m',0,0,0,0,0,
 '[{"name":"speech_to_text","params":{"duration_seconds":61},"rows":0,"truncated":false,"ms":0}]')$q$,(select run_id from tg_runs where n=4),(select token from tg_runs where n=4)),'AGENT_BAD_REQUEST');
select tests.tg_expect_error(format($q$select public.agent_finish_run('bf540000-0000-4000-8000-000000000001',%L,%L,'completed',null,false,'openai','m',0,0,0,0,0,
 '[{"name":"find_shipments","params":{"date":"15.10.2026"},"rows":0,"truncated":false,"ms":0}]')$q$,(select run_id from tg_runs where n=4),(select token from tg_runs where n=4)),'AGENT_BAD_REQUEST');
select tests.tg_expect_error(format($q$select public.agent_finish_run('bf540000-0000-4000-8000-000000000001',%L,%L,'failed','AGENT_SPEECH_ERROR_900101300123',true,'openai','m',0,0,0,0,0,'[]')$q$,
 (select run_id from tg_runs where n=4),(select token from tg_runs where n=4)),'AGENT_BAD_REQUEST');
reset role;
do $$begin
 assert (select count(*) from public.agent_runs r join tg_runs t on t.run_id=r.id where t.n<=3 and r.cost_status='actual')=3,'voice and date-search runs are closed with their real usage';
 assert (select actual_usd_micros=7225 and tools->0->'params'->>'duration_seconds'='9' and tools->1->'params'->>'date'='2026-10-15' from public.agent_runs where id=(select run_id from tg_runs where n=1)),'trace stored';
 assert (select request_refunded and actual_usd_micros=20000 from public.agent_runs where id=(select run_id from tg_runs where n=2)),'failed speech: question returned, cost kept';
 assert (select requests_used from public.agent_usage_days where user_id='bf540000-0000-4000-8000-000000000001')=2,'four reserved, two returned';
end$$;

-- 2. Update state: progress, the point of no return and final states.
set local role service_role;
select public.telegram_claim_update(5001,700001) as t1 \gset
select public.telegram_claim_update(5002,700001) as t2 \gset
select public.telegram_claim_update(5003,700002) as t3 \gset
do $$begin assert public.telegram_claim_update(5001,700001) is null,'a repeated delivery is never claimed twice';end$$;
select set_config('tests.t1',:'t1',true),set_config('tests.t2',:'t2',true),set_config('tests.t3',:'t3',true);
do $$
declare t1 text:=current_setting('tests.t1');t2 text:=current_setting('tests.t2');t3 text:=current_setting('tests.t3');
 v_run uuid:=(select run_id from tg_runs where n=1);v_other uuid:=(select run_id from tg_runs where n=4);
begin
 assert public.telegram_update_progress(5001,t1,'session','bf540000-0000-4000-8000-000000000001',null,null),'session stage';
 assert public.telegram_update_progress(5001,t1,'model',null,v_run,null),'run attached';
 assert not public.telegram_update_progress(5001,'wrong','model',null,null,null),'only the claim holder';
 assert not public.telegram_update_progress(5001,t1,'done',null,null,null),'final stage only through status';
 assert not public.telegram_update_progress(5001,t1,'model',null,null,'Иванов 900101300123'),'error codes are codes, not text';
 assert not public.telegram_update_status(5001,t1,'completed'),'no completion without the delivery mark';
 assert public.telegram_update_status(5001,t1,'delivery_started'),'point of no return';
 assert not public.telegram_update_status(5001,t1,'delivery_started'),'the mark is set once: no second sending';
 assert public.telegram_update_progress(5001,t1,'sending',null,null,'TELEGRAM_UNAVAILABLE'),'error code while sending';
 assert public.telegram_update_status(5001,t1,'delivery_unknown'),'unknown delivery is recorded';
 assert not public.telegram_update_status(5001,t1,'completed') and not public.telegram_update_status(5001,t1,'failed'),'final state stays';
 assert not public.telegram_update_progress(5001,t1,'sending',null,null,'TELEGRAM_REJECTED'),'no progress after the final state';
 -- A run of another employee cannot be attached to this update.
 assert public.telegram_update_progress(5002,t2,'session','bf540000-0000-4000-8000-000000000002',null,null);
 assert not public.telegram_update_progress(5002,t2,'model',null,v_run,null),'foreign run refused';
 assert public.telegram_update_status(5002,t2,'failed'),'failure before delivery';
 assert public.telegram_update_progress(5003,t3,'session','bf540000-0000-4000-8000-000000000001',null,null);
 assert public.telegram_update_progress(5003,t3,'model',null,v_other,null);
end$$;
reset role;
do $$begin
 assert (select status='delivery_unknown' and stage='done' and error_code='TELEGRAM_UNAVAILABLE' and run_id is not null and finished_at is not null
   from public.telegram_updates where update_id=5001),'delivery_unknown with its run';
 assert (select status='processing' and stage='model' and finished_at is null from public.telegram_updates where update_id=5003),'an interrupted update stays visible as processing';
end$$;

-- 3. Visibility: own updates, all for trace viewers, nothing for others.
set local role authenticated;
select set_config('request.jwt.claim.sub','bf540000-0000-4000-8000-000000000001',true);
do $$begin
 assert (select count(*) from public.telegram_updates)=2,'employee sees own updates';
 assert (select stage from public.telegram_updates where update_id=5003)='model','with stage';
end$$;
select set_config('request.jwt.claim.sub','bf540000-0000-4000-8000-000000000002',true);
do $$begin assert (select count(*) from public.telegram_updates)=1,'another employee sees only own';end$$;
select set_config('request.jwt.claim.sub','bf540000-0000-4000-8000-000000000003',true);
do $$begin assert (select count(*) from public.telegram_updates where update_id in (5001,5002,5003))=3,'trace viewer sees all';end$$;
select tests.tg_expect_error($q$update public.telegram_updates set status='completed'$q$,'permission denied');
reset role;
rollback;
