-- Reapplying an older migration to a current database must not undo the business timezone.
-- The migration commits its own transaction, so intentionally do not wrap this test in BEGIN.
\set ON_ERROR_STOP 1
create temporary table number_reapply_snapshot as
select p.oid, p.proacl, p.proowner, p.prosecdef,
 (select count(*) from public.shipments) as shipments,
 (select count(*) from public.shipment_stage_runs) as stages
from pg_proc p where p.oid='public.create_shipment_with_stages(text,text,uuid,uuid,uuid,uuid,uuid,uuid,date,date)'::regprocedure;

-- Simulate the setting already present on a database upgraded past 202609278300.
alter function public.create_shipment_with_stages(text,text,uuid,uuid,uuid,uuid,uuid,uuid,date,date)
 set timezone to 'Asia/Almaty';
\ir ../migrations/202609276800_shipment_number_generation.sql
\ir ../migrations/202609276800_shipment_number_generation.sql

do $$ declare old record; current_function record; begin
 select * into strict old from number_reapply_snapshot;
 select * into strict current_function from pg_proc where oid=old.oid;
 assert exists(select 1 from unnest(current_function.proconfig) c where lower(c)='timezone=asia/almaty'),
   'numbering migration must preserve Kazakhstan business timezone on repeat/upgrade';
 assert current_function.proacl is not distinct from old.proacl, 'EXECUTE grants must not change';
 assert current_function.proowner=old.proowner and current_function.prosecdef=old.prosecdef,
   'owner and security mode must not change';
 assert exists(select 1 from unnest(current_function.proconfig) c where c='search_path=""'),
   'empty search path must remain enforced';
 assert (select count(*) from public.shipments)=old.shipments, 'migration must not create or remove shipments';
 assert (select count(*) from public.shipment_stage_runs)=old.stages, 'migration must not create or remove stages';
end $$;
drop table number_reapply_snapshot;
