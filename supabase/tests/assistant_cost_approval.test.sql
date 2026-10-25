-- Shipment expenses, allocation, versioned landed cost and approval.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('b6600000-0000-4000-8000-000000000001','assistant-cost-approval-director@test.local','{"full_name":"Finance Director"}'),
 ('b6600000-0000-4000-8000-000000000002','assistant-cost-approval-accountant@test.local','{"full_name":"Finance Accountant"}'),
 ('b6600000-0000-4000-8000-000000000003','assistant-cost-approval-logistic@test.local','{"full_name":"Finance Logistic"}');
insert into public.user_roles(user_id,role_id)
select u.id::uuid,r.id from (values
 ('b6600000-0000-4000-8000-000000000001','director'),('b6600000-0000-4000-8000-000000000002','accountant'),('b6600000-0000-4000-8000-000000000003','logistics_specialist'))u(id,role_code) join public.app_roles r on r.code=u.role_code;

insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('b6610000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Finance Supplier','FI','CAP-SUP'),
 ('b6610000-0000-4000-8000-000000000002',array['carrier'],'Finance Carrier','KZ','CAP-CAR');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('b6620000-0000-4000-8000-000000000001','CAP-001','{"ru":"Финансовый тестовый товар"}','b6610000-0000-4000-8000-000000000001','active');

select set_config('request.jwt.claim.sub','b6600000-0000-4000-8000-000000000001',false);
insert into public.shipments(id,shipment_number,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select 'b6630000-0000-4000-8000-000000000001','CAP-SHIP-001','import','b6610000-0000-4000-8000-000000000001',(select id from public.routes limit 1),(select id from public.process_templates where code='import_eu_kz' and version=1),(select id from public.currencies where code='EUR'),(select id from public.warehouses where status='active' and not is_virtual limit 1),'b6600000-0000-4000-8000-000000000003','b6600000-0000-4000-8000-000000000001';
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity,received_quantity,unit_price,currency_id) values
 ('b6640000-0000-4000-8000-000000000001','b6630000-0000-4000-8000-000000000001','b6620000-0000-4000-8000-000000000001','piece',10,10,2,(select id from public.currencies where code='EUR'));
insert into public.inventory_batches(id,product_id,source_shipment_item_id,batch_number,expiry_date,created_by) values
 ('b6650000-0000-4000-8000-000000000001','b6620000-0000-4000-8000-000000000001','b6640000-0000-4000-8000-000000000001','CAP-BATCH','2027-12-31','b6600000-0000-4000-8000-000000000001');



insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('b6620000-0000-4000-8000-000000000002','CAP-002','{"ru":"Второй товар"}','b6610000-0000-4000-8000-000000000001','active'),
 ('b6620000-0000-4000-8000-000000000003','CAP-003','{"ru":"Нулевая позиция"}','b6610000-0000-4000-8000-000000000001','active');
insert into public.product_packaging(product_id,uom,units_per_parent,gross_weight_kg,volume_m3,length_cm,width_cm,height_cm) values
 ('b6620000-0000-4000-8000-000000000001','piece',1,2,0.1,null,null,null),
 ('b6620000-0000-4000-8000-000000000002','piece',1,4,null,100,100,20)
on conflict(product_id,uom) do update set gross_weight_kg=excluded.gross_weight_kg,volume_m3=excluded.volume_m3,length_cm=excluded.length_cm,width_cm=excluded.width_cm,height_cm=excluded.height_cm;
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity,shipped_quantity,received_quantity,unit_price,currency_id) values
 ('b6640000-0000-4000-8000-000000000002','b6630000-0000-4000-8000-000000000001','b6620000-0000-4000-8000-000000000002','piece',25,20,null,3,(select id from public.currencies where code='EUR')),
 ('b6640000-0000-4000-8000-000000000003','b6630000-0000-4000-8000-000000000001','b6620000-0000-4000-8000-000000000003','box',1,1,0,null,(select id from public.currencies where code='EUR'));

update public.shipment_items set ordered_quantity=100,shipped_quantity=100,received_quantity=98 where id='b6640000-0000-4000-8000-000000000001';
update public.shipment_items set shipped_quantity=0 where id='b6640000-0000-4000-8000-000000000002';
create temporary table cap(id uuid,token uuid,p jsonb,expense uuid);
grant all on cap to authenticated;
set role authenticated;
do $$declare eid uuid;begin
 eid:=public.create_expense('b6630000-0000-4000-8000-000000000001','goods_cost',null,1000,(select id from public.currencies where code='EUR'),'2026-10-24',false,null,'Purchase 100');
 perform public.confirm_expense(eid);
 perform public.allocate_expense(eid,'by_quantity',(select id from public.currencies where code='EUR'));
 insert into cap values(gen_random_uuid(),null,jsonb_build_object('shipment_id','b6630000-0000-4000-8000-000000000001','target_currency_id',(select id from public.currencies where code='EUR')),eid);
end $$;
 reset role;

insert into public.inventory_batches(id,product_id,source_shipment_item_id,batch_number,expiry_date,created_by)
values('b6650000-0000-4000-8000-000000000002','b6620000-0000-4000-8000-000000000001','b6640000-0000-4000-8000-000000000001','CAP-SECOND','2027-12-31',auth.uid()),
('b6650000-0000-4000-8000-000000000003','b6620000-0000-4000-8000-000000000002','b6640000-0000-4000-8000-000000000002','CAP-UNRELATED','2027-12-31',auth.uid());
alter table cap add column previous_id uuid;
alter table cap add column calculation_id uuid;
update cap set previous_id=public.calculate_shipment_cost((p->>'shipment_id')::uuid,(p->>'target_currency_id')::uuid);
select public.approve_shipment_cost(previous_id) from cap;
update public.expenses set amount=1100 where id=(select expense from cap);
update public.expense_allocations set allocated_amount=1100 where expense_id=(select expense from cap);
update cap set calculation_id=public.calculate_shipment_cost((p->>'shipment_id')::uuid,(p->>'target_currency_id')::uuid);
update cap set p=jsonb_build_object('calculation_id',calculation_id);
-- APPROVAL FIXTURE END

create function pg_temp.fails(q text,pattern text) returns void language plpgsql as $$
begin begin execute q;exception when others then
 if sqlerrm !~ pattern then raise exception 'Expected %, got %',pattern,sqlerrm;end if;return;
end;raise exception 'Expected failure: %',pattern;end $$;
-- No linked batches is an explicit consequence, not a truncated result.
savepoint no_batches;
delete from public.inventory_batches where product_id='b6620000-0000-4000-8000-000000000001';
do $$declare rid uuid:=gen_random_uuid();v jsonb;begin
 perform public.prepare_assistant_operation(rid,'shipment_cost_approve',(select p from cap));
 v:=public.review_assistant_operation(rid);assert jsonb_array_length(v->'preview'->'batches')=0;
 perform public.confirm_assistant_operation(rid,(v->>'review_token')::uuid);
 assert (select status='approved' from public.cost_calculations where id=(select calculation_id from cap));
end $$;
rollback to no_batches;
savepoint too_many_batches;
insert into public.inventory_batches(id,product_id,source_shipment_item_id,batch_number,expiry_date,created_by)
select gen_random_uuid(),'b6620000-0000-4000-8000-000000000001','b6640000-0000-4000-8000-000000000001','CAP-LIMIT-'||n,'2027-12-31',auth.uid()
from generate_series(1,199)n;
select pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','shipment_cost_approve',p),'ASSISTANT_COST_APPROVAL_LIMIT') from cap;
rollback to too_many_batches;
set role authenticated;
do $$declare c cap;v jsonb;bad jsonb;begin
 select * into c from cap;
 for bad in select x from jsonb_array_elements(jsonb_build_array('{}'::jsonb,c.p||'{"pay":true}',c.p||'{"version":2}',c.p||'{"calculation_id":"bad"}'))x loop
  perform pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','shipment_cost_approve',bad),'ASSISTANT_COST_APPROVAL_INVALID');
 end loop;
 perform public.prepare_assistant_operation(c.id,'shipment_cost_approve',c.p);
 v:=public.review_assistant_operation(c.id);
 assert v->>'status'='awaiting_confirmation' and v->'preview'->>'version'='2';
 assert jsonb_array_length(v->'preview'->'batches')=2 and jsonb_array_length(v->'preview'->'lines')=1;
 assert (v->'preview'->'batches'->0->>'old_cost')::numeric=10 and (v->'preview'->'batches'->0->>'new_cost')::numeric=11;
 assert v->'preview'->'previous'->0->>'version'='1';
 assert not(v->'preview')?'state_stamp';
 update cap set token=(v->>'review_token')::uuid;
end $$;
reset role;
do $$begin
 assert (select status='draft' from public.cost_calculations where id=(select calculation_id from cap));
 assert (select status='approved' from public.cost_calculations where id=(select previous_id from cap));
 assert (select count(*)=2 from public.inventory_batches where product_id='b6620000-0000-4000-8000-000000000001' and unit_landed_cost=10);
end $$;
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,gen_random_uuid()),'ASSISTANT_OPERATION_DENIED') from cap;
select set_config('request.jwt.claim.sub','b6600000-0000-4000-8000-000000000002',false);
select pg_temp.fails(format('select public.review_assistant_operation(%L)',id),'ASSISTANT_OPERATION_DENIED') from cap;
select pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','shipment_cost_approve',p),'ASSISTANT_OPERATION_DENIED') from cap;
select set_config('request.jwt.claim.sub','b6600000-0000-4000-8000-000000000001',false);
do $$declare perm text;begin
 foreach perm in array array['agent.use','costing.view','costing.approve','prices.purchase.view','finance.view','products.view','shipments.view','documents.view','inventory.view'] loop
  insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
  select auth.uid(),id,'deny','Approval permission test',auth.uid() from public.permissions where code=perm;
  perform pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',(select id from cap),(select token from cap)),'ASSISTANT_OPERATION_DENIED');
  delete from public.user_permission_overrides where user_id=auth.uid();
 end loop;
end $$;
-- Expired review and obsolete/preliminary calculations cannot be approved.
update private.assistant_operations set expires_at=clock_timestamp()-interval '1 second' where id=(select id from cap);
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_OPERATION_EXPIRED') from cap;
update private.assistant_operations set expires_at=clock_timestamp()+interval '10 minutes' where id=(select id from cap);
update public.cost_calculation_items set goods_rate_basis='calculation' where calculation_id=(select calculation_id from cap);
select pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','shipment_cost_approve',p),'ASSISTANT_COST_APPROVAL_PRELIMINARY') from cap;
update public.cost_calculation_items set goods_rate_basis='expense' where calculation_id=(select calculation_id from cap);
update public.shipment_items set shipped_quantity=101 where id='b6640000-0000-4000-8000-000000000001';
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_COST_APPROVAL_STALE') from cap;
update public.shipment_items set shipped_quantity=100 where id='b6640000-0000-4000-8000-000000000001';
-- A newly linked batch changes the exact set of consequences.
insert into public.inventory_batches(id,product_id,source_shipment_item_id,batch_number,expiry_date,created_by)
values('b6650000-0000-4000-8000-000000000004','b6620000-0000-4000-8000-000000000001','b6640000-0000-4000-8000-000000000001','CAP-LATE','2027-12-31',auth.uid());
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_OPERATION_STALE') from cap;
delete from public.inventory_batches where id='b6650000-0000-4000-8000-000000000004';
-- Late native mismatch rolls back approval, supersession and every batch cost.
create function pg_temp.drift_batch() returns trigger language plpgsql as $$begin new.unit_landed_cost:=new.unit_landed_cost+1;return new;end $$;
create trigger approval_drift before update on public.inventory_batches for each row execute function pg_temp.drift_batch();
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_COST_APPROVAL_REFUSED') from cap;
drop trigger approval_drift on public.inventory_batches;
do $$begin
 assert (select status='draft' from public.cost_calculations where id=(select calculation_id from cap));
 assert (select status='approved' from public.cost_calculations where id=(select previous_id from cap));
 assert (select count(*)=2 from public.inventory_batches where product_id='b6620000-0000-4000-8000-000000000001' and unit_landed_cost=10);
end $$;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select auth.uid(),id,'deny','No calculation/payment permission needed',auth.uid() from public.permissions where code in('costing.calculate','finance.pay','finance.confirm','finance.manage','finance.draft');
set role authenticated;
do $$declare c cap;v jsonb;begin
 select * into c from cap;
 v:=public.confirm_assistant_operation(c.id,c.token);
 assert v->>'status'='completed' and v->>'result_id'=c.calculation_id::text;
 assert v=public.confirm_assistant_operation(c.id,c.token);
end $$;
reset role;
do $$begin
 assert (select status='approved' and approved_by=auth.uid() and approved_at is not null from public.cost_calculations where id=(select calculation_id from cap));
 assert (select status='superseded' and goods_total=1000 from public.cost_calculations where id=(select previous_id from cap));
 assert (select count(*)=2 from public.inventory_batches where product_id='b6620000-0000-4000-8000-000000000001' and unit_landed_cost=11 and cost_calculation_id=(select calculation_id from cap));
 assert (select unit_landed_cost is null from public.inventory_batches where id='b6650000-0000-4000-8000-000000000003');
 assert (select status='allocated' and paid_at is null from public.expenses where id=(select expense from cap));
 assert (select count(*)=2 from public.cost_calculations where shipment_id='b6630000-0000-4000-8000-000000000001');
 assert not exists(select 1 from public.inventory_movements where batch_id in(select id from public.inventory_batches where product_id='b6620000-0000-4000-8000-000000000001'));
end $$;
select pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','shipment_cost_approve',p),'ASSISTANT_COST_APPROVAL_STATE') from cap;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select auth.uid(),id,'deny','Receipt access revoked',auth.uid() from public.permissions where code='costing.approve';
select pg_temp.fails(format('select public.review_assistant_operation(%L)',id),'ASSISTANT_OPERATION_DENIED') from cap;
rollback;
