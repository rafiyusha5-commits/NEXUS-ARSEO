-- 202611280300: inventory counts. Three locations, five batches: a shortage, a mis-sort (shortage of one product next to a
-- surplus of another), a batch found at another location, a batch not identified; two people counting one place, a
-- correction, a recount by another employee, a blind count, the lock of counted locations, a reservation in the way, a
-- stale preview, posting through the adjustment document, its reversal, rights and money. Synthetic data; rolled back.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('cc000000-0000-4000-8000-000000000001','count-director@example.invalid','{"full_name":"Count director"}'),
 ('cc000000-0000-4000-8000-000000000002','count-a@example.invalid','{"full_name":"Counter A"}'),
 ('cc000000-0000-4000-8000-000000000003','count-b@example.invalid','{"full_name":"Counter B"}'),
 ('cc000000-0000-4000-8000-000000000004','count-c@example.invalid','{"full_name":"Counter C"}'),
 ('cc000000-0000-4000-8000-000000000005','count-marketer@example.invalid','{"full_name":"Marketer"}'),
 ('cc000000-0000-4000-8000-000000000006','count-director-np@example.invalid','{"full_name":"Director without prices"}'),
 ('cc000000-0000-4000-8000-000000000007','count-admin@example.invalid','{"full_name":"Count admin"}');
insert into public.user_roles(user_id,role_id) select u.id::uuid,r.id from (values
 ('cc000000-0000-4000-8000-000000000001','director'),('cc000000-0000-4000-8000-000000000002','logistics_specialist'),
 ('cc000000-0000-4000-8000-000000000003','senior_logistics_manager'),('cc000000-0000-4000-8000-000000000004','logistics_specialist'),
 ('cc000000-0000-4000-8000-000000000005','marketer'),('cc000000-0000-4000-8000-000000000006','director'),
 ('cc000000-0000-4000-8000-000000000007','administrator')) u(id,code) join public.app_roles r on r.code=u.code;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'cc000000-0000-4000-8000-000000000006',id,'deny','no prices','cc000000-0000-4000-8000-000000000001'
   from public.permissions where code='prices.purchase.view';

create temporary table ic(k text primary key,id uuid);
grant all on ic to authenticated;
create function pg_temp.id(p_key text) returns uuid language sql stable as $$ select id from ic where k=p_key $$;
create function pg_temp.as_user(p_n integer) returns void language sql as $$
 select set_config('request.jwt.claim.sub','cc000000-0000-4000-8000-00000000000'||p_n,true) $$;
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
-- Quantity on hand of a batch at a location (null: none) in a unit, read as the owner.
create function pg_temp.qty(p_batch text,p_location text,p_uom text default 'piece') returns numeric language sql stable security definer as $$
 select quantity_on_hand from public.inventory_balances
  where batch_id=(select id from ic where k=p_batch) and warehouse_location_id is not distinct from (select id from ic where k=p_location) and uom=p_uom $$;
create function pg_temp.line(p_review jsonb,p_location text,p_batch text,p_uom text default 'piece') returns jsonb language sql stable as $$
 select x from jsonb_array_elements(p_review->'lines') x
  where x->>'location_id'=(select id::text from ic where k=p_location) and x->>'batch_id' is not distinct from (select id::text from ic where k=p_batch)
    and x->>'uom'=p_uom $$;
grant execute on all functions in schema pg_temp to authenticated;

-- Warehouse with locations L1, L2, L3 (counted) and L4 (not counted). Products P1 (box of 10), P2, P3.
insert into ic select 'wh',id from public.warehouses where status='active' and not is_virtual order by code limit 1;
insert into public.counterparties(id,roles,legal_name,country) values ('cc100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Count maker','FI');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('cc200000-0000-4000-8000-000000000001','CNT-P1','{"ru":"Печенье"}','cc100000-0000-4000-8000-000000000001','active'),
 ('cc200000-0000-4000-8000-000000000002','CNT-P2','{"ru":"Вафли"}','cc100000-0000-4000-8000-000000000001','active'),
 ('cc200000-0000-4000-8000-000000000003','CNT-P3','{"ru":"Конфеты"}','cc100000-0000-4000-8000-000000000001','active');
insert into public.product_packaging(product_id,uom,units_per_parent) values ('cc200000-0000-4000-8000-000000000001','box',10);
insert into ic values ('P1','cc200000-0000-4000-8000-000000000001'),('P2','cc200000-0000-4000-8000-000000000002'),('P3','cc200000-0000-4000-8000-000000000003');
with l as (insert into public.warehouse_locations(warehouse_id,code,zone)
           select pg_temp.id('wh'),v.code,'storage' from (values ('CNT-L1'),('CNT-L2'),('CNT-L3'),('CNT-L4')) v(code) returning id,code)
insert into ic select replace(code,'CNT-',''),id from l;
-- Batches: B1, B2 of P1; B3 of P2; B4, B5 of P3. B1 costs 1 000 KZT a piece; B4 has no cost.
with b as (insert into public.inventory_batches(product_id,batch_number,expiry_date,created_by,unit_landed_cost,cost_currency_id,cost_uom)
           select pg_temp.id(v.p),v.n,current_date+200,'cc000000-0000-4000-8000-000000000001',v.cost,
                  case when v.cost is not null then (select id from public.currencies where code='KZT') end,case when v.cost is not null then 'piece' end
             from (values ('P1','CNT-B1',1000),('P1','CNT-B2',800),('P2','CNT-B3',500),('P3','CNT-B4',null),('P3','CNT-B5',300)) v(p,n,cost)
           returning id,batch_number)
insert into ic select replace(batch_number,'CNT-',''),id from b;
-- Book: L1 B1 100 (95 reserved by an order), L1 B3 50, L2 B2 40, L2 B4 30, L3 B5 20, L4 B1 5.
insert into public.inventory_balances(batch_id,warehouse_id,warehouse_location_id,uom,quantity_on_hand,quantity_reserved)
select pg_temp.id(v.b),pg_temp.id('wh'),pg_temp.id(v.l),'piece',v.q,v.r
  from (values ('B1','L1',100,95),('B3','L1',50,0),('B2','L2',40,0),('B4','L2',30,0),('B5','L3',20,0),('B1','L4',5,0)) v(b,l,q,r);
insert into public.counterparties(id,roles,legal_name,country) values ('cc100000-0000-4000-8000-000000000002',array['customer'],'Count customer','KZ');
insert into public.sales(id,sale_number,customer_id,warehouse_id,sale_date,planned_shipment_date,status,created_by)
 values ('cc300000-0000-4000-8000-000000000001','CNT-S1','cc100000-0000-4000-8000-000000000002',pg_temp.id('wh'),current_date,current_date+3,'reserved',
         'cc000000-0000-4000-8000-000000000001');
insert into public.sale_items(id,sale_id,product_id,quantity,uom,unit_price)
 values ('cc300000-0000-4000-8000-000000000002','cc300000-0000-4000-8000-000000000001',pg_temp.id('P1'),95,'piece',100);
insert into public.inventory_reservations(sale_item_id,inventory_balance_id,batch_id,quantity,remaining_shelf_life_pct,created_by)
select 'cc300000-0000-4000-8000-000000000002',b.id,b.batch_id,95,90,'cc000000-0000-4000-8000-000000000001'
  from public.inventory_balances b where b.batch_id=pg_temp.id('B1') and b.warehouse_location_id=pg_temp.id('L1');

-- 1. Draft and scope (counter A manages counts but does not approve).
select pg_temp.as_user(5);
set local role authenticated;
select pg_temp.fails($q$select public.create_inventory_count(pg_temp.id('wh'),'partial')$q$,'Нет права: вести инвентаризацию');
select pg_temp.fails($q$select public.inventory_count_list()$q$,'Нет доступа к инвентаризации');
select pg_temp.as_user(2);
insert into ic values ('count',public.create_inventory_count(pg_temp.id('wh'),'partial',true,null,'Пересчёт стеллажей'));
select pg_temp.fails($q$select public.start_inventory_count(pg_temp.id('count'))$q$,'Задайте состав');
select pg_temp.fails($q$select public.set_inventory_count_scope(pg_temp.id('count'),array[gen_random_uuid()],null,false,null)$q$,'не относится к складу');
do $$begin
 assert public.set_inventory_count_scope(pg_temp.id('count'),array[pg_temp.id('L1'),pg_temp.id('L2'),pg_temp.id('L3')],null,false,null)=3;
end $$;
do $$declare v jsonb := public.inventory_count_list();begin
 assert (select x->>'status' from jsonb_array_elements(v->'counts') x where x->>'id'=pg_temp.id('count')::text)='draft'
    and (v->>'tolerance_pieces')::numeric=0 and not (v->>'can_settings')::boolean;
end $$;

-- 2. Start: the book of L1–L3 (5 balances) is remembered; L4 is not in the count.
do $$begin assert public.start_inventory_count(pg_temp.id('count'))=5,'five balances of the scope';end $$;
select pg_temp.fails($q$select public.set_inventory_count_scope(pg_temp.id('count'),array[pg_temp.id('L1')],null,false,null)$q$,'только в черновике');
reset role;
do $$begin
 assert (select count(*) from public.inventory_count_snapshot where count_id=pg_temp.id('count'))=5;
 assert (select s.quantity_on_hand=100 and s.quantity_reserved=95 from public.inventory_count_snapshot s join public.inventory_balances b on b.id=s.balance_id
          where s.count_id=pg_temp.id('count') and b.batch_id=pg_temp.id('B1') and b.warehouse_location_id=pg_temp.id('L1'));
end $$;

-- 3. The lock: stock of L1–L3 does not move (directly, through a write-off document, or a new balance there); L4 moves.
select pg_temp.fails($q$update public.inventory_balances set quantity_on_hand=99 where batch_id=pg_temp.id('B1') and warehouse_location_id=pg_temp.id('L1')$q$,
                     'Идёт инвентаризация ИНВ-\d+ на месте CNT-L1');
select pg_temp.fails($q$insert into public.inventory_balances(batch_id,warehouse_id,warehouse_location_id,uom,quantity_on_hand)
                       values (pg_temp.id('B5'),pg_temp.id('wh'),pg_temp.id('L1'),'piece',1)$q$,'Идёт инвентаризация');
update public.inventory_balances set quantity_on_hand=6 where batch_id=pg_temp.id('B1') and warehouse_location_id=pg_temp.id('L4');
update public.inventory_balances set quantity_on_hand=5 where batch_id=pg_temp.id('B1') and warehouse_location_id=pg_temp.id('L4');
select pg_temp.as_user(1);
set local role authenticated;
insert into ic values ('wo',public.create_inventory_operation_document('write_off',current_date,pg_temp.id('wh'),null,'CNT-WO','Бой',null));
select public.add_inventory_loss_line(pg_temp.id('wo'),(select id from public.inventory_balances where batch_id=pg_temp.id('B3') and warehouse_location_id=pg_temp.id('L1')),
                                      1,null,'damaged',null);
select pg_temp.fails($q$select public.post_inventory_operation_document(pg_temp.id('wo'))$q$,'Идёт инвентаризация ИНВ-\d+ на месте CNT-L1');
select public.remove_inventory_operation_line((select id from public.inventory_operation_lines where document_id=pg_temp.id('wo')));

-- 4. Counting, round 1. Blind: the sheet has no book, the review is closed, the snapshot is not readable.
select pg_temp.as_user(2);
do $$declare v jsonb := public.inventory_count_sheet(pg_temp.id('count'));begin
 assert v->>'status'='counting' and (v->>'round')::integer=1 and (v->>'blind')::boolean and v->'book'='null'::jsonb
    and jsonb_array_length(v->'locations')=3 and not (v->>'no_location')::boolean,'blind: no book, only L1–L3';
 assert v::text !~ '"100\.000"|"95\.000"','no book quantity anywhere in the sheet';
end $$;
select pg_temp.fails($q$select public.inventory_count_review(pg_temp.id('count'))$q$,'после завершения подсчёта');
select pg_temp.fails($q$select * from public.inventory_count_snapshot$q$,'permission denied');
select pg_temp.fails($q$select * from public.inventory_count_lines$q$,'permission denied');
do $$declare v jsonb := public.inventory_count_catalog(pg_temp.id('count'),'CNT-P1');begin
 assert jsonb_array_length(v)=1 and v->0->'uoms'='["piece", "box"]'::jsonb and jsonb_array_length(v->0->'batches')=2
    and v::text !~ 'quantity','the catalog: products, units and batches, no quantity';
end $$;
select pg_temp.fails($q$select public.record_inventory_count(pg_temp.id('count'),1::smallint,pg_temp.id('L4'),pg_temp.id('P1'),pg_temp.id('B1'),'piece',5)$q$,'не входит в пересчёт');
select pg_temp.fails($q$select public.record_inventory_count(pg_temp.id('count'),1::smallint,pg_temp.id('L1'),pg_temp.id('P2'),pg_temp.id('B1'),'piece',5)$q$,'другому товару');
select pg_temp.fails($q$select public.record_inventory_count(pg_temp.id('count'),1::smallint,pg_temp.id('L1'),pg_temp.id('P2'),pg_temp.id('B3'),'box',1)$q$,'не задана упаковка');
select pg_temp.fails($q$select public.record_inventory_count(pg_temp.id('count'),1::smallint,pg_temp.id('L1'),pg_temp.id('P2'),pg_temp.id('B3'),'piece',-1)$q$,'не меньше нуля');
-- L1 B1: A counts 60, B counts 30 at the same place (they add up); A corrects 60 to 58 -> 88 (book 100: shortage 12).
insert into ic values ('a60',public.record_inventory_count(pg_temp.id('count'),1::smallint,pg_temp.id('L1'),pg_temp.id('P1'),pg_temp.id('B1'),'piece',60,'Стеллаж 1'));
select public.record_inventory_count(pg_temp.id('count'),1::smallint,pg_temp.id('L1'),pg_temp.id('P2'),pg_temp.id('B3'),'piece',50);
-- L2: P1 B2 45 (book 40: surplus 5), P3 B4 25 (book 30: shortage 5) — a mis-sort.
select public.record_inventory_count(pg_temp.id('count'),1::smallint,pg_temp.id('L2'),pg_temp.id('P1'),pg_temp.id('B2'),'piece',45);
select public.record_inventory_count(pg_temp.id('count'),1::smallint,pg_temp.id('L2'),pg_temp.id('P3'),pg_temp.id('B4'),'piece',25);
-- L3: B5 20 (match); a box of B1 that the book has at L1 ("другое место"); 3 pieces of P2 without a readable batch.
select public.record_inventory_count(pg_temp.id('count'),1::smallint,pg_temp.id('L3'),pg_temp.id('P3'),pg_temp.id('B5'),'piece',20);
select public.record_inventory_count(pg_temp.id('count'),1::smallint,pg_temp.id('L3'),pg_temp.id('P1'),pg_temp.id('B1'),'box',1);
select public.record_inventory_count(pg_temp.id('count'),1::smallint,pg_temp.id('L3'),pg_temp.id('P2'),null,'piece',3,'Без этикетки');
select pg_temp.as_user(3);
select public.record_inventory_count(pg_temp.id('count'),1::smallint,pg_temp.id('L1'),pg_temp.id('P1'),pg_temp.id('B1'),'piece',30,'Стеллаж 2');
select pg_temp.as_user(2);
select public.record_inventory_count(pg_temp.id('count'),1::smallint,pg_temp.id('L1'),pg_temp.id('P1'),pg_temp.id('B1'),'piece',58,'Пересчитал стеллаж 1',pg_temp.id('a60'));
select pg_temp.fails($q$select public.record_inventory_count(pg_temp.id('count'),1::smallint,pg_temp.id('L1'),pg_temp.id('P1'),pg_temp.id('B1'),'piece',57,null,pg_temp.id('a60'))$q$,
                     'уже исправлена');
select pg_temp.fails($q$select public.record_inventory_count(pg_temp.id('count'),1::smallint,pg_temp.id('L2'),pg_temp.id('P1'),pg_temp.id('B2'),'piece',1,null,pg_temp.id('a60'))$q$,
                     'той же позиции');
reset role;
select pg_temp.fails($q$update public.inventory_count_entries set quantity=1$q$,'не меняются');
select pg_temp.fails($q$delete from public.inventory_count_entries$q$,'не меняются');
set local role authenticated;
do $$declare v jsonb := public.inventory_count_sheet(pg_temp.id('count'));begin
 assert jsonb_array_length(v->'entries')=9 and (select count(*) from jsonb_array_elements(v->'entries') e where (e->>'superseded')::boolean)=1,
   'history kept: the corrected record stays, marked';
end $$;

-- 5. End of round 1 (tolerance 0): every difference and the unknown batch go to a recount; matches do not.
do $$declare v jsonb := public.finish_inventory_count_round(pg_temp.id('count'));begin
 assert v->>'status'='recount' and (v->>'recount_lines')::integer=5,'L1 B1, L2 B2, L2 B4, L3 B1 box, L3 P2 not identified';
end $$;


-- 6. Recount: only the lines to recount, never by someone who counted that line first; all of them before review.
select pg_temp.fails($q$select public.record_inventory_count(pg_temp.id('count'),2::smallint,pg_temp.id('L1'),pg_temp.id('P1'),pg_temp.id('B1'),'piece',88)$q$,
                     'другой сотрудник');
select pg_temp.as_user(3);
select pg_temp.fails($q$select public.record_inventory_count(pg_temp.id('count'),2::smallint,pg_temp.id('L1'),pg_temp.id('P1'),pg_temp.id('B1'),'piece',88)$q$,
                     'другой сотрудник');
select pg_temp.fails($q$select public.finish_inventory_count_round(pg_temp.id('count'))$q$,'осталось 5');
select pg_temp.as_user(4);
select pg_temp.fails($q$select public.record_inventory_count(pg_temp.id('count'),2::smallint,pg_temp.id('L1'),pg_temp.id('P2'),pg_temp.id('B3'),'piece',50)$q$,'не нужно');
select pg_temp.fails($q$select public.record_inventory_count(pg_temp.id('count'),1::smallint,pg_temp.id('L2'),pg_temp.id('P1'),pg_temp.id('B2'),'piece',45)$q$,
                     'Подсчёт закрыт: идёт повторный тур');
do $$declare v jsonb := public.inventory_count_sheet(pg_temp.id('count'));begin
 assert (v->>'round')::integer=2 and jsonb_array_length(v->'recount')=5 and v->'book'='null'::jsonb
    and not exists (select 1 from jsonb_array_elements(v->'recount') x where x ? 'quantity' or x ? 'book'),'the recount list has no quantities';
 assert (select x->'first_counters' from jsonb_array_elements(v->'recount') x
          where x->>'location_id'=pg_temp.id('L1')::text and x->>'batch_id'=pg_temp.id('B1')::text)='["Counter A", "Counter B"]'::jsonb;
end $$;
select public.record_inventory_count(pg_temp.id('count'),2::smallint,pg_temp.id('L1'),pg_temp.id('P1'),pg_temp.id('B1'),'piece',88);
select public.record_inventory_count(pg_temp.id('count'),2::smallint,pg_temp.id('L2'),pg_temp.id('P1'),pg_temp.id('B2'),'piece',45);
select public.record_inventory_count(pg_temp.id('count'),2::smallint,pg_temp.id('L2'),pg_temp.id('P3'),pg_temp.id('B4'),'piece',25);
select public.record_inventory_count(pg_temp.id('count'),2::smallint,pg_temp.id('L3'),pg_temp.id('P1'),pg_temp.id('B1'),'box',1);
select public.record_inventory_count(pg_temp.id('count'),2::smallint,pg_temp.id('L3'),pg_temp.id('P2'),null,'piece',3);
select pg_temp.as_user(2);
do $$begin assert public.finish_inventory_count_round(pg_temp.id('count'))->>'status'='review';end $$;
select pg_temp.fails($q$select public.record_inventory_count(pg_temp.id('count'),2::smallint,pg_temp.id('L3'),pg_temp.id('P3'),pg_temp.id('B5'),'piece',1)$q$,'Подсчёт закрыт');

-- 7. Review. The book is open to the approver only (blind count).
select pg_temp.fails($q$select public.inventory_count_review(pg_temp.id('count'))$q$,'видит только утверждающий');
select pg_temp.as_user(1);
do $$
declare v jsonb := public.inventory_count_review(pg_temp.id('count')); l jsonb;
begin
 assert (v->'totals'->>'lines')::integer=7 and (v->'totals'->>'matches')::integer=2 and (v->'totals'->>'shortages')::integer=2
    and (v->'totals'->>'surpluses')::integer=2 and (v->'totals'->>'unknown')::integer=1,'7 lines: 2 match, 2 short, 2 surplus, 1 not identified';
 l:=pg_temp.line(v,'L1','B1');
 assert (l->>'book')::numeric=100 and (l->>'counted')::numeric=88 and (l->>'recount')::numeric=88 and (l->>'difference')::numeric=-12
    and l->>'kind'='shortage' and l->>'problem'='reason' and l->'orders'->0->>'sale_number'='CNT-S1','88 counted (58 + 30), the order in the way';
 assert (l->>'difference_kzt')::numeric=-12000,'12 pieces at 1 000 KZT';
 l:=pg_temp.line(v,'L3','B1','box');
 assert l->>'kind'='surplus' and (l->>'other_location')::boolean and (l->>'difference_kzt')::numeric=10000,'a box of B1 at L3: another location, 10 pieces';
 l:=(select x from jsonb_array_elements(v->'lines') x where x->>'kind'='unknown_batch');
 assert l->>'problem'='batch' and (l->>'final')::numeric=3 and jsonb_array_length(l->'batches')=1;
 assert (pg_temp.line(v,'L2','B4')->>'difference_kzt') is null and (v->'totals'->>'no_cost_lines')::integer=2,'B4 has no cost: a mark, not a zero';
 assert (v->'totals'->>'shortage_kzt')::numeric=12000 and (v->'totals'->>'problems')::integer=3;
 assert (v->'totals'->>'shortage_pieces')::numeric=17 and (v->'totals'->>'surplus_pieces')::numeric=15,'12 + 5 short; 5 + 10 surplus';
end $$;
select pg_temp.as_user(3);
select pg_temp.fails($q$select public.set_inventory_count_decision((select (x->>'id')::uuid from jsonb_array_elements(public.inventory_count_review(pg_temp.id('count'))->'lines') x limit 1),'damaged')$q$,
                     'утверждать инвентаризацию|видит только утверждающий');
select pg_temp.as_user(1);
create temporary table icl as select (x->>'id')::uuid as id, x->>'kind' as kind, x->>'location_id' as location_id, x->>'batch_id' as batch_id, x->>'uom' as uom
  from jsonb_array_elements(public.inventory_count_review(pg_temp.id('count'))->'lines') x;
create function pg_temp.lid(p_location text,p_batch text,p_uom text default 'piece') returns uuid language sql stable as $$
 select id from icl where location_id=(select id::text from ic where k=p_location) and batch_id is not distinct from (select id::text from ic where k=p_batch) and uom=p_uom $$;
select pg_temp.fails($q$select public.set_inventory_count_decision(pg_temp.lid('L1','B1'),null)$q$,'причину недостачи');
select public.set_inventory_count_decision(pg_temp.lid('L1','B1'),'count_shortage');
select pg_temp.fails($q$select public.set_inventory_count_decision(pg_temp.lid('L2','B2'),'damaged')$q$,'не нужно');
select public.pair_inventory_count_lines(pg_temp.lid('L2','B4'),pg_temp.lid('L2','B2'));
select pg_temp.fails($q$select public.set_inventory_count_decision((select id from icl where kind='unknown_batch'),null,pg_temp.id('B1'))$q$,'партию этого товара');
select public.set_inventory_count_decision((select id from icl where kind='unknown_batch'),null,pg_temp.id('B3'));
do $$
declare v jsonb := public.inventory_count_review(pg_temp.id('count'));
begin
 assert pg_temp.line(v,'L2','B4')->>'reason_code'='mis_sort' and pg_temp.line(v,'L2','B4')->>'pair_line_id'=pg_temp.lid('L2','B2')::text
    and pg_temp.line(v,'L2','B2')->>'pair_line_id'=pg_temp.lid('L2','B4')::text,'the pair: both ways, the shortage is a mis-sort';
 assert (v->'totals'->>'problems')::integer=1 and pg_temp.line(v,'L1','B1')->>'problem'='reserved',
   'only the reservation is left: 12 off 100 with 95 reserved';
 perform set_config('tests.digest1',v->>'digest',true);
end $$;
select pg_temp.fails($q$select public.post_inventory_count(pg_temp.id('count'),current_setting('tests.digest1'))$q$,'нерешённые строки: 1');
-- The order releases 85 of its 95 (only the reservation moves; the lock is about stock on hand).
reset role;
update public.inventory_reservations set quantity=10 where sale_item_id='cc300000-0000-4000-8000-000000000002';
update public.inventory_balances set quantity_reserved=10 where batch_id=pg_temp.id('B1') and warehouse_location_id=pg_temp.id('L1');
set local role authenticated;
select pg_temp.fails($q$select public.post_inventory_count(pg_temp.id('count'),current_setting('tests.digest1'))$q$,'Предпросмотр устарел');
do $$declare v jsonb := public.inventory_count_review(pg_temp.id('count'));begin
 assert (v->'totals'->>'problems')::integer=0 and v->>'digest'<>current_setting('tests.digest1');
 perform set_config('tests.digest2',v->>'digest',true);
end $$;
select pg_temp.as_user(3);
select pg_temp.fails($q$select public.post_inventory_count(pg_temp.id('count'),current_setting('tests.digest2'))$q$,'утверждать инвентаризацию');

-- 8. Posting: one adjustment document, stock changes exactly by the approved differences.
select pg_temp.as_user(1);
insert into ic values ('doc',public.post_inventory_count(pg_temp.id('count'),current_setting('tests.digest2')));
select pg_temp.fails($q$select public.post_inventory_count(pg_temp.id('count'),current_setting('tests.digest2'))$q$,'только инвентаризацию на утверждении');
reset role;
do $$begin
 assert (select status='posted' and adjustment_document_id=pg_temp.id('doc') from public.inventory_counts where id=pg_temp.id('count'));
 assert (select operation_type='adjustment' and status='posted' and reference like 'ИНВ-%' from public.inventory_operation_documents where id=pg_temp.id('doc'));
 assert pg_temp.qty('B1','L1')=88 and pg_temp.qty('B2','L2')=45 and pg_temp.qty('B4','L2')=25 and pg_temp.qty('B1','L3','box')=1
    and pg_temp.qty('B3','L3')=3,'differences applied: -12, +5, -5, +1 box, +3 (B3 decided for the batch not identified)';
 assert pg_temp.qty('B3','L1')=50 and pg_temp.qty('B5','L3')=20 and pg_temp.qty('B1','L4')=5,'matches and L4 untouched';
 assert (select count(*) from public.inventory_operation_lines where document_id=pg_temp.id('doc'))=5;
 assert (select array_agg(loss_reason_code order by loss_reason_code) from public.inventory_operation_lines
          where document_id=pg_temp.id('doc') and adjustment_direction='decrease')='{count_shortage,mis_sort}';
 -- Every change of stock at L1–L3 since the start is a movement of that document, quantity for quantity.
 assert not exists (
   with now_stock as (
     select b.batch_id, b.warehouse_location_id as location_id, b.uom, b.quantity_on_hand - coalesce(s.quantity_on_hand, 0) as delta
       from public.inventory_balances b
       left join public.inventory_count_snapshot s on s.balance_id = b.id and s.count_id = pg_temp.id('count')
      where b.warehouse_location_id in (pg_temp.id('L1'), pg_temp.id('L2'), pg_temp.id('L3'))
   ), moved as (
     select m.batch_id, coalesce(m.to_location_id, m.from_location_id) as location_id, m.uom,
            sum(case when m.to_warehouse_id is not null then m.quantity else -m.quantity end) as delta
       from public.inventory_movements m
      where m.inventory_operation_document_id = pg_temp.id('doc')
      group by 1, 2, 3
   )
   select 1 from now_stock n full join moved m on m.batch_id = n.batch_id and m.location_id = n.location_id and m.uom = n.uom
    where coalesce(n.delta, 0) <> coalesce(m.delta, 0)),'stock moved only through the adjustment document';
 assert not exists (select 1 from public.inventory_movements m join public.inventory_counts c on c.id = pg_temp.id('count')
                     where m.created_at >= c.started_at and m.inventory_operation_document_id is distinct from pg_temp.id('doc')
                       and (m.from_location_id in (pg_temp.id('L1'), pg_temp.id('L2'), pg_temp.id('L3'))
                            or m.to_location_id in (pg_temp.id('L1'), pg_temp.id('L2'), pg_temp.id('L3')))),'no other movement there';
end $$;
-- The lock is released.
update public.inventory_balances set quantity_on_hand=51 where batch_id=pg_temp.id('B3') and warehouse_location_id=pg_temp.id('L1');
update public.inventory_balances set quantity_on_hand=50 where batch_id=pg_temp.id('B3') and warehouse_location_id=pg_temp.id('L1');

-- 9. An open (not blind) count shows the book to the people counting; one open count per warehouse.
select pg_temp.as_user(2);
set local role authenticated;
insert into ic values ('open',public.create_inventory_count(pg_temp.id('wh'),'partial',false,null,null));
select public.set_inventory_count_scope(pg_temp.id('open'),array[pg_temp.id('L4')],null,false,null);
select public.start_inventory_count(pg_temp.id('open'));
do $$declare v jsonb := public.inventory_count_sheet(pg_temp.id('open'));begin
 assert jsonb_array_length(v->'book')=1 and (v->'book'->0->>'quantity')::numeric=5 and v->'book'->0->>'location'='CNT-L4';
end $$;
insert into ic values ('third',public.create_inventory_count(pg_temp.id('wh'),'full',true,null,null));
select pg_temp.fails($q$select public.start_inventory_count(pg_temp.id('third'))$q$,'уже идёт инвентаризация');
select pg_temp.fails($q$select public.cancel_inventory_count(pg_temp.id('open'),'')$q$,'причину отмены');
select public.cancel_inventory_count(pg_temp.id('open'),'Ошиблись складом');
reset role;
update public.inventory_balances set quantity_on_hand=5 where batch_id=pg_temp.id('B1') and warehouse_location_id=pg_temp.id('L4');

-- 10. Money only with the purchase prices.
select pg_temp.as_user(6);
set local role authenticated;
do $$declare v jsonb := public.inventory_count_review(pg_temp.id('count'));begin
 assert not (v->>'cost')::boolean and v->'totals'->>'shortage_kzt' is null and v->'totals'->>'surplus_kzt' is null
    and not exists (select 1 from jsonb_array_elements(v->'lines') x where x->>'difference_kzt' is not null)
    and not exists (select 1 from jsonb_array_elements(v->'by_reason') x where x->>'kzt' is not null),'no cost anywhere';
 assert (select (x->>'pieces')::numeric from jsonb_array_elements(v->'by_reason') x where x->>'reason_code'='count_shortage')=12;
end $$;

-- 11. Tolerance: the administrator only.
select pg_temp.as_user(1);
select pg_temp.fails($q$select public.set_inventory_count_tolerance(2)$q$,'менять допуск');
select pg_temp.as_user(7);
select public.set_inventory_count_tolerance(2);
do $$begin assert (public.inventory_count_list()->>'tolerance_pieces')::numeric=2;end $$;
select public.set_inventory_count_tolerance(0);

-- 12. Cancelling a posted count reverses its document: stock as before the count.
select pg_temp.as_user(2);
select pg_temp.fails($q$select public.cancel_inventory_count(pg_temp.id('count'),'Пересчитать заново')$q$,'утверждать инвентаризацию');
select pg_temp.as_user(1);
select public.cancel_inventory_count(pg_temp.id('count'),'Пересчитать заново');
select pg_temp.fails($q$select public.cancel_inventory_count(pg_temp.id('count'),'Ещё раз')$q$,'уже отменена');
reset role;
do $$begin
 assert (select status='cancelled' from public.inventory_operation_documents where id=pg_temp.id('doc'));
 assert pg_temp.qty('B1','L1')=100 and pg_temp.qty('B2','L2')=40 and pg_temp.qty('B4','L2')=30 and pg_temp.qty('B1','L3','box')=0
    and pg_temp.qty('B3','L3')=0,'the reversal brings the book back';
 assert (select count(*) from public.audit_log where entity_type='inventory_counts' and entity_id=pg_temp.id('count')::text)=3,
   'started, posted, cancelled';
end $$;

rollback;
\echo 'inventory_counts: all checks passed'
