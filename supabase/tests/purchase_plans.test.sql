-- Purchase plans: packaging, two-step approval and shipment traceability.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('fb000000-0000-4000-8000-000000000001','plan-logistics@test.local','{"full_name":"Plan Logistics"}'),
 ('fb000000-0000-4000-8000-000000000002','plan-director@test.local','{"full_name":"Plan Director"}'),
 ('fb000000-0000-4000-8000-000000000003','plan-admin@test.local','{"full_name":"Plan Administrator"}'),
 ('fb000000-0000-4000-8000-000000000004','plan-commercial@test.local','{"full_name":"Plan Commercial"}');
insert into public.user_roles(user_id,role_id)
select u.id::uuid,r.id from (values
 ('fb000000-0000-4000-8000-000000000001','logistics_director'),
 ('fb000000-0000-4000-8000-000000000002','director'),
 ('fb000000-0000-4000-8000-000000000003','administrator'),
 ('fb000000-0000-4000-8000-000000000004','commercial_director'))u(id,role_code)
join public.app_roles r on r.code=u.role_code;

insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('fb100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Plan Factory','FI','PLAN-SUP'),
 ('fb100000-0000-4000-8000-000000000002',array['customer'],'Plan Customer','KZ','PLAN-CUS');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('fb200000-0000-4000-8000-000000000001','PLAN-001','{"ru":"Товар плана закупок"}','fb100000-0000-4000-8000-000000000001','active');

set role authenticated;
select set_config('request.jwt.claim.sub','fb000000-0000-4000-8000-000000000001',false);
select public.create_forecast('Источник плана','base','2027-04-01','2027-06-30','month','manual');
select public.upsert_forecast_line((select id from public.forecasts where name='Источник плана'),'fb200000-0000-4000-8000-000000000001','fb100000-0000-4000-8000-000000000002',null,'2027-04-01',125,5,'Спрос');
select public.submit_forecast((select id from public.forecasts where name='Источник плана'));
select set_config('request.jwt.claim.sub','fb000000-0000-4000-8000-000000000004',false);
select public.review_forecast((select id from public.forecasts where name='Источник плана'),true,'Проверено');
select set_config('request.jwt.claim.sub','fb000000-0000-4000-8000-000000000002',false);
select public.approve_forecast((select id from public.forecasts where name='Источник плана'));

select set_config('request.jwt.claim.sub','fb000000-0000-4000-8000-000000000001',false);
select public.create_purchase_plan('Закупка Финляндия',(select id from public.forecasts where name='Источник плана'),'fb100000-0000-4000-8000-000000000001');
select public.upsert_purchase_plan_line((select id from public.purchase_plans where name='Закупка Финляндия'),'fb200000-0000-4000-8000-000000000001',30,10,5,12,4,131,'box',12,132,'2027-02-15','Ручное решение до утверждения формулы');
do $$begin
 assert (select forecast_demand=130 and rounded_quantity=132 and approved_quantity=132 from public.purchase_plan_lines where purchase_plan_id=(select id from public.purchase_plans where name='Закупка Финляндия')),'forecast demand and packaging rounding';
 begin perform public.upsert_purchase_plan_line((select id from public.purchase_plans where name='Закупка Финляндия'),'fb200000-0000-4000-8000-000000000001',30,10,5,12,4,131,'box',12,131,null,null);raise exception 'accepted non-multiple' using errcode='P0099';exception when sqlstate 'P0099' then raise;when others then assert position('кратно упаковке' in sqlerrm)>0,'approved quantity must follow packaging';end;
end$$;
select public.submit_purchase_plan((select id from public.purchase_plans where name='Закупка Финляндия'));
select public.review_purchase_plan((select id from public.purchase_plans where name='Закупка Финляндия'),true,'Логистика проверила');

select set_config('request.jwt.claim.sub','fb000000-0000-4000-8000-000000000002',false);
select public.approve_purchase_plan((select id from public.purchase_plans where name='Закупка Финляндия'));
do $$begin assert (select status='approved' and logistic_reviewed_at is not null and approved_at is not null from public.purchase_plans where name='Закупка Финляндия'),'plan approved in two steps';end$$;

select set_config('request.jwt.claim.sub','fb000000-0000-4000-8000-000000000001',false);
select public.create_purchase_plan_shipment(
 (select id from public.purchase_plans where name='Закупка Финляндия'),
 (select id from public.routes where status='active' limit 1),(select id from public.currencies where code='EUR'),
 (select id from public.warehouses where status='active' and not is_virtual limit 1),'fb000000-0000-4000-8000-000000000001','2027-02-20','2027-03-20');
do $$declare v_shipment uuid;begin
 select shipment_id into v_shipment from public.purchase_plan_lines where purchase_plan_id=(select id from public.purchase_plans where name='Закупка Финляндия');
 assert v_shipment is not null and (select status='ordered' from public.purchase_plans where name='Закупка Финляндия'),'plan linked and ordered';
 assert (select ordered_quantity=132 and product_id='fb200000-0000-4000-8000-000000000001' from public.shipment_items where shipment_id=v_shipment),'shipment item copied from plan';
 assert (select count(*)=18 from public.shipment_stage_runs where shipment_id=v_shipment),'RVI stages created';
end$$;

select set_config('request.jwt.claim.sub','fb000000-0000-4000-8000-000000000003',false);
do $$begin assert (select count(*)=1 from public.purchase_plans where name='Закупка Финляндия'),'administrator sees plan status';assert (select count(*)=0 from public.purchase_plan_lines),'administrator cannot see plan details';end$$;

reset role;
rollback;
