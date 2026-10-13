-- Confirmed and shipped quantities from source documents (202609277200): permissions, document state and kind,
-- vehicle scope, validation, history of every change, no history for unchanged values, closed shipments.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('eb000000-0000-4000-8000-000000000001','dq-director@test.local','{"full_name":"DQ Director"}'),
 ('eb000000-0000-4000-8000-000000000002','dq-noreview@test.local','{"full_name":"DQ No review"}'),
 ('eb000000-0000-4000-8000-000000000003','dq-noupdate@test.local','{"full_name":"DQ No update"}');
insert into public.user_roles(user_id,role_id) select u::uuid,r.id from (values
 ('eb000000-0000-4000-8000-000000000001'),('eb000000-0000-4000-8000-000000000002'),('eb000000-0000-4000-8000-000000000003')) v(u)
 cross join public.app_roles r where r.code='director';
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select x.u::uuid,p.id,'deny','document quantities test','eb000000-0000-4000-8000-000000000001' from (values
 ('eb000000-0000-4000-8000-000000000002','source_documents.review'),
 ('eb000000-0000-4000-8000-000000000003','shipments.update')) x(u,code) join public.permissions p on p.code=x.code;

insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('eb100000-0000-4000-8000-000000000001',array['customer'],'DQ customer','KZ','DQ-A'),
 ('eb100000-0000-4000-8000-000000000002',array['manufacturer','supplier'],'DQ supplier','FI','DQ-B');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('eb200000-0000-4000-8000-000000000001','DQ-001','{"ru":"Товар DQ 1"}','eb100000-0000-4000-8000-000000000002','active'),
 ('eb200000-0000-4000-8000-000000000002','DQ-002','{"ru":"Товар DQ 2"}','eb100000-0000-4000-8000-000000000002','active');

set session_replication_role=replica;
insert into public.shipments(id,shipment_number,type,customer_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select s.id::uuid,s.num,'export','eb100000-0000-4000-8000-000000000001',(select id from public.routes limit 1),(select id from public.process_templates limit 1),
 (select id from public.currencies where code='EUR'),(select id from public.warehouses where code='AKT'),'eb000000-0000-4000-8000-000000000001','eb000000-0000-4000-8000-000000000001'
from (values ('eb300000-0000-4000-8000-000000000001','DQ-1'),('eb300000-0000-4000-8000-000000000002','DQ-OTHER')) s(id,num);
insert into public.shipment_transports(id,shipment_id,sequence_no) values
 ('eb310000-0000-4000-8000-000000000001','eb300000-0000-4000-8000-000000000001',1),
 ('eb310000-0000-4000-8000-000000000002','eb300000-0000-4000-8000-000000000001',2);
insert into public.shipment_items(id,shipment_id,shipment_transport_id,product_id,uom,ordered_quantity) values
 ('eb400000-0000-4000-8000-000000000001','eb300000-0000-4000-8000-000000000001','eb310000-0000-4000-8000-000000000001','eb200000-0000-4000-8000-000000000001','piece',1000),
 ('eb400000-0000-4000-8000-000000000002','eb300000-0000-4000-8000-000000000001','eb310000-0000-4000-8000-000000000002','eb200000-0000-4000-8000-000000000002','box',50),
 ('eb400000-0000-4000-8000-000000000003','eb300000-0000-4000-8000-000000000001',null,'eb200000-0000-4000-8000-000000000002','box',20),
 ('eb400000-0000-4000-8000-000000000009','eb300000-0000-4000-8000-000000000002',null,'eb200000-0000-4000-8000-000000000001','piece',5);
-- Documents: 1 invoice (whole shipment), 2 packing list of vehicle 1, 3 unconfirmed invoice, 4 driver document.
insert into public.documents(id,document_type_id,title,status,source,uploaded_by,current_version)
select ('eb50'||n||'000-0000-4000-8000-000000000001')::uuid,(select id from public.document_types where code='driver_document'),'DQ doc '||n,'approved','manual_upload','eb000000-0000-4000-8000-000000000001',1
from generate_series(1,4) n;
insert into public.document_versions(id,document_id,version_number,storage_path,original_filename,mime_type,file_size_bytes,is_current,uploaded_by)
select ('eb51'||n||'000-0000-4000-8000-000000000001')::uuid,('eb50'||n||'000-0000-4000-8000-000000000001')::uuid,1,
 'documents/eb50'||n||'000-0000-4000-8000-000000000001/00000000000000000000000000000001-d.pdf','d.pdf','application/pdf',10,true,'eb000000-0000-4000-8000-000000000001'
from generate_series(1,4) n;
insert into public.shipment_source_extractions(id,shipment_id,document_id,document_version_id,shipment_transport_id,source_kind,status,extractor_version,requested_by,reviewed_by,reviewed_at)
select ('eb60'||n||'000-0000-4000-8000-000000000001')::uuid,'eb300000-0000-4000-8000-000000000001',('eb50'||n||'000-0000-4000-8000-000000000001')::uuid,('eb51'||n||'000-0000-4000-8000-000000000001')::uuid,
 case n when 2 then 'eb310000-0000-4000-8000-000000000001'::uuid end,
 case n when 1 then 'invoice' when 2 then 'specification' when 3 then 'invoice' else 'driver_document' end,
 case n when 3 then 'extracted' else 'confirmed' end,'rules-test','eb000000-0000-4000-8000-000000000001',
 case n when 3 then null else 'eb000000-0000-4000-8000-000000000001'::uuid end,case n when 3 then null else now() end
from generate_series(1,4) n;
set session_replication_role=origin;

create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql; exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm; end if;
  return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on function pg_temp.fails(text,text) to authenticated;

set role authenticated;

-- ---------- permissions ----------
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000002',false);
select pg_temp.fails($$select public.apply_shipment_document_quantities('eb601000-0000-4000-8000-000000000001',array['confirmed'],'[{"shipment_item_id":"eb400000-0000-4000-8000-000000000001","quantity":980}]')$$,'Недостаточно прав');
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000003',false);
select pg_temp.fails($$select public.apply_shipment_document_quantities('eb601000-0000-4000-8000-000000000001',array['confirmed'],'[{"shipment_item_id":"eb400000-0000-4000-8000-000000000001","quantity":980}]')$$,'Недостаточно прав');

select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',false);
-- Only through the function: the item fields and the history cannot be written directly.
select pg_temp.fails($$update public.shipment_items set confirmed_quantity=1 where id='eb400000-0000-4000-8000-000000000001'$$,'permission denied');
select pg_temp.fails($$insert into public.shipment_item_quantity_confirmations(shipment_id,shipment_item_id,extraction_id,document_id,document_version_id,field,quantity,confirmed_by)
 values('eb300000-0000-4000-8000-000000000001','eb400000-0000-4000-8000-000000000001','eb601000-0000-4000-8000-000000000001','eb501000-0000-4000-8000-000000000001','eb511000-0000-4000-8000-000000000001','confirmed',1,'eb000000-0000-4000-8000-000000000001')$$,'permission denied');

-- ---------- document state and kind ----------
select pg_temp.fails($$select public.apply_shipment_document_quantities('eb603000-0000-4000-8000-000000000001',array['confirmed'],'[{"shipment_item_id":"eb400000-0000-4000-8000-000000000001","quantity":980}]')$$,'Сначала подтвердите');
select pg_temp.fails($$select public.apply_shipment_document_quantities('eb604000-0000-4000-8000-000000000001',array['confirmed'],'[{"shipment_item_id":"eb400000-0000-4000-8000-000000000001","quantity":980}]')$$,'инвойса, упаковочного листа или накладной');
select pg_temp.fails($$select public.apply_shipment_document_quantities('eb609000-0000-4000-8000-000000000001',array['confirmed'],'[{"shipment_item_id":"eb400000-0000-4000-8000-000000000001","quantity":980}]')$$,'Документ не найден');

-- ---------- validation ----------
select pg_temp.fails($$select public.apply_shipment_document_quantities('eb601000-0000-4000-8000-000000000001',array[]::text[],'[{"shipment_item_id":"eb400000-0000-4000-8000-000000000001","quantity":980}]')$$,'какое количество');
select pg_temp.fails($$select public.apply_shipment_document_quantities('eb601000-0000-4000-8000-000000000001',array['received'],'[{"shipment_item_id":"eb400000-0000-4000-8000-000000000001","quantity":980}]')$$,'какое количество');
select pg_temp.fails($$select public.apply_shipment_document_quantities('eb601000-0000-4000-8000-000000000001',array['confirmed'],'[]')$$,'хотя бы для одной');
select pg_temp.fails($$select public.apply_shipment_document_quantities('eb601000-0000-4000-8000-000000000001',array['confirmed'],'[{"shipment_item_id":"eb400000-0000-4000-8000-000000000001","quantity":-1}]')$$,'неотрицательным');
select pg_temp.fails($$select public.apply_shipment_document_quantities('eb601000-0000-4000-8000-000000000001',array['confirmed'],'[{"shipment_item_id":"eb400000-0000-4000-8000-000000000001","quantity":1.0005}]')$$,'тремя знаками');
select pg_temp.fails($$select public.apply_shipment_document_quantities('eb601000-0000-4000-8000-000000000001',array['confirmed'],'[{"shipment_item_id":"eb400000-0000-4000-8000-000000000001","quantity":"980"}]')$$,'должно быть числом');
select pg_temp.fails($$select public.apply_shipment_document_quantities('eb601000-0000-4000-8000-000000000001',array['confirmed'],'[{"shipment_item_id":"not-a-uuid","quantity":1}]')$$,'Некорректная позиция');
select pg_temp.fails($$select public.apply_shipment_document_quantities('eb601000-0000-4000-8000-000000000001',array['confirmed'],'[{"shipment_item_id":"eb400000-0000-4000-8000-000000000001","quantity":1},{"shipment_item_id":"eb400000-0000-4000-8000-000000000001","quantity":2}]')$$,'дважды');
select pg_temp.fails($$select public.apply_shipment_document_quantities('eb601000-0000-4000-8000-000000000001',array['confirmed'],'[{"shipment_item_id":"eb400000-0000-4000-8000-000000000009","quantity":5}]')$$,'не относится к этой поставке');
do $$ begin
 assert not exists(select 1 from public.shipment_items where shipment_id='eb300000-0000-4000-8000-000000000001' and (confirmed_quantity is not null or shipped_quantity is not null)),'refused calls changed nothing';
 assert not exists(select 1 from public.shipment_item_quantity_confirmations),'refused calls left no history';
end $$;

-- ---------- invoice: confirmed quantities of the whole shipment ----------
do $$ declare r jsonb; begin
 r:=public.apply_shipment_document_quantities('eb601000-0000-4000-8000-000000000001',array['confirmed'],
   '[{"shipment_item_id":"eb400000-0000-4000-8000-000000000001","quantity":980},{"shipment_item_id":"eb400000-0000-4000-8000-000000000002","quantity":50}]');
 assert (r->>'changed')::int=2 and (r->>'items')::int=2,'two values written: '||r::text;
 assert (select confirmed_quantity=980 and shipped_quantity is null from public.shipment_items where id='eb400000-0000-4000-8000-000000000001'),'confirmed is written, shipped is untouched';
 assert (select confirmed_quantity=50 from public.shipment_items where id='eb400000-0000-4000-8000-000000000002'),'the second item is confirmed';
 assert (select confirmed_quantity is null from public.shipment_items where id='eb400000-0000-4000-8000-000000000003'),'an item not listed is untouched';
 assert (select count(*)=2 from public.shipment_item_quantity_confirmations where field='confirmed' and previous_quantity is null
          and extraction_id='eb601000-0000-4000-8000-000000000001' and document_id='eb501000-0000-4000-8000-000000000001'
          and document_version_id='eb511000-0000-4000-8000-000000000001' and confirmed_by='eb000000-0000-4000-8000-000000000001'),'history keeps the document, its version and the employee';
 -- The same values again: nothing changes, nothing is added to the history.
 r:=public.apply_shipment_document_quantities('eb601000-0000-4000-8000-000000000001',array['confirmed'],
   '[{"shipment_item_id":"eb400000-0000-4000-8000-000000000001","quantity":980.000}]');
 assert (r->>'changed')::int=0,'unchanged value is not written again';
 assert (select count(*)=2 from public.shipment_item_quantity_confirmations),'no history for an unchanged value';
 -- A correction keeps the previous value.
 perform public.apply_shipment_document_quantities('eb601000-0000-4000-8000-000000000001',array['confirmed'],
   '[{"shipment_item_id":"eb400000-0000-4000-8000-000000000001","quantity":990.5}]');
 assert (select previous_quantity=980 and quantity=990.5 from public.shipment_item_quantity_confirmations
         where shipment_item_id='eb400000-0000-4000-8000-000000000001' order by confirmed_at desc, quantity desc limit 1),'correction keeps the previous value';
 -- Both fields at once, including zero (the supplier did not ship the item).
 r:=public.apply_shipment_document_quantities('eb601000-0000-4000-8000-000000000001',array['confirmed','shipped'],
   '[{"shipment_item_id":"eb400000-0000-4000-8000-000000000003","quantity":0}]');
 assert (r->>'changed')::int=2,'both fields are written';
 assert (select confirmed_quantity=0 and shipped_quantity=0 from public.shipment_items where id='eb400000-0000-4000-8000-000000000003'),'zero is a valid quantity';
end $$;

-- ---------- packing list of vehicle 1: only the cargo of vehicle 1 ----------
select pg_temp.fails($$select public.apply_shipment_document_quantities('eb602000-0000-4000-8000-000000000001',array['shipped'],'[{"shipment_item_id":"eb400000-0000-4000-8000-000000000002","quantity":48}]')$$,'другому автомобилю');
select pg_temp.fails($$select public.apply_shipment_document_quantities('eb602000-0000-4000-8000-000000000001',array['shipped'],'[{"shipment_item_id":"eb400000-0000-4000-8000-000000000003","quantity":1}]')$$,'другому автомобилю');
do $$ begin
 perform public.apply_shipment_document_quantities('eb602000-0000-4000-8000-000000000001',array['shipped'],'[{"shipment_item_id":"eb400000-0000-4000-8000-000000000001","quantity":975}]');
 assert (select shipped_quantity=975 and confirmed_quantity=990.5 from public.shipment_items where id='eb400000-0000-4000-8000-000000000001'),'shipped by the packing list, confirmed stays from the invoice';
 assert (select count(*)=1 from public.shipment_item_quantity_confirmations where extraction_id='eb602000-0000-4000-8000-000000000001' and field='shipped'),'packing list history';
 assert (select count(*)>=5 from public.shipment_item_quantity_confirmations where shipment_id='eb300000-0000-4000-8000-000000000001'),'history is visible to shipment users';
end $$;

-- ---------- closed or held shipment ----------
reset role;
set session_replication_role=replica;
update public.shipments set status='on_hold' where id='eb300000-0000-4000-8000-000000000001';
set session_replication_role=origin;
set role authenticated;
select pg_temp.fails($$select public.apply_shipment_document_quantities('eb601000-0000-4000-8000-000000000001',array['confirmed'],'[{"shipment_item_id":"eb400000-0000-4000-8000-000000000001","quantity":1}]')$$,'приостановлена');
reset role;
set session_replication_role=replica;
update public.shipments set status='closed',is_locked=true where id='eb300000-0000-4000-8000-000000000001';
set session_replication_role=origin;
set role authenticated;
select pg_temp.fails($$select public.apply_shipment_document_quantities('eb601000-0000-4000-8000-000000000001',array['confirmed'],'[{"shipment_item_id":"eb400000-0000-4000-8000-000000000001","quantity":1}]')$$,'закрыта');

reset role;
rollback;
