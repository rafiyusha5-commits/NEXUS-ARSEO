-- Shipment expenses, allocation, versioned landed cost and approval.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('b6900000-0000-4000-8000-000000000001','expense-reverse-director@test.local','{"full_name":"Finance Director"}'),
 ('b6900000-0000-4000-8000-000000000002','expense-reverse-accountant@test.local','{"full_name":"Finance Accountant"}'),
 ('b6900000-0000-4000-8000-000000000003','expense-reverse-logistic@test.local','{"full_name":"Finance Logistic"}');
insert into public.user_roles(user_id,role_id)
select u.id::uuid,r.id from (values
 ('b6900000-0000-4000-8000-000000000001','director'),('b6900000-0000-4000-8000-000000000002','accountant'),('b6900000-0000-4000-8000-000000000003','logistics_specialist'))u(id,role_code) join public.app_roles r on r.code=u.role_code;

insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('b6910000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Finance Supplier','FI','ERV-SUP'),
 ('b6910000-0000-4000-8000-000000000002',array['carrier'],'Finance Carrier','KZ','ERV-CAR');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('b6920000-0000-4000-8000-000000000001','ERV-001','{"ru":"Финансовый тестовый товар"}','b6910000-0000-4000-8000-000000000001','active');

select set_config('request.jwt.claim.sub','b6900000-0000-4000-8000-000000000001',false);
insert into public.shipments(id,shipment_number,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select 'b6930000-0000-4000-8000-000000000001','ERV-SHIP-001','import','b6910000-0000-4000-8000-000000000001',(select id from public.routes limit 1),(select id from public.process_templates where code='import_eu_kz' and version=1),(select id from public.currencies where code='EUR'),(select id from public.warehouses where status='active' and not is_virtual limit 1),'b6900000-0000-4000-8000-000000000003','b6900000-0000-4000-8000-000000000001';
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity,received_quantity,unit_price,currency_id) values
 ('b6940000-0000-4000-8000-000000000001','b6930000-0000-4000-8000-000000000001','b6920000-0000-4000-8000-000000000001','piece',10,10,2,(select id from public.currencies where code='EUR'));
insert into public.inventory_batches(id,product_id,source_shipment_item_id,batch_number,expiry_date,created_by) values
 ('b6950000-0000-4000-8000-000000000001','b6920000-0000-4000-8000-000000000001','b6940000-0000-4000-8000-000000000001','ERV-BATCH','2027-12-31','b6900000-0000-4000-8000-000000000001');


create temporary table erv(n integer primary key,id uuid,expense_id uuid,token uuid);
grant all on erv to authenticated;
set role authenticated;
do $$declare n integer;eid uuid;begin
 for n in 1..8 loop
  eid:=public.create_expense('b6930000-0000-4000-8000-000000000001',case when n=3 then 'goods_cost' else 'transport' end,null,
   123.45,(select id from public.currencies where code='EUR'),'2026-10-24',false,null,'Accounting review');
  insert into erv values(n,gen_random_uuid(),eid,null);
 end loop;
end $$;
reset role;
-- Synthetic paid records: no external payments or payment API.
update public.expenses set status='paid',paid_at='2026-10-23T10:00:00Z',paid_by=auth.uid()
where id in(select expense_id from erv);
set role authenticated;
-- REVERSE EXPENSE FIXTURE END

create function pg_temp.fails(q text, pattern text) returns void language plpgsql as $$
begin
 begin execute q;exception when others then
  if sqlerrm !~ pattern then raise exception 'Expected %, got %',pattern,sqlerrm;end if;return;
 end;raise exception 'Expected failure: %',pattern;
end $$;
select public.allocate_expense(expense_id,'by_quantity',(select id from public.currencies where code='EUR')) from erv where n=3;
do $$declare c erv;v jsonb;bad jsonb;begin
 for c in select * from erv loop
  for bad in select x from jsonb_array_elements(jsonb_build_array('{}'::jsonb,
    jsonb_build_object('expense_id',c.expense_id,'reason','Duplicate','refund',true),
    jsonb_build_object('expense_id',c.expense_id,'reason',''),
    jsonb_build_object('expense_id',c.expense_id,'reason',repeat('a',501)),
    jsonb_build_object('expense_id','x','reason','Duplicate'))) x loop
   perform pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','expense_reverse',bad),'ASSISTANT_EXPENSE_REVERSE_INVALID');
  end loop;
  perform public.prepare_assistant_operation(c.id,'expense_reverse',jsonb_build_object('expense_id',c.expense_id,'reason','Duplicate invoice'));
  v:=public.review_assistant_operation(c.id);
  assert v->>'status'='awaiting_confirmation' and v->'preview'->>'amount'='123.45' and not(v->'preview')?'state_stamp';
  assert v->'preview'->>'status'='paid' and v->'preview'->>'paid_by'='Finance Director';
  update erv set token=(v->>'review_token')::uuid where n=c.n;
 end loop;
end $$;
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,gen_random_uuid()),'ASSISTANT_OPERATION_DENIED') from erv;
select set_config('request.jwt.claim.sub','b6900000-0000-4000-8000-000000000003',false);
select pg_temp.fails(format('select public.review_assistant_operation(%L)',id),'ASSISTANT_OPERATION_DENIED') from erv;
select set_config('request.jwt.claim.sub','b6900000-0000-4000-8000-000000000001',false);
reset role;
do $$declare perm text;begin
 foreach perm in array array['agent.use','finance.view','finance.manage','finance.pay','prices.purchase.view','shipments.view'] loop
  insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
  select auth.uid(),id,'deny','Reversal test',auth.uid() from public.permissions where code=perm;
  perform pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',(select id from erv where n=3),(select token from erv where n=3)),'ASSISTANT_OPERATION_DENIED');
  delete from public.user_permission_overrides where user_id=auth.uid();
 end loop;
end $$;
-- Late corruption of payment history must roll back the entire operation.
create function pg_temp.drift_reverse() returns trigger language plpgsql as $$begin new.paid_at:=new.paid_at+interval '1 day';return new;end $$;
create trigger reverse_drift before update on public.expenses for each row execute function pg_temp.drift_reverse();
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_EXPENSE_REVERSE_REFUSED') from erv where n=1;
drop trigger reverse_drift on public.expenses;
do $$begin assert (select status='paid' and paid_at='2026-10-23T10:00:00Z'::timestamptz from public.expenses where id=(select expense_id from erv where n=1));end $$;
create temporary table before_expenses as select e.* from public.expenses e join erv on erv.expense_id=e.id;
create temporary table before_allocations as select a.* from public.expense_allocations a join erv on erv.expense_id=a.expense_id;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select auth.uid(),id,'deny','No costing rights',auth.uid() from public.permissions where code in ('finance.confirm','finance.draft','costing.calculate','costing.approve');
set role authenticated;
do $$declare c erv;a jsonb;begin
 for c in select * from erv where n<=3 loop
  a:=public.confirm_assistant_operation(c.id,c.token);
  assert a=public.confirm_assistant_operation(c.id,c.token) and a->>'status'='completed' and a->>'result_id'=c.expense_id::text;
 end loop;
end $$;
reset role;
delete from public.user_permission_overrides where user_id=auth.uid();
do $$begin
 assert (select count(*)=3 from public.expenses e join erv on erv.expense_id=e.id where status='reversed' and reversed_by=auth.uid() and reversal_reason='Duplicate invoice');
 assert not exists(select 1 from before_expenses b join public.expenses e on e.id=b.id
 where (to_jsonb(e)-array['status','reversed_by','reversed_at','reversal_reason','updated_at'])
 is distinct from (to_jsonb(b)-array['status','reversed_by','reversed_at','reversal_reason','updated_at']));
 assert not exists(select * from before_allocations except select * from public.expense_allocations);
 assert not exists(select 1 from public.cost_calculations where shipment_id='b6930000-0000-4000-8000-000000000001');
end $$;
update private.assistant_operations set expires_at=clock_timestamp()-interval '1 second' where id=(select id from erv where n=4);
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_OPERATION_EXPIRED') from erv where n=4;
update public.expenses set paid_at=paid_at+interval '1 second' where id=(select expense_id from erv where n=5);
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_EXPENSE_REVERSE_STALE') from erv where n=5;
select public.reverse_expense(expense_id,'Native reversal') from erv where n=6;
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_EXPENSE_REVERSE_STATE') from erv where n=6;
-- No unpaid status may be reversed, even by a director.
do $$declare st text;eid uuid;rid uuid;begin
 select expense_id into eid from erv where n=7;
 foreach st in array array['draft','confirmed','allocated'] loop
  update public.expenses set status=st,paid_by=null,paid_at=null where id=eid;
  perform pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','expense_reverse',jsonb_build_object('expense_id',eid,'reason','Duplicate')),'ASSISTANT_EXPENSE_REVERSE_STATE');
 end loop;
 perform public.cancel_expense(eid,'Native cancellation');
 perform pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','expense_reverse',jsonb_build_object('expense_id',eid,'reason','Duplicate')),'ASSISTANT_EXPENSE_REVERSE_STATE');
end $$;
do $$declare doc uuid;eid uuid;rid uuid:=gen_random_uuid();v jsonb;begin
 insert into public.documents(document_type_id,title,status,uploaded_by)
 select id,'Synthetic reversal attachment','approved',auth.uid() from public.document_types limit 1 returning id into doc;
 select expense_id into eid from erv where n=8;
 update public.expenses set document_id=doc where id=eid;
 perform public.prepare_assistant_operation(rid,'expense_reverse',jsonb_build_object('expense_id',eid,'reason','Duplicate'));
 v:=public.review_assistant_operation(rid);
 insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select auth.uid(),id,'deny','Document denial',auth.uid() from public.permissions where code='documents.view';
 perform pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',rid,v->>'review_token'),'ASSISTANT_OPERATION_DENIED');
 delete from public.user_permission_overrides where user_id=auth.uid();
end $$;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select auth.uid(),id,'deny','Receipt denial',auth.uid() from public.permissions where code='finance.pay';
select pg_temp.fails(format('select public.review_assistant_operation(%L)',id),'ASSISTANT_OPERATION_DENIED') from erv where n=1;
rollback;
