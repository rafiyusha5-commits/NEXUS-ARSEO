\set ON_ERROR_STOP 1
begin;
\ir fixtures/freight_directory.sql
insert into tests.freight_ids(k,value) values('before',tests.freight_business());
set local role authenticated;
select set_config('request.jwt.claim.sub','fc000000-0000-4000-8000-000000000001',true);
insert into tests.freight_ids(k,id) values('carrier',public.save_freight_directory('carrier','fc500000-0000-4000-8000-000000000001',null,0,'{"counterparty_id":"fc100000-0000-4000-8000-000000000001","active":true}','Первичная запись'));
insert into tests.freight_ids(k,id) values('carrier2',public.save_freight_directory('carrier','fc500000-0000-4000-8000-000000000002',null,0,'{"counterparty_id":"fc100000-0000-4000-8000-000000000002","active":true}','Первичная запись'));
do $$begin
 assert public.save_freight_directory('carrier','fc500000-0000-4000-8000-000000000001',null,0,'{"counterparty_id":"fc100000-0000-4000-8000-000000000001","active":true}','Первичная запись')=(select id from tests.freight_ids where k='carrier');
end$$;
select tests.freight_fails($q$select public.save_freight_directory('carrier','fc500000-0000-4000-8000-000000000001',null,0,'{"counterparty_id":"fc100000-0000-4000-8000-000000000001","active":false}','Другой запрос')$q$,'использован');
insert into tests.freight_ids(k,id) select 'driver',public.save_freight_directory('driver',gen_random_uuid(),null,0,jsonb_build_object('full_name','Иванов Иван','phones',array['+70000000000'],'active',true,'carrier_id',id),'Первичная запись') from tests.freight_ids where k='carrier';
insert into tests.freight_ids(k,id) select 'driver2',public.save_freight_directory('driver',gen_random_uuid(),null,0,jsonb_build_object('full_name','Другой водитель','phones',array['+70000000000'],'active',true,'carrier_id',id),'Общий телефон допустим') from tests.freight_ids where k='carrier';
insert into tests.freight_ids(k,id) select 'vehicle',public.save_freight_directory('vehicle',gen_random_uuid(),null,0,jsonb_build_object('carrier_id',id,'plate_number','ABC-123','registration_country','KZ','vehicle_type','truck','status','active'),'Первичная запись') from tests.freight_ids where k='carrier';
insert into tests.freight_ids(k,id) select 'vehicle2',public.save_freight_directory('vehicle',gen_random_uuid(),null,0,jsonb_build_object('carrier_id',id,'plate_number','abc 123','registration_country','PL','vehicle_type','truck','status','active'),'Другая страна') from tests.freight_ids where k='carrier';
insert into tests.freight_ids(k,id) select 'trailer',public.save_freight_directory('vehicle',gen_random_uuid(),null,0,jsonb_build_object('carrier_id',id,'plate_number','ABC123','registration_country','KZ','vehicle_type','trailer','status','active'),'Другой тип') from tests.freight_ids where k='carrier';
select tests.freight_fails($q$select public.save_freight_directory('vehicle',gen_random_uuid(),null,0,jsonb_build_object('carrier_id',(select id from tests.freight_ids where k='carrier'),'plate_number','abc 123','registration_country','KZ','vehicle_type','truck','status','active'),'Дубликат')$q$,'уже есть');
select public.save_freight_directory('driver_documents',gen_random_uuid(),id,0,'{"iin":"123456789012","document_requisites":"PRIVATE-SENTINEL"}','Защищённые реквизиты') from tests.freight_ids where k='driver';
do $$begin
 assert public.freight_directory_detail('driver_documents',(select id from tests.freight_ids where k='driver'))->'record'->>'iin'='123456789012';
 assert jsonb_array_length(public.freight_directory('driver'))=2,'Shared phone merged identities';
end$$;
select set_config('request.jwt.claim.sub','fc000000-0000-4000-8000-000000000002',true);
select tests.freight_fails($q$select public.freight_directory_detail('driver_documents',(select id from tests.freight_ids where k='driver'))$q$,'Нет доступа');
select tests.freight_fails($q$select * from private.freight_driver_documents$q$,'permission denied');
do $$begin
 assert public.freight_directory('driver')::text !~ '123456789012|PRIVATE-SENTINEL';
 assert public.freight_directory_detail('driver',(select id from tests.freight_ids where k='driver'))::text !~ '123456789012|PRIVATE-SENTINEL';
 assert public.freight_source_preview('transport','fc210000-0000-4000-8000-000000000001')::text !~ 'SECRET-DOC';
end$$;
select set_config('request.jwt.claim.sub','fc000000-0000-4000-8000-000000000003',true);
select tests.freight_fails($q$select public.freight_directory('driver')$q$,'Нет доступа');
select tests.freight_fails($q$select public.freight_trips()$q$,'Нет доступа');
select set_config('request.jwt.claim.sub','fc000000-0000-4000-8000-000000000001',true);
insert into tests.freight_ids(k,value) select 'values',jsonb_build_object('carrier_id',(select id from tests.freight_ids where k='carrier'),
 'driver_id',(select id from tests.freight_ids where k='driver'),'vehicle_id',(select id from tests.freight_ids where k='vehicle'),
 'trailer_id',(select id from tests.freight_ids where k='trailer'),'pallet_tare_kg','22',
 'origin',jsonb_build_object('address','Завод, тестовый адрес','contact','Склад завода','confirmed',true),
 'destination',jsonb_build_object('address','Актобе, тестовый адрес','contact','Склад Актобе','confirmed',true));
reset role;
create function tests.make_freight(mode text,ops uuid[],req uuid default gen_random_uuid(),tare text default '22') returns uuid language plpgsql as $$
declare v jsonb;preview jsonb;begin
 select jsonb_set(value,'{pallet_tare_kg}',to_jsonb(tare)) into v from tests.freight_ids where k='values';
 preview:=public.preview_freight_trip(mode,ops,v);
 return public.save_freight_trip(req,null,0,mode,ops,v,preview->>'digest','Подтверждено по тестовым документам');
end$$;
grant execute on function tests.make_freight(text,uuid[],uuid,text) to authenticated;
set local role authenticated;
insert into tests.freight_ids(k,id) values('import',tests.make_freight('purchase',array['fc210000-0000-4000-8000-000000000001'::uuid],'fc600000-0000-4000-8000-000000000001'));
insert into tests.freight_ids(k,id) values('sale',tests.make_freight('sale',array['fc300000-0000-4000-8000-000000000001'::uuid],'fc600000-0000-4000-8000-000000000002','25'));
insert into tests.freight_ids(k,id) values('transfer',tests.make_freight('transfer',array['fc400000-0000-4000-8000-000000000001'::uuid,'fc400000-0000-4000-8000-000000000002'::uuid]));
do $$begin
 assert tests.make_freight('purchase',array['fc210000-0000-4000-8000-000000000001'::uuid],'fc600000-0000-4000-8000-000000000001')=(select id from tests.freight_ids where k='import');
 assert public.freight_trips((select id from tests.freight_ids where k='import'))->'snapshot'->>'pallet_tare_kg'='22';
 assert public.freight_trips((select id from tests.freight_ids where k='sale'))->'snapshot'->>'pallet_tare_kg'='25';
 assert jsonb_array_length(public.freight_trips((select id from tests.freight_ids where k='transfer'))->'snapshot'->'operations')=2;
end$$;
select tests.freight_fails($q$select tests.make_freight('purchase',array['fc300000-0000-4000-8000-000000000002'::uuid])$q$,'недоступна');
select tests.freight_fails($q$select tests.make_freight('sale',array['fc300000-0000-4000-8000-000000000002'::uuid],gen_random_uuid(),'26')$q$,'20 до 25');
select tests.freight_fails($q$select public.preview_freight_trip('sale',array['fc300000-0000-4000-8000-000000000002'::uuid],jsonb_set((select value from tests.freight_ids where k='values'),'{origin,confirmed}','false'))$q$,'Подтвердите');
insert into tests.freight_ids(k,value) select 'stale',public.preview_freight_trip('sale',array['fc300000-0000-4000-8000-000000000002'::uuid],value) from tests.freight_ids where k='values';
select public.save_freight_directory('driver',gen_random_uuid(),id,1,jsonb_build_object('full_name','Новое ФИО','phones',array['+71111111111'],'carrier_id',(select id from tests.freight_ids where k='carrier'),'active',true),'Смена телефона') from tests.freight_ids where k='driver';
select tests.freight_fails($q$select public.save_freight_trip(gen_random_uuid(),null,0,'sale',array['fc300000-0000-4000-8000-000000000002'::uuid],(select value from tests.freight_ids where k='values'),(select value->>'digest' from tests.freight_ids where k='stale'),'Устаревший предпросмотр')$q$,'изменились');
do $$begin
 assert public.freight_trips((select id from tests.freight_ids where k='import'))->'snapshot'->'driver'->>'full_name'='Иванов Иван','Old snapshot changed';
end$$;
select public.save_freight_directory('carrier',gen_random_uuid(),id,1,'{"counterparty_id":"fc100000-0000-4000-8000-000000000001","active":false,"inactive_reason":"Не работаем"}','Прекращение работы') from tests.freight_ids where k='carrier';
select tests.freight_fails($q$select tests.make_freight('sale',array['fc300000-0000-4000-8000-000000000002'::uuid])$q$,'активного перевозчика');
do $$begin assert public.freight_trips((select id from tests.freight_ids where k='import')) is not null,'Inactive carrier hid old trip';end$$;
select public.save_freight_directory('driver',gen_random_uuid(),id,2,jsonb_build_object('full_name','Новое ФИО','phones',array['+71111111111'],'carrier_id',(select id from tests.freight_ids where k='carrier2'),'active',true),'Водитель сменил перевозчика') from tests.freight_ids where k='driver';
do $$begin
 assert public.freight_trips((select id from tests.freight_ids where k='import'))->'snapshot'->'carrier'->>'name'='Тестовый перевозчик А';
 assert jsonb_array_length(public.freight_directory_detail('driver',(select id from tests.freight_ids where k='driver'))->'history')=3;
end$$;
-- A source is previewed without writing and may be imported once per kind. A new request cannot duplicate it.
insert into tests.freight_ids(k,value) values('source',public.freight_source_preview('transport','fc210000-0000-4000-8000-000000000001'));
insert into tests.freight_ids(k,value) select 'source-values',jsonb_build_object('full_name','Источник Водитель','phones',array['+70000000000'],'active',true,
 'source',jsonb_build_object('type','transport','id','fc210000-0000-4000-8000-000000000001','stamp',value->>'stamp')) from tests.freight_ids where k='source';
select tests.freight_fails($q$select public.save_freight_directory('driver',gen_random_uuid(),null,0,jsonb_set((select value from tests.freight_ids where k='source-values'),'{source,stamp}','"old"'),'Старый источник')$q$,'Источник изменился');
insert into tests.freight_ids(k,id) select 'source-driver',public.save_freight_directory('driver','fc800000-0000-4000-8000-000000000001',null,0,value,'Подтверждённый перенос') from tests.freight_ids where k='source-values';
do $$begin assert (select public.save_freight_directory('driver','fc800000-0000-4000-8000-000000000001',null,0,value,'Подтверждённый перенос')=(select id from tests.freight_ids where k='source-driver') from tests.freight_ids where k='source-values');end$$;
select tests.freight_fails($q$select public.save_freight_directory('driver',gen_random_uuid(),null,0,(select value from tests.freight_ids where k='source-values'),'Повторный перенос')$q$,'уже перенесён');
reset role;
do $$begin
 assert (select count(*)=3 from private.freight_trips);
 assert (select count(*)=4 from private.freight_trip_links);
 assert (select count(*)=3 from private.freight_trip_versions);
 assert tests.freight_business()=(select value from tests.freight_ids where k='before'),'Business rows changed';
 assert not has_table_privilege('authenticated','private.freight_trip_versions','insert,update,delete');
 assert not has_function_privilege('anon','public.freight_directory(text,text,uuid)','execute');
 assert not has_function_privilege('service_role','public.save_freight_directory(text,uuid,uuid,bigint,jsonb,text)','execute');
end$$;
-- Personal denial must apply even to an already visible trip and to directory reads.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'fc000000-0000-4000-8000-000000000001',id,'deny','Personal denial test','fc000000-0000-4000-8000-000000000001' from public.permissions where code='shipments.view';
set local role authenticated;
select tests.freight_fails($q$select public.freight_trips((select id from tests.freight_ids where k='import'))$q$,'недоступен');
reset role;
-- Failure of history insertion must roll back the directory and request receipt.
create function tests.fail_freight_history() returns trigger language plpgsql as $$begin raise exception 'SYNTHETIC_HISTORY_FAILURE';end$$;
create trigger fail_freight_history before insert on private.freight_directory_history for each row execute function tests.fail_freight_history();
set local role authenticated;
select tests.freight_fails($q$select public.save_freight_directory('driver',gen_random_uuid(),null,0,'{"full_name":"Не должен сохраниться","active":true}','Ошибка истории')$q$,'SYNTHETIC_HISTORY_FAILURE');
reset role;
do $$begin assert not exists(select 1 from public.freight_drivers where full_name='Не должен сохраниться');end$$;
rollback;
