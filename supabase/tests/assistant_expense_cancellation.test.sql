-- Shipment expenses, allocation, versioned landed cost and approval.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('b6700000-0000-4000-8000-000000000001','expense-cancel-director@test.local','{"full_name":"Finance Director"}'),
 ('b6700000-0000-4000-8000-000000000002','expense-cancel-accountant@test.local','{"full_name":"Finance Accountant"}'),
 ('b6700000-0000-4000-8000-000000000003','expense-cancel-logistic@test.local','{"full_name":"Finance Logistic"}');
insert into public.user_roles(user_id,role_id)
select u.id::uuid,r.id from (values
 ('b6700000-0000-4000-8000-000000000001','director'),('b6700000-0000-4000-8000-000000000002','accountant'),('b6700000-0000-4000-8000-000000000003','logistics_specialist'))u(id,role_code) join public.app_roles r on r.code=u.role_code;

insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('b6710000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Finance Supplier','FI','ECX-SUP'),
 ('b6710000-0000-4000-8000-000000000002',array['carrier'],'Finance Carrier','KZ','ECX-CAR');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('b6720000-0000-4000-8000-000000000001','ECX-001','{"ru":"Финансовый тестовый товар"}','b6710000-0000-4000-8000-000000000001','active');

select set_config('request.jwt.claim.sub','b6700000-0000-4000-8000-000000000001',false);
insert into public.shipments(id,shipment_number,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select 'b6730000-0000-4000-8000-000000000001','ECX-SHIP-001','import','b6710000-0000-4000-8000-000000000001',(select id from public.routes limit 1),(select id from public.process_templates where code='import_eu_kz' and version=1),(select id from public.currencies where code='EUR'),(select id from public.warehouses where status='active' and not is_virtual limit 1),'b6700000-0000-4000-8000-000000000003','b6700000-0000-4000-8000-000000000001';
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity,received_quantity,unit_price,currency_id) values
 ('b6740000-0000-4000-8000-000000000001','b6730000-0000-4000-8000-000000000001','b6720000-0000-4000-8000-000000000001','piece',10,10,2,(select id from public.currencies where code='EUR'));
insert into public.inventory_batches(id,product_id,source_shipment_item_id,batch_number,expiry_date,created_by) values
 ('b6750000-0000-4000-8000-000000000001','b6720000-0000-4000-8000-000000000001','b6740000-0000-4000-8000-000000000001','ECX-BATCH','2027-12-31','b6700000-0000-4000-8000-000000000001');


create temporary table ecx(n integer primary key,id uuid,expense_id uuid,token uuid);
grant all on ecx to authenticated;
set role authenticated;
do $$declare n integer;eid uuid;begin
 for n in 1..8 loop
  eid:=public.create_expense('b6730000-0000-4000-8000-000000000001',case when n=3 then 'goods_cost' else 'transport' end,null,
   123.45,(select id from public.currencies where code='EUR'),'2026-10-24',n=2,null,'Accounting review');
  insert into ecx values(n,gen_random_uuid(),eid,null);
 end loop;
end $$;
-- CANCEL EXPENSE FIXTURE END

create function pg_temp.fails(q text, pattern text) returns void language plpgsql as $$
begin
 begin execute q;exception when others then
  if sqlerrm !~ pattern then raise exception 'Expected %, got %',pattern,sqlerrm;end if;return;
 end;raise exception 'Expected failure: %',pattern;
end $$;
select public.confirm_expense(expense_id) from ecx where n in (2,3,6,7);
select public.allocate_expense(expense_id,'by_quantity',(select id from public.currencies where code='EUR')) from ecx where n=3;
do $$declare c ecx;v jsonb;bad jsonb;begin
 for c in select * from ecx loop
  for bad in select x from jsonb_array_elements(jsonb_build_array('{}'::jsonb,
   jsonb_build_object('expense_id',c.expense_id,'reason',' ','refund',true),
   jsonb_build_object('expense_id',c.expense_id,'reason',''),
   jsonb_build_object('expense_id',c.expense_id,'reason',repeat('a',501)),
   jsonb_build_object('expense_id','x','reason','Duplicate'))) x loop
   perform pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','expense_cancel',bad),'ASSISTANT_EXPENSE_CANCEL_INVALID');
  end loop;
  perform public.prepare_assistant_operation(c.id,'expense_cancel',jsonb_build_object('expense_id',c.expense_id,'reason','Duplicate invoice'));
  v:=public.review_assistant_operation(c.id);
  assert v->>'status'='awaiting_confirmation' and v->'preview'->>'amount'='123.45' and not(v->'preview')?'state_stamp';
  assert v->'preview'->>'reason'='Duplicate invoice';
  update ecx set token=(v->>'review_token')::uuid where n=c.n;
 end loop;
end $$;
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,gen_random_uuid()),'ASSISTANT_OPERATION_DENIED') from ecx;
select set_config('request.jwt.claim.sub','b6700000-0000-4000-8000-000000000003',false);
select pg_temp.fails(format('select public.review_assistant_operation(%L)',id),'ASSISTANT_OPERATION_DENIED') from ecx;
select pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','expense_cancel',jsonb_build_object('expense_id',expense_id,'reason','Duplicate')),'ASSISTANT_OPERATION_DENIED') from ecx;
select set_config('request.jwt.claim.sub','b6700000-0000-4000-8000-000000000001',false);
reset role;
do $$declare perm text;begin
 foreach perm in array array['agent.use','finance.view','finance.manage','prices.purchase.view','shipments.view'] loop
  insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
  select auth.uid(),id,'deny','Cancellation test',auth.uid() from public.permissions where code=perm;
  perform pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',(select id from ecx where n=3),(select token from ecx where n=3)),'ASSISTANT_OPERATION_DENIED');
  delete from public.user_permission_overrides where user_id=auth.uid();
 end loop;
end $$;
-- Reject post-write drift and roll back the native update.
create function pg_temp.drift_cancel() returns trigger language plpgsql as $$begin new.amount:=new.amount+1;return new;end $$;
create trigger cancel_drift before update on public.expenses for each row execute function pg_temp.drift_cancel();
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_EXPENSE_CANCEL_REFUSED') from ecx where n=1;
drop trigger cancel_drift on public.expenses;
do $$begin assert (select status='draft' and amount=123.45 from public.expenses where id=(select expense_id from ecx where n=1));end $$;
create temporary table saved_allocations as select a.* from public.expense_allocations a join ecx on ecx.expense_id=a.expense_id;
-- Cancellation never needs finance.pay, finance.confirm or costing permissions.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select auth.uid(),id,'deny','No payment or costing rights',auth.uid() from public.permissions where code in ('finance.pay','finance.confirm','costing.calculate','costing.approve');
set role authenticated;
do $$declare c ecx;a jsonb;b jsonb;begin
 for c in select * from ecx where n<=3 loop
  a:=public.confirm_assistant_operation(c.id,c.token);b:=public.confirm_assistant_operation(c.id,c.token);
  assert a=b and a->>'status'='completed' and a->>'result_id'=c.expense_id::text;
 end loop;
end $$;
reset role;
delete from public.user_permission_overrides where user_id=auth.uid();
do $$begin
 assert (select count(*)=3 from public.expenses where shipment_id='b6730000-0000-4000-8000-000000000001' and status='cancelled' and cancelled_by=auth.uid() and cancelled_at is not null and amount=123.45 and cancellation_reason='Duplicate invoice');
 assert not exists(select 1 from public.expenses where shipment_id='b6730000-0000-4000-8000-000000000001' and paid_at is not null);
 assert (select jsonb_agg(to_jsonb(a) order by a.id) from saved_allocations a) =
 (select jsonb_agg(to_jsonb(a) order by a.id) from public.expense_allocations a join ecx on ecx.expense_id=a.expense_id);
 assert not exists(select 1 from public.cost_calculations where shipment_id='b6730000-0000-4000-8000-000000000001');
 assert (select is_planned from public.expenses where id=(select expense_id from ecx where n=2));
end $$;
update private.assistant_operations set expires_at=clock_timestamp()-interval '1 second' where id=(select id from ecx where n=4);
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_OPERATION_EXPIRED') from ecx where n=4;
update public.expenses set notes='Changed after preview' where id=(select expense_id from ecx where n=5);
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_EXPENSE_CANCEL_STALE') from ecx where n=5;
select public.cancel_expense(expense_id,'Native cancellation') from ecx where n=6;
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_EXPENSE_CANCEL_STATE') from ecx where n=6;
update public.expenses set status='paid',paid_by=auth.uid(),paid_at=now() where id=(select expense_id from ecx where n=7);
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_EXPENSE_CANCEL_STATE') from ecx where n=7;
-- Own draft can be cancelled without finance.manage, including receipt retry; foreign draft cannot.
-- Keep finance.view for the full assistant preview; deny only the write/manage right.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select auth.uid(),id,'deny','Own draft only',auth.uid() from public.permissions where code='finance.manage';
set role authenticated;
do $$declare eid uuid;rid uuid:=gen_random_uuid();v jsonb;begin
 eid:=public.create_expense('b6730000-0000-4000-8000-000000000001','transport',null,1,
 (select id from public.currencies where code='EUR'),'2026-10-24',false,null,'Own draft');
 perform public.prepare_assistant_operation(rid,'expense_cancel',jsonb_build_object('expense_id',eid,'reason','Own mistake'));
 v:=public.review_assistant_operation(rid);
 assert public.confirm_assistant_operation(rid,(v->>'review_token')::uuid)->>'status'='completed';
 assert public.confirm_assistant_operation(rid,(v->>'review_token')::uuid)->>'status'='completed';
end $$;
reset role;
delete from public.user_permission_overrides where user_id=auth.uid();
select set_config('request.jwt.claim.sub','b6700000-0000-4000-8000-000000000001',false);
-- Attached document access is checked; inactive context does not prevent correction.
do $$declare doc uuid;eid uuid;rid uuid:=gen_random_uuid();v jsonb;begin
 insert into public.documents(document_type_id,title,status,uploaded_by)
 select id,'Synthetic cancellation attachment','approved',auth.uid() from public.document_types limit 1 returning id into doc;
 select expense_id into eid from ecx where n=8;
 update public.expenses set document_id=doc,payee_counterparty_id='b6710000-0000-4000-8000-000000000002' where id=eid;
 perform public.prepare_assistant_operation(rid,'expense_cancel',jsonb_build_object('expense_id',eid,'reason','Duplicate'));
 v:=public.review_assistant_operation(rid);
 insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select auth.uid(),id,'deny','Document denial',auth.uid() from public.permissions where code='documents.view';
 perform pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',rid,v->>'review_token'),'ASSISTANT_OPERATION_DENIED');
 delete from public.user_permission_overrides where user_id=auth.uid();
end $$;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select auth.uid(),id,'deny','Receipt denial',auth.uid() from public.permissions where code='finance.view';
select pg_temp.fails(format('select public.review_assistant_operation(%L)',id),'ASSISTANT_OPERATION_DENIED') from ecx where n=1;
rollback;

