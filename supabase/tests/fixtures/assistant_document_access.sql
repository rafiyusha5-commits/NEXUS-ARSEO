-- Shipment expenses, allocation, versioned landed cost and approval.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('f7900000-0000-4000-8000-000000000001','expense-payment-director@assistant-document.test','{"full_name":"Finance Director"}'),
 ('f7900000-0000-4000-8000-000000000002','expense-payment-accountant@assistant-document.test','{"full_name":"Finance Accountant"}'),
 ('f7900000-0000-4000-8000-000000000003','expense-payment-logistic@assistant-document.test','{"full_name":"Finance Logistic"}');
insert into public.user_roles(user_id,role_id)
select u.id::uuid,r.id from (values
 ('f7900000-0000-4000-8000-000000000001','director'),('f7900000-0000-4000-8000-000000000002','accountant'),('f7900000-0000-4000-8000-000000000003','logistics_specialist'))u(id,role_code) join public.app_roles r on r.code=u.role_code;

insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('f7910000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Finance Supplier','FI','ACCESS-EPM-SUP'),
 ('f7910000-0000-4000-8000-000000000002',array['carrier'],'Finance Carrier','KZ','ACCESS-EPM-CAR');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('f7920000-0000-4000-8000-000000000001','ACCESS-EPM-001','{"ru":"Финансовый тестовый товар"}','f7910000-0000-4000-8000-000000000001','active');

select set_config('request.jwt.claim.sub','f7900000-0000-4000-8000-000000000001',false);
insert into public.shipments(id,shipment_number,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select 'f7930000-0000-4000-8000-000000000001','ACCESS-EPM-SHIP-001','import','f7910000-0000-4000-8000-000000000001',(select id from public.routes limit 1),(select id from public.process_templates where code='import_eu_kz' and version=1),(select id from public.currencies where code='EUR'),(select id from public.warehouses where status='active' and not is_virtual limit 1),'f7900000-0000-4000-8000-000000000003','f7900000-0000-4000-8000-000000000001';
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity,received_quantity,unit_price,currency_id) values
 ('f7940000-0000-4000-8000-000000000001','f7930000-0000-4000-8000-000000000001','f7920000-0000-4000-8000-000000000001','piece',10,10,2,(select id from public.currencies where code='EUR'));
insert into public.inventory_batches(id,product_id,source_shipment_item_id,batch_number,expiry_date,created_by) values
 ('f7950000-0000-4000-8000-000000000001','f7920000-0000-4000-8000-000000000001','f7940000-0000-4000-8000-000000000001','ACCESS-EPM-BATCH','2027-12-31','f7900000-0000-4000-8000-000000000001');


create temporary table epm(n integer primary key,id uuid,expense_id uuid,token uuid);
grant all on epm to authenticated;
set role authenticated;
do $$declare n integer;eid uuid;begin
 for n in 1..8 loop
  eid:=public.create_expense('f7930000-0000-4000-8000-000000000001',case when n=3 then 'goods_cost' else 'transport' end,null,
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

reset role;
set session_replication_role=replica;
insert into public.documents(id,document_type_id,title,status,source,uploaded_by,current_version)
select 'f0690000-0000-4000-8000-000000000001',id,'PRIVATE-PURCHASE-DOCUMENT-123','approved','generated',auth.uid(),1
from public.document_types where code='invoice';
-- Only synthetic metadata: no real templates, source files or external services.
insert into public.document_generations(template_id,template_version_id,shipment_id,document_id,output_format,contains_prices,fields_snapshot,generated_by)
values(gen_random_uuid(),gen_random_uuid(),'f7930000-0000-4000-8000-000000000001','f0690000-0000-4000-8000-000000000001','xlsx',true,'{}',auth.uid());
insert into public.document_links(document_id,entity_type,entity_id,created_by)
values('f0690000-0000-4000-8000-000000000001','shipment','f7930000-0000-4000-8000-000000000001',auth.uid());
update public.expenses set document_id='f0690000-0000-4000-8000-000000000001' where id in(select expense_id from epm);
update public.expenses set status='draft' where id=(select expense_id from epm where n=2);
update public.expenses set status='paid',paid_at=clock_timestamp(),paid_by=auth.uid() where id=(select expense_id from epm where n=4);
set session_replication_role=origin;
create temporary table document_cases(kind text primary key,id uuid,token uuid,payload jsonb);
grant all on document_cases to authenticated;
set role authenticated;
do $$ declare k text;p jsonb;begin
 foreach k in array array['expense_mark_paid','expense_cancel','expense_allocate','expense_confirm','expense_reverse','expense_create'] loop
  p:=jsonb_build_object('expense_id',(select expense_id from epm where n=case when k='expense_confirm' then 2 when k='expense_reverse' then 4 when k='expense_cancel' then 5 when k='expense_allocate' then 6 else 1 end));
  if k in ('expense_cancel','expense_reverse') then p:=p||jsonb_build_object('reason','Synthetic document access test');end if;
  if k='expense_allocate' then p:=p||jsonb_build_object('method','by_quantity','target_currency_id',(select id::text from public.currencies where code='EUR'));end if;
  if k='expense_create' then p:=jsonb_build_object('shipment_id','f7930000-0000-4000-8000-000000000001','expense_type','transport','payee_counterparty_id',null,'amount','50','currency_id',(select id::text from public.currencies where code='EUR'),'incurred_at','2026-10-24','amount_kind','actual','document_id','f0690000-0000-4000-8000-000000000001','notes','Synthetic review');end if;
  insert into document_cases(kind,id,payload) values(k,gen_random_uuid(),p);
 end loop;
end $$;
