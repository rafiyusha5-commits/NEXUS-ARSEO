-- Fixture for the concurrent monthly-budget check in scripts/test-db.sh (runs after the daily-limit check).
\set ON_ERROR_STOP 1
update public.agent_settings set daily_request_limit=1000,max_run_reserve_usd_micros=100000,
 monthly_budget_usd_micros=(select coalesce(sum(spent_usd_micros),0) from public.agent_budget_months
   where budget_month=date_trunc('month',(now() at time zone 'Asia/Aqtobe'))::date)
  +(select coalesce(sum(reserved_usd_micros),0) from public.agent_runs where status='running'
   and budget_month=date_trunc('month',(now() at time zone 'Asia/Aqtobe'))::date and created_at>=now()-interval '600 seconds')
  +7000;
