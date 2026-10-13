-- «Логист» (202609277400): proposals are made from the shipment state, accepted with the employee's own rights,
-- rejected for good, made obsolete when the situation passes, and never visible or decidable without access.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('ed000000-0000-4000-8000-000000000001','logist-director@test.local','{"full_name":"Logist Director"}'),
 ('ed000000-0000-4000-8000-000000000002','logist-limited@test.local','{"full_name":"Logist Limited"}'),
 ('ed000000-0000-4000-8000-000000000003','logist-nodocs@test.local','{"full_name":"Logist No Documents"}');
insert into public.user_roles(user_id,role_id) select u::uuid,r.id from (values
 ('ed000000-0000-4000-8000-000000000001'),('ed000000-0000-4000-8000-000000000002'),('ed000000-0000-4000-8000-000000000003')) v(u)
 cross join public.app_roles r where r.code='director';
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select x.u::uuid,p.id,'deny','logist test','ed000000-0000-4000-8000-000000000001' from (values
 ('ed000000-0000-4000-8000-000000000002','shipments.change_status'),
 ('ed000000-0000-4000-8000-000000000002','tasks.manage'),
 ('ed000000-0000-4000-8000-000000000003','documents.view')) x(u,code) join public.permissions p on p.code=x.code;
insert into public.counterparties(id,roles,legal_name,country,tax_id)
values('ed100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Logist supplier','FI','LOGIST-FI');

create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql; exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm; end if;
  return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on function pg_temp.fails(text,text) to authenticated;
create temporary table lg(name text primary key,id uuid);
grant select,insert,update on lg to authenticated;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from lg where name=p_name $$;
grant execute on function pg_temp.id(text) to authenticated;
create function pg_temp.proposal(p_kind text,p_like text) returns uuid language sql as $$
 select id from public.logist_proposals where shipment_id=pg_temp.id('shipment') and kind=p_kind and title like p_like order by (status='pending') desc, created_at desc limit 1
$$;
grant execute on function pg_temp.proposal(text,text) to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub','ed000000-0000-4000-8000-000000000001',false);
insert into lg select 'shipment',public.create_shipment_with_stages('LOGIST-1','import','ed100000-0000-4000-8000-000000000001',null,
 (select id from public.routes limit 1),(select id from public.currencies where code='EUR'),(select id from public.warehouses where code='AKT'),
 'ed000000-0000-4000-8000-000000000001');
-- Three vehicles: two with plates, one still empty. Vehicles 1 and 2 were due three and two days ago.
select public.create_shipment_transport(pg_temp.id('shipment'),current_date-10,current_date-3,null,null,null,null,null,'111AAA11');
select public.create_shipment_transport(pg_temp.id('shipment'),current_date-10,current_date-2,null,null,null,null,null,'222BBB22');
select public.create_shipment_transport(pg_temp.id('shipment'));
insert into lg select 't'||sequence_no,id from public.shipment_transports where shipment_id=pg_temp.id('shipment');
do $$ declare r record; begin
 for r in select run.id from public.shipment_stage_runs run join public.shipment_stages st on st.id=run.stage_id
          where run.shipment_id=pg_temp.id('shipment') and st.sequence_order<=4 order by st.sequence_order loop
  perform public.change_shipment_stage_status(r.id,'completed');
 end loop;
end $$;


select public.run_logist(pg_temp.id('shipment'));
reset role;
update public.shipments set responsible_user_id='ed000000-0000-4000-8000-000000000002' where id=pg_temp.id('shipment');
set role authenticated;
select public.accept_logist_proposal((select id from public.logist_proposals where shipment_id=pg_temp.id('shipment') and kind='follow_up_task' and status='pending' limit 1));
select responsible_user_id from public.shipments where id=pg_temp.id('shipment');


do $$ begin
 assert (select result->>'assignee_user_id'='ed000000-0000-4000-8000-000000000002' from public.logist_proposals where status='accepted'), 'Task uses the current responsible employee';
 assert (select action->>'assignee_user_id'=result->>'assignee_user_id' from public.logist_proposals where status='accepted'), 'Stored action records the actual decision';
end $$;
rollback;
