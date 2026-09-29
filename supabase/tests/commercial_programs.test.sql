-- Promotions, forecast uplift, special programs and exact-batch low-shelf-life clearance.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('fc000000-0000-4000-8000-000000000001','program-marketer@test.local','{"full_name":"Program Marketer"}'),
 ('fc000000-0000-4000-8000-000000000002','program-commercial@test.local','{"full_name":"Program Commercial"}'),
 ('fc000000-0000-4000-8000-000000000003','program-director@test.local','{"full_name":"Program Director"}'),
 ('fc000000-0000-4000-8000-000000000004','program-admin@test.local','{"full_name":"Program Administrator"}');
insert into public.user_roles(user_id,role_id)
select u.id::uuid,r.id from (values
 ('fc000000-0000-4000-8000-000000000001','marketer'),
 ('fc000000-0000-4000-8000-000000000002','commercial_director'),
 ('fc000000-0000-4000-8000-000000000003','director'),
 ('fc000000-0000-4000-8000-000000000004','administrator'))u(id,role_code) join public.app_roles r on r.code=u.role_code;

insert into public.counterparties(id,roles,legal_name,country,tax_id,min_remaining_shelf_life_pct) values
 ('fc100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Program Factory','FI','PROGRAM-SUP',null),
 ('fc100000-0000-4000-8000-000000000002',array['customer'],'Program Customer','KZ','PROGRAM-CUS',60);
insert into public.products(id,internal_sku,name,manufacturer_id,status,shelf_life_days) values
 ('fc200000-0000-4000-8000-000000000001','PROGRAM-001','{"ru":"Товар коммерческой программы"}','fc100000-0000-4000-8000-000000000001','active',365);
create temporary table program_context(warehouse_id uuid,balance_id uuid,promo_id uuid,clearance_id uuid,forecast_id uuid,sale_id uuid);
grant select,insert,update on program_context to authenticated;
insert into program_context(warehouse_id) select id from public.warehouses where status='active' and not is_virtual order by code limit 1;
insert into public.inventory_batches(id,product_id,batch_number,manufacture_date,expiry_date,created_by) values
 ('fc300000-0000-4000-8000-000000000001','fc200000-0000-4000-8000-000000000001','PROGRAM-LOW-OSG',current_date-300,current_date+65,'fc000000-0000-4000-8000-000000000003');
insert into public.inventory_balances(id,batch_id,warehouse_id,uom,quantity_on_hand)
select 'fc400000-0000-4000-8000-000000000001','fc300000-0000-4000-8000-000000000001',warehouse_id,'piece',80 from program_context;
update program_context set balance_id='fc400000-0000-4000-8000-000000000001';

set role authenticated;
select set_config('request.jwt.claim.sub','fc000000-0000-4000-8000-000000000001',false);
update program_context set forecast_id=public.create_forecast(
  'Прогноз с промо',
  'base',
  date_trunc('month',current_date)::date,
  (date_trunc('month',current_date)+interval '3 months - 1 day')::date,
  'month',
  'manual'
);
update program_context set promo_id=public.create_commercial_program('Осеннее промо','promotion','fc100000-0000-4000-8000-000000000002',current_date+5,current_date+35);
select public.upsert_commercial_program_line(promo_id,'fc200000-0000-4000-8000-000000000001',null,25,25,'piece',10,null,null,null,'Промо-прирост') from program_context;
select public.submit_commercial_program(promo_id) from program_context;

select set_config('request.jwt.claim.sub','fc000000-0000-4000-8000-000000000002',false);
select public.review_commercial_program(promo_id,true,'Коммерчески проверено') from program_context;
select set_config('request.jwt.claim.sub','fc000000-0000-4000-8000-000000000003',false);
select public.approve_commercial_program(promo_id) from program_context;

select set_config('request.jwt.claim.sub','fc000000-0000-4000-8000-000000000001',false);
select public.apply_commercial_program_to_forecast(promo_id,forecast_id,date_trunc('month',current_date)::date,null) from program_context;
do $$begin
 assert (select promo_uplift_quantity=25 and final_quantity=25 from public.forecast_lines where forecast_id=(select forecast_id from program_context)),'approved promo is copied into draft forecast';
 assert (select forecast_line_id is not null from public.commercial_program_lines where commercial_program_id=(select promo_id from program_context)),'promo line keeps forecast traceability';
end$$;

update program_context set clearance_id=public.create_commercial_program('Распределение низкого ОСГ','low_shelf_life','fc100000-0000-4000-8000-000000000002',current_date+10,current_date+30);
select public.upsert_commercial_program_line(clearance_id,'fc200000-0000-4000-8000-000000000001',balance_id,20,0,'piece',20,null,null,60,'Согласовать гарантийное письмо') from program_context;
do $$begin assert (select remaining_shelf_life_pct<60 from public.commercial_program_lines where commercial_program_id=(select clearance_id from program_context)),'low shelf life is snapshotted';end$$;
select public.submit_commercial_program(clearance_id) from program_context;
select set_config('request.jwt.claim.sub','fc000000-0000-4000-8000-000000000002',false);
select public.review_commercial_program(clearance_id,true,'Клиент и партия проверены') from program_context;
select set_config('request.jwt.claim.sub','fc000000-0000-4000-8000-000000000003',false);
select public.approve_commercial_program(clearance_id) from program_context;
select set_config('request.jwt.claim.sub','fc000000-0000-4000-8000-000000000002',false);
update program_context set sale_id=public.create_sale_from_commercial_program(clearance_id,warehouse_id,current_date+10,(select id from public.currencies where code='KZT'),null);
do $$begin
 assert (select status='ordered' and sale_id=(select sale_id from program_context) from public.commercial_programs where id=(select clearance_id from program_context)),'clearance is linked to the sale';
 assert (select status='reserved' from public.sales where id=(select sale_id from program_context)),'clearance sale is reserved';
 assert (select r.inventory_balance_id=(select balance_id from program_context) and r.quantity=20 and r.is_fefo_override from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id where i.sale_id=(select sale_id from program_context) and r.status='active'),'approved exact batch is reserved';
 assert (select quantity_reserved=20 from public.inventory_balances where id=(select balance_id from program_context)),'stock reservation is reflected in balance';
end$$;

select set_config('request.jwt.claim.sub','fc000000-0000-4000-8000-000000000004',false);
do $$begin assert (select count(*)=2 from public.commercial_programs),'administrator sees statuses';assert (select count(*)=0 from public.commercial_program_lines),'administrator cannot see commercial details';end$$;

reset role;
rollback;
