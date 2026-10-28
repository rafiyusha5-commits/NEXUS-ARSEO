begin;
insert into auth.users(id,email,raw_user_meta_data) values('baf00000-0000-4000-8000-000000000001','archive-test@example.invalid','{"full_name":"Archive test"}');
insert into public.user_roles(user_id,role_id) select 'baf00000-0000-4000-8000-000000000001',id from public.app_roles where code='administrator';
insert into private.operational_archives values ('baf00000-0000-4000-8000-000000000010','Test','Archive regression',now(),repeat('a',40),'{"rows":1}','{"shipments":[{"id":"old","quantity":100}]}');
select set_config('request.jwt.claim.sub','baf00000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$begin
 assert (select count(*)=1 from public.list_operational_archives());
 assert public.read_operational_archive('baf00000-0000-4000-8000-000000000010')->'records'->'shipments'->0->>'quantity'='100';
 assert public.read_operational_archive('baf00000-0000-4000-8000-000000000099') is null;
 begin perform * from private.operational_archives; raise exception 'direct read allowed'; exception when insufficient_privilege then null; end;
 begin delete from private.operational_archives; raise exception 'delete allowed'; exception when insufficient_privilege then null; end;
end$$;
reset role;

-- A number retained in the archive cannot be reused after active shipments are gone.
insert into public.counterparties(id,roles,legal_name,country)
values ('baf00000-0000-4000-8000-000000000020',array['manufacturer','supplier'],'Archive number fixture','FI');
insert into private.operational_archives(id,title,reason,source_commit,manifest,records)
values('baf00000-0000-4000-8000-000000000011','Number','Regression',repeat('a',40),'{}',
  jsonb_build_object('shipments',jsonb_build_array(jsonb_build_object('shipment_number','NAR-'||to_char(current_date,'YYYY')||'-999999'))));
set local role authenticated;
do $$declare created uuid; begin
 created:=public.create_shipment_with_stages('ARCHIVE-NUMBER','import','baf00000-0000-4000-8000-000000000020',null,
   (select id from public.routes limit 1),(select id from public.currencies where code='EUR'),
   (select id from public.warehouses where code='AKT'),'baf00000-0000-4000-8000-000000000001');
 assert (select shipment_number='NAR-'||to_char(current_date,'YYYY')||'-1000000' from public.shipments where id=created), 'archived number reused';
end$$;
reset role;

insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'baf00000-0000-4000-8000-000000000001',id,'deny','test','baf00000-0000-4000-8000-000000000001' from public.permissions where code='prices.purchase.view';
set local role authenticated;
do $$begin
 begin perform * from public.list_operational_archives(); raise exception 'personal deny bypassed'; exception when insufficient_privilege then null; end;
 begin perform public.read_operational_archive('baf00000-0000-4000-8000-000000000010'); raise exception 'personal deny bypassed'; exception when insufficient_privilege then null; end;
end$$;
reset role;
do $$begin
 assert not has_function_privilege('anon','public.list_operational_archives()','execute');
 assert not has_function_privilege('service_role','public.read_operational_archive(uuid)','execute');
 begin update private.operational_archives set title='changed'; raise exception 'immutable update allowed'; exception when insufficient_privilege then null; end;
 begin delete from private.operational_archives; raise exception 'immutable delete allowed'; exception when insufficient_privilege then null; end;
end$$;
rollback;
