\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('ae020000-0000-4000-8000-000000000001','health-admin@example.invalid','{"full_name":"Health test"}'),
 ('ae020000-0000-4000-8000-000000000002','health-viewer@example.invalid','{"full_name":"Denied health test"}');
insert into public.user_roles(user_id,role_id) select u.id,r.id from auth.users u cross join public.app_roles r
 where u.id in('ae020000-0000-4000-8000-000000000001','ae020000-0000-4000-8000-000000000002') and r.code='administrator';
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'ae020000-0000-4000-8000-000000000001',id,'allow','Synthetic monitoring test','ae020000-0000-4000-8000-000000000001' from public.permissions where code='system.health.view';
create function pg_temp.health_reject(sql text) returns void language plpgsql as $$begin
 execute sql;raise exception 'expected denial' using errcode='P0999';exception when insufficient_privilege then null;end$$;
create temp table health_business_before as select
 (select md5(coalesce(jsonb_agg(to_jsonb(s) order by id)::text,'')) from public.shipments s) shipments,
 (select md5(coalesce(jsonb_agg(to_jsonb(s) order by id)::text,'')) from public.sales s) sales,
 (select md5(coalesce(jsonb_agg(to_jsonb(s) order by id)::text,'')) from public.inventory_balances s) balances,
 (select md5(coalesce(jsonb_agg(to_jsonb(s) order by id)::text,'')) from public.documents s) documents;
do $$begin
 assert not has_function_privilege('anon','public.system_health_ping()','execute');
 assert not has_function_privilege('authenticated','public.record_system_health(text,text,text,timestamptz,uuid)','execute');
 assert not has_table_privilege('authenticated','private.system_health_incidents','select,insert,update,delete');
 assert not has_table_privilege('service_role','private.system_health_delivery','select,insert,update,delete');
 assert not has_table_privilege('service_role','private.system_health_policy','select,insert,update,delete');
 assert not has_function_privilege('authenticated','private.notify_system_health(text,text)','execute');
end$$;
set local role authenticated;
select set_config('request.jwt.claim.sub','ae020000-0000-4000-8000-000000000002',true);
select pg_temp.health_reject($q$select public.system_health_snapshot('test')$q$);
select pg_temp.health_reject($q$select public.system_health_jobs()$q$);
select pg_temp.health_reject($q$select public.record_system_health('test','app','FAILED',now(),gen_random_uuid())$q$);
select set_config('request.jwt.claim.sub','ae020000-0000-4000-8000-000000000001',true);
select public.system_health_snapshot('test');
select public.system_health_jobs();
reset role;
set local role service_role;
do $$declare stamp timestamptz:=clock_timestamp();begin
 assert public.system_health_ping();
 perform public.system_health_jobs();
 perform public.record_system_health('test','app','FAILED',stamp,'ae020000-0000-4000-8000-000000000003');
 for i in 1..100 loop perform public.record_system_health('test','app','FAILED',stamp,'ae020000-0000-4000-8000-000000000003');end loop;
 perform public.record_system_health('test','app','FAILED',stamp+interval '1 second','ae020000-0000-4000-8000-000000000004');
 perform public.record_system_health('test','app','DISABLED',stamp+interval '2 seconds','ae020000-0000-4000-8000-000000000005');
end$$;
reset role;
do $$begin
 assert (select count(*)=1 from private.system_health_incidents where environment='test' and component='app' and recovered_at is null);
 assert (select occurrences=2 from private.system_health_incidents where environment='test' and component='app' and recovered_at is null);
 assert (select count(*)=1 from public.notifications where entity_type='system_health' and recipient_user_id='ae020000-0000-4000-8000-000000000001');
 assert not exists(select 1 from public.notifications where entity_type='system_health' and recipient_user_id='ae020000-0000-4000-8000-000000000002');
 assert (select count(*)=1 from private.system_health_delivery);
end$$;
set local role service_role;
create temp table health_claim as select public.claim_system_health_delivery('test') claim;
do $$declare d jsonb:=(select claim from health_claim);begin
 assert d is not null;
 assert public.claim_system_health_delivery('test') is null;
 assert not public.finish_system_health_delivery((d->>'id')::uuid,gen_random_uuid(),true);
 assert public.finish_system_health_delivery((d->>'id')::uuid,(d->>'claim')::uuid,false);
 assert not public.finish_system_health_delivery((d->>'id')::uuid,(d->>'claim')::uuid,true);
 assert public.claim_system_health_delivery('test') is null;
end$$;
reset role;
-- The test advances only technical leases, never business state or wall clock.
do $$declare d jsonb;begin
 for i in 2..5 loop
  update private.system_health_delivery set available_at=now()-interval '1 second',lease_until=now()-interval '1 second';
  d:=public.claim_system_health_delivery('test');assert d is not null;
  assert public.finish_system_health_delivery((d->>'id')::uuid,(d->>'claim')::uuid,false);
 end loop;
 assert (select count(*)=1 from private.system_health_delivery where state='failed' and attempts=5);
 assert (select count(*)=1 from private.system_health_incidents);
 assert public.claim_system_health_delivery('test') is null;
 perform public.record_system_health('test','app','OK',clock_timestamp()+interval '3 seconds',gen_random_uuid());
 assert (select count(*)=1 from private.system_health_incidents where recovered_at is not null);
 perform public.record_system_health('test','app','FAILED',clock_timestamp()+interval '4 seconds',gen_random_uuid());
 assert (select count(*)=1 from private.system_health_incidents where recovered_at is null);
 assert (select count(*)=2 from public.notifications where entity_type='system_health' and recipient_user_id='ae020000-0000-4000-8000-000000000001'),'Rate window bypassed';
 -- A rapid repeated failure is retained, but does not repeat its alert until the window expires.
 update private.system_health_delivery set notified_at=notified_at-interval '10 minutes';
 perform public.record_system_health('test','app','FAILED',clock_timestamp()+interval '5 seconds',gen_random_uuid());
 assert (select count(*)=3 from public.notifications where entity_type='system_health' and recipient_user_id='ae020000-0000-4000-8000-000000000001');
 -- Out-of-order healthy response must not close the new incident.
 perform public.record_system_health('test','app','OK',clock_timestamp()-interval '1 hour',gen_random_uuid());
 assert (select count(*)=1 from private.system_health_incidents where recovered_at is null);
end$$;
-- Flapping keeps every cycle, limits notices, and cannot silence a continuing failure forever.
do $$declare stamp timestamptz:=clock_timestamp(); n integer; d jsonb;begin
 for n in 0..49 loop
  perform public.record_system_health('training','storage','FAILED',stamp+make_interval(secs=>n*0.002),gen_random_uuid());
  perform public.record_system_health('training','storage','OK',stamp+make_interval(secs=>n*0.002+0.001),gen_random_uuid());
 end loop;
 perform public.record_system_health('training','storage','FAILED',stamp+interval '1 second',gen_random_uuid());
 assert (select count(*)=51 from private.system_health_incidents where environment='training' and component='storage');
 select count(*) into n from public.notifications x join private.system_health_incidents i on i.id=x.entity_id
  where i.environment='training' and i.component='storage' and x.recipient_user_id='ae020000-0000-4000-8000-000000000001';
 assert n=2,'Flapping must not flood Nexus notifications';
 update private.system_health_delivery d set notified_at=clock_timestamp()-interval '45 seconds'
  from private.system_health_incidents i where i.id=d.incident_id and i.environment='training' and d.notified_at is not null;
 update private.system_health_policy set notification_window_seconds=60,delivery_interval_seconds=90 where environment='training';
 perform public.record_system_health('training','storage','FAILED',stamp+interval '2 seconds',gen_random_uuid());
 assert (select count(*)=2 from public.notifications x join private.system_health_incidents i on i.id=x.entity_id
  where i.environment='training' and x.recipient_user_id='ae020000-0000-4000-8000-000000000001');
 update private.system_health_policy set notification_window_seconds=30 where environment='training';
 perform public.record_system_health('training','storage','FAILED',stamp+interval '3 seconds',gen_random_uuid());
 assert (select count(*)=3 from public.notifications x join private.system_health_incidents i on i.id=x.entity_id
  where i.environment='training' and x.recipient_user_id='ae020000-0000-4000-8000-000000000001'),'Persistent failure must eventually notify';
 d:=public.claim_system_health_delivery('training');assert d is not null;
 assert public.finish_system_health_delivery((d->>'id')::uuid,(d->>'claim')::uuid,true);
 assert (select lease_until>=now()+interval '89 seconds' from private.system_health_delivery where id=(d->>'id')::uuid);
 assert public.claim_system_health_delivery('training') is null;
end$$;
-- A personal deny and inactive account cannot use the read RPC even with the old role.
create function pg_temp.health_notification_failure() returns trigger language plpgsql as $$begin raise exception 'Synthetic delivery failure';end$$;
create trigger synthetic_health_notification_failure before insert on public.notifications for each row execute function pg_temp.health_notification_failure();
do $$begin
 begin
  perform public.record_system_health('test','database','UNAVAILABLE',clock_timestamp(),gen_random_uuid());
  raise exception 'Expected atomic failure' using errcode='P0999';
 exception when sqlstate 'P0001' then null;end;
 assert not exists(select 1 from private.system_health_current where component='database');
 assert not exists(select 1 from private.system_health_incidents where component='database');
end$$;
drop trigger synthetic_health_notification_failure on public.notifications;
update public.user_permission_overrides set effect='deny' where user_id='ae020000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.health_reject($q$select public.system_health_snapshot('test')$q$);
reset role;
update public.user_permission_overrides set effect='allow' where user_id='ae020000-0000-4000-8000-000000000001';
update public.profiles set is_active=false where id='ae020000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.health_reject($q$select public.system_health_jobs()$q$);
reset role;
-- A portal profile cannot read diagnostics even if an allow override remains.
insert into public.counterparties(id,roles,legal_name,country) values
 ('ae020000-0000-4000-8000-000000000009',array['customer'],'Synthetic monitoring portal','KZ');
update public.profiles set is_active=true,user_type='external',counterparty_id='ae020000-0000-4000-8000-000000000009'
 where id='ae020000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.health_reject($q$select public.system_health_snapshot('test')$q$);
select pg_temp.health_reject($q$select public.system_health_jobs()$q$);
reset role;
do $$declare b record;begin
 select * into b from health_business_before;
 assert b.shipments=(select md5(coalesce(jsonb_agg(to_jsonb(s) order by id)::text,'')) from public.shipments s);
 assert b.sales=(select md5(coalesce(jsonb_agg(to_jsonb(s) order by id)::text,'')) from public.sales s);
 assert b.balances=(select md5(coalesce(jsonb_agg(to_jsonb(s) order by id)::text,'')) from public.inventory_balances s);
 assert b.documents=(select md5(coalesce(jsonb_agg(to_jsonb(s) order by id)::text,'')) from public.documents s);
end$$;
rollback;
