-- Shipment expenses, allocation, versioned landed cost and approval.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('ef500000-0000-4000-8000-000000000001','exact-expense-director@test.local','{"full_name":"Finance Director"}'),
 ('ef500000-0000-4000-8000-000000000002','exact-expense-accountant@test.local','{"full_name":"Finance Accountant"}'),
 ('ef500000-0000-4000-8000-000000000003','exact-expense-logistic@test.local','{"full_name":"Finance Logistic"}');
insert into public.user_roles(user_id,role_id)
select u.id::uuid,r.id from (values
 ('ef500000-0000-4000-8000-000000000001','director'),('ef500000-0000-4000-8000-000000000002','accountant'),('ef500000-0000-4000-8000-000000000003','logistics_specialist'))u(id,role_code) join public.app_roles r on r.code=u.role_code;

insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('ef510000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Exact Supplier','FI','EXACT-SUP'),
 ('ef510000-0000-4000-8000-000000000002',array['carrier'],'Exact Carrier','KZ','EXACT-CAR');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('ef520000-0000-4000-8000-000000000001','EXACT-001','{"ru":"Финансовый тестовый товар"}','ef510000-0000-4000-8000-000000000001','active');

select set_config('request.jwt.claim.sub','ef500000-0000-4000-8000-000000000001',false);
insert into public.shipments(id,shipment_number,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select 'ef530000-0000-4000-8000-000000000001','EXACT-SHIP-001','import','ef510000-0000-4000-8000-000000000001',(select id from public.routes limit 1),(select id from public.process_templates where code='import_eu_kz' and version=1),(select id from public.currencies where code='EUR'),(select id from public.warehouses where status='active' and not is_virtual limit 1),'ef500000-0000-4000-8000-000000000003','ef500000-0000-4000-8000-000000000001';
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity,received_quantity,unit_price,currency_id) values
 ('ef540000-0000-4000-8000-000000000001','ef530000-0000-4000-8000-000000000001','ef520000-0000-4000-8000-000000000001','piece',10,10,2,(select id from public.currencies where code='EUR'));
insert into public.inventory_batches(id,product_id,source_shipment_item_id,batch_number,expiry_date,created_by) values
 ('ef550000-0000-4000-8000-000000000001','ef520000-0000-4000-8000-000000000001','ef540000-0000-4000-8000-000000000001','EXACT-BATCH','2027-12-31','ef500000-0000-4000-8000-000000000001');



insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('ef520000-0000-4000-8000-000000000002','EXACT-002','{"ru":"Второй товар"}','ef510000-0000-4000-8000-000000000001','active'),
 ('ef520000-0000-4000-8000-000000000003','EXACT-003','{"ru":"Нулевая позиция"}','ef510000-0000-4000-8000-000000000001','active');
insert into public.product_packaging(product_id,uom,units_per_parent,gross_weight_kg,volume_m3,length_cm,width_cm,height_cm) values
 ('ef520000-0000-4000-8000-000000000001','piece',1,2,0.1,null,null,null),
 ('ef520000-0000-4000-8000-000000000002','piece',1,4,null,100,100,20)
on conflict(product_id,uom) do update set gross_weight_kg=excluded.gross_weight_kg,volume_m3=excluded.volume_m3,length_cm=excluded.length_cm,width_cm=excluded.width_cm,height_cm=excluded.height_cm;
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity,shipped_quantity,received_quantity,unit_price,currency_id) values
 ('ef540000-0000-4000-8000-000000000002','ef530000-0000-4000-8000-000000000001','ef520000-0000-4000-8000-000000000002','piece',25,20,null,3,(select id from public.currencies where code='EUR')),
 ('ef540000-0000-4000-8000-000000000003','ef530000-0000-4000-8000-000000000001','ef520000-0000-4000-8000-000000000003','box',1,1,0,null,(select id from public.currencies where code='EUR'));
create temporary table exact_cases(n integer primary key,id uuid,expense_id uuid,token uuid,p jsonb);
grant all on exact_cases to authenticated;
set role authenticated;
do $$declare n integer;eid uuid;begin
 for n in 1..8 loop
  eid:=public.create_expense('ef530000-0000-4000-8000-000000000001','transport',null,123.45,
   (select id from public.currencies where code='EUR'),'2026-10-24',n=6,null,'Allocation review');
  if n<>7 then perform public.confirm_expense(eid);end if;
  insert into exact_cases values(n,gen_random_uuid(),eid,null,jsonb_build_object('expense_id',eid,'method',case n when 2 then 'by_weight' when 3 then 'by_volume' when 4 then 'by_value' else 'by_quantity' end,'target_currency_id',(select id from public.currencies where code='EUR')));
 end loop;
end $$;
reset role;
update public.expenses set status='paid',paid_at=now(),paid_by=auth.uid() where id=(select expense_id from exact_cases where n=5);

insert into public.documents(id,document_type_id,title,status,uploaded_by)
select 'ef580000-0000-4000-8000-000000000001',id,'Synthetic exact allocation source','approved',auth.uid() from public.document_types where code='invoice';
insert into public.document_links(document_id,entity_type,entity_id,created_by)
values('ef580000-0000-4000-8000-000000000001','shipment','ef530000-0000-4000-8000-000000000001',auth.uid());
insert into storage.objects(bucket_id,name,owner_id,metadata)
values('nexus-documents','documents/ef580000-0000-4000-8000-000000000001/0123456789abcdef0123456789abcdef-synthetic.pdf',auth.uid()::text,'{"mimetype":"application/pdf","size":100}');
insert into public.document_versions(document_id,version_number,storage_path,original_filename,mime_type,file_size_bytes,uploaded_by)
values('ef580000-0000-4000-8000-000000000001',1,'documents/ef580000-0000-4000-8000-000000000001/0123456789abcdef0123456789abcdef-synthetic.pdf','synthetic.pdf','application/pdf',100,auth.uid());
-- EXACT FIXTURE END
create function pg_temp.fails(q text, pattern text) returns void language plpgsql as $$
begin begin execute q;exception when others then
 if sqlerrm !~ pattern then raise exception 'Expected %, got %',pattern,sqlerrm;end if;return;
 end;raise exception 'Expected failure: %',pattern;end $$;
create temporary table exact_review as select n,gen_random_uuid() request_id,
 public.exact_expense_allocation_context(expense_id,(select id from public.currencies where code='EUR'),'ef580000-0000-4000-8000-000000000001') c
 from exact_cases where n<>6;
grant all on exact_review to authenticated;
create function pg_temp.save_exact(n integer, amounts jsonb default '[{"item_id":"ef540000-0000-4000-8000-000000000001","amount":"23.45"},{"item_id":"ef540000-0000-4000-8000-000000000002","amount":"100.00"}]',note text default 'Exact amounts from synthetic source') returns uuid language sql as $$
 select public.save_exact_expense_allocation(v.request_id,(v.c->>'expense_id')::uuid,(v.c->>'target_currency_id')::uuid,
 (v.c->>'source_document_id')::uuid,v.c->>'stamp',amounts,note) from exact_review v where v.n=$1;
$$;
set role authenticated;
select pg_temp.fails('select pg_temp.save_exact(1, ''{}'')','список');
select pg_temp.fails('select pg_temp.save_exact(1, ''[]'')','200');
do $$declare a jsonb;begin
 foreach a in array array[
 '[{"item_id":"ef540000-0000-4000-8000-000000000001","amount":"123.45"}]'::jsonb,
 '[{"item_id":"ef540000-0000-4000-8000-000000000001","amount":"23.45"},{"item_id":"ef540000-0000-4000-8000-000000000001","amount":"100"}]'::jsonb,
 '[{"item_id":"ef540000-0000-4000-8000-000000000001","amount":"23.45"},{"item_id":"ef540000-0000-4000-8000-000000000003","amount":"100"}]'::jsonb,
 '[{"item_id":"ef540000-0000-4000-8000-000000000001","amount":"23.451"},{"item_id":"ef540000-0000-4000-8000-000000000002","amount":"99.999"}]'::jsonb,
 '[{"item_id":"ef540000-0000-4000-8000-000000000001","amount":"-1"},{"item_id":"ef540000-0000-4000-8000-000000000002","amount":"124.45"}]'::jsonb,
 '[{"item_id":"ef540000-0000-4000-8000-000000000001","amount":"24.45"},{"item_id":"ef540000-0000-4000-8000-000000000002","amount":"100"}]'::jsonb
 ] loop perform pg_temp.fails(format('select pg_temp.save_exact(1,%L::jsonb)',a),'позицию|повторяется|сотых|Сумма');end loop;
end $$;
select pg_temp.fails(format('select public.exact_expense_allocation_context(%L,%L,null)',(select expense_id from exact_cases where n=6),(select id from public.currencies where code='EUR')),'фактический');
reset role;
do $$declare perm text;begin
 foreach perm in array array['finance.view','prices.purchase.view','products.view','shipments.view','documents.view','costing.calculate'] loop
 insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by) select auth.uid(),id,'deny','Exact permission regression',auth.uid() from public.permissions where code=perm;
 perform pg_temp.fails('select pg_temp.save_exact(1)','доступ|права');
 delete from public.user_permission_overrides where user_id=auth.uid();
 end loop;
 insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by) select auth.uid(),id,'deny','Draft confirmation denied',auth.uid() from public.permissions where code='finance.confirm';
 perform pg_temp.fails('select pg_temp.save_exact(7)','права|прав');
 delete from public.user_permission_overrides where user_id=auth.uid();
end $$;
create function pg_temp.reject_exact() returns trigger language plpgsql as $$begin raise exception 'late exact failure';end $$;
create trigger exact_failure after insert on public.expense_allocations for each row execute function pg_temp.reject_exact();
select pg_temp.fails('select pg_temp.save_exact(7)','late exact failure');
drop trigger exact_failure on public.expense_allocations;
do $$begin assert (select status='draft' and confirmed_at is null from public.expenses where id=(select expense_id from exact_cases where n=7));
 assert not exists(select 1 from public.expense_allocations where expense_id in(select expense_id from exact_cases));
 assert not exists(select 1 from private.expense_allocation_revisions where expense_id in(select expense_id from exact_cases));end $$;
set role authenticated;
select pg_temp.save_exact(n) from exact_review where n in(1,5,7);
select pg_temp.save_exact(n) from exact_review where n in(1,5,7);
select pg_temp.fails('select pg_temp.save_exact(1,note=>''Different reason for same request'')','Идентификатор');
reset role;
do $$begin
 assert (select count(*)=6 from public.expense_allocations where expense_id in(select expense_id from exact_cases));
 assert (select count(*)=3 from private.expense_allocation_revisions where expense_id in(select expense_id from exact_cases));
 assert (select status='paid' and paid_at is not null from public.expenses where id=(select expense_id from exact_cases where n=5));
 assert not exists(select 1 from public.expenses where id in(select expense_id from exact_cases where n<>5) and paid_at is not null);
 assert (select allocated_amount=23.45 from public.expense_allocations where expense_id=(select expense_id from exact_cases where n=1) and shipment_item_id='ef540000-0000-4000-8000-000000000001');
end $$;
update public.documents set current_version=current_version+1 where id='ef580000-0000-4000-8000-000000000001';
select pg_temp.fails('select pg_temp.save_exact(2)','Данные изменились');
update public.documents set current_version=current_version-1 where id='ef580000-0000-4000-8000-000000000001';
update public.document_links set removed_at=now(),removed_by=auth.uid() where document_id='ef580000-0000-4000-8000-000000000001';
select pg_temp.fails('select pg_temp.save_exact(2)','Источник');
update public.document_links set removed_at=null,removed_by=null where document_id='ef580000-0000-4000-8000-000000000001';
update public.shipment_items set shipped_quantity=19 where id='ef540000-0000-4000-8000-000000000002';
select pg_temp.fails('select pg_temp.save_exact(3)','Данные изменились');
update public.shipment_items set shipped_quantity=20 where id='ef540000-0000-4000-8000-000000000002';
update public.expenses set amount=124 where id=(select expense_id from exact_cases where n=4);
select pg_temp.fails('select pg_temp.save_exact(4)','Данные изменились');
update public.expenses set amount=123.45 where id=(select expense_id from exact_cases where n=4);
update exact_review v set request_id=gen_random_uuid(),c=public.exact_expense_allocation_context((v.c->>'expense_id')::uuid,(v.c->>'target_currency_id')::uuid,null) where n=1;
select pg_temp.save_exact(1,'[{"item_id":"ef540000-0000-4000-8000-000000000001","amount":"0"},{"item_id":"ef540000-0000-4000-8000-000000000002","amount":"123.45"}]','Reallocation: source explained in note');
do $$begin
 assert (select count(*)=2 from public.expense_allocations where expense_id=(select expense_id from exact_cases where n=1));
 assert (select count(*)=2 from private.expense_allocation_revisions where expense_id=(select expense_id from exact_cases where n=1));
 assert not exists(select 1 from public.cost_calculations where shipment_id='ef530000-0000-4000-8000-000000000001');
 assert not has_table_privilege('authenticated','private.expense_allocation_revisions','insert');
 assert not has_function_privilege('service_role','public.save_exact_expense_allocation(uuid,uuid,uuid,uuid,text,jsonb,text)','execute');
 assert not has_function_privilege('anon','public.exact_expense_allocation_context(uuid,uuid,uuid)','execute');
end $$;
select pg_temp.fails('update private.expense_allocation_revisions set basis_note=''Tampered source explanation''','неизменяема');
-- Only allocated actual expenses enter a new draft. Approval remains a separate operation.
update public.expenses set is_planned=true where id in(select expense_id from exact_cases where n not in(1,5,7));
set role authenticated;
select public.calculate_shipment_cost('ef530000-0000-4000-8000-000000000001',(select id from public.currencies where code='EUR'));
reset role;
do $$begin
 assert (select count(*)=1 from public.cost_calculations where shipment_id='ef530000-0000-4000-8000-000000000001');
 assert (select status='draft' and approved_at is null and expenses_total=370.35 from public.cost_calculations where shipment_id='ef530000-0000-4000-8000-000000000001');
 assert not exists(select 1 from public.inventory_batches where id='ef550000-0000-4000-8000-000000000001' and unit_landed_cost is not null);
end $$;
rollback;
