-- Shipment expenses, allocation, versioned landed cost and approval.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('b6800000-0000-4000-8000-000000000001','expense-cancellation-history-director@test.local','{"full_name":"Finance Director"}'),
 ('b6800000-0000-4000-8000-000000000002','expense-cancellation-history-accountant@test.local','{"full_name":"Finance Accountant"}'),
 ('b6800000-0000-4000-8000-000000000003','expense-cancellation-history-logistic@test.local','{"full_name":"Finance Logistic"}');
insert into public.user_roles(user_id,role_id)
select u.id::uuid,r.id from (values
 ('b6800000-0000-4000-8000-000000000001','director'),('b6800000-0000-4000-8000-000000000002','accountant'),('b6800000-0000-4000-8000-000000000003','logistics_specialist'))u(id,role_code) join public.app_roles r on r.code=u.role_code;

insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('b6810000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Finance Supplier','FI','ECH-SUP'),
 ('b6810000-0000-4000-8000-000000000002',array['carrier'],'Finance Carrier','KZ','ECH-CAR');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('b6820000-0000-4000-8000-000000000001','ECH-001','{"ru":"Финансовый тестовый товар"}','b6810000-0000-4000-8000-000000000001','active');

select set_config('request.jwt.claim.sub','b6800000-0000-4000-8000-000000000001',false);
insert into public.shipments(id,shipment_number,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select 'b6830000-0000-4000-8000-000000000001','ECH-SHIP-001','import','b6810000-0000-4000-8000-000000000001',(select id from public.routes limit 1),(select id from public.process_templates where code='import_eu_kz' and version=1),(select id from public.currencies where code='EUR'),(select id from public.warehouses where status='active' and not is_virtual limit 1),'b6800000-0000-4000-8000-000000000003','b6800000-0000-4000-8000-000000000001';
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity,received_quantity,unit_price,currency_id) values
 ('b6840000-0000-4000-8000-000000000001','b6830000-0000-4000-8000-000000000001','b6820000-0000-4000-8000-000000000001','piece',10,10,2,(select id from public.currencies where code='EUR'));
insert into public.inventory_batches(id,product_id,source_shipment_item_id,batch_number,expiry_date,created_by) values
 ('b6850000-0000-4000-8000-000000000001','b6820000-0000-4000-8000-000000000001','b6840000-0000-4000-8000-000000000001','ECH-BATCH','2027-12-31','b6800000-0000-4000-8000-000000000001');



insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('b6820000-0000-4000-8000-000000000002','ECH-002','{"ru":"Второй товар"}','b6810000-0000-4000-8000-000000000001','active'),
 ('b6820000-0000-4000-8000-000000000003','ECH-003','{"ru":"Нулевая позиция"}','b6810000-0000-4000-8000-000000000001','active');
insert into public.product_packaging(product_id,uom,units_per_parent,gross_weight_kg,volume_m3,length_cm,width_cm,height_cm) values
 ('b6820000-0000-4000-8000-000000000001','piece',1,2,0.1,null,null,null),
 ('b6820000-0000-4000-8000-000000000002','piece',1,4,null,100,100,20)
on conflict(product_id,uom) do update set gross_weight_kg=excluded.gross_weight_kg,volume_m3=excluded.volume_m3,length_cm=excluded.length_cm,width_cm=excluded.width_cm,height_cm=excluded.height_cm;
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity,shipped_quantity,received_quantity,unit_price,currency_id) values
 ('b6840000-0000-4000-8000-000000000002','b6830000-0000-4000-8000-000000000001','b6820000-0000-4000-8000-000000000002','piece',25,20,null,3,(select id from public.currencies where code='EUR')),
 ('b6840000-0000-4000-8000-000000000003','b6830000-0000-4000-8000-000000000001','b6820000-0000-4000-8000-000000000003','box',1,1,0,null,(select id from public.currencies where code='EUR'));

update public.shipment_items set ordered_quantity=100,shipped_quantity=100,received_quantity=98 where id='b6840000-0000-4000-8000-000000000001';
update public.shipment_items set shipped_quantity=0 where id='b6840000-0000-4000-8000-000000000002';
create temporary table cap(id uuid,token uuid,p jsonb,expense uuid);
grant all on cap to authenticated;
set role authenticated;
do $$declare eid uuid;begin
 eid:=public.create_expense('b6830000-0000-4000-8000-000000000001','goods_cost',null,1000,(select id from public.currencies where code='EUR'),'2026-10-24',false,null,'Purchase 100');
 perform public.confirm_expense(eid);
 perform public.allocate_expense(eid,'by_quantity',(select id from public.currencies where code='EUR'));
 insert into cap values(gen_random_uuid(),null,jsonb_build_object('shipment_id','b6830000-0000-4000-8000-000000000001','target_currency_id',(select id from public.currencies where code='EUR')),eid);
end $$;
 reset role;

insert into public.inventory_batches(id,product_id,source_shipment_item_id,batch_number,expiry_date,created_by)
values('b6850000-0000-4000-8000-000000000002','b6820000-0000-4000-8000-000000000001','b6840000-0000-4000-8000-000000000001','ECH-SECOND','2027-12-31',auth.uid()),
('b6850000-0000-4000-8000-000000000003','b6820000-0000-4000-8000-000000000002','b6840000-0000-4000-8000-000000000002','ECH-UNRELATED','2027-12-31',auth.uid());
alter table cap add column previous_id uuid;
alter table cap add column calculation_id uuid;
update cap set previous_id=public.calculate_shipment_cost((p->>'shipment_id')::uuid,(p->>'target_currency_id')::uuid);
select public.approve_shipment_cost(previous_id) from cap;
update public.expenses set amount=1100 where id=(select expense from cap);
update public.expense_allocations set allocated_amount=1100 where expense_id=(select expense from cap);
update cap set calculation_id=public.calculate_shipment_cost((p->>'shipment_id')::uuid,(p->>'target_currency_id')::uuid);
update cap set p=jsonb_build_object('calculation_id',calculation_id);

create temporary table history_versions as select c.* from public.cost_calculations c where shipment_id='b6830000-0000-4000-8000-000000000001';
create temporary table history_batches as select b.* from public.inventory_batches b where source_shipment_item_id in(select id from public.shipment_items where shipment_id='b6830000-0000-4000-8000-000000000001');
create temporary table history_allocations as select a.* from public.expense_allocations a where expense_id=(select expense from cap);
set role authenticated;
do $$declare v jsonb;c cap;begin
 select * into c from cap;
 perform public.prepare_assistant_operation(c.id,'expense_cancel',jsonb_build_object('expense_id',c.expense,'reason','Duplicate goods invoice'));
 v:=public.review_assistant_operation(c.id);
 assert v->'preview'->>'status'='allocated' and v->'preview'->>'allocation_count'='1';
 perform public.confirm_assistant_operation(c.id,(v->>'review_token')::uuid);
end $$;
reset role;
do $$begin
 assert not exists((select * from history_versions except select * from public.cost_calculations)
 union all (select * from public.cost_calculations where shipment_id='b6830000-0000-4000-8000-000000000001' except select * from history_versions));
 assert not exists(select * from history_batches except select * from public.inventory_batches);
 assert not exists(select * from history_allocations except select * from public.expense_allocations);
 assert (select inputs_digest from public.cost_calculations where id=(select calculation_id from cap)) <> private.shipment_cost_inputs_digest('b6830000-0000-4000-8000-000000000001');
 begin
  perform public.approve_shipment_cost((select calculation_id from cap));
  raise exception 'Expected stale calculation refusal';
 exception when others then
  if sqlerrm='Expected stale calculation refusal' then raise;end if;
 end;
 assert (select status='draft' from public.cost_calculations where id=(select calculation_id from cap));
 assert (select status='cancelled' and paid_at is null and reversed_at is null from public.expenses where id=(select expense from cap));
end $$;
rollback;
