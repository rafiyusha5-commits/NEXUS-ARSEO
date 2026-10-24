-- Shipment expenses, allocation, versioned landed cost and approval.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('b6300000-0000-4000-8000-000000000001','expense-confirm-director@test.local','{"full_name":"Finance Director"}'),
 ('b6300000-0000-4000-8000-000000000002','expense-confirm-accountant@test.local','{"full_name":"Finance Accountant"}'),
 ('b6300000-0000-4000-8000-000000000003','expense-confirm-logistic@test.local','{"full_name":"Finance Logistic"}');
insert into public.user_roles(user_id,role_id)
select u.id::uuid,r.id from (values
 ('b6300000-0000-4000-8000-000000000001','director'),('b6300000-0000-4000-8000-000000000002','accountant'),('b6300000-0000-4000-8000-000000000003','logistics_specialist'))u(id,role_code) join public.app_roles r on r.code=u.role_code;

insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('b6310000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Finance Supplier','FI','ECF-SUP'),
 ('b6310000-0000-4000-8000-000000000002',array['carrier'],'Finance Carrier','KZ','ECF-CAR');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('b6320000-0000-4000-8000-000000000001','ECF-001','{"ru":"Финансовый тестовый товар"}','b6310000-0000-4000-8000-000000000001','active');

select set_config('request.jwt.claim.sub','b6300000-0000-4000-8000-000000000001',false);
insert into public.shipments(id,shipment_number,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select 'b6330000-0000-4000-8000-000000000001','ECF-SHIP-001','import','b6310000-0000-4000-8000-000000000001',(select id from public.routes limit 1),(select id from public.process_templates where code='import_eu_kz' and version=1),(select id from public.currencies where code='EUR'),(select id from public.warehouses where status='active' and not is_virtual limit 1),'b6300000-0000-4000-8000-000000000003','b6300000-0000-4000-8000-000000000001';
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity,received_quantity,unit_price,currency_id) values
 ('b6340000-0000-4000-8000-000000000001','b6330000-0000-4000-8000-000000000001','b6320000-0000-4000-8000-000000000001','piece',10,10,2,(select id from public.currencies where code='EUR'));
insert into public.inventory_batches(id,product_id,source_shipment_item_id,batch_number,expiry_date,created_by) values
 ('b6350000-0000-4000-8000-000000000001','b6320000-0000-4000-8000-000000000001','b6340000-0000-4000-8000-000000000001','ECF-BATCH','2027-12-31','b6300000-0000-4000-8000-000000000001');


create temporary table ecf(n integer primary key,id uuid,expense_id uuid,token uuid);
grant all on ecf to authenticated;
set role authenticated;
do $$declare n integer;eid uuid;begin
 for n in 1..8 loop
  eid:=public.create_expense('b6330000-0000-4000-8000-000000000001',case when n=3 then 'goods_cost' else 'transport' end,null,
   123.45,(select id from public.currencies where code='EUR'),'2026-10-24',n=2,null,'Accounting review');
  insert into ecf values(n,gen_random_uuid(),eid,null);
 end loop;
end $$;
-- CONFIRM EXPENSE FIXTURE END
create function pg_temp.fails(q text, pattern text) returns void language plpgsql as $$
begin
 begin execute q;exception when others then
  if sqlerrm !~ pattern then raise exception 'Expected %, got %',pattern,sqlerrm;end if;return;
 end;raise exception 'Expected failure: %',pattern;
end $$;
do $$declare c ecf;v jsonb;bad jsonb;begin
 for c in select * from ecf loop
  for bad in select x from jsonb_array_elements(jsonb_build_array('{}'::jsonb,jsonb_build_object('expense_id',c.expense_id,'pay',true),jsonb_build_object('expense_id',c.expense_id,'amount','1'),jsonb_build_object('expense_id','x'))) x loop
   perform pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','expense_confirm',bad),'ASSISTANT_EXPENSE_CONFIRM_INVALID');
  end loop;
  perform public.prepare_assistant_operation(c.id,'expense_confirm',jsonb_build_object('expense_id',c.expense_id));
  v:=public.review_assistant_operation(c.id);
  assert v->>'status'='awaiting_confirmation' and v->'preview'->>'amount'='123.45' and not(v->'preview')?'state_stamp';
  update ecf set token=(v->>'review_token')::uuid where n=c.n;
 end loop;
end $$;
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,gen_random_uuid()),'ASSISTANT_OPERATION_DENIED') from ecf;
select set_config('request.jwt.claim.sub','b6300000-0000-4000-8000-000000000003',false);
select pg_temp.fails(format('select public.review_assistant_operation(%L)',id),'ASSISTANT_OPERATION_DENIED') from ecf;
select pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','expense_confirm',jsonb_build_object('expense_id',expense_id)),'ASSISTANT_OPERATION_DENIED') from ecf;
select set_config('request.jwt.claim.sub','b6300000-0000-4000-8000-000000000001',false);
reset role;
do $$declare perm text;begin
 foreach perm in array array['agent.use','finance.view','finance.confirm','prices.purchase.view','shipments.view'] loop
  insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
  select auth.uid(),id,'deny','Accounting test',auth.uid() from public.permissions where code=perm;
  perform pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',(select id from ecf where n=3),(select token from ecf where n=3)),'ASSISTANT_OPERATION_DENIED');
  delete from public.user_permission_overrides where user_id=auth.uid();
 end loop;
end $$;
-- Native write failure is atomic.
create function pg_temp.reject_confirm() returns trigger language plpgsql as $$begin raise exception 'downstream failure';end $$;
create trigger confirm_failure after update on public.expenses for each row execute function pg_temp.reject_confirm();
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_EXPENSE_CONFIRM_REFUSED') from ecf where n=1;
drop trigger confirm_failure on public.expenses;
do $$begin assert not exists(select 1 from public.expenses where shipment_id='b6330000-0000-4000-8000-000000000001' and status<>'draft');end $$;
-- No finance.pay, finance.manage or finance.draft required for confirmation.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select auth.uid(),id,'deny','No payment rights',auth.uid() from public.permissions where code in ('finance.pay','finance.manage','finance.draft');
set role authenticated;
do $$declare c ecf;a jsonb;b jsonb;begin
 for c in select * from ecf where n<=3 loop
  a:=public.confirm_assistant_operation(c.id,c.token);b:=public.confirm_assistant_operation(c.id,c.token);
  assert a=b and a->>'status'='completed' and a->>'result_id'=c.expense_id::text;
 end loop;
end $$;
reset role;
delete from public.user_permission_overrides where user_id=auth.uid();
do $$begin
 assert (select count(*)=3 from public.expenses where shipment_id='b6330000-0000-4000-8000-000000000001' and status='confirmed' and confirmed_by=auth.uid() and confirmed_at is not null and amount=123.45);
 assert not exists(select 1 from public.expenses where shipment_id='b6330000-0000-4000-8000-000000000001' and paid_at is not null);
 assert not exists(select 1 from public.expense_allocations a join ecf on ecf.expense_id=a.expense_id);
 assert not exists(select 1 from public.cost_calculations where shipment_id='b6330000-0000-4000-8000-000000000001');
 assert (select is_planned from public.expenses where id=(select expense_id from ecf where n=2));
end $$;
update private.assistant_operations set expires_at=clock_timestamp()-interval '1 second' where id=(select id from ecf where n=4);
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_OPERATION_EXPIRED') from ecf where n=4;
-- Source edit makes reviewed proposal stale.
update public.expenses set notes='Changed after preview' where id=(select expense_id from ecf where n=5);
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_OPERATION_STALE') from ecf where n=5;
select public.cancel_expense(expense_id,'Cancelled before confirmation') from ecf where n=6;
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_EXPENSE_CONFIRM_STATE') from ecf where n=6;
select public.confirm_expense(expense_id) from ecf where n=7;
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_EXPENSE_CONFIRM_STATE') from ecf where n=7;
-- Document visibility and archive state cannot be bypassed by confirmation.
do $$declare doc uuid;eid uuid;rid uuid:=gen_random_uuid();v jsonb;begin
 insert into public.documents(document_type_id,title,status,uploaded_by)
 select id,'Synthetic accounting attachment','approved',auth.uid() from public.document_types limit 1 returning id into doc;
 select expense_id into eid from ecf where n=8;
 update public.expenses set document_id=doc,payee_counterparty_id='b6310000-0000-4000-8000-000000000002' where id=eid;
 perform public.prepare_assistant_operation(rid,'expense_confirm',jsonb_build_object('expense_id',eid));
 v:=public.review_assistant_operation(rid);
 assert v->'preview'->>'document'='Synthetic accounting attachment';
 insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select auth.uid(),id,'deny','Document denial',auth.uid() from public.permissions where code='documents.view';
 perform pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',rid,v->>'review_token'),'ASSISTANT_OPERATION_DENIED');
 delete from public.user_permission_overrides where user_id=auth.uid();
 update public.documents set archived_at=now(),archived_by=auth.uid(),archive_reason='Synthetic archive' where id=doc;
 perform pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',rid,v->>'review_token'),'ASSISTANT_EXPENSE_CONFIRM_STATE');
end $$;
-- Completed receipt must still respect current rights.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select auth.uid(),id,'deny','Receipt denial',auth.uid() from public.permissions where code='finance.confirm';
select pg_temp.fails(format('select public.review_assistant_operation(%L)',id),'ASSISTANT_OPERATION_DENIED') from ecf where n=1;
rollback;
