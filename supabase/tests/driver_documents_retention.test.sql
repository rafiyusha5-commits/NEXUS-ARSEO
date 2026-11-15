-- 202611150200: IIN and document requisites disappear after 12 months without driver activity,
-- from the directory and from the history; everything else stays; the history stays immutable.
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('fb000000-0000-4000-8000-000000000001','retention-actor@example.invalid','{"full_name":"Retention actor"}');

-- A: no activity for two years -> removed.  B: old documents, trip three months ago -> kept.
-- C: old card, documents entered a month ago -> kept.  D: card without documents -> nothing to do.
insert into public.freight_drivers(id,full_name,phones,active,created_at) values
 ('fb100000-0000-4000-8000-00000000000a','Driver A',array['+77000000001'],false,now()-interval '2 years'),
 ('fb100000-0000-4000-8000-00000000000b','Driver B',array['+77000000002'],true,now()-interval '2 years'),
 ('fb100000-0000-4000-8000-00000000000c','Driver C',array['+77000000003'],true,now()-interval '2 years'),
 ('fb100000-0000-4000-8000-00000000000d','Driver D',array['+77000000004'],true,now()-interval '2 years');
insert into private.freight_driver_documents(driver_id,iin,document_requisites,version) values
 ('fb100000-0000-4000-8000-00000000000a','111111111111','PASSPORT-A-SENTINEL',2),
 ('fb100000-0000-4000-8000-00000000000b','222222222222','PASSPORT-B',1),
 ('fb100000-0000-4000-8000-00000000000c','333333333333','PASSPORT-C',1);
insert into private.freight_directory_history(kind,entity_id,actor_id,reason,before_value,after_value,created_at) values
 ('driver_documents','fb100000-0000-4000-8000-00000000000a','fb000000-0000-4000-8000-000000000001','First entry',null,
  '{"driver_id":"fb100000-0000-4000-8000-00000000000a","iin":"111111111110","document_requisites":"OLD-A","version":1,"source":null}',now()-interval '25 months'),
 ('driver_documents','fb100000-0000-4000-8000-00000000000a','fb000000-0000-4000-8000-000000000001','Correction',
  '{"driver_id":"fb100000-0000-4000-8000-00000000000a","iin":"111111111110","document_requisites":"OLD-A","version":1}',
  '{"driver_id":"fb100000-0000-4000-8000-00000000000a","iin":"111111111111","document_requisites":"PASSPORT-A-SENTINEL","version":2,"source":null}',now()-interval '24 months'),
 ('driver','fb100000-0000-4000-8000-00000000000a','fb000000-0000-4000-8000-000000000001','Card',null,'{"full_name":"Driver A"}',now()-interval '23 months'),
 ('driver_documents','fb100000-0000-4000-8000-00000000000b','fb000000-0000-4000-8000-000000000001','Entry',null,
  '{"driver_id":"fb100000-0000-4000-8000-00000000000b","iin":"222222222222","document_requisites":"PASSPORT-B","version":1}',now()-interval '2 years'),
 ('driver_documents','fb100000-0000-4000-8000-00000000000c','fb000000-0000-4000-8000-000000000001','Entry',null,
  '{"driver_id":"fb100000-0000-4000-8000-00000000000c","iin":"333333333333","document_requisites":"PASSPORT-C","version":1}',now()-interval '1 month');
insert into private.freight_trips(id,mode,version,snapshot) values
 ('fb200000-0000-4000-8000-000000000001','sale',1,'{"driver":{"id":"fb100000-0000-4000-8000-00000000000b","full_name":"Driver B"}}');
insert into private.freight_trip_versions(trip_id,version,snapshot,actor_id,reason,created_at) values
 ('fb200000-0000-4000-8000-000000000001',1,'{"driver":{"id":"fb100000-0000-4000-8000-00000000000b","full_name":"Driver B"}}',
  'fb000000-0000-4000-8000-000000000001','Trip',now()-interval '3 months');
insert into private.freight_directory_requests(id,actor_id,digest,result_id,created_at) values
 ('fb300000-0000-4000-8000-000000000001','fb000000-0000-4000-8000-000000000001',repeat('a',64),'fb100000-0000-4000-8000-00000000000a',now()-interval '24 months'),
 ('fb300000-0000-4000-8000-000000000002','fb000000-0000-4000-8000-000000000001',repeat('b',64),'fb100000-0000-4000-8000-00000000000b',now()-interval '2 years');

-- The history stays immutable outside the retention removal.
do $$begin
 begin
  update private.freight_directory_history set reason='Changed' where entity_id='fb100000-0000-4000-8000-00000000000a';
  raise exception 'history update was not refused';
 exception when insufficient_privilege then null; end;
 begin
  delete from private.freight_directory_history where entity_id='fb100000-0000-4000-8000-00000000000a';
  raise exception 'history delete was not refused';
 exception when insufficient_privilege then null; end;
 -- Even with the switch on, only blanking the two fields of document rows is accepted.
 perform set_config('nexus.freight_retention_purge','on',true);
 begin
  update private.freight_directory_history set reason='Changed' where kind='driver_documents' and entity_id='fb100000-0000-4000-8000-00000000000a';
  raise exception 'history reason change was not refused';
 exception when insufficient_privilege then null; end;
 begin
  update private.freight_directory_history set after_value='{}' where kind='driver' and entity_id='fb100000-0000-4000-8000-00000000000a';
  raise exception 'driver card history change was not refused';
 exception when insufficient_privilege then null; end;
 begin
  delete from private.freight_directory_history where kind='driver_documents' and entity_id='fb100000-0000-4000-8000-00000000000a';
  raise exception 'history delete with the switch was not refused';
 exception when insufficient_privilege then null; end;
 perform set_config('nexus.freight_retention_purge','',true);
 -- Trip versions keep their own guard.
 begin
  update private.freight_trip_versions set reason='Changed' where trip_id='fb200000-0000-4000-8000-000000000001';
  raise exception 'trip version update was not refused';
 exception when insufficient_privilege then null; end;
end$$;

do $$
declare removed integer;
begin
 removed:=private.purge_expired_driver_documents(now());
 assert removed=1, format('exactly driver A is removed, got %s', removed);

 -- A: values gone from the directory and every history row; the rest is untouched.
 assert (select iin is null and document_requisites is null and version=3 from private.freight_driver_documents where driver_id='fb100000-0000-4000-8000-00000000000a');
 assert not exists(select 1 from private.freight_directory_history where entity_id='fb100000-0000-4000-8000-00000000000a'
   and (before_value::text ~ '11111111111|OLD-A|PASSPORT-A' or after_value::text ~ '11111111111|OLD-A|PASSPORT-A'));
 assert (select count(*) from private.freight_directory_history where entity_id='fb100000-0000-4000-8000-00000000000a')=3, 'history rows are kept';
 assert (select reason from private.freight_directory_history where entity_id='fb100000-0000-4000-8000-00000000000a' and created_at<now()-interval '24 months 15 days')='First entry';
 assert (select after_value->>'version' from private.freight_directory_history where entity_id='fb100000-0000-4000-8000-00000000000a' and reason='Correction')='2';
 assert (select after_value->>'full_name' from private.freight_directory_history where entity_id='fb100000-0000-4000-8000-00000000000a' and kind='driver')='Driver A';
 assert (select full_name='Driver A' and phones=array['+77000000001'] from public.freight_drivers where id='fb100000-0000-4000-8000-00000000000a');
 assert not exists(select 1 from private.freight_directory_requests where result_id='fb100000-0000-4000-8000-00000000000a'), 'idempotency digests of A removed';
 assert (select history_rows=2 and rule ~ '12' from private.freight_driver_document_purges where driver_id='fb100000-0000-4000-8000-00000000000a');
 assert not exists(select 1 from private.freight_driver_document_purges p where to_jsonb(p)::text ~ '111111111111|PASSPORT'), 'the log holds no removed value';

 -- B (recent trip) and C (recent documents) keep everything.
 assert (select iin='222222222222' from private.freight_driver_documents where driver_id='fb100000-0000-4000-8000-00000000000b');
 assert exists(select 1 from private.freight_directory_history where entity_id='fb100000-0000-4000-8000-00000000000b' and after_value->>'iin'='222222222222');
 assert exists(select 1 from private.freight_directory_requests where result_id='fb100000-0000-4000-8000-00000000000b');
 assert (select iin='333333333333' from private.freight_driver_documents where driver_id='fb100000-0000-4000-8000-00000000000c');
 assert not exists(select 1 from private.freight_driver_document_purges where driver_id<>'fb100000-0000-4000-8000-00000000000a');

 -- Repeating removes nothing; the trip of B ages past 12 months -> B is removed too.
 assert private.purge_expired_driver_documents(now())=0, 'second run is a no-op';
 assert private.purge_expired_driver_documents(now()+interval '10 months')=1, 'B expires 12 months after its trip';
 assert (select iin is null from private.freight_driver_documents where driver_id='fb100000-0000-4000-8000-00000000000b');
 assert (select snapshot->'driver'->>'full_name' from private.freight_trip_versions where trip_id='fb200000-0000-4000-8000-000000000001')='Driver B', 'trip history untouched';
end$$;

-- The schedule entry point runs for service_role and is refused to employees.
set local role service_role;
select public.purge_expired_driver_documents();
reset role;
set local role authenticated;
do $$begin
 begin
  perform public.purge_expired_driver_documents();
  raise exception 'employees must not run the removal';
 exception when insufficient_privilege then null; end;
end$$;
reset role;
rollback;
\echo driver_documents_retention: all checks passed
