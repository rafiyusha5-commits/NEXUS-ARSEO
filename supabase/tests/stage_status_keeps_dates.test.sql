-- 202611220100: saving a completed stage again keeps its completion date; a save that changes nothing writes no
-- history; other changes behave as before. Synthetic data only; rolled back.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('ae100000-0000-4000-8000-000000000001','stage-dates@example.invalid','{"full_name":"Stage dates director"}');
insert into public.user_roles(user_id,role_id) select 'ae100000-0000-4000-8000-000000000001',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id)
values('ae110000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Stage dates supplier','TR','AE1-TR');
create temporary table sd(name text primary key,id uuid);
grant select,insert on sd to authenticated;
create function pg_temp.run() returns public.shipment_stage_runs language sql stable security definer as $$
 select * from public.shipment_stage_runs where id=(select id from sd where name='run') $$;
create function pg_temp.history() returns bigint language sql stable security definer as $$
 select count(*) from public.shipment_stage_history where stage_run_id=(select id from sd where name='run') $$;
grant execute on all functions in schema pg_temp to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub','ae100000-0000-4000-8000-000000000001',true);
insert into sd select 'shipment',public.create_shipment_with_stages('STAGE-DATES-1','import','ae110000-0000-4000-8000-000000000001',null,
 (select id from public.routes limit 1),(select id from public.currencies where code='EUR'),(select id from public.warehouses where code='AKT'),
 'ae100000-0000-4000-8000-000000000001');
insert into sd select 'run',r.id from public.shipment_stage_runs r join public.shipment_stages st on st.id=r.stage_id
 where r.shipment_id=(select id from sd where name='shipment') order by st.sequence_order limit 1;
select public.change_shipment_stage_status((select id from sd where name='run'),'completed');
reset role;

-- The stage was really completed on 15.10 (as a date correction would set it).
update public.shipment_stage_runs set completed_at='2026-10-15 12:00+05' where id=(select id from sd where name='run');
create temporary table before_history as select pg_temp.history() as n;

-- 1. Saving the stage list again: same status, no reason — nothing changes, no history entry.
set role authenticated;
select public.change_shipment_stage_status((select id from sd where name='run'),'completed');
reset role;
do $$begin
 assert (pg_temp.run()).completed_at='2026-10-15 12:00+05','the completion date is kept';
 assert pg_temp.history()=(select n from before_history),'an unchanged save writes no history';
end $$;

-- 2. Completed again with a reason: the reason is recorded, the date still kept.
set role authenticated;
select public.change_shipment_stage_status((select id from sd where name='run'),'completed','По CMR','Склад Актобе');
reset role;
do $$begin
 assert (pg_temp.run()).completed_at='2026-10-15 12:00+05','a new reason does not move the date';
 assert (pg_temp.run()).status_reason='По CMR' and (pg_temp.run()).performed_by_name='Склад Актобе';
 assert pg_temp.history()=(select n from before_history)+1,'the change of reason is in the history';
end $$;

-- 3. Reopened and completed again: as before, the date is cleared and then set anew.
set role authenticated;
select public.change_shipment_stage_status((select id from sd where name='run'),'in_progress');
reset role;
do $$begin
 assert (pg_temp.run()).completed_at is null and (pg_temp.run()).status='in_progress','reopening clears the date';
end $$;
set role authenticated;
select public.change_shipment_stage_status((select id from sd where name='run'),'completed');
reset role;
do $$begin
 assert (pg_temp.run()).completed_at = now(),'a stage completed anew gets the current date';
 assert pg_temp.history()=(select n from before_history)+3;
 assert not has_function_privilege('anon','public.change_shipment_stage_status(uuid,text,text,text)','execute');
end $$;
\echo stage_status_keeps_dates: all checks passed
rollback;
