-- Shipment expenses, allocation, versioned landed cost and approval.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('b6400000-0000-4000-8000-000000000001','expense-allocation-director@test.local','{"full_name":"Finance Director"}'),
 ('b6400000-0000-4000-8000-000000000002','expense-allocation-accountant@test.local','{"full_name":"Finance Accountant"}'),
 ('b6400000-0000-4000-8000-000000000003','expense-allocation-logistic@test.local','{"full_name":"Finance Logistic"}');
insert into public.user_roles(user_id,role_id)
select u.id::uuid,r.id from (values
 ('b6400000-0000-4000-8000-000000000001','director'),('b6400000-0000-4000-8000-000000000002','accountant'),('b6400000-0000-4000-8000-000000000003','logistics_specialist'))u(id,role_code) join public.app_roles r on r.code=u.role_code;

insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('b6410000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Finance Supplier','FI','EAL-SUP'),
 ('b6410000-0000-4000-8000-000000000002',array['carrier'],'Finance Carrier','KZ','EAL-CAR');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('b6420000-0000-4000-8000-000000000001','EAL-001','{"ru":"Финансовый тестовый товар"}','b6410000-0000-4000-8000-000000000001','active');

select set_config('request.jwt.claim.sub','b6400000-0000-4000-8000-000000000001',false);
insert into public.shipments(id,shipment_number,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select 'b6430000-0000-4000-8000-000000000001','EAL-SHIP-001','import','b6410000-0000-4000-8000-000000000001',(select id from public.routes limit 1),(select id from public.process_templates where code='import_eu_kz' and version=1),(select id from public.currencies where code='EUR'),(select id from public.warehouses where status='active' and not is_virtual limit 1),'b6400000-0000-4000-8000-000000000003','b6400000-0000-4000-8000-000000000001';
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity,received_quantity,unit_price,currency_id) values
 ('b6440000-0000-4000-8000-000000000001','b6430000-0000-4000-8000-000000000001','b6420000-0000-4000-8000-000000000001','piece',10,10,2,(select id from public.currencies where code='EUR'));
insert into public.inventory_batches(id,product_id,source_shipment_item_id,batch_number,expiry_date,created_by) values
 ('b6450000-0000-4000-8000-000000000001','b6420000-0000-4000-8000-000000000001','b6440000-0000-4000-8000-000000000001','EAL-BATCH','2027-12-31','b6400000-0000-4000-8000-000000000001');



insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('b6420000-0000-4000-8000-000000000002','EAL-002','{"ru":"Второй товар"}','b6410000-0000-4000-8000-000000000001','active'),
 ('b6420000-0000-4000-8000-000000000003','EAL-003','{"ru":"Нулевая позиция"}','b6410000-0000-4000-8000-000000000001','active');
insert into public.product_packaging(product_id,uom,units_per_parent,gross_weight_kg,volume_m3,length_cm,width_cm,height_cm) values
 ('b6420000-0000-4000-8000-000000000001','piece',1,2,0.1,null,null,null),
 ('b6420000-0000-4000-8000-000000000002','piece',1,4,null,100,100,20)
on conflict(product_id,uom) do update set gross_weight_kg=excluded.gross_weight_kg,volume_m3=excluded.volume_m3,length_cm=excluded.length_cm,width_cm=excluded.width_cm,height_cm=excluded.height_cm;
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity,shipped_quantity,received_quantity,unit_price,currency_id) values
 ('b6440000-0000-4000-8000-000000000002','b6430000-0000-4000-8000-000000000001','b6420000-0000-4000-8000-000000000002','piece',25,20,null,3,(select id from public.currencies where code='EUR')),
 ('b6440000-0000-4000-8000-000000000003','b6430000-0000-4000-8000-000000000001','b6420000-0000-4000-8000-000000000003','box',1,1,0,null,(select id from public.currencies where code='EUR'));
create temporary table eal(n integer primary key,id uuid,expense_id uuid,token uuid,p jsonb);
grant all on eal to authenticated;
set role authenticated;
do $$declare n integer;eid uuid;begin
 for n in 1..8 loop
  eid:=public.create_expense('b6430000-0000-4000-8000-000000000001','transport',null,123.45,
   (select id from public.currencies where code='EUR'),'2026-10-24',n=6,null,'Allocation review');
  if n<>7 then perform public.confirm_expense(eid);end if;
  insert into eal values(n,gen_random_uuid(),eid,null,jsonb_build_object('expense_id',eid,'method',case n when 2 then 'by_weight' when 3 then 'by_volume' when 4 then 'by_value' else 'by_quantity' end,'target_currency_id',(select id from public.currencies where code='EUR')));
 end loop;
end $$;
reset role;
update public.expenses set status='paid',paid_at=now(),paid_by=auth.uid() where id=(select expense_id from eal where n=5);
-- ALLOCATION FIXTURE END
create function pg_temp.fails(q text, pattern text) returns void language plpgsql as $$
begin
 begin execute q;exception when others then
  if sqlerrm !~ pattern then raise exception 'Expected %, got %',pattern,sqlerrm;end if;return;
 end;raise exception 'Expected failure: %',pattern;
end $$;
set role authenticated;
do $$declare c eal;v jsonb;bad jsonb;begin
 for c in select * from eal where n not in (6,7) loop
  for bad in select x from jsonb_array_elements(jsonb_build_array(c.p-'method',c.p||'{"method":"manual"}',c.p||'{"pay":true}',c.p||'{"amount":"1"}',c.p||'{"target_currency_id":"x"}')) x loop
   perform pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','expense_allocate',bad),'ASSISTANT_ALLOCATION_INVALID');
  end loop;
  perform public.prepare_assistant_operation(c.id,'expense_allocate',c.p);
  v:=public.review_assistant_operation(c.id);
  assert v->>'status'='awaiting_confirmation' and v->'preview'->>'total'='123.45' and jsonb_array_length(v->'preview'->'lines')=2;
  assert v->'preview'->>'excluded_count'='1' and not (v->'preview')?'state_stamp';
  if c.n=1 then assert v->'preview'->'lines'->0->>'amount'='41.15';assert v->'preview'->'lines'->1->>'amount'='82.30';end if;
  update eal set token=(v->>'review_token')::uuid where n=c.n;
 end loop;
end $$;
select pg_temp.fails(format('select public.prepare_assistant_operation(%L,%L,%L::jsonb)',id,'expense_allocate',p),'ASSISTANT_ALLOCATION_STATE') from eal where n in(6,7);
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,gen_random_uuid()),'ASSISTANT_OPERATION_DENIED') from eal where n=1;
select set_config('request.jwt.claim.sub','b6400000-0000-4000-8000-000000000003',false);
select pg_temp.fails(format('select public.review_assistant_operation(%L)',id),'ASSISTANT_OPERATION_DENIED') from eal where n=1;
select set_config('request.jwt.claim.sub','b6400000-0000-4000-8000-000000000001',false);
reset role;
do $$declare perm text;begin
 foreach perm in array array['agent.use','finance.view','costing.calculate','prices.purchase.view','products.view','shipments.view'] loop
  insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
  select auth.uid(),id,'deny','Allocation test',auth.uid() from public.permissions where code=perm;
  perform pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',(select id from eal where n=1),(select token from eal where n=1)),'ASSISTANT_OPERATION_DENIED');
  delete from public.user_permission_overrides where user_id=auth.uid();
 end loop;
end $$;
-- Fail late: native deletion/insertion and status change must roll back together.
create function pg_temp.reject_allocation() returns trigger language plpgsql as $$begin raise exception 'late allocation failure';end $$;
create trigger allocation_failure after insert on public.expense_allocations for each row execute function pg_temp.reject_allocation();
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_ALLOCATION_REFUSED') from eal where n=1;
drop trigger allocation_failure on public.expense_allocations;
do $$begin assert not exists(select 1 from public.expense_allocations a join eal on eal.expense_id=a.expense_id);end $$;
-- A native result drifting from the displayed amounts is rejected atomically too.
create function pg_temp.drift_allocation() returns trigger language plpgsql as $$begin new.allocated_amount:=new.allocated_amount+1;return new;end $$;
create trigger allocation_drift before insert on public.expense_allocations for each row execute function pg_temp.drift_allocation();
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_ALLOCATION_REFUSED') from eal where n=1;
drop trigger allocation_drift on public.expense_allocations;
do $$begin assert not exists(select 1 from public.expense_allocations a join eal on eal.expense_id=a.expense_id);end $$;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select auth.uid(),id,'deny','No payment rights',auth.uid() from public.permissions where code in('finance.pay','finance.confirm','finance.manage','finance.draft');
set role authenticated;
do $$declare c eal;v jsonb;again jsonb;rid uuid;before_ids jsonb;begin
 for c in select * from eal where n<=5 loop
  v:=public.confirm_assistant_operation(c.id,c.token);
  again:=public.confirm_assistant_operation(c.id,c.token);assert v=again;
  assert v->>'status'='completed';
 end loop;
 -- Explicit re-allocation shows old rows and replaces rather than appends.
 select * into c from eal where n=1;
 rid:=gen_random_uuid();
 perform public.prepare_assistant_operation(rid,'expense_allocate',c.p||'{"method":"by_weight"}');
 v:=public.review_assistant_operation(rid);assert jsonb_array_length(v->'preview'->'previous')=2;
 perform public.confirm_assistant_operation(rid,(v->>'review_token')::uuid);
end $$;
reset role;
delete from public.user_permission_overrides where user_id=auth.uid();
do $$begin
 assert (select count(*)=10 from public.expense_allocations a join eal on eal.expense_id=a.expense_id);
 assert not exists(select 1 from public.expense_allocations a join eal on eal.expense_id=a.expense_id group by a.expense_id having sum(a.allocated_amount)<>123.45);
 assert (select status='paid' and paid_at is not null and paid_by=auth.uid() from public.expenses where id=(select expense_id from eal where n=5));
 assert not exists(select 1 from public.expenses e join eal on eal.expense_id=e.id where eal.n<>5 and e.paid_at is not null);
 assert not exists(select 1 from public.cost_calculations where shipment_id='b6430000-0000-4000-8000-000000000001');
end $$;
-- A quantity source change invalidates the reviewed distribution.
update public.shipment_items set shipped_quantity=19 where id='b6440000-0000-4000-8000-000000000002';
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_OPERATION_STALE') from eal where n=8;
update public.shipment_items set shipped_quantity=20 where id='b6440000-0000-4000-8000-000000000002';
-- Missing weight, value or FX must be refused before writing.
update public.product_packaging set gross_weight_kg=null where product_id='b6420000-0000-4000-8000-000000000002';
select pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','expense_allocate',p||'{"method":"by_weight"}'),'ASSISTANT_ALLOCATION_BASIS') from eal where n=8;
update public.product_packaging set gross_weight_kg=4 where product_id='b6420000-0000-4000-8000-000000000002';
delete from public.exchange_rates where base_currency_id=(select id from public.currencies where code='EUR');
select pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','expense_allocate',p||jsonb_build_object('target_currency_id',(select id from public.currencies where code='KZT'))),'ASSISTANT_ALLOCATION_RATE') from eal where n=8;
-- Explicit native FX and last-line remainder: exactly the shown total is saved.
select public.add_exchange_rate((select id from public.currencies where code='EUR'),(select id from public.currencies where code='KZT'),1.234567,'bank','Synthetic allocation', '2026-10-22');
do $$declare c eal;v jsonb;rid uuid:=gen_random_uuid();begin
 select * into c from eal where n=8;
 perform public.prepare_assistant_operation(rid,'expense_allocate',c.p||jsonb_build_object('target_currency_id',(select id from public.currencies where code='KZT')));
 v:=public.review_assistant_operation(rid);assert v->'preview'->>'rate'='1.234567';
 perform public.confirm_assistant_operation(rid,(v->>'review_token')::uuid);
 assert (select sum(allocated_amount) from public.expense_allocations where expense_id=c.expense_id)=(v->'preview'->>'total')::numeric;
end $$;
-- A newly applicable rate after review invalidates the proposal.
update public.expenses set incurred_at='2026-10-23' where id=(select expense_id from eal where n=8);
do $$declare c eal;rid uuid:=gen_random_uuid();v jsonb;begin
 select * into c from eal where n=8;
 perform public.prepare_assistant_operation(rid,'expense_allocate',c.p||jsonb_build_object('target_currency_id',(select id from public.currencies where code='KZT')));
 v:=public.review_assistant_operation(rid);
 perform public.add_exchange_rate((select id from public.currencies where code='EUR'),(select id from public.currencies where code='KZT'),2,'bank','New rate','2026-10-23');
 perform pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',rid,v->>'review_token'),'ASSISTANT_OPERATION_STALE');
end $$;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select auth.uid(),id,'deny','Receipt access revoked',auth.uid() from public.permissions where code='costing.calculate';
select pg_temp.fails(format('select public.review_assistant_operation(%L)',id),'ASSISTANT_OPERATION_DENIED') from eal where n=1;
rollback;
