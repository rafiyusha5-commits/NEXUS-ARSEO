-- Verifies that racing settlement and late finishes count every abandoned run's money exactly once.
\set ON_ERROR_STOP 1
select set_config('tests.agent_finished',:'finished',false),set_config('tests.agent_reserved',:'reserved',false);
do $$
declare v_finished int:=current_setting('tests.agent_finished')::int;v_reserved int:=current_setting('tests.agent_reserved')::int;
begin
 assert v_finished=10,format('every late finish is accepted once, got %s',v_finished);
 assert v_reserved=10,format('every parallel reservation succeeds, got %s',v_reserved);
 assert (select count(*) from public.agent_runs r join tests.agent_stale s on s.run_id=r.id
   where r.status='failed' and r.actual_usd_micros=300 and r.cost_status in ('actual','reconciled'))=10,'each abandoned run ends with its reported usage';
 assert (select spent_usd_micros from public.agent_budget_months where budget_month=date_trunc('month',(now() at time zone 'Asia/Aqtobe'))::date)
   =(select spent from tests.agent_settle_before)+10*300,'the monthly spend counts each run once, whichever came first';
 assert (select input_tokens from public.agent_budget_months where budget_month=date_trunc('month',(now() at time zone 'Asia/Aqtobe'))::date)
   =(select input_tokens from tests.agent_settle_before)+10*50,'tokens are counted once';
end$$;
