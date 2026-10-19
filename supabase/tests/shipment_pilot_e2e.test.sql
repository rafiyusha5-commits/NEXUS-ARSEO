-- Adapted from PR #9 (test/shipment-pilot-e2e), not a second independent fixture.
-- Synthetic shipment pilot. Run ONLY in the throwaway test:db cluster.
-- No live keys, binary documents, remote OCR or storage. No disabled triggers/RLS.
\set ON_ERROR_STOP 1
begin;
set local timezone='UTC';
do $$ begin assert current_date < date '2099-01-01','Fixed pilot date expired: revise fixture dates explicitly'; end $$;
insert into auth.users(id,email,raw_user_meta_data) values
 ('ee000000-0000-4000-8000-000000000001','pilot-director@example.invalid','{"full_name":"Synthetic Pilot Operator"}');
insert into public.user_roles(user_id,role_id)
select 'ee000000-0000-4000-8000-000000000001',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id,min_remaining_shelf_life_pct)
values('ee100000-0000-4000-8000-000000000001',array['customer'],'Synthetic Pilot Buyer','KZ','PILOT-BUYER',60);
insert into public.warehouses(id,code,name,city,country) values
 ('ee100000-0000-4000-8000-000000000002','PILOT-E2E','{"ru":"Вымышленный склад"}','Synthetic City','KZ');
insert into public.routes(id,origin_country,destination_country,name) values
 ('ee100000-0000-4000-8000-000000000003','FI','KZ','{"ru":"Вымышленный маршрут"}');
insert into public.document_requirements(document_type_id,applies_to,shipment_type,is_mandatory,route_id)
select id,'shipment_transport','import',true,'ee100000-0000-4000-8000-000000000003'
from public.document_types where code='cmr';

create temp table pilot_ids(k text primary key,id uuid);
create temp table pilot_results(k text primary key,v jsonb);
create temp table pilot_package(payload jsonb);
grant all on pilot_ids,pilot_results,pilot_package to authenticated;
insert into pilot_package values ('{"format":"nexus-reference-import","version":1,
 "counterparties":[{"row":1,"ref":"maker","legal_name":"Synthetic Pilot Factory","country":"FI","tax_id":"PILOT-FACTORY","roles":["manufacturer","supplier"]}],
 "products":[
 {"row":1,"internal_sku":"PILOT-E2E-A","name":{"ru":"Вымышленный товар Альфа"},"manufacturer":"maker","shelf_life_days":400,"packaging":[{"uom":"piece","units_per_parent":1,"gross_weight_kg":1,"net_weight_kg":0.9},{"uom":"box","units_per_parent":10},{"uom":"pallet","units_per_parent":100}]},
 {"row":2,"internal_sku":"PILOT-E2E-B","name":{"ru":"Вымышленный товар Бета"},"manufacturer":"maker","shelf_life_days":400,"packaging":[{"uom":"piece","units_per_parent":1,"gross_weight_kg":0.5,"net_weight_kg":0.4}]}]}');

create function pg_temp.pilot_id(text) returns uuid language sql as $$select id from pilot_ids where k=$1$$;
create function pg_temp.pilot_fails(q text,pattern text) returns void language plpgsql as $$
begin
 begin execute q; exception when others then
  assert sqlerrm ~* pattern,format('Wrong rejection: %s',sqlerrm); return;
 end;
 raise exception 'Expected rejection: %',q;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub','ee000000-0000-4000-8000-000000000001',true);
select public.import_reference_data(payload,true) from pilot_package;
do $$ begin assert not exists(select 1 from public.products where internal_sku like 'PILOT-E2E-%'),'dry run cannot import'; end $$;
select public.import_reference_data(payload,false) from pilot_package;
select public.import_reference_data(payload,false) from pilot_package;
do $$ begin assert (select count(*) from public.products where internal_sku like 'PILOT-E2E-%')=2,'reimport is idempotent'; end $$;
insert into pilot_ids select 'a',id from public.products where internal_sku='PILOT-E2E-A';
insert into pilot_ids select 'b',id from public.products where internal_sku='PILOT-E2E-B';
insert into pilot_ids select 'supplier',id from public.counterparties where tax_id='PILOT-FACTORY';
insert into pilot_ids values ('warehouse','ee100000-0000-4000-8000-000000000002');
-- Procurement is the existing forecast -> reviewed plan -> shipment workflow, not fixture inserts.
insert into pilot_ids values ('forecast',public.create_forecast('Synthetic Pilot Forecast','base','2099-01-01','2099-03-31','month','manual'));
select public.upsert_forecast_line(pg_temp.pilot_id('forecast'),pg_temp.pilot_id('a'),'ee100000-0000-4000-8000-000000000001',null,'2099-01-01',100,0,'Synthetic demand');
select public.upsert_forecast_line(pg_temp.pilot_id('forecast'),pg_temp.pilot_id('b'),'ee100000-0000-4000-8000-000000000001',null,'2099-01-01',50,0,'Synthetic demand');
select public.submit_forecast(pg_temp.pilot_id('forecast'));
select public.review_forecast(pg_temp.pilot_id('forecast'),true,'Synthetic review');
select public.approve_forecast(pg_temp.pilot_id('forecast'));
insert into pilot_ids values ('plan',public.create_purchase_plan('Synthetic Pilot Plan',pg_temp.pilot_id('forecast'),pg_temp.pilot_id('supplier')));
select public.upsert_purchase_plan_line(pg_temp.pilot_id('plan'),pg_temp.pilot_id('a'),0,0,0,0,0,100,'box',10,100,'2098-12-20','Synthetic plan');
select public.upsert_purchase_plan_line(pg_temp.pilot_id('plan'),pg_temp.pilot_id('b'),0,0,0,0,0,50,'piece',1,50,'2098-12-20','Synthetic plan');
select public.submit_purchase_plan(pg_temp.pilot_id('plan'));
select public.review_purchase_plan(pg_temp.pilot_id('plan'),true,'Synthetic logistics review');
select public.approve_purchase_plan(pg_temp.pilot_id('plan'));
insert into pilot_ids values ('shipment',public.create_purchase_plan_shipment(pg_temp.pilot_id('plan'),
 'ee100000-0000-4000-8000-000000000003',
 (select id from public.currencies where code='EUR'),pg_temp.pilot_id('warehouse'),
 'ee000000-0000-4000-8000-000000000001','2099-01-01','2099-01-10'));
select public.create_shipment_transport(pg_temp.pilot_id('shipment'),'2099-01-01','2099-01-10',null,null,'Synthetic Driver A',null,null,'PILOT-A');
select public.create_shipment_transport(pg_temp.pilot_id('shipment'),'2099-01-02','2099-01-10',null,null,'Synthetic Driver B',null,null,'PILOT-B');
insert into pilot_ids select 't'||sequence_no,id from public.shipment_transports where shipment_id=pg_temp.pilot_id('shipment');
insert into pilot_ids select 'item-a',id from public.shipment_items where shipment_id=pg_temp.pilot_id('shipment') and product_id=pg_temp.pilot_id('a');
insert into pilot_ids select 'item-b',id from public.shipment_items where shipment_id=pg_temp.pilot_id('shipment') and product_id=pg_temp.pilot_id('b');
select public.update_shipment_item(pg_temp.pilot_id('item-a'),100,2);
select public.update_shipment_item(pg_temp.pilot_id('item-b'),50,3);
do $$begin
 assert (select status='ordered' from public.purchase_plans where id=pg_temp.pilot_id('plan')),'approved procurement plan ordered';
 assert (select count(*) from public.purchase_plan_lines where purchase_plan_id=pg_temp.pilot_id('plan') and shipment_id=pg_temp.pilot_id('shipment'))=2,'plan traceability';
end$$;
select pg_temp.pilot_fails($q$select public.create_purchase_plan_shipment(pg_temp.pilot_id('plan'),'ee100000-0000-4000-8000-000000000003',(select id from public.currencies where code='EUR'),pg_temp.pilot_id('warehouse'),'ee000000-0000-4000-8000-000000000001','2099-01-01','2099-01-10')$q$,'утверждённого|уже создана');
select public.allocate_shipment_item(pg_temp.pilot_id('item-a'),pg_temp.pilot_id('t1'),60);
select public.allocate_shipment_item((select id from public.shipment_items where shipment_id=pg_temp.pilot_id('shipment') and product_id=pg_temp.pilot_id('a') and shipment_transport_id is null),pg_temp.pilot_id('t2'),40);
select public.allocate_shipment_item(pg_temp.pilot_id('item-b'),pg_temp.pilot_id('t2'),50);
do $$begin
 assert (select sum(ordered_quantity) from public.shipment_items where shipment_id=pg_temp.pilot_id('shipment'))=150,'allocation conserves quantity';
 assert not exists(select 1 from public.shipment_items where shipment_id=pg_temp.pilot_id('shipment') and shipment_transport_id is null),'all cargo allocated';
 assert (select sum(ordered_quantity) from public.shipment_items where shipment_transport_id=pg_temp.pilot_id('t1'))=60,'truck A cargo';
end$$;

-- Fake storage metadata at the existing storage boundary; actual registration and links are real operations.
insert into storage.objects(bucket_id,name,owner_id,metadata) values
 ('nexus-documents','documents/ee200000-0000-4000-8000-000000000001/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-pilot.pdf','ee000000-0000-4000-8000-000000000001','{"size":64,"mimetype":"application/pdf"}');
select public.register_document('ee200000-0000-4000-8000-000000000001',(select id from public.document_types where code='cmr'),
 'Synthetic Pilot CMR','documents/ee200000-0000-4000-8000-000000000001/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-pilot.pdf','synthetic-pilot.pdf',
 'PILOT-CMR-1',null,'2099-01-01','2099-01-05',null,null,null,repeat('a',64),
 jsonb_build_array(jsonb_build_object('entity_type','shipment_transport','entity_id',pg_temp.pilot_id('t1'))));
select pg_temp.pilot_fails($q$select public.register_document('ee200000-0000-4000-8000-000000000001',(select id from public.document_types where code='cmr'),'Synthetic duplicate','documents/ee200000-0000-4000-8000-000000000001/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-pilot.pdf','synthetic-pilot.pdf')$q$,'duplicate key|уже');
insert into pilot_ids select 'version',id from public.document_versions where document_id='ee200000-0000-4000-8000-000000000001';
insert into pilot_ids select 'extraction',(public.begin_shipment_source_ocr(pg_temp.pilot_id('shipment'),'ee200000-0000-4000-8000-000000000001',pg_temp.pilot_id('version'),'waybill',repeat('a',64),'synthetic','pilot-v1')->>'extraction_id')::uuid;
select public.finish_shipment_source_ocr(pg_temp.pilot_id('extraction'),'needs_review','{"driver_name":"Synthetic OCR Driver A","vehicle_plate":"PILOT-A","gross_weight_kg":999}');
do $$begin
 assert (select driver_name='Synthetic Driver A' from public.shipment_transports where id=pg_temp.pilot_id('t1')),'OCR never applies itself';
 assert (select shipment_transport_id=pg_temp.pilot_id('t1') from public.shipment_source_extractions where id=pg_temp.pilot_id('extraction')),'OCR follows document link';
 assert exists(select 1 from jsonb_array_elements(public.shipment_document_check(pg_temp.pilot_id('shipment'))->'findings') f where f->>'code'='weight_mismatch'),'check finds fabricated OCR weight';
 assert exists(select 1 from jsonb_array_elements(public.shipment_document_check(pg_temp.pilot_id('shipment'))->'findings') f
  where f->>'code'='document_missing' and f->>'field'='cmr' and f->>'transport_id'=pg_temp.pilot_id('t2')::text),'check detects missing CMR on second vehicle';
end$$;
select public.run_shipment_document_check(pg_temp.pilot_id('shipment'),'manual');
insert into pilot_results select 'notification_count',to_jsonb(count(*)) from public.notifications where recipient_user_id='ee000000-0000-4000-8000-000000000001';
select public.run_shipment_document_check(pg_temp.pilot_id('shipment'),'manual');
do $$begin assert (select to_jsonb(count(*)) from public.notifications where recipient_user_id='ee000000-0000-4000-8000-000000000001')=(select v from pilot_results where k='notification_count'),'unchanged findings do not spam notifications';end$$;
select public.review_shipment_source_extraction(pg_temp.pilot_id('extraction'),' {"driver_name":"Synthetic OCR Driver A","vehicle_plate":"PILOT-A","gross_weight_kg":60}',true);
-- Separate shipment-wide invoice, checked through existing operations; replay replaces nothing twice.
insert into storage.objects(bucket_id,name,owner_id,metadata) values
 ('nexus-documents','documents/ee200000-0000-4000-8000-000000000002/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-invoice.pdf','ee000000-0000-4000-8000-000000000001','{"size":64,"mimetype":"application/pdf"}');
select public.register_document('ee200000-0000-4000-8000-000000000002',(select id from public.document_types where code='invoice'),
 'Synthetic invoice','documents/ee200000-0000-4000-8000-000000000002/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-invoice.pdf','invoice.pdf',
 'SYNTH-INV',null,'2099-01-01',null,null,null,null,repeat('b',64),jsonb_build_array(jsonb_build_object('entity_type','shipment','entity_id',pg_temp.pilot_id('shipment'))));
insert into pilot_ids select 'invoice-extraction',public.upsert_shipment_source_extraction(pg_temp.pilot_id('shipment'),document_id,id,'invoice','extracted','{"invoice_number":"SYNTH-INV"}')
 from public.document_versions where document_id='ee200000-0000-4000-8000-000000000002';
select public.review_shipment_source_extraction(pg_temp.pilot_id('invoice-extraction'),'{"invoice_number":"SYNTH-INV"}',false);
select public.apply_shipment_document_quantities(pg_temp.pilot_id('invoice-extraction'),array['confirmed','shipped'],
 (select jsonb_agg(jsonb_build_object('shipment_item_id',id,'quantity',ordered_quantity)) from public.shipment_items where shipment_id=pg_temp.pilot_id('shipment')));
do $$declare result jsonb;begin
 result:=public.apply_shipment_document_quantities(pg_temp.pilot_id('invoice-extraction'),array['confirmed','shipped'],
 (select jsonb_agg(jsonb_build_object('shipment_item_id',id,'quantity',ordered_quantity)) from public.shipment_items where shipment_id=pg_temp.pilot_id('shipment')));
 assert (result->>'changed')::int=0,'quantity replay';
 assert (select count(*)=6 from public.shipment_item_quantity_confirmations where extraction_id=pg_temp.pilot_id('invoice-extraction')),'one history per field/item';
end$$;
do $$begin
 assert (select driver_name='Synthetic OCR Driver A' from public.shipment_transports where id=pg_temp.pilot_id('t1')),'human confirmation applies';
 assert (select driver_name='Synthetic Driver B' from public.shipment_transports where id=pg_temp.pilot_id('t2')),'other vehicle unchanged';
 assert (public.begin_shipment_source_ocr(pg_temp.pilot_id('shipment'),'ee200000-0000-4000-8000-000000000001',pg_temp.pilot_id('version'),'waybill',repeat('a',64),'synthetic','pilot-v1')->>'action')='reuse','repeated OCR reuses confirmation';
 assert (select count(*) from public.documents where id='ee200000-0000-4000-8000-000000000001')=1,'one source document';
 assert (select count(*) from public.document_versions where document_id='ee200000-0000-4000-8000-000000000001')=1,'one source version';
end$$;
-- Fixed-date expiry check through the same rule engine; owner needed because public RPC uses current_date.
reset role;
do $$begin assert exists(select 1 from jsonb_array_elements(private.document_check_findings(pg_temp.pilot_id('shipment'),'2099-01-10')) f where f->>'code'='document_expired'),'fixed-date expiry';end$$;
set local role authenticated;

-- Existing workflow operations for procurement, transport and customs (no actual customs service).
do $$declare task_stage record; begin
 for task_stage in select r.id from public.shipment_stage_runs r join public.shipment_stages s on s.id=r.stage_id
 where r.shipment_id=pg_temp.pilot_id('shipment') and s.sequence_order<11 order by s.sequence_order,r.id loop
  perform public.change_shipment_stage_status(task_stage.id,'completed',null,'Synthetic Operator');
 end loop;
 assert exists(select 1 from public.shipment_stage_runs r join public.shipment_stages s on s.id=r.stage_id where r.shipment_id=pg_temp.pilot_id('shipment') and s.status_category='customs' and r.status='completed'),'customs workflow recorded';
end$$;
select public.change_shipment_transport_status(pg_temp.pilot_id('t1'),'in_transit');
select public.change_shipment_transport_status(pg_temp.pilot_id('t2'),'in_transit');
select public.change_shipment_transport_status(pg_temp.pilot_id('t1'),'arrived');
select public.change_shipment_transport_status(pg_temp.pilot_id('t2'),'arrived');
do $$declare t uuid; payload jsonb; begin
 for t in select id from pilot_ids where k in ('t1','t2') order by k loop
  select jsonb_agg(jsonb_build_object('item_id',id,'accepted_quantity',case when t=pg_temp.pilot_id('t1') then 57 else ordered_quantity end,
   'damaged_quantity',case when t=pg_temp.pilot_id('t1') then 1 else 0 end,'batch_number','SYNTHETIC-'||t::text||'-'||product_id::text,
   'manufacture_date',case when t=pg_temp.pilot_id('t1') then '2098-04-01' else '2098-11-01' end,
   'expiry_date',case when t=pg_temp.pilot_id('t1') then '2099-05-06' else '2099-12-06' end,
   'discrepancy_reason',case when t=pg_temp.pilot_id('t1') then 'Synthetic: 2 missing, 1 damaged' else null end)) into payload
  from public.shipment_items where shipment_transport_id=t;
  perform public.receive_shipment_transport(t,null,payload,'Synthetic Receiver','pilot');
  perform pg_temp.pilot_fails(format('select public.receive_shipment_transport(%L,null,%L::jsonb,%L,null)',t,payload,'Synthetic Receiver'),'уже принят');
 end loop;
 assert (select sum(quantity_on_hand) from public.inventory_balances b join public.inventory_batches x on x.id=b.batch_id where x.source_shipment_transport_id in (pg_temp.pilot_id('t1'),pg_temp.pilot_id('t2')))=147,'only accepted stock enters balance';
 assert (select count(*) from public.shipment_transport_receipts where shipment_id=pg_temp.pilot_id('shipment'))=2,'one receipt per vehicle';
 assert (select count(*) from public.inventory_batches where source_shipment_transport_id in (pg_temp.pilot_id('t1'),pg_temp.pilot_id('t2')))=3,'three traceable batches';
 assert (select sum(received_quantity) from public.shipment_items where shipment_id=pg_temp.pilot_id('shipment'))=148,'received includes one damaged';
end$$;

-- Fixed dates, FEFO across two batches, low shelf-life guarantee, repeated reservation.
insert into pilot_ids values ('sale',public.create_customer_order('ee100000-0000-4000-8000-000000000001',null,pg_temp.pilot_id('warehouse'),'2099-01-20',(select id from public.currencies where code='EUR'),'Synthetic pilot'));
insert into pilot_ids values ('sale-item',public.add_customer_order_item(pg_temp.pilot_id('sale'),pg_temp.pilot_id('a'),7,'box',50,60));
select public.reserve_customer_order_item_fefo(pg_temp.pilot_id('sale-item'));
select public.reserve_customer_order_item_fefo(pg_temp.pilot_id('sale-item'));
do $$begin
 assert (select sum(quantity_reserved) from public.inventory_balances b join public.inventory_batches x on x.id=b.batch_id where x.product_id=pg_temp.pilot_id('a'))=70,'repeated reservation does not double count';
 assert (select quantity_reserved from public.inventory_balances b join public.inventory_batches x on x.id=b.batch_id where x.source_shipment_transport_id=pg_temp.pilot_id('t1'))=57,'earlier expiry reserved first';
 assert (select count(*) from public.inventory_reservations where sale_item_id=pg_temp.pilot_id('sale-item') and status='active')=2,'two active FEFO allocations';
 assert (select remaining_shelf_life_pct from public.inventory_reservations r join public.inventory_batches b on b.id=r.batch_id
  where r.sale_item_id=pg_temp.pilot_id('sale-item') and r.status='active' and b.source_shipment_transport_id=pg_temp.pilot_id('t1'))=26.5,'fixed-date remaining shelf life: 106 of 400 days';
end$$;
select pg_temp.pilot_fails('select public.confirm_customer_order(pg_temp.pilot_id(''sale''))','гарантийное письмо');
insert into pilot_ids values ('guarantee',public.create_sale_guarantee_letter(pg_temp.pilot_id('sale'),'Synthetic low shelf-life approval'));
select public.change_sale_guarantee_status(pg_temp.pilot_id('guarantee'),'approved');
select public.confirm_customer_order(pg_temp.pilot_id('sale'));
do $$begin assert (select status='confirmed' from public.sales where id=pg_temp.pilot_id('sale')),'sale confirmed, NOT shipped';end$$;

-- Warehouse transfer keeps batch provenance; it does not create another receipt.
insert into pilot_ids select 'warehouse-2',id from public.warehouses where status='active' and not is_virtual and id<>pg_temp.pilot_id('warehouse') order by code limit 1;
insert into pilot_ids select 'move',public.create_inventory_operation_document('transfer','2099-01-10',pg_temp.pilot_id('warehouse'),pg_temp.pilot_id('warehouse-2'),'SYNTH-TRANSFER','Synthetic transfer',null);
select public.add_inventory_operation_line(pg_temp.pilot_id('move'),b.id,null,10,null,null) from public.inventory_balances b
 join public.inventory_batches x on x.id=b.batch_id where x.product_id=pg_temp.pilot_id('b') and b.warehouse_id=pg_temp.pilot_id('warehouse');
select public.post_inventory_operation_document(pg_temp.pilot_id('move'));
select pg_temp.pilot_fails('select public.post_inventory_operation_document(pg_temp.pilot_id(''move''))','черновик|провед');
select public.fulfill_customer_order(pg_temp.pilot_id('sale'));
select public.fulfill_customer_order(pg_temp.pilot_id('sale'));
do $$begin
 assert (select sum(quantity_on_hand)=77 and sum(quantity_reserved)=0 from public.inventory_balances b join public.inventory_batches x on x.id=b.batch_id where x.product_id in(pg_temp.pilot_id('a'),pg_temp.pilot_id('b'))),'stock after shipment';
 assert (select sum(quantity)=70 and count(*)=2 from public.inventory_movements where sale_id=pg_temp.pilot_id('sale')),'no repeated issue';
 assert (select sum(sale_quantity)=7 and sum(quantity)=70 from public.inventory_reservations where sale_item_id=pg_temp.pilot_id('sale-item') and status='fulfilled'),'seven boxes consume seventy pieces';
end$$;
insert into pilot_ids select 'return',public.create_customer_return(pg_temp.pilot_id('sale'),jsonb_build_array(jsonb_build_object(
 'sale_item_id',pg_temp.pilot_id('sale-item'),'batch_id',(select id from public.inventory_batches where source_shipment_transport_id=pg_temp.pilot_id('t1')),'quantity',1,'reason_code','refused')),'Synthetic unopened box');
select public.decide_customer_return_item(id,'restock',null,'Synthetic inspection: intact') from public.customer_return_items where return_id=pg_temp.pilot_id('return');
select pg_temp.pilot_fails(format('select public.decide_customer_return_item(%L,''restock'',null,''Synthetic replay'')',
 (select id from public.customer_return_items where return_id=pg_temp.pilot_id('return'))),'уже принято');
-- Same-currency costing exercises real expenses without inventing an exchange rate or changing VAT rules.
insert into pilot_ids select 'expense',public.create_expense(pg_temp.pilot_id('shipment'),'transport',pg_temp.pilot_id('supplier'),50,(select id from public.currencies where code='EUR'),'2099-01-10',false,null,'Synthetic actual cost');
select public.confirm_expense(pg_temp.pilot_id('expense'));
select public.allocate_expense(pg_temp.pilot_id('expense'),'by_quantity',(select id from public.currencies where code='EUR'));
insert into pilot_ids select 'cost',public.calculate_shipment_cost(pg_temp.pilot_id('shipment'),(select id from public.currencies where code='EUR'));
select public.approve_shipment_cost(pg_temp.pilot_id('cost'));
do $$begin
 assert (select goods_total=346 and expenses_total=50 and landed_total=396 and status='approved' from public.cost_calculations where id=pg_temp.pilot_id('cost')),'current costing rules';
 assert (select sum(quantity_on_hand) filter(where b.uom='piece')=77 and sum(quantity_on_hand) filter(where b.uom='box')=1 and sum(quantity_reserved)=0 from public.inventory_balances b join public.inventory_batches x on x.id=b.batch_id where x.product_id in(pg_temp.pilot_id('a'),pg_temp.pilot_id('b'))),'stock after return: 77 pieces plus one 10-piece box, never add unlike units';
end$$;
-- Closing is a real last-stage operation, not the old PR9 expectation of premature closure.
-- The missing-CMR negative case above is separate from the completed scenario: supply CMR for vehicle 2.
insert into storage.objects(bucket_id,name,owner_id,metadata) values
 ('nexus-documents','documents/ee200000-0000-4000-8000-000000000003/cccccccccccccccccccccccccccccccc-cmr2.pdf','ee000000-0000-4000-8000-000000000001','{"size":64,"mimetype":"application/pdf"}');
select public.register_document('ee200000-0000-4000-8000-000000000003',(select id from public.document_types where code='cmr'),
 'Synthetic Pilot CMR 2','documents/ee200000-0000-4000-8000-000000000003/cccccccccccccccccccccccccccccccc-cmr2.pdf','cmr2.pdf',
 'PILOT-CMR-2',null,'2099-01-01',null,null,null,null,repeat('c',64),
 jsonb_build_array(jsonb_build_object('entity_type','shipment_transport','entity_id',pg_temp.pilot_id('t2'))));
do $$begin
 assert not exists(select 1 from jsonb_array_elements(public.shipment_document_check(pg_temp.pilot_id('shipment'))->'findings') f
  where f->>'code'='document_missing' and f->>'field'='cmr'),'CMRs incomplete before closing';
end$$;
do $$declare task_stage record; begin
 for task_stage in select r.id from public.shipment_stage_runs r join public.shipment_stages s on s.id=r.stage_id
 where r.shipment_id=pg_temp.pilot_id('shipment') and s.code<>'closed' and r.status not in ('completed','skipped','not_applicable') order by s.sequence_order,r.id loop
  perform public.change_shipment_stage_status(task_stage.id,'completed',null,'Synthetic Operator');
 end loop;
 assert (select status<>'closed' from public.shipments where id=pg_temp.pilot_id('shipment')),'not closed before final stage';
 perform public.change_shipment_stage_status((select r.id from public.shipment_stage_runs r join public.shipment_stages s on s.id=r.stage_id where r.shipment_id=pg_temp.pilot_id('shipment') and s.code='closed'),'completed',null,'Synthetic Operator');
 assert (select status='closed' and is_locked and closed_at is not null from public.shipments where id=pg_temp.pilot_id('shipment')),'final stage closes shipment';
end$$;
select 'PILOT_RESULT='||jsonb_build_object('ordered',150,'received_including_damage',148,
 'accepted',(select sum(i.accepted_quantity) from public.shipment_transport_receipt_items i join public.shipment_transport_receipts r on r.id=i.receipt_id where r.shipment_id=pg_temp.pilot_id('shipment')),
 'receipt_movements',(select sum(m.quantity) from public.inventory_movements m where m.shipment_transport_id in (pg_temp.pilot_id('t1'),pg_temp.pilot_id('t2')) and m.movement_type='receipt'),
 'stock_by_uom',(select jsonb_object_agg(uom,qty) from (select b.uom,sum(b.quantity_on_hand) qty from public.inventory_balances b join public.inventory_batches x on x.id=b.batch_id where x.product_id in (pg_temp.pilot_id('a'),pg_temp.pilot_id('b')) group by b.uom) q),
 'reserved',(select sum(b.quantity_reserved) from public.inventory_balances b join public.inventory_batches x on x.id=b.batch_id where x.product_id in (pg_temp.pilot_id('a'),pg_temp.pilot_id('b'))),
 'sale_status',(select status from public.sales where id=pg_temp.pilot_id('sale')),
 'shipment_status',(select status from public.shipments where id=pg_temp.pilot_id('shipment')),
 'coverage','Synthetic operations and CMR completeness; not proof that all document/business warnings are absent',
 'documents',(select count(*) from public.documents where id in ('ee200000-0000-4000-8000-000000000001','ee200000-0000-4000-8000-000000000002','ee200000-0000-4000-8000-000000000003')))::text;
reset role;
-- The actual report loader receives this DB snapshot through a local PostgREST-shaped adapter.
select 'PILOT_REPORT='||jsonb_build_object(
 'shipments',(select jsonb_agg(to_jsonb(s)) from public.shipments s where id=pg_temp.pilot_id('shipment')),
 'shipment_transports',(select jsonb_agg(to_jsonb(t)) from public.shipment_transports t where shipment_id=pg_temp.pilot_id('shipment')),
 'shipment_stage_runs',(select jsonb_agg(to_jsonb(r)||jsonb_build_object('stage',to_jsonb(s))) from public.shipment_stage_runs r join public.shipment_stages s on s.id=r.stage_id where r.shipment_id=pg_temp.pilot_id('shipment')),
 'shipment_items',(select jsonb_agg((to_jsonb(i)-'unit_price')||jsonb_build_object('product',jsonb_build_object('internal_sku',p.internal_sku,'name',p.name))) from public.shipment_items i join public.products p on p.id=i.product_id where i.shipment_id=pg_temp.pilot_id('shipment')),
 'prices',(select jsonb_agg(jsonb_build_object('item_id',id,'unit_price',unit_price)) from public.shipment_items where shipment_id=pg_temp.pilot_id('shipment')),
 'shipment_transport_receipts',(select jsonb_agg(to_jsonb(r)||jsonb_build_object('items',
  (select jsonb_agg(to_jsonb(i)||jsonb_build_object('batch',to_jsonb(b),'movement',jsonb_build_object('quantity',m.quantity))) from public.shipment_transport_receipt_items i
   left join public.inventory_batches b on b.id=i.inventory_batch_id left join public.inventory_movements m on m.id=i.inventory_movement_id where i.receipt_id=r.id))) from public.shipment_transport_receipts r where r.shipment_id=pg_temp.pilot_id('shipment')),
 'documents',(select jsonb_agg(to_jsonb(d)) from public.documents d where id in ('ee200000-0000-4000-8000-000000000001','ee200000-0000-4000-8000-000000000002','ee200000-0000-4000-8000-000000000003')),
 'document_links',(select jsonb_agg(to_jsonb(l)) from public.document_links l where document_id in ('ee200000-0000-4000-8000-000000000001','ee200000-0000-4000-8000-000000000002','ee200000-0000-4000-8000-000000000003')),
 'document_requirements',(select jsonb_agg(to_jsonb(r)) from public.document_requirements r where is_active),
 'tasks',(select coalesce(jsonb_agg(to_jsonb(t)),'[]'::jsonb) from public.tasks t where shipment_id=pg_temp.pilot_id('shipment')))::text;
rollback;
