-- Shipment expenses, allocation, versioned landed cost and approval.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('ae000000-0000-4000-8000-000000000001','expense-director@test.local','{"full_name":"Finance Director"}'),
 ('ae000000-0000-4000-8000-000000000002','expense-accountant@test.local','{"full_name":"Finance Accountant"}'),
 ('ae000000-0000-4000-8000-000000000003','expense-logistic@test.local','{"full_name":"Finance Logistic"}');
insert into public.user_roles(user_id,role_id)
select u.id::uuid,r.id from (values
 ('ae000000-0000-4000-8000-000000000001','director'),('ae000000-0000-4000-8000-000000000002','accountant'),('ae000000-0000-4000-8000-000000000003','logistics_specialist'))u(id,role_code) join public.app_roles r on r.code=u.role_code;

insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('ae100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Finance Supplier','FI','EXP-SUP'),
 ('ae100000-0000-4000-8000-000000000002',array['carrier'],'Finance Carrier','KZ','EXP-CAR');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('ae200000-0000-4000-8000-000000000001','EXP-001','{"ru":"Финансовый тестовый товар"}','ae100000-0000-4000-8000-000000000001','active');

select set_config('request.jwt.claim.sub','ae000000-0000-4000-8000-000000000001',false);
insert into public.shipments(id,shipment_number,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select 'ae300000-0000-4000-8000-000000000001','EXP-SHIP-001','import','ae100000-0000-4000-8000-000000000001',(select id from public.routes limit 1),(select id from public.process_templates where code='import_eu_kz' and version=1),(select id from public.currencies where code='EUR'),(select id from public.warehouses where status='active' and not is_virtual limit 1),'ae000000-0000-4000-8000-000000000003','ae000000-0000-4000-8000-000000000001';
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity,received_quantity,unit_price,currency_id) values
 ('ae400000-0000-4000-8000-000000000001','ae300000-0000-4000-8000-000000000001','ae200000-0000-4000-8000-000000000001','piece',10,10,2,(select id from public.currencies where code='EUR'));
insert into public.inventory_batches(id,product_id,source_shipment_item_id,batch_number,expiry_date,created_by) values
 ('ae500000-0000-4000-8000-000000000001','ae200000-0000-4000-8000-000000000001','ae400000-0000-4000-8000-000000000001','EXP-BATCH','2027-12-31','ae000000-0000-4000-8000-000000000001');

-- Explicit declaration fixture: foreign purchase costs require a confirmed declaration.
with inserted as (
 insert into public.documents(document_type_id,title,document_number,document_date,status,uploaded_by)
 select dt.id,'Cost declaration '||s.shipment_number,s.shipment_number,(now() at time zone 'Asia/Almaty')::date,'approved',s.created_by
 from public.shipments s cross join public.document_types dt where dt.code='customs_declaration' and s.id::text like 'ae%'
 returning id,document_number
) insert into public.document_links(document_id,entity_type,entity_id,created_by)
 select d.id,'shipment',s.id,s.created_by from inserted d join public.shipments s on s.shipment_number=d.document_number;


-- EXPENSE FIXTURE END
create function pg_temp.fails(q text, pattern text) returns void language plpgsql as $$
begin
 begin execute q; exception when others then
  if sqlerrm !~ pattern then raise exception 'Expected %, got %',pattern,sqlerrm;end if;return;
 end;raise exception 'Expected failure: %',pattern;
end $$;
create temporary table ec(n integer primary key,id uuid,token uuid,p jsonb);
grant all on ec to authenticated;
insert into ec
select n,gen_random_uuid(),null,jsonb_build_object('shipment_id','ae300000-0000-4000-8000-000000000001',
'expense_type',case when n=3 then 'goods_cost' else 'transport' end,'payee_counterparty_id',null,
'amount',case when n=2 then '42.50' else '1250.50' end,'currency_id',(select id from public.currencies where code='EUR'),
'incurred_at','2026-10-24','amount_kind',case when n=2 then 'planned' else 'actual' end,'document_id',null,'notes',null)
from generate_series(1,8) n;
set role authenticated;
select set_config('request.jwt.claim.sub','ae000000-0000-4000-8000-000000000001',false);
do $$declare c ec; v jsonb;bad jsonb;begin
 for c in select * from ec loop
  for bad in select x from jsonb_array_elements(jsonb_build_array(c.p-'notes',c.p||'{"confirmed":true}',c.p||'{"amount":"0"}',
   c.p||'{"amount":"1.001"}',c.p||'{"amount":1}',c.p||'{"incurred_at":"2026-02-30"}',c.p||'{"notes":" "}',c.p||'{"amount_kind":"yes"}')) x loop
   perform pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','expense_create',bad),'ASSISTANT_EXPENSE_INVALID');
  end loop;
  perform public.prepare_assistant_operation(c.id,'expense_create',c.p);
  v:=public.review_assistant_operation(c.id);
  assert v->>'status'='awaiting_confirmation' and not (v->'preview')?'state_stamp';
  update ec set token=(v->>'review_token')::uuid where n=c.n;
 end loop;
end $$;
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,gen_random_uuid()),'ASSISTANT_OPERATION_DENIED') from ec;
select set_config('request.jwt.claim.sub','ae000000-0000-4000-8000-000000000002',false);
select pg_temp.fails(format('select public.review_assistant_operation(%L)',id),'ASSISTANT_OPERATION_DENIED') from ec;
select set_config('request.jwt.claim.sub','ae000000-0000-4000-8000-000000000001',false);
reset role;
do $$declare perm text;begin
 foreach perm in array array['agent.use','shipments.view','prices.purchase.view'] loop
  insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
  select 'ae000000-0000-4000-8000-000000000001',id,'deny','Expense test','ae000000-0000-4000-8000-000000000001' from public.permissions where code=perm;
  perform pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',(select id from ec where n=3),(select token from ec where n=3)),'ASSISTANT_OPERATION_DENIED');
  delete from public.user_permission_overrides where user_id='ae000000-0000-4000-8000-000000000001';
 end loop;
end $$;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'ae000000-0000-4000-8000-000000000001',id,'deny','Expense test','ae000000-0000-4000-8000-000000000001' from public.permissions where code in ('finance.manage','finance.draft');
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_OPERATION_DENIED') from ec;
delete from public.user_permission_overrides where user_id='ae000000-0000-4000-8000-000000000001';
update private.assistant_operations set expires_at=clock_timestamp()-interval '1 second' where id=(select id from ec where n=8);
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_OPERATION_EXPIRED') from ec where n=8;
-- A native write failure rolls back the expense and the receipt together.
create function pg_temp.reject_expense() returns trigger language plpgsql as $$begin raise exception 'test downstream failure';end $$;
create trigger expense_failure after insert on public.expenses for each row execute function pg_temp.reject_expense();
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_EXPENSE_REFUSED') from ec where n=1;
drop trigger expense_failure on public.expenses;
do $$begin assert not exists(select 1 from public.expenses where shipment_id='ae300000-0000-4000-8000-000000000001');end $$;
set role authenticated;
-- Actual, planned, goods are drafts; retry same operation returns the same receipt.
do $$declare c ec;first jsonb;again jsonb;begin
 for c in select * from ec where n<=3 loop
  first:=public.confirm_assistant_operation(c.id,c.token);
  again:=public.confirm_assistant_operation(c.id,c.token);
  assert first=again and first->>'status'='completed';
 end loop;
end $$;
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',id,token),'ASSISTANT_OPERATION_STALE') from ec where n in (4,5,6,7);
reset role;
do $$begin
 assert (select count(*)=3 from public.expenses where shipment_id='ae300000-0000-4000-8000-000000000001');
 assert not exists(select 1 from public.expenses where shipment_id='ae300000-0000-4000-8000-000000000001' and (status<>'draft' or confirmed_at is not null or paid_at is not null));
 assert not exists(select 1 from public.expense_allocations a join public.expenses e on e.id=a.expense_id where e.shipment_id='ae300000-0000-4000-8000-000000000001');
 assert not exists(select 1 from public.cost_calculations where shipment_id='ae300000-0000-4000-8000-000000000001');
end $$;
-- Optional source documents must be visible, active and linked to this shipment.
do $$declare p jsonb; rid uuid:=gen_random_uuid(); v jsonb;doc uuid;begin
 select ec.p into p from ec where n=1;
 select d.id into doc from public.documents d join public.document_links l on l.document_id=d.id
 where l.entity_id='ae300000-0000-4000-8000-000000000001' and l.entity_type='shipment' limit 1;
 p:=p||jsonb_build_object('document_id',doc,'payee_counterparty_id','ae100000-0000-4000-8000-000000000002','amount','9.99');
 perform public.prepare_assistant_operation(rid,'expense_create',p);
 v:=public.review_assistant_operation(rid);assert v->'preview'->>'document' is not null;
 insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'ae000000-0000-4000-8000-000000000001',id,'deny','Expense document test','ae000000-0000-4000-8000-000000000001' from public.permissions where code='documents.view';
 perform pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',rid,v->>'review_token'),'ASSISTANT_OPERATION_DENIED');
 delete from public.user_permission_overrides where user_id='ae000000-0000-4000-8000-000000000001';
 update public.document_links set removed_at=now(),removed_by=auth.uid() where document_id=doc;
 perform pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',rid,v->>'review_token'),'ASSISTANT_EXPENSE_STATE');
 update public.document_links set removed_at=null,removed_by=null where document_id=doc;
 update public.currencies set is_active=false where id=(p->>'currency_id')::uuid;
 perform pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',rid,v->>'review_token'),'ASSISTANT_EXPENSE_STATE');
 update public.currencies set is_active=true where id=(p->>'currency_id')::uuid;
end $$;
-- Fresh duplicate warns, does not silently replace the old expense.
set role authenticated;
do $$declare p jsonb;rid uuid:=gen_random_uuid();v jsonb;begin
 select ec.p into p from ec where n=1;
 perform public.prepare_assistant_operation(rid,'expense_create',p);
 v:=public.review_assistant_operation(rid);assert v->'preview'->>'existing_same_count'='1';
end $$;
reset role;
-- A finance.draft user needs no accounting/payment authority; denying manage alone
-- must not accidentally deny the native alternative permission.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'ae000000-0000-4000-8000-000000000001',id,'deny','Draft alternative','ae000000-0000-4000-8000-000000000001'
from public.permissions where code in ('finance.manage','finance.confirm','finance.pay');
set role authenticated;
do $$declare p jsonb;rid uuid:=gen_random_uuid();v jsonb;begin
 select ec.p||'{"amount":"77.77"}' into p from ec where n=1;
 perform public.prepare_assistant_operation(rid,'expense_create',p);
 v:=public.review_assistant_operation(rid);
 assert public.confirm_assistant_operation(rid,(v->>'review_token')::uuid)->>'status'='completed';
end $$;
reset role;
rollback;
