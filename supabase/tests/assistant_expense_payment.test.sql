-- Shipment expenses, allocation, versioned landed cost and approval.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('b7100000-0000-4000-8000-000000000001','expense-payment-director@test.local','{"full_name":"Finance Director"}'),
 ('b7100000-0000-4000-8000-000000000002','expense-payment-accountant@test.local','{"full_name":"Finance Accountant"}'),
 ('b7100000-0000-4000-8000-000000000003','expense-payment-logistic@test.local','{"full_name":"Finance Logistic"}');
insert into public.user_roles(user_id,role_id)
select u.id::uuid,r.id from (values
 ('b7100000-0000-4000-8000-000000000001','director'),('b7100000-0000-4000-8000-000000000002','accountant'),('b7100000-0000-4000-8000-000000000003','logistics_specialist'))u(id,role_code) join public.app_roles r on r.code=u.role_code;

insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('b7110000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Finance Supplier','FI','EPM-SUP'),
 ('b7110000-0000-4000-8000-000000000002',array['carrier'],'Finance Carrier','KZ','EPM-CAR');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('b7120000-0000-4000-8000-000000000001','EPM-001','{"ru":"Финансовый тестовый товар"}','b7110000-0000-4000-8000-000000000001','active');

select set_config('request.jwt.claim.sub','b7100000-0000-4000-8000-000000000001',false);
insert into public.shipments(id,shipment_number,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select 'b7130000-0000-4000-8000-000000000001','EPM-SHIP-001','import','b7110000-0000-4000-8000-000000000001',(select id from public.routes limit 1),(select id from public.process_templates where code='import_eu_kz' and version=1),(select id from public.currencies where code='EUR'),(select id from public.warehouses where status='active' and not is_virtual limit 1),'b7100000-0000-4000-8000-000000000003','b7100000-0000-4000-8000-000000000001';
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity,received_quantity,unit_price,currency_id) values
 ('b7140000-0000-4000-8000-000000000001','b7130000-0000-4000-8000-000000000001','b7120000-0000-4000-8000-000000000001','piece',10,10,2,(select id from public.currencies where code='EUR'));
insert into public.inventory_batches(id,product_id,source_shipment_item_id,batch_number,expiry_date,created_by) values
 ('b7150000-0000-4000-8000-000000000001','b7120000-0000-4000-8000-000000000001','b7140000-0000-4000-8000-000000000001','EPM-BATCH','2027-12-31','b7100000-0000-4000-8000-000000000001');


create temporary table epm(n integer primary key,id uuid,expense_id uuid,token uuid);
grant all on epm to authenticated;
set role authenticated;
do $$declare n integer;eid uuid;begin
 for n in 1..8 loop
  eid:=public.create_expense('b7130000-0000-4000-8000-000000000001',case when n=3 then 'goods_cost' else 'transport' end,null,
   123.45,(select id from public.currencies where code='EUR'),'2026-10-24',false,null,'Accounting review');
  insert into epm values(n,gen_random_uuid(),eid,null);
 end loop;
end $$;

do $$declare c epm;begin
 for c in select * from epm loop
  perform public.confirm_expense(c.expense_id);
  perform public.allocate_expense(c.expense_id,'by_quantity',(select id from public.currencies where code='EUR'));
 end loop;
end $$;
-- PAYMENT EXPENSE FIXTURE END
create function pg_temp.fails(q text, pattern text) returns void language plpgsql as $$
begin
 begin execute q;exception when others then
  if sqlerrm !~ pattern then raise exception 'Expected %, got %',pattern,sqlerrm;end if;return;
 end;raise exception 'Expected failure: %',pattern;
end $$;
do $$declare c epm;v jsonb;k text;begin
 for c in select * from epm loop
  foreach k in array array['amount','paid_at','actor','transfer','payment_amount'] loop
   perform pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','expense_mark_paid',jsonb_build_object('expense_id',c.expense_id,k,'x')),'ASSISTANT_EXPENSE_PAYMENT_INVALID');
  end loop;
  perform public.prepare_assistant_operation(c.id,'expense_mark_paid',jsonb_build_object('expense_id',c.expense_id));
  v:=public.review_assistant_operation(c.id);
  assert v->'preview'->>'status'='allocated' and v->'preview'->>'amount'='123.45' and not(v->'preview')?'state_stamp';
  update epm set token=(v->>'review_token')::uuid where n=c.n;
 end loop;
end $$;
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,gen_random_uuid()),'ASSISTANT_OPERATION_DENIED') from epm;
select set_config('request.jwt.claim.sub','b7100000-0000-4000-8000-000000000003',false);
select pg_temp.fails(format('select public.review_assistant_operation(%L)',id),'ASSISTANT_OPERATION_DENIED') from epm;
select set_config('request.jwt.claim.sub','b7100000-0000-4000-8000-000000000001',false);
reset role;
do $$declare perm text;begin
 foreach perm in array array['agent.use','finance.view','finance.pay','prices.purchase.view','shipments.view'] loop
  insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
  select auth.uid(),id,'deny','Payment test',auth.uid() from public.permissions where code=perm;
  perform pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',(select id from epm where n=3),(select token from epm where n=3)),'ASSISTANT_OPERATION_DENIED');
  delete from public.user_permission_overrides where user_id=auth.uid();
 end loop;
end $$;
create function pg_temp.drift_payment() returns trigger language plpgsql as $$begin new.amount:=new.amount+1;return new;end $$;
create trigger payment_drift before update on public.expenses for each row execute function pg_temp.drift_payment();
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_EXPENSE_PAYMENT_REFUSED') from epm where n=1;
drop trigger payment_drift on public.expenses;
do $$begin assert not exists(select 1 from public.expenses where shipment_id='b7130000-0000-4000-8000-000000000001' and (status<>'allocated' or amount<>123.45 or paid_at is not null));end $$;
create temporary table allocations_before as select a.* from public.expense_allocations a join epm on epm.expense_id=a.expense_id;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select auth.uid(),id,'deny','Not required for payment',auth.uid() from public.permissions where code in ('finance.manage','finance.confirm','finance.draft');
set role authenticated;
do $$declare c epm;a jsonb;b jsonb;begin
 for c in select * from epm where n<=3 loop
  a:=public.confirm_assistant_operation(c.id,c.token);b:=public.confirm_assistant_operation(c.id,c.token);
  assert a=b and a->>'status'='completed' and a->>'result_id'=c.expense_id::text;
 end loop;
end $$;
reset role;
delete from public.user_permission_overrides where user_id=auth.uid();
do $$begin
 assert (select count(*)=3 from public.expenses where shipment_id='b7130000-0000-4000-8000-000000000001' and status='paid' and paid_by=auth.uid() and paid_at is not null and amount=123.45);
 assert not exists(select * from allocations_before except select a.* from public.expense_allocations a join epm on epm.expense_id=a.expense_id);
 assert not exists(select 1 from public.cost_calculations where shipment_id='b7130000-0000-4000-8000-000000000001');
end $$;
update private.assistant_operations set expires_at=clock_timestamp()-interval '1 second' where id=(select id from epm where n=4);
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_OPERATION_EXPIRED') from epm where n=4;
update public.expenses set notes='Changed after preview' where id=(select expense_id from epm where n=5);
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_EXPENSE_PAYMENT_STALE') from epm where n=5;
select public.cancel_expense(expense_id,'Cancelled before payment') from epm where n=6;
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_EXPENSE_PAYMENT_STATE') from epm where n=6;
select public.mark_expense_paid(expense_id) from epm where n=7;
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_EXPENSE_PAYMENT_STATE') from epm where n=7;
do $$declare s text;eid uuid;begin
 select expense_id into eid from epm where n=8;
 foreach s in array array['draft','confirmed','paid'] loop
  update public.expenses set status=s where id=eid;
  perform pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','expense_mark_paid',jsonb_build_object('expense_id',eid)),'ASSISTANT_EXPENSE_PAYMENT_STATE');
 end loop;
 update public.expenses set status='allocated',is_planned=true where id=eid;
 perform pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','expense_mark_paid',jsonb_build_object('expense_id',eid)),'ASSISTANT_EXPENSE_PAYMENT_STATE');
end $$;
-- Context rights remain mandatory even with finance.pay.
do $$declare doc uuid;eid uuid;rid uuid:=gen_random_uuid();v jsonb;begin
 insert into public.documents(document_type_id,title,status,uploaded_by)
 select id,'Payment evidence','approved',auth.uid() from public.document_types limit 1 returning id into doc;
 select expense_id into eid from epm where n=8;
 update public.expenses set status='allocated',is_planned=false,document_id=doc where id=eid;
 perform public.prepare_assistant_operation(rid,'expense_mark_paid',jsonb_build_object('expense_id',eid));
 v:=public.review_assistant_operation(rid);
 assert v->'preview'->>'document'='Payment evidence';
 insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select auth.uid(),id,'deny','Payment context denied',auth.uid() from public.permissions where code='documents.view';
 perform pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',rid,v->>'review_token'),'ASSISTANT_OPERATION_DENIED');
 delete from public.user_permission_overrides where user_id=auth.uid();
 update public.documents set title='Changed evidence' where id=doc;
 perform pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',rid,v->>'review_token'),'ASSISTANT_EXPENSE_PAYMENT_STALE');
end $$;
select public.reverse_expense(expense_id,'Separate reversal') from epm where n=7;
select pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','expense_mark_paid',jsonb_build_object('expense_id',expense_id)),'ASSISTANT_EXPENSE_PAYMENT_STATE') from epm where n=7;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select auth.uid(),id,'deny','Receipt denial',auth.uid() from public.permissions where code='finance.pay';
select pg_temp.fails(format('select public.review_assistant_operation(%L)',id),'ASSISTANT_OPERATION_DENIED') from epm where n=1;
rollback;
