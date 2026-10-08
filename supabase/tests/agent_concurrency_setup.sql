-- Fixture for the concurrent daily-limit check in scripts/test-db.sh (committed, not rolled back).
\set ON_ERROR_STOP 1
insert into auth.users(id,email,raw_user_meta_data) values
 ('ac000000-0000-4000-8000-000000000001','agent-parallel@test.local','{"full_name":"Параллельный сотрудник"}')
on conflict do nothing;
insert into public.user_roles(user_id,role_id)
select 'ac000000-0000-4000-8000-000000000001',id from public.app_roles where code='logistics_specialist'
on conflict do nothing;
update public.agent_settings set daily_request_limit=20,monthly_budget_usd_micros=1000000000,max_run_reserve_usd_micros=100000;
