-- Assistant permissions, atomic daily limit, monthly budget, finish token and trace visibility.
\set ON_ERROR_STOP 1
begin;

create schema if not exists tests;
create or replace function tests.agent_expect_error(p_sql text,p_pattern text) returns void language plpgsql as $$begin
 execute p_sql;raise exception 'expected error but statement succeeded: %',p_sql using errcode='P0099';
exception when sqlstate 'P0099' then raise;when others then if sqlerrm!~p_pattern then raise exception 'expected %, got %',p_pattern,sqlerrm using errcode='P0099';end if;end$$;
grant usage on schema tests to authenticated;
grant execute on function tests.agent_expect_error(text,text) to authenticated;

-- Grants: every internal role uses the assistant, only the administrator reads other traces.
do $$begin
 assert (select array_agg(r.code order by r.code) from public.role_permissions rp join public.app_roles r on r.id=rp.role_id
   join public.permissions p on p.id=rp.permission_id where p.code='agent.use' and rp.granted)
  =(select array_agg(code order by code) from public.app_roles where audience='internal'),'agent.use is granted to exactly the internal roles';
 assert (select array_agg(r.code) from public.role_permissions rp join public.app_roles r on r.id=rp.role_id
   join public.permissions p on p.id=rp.permission_id where p.code='agent.view_traces' and rp.granted)=array['administrator'],
  'agent.view_traces is granted to the administrator only';
 assert not exists(select 1 from public.role_permissions rp join public.app_roles r on r.id=rp.role_id
   join public.permissions p on p.id=rp.permission_id where p.code like 'agent.%' and r.audience<>'internal'),'no external role holds agent permissions';
 assert (select daily_request_limit from public.agent_settings)=20,'default daily limit is 20';
 assert (select monthly_budget_usd_micros=0 and max_run_reserve_usd_micros=0 from public.agent_settings),'no money budget until the owner sets one';
 assert not has_column_privilege('authenticated','public.agent_runs','finish_token_hash','select'),'the finish token hash is not readable';
 assert not has_table_privilege('authenticated','public.agent_runs','insert') and not has_table_privilege('authenticated','public.agent_runs','update')
  and not has_table_privilege('authenticated','public.agent_usage_days','update') and not has_table_privilege('authenticated','public.agent_settings','update'),
  'assistant tables are written only through the RPCs';
 assert not has_function_privilege('anon','public.agent_reserve_run(text,text,bigint)','execute'),'anonymous cannot reserve';
 assert (select relrowsecurity from pg_class where oid='public.agent_runs'::regclass),'agent_runs has RLS';
end$$;

insert into auth.users(id,email,raw_user_meta_data) values
 ('aa000000-0000-4000-8000-000000000001','agent-admin@test.local','{"full_name":"Администратор"}'),
 ('aa000000-0000-4000-8000-000000000002','agent-spec@test.local','{"full_name":"Специалист"}'),
 ('aa000000-0000-4000-8000-000000000003','agent-mkt@test.local','{"full_name":"Маркетолог"}'),
 ('aa000000-0000-4000-8000-000000000004','agent-client@test.local','{"full_name":"Клиент"}'),
 ('aa000000-0000-4000-8000-000000000005','agent-denied@test.local','{"full_name":"Директор под запретом"}');
insert into public.user_roles(user_id,role_id) select u.id::uuid,r.id from (values
 ('aa000000-0000-4000-8000-000000000001','administrator'),('aa000000-0000-4000-8000-000000000002','logistics_specialist'),
 ('aa000000-0000-4000-8000-000000000003','marketer'),('aa000000-0000-4000-8000-000000000005','director'))u(id,code)
 join public.app_roles r on r.code=u.code;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'aa000000-0000-4000-8000-000000000005',id,'deny','agent test','aa000000-0000-4000-8000-000000000001' from public.permissions where code='agent.use';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values('ab000000-0000-4000-8000-000000000001',array['customer'],'Agent client','KZ','AGENT-C');

set role authenticated;
select set_config('request.jwt.claim.sub','aa000000-0000-4000-8000-000000000001',false);
select public.configure_external_client('aa000000-0000-4000-8000-000000000004','ab000000-0000-4000-8000-000000000001','Клиент',null,'ru',true,true,false);
reset role;

-- Without a money budget nothing is reserved, even with the daily limit available.
set role authenticated;
select set_config('request.jwt.claim.sub','aa000000-0000-4000-8000-000000000002',false);
select tests.agent_expect_error($q$select * from public.agent_reserve_run('web',null,1000)$q$,'AGENT_RUN_BUDGET_EXCEEDED');
reset role;
update public.agent_settings set monthly_budget_usd_micros=50000,max_run_reserve_usd_micros=2000;

set role authenticated;
-- External accounts and a personal deny of agent.use are refused before any counter moves.
select set_config('request.jwt.claim.sub','aa000000-0000-4000-8000-000000000004',false);
select tests.agent_expect_error($q$select * from public.agent_reserve_run('web',null,1000)$q$,'AGENT_FORBIDDEN');
select tests.agent_expect_error($q$select * from public.my_agent_usage()$q$,'AGENT_FORBIDDEN');
select set_config('request.jwt.claim.sub','aa000000-0000-4000-8000-000000000005',false);
select tests.agent_expect_error($q$select * from public.agent_reserve_run('web',null,1000)$q$,'AGENT_FORBIDDEN');

-- Arguments cannot raise limits: the per-run cap comes from agent_settings.
select set_config('request.jwt.claim.sub','aa000000-0000-4000-8000-000000000002',false);
select tests.agent_expect_error($q$select * from public.agent_reserve_run('web',null,999999)$q$,'AGENT_RUN_BUDGET_EXCEEDED');
select tests.agent_expect_error($q$select * from public.agent_reserve_run('sms',null,1000)$q$,'AGENT_BAD_REQUEST');
select tests.agent_expect_error($q$select * from public.agent_reserve_run('web',repeat('x',201),1000)$q$,'AGENT_BAD_REQUEST');

-- Twenty requests a day per employee; the twenty-first is refused.
create temp table agent_runs_t(n int,run_id uuid,token text);
grant all on agent_runs_t to authenticated;
do $$declare i int;r record;begin
 for i in 1..20 loop
  select * into r from public.agent_reserve_run('web','вопрос '||i,1000);
  insert into agent_runs_t values(i,r.run_id,r.finish_token);
  assert r.requests_used=i and r.request_limit=20,'counter moves by one per request';
 end loop;
end$$;
select tests.agent_expect_error($q$select * from public.agent_reserve_run('web',null,1000)$q$,'AGENT_DAILY_LIMIT');
do $$begin
 assert (select usage_date from public.my_agent_usage())=(now() at time zone 'Asia/Aqtobe')::date,'the day follows Asia/Aqtobe';
 assert (select requests_used from public.my_agent_usage())=20,'usage shows twenty requests';
end$$;

-- The finish token is required, and a run is finished only once and only by its owner.
select tests.agent_expect_error(format($q$select public.agent_finish_run(%L,'wrong','completed',null,false,'fake','m',1,0,10,10,5,'[]')$q$,
 (select run_id from agent_runs_t where n=1)),'AGENT_RUN_NOT_FOUND');
select tests.agent_expect_error(format($q$select public.agent_finish_run(%L,%L,'completed',null,true,'fake','m',1,0,10,10,5,'[]')$q$,
 (select run_id from agent_runs_t where n=1),(select token from agent_runs_t where n=1)),'AGENT_BAD_REQUEST');
select public.agent_finish_run((select run_id from agent_runs_t where n=1),(select token from agent_runs_t where n=1),'completed',null,false,'fake','m',2,1,1200,300,700,
 '[{"name":"find_shipments","params":{"limit":5},"rows":3,"truncated":false,"ms":12}]');
select tests.agent_expect_error(format($q$select public.agent_finish_run(%L,%L,'failed','X',true,'fake','m',1,0,0,0,0,'[]')$q$,
 (select run_id from agent_runs_t where n=1),(select token from agent_runs_t where n=1)),'AGENT_RUN_NOT_FOUND');
select set_config('request.jwt.claim.sub','aa000000-0000-4000-8000-000000000003',false);
select tests.agent_expect_error(format($q$select public.agent_finish_run(%L,%L,'failed','X',true,'fake','m',1,0,0,0,0,'[]')$q$,
 (select run_id from agent_runs_t where n=2),(select token from agent_runs_t where n=2)),'AGENT_RUN_NOT_FOUND');

-- A failed run returns the request to the user but keeps the tokens actually charged.
select set_config('request.jwt.claim.sub','aa000000-0000-4000-8000-000000000002',false);
select public.agent_finish_run((select run_id from agent_runs_t where n=2),(select token from agent_runs_t where n=2),'failed','AGENT_PROVIDER_ERROR',true,'fake','m',1,0,800,0,400,'[]');
do $$begin
 assert (select requests_used from public.my_agent_usage())=19,'a refunded request frees one slot';
 assert (select request_refunded and status='failed' and input_tokens=800 from public.agent_runs where id=(select run_id from agent_runs_t where n=2)),'refunded run keeps its usage';
 assert (select count(*) from public.agent_runs)=20,'the employee sees own runs';
end$$;
select * from public.agent_reserve_run('web',null,1000);

-- Other employees do not see these runs; the administrator does, and the money spent is counted.
select set_config('request.jwt.claim.sub','aa000000-0000-4000-8000-000000000003',false);
do $$begin
 assert (select count(*) from public.agent_runs)=0,'a marketer sees no other traces';
 assert (select count(*) from public.agent_usage_days)=0,'nor other usage';
 assert (select count(*) from public.agent_settings)=0 and (select count(*) from public.agent_budget_months)=0,'settings and budget are administrative';
end$$;
select set_config('request.jwt.claim.sub','aa000000-0000-4000-8000-000000000001',false);
do $$begin
 assert (select count(*) from public.agent_runs where user_id='aa000000-0000-4000-8000-000000000002')=21,'the trace viewer sees other runs';
 assert (select spent_usd_micros=1100 and input_tokens=2000 and output_tokens=300 from public.agent_budget_months),'actual spend and tokens are accumulated';
end$$;

-- The monthly budget counts spend plus active reservations.
reset role;
update public.agent_settings set daily_request_limit=1000,monthly_budget_usd_micros=(select spent_usd_micros from public.agent_budget_months)
 +(select sum(reserved_usd_micros) from public.agent_runs where status='running')+1500;
set role authenticated;
select set_config('request.jwt.claim.sub','aa000000-0000-4000-8000-000000000003',false);
select * from public.agent_reserve_run('web',null,1000);
select tests.agent_expect_error($q$select * from public.agent_reserve_run('web',null,1000)$q$,'AGENT_MONTHLY_BUDGET');
-- Reservations older than the TTL keep holding money: a crashed server may have been billed for them.
reset role;
update public.agent_runs set created_at=now()-interval '2 hours' where status='running';
set role authenticated;
select tests.agent_expect_error($q$select * from public.agent_reserve_run('web',null,1000)$q$,'AGENT_MONTHLY_BUDGET');

-- With room for one more run, the next reservation settles the abandoned runs conservatively: each is
-- charged its whole reservation as an estimate; the employee's request is not returned automatically.
reset role;
create temp table agent_before as
 select (select spent_usd_micros from public.agent_budget_months) spent,
  (select sum(reserved_usd_micros) from public.agent_runs where status='running') held,
  (select count(*) from public.agent_runs where status='running') runs,
  (select requests_used from public.agent_usage_days where user_id='aa000000-0000-4000-8000-000000000002') used;
update public.agent_settings set monthly_budget_usd_micros=(select spent+held+1000 from agent_before);
set role authenticated;
select * from public.agent_reserve_run('web',null,1000);
select tests.agent_expect_error($q$select * from public.agent_reserve_run('web',null,1000)$q$,'AGENT_MONTHLY_BUDGET');
reset role;
do $$begin
 assert (select runs from agent_before)=20,'nineteen runs of the specialist and one of the marketer were open';
 assert (select count(*) from public.agent_runs where error_code='AGENT_ABANDONED' and status='failed' and cost_status='estimated'
   and actual_usd_micros=reserved_usd_micros and finished_at is not null and not request_refunded)=20,'abandoned runs are charged their reservation';
 assert (select spent_usd_micros from public.agent_budget_months)=(select spent+held from agent_before),'the estimate is added to the monthly spend';
 assert (select requests_used from public.agent_usage_days where user_id='aa000000-0000-4000-8000-000000000002')=(select used from agent_before),
  'settling money does not touch the request counter';
 assert (select count(*) from public.agent_runs where status='running')=1,'only the new run is open';
end$$;

-- A late finish replaces the estimate with the reported usage once: the spend moves by the difference.
set role authenticated;
select set_config('request.jwt.claim.sub','aa000000-0000-4000-8000-000000000002',false);
select public.agent_finish_run((select run_id from agent_runs_t where n=3),(select token from agent_runs_t where n=3),
 'failed','AGENT_PROVIDER_ERROR',true,'openai','gpt-4.1-mini',1,0,500,100,300,'[]');
select tests.agent_expect_error(format($q$select public.agent_finish_run(%L,%L,'failed','AGENT_PROVIDER_ERROR',true,'openai','gpt-4.1-mini',1,0,500,100,300,'[]')$q$,
 (select run_id from agent_runs_t where n=3),(select token from agent_runs_t where n=3)),'AGENT_RUN_NOT_FOUND');
select public.agent_finish_run((select run_id from agent_runs_t where n=4),(select token from agent_runs_t where n=4),
 'completed',null,false,'openai','gpt-4.1-mini',2,1,900,200,999999,'[]');
reset role;
do $$begin
 assert (select spent_usd_micros from public.agent_budget_months)=(select spent+held-700 from agent_before),
  'late finish corrects the estimate by the difference only; a repeated or inflated finish adds nothing';
 assert (select input_tokens from public.agent_budget_months)=2000+500+900,'tokens of late finishes are recorded once';
 assert (select status='failed' and error_code='AGENT_PROVIDER_ERROR' and cost_status='reconciled' and actual_usd_micros=300 and request_refunded
   from public.agent_runs where id=(select run_id from agent_runs_t where n=3)),'the reconciled run keeps reported usage';
 assert (select status='completed' and error_code is null and cost_status='reconciled' and actual_usd_micros=1000 and not request_refunded
   from public.agent_runs where id=(select run_id from agent_runs_t where n=4)),'a late completed run stays charged up to its reservation';
 assert (select requests_used from public.agent_usage_days where user_id='aa000000-0000-4000-8000-000000000002')=(select used-1 from agent_before),
  'the request is returned only by the explicit refund of the late finish';
end$$;
-- A normally finished run cannot be reconciled again.
set role authenticated;
select tests.agent_expect_error(format($q$select public.agent_finish_run(%L,%L,'failed','AGENT_PROVIDER_ERROR',true,'openai','m',1,0,0,0,0,'[]')$q$,
 (select run_id from agent_runs_t where n=1),(select token from agent_runs_t where n=1)),'AGENT_RUN_NOT_FOUND');

-- A direct RPC call cannot inflate the shared spend: reported usage is capped by the run's reservation.
reset role;
update public.agent_settings set monthly_budget_usd_micros=1000000000000;
create temp table agent_spent_before as select spent_usd_micros from public.agent_budget_months;
create temp table agent_inflate(run_id uuid,token text);
grant all on agent_inflate to authenticated;
set role authenticated;
select set_config('request.jwt.claim.sub','aa000000-0000-4000-8000-000000000003',false);
insert into agent_inflate select r.run_id,r.finish_token from public.agent_reserve_run('web',null,1000) r;
select public.agent_finish_run((select run_id from agent_inflate),(select token from agent_inflate),'failed','AGENT_PROVIDER_ERROR',true,'fake','m',
 99999,99999,2000000000,2000000000,999999999999999,'[]');
reset role;
do $$begin
 assert (select spent_usd_micros from public.agent_budget_months)=(select spent_usd_micros from agent_spent_before)+1000,'reported spend is capped by the reservation';
 assert (select input_tokens=10000000 and output_tokens=10000000 and steps=50 and tool_calls=100 from public.agent_runs where id=(select run_id from agent_inflate)),'reported counters are bounded';
end$$;
set role authenticated;

select set_config('request.jwt.claim.sub','aa000000-0000-4000-8000-000000000003',false);
-- A direct RPC call cannot store personal data or secrets in the trace excerpt, in any number form.
select public.agent_finish_run(r.run_id,r.finish_token,'rejected',null,true,'fake','m',0,0,0,0,0,'[]')
from public.agent_reserve_run('web','удостоверение 045 678 912, ИИН 900101300123',1000) r;
select public.agent_finish_run(r.run_id,r.finish_token,'rejected',null,true,'fake','m',0,0,0,0,0,'[]')
from public.agent_reserve_run('web',E'номер 0456 78912, 0456.78912, 0456_78912, (701) 555-44-33, ０４５６７８９１２, 0456–78912, password=hunter2 Bearer abc.def eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln sk-proj-abcdefghijklmnopqrstu​',1000) r;
reset role;
do $$begin
 assert not exists(select 1 from public.agent_runs where question_excerpt ~ '[0-9]{3}|[0-9][ ._/()-][0-9]{2}'),'excerpts keep no digit runs';
 assert exists(select 1 from public.agent_runs where question_excerpt like 'удостоверение [скрыто], ИИН [скрыто]'),'the excerpt is masked by the database';
 assert not exists(select 1 from public.agent_runs where question_excerpt ~* 'hunter2|abc\.def|eyJ|sk-proj|​'),'secrets and invisible characters are removed';
end$$;

-- The tool trace is checked field by field; anything outside the fixed shape is refused.
create temp table agent_pii(run_id uuid,token text);
grant all on agent_pii to authenticated;
set role authenticated;
insert into agent_pii select r.run_id,r.finish_token from public.agent_reserve_run('web',null,1000) r;
do $$declare v_sql text:=$f$select public.agent_finish_run(%L,%L,'completed',null,false,%L,%L,1,1,10,10,1,%L::jsonb)$f$;
 bad_tools text[]:=array[
  '{"name":"find_shipments"}',
  '[{"name":"find_shipments","params":{},"rows":1,"truncated":false,"ms":1,"driver_phone":"+77015554433"}]',
  '[{"name":"run_sql","params":{},"rows":1,"truncated":false,"ms":1}]',
  '[{"name":"find_shipments","params":{"driver_name":"Иванов"},"rows":1,"truncated":false,"ms":1}]',
  '[{"name":"find_shipments","params":{"status":"Иванов Иван 900101300123"},"rows":1,"truncated":false,"ms":1}]',
  '[{"name":"find_shipments","params":{"query":{"nested":"x"}},"rows":1,"truncated":false,"ms":1}]',
  '[{"name":"find_shipments","params":{"limit":500},"rows":1,"truncated":false,"ms":1}]',
  '[{"name":"get_shipment","params":{"shipment_id":"900101300123"},"rows":1,"truncated":false,"ms":1}]',
  '[{"name":"find_shipments","params":{},"rows":1000,"truncated":false,"ms":1}]',
  '[{"name":"find_shipments","params":{},"rows":1,"truncated":"no","ms":"1"}]',
  '[{"name":"find_shipments","params":{},"rows":1,"truncated":false,"ms":1,"error":"Водитель 900101300123"}]',
  '[{"name":"find_shipments","params":{},"rows":1,"truncated":false}]',
  (select jsonb_agg('{"name":"get_help","params":{},"rows":1,"truncated":false,"ms":1}'::jsonb)::text from generate_series(1,31))];
 bad_meta text[][]:=array[
  array['openai','gpt 900101300123'],array['openai','model-9001013001'],array['openai',repeat('m',81)],array['openai',''],
  array['OpenAI 900101300123','m'],array['openai; drop','m']];
 t text;i int;
begin
 for i in 1..array_length(bad_tools,1) loop
  perform tests.agent_expect_error(format(v_sql,(select run_id from agent_pii),(select token from agent_pii),'openai','gpt-4.1-mini',bad_tools[i]),'AGENT_BAD_REQUEST');
 end loop;
 for i in 1..array_length(bad_meta,1) loop
  perform tests.agent_expect_error(format(v_sql,(select run_id from agent_pii),(select token from agent_pii),bad_meta[i][1],bad_meta[i][2],'[]'),'AGENT_BAD_REQUEST');
 end loop;
 perform tests.agent_expect_error(format($f$select public.agent_finish_run(%L,%L,'failed','IIN_NINE_ZERO',true,'openai','m',1,1,1,1,1,'[]')$f$,
  (select run_id from agent_pii),(select token from agent_pii)),'AGENT_BAD_REQUEST');
 perform tests.agent_expect_error(format($f$select public.agent_finish_run(%L,%L,'completed','AGENT_TIMEOUT',false,'openai','m',1,1,1,1,1,'[]')$f$,
  (select run_id from agent_pii),(select token from agent_pii)),'AGENT_BAD_REQUEST');
end$$;
select public.agent_finish_run((select run_id from agent_pii),(select token from agent_pii),'completed',null,false,'openai','gpt-4.1-mini',1,2,10,10,1,
 E'[{"name":"find_shipments","params":{"query":"0456 78912 password=hunter2\\u200b","status":"in_transit","limit":5},"rows":1,"truncated":false,"ms":12},{"name":"get_help","params":{"topic":"documents"},"rows":1,"truncated":false,"ms":0,"error":"TOOL_ERROR"}]');
reset role;
do $$begin
 assert (select tools from public.agent_runs where id=(select run_id from agent_pii))=
  '[{"name":"find_shipments","params":{"query":"[скрыто] password=[скрыто]","status":"in_transit","limit":5},"rows":1,"truncated":false,"ms":12},{"name":"get_help","params":{"topic":"documents"},"rows":1,"truncated":false,"ms":0,"error":"TOOL_ERROR"}]'::jsonb,
  'the stored trace is rebuilt from cleaned values only';
 assert (select model='gpt-4.1-mini' and provider='openai' from public.agent_runs where id=(select run_id from agent_pii)),'checked metadata is stored';
end$$;
set role authenticated;

-- No direct writes from the API.
select tests.agent_expect_error($q$update public.agent_usage_days set requests_used=0$q$,'permission denied');
select tests.agent_expect_error($q$insert into public.agent_runs(user_id,channel,usage_date,budget_month,finish_token_hash) values(auth.uid(),'web',current_date,date_trunc('month',current_date)::date,repeat('0',64))$q$,'permission denied');

reset role;
rollback;
select 'agent_assistant: passed' as result;
