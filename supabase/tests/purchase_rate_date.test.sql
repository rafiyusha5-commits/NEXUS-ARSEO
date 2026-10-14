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

-- ---------- 1. each item at the rate of its own day, in a session far from Kazakhstan ----------
set role authenticated;
select set_config('request.jwt.claim.sub','db000000-0000-4000-8000-000000000002',false);
set timezone='Etc/GMT+12';
select public.calculate_shipment_cost('db300000-0000-4000-8000-000000000001',pg_temp.cur('KZT'));
reset timezone;
reset role;
do $$ declare a record; b record; c record; e record; begin
 a:=pg_temp.line('db300000-0000-4000-8000-000000000001','db600000-0000-4000-8000-000000000001',1);
 b:=pg_temp.line('db300000-0000-4000-8000-000000000001','db600000-0000-4000-8000-000000000002',1);
 c:=pg_temp.line('db300000-0000-4000-8000-000000000001','db600000-0000-4000-8000-000000000003',1);
 e:=pg_temp.line('db300000-0000-4000-8000-000000000001','db600000-0000-4000-8000-000000000005',1);
 assert a.goods_rate_basis='receipt' and a.goods_rate_date=pg_temp.today()-20 and a.goods_rate=500 and a.goods_amount=10000,
  format('A at the rate of its receipt day in Almaty (10 x 2 x 500): %s',row_to_json(a));
 assert b.goods_rate_basis='loading' and b.goods_rate_date=pg_temp.today()-5 and b.goods_rate=520 and b.goods_amount=6240,
  format('B at the rate of the loading day (4 x 3 x 520): %s',row_to_json(b));
 assert c.goods_rate_basis='calculation' and c.goods_rate_date=pg_temp.today() and c.goods_rate=550 and c.goods_amount=2750,
  format('C is an estimate at the rate of the business day (5 x 1 x 550): %s',row_to_json(c));
 assert e.goods_rate_basis='receipt' and e.goods_rate_date=pg_temp.today()-5 and e.goods_amount=2080,
  format('E received without a truck receipt: the day of its receipt movement (1 x 4 x 520): %s',row_to_json(e));
end $$;

-- ---------- 2. a new rate later moves only the estimate; a corrected receipt day moves the received goods ----------
insert into public.exchange_rates(base_currency_id,quote_currency_id,rate,source,rate_date,created_by)
values(pg_temp.cur('EUR'),pg_temp.cur('KZT'),560,'bank',pg_temp.today(),'db000000-0000-4000-8000-000000000001');
set role authenticated;
select set_config('request.jwt.claim.sub','db000000-0000-4000-8000-000000000002',false);
select public.calculate_shipment_cost('db300000-0000-4000-8000-000000000001',pg_temp.cur('KZT'));
reset role;
do $$ begin
 assert (pg_temp.line('db300000-0000-4000-8000-000000000001','db600000-0000-4000-8000-000000000001',2)).goods_amount=10000,'received goods keep their cost';
 assert (pg_temp.line('db300000-0000-4000-8000-000000000001','db600000-0000-4000-8000-000000000002',2)).goods_amount=6240,'loaded goods keep their cost';
 assert (pg_temp.line('db300000-0000-4000-8000-000000000001','db600000-0000-4000-8000-000000000003',2)).goods_amount=2800,'the estimate follows the new rate';
end $$;
update public.shipment_transport_receipts set received_at=((pg_temp.today()-40)+time '15:00') at time zone 'Asia/Almaty'
where id='db500000-0000-4000-8000-000000000001';
set role authenticated;
select set_config('request.jwt.claim.sub','db000000-0000-4000-8000-000000000002',false);
select public.calculate_shipment_cost('db300000-0000-4000-8000-000000000001',pg_temp.cur('KZT'));
reset role;
do $$ declare a record; begin
 a:=pg_temp.line('db300000-0000-4000-8000-000000000001','db600000-0000-4000-8000-000000000001',3);
 assert a.goods_rate_date=pg_temp.today()-40 and a.goods_amount=9600,format('the corrected receipt day decides (10 x 2 x 480): %s',row_to_json(a));
end $$;

-- ---------- 3. a goods cost paid as an expense needs no rate; a missing rate names the currencies, day and item ----------
set role authenticated;
select set_config('request.jwt.claim.sub','db000000-0000-4000-8000-000000000002',false);
select public.create_expense('db300000-0000-4000-8000-000000000002','goods_cost','db100000-0000-4000-8000-000000000001',9000,
 pg_temp.cur('KZT'),pg_temp.today()-3,false,null,'RD-2 оплата товара');
select public.confirm_expense((select id from public.expenses where notes='RD-2 оплата товара'));
select public.allocate_expense((select id from public.expenses where notes='RD-2 оплата товара'),'by_quantity',pg_temp.cur('KZT'));
select public.calculate_shipment_cost('db300000-0000-4000-8000-000000000002',pg_temp.cur('KZT'));
select pg_temp.fails($$select public.calculate_shipment_cost('db300000-0000-4000-8000-000000000003',pg_temp.cur('KZT'))$$,
 'Нет курса RUB → KZT на \d\d\.\d\d\.\d{4} для закупочной цены RD-6');
reset role;
do $$ declare d record; begin
 d:=pg_temp.line('db300000-0000-4000-8000-000000000002','db600000-0000-4000-8000-000000000004',1);
 assert d.goods_rate_basis='expense' and d.goods_rate is null and d.goods_rate_date is null and d.goods_amount=9000,
  format('the goods cost comes from the expense: %s',row_to_json(d));
end $$;

rollback;
\echo 'purchase_rate_date: all checks passed'
