-- Reviewed source documents may carry the party requisites of the export documents (202609274800).
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('fe000000-0000-4000-8000-000000000001','requisites-director@test.local','{"full_name":"Requisites Director"}');
insert into public.user_roles(user_id,role_id) select 'fe000000-0000-4000-8000-000000000001',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('fe100000-0000-4000-8000-000000000001',array['customer'],'Requisites customer','KZ','REQ-A');

set session_replication_role=replica;
insert into public.shipments(id,shipment_number,type,customer_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select 'fe300000-0000-4000-8000-000000000001','REQ-EXP-1','export','fe100000-0000-4000-8000-000000000001',
 (select id from public.routes limit 1),(select id from public.process_templates limit 1),(select id from public.currencies where code='EUR'),
 (select id from public.warehouses where code='AKT'),'fe000000-0000-4000-8000-000000000001','fe000000-0000-4000-8000-000000000001';
insert into public.documents(id,document_type_id,title,status,source,uploaded_by,current_version)
select 'fe200000-0000-4000-8000-000000000001',id,'Contract','approved','manual_upload','fe000000-0000-4000-8000-000000000001',1 from public.document_types where code='cmr';
insert into public.document_versions(id,document_id,version_number,storage_path,original_filename,mime_type,file_size_bytes,is_current,uploaded_by)
values('fe210000-0000-4000-8000-000000000001','fe200000-0000-4000-8000-000000000001',1,
 'documents/fe200000-0000-4000-8000-000000000001/00000000000000000000000000000001-c.pdf','c.pdf','application/pdf',10,true,'fe000000-0000-4000-8000-000000000001');
insert into public.shipment_source_extractions(id,shipment_id,document_id,document_version_id,source_kind,status,extracted_data,extractor_version,requested_by)
values('fe400000-0000-4000-8000-000000000001','fe300000-0000-4000-8000-000000000001','fe200000-0000-4000-8000-000000000001','fe210000-0000-4000-8000-000000000001',
 'contract','extracted','{"supplier_address":"Тестландия, г. Тестоград, ул. Заводская, 2"}','rules-v1','fe000000-0000-4000-8000-000000000001');
set session_replication_role=origin;

set role authenticated;
select set_config('request.jwt.claim.sub','fe000000-0000-4000-8000-000000000001',false);

do $$ declare v_message text; v_long text:=repeat('а',480); begin
 perform public.review_shipment_source_extraction('fe400000-0000-4000-8000-000000000001',
  jsonb_build_object('supplier_address',v_long,'customer_address','Тестландия, г. Город-А','customer_kpp','000000000','seller_phone','+0 000 000 0000',
   'bank_details','Тест-Банк БИК 000000000','sender_signatory','Тестов Т.Т., директор','loading_city','г. Тестоград','goods_category','тестовые изделия','payment_terms','DAP Город-А'),false);
 assert (select confirmed_data->>'bank_details' from public.shipment_source_extractions where id='fe400000-0000-4000-8000-000000000001')='Тест-Банк БИК 000000000','requisites are stored as confirmed data';
 assert (select length(confirmed_data->>'supplier_address') from public.shipment_source_extractions where id='fe400000-0000-4000-8000-000000000001')=480,'addresses may be up to 500 characters';
 -- the allow-list is still closed: unknown fields and over-long ordinary fields are refused
 begin perform public.review_shipment_source_extraction('fe400000-0000-4000-8000-000000000001','{"password":"x"}'::jsonb,false);
 exception when others then v_message:=sqlerrm; end;
 assert v_message like '%Недопустимое поле%','unknown fields stay rejected';
 v_message:=null;
 begin perform public.review_shipment_source_extraction('fe400000-0000-4000-8000-000000000001',jsonb_build_object('sender_signatory',repeat('x',201)),false);
 exception when others then v_message:=sqlerrm; end;
 assert v_message like '%слишком длинное%','ordinary fields keep the 200-character limit';
end $$;

-- An electronic invoice brings structured lines next to the scalar fields; confirming the whole
-- extraction must neither fail on them nor copy them into confirmed_data (they stay in extracted_data).
reset role;
update public.shipment_source_extractions
 set extracted_data=extracted_data||'{"esf_number":"777","invoice_items":[{"line_number":1,"product_name":"X","hs_code":"0000000001","uom":"Штука","quantity":1,"unit_price":2,"line_total":2}]}'::jsonb
 where id='fe400000-0000-4000-8000-000000000001';
set role authenticated;
select set_config('request.jwt.claim.sub','fe000000-0000-4000-8000-000000000001',false);
do $$ begin
 perform public.confirm_shipment_source_extraction('fe400000-0000-4000-8000-000000000001');
 assert (select confirmed_data->>'esf_number' from public.shipment_source_extractions where id='fe400000-0000-4000-8000-000000000001')='777','scalar invoice fields are confirmed';
 assert (select not (confirmed_data ? 'invoice_items') from public.shipment_source_extractions where id='fe400000-0000-4000-8000-000000000001'),'structured lines are not copied into confirmed data';
 assert (select jsonb_array_length(extracted_data->'invoice_items') from public.shipment_source_extractions where id='fe400000-0000-4000-8000-000000000001')=1,'invoice lines stay readable on the confirmed extraction';
end $$;

reset role;
rollback;
\echo 'source_document_requisites: all checks passed'
