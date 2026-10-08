-- Fixture for the concurrent settlement check in scripts/test-db.sh: ten abandoned runs (older than
-- the TTL) whose late finishes race with new reservations that settle abandoned runs.
\set ON_ERROR_STOP 1
update public.agent_settings set daily_request_limit=1000,monthly_budget_usd_micros=1000000000000,max_run_reserve_usd_micros=100000;
-- Runs left open by the earlier phases are finished so that only the fixture runs are abandoned here.
update public.agent_runs set status='failed',error_code='AGENT_INTERNAL_ERROR',cost_status='actual',finished_at=now() where status='running';
create schema if not exists tests;
drop table if exists tests.agent_stale;
create table tests.agent_stale(n int primary key,run_id uuid,token text);
grant usage on schema tests to authenticated;
grant select,insert on tests.agent_stale to authenticated;
set role authenticated;
select set_config('request.jwt.claim.sub','ac000000-0000-4000-8000-000000000001',false);
insert into tests.agent_stale select g,r.run_id,r.finish_token from generate_series(1,10) g
 cross join lateral public.agent_reserve_run('web','stale '||g,1000) r;
reset role;
revoke insert on tests.agent_stale from authenticated;
update public.agent_runs set created_at=now()-interval '2 hours' where id in (select run_id from tests.agent_stale);
drop table if exists tests.agent_settle_before;
create table tests.agent_settle_before as
 select spent_usd_micros spent,input_tokens from public.agent_budget_months
 where budget_month=date_trunc('month',(now() at time zone 'Asia/Aqtobe'))::date;
