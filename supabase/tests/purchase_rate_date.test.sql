-- The purchase price is converted at the rate of the day the goods came (202609278700, audit finding Н9): the day of
-- the receipt, else the day the truck was loaded, else the day of the calculation (an estimate); a goods cost entered
-- as an expense needs no rate. Each line keeps the rate, its day and the basis; repeating the calculation later gives
-- the same cost for goods that came.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('db000000-0000-4000-8000-000000000001','rate-director@test.local','{"full_name":"Rate Director"}'),
 ('db000000-0000-4000-8000-000000000002','rate-accountant@test.local','{"full_name":"Rate Accountant"}');
insert into public.user_roles(user_id,role_id) select u.id,r.id from (values
 ('db000000-0000-4000-8000-000000000001'::uuid,'director'),('db000000-0000-4000-8000-000000000002'::uuid,'accountant')) u(id,code)
 join public.app_roles r on r.code=u.code;
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('db100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Rate supplier','FI','RD-SUP');
insert into public.products(id,internal_sku,name,manufacturer_id,status)
select ('db200000-0000-4000-8000-00000000000'||n)::uuid,'RD-'||n,jsonb_build_object('ru','Товар '||n),'db100000-0000-4000-8000-000000000001','active'
from generate_series(1,6) n;
select set_config('request.jwt.claim.sub','db000000-0000-4000-8000-000000000001',false);
create function pg_temp.cur(p_code text) returns uuid language sql stable as $$select id from public.currencies where code=p_code$$;
create function pg_temp.today() returns date language sql stable as $$select (now() at time zone 'Asia/Almaty')::date$$;
grant execute on function pg_temp.cur(text), pg_temp.today() to authenticated;

insert into public.shipments(id,shipment_number,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select s.id::uuid,s.number,'import','db100000-0000-4000-8000-000000000001',(select id from public.routes limit 1),
 (select id from public.process_templates where code='import_eu_kz' and version=1),pg_temp.cur('EUR'),
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),'db000000-0000-4000-8000-000000000001','db000000-0000-4000-8000-000000000001'
from (values('db300000-0000-4000-8000-000000000001','RD-1'),('db300000-0000-4000-8000-000000000002','RD-2'),('db300000-0000-4000-8000-000000000003','RD-3')) s(id,number);
-- RD-1: truck 1 received, truck 2 loaded, truck 3 planned
insert into public.shipment_transports(id,shipment_id,sequence_no,status,actual_loading_date) values
 ('db400000-0000-4000-8000-000000000001','db300000-0000-4000-8000-000000000001',1,'unloaded',pg_temp.today()-25),
 ('db400000-0000-4000-8000-000000000002','db300000-0000-4000-8000-000000000001',2,'in_transit',pg_temp.today()-5),
 ('db400000-0000-4000-8000-000000000003','db300000-0000-4000-8000-000000000001',3,'planned',null);
-- received at 00:30 in Almaty twenty days ago: still the day before in UTC
insert into public.shipment_transport_receipts(id,shipment_id,shipment_transport_id,warehouse_id,performed_by_name,received_by,received_at)
select 'db500000-0000-4000-8000-000000000001','db300000-0000-4000-8000-000000000001','db400000-0000-4000-8000-000000000001',
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),'Кладовщик','db000000-0000-4000-8000-000000000001',
 ((pg_temp.today()-20)+time '00:30') at time zone 'Asia/Almaty';
insert into public.shipment_items(id,shipment_id,shipment_transport_id,product_id,uom,ordered_quantity,shipped_quantity,received_quantity,unit_price,currency_id)
select i.id::uuid,i.shipment::uuid,i.transport::uuid,i.product::uuid,'piece',i.qty,i.shipped,i.received,i.price,pg_temp.cur(i.cur) from (values
 -- A received in truck 1, B loaded in truck 2, C ordered in truck 3, E received without a truck receipt
 ('db600000-0000-4000-8000-000000000001','db300000-0000-4000-8000-000000000001','db400000-0000-4000-8000-000000000001','db200000-0000-4000-8000-000000000001',10,10,10,2.0,'EUR'),
 ('db600000-0000-4000-8000-000000000002','db300000-0000-4000-8000-000000000001','db400000-0000-4000-8000-000000000002','db200000-0000-4000-8000-000000000002',4,4,null,3.0,'EUR'),
 ('db600000-0000-4000-8000-000000000003','db300000-0000-4000-8000-000000000001','db400000-0000-4000-8000-000000000003','db200000-0000-4000-8000-000000000003',5,null,null,1.0,'EUR'),
 ('db600000-0000-4000-8000-000000000005','db300000-0000-4000-8000-000000000001',null,'db200000-0000-4000-8000-000000000005',1,null,1,4.0,'EUR'),
 -- RD-2: D priced in roubles (no rouble rate) and paid as a goods cost expense
 ('db600000-0000-4000-8000-000000000004','db300000-0000-4000-8000-000000000002',null,'db200000-0000-4000-8000-000000000004',2,null,2,7.0,'RUB'),
 -- RD-3: F priced in roubles, no rate and no expense
 ('db600000-0000-4000-8000-000000000006','db300000-0000-4000-8000-000000000003',null,'db200000-0000-4000-8000-000000000006',3,null,3,5.0,'RUB')
) i(id,shipment,transport,product,qty,shipped,received,price,cur);
insert into public.inventory_batches(id,product_id,source_shipment_item_id,batch_number,expiry_date,created_by)
values('db700000-0000-4000-8000-000000000005','db200000-0000-4000-8000-000000000005','db600000-0000-4000-8000-000000000005','RD-LOT-E',pg_temp.today()+300,'db000000-0000-4000-8000-000000000001');
insert into public.inventory_movements(batch_id,movement_type,quantity,uom,to_warehouse_id,shipment_id,shipment_item_id,created_at)
select 'db700000-0000-4000-8000-000000000005','receipt',1,'piece',(select id from public.warehouses where status='active' and not is_virtual order by code limit 1),
 'db300000-0000-4000-8000-000000000001','db600000-0000-4000-8000-000000000005',((pg_temp.today()-5)+time '12:00') at time zone 'Asia/Almaty';
insert into public.exchange_rates(base_currency_id,quote_currency_id,rate,source,rate_date,created_by)
select pg_temp.cur('EUR'),pg_temp.cur('KZT'),r.rate,'official',pg_temp.today()-r.ago,'db000000-0000-4000-8000-000000000001'
from (values(40,480),(21,490),(20,500),(5,520),(0,550)) r(ago,rate);

create function pg_temp.line(p_shipment uuid,p_item uuid,p_version integer) returns public.cost_calculation_items language sql stable as $$
 select i.* from public.cost_calculation_items i join public.cost_calculations c on c.id=i.calculation_id
 where c.shipment_id=p_shipment and c.version_number=p_version and i.shipment_item_id=p_item $$;
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql; exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm; end if;
  return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on function pg_temp.fails(text,text) to authenticated;


-- A single approved declaration applies to the whole shipment. Truck/receipt dates are deliberately different.
insert into public.documents(id,document_type_id,title,document_date,status,uploaded_by)
select 'db800000-0000-4000-8000-000000000001',id,'Customs declaration',pg_temp.today()-20,'approved','db000000-0000-4000-8000-000000000001'
from public.document_types where code='customs_declaration';
insert into public.document_links(document_id,entity_type,entity_id,created_by) values
('db800000-0000-4000-8000-000000000001','shipment','db300000-0000-4000-8000-000000000001','db000000-0000-4000-8000-000000000001');
set role authenticated;
select set_config('request.jwt.claim.sub','db000000-0000-4000-8000-000000000001',false);
select public.calculate_shipment_cost('db300000-0000-4000-8000-000000000001',pg_temp.cur('KZT'));
reset role;
do $$begin
 assert (pg_temp.line('db300000-0000-4000-8000-000000000001','db600000-0000-4000-8000-000000000001',1)).goods_amount=10000;
 assert (select bool_and(goods_rate_basis='customs_declaration' and goods_rate=500 and goods_rate_date=pg_temp.today()-20)
 from public.cost_calculation_items), 'all lines use the declaration, not receipt/loading/today';
end $$;
-- A date correction invalidates a draft, even when quantities and expenses are unchanged.
update public.documents set document_date=pg_temp.today()-5 where id='db800000-0000-4000-8000-000000000001';
set role authenticated;
select pg_temp.fails($q$select public.approve_shipment_cost((select id from public.cost_calculations where version_number=1 and shipment_id='db300000-0000-4000-8000-000000000001'))$q$,'После расчёта изменились');
select public.calculate_shipment_cost('db300000-0000-4000-8000-000000000001',pg_temp.cur('KZT'));
reset role;
do $$begin
 assert (pg_temp.line('db300000-0000-4000-8000-000000000001','db600000-0000-4000-8000-000000000001',2)).goods_amount=10400;
end $$;
-- Editing the applicable FX rate also invalidates approval.
update public.exchange_rates set rate=521 where rate=520;
set role authenticated;
select pg_temp.fails($q$select public.approve_shipment_cost((select id from public.cost_calculations where version_number=2 and shipment_id='db300000-0000-4000-8000-000000000001'))$q$,'После расчёта изменились');
select public.calculate_shipment_cost('db300000-0000-4000-8000-000000000001',pg_temp.cur('KZT'));
select public.approve_shipment_cost((select id from public.cost_calculations where version_number=3 and shipment_id='db300000-0000-4000-8000-000000000001'));
reset role;
-- Unapproved and removed declarations cannot silently supply a final rate.
update public.documents set status='under_review' where id='db800000-0000-4000-8000-000000000001';
set role authenticated;
select public.calculate_shipment_cost('db300000-0000-4000-8000-000000000001',pg_temp.cur('KZT'));
select pg_temp.fails($q$select public.approve_shipment_cost((select id from public.cost_calculations where version_number=4 and shipment_id='db300000-0000-4000-8000-000000000001'))$q$,'предварительный');
reset role;
update public.documents set status='approved' where id='db800000-0000-4000-8000-000000000001';
update public.document_links set removed_at=now(),removed_by='db000000-0000-4000-8000-000000000001' where document_id='db800000-0000-4000-8000-000000000001';
do $$begin
 assert (select basis='calculation' from private.shipment_item_rate_date('db600000-0000-4000-8000-000000000001'));
 assert to_char(72.34,'FM990.99')='72.34';
 assert to_char(123.45,'FM999999999990.999')='123.45';
 assert position('FM990.##' in pg_get_functiondef('private.customer_order_blockers(uuid,date)'::regprocedure))=0;
end $$;
-- A vehicle-specific declaration wins; changing its allocation also invalidates a calculation.
update public.document_links set removed_at=null,removed_by=null where document_id='db800000-0000-4000-8000-000000000001';
insert into public.documents(id,document_type_id,title,document_date,status,uploaded_by)
select 'db800000-0000-4000-8000-000000000002',id,'Vehicle customs declaration',pg_temp.today()-20,'approved','db000000-0000-4000-8000-000000000001'
from public.document_types where code='customs_declaration';
insert into public.document_links(document_id,entity_type,entity_id,created_by) values
('db800000-0000-4000-8000-000000000002','shipment_transport','db400000-0000-4000-8000-000000000002','db000000-0000-4000-8000-000000000001');
do $$begin
 assert (select rate_date=pg_temp.today()-20 from private.shipment_item_rate_date('db600000-0000-4000-8000-000000000002')), 'vehicle declaration wins';
 assert (select rate_date=pg_temp.today()-5 from private.shipment_item_rate_date('db600000-0000-4000-8000-000000000003')), 'another vehicle keeps shipment declaration';
end $$;
set role authenticated;
select public.calculate_shipment_cost('db300000-0000-4000-8000-000000000001',pg_temp.cur('KZT'));
reset role;
update public.shipment_items set shipment_transport_id='db400000-0000-4000-8000-000000000003' where id='db600000-0000-4000-8000-000000000002';
set role authenticated;
select pg_temp.fails($q$select public.approve_shipment_cost((select id from public.cost_calculations where version_number=5 and shipment_id='db300000-0000-4000-8000-000000000001'))$q$,'После расчёта изменились');
reset role;
insert into public.document_links(document_id,entity_type,entity_id,created_by) values
('db800000-0000-4000-8000-000000000001','shipment_transport','db400000-0000-4000-8000-000000000002','db000000-0000-4000-8000-000000000001');
update public.shipment_items set shipment_transport_id='db400000-0000-4000-8000-000000000002' where id='db600000-0000-4000-8000-000000000002';
select pg_temp.fails($q$select * from private.shipment_item_rate_date('db600000-0000-4000-8000-000000000002')$q$,'разными датами');
rollback;
\echo 'customs purchase rate and stale approval checks passed'
