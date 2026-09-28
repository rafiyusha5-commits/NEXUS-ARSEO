-- Versioned sales forecasts: permissions, approval and immutability.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('fa000000-0000-4000-8000-000000000001','forecast-commercial@test.local','{"full_name":"Forecast Commercial"}'),
 ('fa000000-0000-4000-8000-000000000002','forecast-director@test.local','{"full_name":"Forecast Director"}'),
 ('fa000000-0000-4000-8000-000000000003','forecast-accountant@test.local','{"full_name":"Forecast Accountant"}');
insert into public.user_roles(user_id,role_id)
select u.id::uuid,r.id from (values
 ('fa000000-0000-4000-8000-000000000001','commercial_director'),
 ('fa000000-0000-4000-8000-000000000002','director'),
 ('fa000000-0000-4000-8000-000000000003','accountant'))u(id,role_code)
join public.app_roles r on r.code=u.role_code;

insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('fa100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Forecast Factory','FI','FORECAST-SUP'),
 ('fa100000-0000-4000-8000-000000000002',array['customer'],'Forecast Customer','KZ','FORECAST-CUS');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('fa200000-0000-4000-8000-000000000001','FORECAST-001','{"ru":"Тестовый товар прогноза"}','fa100000-0000-4000-8000-000000000001','active');

set role authenticated;
select set_config('request.jwt.claim.sub','fa000000-0000-4000-8000-000000000001',false);
select public.create_forecast('План продаж 2027','base','2027-01-01','2027-03-31','month','manual');
select public.upsert_forecast_line(
 (select id from public.forecasts where name='План продаж 2027'),
 'fa200000-0000-4000-8000-000000000001','fa100000-0000-4000-8000-000000000002',null,
 '2027-01-01',100,15,'Промо января');
select public.submit_forecast((select id from public.forecasts where name='План продаж 2027'));
do $$begin
 assert (select status='in_review' from public.forecasts where name='План продаж 2027'),'draft submitted';
 begin perform public.upsert_forecast_line((select id from public.forecasts where name='План продаж 2027'),'fa200000-0000-4000-8000-000000000001','fa100000-0000-4000-8000-000000000002',null,'2027-01-01',200,0,null);raise exception 'changed submitted forecast' using errcode='P0099';exception when sqlstate 'P0099' then raise;when others then assert position('только черновик' in sqlerrm)>0,'submitted forecast immutable';end;
end$$;
select public.review_forecast((select id from public.forecasts where name='План продаж 2027'),true,'Проверено коммерческим директором');

select set_config('request.jwt.claim.sub','fa000000-0000-4000-8000-000000000002',false);
select public.approve_forecast((select id from public.forecasts where name='План продаж 2027'));
do $$begin
 assert (select status='approved' and commercial_reviewed_at is not null and approved_at is not null from public.forecasts where name='План продаж 2027'),'forecast approved after two-step review';
 assert (select final_quantity=115 from public.forecast_lines where forecast_id=(select id from public.forecasts where name='План продаж 2027')),'final quantity generated';
end$$;

select set_config('request.jwt.claim.sub','fa000000-0000-4000-8000-000000000001',false);
select public.create_forecast_version((select id from public.forecasts where name='План продаж 2027' and version=1));
do $$begin
 assert (select count(*)=2 and max(version)=2 from public.forecasts where name='План продаж 2027'),'second version created';
 assert (select count(*)=1 from public.forecast_lines where forecast_id=(select id from public.forecasts where name='План продаж 2027' and version=2) and final_quantity=115),'approved lines copied';
end$$;

select set_config('request.jwt.claim.sub','fa000000-0000-4000-8000-000000000003',false);
do $$begin
 assert (select count(*)=2 from public.forecasts where name='План продаж 2027'),'accountant sees forecast headers';
 assert (select count(*)=2 from public.forecast_lines),'accountant sees details';
 begin perform public.create_forecast('Запрещённый','base','2027-01-01','2027-01-31','month','manual');raise exception 'accountant created forecast' using errcode='P0099';exception when sqlstate 'P0099' then raise;when others then assert position('Нет права' in sqlerrm)>0,'accountant cannot create';end;
end$$;

reset role;
rollback;
