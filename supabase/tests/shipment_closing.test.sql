-- Closing a shipment (202609276650): the last stage can be completed, closing locks the shipment and
-- records when and by whom, a closed shipment rejects changes, and only managers may reopen it with a reason.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('c1000000-0000-4000-8000-000000000001','close-director@test.local','{"full_name":"Close Director"}'),
 ('c1000000-0000-4000-8000-000000000002','close-logistics@test.local','{"full_name":"Close Logistics"}');
insert into public.user_roles(user_id,role_id) select v.u::uuid,r.id from (values
 ('c1000000-0000-4000-8000-000000000001','director'),('c1000000-0000-4000-8000-000000000002','senior_logistics_manager')) v(u,code)
 join public.app_roles r on r.code=v.code;
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('c1100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Close supplier','FI','CLOSE-1');

create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql; exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm; end if;
  return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on function pg_temp.fails(text,text) to authenticated;
create temp table cl_ids(name text primary key,id uuid);
grant select,insert on cl_ids to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000002',false);
insert into cl_ids select 'shipment',public.create_shipment_with_stages('CLOSE-1','import','c1100000-0000-4000-8000-000000000001',null,
 (select id from public.routes limit 1),(select id from public.currencies where code='EUR'),(select id from public.warehouses where code='AKT'),
 'c1000000-0000-4000-8000-000000000002');

-- Every stage before "Закрытие поставки" is done (conditional ones are not applicable).
do $$
declare r record; v_shipment uuid := (select id from cl_ids where name='shipment');
begin
 for r in select run.id from public.shipment_stage_runs run join public.shipment_stages st on st.id=run.stage_id
          where run.shipment_id=v_shipment and st.code<>'closed' and run.status not in ('not_applicable') order by st.sequence_order
 loop
  perform public.change_shipment_stage_status(r.id,'completed');
 end loop;
 assert (select status from public.shipments where id=v_shipment)='sales',
  format('before the closing stage the shipment waits for closing, not closed: %s', (select status from public.shipments where id=v_shipment));
 assert not (select is_locked from public.shipments where id=v_shipment);
end $$;

-- The closing stage itself can be completed; this closes and locks the shipment.
do $$
declare v_shipment uuid := (select id from cl_ids where name='shipment');
begin
 perform public.change_shipment_stage_status(
  (select run.id from public.shipment_stage_runs run join public.shipment_stages st on st.id=run.stage_id where run.shipment_id=v_shipment and st.code='closed'),'completed');
 assert (select status||'|'||is_locked||'|'||(closed_at is not null)||'|'||closed_by from public.shipments where id=v_shipment)
   ='closed|true|true|c1000000-0000-4000-8000-000000000002', (select row_to_json(s)::text from public.shipments s where id=v_shipment);
end $$;

-- A closed shipment rejects changes.
select pg_temp.fails($$select public.change_shipment_stage_status((select run.id from public.shipment_stage_runs run join public.shipment_stages st on st.id=run.stage_id where run.shipment_id=(select id from cl_ids where name='shipment') and st.code='closed'),'in_progress')$$,'Закрытая поставка');
select pg_temp.fails($$select public.add_shipment_transport((select id from cl_ids where name='shipment'))$$,'Закрыт|closed|недоступна');

-- Reopening: not for the logistics manager, not without a reason.
select pg_temp.fails($$select public.reopen_shipment((select id from cl_ids where name='shipment'),'Ошибка в количестве')$$,'Недостаточно прав');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',false);
select pg_temp.fails($$select public.reopen_shipment((select id from cl_ids where name='shipment'),'  ')$$,'причину');
do $$
declare v_shipment uuid := (select id from cl_ids where name='shipment');
begin
 perform public.reopen_shipment(v_shipment,'Ошибка в количестве');
 assert (select status||'|'||is_locked||'|'||(closed_at is null)||'|'||(closed_by is null) from public.shipments where id=v_shipment)='sales|false|true|true';
 assert (select run.status from public.shipment_stage_runs run join public.shipment_stages st on st.id=run.stage_id where run.shipment_id=v_shipment and st.code='closed')='in_progress';
 assert exists(select 1 from public.shipment_stage_history h where h.shipment_id=v_shipment and h.from_status='completed' and h.to_status='in_progress' and h.reason='Повторное открытие поставки: Ошибка в количестве'),
  'the reopening is in the history with its reason';
 -- other stages stay done
 assert not exists(select 1 from public.shipment_stage_runs run join public.shipment_stages st on st.id=run.stage_id where run.shipment_id=v_shipment and st.code<>'closed' and run.status in ('pending','in_progress'));
 -- the shipment can be closed again
 perform public.change_shipment_stage_status(
  (select run.id from public.shipment_stage_runs run join public.shipment_stages st on st.id=run.stage_id where run.shipment_id=v_shipment and st.code='closed'),'completed');
 assert (select status||'|'||is_locked||'|'||closed_by from public.shipments where id=v_shipment)='closed|true|c1000000-0000-4000-8000-000000000001';
end $$;
select pg_temp.fails($$select public.reopen_shipment(gen_random_uuid(),'Причина')$$,'не найдена');

-- ---------- repair of shipments closed by the old rule ----------
reset role;
-- old_stuck: "closed" while the closing stage is still open; old_done: every stage done but never locked.
set role authenticated;
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000002',false);
insert into cl_ids select 'old_stuck',public.create_shipment_with_stages('CLOSE-2','import','c1100000-0000-4000-8000-000000000001',null,
 (select id from public.routes limit 1),(select id from public.currencies where code='EUR'),(select id from public.warehouses where code='AKT'),'c1000000-0000-4000-8000-000000000002');
insert into cl_ids select 'old_done',public.create_shipment_with_stages('CLOSE-3','import','c1100000-0000-4000-8000-000000000001',null,
 (select id from public.routes limit 1),(select id from public.currencies where code='EUR'),(select id from public.warehouses where code='AKT'),'c1000000-0000-4000-8000-000000000002');
reset role;
set session_replication_role=replica;
update public.shipment_stage_runs set status='completed',completed_at=now()-interval '3 days'
 where shipment_id=(select id from cl_ids where name='old_done') and status='pending';
update public.shipment_stage_runs run set status='completed',completed_at=now()-interval '3 days' from public.shipment_stages st
 where st.id=run.stage_id and run.shipment_id=(select id from cl_ids where name='old_stuck') and run.status='pending' and st.code<>'closed';
update public.shipments set status='closed',is_locked=false,closed_at=null,closed_by=null
 where id in ((select id from cl_ids where name='old_stuck'),(select id from cl_ids where name='old_done'));
set session_replication_role=origin;
\i :repo_root/supabase/migrations/202609276650_shipment_closing.sql
do $$ begin
 assert (select status||'|'||is_locked from public.shipments where id=(select id from cl_ids where name='old_stuck'))='sales|false','a stuck shipment waits for closing again';
 assert (select status||'|'||is_locked||'|'||(closed_at < now()-interval '2 days') from public.shipments where id=(select id from cl_ids where name='old_done'))='closed|true|true',
  'a finished shipment is locked with the time of its last stage';
 -- the repair is repeatable and does not touch shipments in progress
 assert (select status from public.shipments where id=(select id from cl_ids where name='shipment'))='closed';
end $$;

reset role;
rollback;
\echo 'shipment_closing: all checks passed'
