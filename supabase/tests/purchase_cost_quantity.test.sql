\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('ed000000-0000-4000-8000-000000000001','historical-cost@example.invalid','{"full_name":"Synthetic Cost Operator"}');
insert into public.user_roles(user_id,role_id)
 select 'ed000000-0000-4000-8000-000000000001',id from public.app_roles where code='director';
select set_config('request.jwt.claim.sub','ed000000-0000-4000-8000-000000000001',true);
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('ed100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Synthetic Paid Supplier','KZ','SYNTH-PAID');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('ed200000-0000-4000-8000-000000000001','SYNTH-PAID-100','{"ru":"Синтетический товар"}','ed100000-0000-4000-8000-000000000001','active');
insert into public.shipments(id,shipment_number,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
 select 'ed300000-0000-4000-8000-000000000001','SYNTH-PAID-100','import','ed100000-0000-4000-8000-000000000001',
 (select id from public.routes limit 1),(select id from public.process_templates where code='import_eu_kz' and version=1),
 (select id from public.currencies where code='EUR'),(select id from public.warehouses where status='active' and not is_virtual limit 1),
 'ed000000-0000-4000-8000-000000000001','ed000000-0000-4000-8000-000000000001';
-- Already-received state is fixture setup, not evidence of the receiving UI.
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity,confirmed_quantity,shipped_quantity,received_quantity,unit_price,currency_id)
 values ('ed400000-0000-4000-8000-000000000001','ed300000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000001','piece',100,100,100,98,10,(select id from public.currencies where code='EUR'));
create temp table diagnostic_ids(k text primary key,id uuid);
grant all on diagnostic_ids to authenticated;
set local role authenticated;
insert into diagnostic_ids select 'goods',public.create_expense('ed300000-0000-4000-8000-000000000001','goods_cost',
 'ed100000-0000-4000-8000-000000000001',1000,(select id from public.currencies where code='EUR'),'2099-01-10',false,null,'Synthetic: paid 100 units at 10');
select public.confirm_expense((select id from diagnostic_ids where k='goods'));
select public.allocate_expense((select id from diagnostic_ids where k='goods'),'by_quantity',(select id from public.currencies where code='EUR'));
select public.mark_expense_paid((select id from diagnostic_ids where k='goods'));
insert into diagnostic_ids select 'cost',public.calculate_shipment_cost('ed300000-0000-4000-8000-000000000001',(select id from public.currencies where code='EUR'));

do $$begin
 assert (select quantity=98 and cost_quantity=100 and cost_quantity_basis='shipped'
  and goods_amount=1000 and unit_landed_cost=10 and landed_amount=1000
  from public.cost_calculation_items where calculation_id=(select id from diagnostic_ids where k='cost')),
  'Paid 100 units must not be redistributed over 98 received units';
 assert (select received_quantity=98 and shipped_quantity=100 from public.shipment_items where id='ed400000-0000-4000-8000-000000000001');
 assert (select status='paid' from public.expenses where id=(select id from diagnostic_ids where k='goods'));
 assert not exists(select 1 from public.inventory_movements m join public.inventory_batches b on b.id=m.batch_id
  where b.product_id='ed200000-0000-4000-8000-000000000001');
end $$;
select public.approve_shipment_cost((select id from diagnostic_ids where k='cost'));
create temp table approved_snapshot as select to_jsonb(i) item from public.cost_calculation_items i where calculation_id=(select id from diagnostic_ids where k='cost');
-- Transport expenses are also divided by documented purchase quantity, not good receipt.
insert into diagnostic_ids select 'freight',public.create_expense('ed300000-0000-4000-8000-000000000001','transport',
 null,100,(select id from public.currencies where code='EUR'),'2099-01-10',false,null,'Synthetic freight');
select public.confirm_expense((select id from diagnostic_ids where k='freight'));
select public.allocate_expense((select id from diagnostic_ids where k='freight'),'by_quantity',(select id from public.currencies where code='EUR'));
insert into diagnostic_ids select 'cost2',public.calculate_shipment_cost('ed300000-0000-4000-8000-000000000001',(select id from public.currencies where code='EUR'));
do $$begin
 assert (select quantity=98 and cost_quantity=100 and unit_landed_cost=11 and landed_amount=1100
 from public.cost_calculation_items where calculation_id=(select id from diagnostic_ids where k='cost2'));
 assert (select to_jsonb(i)=(select item from approved_snapshot) from public.cost_calculation_items i where calculation_id=(select id from diagnostic_ids where k='cost')),
  'A new calculation must not rewrite the approved snapshot';
end $$;
reset role;
update public.shipment_items set shipped_quantity=99 where id='ed400000-0000-4000-8000-000000000001';
set local role authenticated;
do $$begin
 begin
  perform public.approve_shipment_cost((select id from diagnostic_ids where k='cost2'));
  raise exception 'FAIL: stale purchase quantity was approved';
 exception when others then
  if sqlerrm not like 'После расчёта изменились расходы или позиции поставки%' then raise;end if;
 end;
end $$;
reset role;
-- Explicit zero is invalid purchase evidence; it must not silently fall back to 100.
update public.shipment_items set shipped_quantity=0 where id='ed400000-0000-4000-8000-000000000001';
set local role authenticated;
do $$begin
 begin
  perform public.calculate_shipment_cost('ed300000-0000-4000-8000-000000000001',(select id from public.currencies where code='EUR'));
  raise exception 'FAIL: explicit zero ignored';
 exception when others then
  if sqlerrm not like 'Укажите количество закупки%' then raise;end if;
 end;
end $$;
reset role;
update public.shipment_items set shipped_quantity=null where id='ed400000-0000-4000-8000-000000000001';
set local role authenticated;
insert into diagnostic_ids select 'confirmed',public.calculate_shipment_cost('ed300000-0000-4000-8000-000000000001',(select id from public.currencies where code='EUR'));
do $$begin
 assert (select cost_quantity=100 and cost_quantity_basis='confirmed' and unit_landed_cost=11
 from public.cost_calculation_items where calculation_id=(select id from diagnostic_ids where k='confirmed'));
end $$;
reset role;
update public.shipment_items set confirmed_quantity=null where id='ed400000-0000-4000-8000-000000000001';
set local role authenticated;
insert into diagnostic_ids select 'ordered',public.calculate_shipment_cost('ed300000-0000-4000-8000-000000000001',(select id from public.currencies where code='EUR'));
do $$begin
 assert (select cost_quantity=100 and cost_quantity_basis='ordered' and unit_landed_cost=11
 from public.cost_calculation_items where calculation_id=(select id from diagnostic_ids where k='ordered'));
end $$;
rollback;
