\set ON_ERROR_STOP 1
begin;
\ir fixtures/freight_directory.sql
insert into public.counterparties(id,roles,legal_name,country) values('fc100000-0000-4000-8000-000000000005',array['supplier','customer'],'Смешанная роль контрагента','KZ');
set local session_replication_role=replica;
update public.sales set customer_id='fc100000-0000-4000-8000-000000000005' where id='fc300000-0000-4000-8000-000000000002';
set local session_replication_role=origin;
insert into tests.freight_ids(k,value) values('before',tests.freight_business());
set local role authenticated;
select set_config('request.jwt.claim.sub','fc000000-0000-4000-8000-000000000001',true);
insert into tests.freight_ids(k,id) values('carrier',public.save_freight_directory('carrier',gen_random_uuid(),null,0,'{"counterparty_id":"fc100000-0000-4000-8000-000000000001","active":true}','Тест редакций'));
insert into tests.freight_ids(k,id) select 'driver',public.save_freight_directory('driver',gen_random_uuid(),null,0,jsonb_build_object('full_name','Тест истории','carrier_id',id,'active',true),'Тест редакций') from tests.freight_ids where k='carrier';
insert into tests.freight_ids(k,id) select 'vehicle',public.save_freight_directory('vehicle',gen_random_uuid(),null,0,jsonb_build_object('carrier_id',id,'plate_number','HISTORY-1','registration_country','KZ','vehicle_type','truck','status','active'),'Тест редакций') from tests.freight_ids where k='carrier';
insert into tests.freight_ids(k,value) select 'values',jsonb_build_object('carrier_id',(select id from tests.freight_ids where k='carrier'),'driver_id',(select id from tests.freight_ids where k='driver'),
 'vehicle_id',(select id from tests.freight_ids where k='vehicle'),'pallet_tare_kg','25','origin',jsonb_build_object('address','Актобе','confirmed',true),'destination',jsonb_build_object('address','Склад покупателя','confirmed',true));
insert into tests.freight_ids(k,id) select 'trip',public.save_freight_trip(gen_random_uuid(),null,0,'sale',array['fc300000-0000-4000-8000-000000000001'::uuid,'fc300000-0000-4000-8000-000000000002'::uuid],value,
 public.preview_freight_trip('sale',array['fc300000-0000-4000-8000-000000000001'::uuid,'fc300000-0000-4000-8000-000000000002'::uuid],value)->>'digest','Оба заказа') from tests.freight_ids where k='values';
insert into tests.freight_ids(k,value) select 'preview',public.preview_freight_trip('sale',array['fc300000-0000-4000-8000-000000000002'::uuid],value) from tests.freight_ids where k='values';
savepoint completed_old_operation;
reset role;
set local session_replication_role=replica;
update public.sales set status='shipped' where id='fc300000-0000-4000-8000-000000000001';
set local session_replication_role=origin;
set local role authenticated;
select tests.freight_fails($q$select public.save_freight_trip(gen_random_uuid(),(select id from tests.freight_ids where k='trip'),1,'sale',array['fc300000-0000-4000-8000-000000000002'::uuid],(select value from tests.freight_ids where k='values'),(select value->>'digest' from tests.freight_ids where k='preview'),'Убрать уже проведённый заказ')$q$,'недоступен');
rollback to completed_old_operation;
select public.save_freight_trip(gen_random_uuid(),(select id from tests.freight_ids where k='trip'),1,'sale',array['fc300000-0000-4000-8000-000000000002'::uuid],(select value from tests.freight_ids where k='values'),(select value->>'digest' from tests.freight_ids where k='preview'),'Первый заказ исключён из рейса');
reset role;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'fc000000-0000-4000-8000-000000000001',id,'deny','History access test','fc000000-0000-4000-8000-000000000001' from public.permissions where code='customers.view';
set local role authenticated;
do $$declare result jsonb;begin
 result:=public.freight_trips((select id from tests.freight_ids where k='trip'));
 assert result->>'history_hidden'='true';
 assert jsonb_array_length(result->'history')=1;
 assert result::text not like '%TEST-FREIGHT-SALE-1%';
 assert result::text like '%TEST-FREIGHT-SALE-2%';
end$$;
select tests.freight_fails($q$select public.save_freight_trip(gen_random_uuid(),null,0,'sale',array_fill('fc300000-0000-4000-8000-000000000002'::uuid,array[31]),'{}','no','Too many operations')$q$,'Выберите вид');
reset role;
do $$begin assert tests.freight_business()=(select value from tests.freight_ids where k='before');end$$;
rollback;
