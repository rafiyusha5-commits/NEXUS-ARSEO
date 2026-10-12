-- Verifies the outcome of 30 parallel reservations by one employee (see scripts/test-db.sh).
\set ON_ERROR_STOP 1
select set_config('tests.agent_granted',:'granted',false),set_config('tests.agent_limited',:'limited',false);
do $$
declare v_granted int:=current_setting('tests.agent_granted')::int;v_limited int:=current_setting('tests.agent_limited')::int;
begin
 assert v_granted=20,format('exactly the daily limit of parallel requests is granted, got %s',v_granted);
 assert v_limited=10,format('the remaining parallel requests hit the daily limit, got %s',v_limited);
 assert (select requests_used from public.agent_usage_days where user_id='ac000000-0000-4000-8000-000000000001')=20,'the counter equals the granted runs';
 assert (select count(*) from public.agent_runs where user_id='ac000000-0000-4000-8000-000000000001' and status='running')=20,'one run per granted request';
end$$;
\echo 'agent concurrency: 20 of 30 parallel requests granted'
