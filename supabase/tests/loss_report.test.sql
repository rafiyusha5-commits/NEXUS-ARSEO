-- 202611280100: losses of goods and stock at risk by shelf life (block Г). Synthetic scenario with hand calculations:
-- write-offs with reasons, a decreasing and an increasing adjustment, a document posted without a reason (as before the
-- migration), a cancelled write-off, a batch without approved cost, a direct write-off movement, a returned item
-- written off, a return by expiry and a markdown of a low shelf-life sale (reference columns), stock at risk.
-- EUR -> KZT official rate 500. Everything is rolled back.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('e1000000-0000-4000-8000-000000000001','loss-director@example.invalid','{"full_name":"Loss director"}'),
 ('e1000000-0000-4000-8000-000000000002','loss-no-prices@example.invalid','{"full_name":"Director without purchase prices"}'),
 ('e1000000-0000-4000-8000-000000000003','loss-admin@example.invalid','{"full_name":"Loss administrator"}'),
 ('e1000000-0000-4000-8000-000000000004','loss-no-reports@example.invalid','{"full_name":"Without reports"}');
insert into public.user_roles(user_id,role_id) select u.id,r.id from (values
 ('e1000000-0000-4000-8000-000000000001'::uuid,'director'),('e1000000-0000-4000-8000-000000000002'::uuid,'director'),
 ('e1000000-0000-4000-8000-000000000003'::uuid,'administrator'),('e1000000-0000-4000-8000-000000000004'::uuid,'director')) u(id,code)
 join public.app_roles r on r.code=u.code;
-- Whatever the roles give: the director runs the whole path and reads reports; the second has no purchase prices,
-- the fourth no reports.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select u.id,p.id,'allow','Synthetic full path','e1000000-0000-4000-8000-000000000003'
   from (values ('e1000000-0000-4000-8000-000000000001'::uuid),('e1000000-0000-4000-8000-000000000002'::uuid),
                ('e1000000-0000-4000-8000-000000000003'::uuid)) u(id)
   cross join public.permissions p
  where p.code in ('reports.view','inventory.view','inventory.write_off','inventory.control','inventory.move','prices.purchase.view',
                   'costing.approve','sales.view','sales.manage')
    and not (u.id='e1000000-0000-4000-8000-000000000002' and p.code='prices.purchase.view');
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'e1000000-0000-4000-8000-000000000002',id,'deny','No purchase prices','e1000000-0000-4000-8000-000000000003'
   from public.permissions where code='prices.purchase.view';
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'e1000000-0000-4000-8000-000000000004',id,'deny','No reports','e1000000-0000-4000-8000-000000000003'
   from public.permissions where code='reports.view';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('e1100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Loss supplier','FI','E1-SUP'),
 ('e1100000-0000-4000-8000-000000000011',array['customer'],'Казахстанский клиент потерь','KZ','E1-C1');
insert into public.products(id,internal_sku,name,brand,manufacturer_id,status) values
 ('e1200000-0000-4000-8000-000000000001','E1-A','{"ru":"Товар A"}','Fazer','e1100000-0000-4000-8000-000000000001','active'),
 ('e1200000-0000-4000-8000-000000000002','E1-B','{"ru":"Товар B"}','Geisha','e1100000-0000-4000-8000-000000000001','active'),
 ('e1200000-0000-4000-8000-000000000003','E1-N','{"ru":"Товар без себестоимости"}',null,'e1100000-0000-4000-8000-000000000001','active'),
 ('e1200000-0000-4000-8000-000000000004','E1-R','{"ru":"Товар под риском"}','Fazer','e1100000-0000-4000-8000-000000000001','active');
insert into public.exchange_rates(base_currency_id,quote_currency_id,rate,source,rate_date,created_by)
 select (select id from public.currencies where code='EUR'),(select id from public.currencies where code='KZT'),500,'official',current_date-1,
 'e1000000-0000-4000-8000-000000000003';
insert into public.vat_rates(country,rate,valid_from,reason,created_by)
 values ('KZ',0.12,'2020-01-01','Синтетическая ставка','e1000000-0000-4000-8000-000000000003');

create temporary table e1(k text primary key,id uuid);
grant all on e1 to authenticated;
create function pg_temp.id(p_key text) returns uuid language sql stable as $$ select id from e1 where k=p_key $$;
create function pg_temp.cur(p_code text) returns uuid language sql stable as $$ select id from public.currencies where code=p_code $$;
create function pg_temp.wh() returns uuid language sql stable security definer as $$
 select id from public.warehouses where status='active' and not is_virtual order by code limit 1 $$;
create function pg_temp.batch(p_number text) returns uuid language sql stable security definer as $$
 select id from public.inventory_batches where batch_number=p_number $$;
create function pg_temp.balance(p_number text) returns uuid language sql stable security definer as $$
 select b.id from public.inventory_balances b join public.inventory_batches x on x.id=b.batch_id where x.batch_number=p_number limit 1 $$;
-- One vehicle; lines [{"product":..,"qty":..,"price":..,"batch":..,"expiry_days":..}], received; cost approved if asked.
create function pg_temp.ship(p_code text,p_lines jsonb,p_approve boolean) returns void language plpgsql as $$
declare v_ship uuid;v_t uuid;v_line jsonb;v_receipt jsonb:='[]';v_item uuid;
begin
 v_ship:=public.create_shipment_with_stages(p_code,'import','e1100000-0000-4000-8000-000000000001',null,
  (select id from public.routes where status='active' order by created_at limit 1),pg_temp.cur('EUR'),pg_temp.wh(),auth.uid(),current_date,current_date+14);
 insert into e1 values(p_code,v_ship);
 perform public.add_shipment_transport(v_ship,null,null,null,null);
 select id into v_t from public.shipment_transports where shipment_id=v_ship;
 for v_line in select * from jsonb_array_elements(p_lines) loop
  v_item:=public.allocate_shipment_item(public.create_shipment_item(v_ship,(v_line->>'product')::uuid,'piece',(v_line->>'qty')::numeric,
   (v_line->>'price')::numeric,pg_temp.cur('EUR')),v_t,(v_line->>'qty')::numeric);
  v_receipt:=v_receipt||jsonb_build_object('item_id',v_item,'accepted_quantity',(v_line->>'qty')::numeric,'batch_number',v_line->>'batch',
   'expiry_date',(current_date+(v_line->>'expiry_days')::int)::text);
 end loop;
 perform public.change_shipment_transport_status(v_t,'arrived');
 perform public.receive_shipment_transport(v_t,null,v_receipt,'Кладовщик',null);
 if p_approve then perform public.approve_shipment_cost(public.calculate_shipment_cost(v_ship,pg_temp.cur('EUR')));end if;
end $$;
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
create function pg_temp.keyed(p_report jsonb,p_key text) returns jsonb language sql immutable as $$
 select r from jsonb_array_elements(p_report->'rows') r where r->>'key'=p_key $$;
-- A write-off or adjustment document with one line and its reason; posted. Returns the document.
create function pg_temp.loss(p_type text,p_batch text,p_qty numeric,p_direction text,p_reason text) returns uuid language plpgsql as $$
declare v_doc uuid;
begin
 v_doc:=public.create_inventory_operation_document(p_type,current_date,pg_temp.wh(),null,'ACT','Акт потерь','Кладовщик');
 perform public.add_inventory_loss_line(v_doc,pg_temp.balance(p_batch),p_qty,p_direction,p_reason,null);
 perform public.post_inventory_operation_document(v_doc);
 return v_doc;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

select set_config('request.jwt.claim.sub','e1000000-0000-4000-8000-000000000001',true);
set local role authenticated;
-- A1 100 pcs at 10 EUR, B1 100 pcs at 20 EUR (approved); N1 50 pcs, cost not approved; R1 10 pcs at 5 EUR expires in
-- 20 days, R2 10 pcs at 5 EUR in 60 days, R3 10 pcs at 5 EUR (made expired below).
select pg_temp.ship('E1-S1','[{"product":"e1200000-0000-4000-8000-000000000001","qty":100,"price":10,"batch":"E1-A1","expiry_days":200},
 {"product":"e1200000-0000-4000-8000-000000000002","qty":100,"price":20,"batch":"E1-B1","expiry_days":200}]',true);
select pg_temp.ship('E1-S2','[{"product":"e1200000-0000-4000-8000-000000000003","qty":50,"price":7,"batch":"E1-N1","expiry_days":200}]',false);
select pg_temp.ship('E1-S3','[{"product":"e1200000-0000-4000-8000-000000000004","qty":10,"price":5,"batch":"E1-R1","expiry_days":20}]',true);
select pg_temp.ship('E1-S4','[{"product":"e1200000-0000-4000-8000-000000000004","qty":10,"price":5,"batch":"E1-R2","expiry_days":60}]',true);
select pg_temp.ship('E1-S5','[{"product":"e1200000-0000-4000-8000-000000000004","qty":10,"price":5,"batch":"E1-R3","expiry_days":30}]',true);

-- 1. A write-off is not posted while a line has no reason; a reason set in the draft lets it post.
insert into e1 values('doc-damaged',public.create_inventory_operation_document('write_off',current_date,pg_temp.wh(),null,'ACT-1','Бой','Кладовщик'));
insert into e1 select 'line-damaged',public.add_inventory_operation_line(pg_temp.id('doc-damaged'),pg_temp.balance('E1-A1'),null,5,null,null);
select pg_temp.fails($$select public.post_inventory_operation_document(pg_temp.id('doc-damaged'))$$,'Укажите причину списания');
select pg_temp.fails($$select public.set_inventory_loss_reason(pg_temp.id('line-damaged'),'nonsense')$$,'Выберите причину');
select public.set_inventory_loss_reason(pg_temp.id('line-damaged'),'damaged');
select public.post_inventory_operation_document(pg_temp.id('doc-damaged'));
-- 2-4. Expired B1 2 pcs (40 EUR = 20 000), shortage A1 3 pcs (30 EUR = 15 000), an increase is not a loss.
insert into e1 select 'doc-expired',pg_temp.loss('write_off','E1-B1',2,null,'expired');
insert into e1 select 'doc-shortage',pg_temp.loss('adjustment','E1-A1',3,'decrease','count_shortage');
insert into e1 values('doc-increase',public.create_inventory_operation_document('adjustment',current_date,pg_temp.wh(),null,'ACT','Излишек','Кладовщик'));
select pg_temp.fails($$select public.add_inventory_loss_line(pg_temp.id('doc-increase'),pg_temp.balance('E1-A1'),2,'increase','other',null)$$,
 'только для списания и уменьшения');
select public.add_inventory_loss_line(pg_temp.id('doc-increase'),pg_temp.balance('E1-A1'),2,'increase',null,null);
select public.post_inventory_operation_document(pg_temp.id('doc-increase'));
-- 5. A cancelled write-off is not a loss.
insert into e1 select 'doc-cancelled',pg_temp.loss('write_off','E1-B1',7,null,'damaged');
select public.cancel_inventory_operation_document(pg_temp.id('doc-cancelled'),'Ошибочный акт');
-- 6. N1 without approved cost: 4 pcs, counted in pieces, marked, never zero in money.
insert into e1 select 'doc-nocost',pg_temp.loss('write_off','E1-N1',4,null,'expired');
-- A transfer line takes no reason.
insert into e1 values('doc-transfer',public.create_inventory_operation_document('transfer',current_date,pg_temp.wh(),
 (select id from public.warehouses where status='active' and not is_virtual and id<>pg_temp.wh() order by code limit 1),'T','Пополнение',null));
insert into e1 select 'line-transfer',public.add_inventory_operation_line(pg_temp.id('doc-transfer'),pg_temp.balance('E1-A1'),null,1,null,null);
select pg_temp.fails($$select public.set_inventory_loss_reason(pg_temp.id('line-transfer'),'damaged')$$,'только для списания');
select pg_temp.fails($$select public.add_inventory_loss_line(pg_temp.id('doc-transfer'),pg_temp.balance('E1-A1'),1,null,'damaged',null)$$,'не нужна');

-- 7. A document posted without a reason, as before the migration (the check switched off for this step only), and a
-- direct write-off movement without a document: both "причина не указана". B1 1 pc = 10 000; A1 1 pc = 5 000.
reset role;
alter table public.inventory_operation_documents disable trigger inventory_operation_documents_loss_reasons;
set local role authenticated;
insert into e1 values('doc-legacy',public.create_inventory_operation_document('write_off',current_date,pg_temp.wh(),null,'OLD','Старый акт','Кладовщик'));
insert into e1 select 'line-legacy',public.add_inventory_operation_line(pg_temp.id('doc-legacy'),pg_temp.balance('E1-B1'),null,1,null,'старое списание');
select public.post_inventory_operation_document(pg_temp.id('doc-legacy'));
reset role;
alter table public.inventory_operation_documents enable trigger inventory_operation_documents_loss_reasons;
insert into public.inventory_movements(batch_id,movement_type,quantity,uom,from_warehouse_id,reference,reason)
 values(pg_temp.batch('E1-A1'),'write_off',1,'piece',pg_temp.wh(),'DIRECT-OLD','Прямое списание до документов');

-- 8. An order of the customer (draft lines are enough for a return and for an issue movement made here).
set local role authenticated;
insert into e1 values('sale',public.create_customer_order('e1100000-0000-4000-8000-000000000011',null,pg_temp.wh(),current_date+1,pg_temp.cur('KZT'),null));
reset role;
-- A return of 2 pcs of A1 by expiry at 1 120 KZT with VAT, written off by the decision: loss 2 pcs of A1 = 10 000
-- (reason expired); reference: returned revenue 2 x 1 120 / 1.12 = 2 000.
insert into public.sale_items(id,sale_id,product_id,quantity,uom,unit_price)
 values('e1300000-0000-4000-8000-000000000001',pg_temp.id('sale'),'e1200000-0000-4000-8000-000000000001',10,'piece',1120);
insert into public.customer_returns(id,return_number,sale_id,customer_id,warehouse_id,status,received_at)
 values('e1400000-0000-4000-8000-000000000001','E1-RET-1',pg_temp.id('sale'),'e1100000-0000-4000-8000-000000000011',pg_temp.wh(),'closed',now());
insert into public.customer_return_items(return_id,sale_item_id,batch_id,quantity,uom,reason_code,unit_price,decision,decision_note,decided_by,decided_at)
 values('e1400000-0000-4000-8000-000000000001','e1300000-0000-4000-8000-000000000001',pg_temp.batch('E1-A1'),2,'piece','expiry',1120,
        'write_off','Истёк срок','e1000000-0000-4000-8000-000000000001',now());
-- A low shelf-life sale: 5 pcs of A1 at 800 KZT while the price list gave 1 000 with VAT. Markdown (1 000 - 800) x 5 /
-- 1.12 = 892.86; cost of sales of the period 5 pcs x 10 EUR = 25 000.
insert into public.commercial_programs(id,name,kind,customer_id,version,starts_on,ends_on,status)
 values('e1500000-0000-4000-8000-000000000001','Распродажа E1','low_shelf_life','e1100000-0000-4000-8000-000000000011',1,
        current_date,current_date+10,'ordered');
insert into public.commercial_program_lines(id,commercial_program_id,product_id,planned_quantity,uom,target_unit_price,currency_id)
 values('e1500000-0000-4000-8000-000000000011','e1500000-0000-4000-8000-000000000001','e1200000-0000-4000-8000-000000000001',
        5,'piece',800,pg_temp.cur('KZT'));
insert into public.sale_items(id,sale_id,product_id,quantity,uom,unit_price,price_source,price_snapshot,commercial_program_line_id,program_quantity)
 values('e1300000-0000-4000-8000-000000000002',pg_temp.id('sale'),'e1200000-0000-4000-8000-000000000001',5,'piece',800,'commercial_program',
        '{"price_list_quote":{"price":1000,"vat_included":true}}','e1500000-0000-4000-8000-000000000011',5);
insert into public.inventory_movements(batch_id,movement_type,quantity,uom,from_warehouse_id,sale_item_id,reference)
 values(pg_temp.batch('E1-A1'),'issue',5,'piece',pg_temp.wh(),'e1300000-0000-4000-8000-000000000002','E1-SHIP');
-- Stock at risk: R3 made expired and partly reserved (4 of 10), R2 in an approved low shelf-life sale, R1 without a plan.
update public.inventory_batches set expiry_date=current_date-1 where id=pg_temp.batch('E1-R3');
update public.inventory_balances set quantity_reserved=4 where id=pg_temp.balance('E1-R3');
insert into public.commercial_programs(id,name,kind,customer_id,version,starts_on,ends_on,status)
 values('e1500000-0000-4000-8000-000000000002','Распродажа R2','low_shelf_life','e1100000-0000-4000-8000-000000000011',1,
        current_date,current_date+10,'approved');
insert into public.commercial_program_lines(commercial_program_id,product_id,inventory_balance_id,planned_quantity,uom)
 values('e1500000-0000-4000-8000-000000000002','e1200000-0000-4000-8000-000000000004',pg_temp.balance('E1-R2'),10,'piece');

-- A decreasing adjustment without a reason is not posted either.
set local role authenticated;
insert into e1 values('doc-noreason',public.create_inventory_operation_document('adjustment',current_date,pg_temp.wh(),null,'ACT','Пересчёт','Кладовщик'));
select public.add_inventory_operation_line(pg_temp.id('doc-noreason'),pg_temp.balance('E1-A1'),null,1,'decrease',null);
select pg_temp.fails($$select public.post_inventory_operation_document(pg_temp.id('doc-noreason'))$$,'Укажите причину списания');

-- Report by reason (director, with purchase prices).
do $$ declare r jsonb := public.loss_report('reason',current_date,current_date); t jsonb := r->'totals'; x jsonb;
begin
 assert (r->>'amounts')::boolean, 'the director sees amounts';
 assert (t->>'lines')::int=7 and (t->>'incomplete_lines')::int=1, format('7 lines, 1 without cost: %s', t);
 assert (t->>'pieces')::numeric=18, format('5+2+3+4+1+1+2 = 18 pcs: %s', t);
 -- 25 000 + 20 000 + 15 000 + 10 000 + 5 000 + 10 000; the reference columns are never added to the total.
 assert (t->>'cost_kzt')::numeric=85000, format('total 85 000 without returns and markdowns: %s', t);
 assert (t->>'unspecified_lines')::int=2 and (t->>'unspecified_cost_kzt')::numeric=15000, format('2 lines without reason, 15 000: %s', t);
 assert (t->>'cost_of_sales_kzt')::numeric=25000 and (t->>'share_pct')::numeric=340, format('share of 25 000 cost of sales: %s', t);
 assert (t->>'returns_pieces')::numeric=2 and (t->>'returns_kzt')::numeric=2000, format('return by expiry 2 pcs, 2 000: %s', t);
 assert (t->>'markdown_kzt')::numeric=892.86, format('markdown 892.86: %s', t);
 x := pg_temp.keyed(r,'damaged');
 assert (x->>'cost_kzt')::numeric=25000 and (x->>'pieces')::numeric=5 and x->>'name'='Бой, брак, повреждение', format('damaged: %s', x);
 x := pg_temp.keyed(r,'expired');
 assert (x->>'cost_kzt')::numeric=30000 and (x->>'pieces')::numeric=8 and (x->>'lines')::int=3 and (x->>'incomplete_lines')::int=1
    and (x->'statuses'->>'no_cost')::int=1, format('expired: B1 20 000 + returned A1 10 000, N1 4 pcs without cost: %s', x);
 assert (x->>'returns_kzt')::numeric=2000 and (x->>'markdown_kzt')::numeric=892.86, format('reference columns under expired: %s', x);
 x := pg_temp.keyed(r,'count_shortage');
 assert (x->>'cost_kzt')::numeric=15000 and (x->>'pieces')::numeric=3, format('shortage: %s', x);
 x := pg_temp.keyed(r,'unspecified');
 assert (x->>'cost_kzt')::numeric=15000 and x->>'name'='Причина не указана', format('unspecified: %s', x);
end $$;

-- Other groupings: the same lines, the same total.
do $$ declare r jsonb; x jsonb;
begin
 r := public.loss_report('product',current_date,current_date);
 x := pg_temp.keyed(r,'e1200000-0000-4000-8000-000000000001');
 assert (x->>'pieces')::numeric=11 and (x->>'cost_kzt')::numeric=55000 and x->>'name' like 'E1-A%', format('A: 5+3+1+2 pcs, 55 000: %s', x);
 x := pg_temp.keyed(r,'e1200000-0000-4000-8000-000000000003');
 assert (x->>'pieces')::numeric=4 and (x->>'cost_kzt')::numeric=0 and (x->>'incomplete_lines')::int=1, format('N: no cost, never a value: %s', x);
 r := public.loss_report('brand',current_date,current_date);
 assert (pg_temp.keyed(r,'Fazer')->>'cost_kzt')::numeric=55000 and (pg_temp.keyed(r,'Geisha')->>'cost_kzt')::numeric=30000
    and (pg_temp.keyed(r,'Без бренда')->>'pieces')::numeric=4, format('brands from the card text: %s', r->'rows');
 r := public.loss_report('shipment',current_date,current_date);
 assert (pg_temp.keyed(r,pg_temp.id('E1-S1')::text)->>'cost_kzt')::numeric=85000, format('shipment S1: %s', r->'rows');
 r := public.loss_report('month',current_date,current_date);
 assert jsonb_array_length(r->'rows')=1 and (r->'rows'->0->>'cost_kzt')::numeric=85000, format('one month: %s', r->'rows');
 r := public.loss_report('warehouse',current_date,current_date);
 assert (pg_temp.keyed(r,pg_temp.wh()::text)->>'cost_kzt')::numeric=85000, format('warehouse: %s', r->'rows');
 assert (select count(*) from public.loss_report_lines(current_date,current_date))=7, 'seven lines in the export';
 assert (select sum(cost_kzt) from public.loss_report_lines(current_date,current_date))=85000, 'export lines add up to the total';
 assert (select count(*) from public.loss_report_lines(current_date-30,current_date-1))=0, 'nothing in an earlier period';
end $$;

-- Stock at risk.
do $$ declare r jsonb := public.loss_risk('bucket'); x jsonb;
begin
 assert (r->'buckets'->'expired'->>'cost_kzt')::numeric=25000 and (r->'buckets'->'critical'->>'cost_kzt')::numeric=25000
    and (r->'buckets'->'warning'->>'cost_kzt')::numeric=25000, format('10 pcs x 5 EUR x 500 in each bucket: %s', r->'buckets');
 x := pg_temp.keyed(r,'critical');
 assert (x->>'no_plan_pieces')::numeric=10 and (x->>'no_plan_cost_kzt')::numeric=25000, format('R1 has no plan: %s', x);
 assert (pg_temp.keyed(r,'warning')->>'no_plan_pieces')::numeric=0, 'R2 is in a low shelf-life sale';
 assert (select i->>'plan' from jsonb_array_elements(r->'items') i where i->>'batch'='E1-R3')='partly_reserved', 'R3 is partly reserved';
 assert (select i->>'plan' from jsonb_array_elements(r->'items') i where i->>'batch'='E1-R2')='program', 'R2 plan is the sale';
 assert (r->>'items_total')::int=3, format('only R1-R3 are at risk: %s', r->>'items_total');
 r := public.loss_risk('brand');
 assert (pg_temp.keyed(r,'Fazer')->>'cost_kzt')::numeric=75000, format('risk by brand: %s', r->'rows');
 r := public.loss_risk('supplier');
 assert (pg_temp.keyed(r,'e1100000-0000-4000-8000-000000000001')->>'cost_kzt')::numeric=75000, format('risk by supplier: %s', r->'rows');
end $$;

-- Trend: twelve months, the current one carries the losses.
do $$ declare r jsonb := public.loss_trend(12); m jsonb;
begin
 assert jsonb_array_length(r->'months')=12, 'twelve months';
 m := r->'months'->11;
 assert m->>'month'=to_char(current_date,'YYYY-MM') and (m->>'cost_kzt')::numeric=85000 and (m->>'share_pct')::numeric=340
    and (m->'by_reason'->>'damaged')::numeric=25000, format('current month: %s', m);
 assert (r->'months'->0->>'cost_kzt')::numeric=0, 'an earlier month without losses is zero, it has data';
end $$;

-- Without purchase prices: quantities, no amounts anywhere.
select set_config('request.jwt.claim.sub','e1000000-0000-4000-8000-000000000002',true);
do $$ declare r jsonb := public.loss_report('reason',current_date,current_date);
begin
 assert not (r->>'amounts')::boolean and r->'totals'->>'cost_kzt' is null and r->'totals'->>'share_pct' is null
    and r->'totals'->>'returns_kzt' is null and r->'totals'->>'markdown_kzt' is null, format('no amounts: %s', r->'totals');
 assert (r->'totals'->>'pieces')::numeric=18, 'quantities stay';
 assert not exists (select 1 from jsonb_array_elements(r->'rows') x where x->>'cost_kzt' is not null), 'no amount in a row';
 assert (select count(*) from public.loss_report_lines(current_date,current_date) where cost_kzt is not null or cost is not null)=0,
  'no amount in the export';
 assert (public.loss_risk('bucket')->'buckets'->'critical'->>'cost_kzt') is null, 'no amount of stock at risk';
 assert (select bool_and(m->>'cost_kzt' is null) from jsonb_array_elements(public.loss_trend(3)->'months') m), 'no amount in the trend';
end $$;
-- Without reports: refused.
select set_config('request.jwt.claim.sub','e1000000-0000-4000-8000-000000000004',true);
select pg_temp.fails($$select public.loss_report('reason',current_date,current_date)$$,'Нет доступа к отчёту о потерях');
select pg_temp.fails($$select public.loss_risk('bucket')$$,'Нет доступа к отчёту о потерях');
select pg_temp.fails($$select count(*) from public.loss_report_lines(current_date,current_date)$$,'Нет доступа к отчёту о потерях');

-- Reason of a line posted without one: only losses.reason_classify, with a basis, once, in the audit log.
select set_config('request.jwt.claim.sub','e1000000-0000-4000-8000-000000000001',true);
select pg_temp.fails($$select public.unclassified_loss_lines(50)$$,'Нет права');
select pg_temp.fails($$select public.set_inventory_loss_reason(pg_temp.id('line-legacy'),'damaged','Акт утилизации №12')$$,'Нет права');
select set_config('request.jwt.claim.sub','e1000000-0000-4000-8000-000000000003',true);
do $$ begin
 assert (public.unclassified_loss_lines(50)->>'total')::int=1, 'one posted line without a reason (the direct movement has no line)';
end $$;
select pg_temp.fails($$select public.set_inventory_loss_reason(pg_temp.id('line-legacy'),'damaged','коротко')$$,'основание');
select public.set_inventory_loss_reason(pg_temp.id('line-legacy'),'damaged','Акт утилизации №12 и пояснение кладовщика');
select pg_temp.fails($$select public.set_inventory_loss_reason(pg_temp.id('line-legacy'),'expired','Повторно другой причиной')$$,'уже указана');
select pg_temp.fails($$select public.set_inventory_loss_reason(pg_temp.id('line-damaged'),'expired','Поменять причину проведённой строки')$$,'уже указана');
select pg_temp.fails($$select public.set_inventory_loss_reason(
 (select id from public.inventory_operation_lines where document_id=pg_temp.id('doc-cancelled')),'expired','Отменённый документ не размечается')$$,
 'отменён');
do $$ declare r jsonb;
begin
 assert (public.unclassified_loss_lines(50)->>'total')::int=0, 'nothing left to classify';
 assert (select loss_reason_source='classified' and loss_reason_set_by='e1000000-0000-4000-8000-000000000003'
           from public.inventory_operation_lines where id=pg_temp.id('line-legacy')), 'source and author are kept';
 r := public.loss_report('reason',current_date,current_date);
 assert (pg_temp.keyed(r,'damaged')->>'cost_kzt')::numeric=35000 and (pg_temp.keyed(r,'unspecified')->>'cost_kzt')::numeric=5000
    and (r->'totals'->>'cost_kzt')::numeric=85000, format('the classified line moves to damaged, the total stays: %s', r->'rows');
end $$;
reset role;
do $$ begin
 assert exists (select 1 from public.audit_log where action='inventory_loss_reason_classified'
                 and entity_id=pg_temp.id('line-legacy')::text and metadata->>'basis' like 'Акт утилизации%'), 'classification is in the audit log';
 -- The report changes nothing: stock of A1 is 100 - 5 - 3 + 2 = 94, B1 100 - 2 - 1 = 97 (the cancelled write-off reversed).
 assert (select quantity_on_hand from public.inventory_balances where id=pg_temp.balance('E1-A1'))=94, 'A1 stock';
 assert (select quantity_on_hand from public.inventory_balances where id=pg_temp.balance('E1-B1'))=97, 'B1 stock';
end $$;

rollback;
