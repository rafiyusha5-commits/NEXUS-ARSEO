-- Shipment expenses, allocation, versioned landed cost and approval.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('b6500000-0000-4000-8000-000000000001','assistant-cost-director@test.local','{"full_name":"Finance Director"}'),
 ('b6500000-0000-4000-8000-000000000002','assistant-cost-accountant@test.local','{"full_name":"Finance Accountant"}'),
 ('b6500000-0000-4000-8000-000000000003','assistant-cost-logistic@test.local','{"full_name":"Finance Logistic"}');
insert into public.user_roles(user_id,role_id)
select u.id::uuid,r.id from (values
 ('b6500000-0000-4000-8000-000000000001','director'),('b6500000-0000-4000-8000-000000000002','accountant'),('b6500000-0000-4000-8000-000000000003','logistics_specialist'))u(id,role_code) join public.app_roles r on r.code=u.role_code;

insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('b6510000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Finance Supplier','FI','CST-SUP'),
 ('b6510000-0000-4000-8000-000000000002',array['carrier'],'Finance Carrier','KZ','CST-CAR');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('b6520000-0000-4000-8000-000000000001','CST-001','{"ru":"Финансовый тестовый товар"}','b6510000-0000-4000-8000-000000000001','active');

select set_config('request.jwt.claim.sub','b6500000-0000-4000-8000-000000000001',false);
insert into public.shipments(id,shipment_number,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select 'b6530000-0000-4000-8000-000000000001','CST-SHIP-001','import','b6510000-0000-4000-8000-000000000001',(select id from public.routes limit 1),(select id from public.process_templates where code='import_eu_kz' and version=1),(select id from public.currencies where code='EUR'),(select id from public.warehouses where status='active' and not is_virtual limit 1),'b6500000-0000-4000-8000-000000000003','b6500000-0000-4000-8000-000000000001';
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity,received_quantity,unit_price,currency_id) values
 ('b6540000-0000-4000-8000-000000000001','b6530000-0000-4000-8000-000000000001','b6520000-0000-4000-8000-000000000001','piece',10,10,2,(select id from public.currencies where code='EUR'));
insert into public.inventory_batches(id,product_id,source_shipment_item_id,batch_number,expiry_date,created_by) values
 ('b6550000-0000-4000-8000-000000000001','b6520000-0000-4000-8000-000000000001','b6540000-0000-4000-8000-000000000001','CST-BATCH','2027-12-31','b6500000-0000-4000-8000-000000000001');



insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('b6520000-0000-4000-8000-000000000002','CST-002','{"ru":"Второй товар"}','b6510000-0000-4000-8000-000000000001','active'),
 ('b6520000-0000-4000-8000-000000000003','CST-003','{"ru":"Нулевая позиция"}','b6510000-0000-4000-8000-000000000001','active');
insert into public.product_packaging(product_id,uom,units_per_parent,gross_weight_kg,volume_m3,length_cm,width_cm,height_cm) values
 ('b6520000-0000-4000-8000-000000000001','piece',1,2,0.1,null,null,null),
 ('b6520000-0000-4000-8000-000000000002','piece',1,4,null,100,100,20)
on conflict(product_id,uom) do update set gross_weight_kg=excluded.gross_weight_kg,volume_m3=excluded.volume_m3,length_cm=excluded.length_cm,width_cm=excluded.width_cm,height_cm=excluded.height_cm;
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity,shipped_quantity,received_quantity,unit_price,currency_id) values
 ('b6540000-0000-4000-8000-000000000002','b6530000-0000-4000-8000-000000000001','b6520000-0000-4000-8000-000000000002','piece',25,20,null,3,(select id from public.currencies where code='EUR')),
 ('b6540000-0000-4000-8000-000000000003','b6530000-0000-4000-8000-000000000001','b6520000-0000-4000-8000-000000000003','box',1,1,0,null,(select id from public.currencies where code='EUR'));

update public.shipment_items set ordered_quantity=100,shipped_quantity=100,received_quantity=98 where id='b6540000-0000-4000-8000-000000000001';
update public.shipment_items set shipped_quantity=0 where id='b6540000-0000-4000-8000-000000000002';
create temporary table cst(id uuid,token uuid,p jsonb,expense uuid);
grant all on cst to authenticated;
set role authenticated;
do $$declare eid uuid;begin
 eid:=public.create_expense('b6530000-0000-4000-8000-000000000001','goods_cost',null,1000,(select id from public.currencies where code='EUR'),'2026-10-24',false,null,'Purchase 100');
 perform public.confirm_expense(eid);
 perform public.allocate_expense(eid,'by_quantity',(select id from public.currencies where code='EUR'));
 insert into cst values(gen_random_uuid(),null,jsonb_build_object('shipment_id','b6530000-0000-4000-8000-000000000001','target_currency_id',(select id from public.currencies where code='EUR')),eid);
end $$;
reset role;
-- COST FIXTURE END

create function pg_temp.fails(q text,pattern text) returns void language plpgsql as $$
begin
 begin execute q;exception when others then
  if sqlerrm !~ pattern then raise exception 'Expected %, got %',pattern,sqlerrm;end if;return;
 end;raise exception 'Expected failure: %',pattern;
end $$;
set role authenticated;
do $$declare v jsonb;bad jsonb;c cst;begin
 select * into c from cst;
 for bad in select x from jsonb_array_elements(jsonb_build_array(c.p-'shipment_id',c.p||'{"approve":true}',c.p||'{"amount":1}',c.p||'{"target_currency_id":"bad"}'))x loop
  perform pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','shipment_cost_calculate',bad),'ASSISTANT_COST_INVALID');
 end loop;
 perform public.prepare_assistant_operation(c.id,'shipment_cost_calculate',c.p);
 v:=public.review_assistant_operation(c.id);
 assert v->>'status'='awaiting_confirmation';
 assert (v->'preview'->>'goods_total')::numeric=1000 and (v->'preview'->>'landed_total')::numeric=1000;
 assert jsonb_array_length(v->'preview'->'lines')=1;
 assert (v->'preview'->'lines'->0->>'quantity')::numeric=98;
 assert (v->'preview'->'lines'->0->>'cost_quantity')::numeric=100;
 assert (v->'preview'->'lines'->0->>'unit_landed_cost')::numeric=10;
 assert v->'preview'->'lines'->0->>'goods_rate_basis'='expense';
 assert not(v->'preview')?'state_stamp';
 update cst set token=(v->>'review_token')::uuid;
end $$;
reset role;
do $$begin assert not exists(select 1 from public.cost_calculations where shipment_id='b6530000-0000-4000-8000-000000000001');end $$;
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,gen_random_uuid()),'ASSISTANT_OPERATION_DENIED') from cst;
select pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','shipment_cost_calculate',p||jsonb_build_object('target_currency_id',(select id from public.currencies where code='KZT'))),'Все расходы должны быть распределены') from cst;
select set_config('request.jwt.claim.sub','b6500000-0000-4000-8000-000000000003',false);
select pg_temp.fails(format('select public.review_assistant_operation(%L)',id),'ASSISTANT_OPERATION_DENIED') from cst;
select set_config('request.jwt.claim.sub','b6500000-0000-4000-8000-000000000001',false);
do $$declare perm text;begin
 foreach perm in array array['agent.use','costing.view','costing.calculate','finance.view','prices.purchase.view','products.view','shipments.view','documents.view'] loop
  insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
  select auth.uid(),id,'deny','Cost access test',auth.uid() from public.permissions where code=perm;
  perform pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',(select id from cst),(select token from cst)),'ASSISTANT_OPERATION_DENIED');
  delete from public.user_permission_overrides where user_id=auth.uid();
 end loop;
end $$;
-- No saved version or status change if native output drifts from the preview.
create function pg_temp.drift_cost() returns trigger language plpgsql as $$begin new.unit_landed_cost:=new.unit_landed_cost+1;return new;end $$;
create trigger cost_drift before insert on public.cost_calculation_items for each row execute function pg_temp.drift_cost();
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_COST_REFUSED') from cst;
drop trigger cost_drift on public.cost_calculation_items;
do $$begin assert not exists(select 1 from public.cost_calculations where shipment_id='b6530000-0000-4000-8000-000000000001');end $$;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select auth.uid(),id,'deny','No automatic approval or payment',auth.uid() from public.permissions where code in('costing.approve','finance.pay','finance.confirm','finance.manage','finance.draft');
set role authenticated;
do $$declare c cst;v jsonb;begin
 select * into c from cst;
 v:=public.confirm_assistant_operation(c.id,c.token);
 assert v->>'status'='completed';
 assert v=public.confirm_assistant_operation(c.id,c.token);
end $$;
reset role;
do $$begin
 assert (select count(*)=1 from public.cost_calculations where shipment_id='b6530000-0000-4000-8000-000000000001' and status='draft' and approved_at is null);
 assert (select unit_landed_cost is null from public.inventory_batches where id='b6550000-0000-4000-8000-000000000001');
 assert (select paid_at is null from public.expenses where id=(select expense from cst));
end $$;
delete from public.user_permission_overrides where user_id=auth.uid();
-- Keep an approved historical version intact; a fresh action creates version 2 only.
select public.approve_shipment_cost((select result_calculation_id from private.assistant_operations where id=(select id from cst)));
do $$declare c cst;rid uuid:=gen_random_uuid();v jsonb;before_batch jsonb;begin
 select * into c from cst;
 select to_jsonb(b) into before_batch from public.inventory_batches b where id='b6550000-0000-4000-8000-000000000001';
 perform public.prepare_assistant_operation(rid,'shipment_cost_calculate',c.p);
 v:=public.review_assistant_operation(rid);assert v->'preview'->>'version'='2' and v->'preview'->>'approved_version'='1';
 perform public.confirm_assistant_operation(rid,(v->>'review_token')::uuid);
 assert (select status='approved' from public.cost_calculations where shipment_id='b6530000-0000-4000-8000-000000000001' and version_number=1);
 assert before_batch=(select to_jsonb(b) from public.inventory_batches b where id='b6550000-0000-4000-8000-000000000001');
end $$;
-- A changed input and a competing native version invalidate the old review.
do $$declare c cst;rid uuid:=gen_random_uuid();v jsonb;begin
 select * into c from cst;perform public.prepare_assistant_operation(rid,'shipment_cost_calculate',c.p);
 v:=public.review_assistant_operation(rid);
 update public.shipment_items set shipped_quantity=101 where id='b6540000-0000-4000-8000-000000000001';
 perform pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',rid,v->>'review_token'),'ASSISTANT_OPERATION_STALE');
 update public.shipment_items set shipped_quantity=100 where id='b6540000-0000-4000-8000-000000000001';
 rid:=gen_random_uuid();perform public.prepare_assistant_operation(rid,'shipment_cost_calculate',c.p);v:=public.review_assistant_operation(rid);
 perform public.calculate_shipment_cost((c.p->>'shipment_id')::uuid,(c.p->>'target_currency_id')::uuid);
 perform pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',rid,v->>'review_token'),'ASSISTANT_OPERATION_STALE');
end $$;
-- Purchase price path: missing FX, provisional FX, planned-only totals and unallocated blockers.
select public.cancel_expense(expense,'Synthetic alternative price path') from cst;
delete from public.exchange_rates where base_currency_id=(select id from public.currencies where code='EUR');
select pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','shipment_cost_calculate',p||jsonb_build_object('target_currency_id',(select id from public.currencies where code='KZT'))),'Нет курса') from cst;
select public.add_exchange_rate((select id from public.currencies where code='EUR'),(select id from public.currencies where code='KZT'),2,'bank','Cost FX','2026-10-22');
do $$declare c cst;rid uuid:=gen_random_uuid();v jsonb;eid uuid;begin
 select * into c from cst;
 eid:=public.create_expense((c.p->>'shipment_id')::uuid,'transport',null,12,(select id from public.currencies where code='EUR'),'2026-10-24',true,null,'Only plan');
 perform public.prepare_assistant_operation(rid,'shipment_cost_calculate',c.p||jsonb_build_object('target_currency_id',(select id from public.currencies where code='KZT')));
 v:=public.review_assistant_operation(rid);
 assert (v->'preview'->>'landed_total')::numeric=392 and (v->'preview'->>'planned_total')::numeric=24;
 assert v->'preview'->'lines'->0->>'goods_rate_basis'='calculation';
 perform public.confirm_assistant_operation(rid,(v->>'review_token')::uuid);
 assert (select status='draft' from public.cost_calculations where id=(select result_calculation_id from private.assistant_operations where id=rid));
 eid:=public.create_expense((c.p->>'shipment_id')::uuid,'transport',null,13,(select id from public.currencies where code='EUR'),'2026-10-24',false,null,'Blocks calculation');
 perform pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','shipment_cost_calculate',c.p),'Подтвердите и распределите');
 perform public.cancel_expense(eid,'Cleanup synthetic blocker');
end $$;
-- Confirmed customs declaration changes both the shown rate basis and its snapshot.
insert into public.documents(id,document_type_id,title,document_date,status,uploaded_by)
select 'b6580000-0000-4000-8000-000000000001',id,'Cost declaration','2026-10-22','approved',auth.uid()
from public.document_types where code='customs_declaration';
insert into public.document_links(document_id,entity_type,entity_id,created_by)
values('b6580000-0000-4000-8000-000000000001','shipment','b6530000-0000-4000-8000-000000000001',auth.uid());
do $$declare c cst;rid uuid:=gen_random_uuid();v jsonb;begin
 select * into c from cst;
 perform public.prepare_assistant_operation(rid,'shipment_cost_calculate',c.p||jsonb_build_object('target_currency_id',(select id from public.currencies where code='KZT')));
 v:=public.review_assistant_operation(rid);
 assert v->'preview'->'lines'->0->>'goods_rate_basis'='customs_declaration';
 assert v->'preview'->'lines'->0->>'goods_rate_date'='2026-10-22';
 update public.documents set document_date='2026-10-23' where id='b6580000-0000-4000-8000-000000000001';
 perform pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',rid,v->>'review_token'),'ASSISTANT_OPERATION_STALE');
 update public.shipment_items set shipped_quantity=20 where id='b6540000-0000-4000-8000-000000000002';
 rid:=gen_random_uuid();perform public.prepare_assistant_operation(rid,'shipment_cost_calculate',c.p||jsonb_build_object('target_currency_id',(select id from public.currencies where code='KZT')));
 v:=public.review_assistant_operation(rid);
 assert jsonb_array_length(v->'preview'->'lines')=2 and (v->'preview'->>'landed_total')::numeric=512;
 perform public.confirm_assistant_operation(rid,(v->>'review_token')::uuid);
end $$;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select auth.uid(),id,'deny','Receipt access revoked',auth.uid() from public.permissions where code='costing.view';
select pg_temp.fails(format('select public.review_assistant_operation(%L)',id),'ASSISTANT_OPERATION_DENIED') from cst;
rollback;
