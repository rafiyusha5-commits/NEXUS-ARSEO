-- Agent «Контроль ОСГ» (202609276500): requirement order (product term, contract, client card, 70 % default),
-- the 30-day forecast, FEFO order of customers, guarantee letter hint, access, the daily summary once
-- per employee and day for service_role only, and no writes into stock or orders.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('5e000000-0000-4000-8000-000000000001','sl-director@test.local','{"full_name":"SL Director"}'),
 ('5e000000-0000-4000-8000-000000000002','sl-nocustomers@test.local','{"full_name":"SL No customers"}'),
 ('5e000000-0000-4000-8000-000000000003','sl-nostock@test.local','{"full_name":"SL No stock"}');
insert into public.user_roles(user_id,role_id) select u::uuid,r.id from (values
 ('5e000000-0000-4000-8000-000000000001'),('5e000000-0000-4000-8000-000000000002'),('5e000000-0000-4000-8000-000000000003')) v(u)
 cross join public.app_roles r where r.code='director';
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select x.u::uuid,p.id,'deny','shelf life test','5e000000-0000-4000-8000-000000000001' from (values
 ('5e000000-0000-4000-8000-000000000002','customers.view'),
 ('5e000000-0000-4000-8000-000000000003','inventory.view')) x(u,code) join public.permissions p on p.code=x.code;

insert into public.counterparties(id,roles,legal_name,short_name,country,tax_id,min_remaining_shelf_life_pct) values
 ('5e100000-0000-4000-8000-000000000001',array['customer'],'Client One LLP','Клиент 1','KZ','SL-1',30),
 ('5e100000-0000-4000-8000-000000000002',array['customer'],'Client Two LLP','Клиент 2','KZ','SL-2',null),
 ('5e100000-0000-4000-8000-000000000003',array['customer'],'Client Three LLP','Клиент 3','KZ','SL-3',90),
 ('5e100000-0000-4000-8000-000000000004',array['customer'],'Client Four LLP','Клиент 4','KZ','SL-4',null),
 ('5e100000-0000-4000-8000-000000000005',array['customer'],'Client Five LLP','Клиент 5','KZ','SL-5',10),
 ('5e100000-0000-4000-8000-000000000006',array['customer'],'Client Six LLP','Клиент 6','KZ','SL-6',10),
 ('5e100000-0000-4000-8000-000000000009',array['manufacturer','supplier'],'SL maker','SL maker','FI','SL-9',null);
insert into public.products(id,internal_sku,name,manufacturer_id,status,shelf_life_days) values
 ('5e200000-0000-4000-8000-000000000001','SL-001','{"ru":"Сок яблочный"}','5e100000-0000-4000-8000-000000000009','active',100),
 ('5e200000-0000-4000-8000-000000000002','SL-002','{"ru":"Печенье"}','5e100000-0000-4000-8000-000000000009','active',300),
 ('5e200000-0000-4000-8000-000000000003','SL-003','{"ru":"Конфеты"}','5e100000-0000-4000-8000-000000000009','active',100),
 ('5e200000-0000-4000-8000-000000000004','SL-004','{"ru":"Без срока"}','5e100000-0000-4000-8000-000000000009','active',null);

set session_replication_role=replica;
-- Client 2: general contract term 80 %. Client 3: product term 50 % beats the card's 90 %.
insert into public.contracts(id,counterparty_id,number,type,status) values
 ('5e110000-0000-4000-8000-000000000002','5e100000-0000-4000-8000-000000000002','SL-K2','sale','active'),
 ('5e110000-0000-4000-8000-000000000003','5e100000-0000-4000-8000-000000000003','SL-K3','sale','active');
insert into public.contract_terms(contract_id,term_type,product_id,value_numeric) values
 ('5e110000-0000-4000-8000-000000000002','min_remaining_shelf_life_pct',null,80),
 ('5e110000-0000-4000-8000-000000000003','min_remaining_shelf_life_pct','5e200000-0000-4000-8000-000000000001',50),
 ('5e110000-0000-4000-8000-000000000003','min_remaining_shelf_life_pct',null,95);
-- Orders of SL-001: clients 1, 2, 4 recently; client 5 cancelled; client 6 more than a year ago. Client 3 has a product term.
insert into public.sales(id,sale_number,customer_id,warehouse_id,sale_date,planned_shipment_date,status,created_by)
select s.id::uuid,s.num,s.customer::uuid,(select id from public.warehouses where code='AKT'),current_date-s.age,current_date-s.age,s.status,'5e000000-0000-4000-8000-000000000001'
from (values ('5e300000-0000-4000-8000-000000000001','SL-SO-1','5e100000-0000-4000-8000-000000000001',10,'shipped'),
             ('5e300000-0000-4000-8000-000000000002','SL-SO-2','5e100000-0000-4000-8000-000000000002',20,'confirmed'),
             ('5e300000-0000-4000-8000-000000000004','SL-SO-4','5e100000-0000-4000-8000-000000000004',30,'draft'),
             ('5e300000-0000-4000-8000-000000000005','SL-SO-5','5e100000-0000-4000-8000-000000000005',5,'cancelled'),
             ('5e300000-0000-4000-8000-000000000006','SL-SO-6','5e100000-0000-4000-8000-000000000006',400,'shipped')) s(id,num,customer,age,status);
insert into public.sale_items(sale_id,product_id,quantity,uom)
select id,'5e200000-0000-4000-8000-000000000001',10,'box' from public.sales where sale_number like 'SL-SO-%';

-- Batches (T = today):
--  B1 SL-001 made T-60, expires T+40 (100 days): ОСГ 40 %
--  B2 SL-002 made T-10, expires T+290: default 70 % holds until T+80 — not at risk
--  B3 SL-002 made T-200, expires T+100: below the default since T-110
--  B4 SL-003 no manufacture date, 100 days, expires T+75: default holds until T+5
--  B5 SL-002 expired yesterday; B6 SL-004 cannot be calculated; B7 blocked; B8 fully reserved
insert into public.inventory_batches(id,product_id,batch_number,manufacture_date,expiry_date,status,created_by)
select b.id::uuid,b.product::uuid,b.num,current_date+b.made,current_date+b.expires,b.status,'5e000000-0000-4000-8000-000000000001'
from (values
 ('5e400000-0000-4000-8000-000000000001','5e200000-0000-4000-8000-000000000001','SL-B1',-60,40,'available'),
 ('5e400000-0000-4000-8000-000000000002','5e200000-0000-4000-8000-000000000002','SL-B2',-10,290,'available'),
 ('5e400000-0000-4000-8000-000000000003','5e200000-0000-4000-8000-000000000002','SL-B3',-200,100,'available'),
 ('5e400000-0000-4000-8000-000000000004','5e200000-0000-4000-8000-000000000003','SL-B4',null,75,'available'),
 ('5e400000-0000-4000-8000-000000000005','5e200000-0000-4000-8000-000000000002','SL-B5',-310,-1,'available'),
 ('5e400000-0000-4000-8000-000000000006','5e200000-0000-4000-8000-000000000004','SL-B6',null,20,'available'),
 ('5e400000-0000-4000-8000-000000000007','5e200000-0000-4000-8000-000000000001','SL-B7',-90,10,'blocked'),
 ('5e400000-0000-4000-8000-000000000008','5e200000-0000-4000-8000-000000000001','SL-B8',-95,5,'available')) b(id,product,num,made,expires,status);
insert into public.inventory_balances(batch_id,warehouse_id,uom,quantity_on_hand,quantity_reserved)
select b.id,(select id from public.warehouses where code='AKT'),'box',100,case when b.batch_number='SL-B8' then 100 else 20 end
from public.inventory_batches b where b.batch_number like 'SL-B%';
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
-- Only this file's batches: other test files may leave stock behind.
create function pg_temp.mine(p jsonb) returns jsonb language sql as $$
 select coalesce(jsonb_agg(i order by n),'[]') from jsonb_array_elements(p->'items') with ordinality e(i,n) where i->>'batch_number' like 'SL-B%' $$;
grant execute on function pg_temp.mine(jsonb) to authenticated;
create function pg_temp.batch(p jsonb,p_number text) returns jsonb language sql as $$
 select i from jsonb_array_elements(pg_temp.mine(p)) i where i->>'batch_number'=p_number $$;
grant execute on function pg_temp.batch(jsonb,text) to authenticated;
create temp table sl_state as select (select max(updated_at) from public.inventory_batches) b,(select max(updated_at) from public.inventory_balances) bal,
 (select max(updated_at) from public.sales) s,(select count(*) from public.inventory_reservations) r,(select count(*) from public.guarantee_letters) g;

-- ---------- privileges ----------
do $$ begin
 assert has_function_privilege('authenticated','public.shelf_life_risks(integer)','execute');
 assert not has_function_privilege('authenticated','public.run_shelf_life_control(date)','execute');
 assert has_function_privilege('service_role','public.run_shelf_life_control(date)','execute');
 assert not has_function_privilege('service_role','public.shelf_life_risks(integer)','execute');
 assert not has_function_privilege('anon','public.shelf_life_risks(integer)','execute');
 assert not has_function_privilege('authenticated','private.shelf_life_risks(date,integer,boolean)','execute');
end $$;

-- ---------- rules ----------
do $$ begin
 assert private.shelf_life_last_ok_day(current_date+40,current_date-60,100,30)=current_date+10;
 assert private.shelf_life_last_ok_day(current_date+75,null,100,70)=current_date+5,'without a manufacture date the product shelf life is used';
 assert private.shelf_life_last_ok_day(current_date+75,null,null,70) is null;
 -- on the last day the batch still meets the requirement, the next day it does not
 assert private.sale_shelf_life_pct(current_date+40,current_date-60,100,current_date+10)>=30;
 assert private.sale_shelf_life_pct(current_date+40,current_date-60,100,current_date+11)<30;
 assert (select source||'|'||required_pct from private.shelf_life_requirement('5e100000-0000-4000-8000-000000000003','5e200000-0000-4000-8000-000000000001',current_date))='contract_product|50.0000';
 assert (select source||'|'||required_pct from private.shelf_life_requirement('5e100000-0000-4000-8000-000000000002','5e200000-0000-4000-8000-000000000001',current_date))='contract|80.0000';
 assert (select source||'|'||required_pct from private.shelf_life_requirement('5e100000-0000-4000-8000-000000000001','5e200000-0000-4000-8000-000000000001',current_date))='client|30.00';
 assert (select source||'|'||required_pct from private.shelf_life_requirement('5e100000-0000-4000-8000-000000000004','5e200000-0000-4000-8000-000000000001',current_date))='default|70';
end $$;

-- ---------- the risk list ----------
set role authenticated;
select set_config('request.jwt.claim.sub','5e000000-0000-4000-8000-000000000001',false);
do $$
declare v jsonb := public.shelf_life_risks(); b1 jsonb; b3 jsonb; b4 jsonb; b5 jsonb;
begin
 assert (select string_agg(i->>'batch_number'||':'||(i->>'state'),' ' order by n) from jsonb_array_elements(pg_temp.mine(v)) with ordinality e(i,n))
   ='SL-B5:expired SL-B3:below SL-B1:below SL-B4:soon', format('order and states: %s', pg_temp.mine(v));
 assert (v->>'horizon_days')='30' and (v->>'unknown_count')::int>=1,'a batch without shelf life data is counted';
 b1 := pg_temp.batch(v,'SL-B1');
 assert (b1->>'remaining_pct')::numeric=40 and b1->'quantities'='[{"uom":"box","quantity":80.000}]'::jsonb and b1->>'warehouses'='AKT';
 -- FEFO: the customer whose window closes soonest but is still open comes first; customers already below follow
 assert (select string_agg(c->>'customer_name'||':'||(c->>'state')||':'||(c->>'source')||':'||(c->>'last_ok_day'),' ' order by n)
         from jsonb_array_elements(b1->'customers') with ordinality e(c,n))
   = format('Клиент 1:soon:client:%s Клиент 2:below:contract:%s Клиент 4:below:default:%s Клиент 3:below:contract_product:%s',
            current_date+10,current_date-40,current_date-30,current_date-10), b1->>'customers';
 assert (select bool_and((c->>'guarantee_letter')::boolean) from jsonb_array_elements(b1->'customers') c where c->>'state'='below'),'guarantee letter hint below the requirement';
 assert not exists(select 1 from jsonb_array_elements(b1->'customers') c where c->>'customer_name' in ('Клиент 5','Клиент 6')),'cancelled and old orders do not count';
 b3 := pg_temp.batch(v,'SL-B3');
 assert b3->'customers'=jsonb_build_array(jsonb_build_object('required_pct',70,'source','default','last_ok_day',current_date-110,'state','below','guarantee_letter',true)),'no customers: the default for any customer';
 b4 := pg_temp.batch(v,'SL-B4');
 assert (b4->>'first_deadline')::date=current_date+5;
 b5 := pg_temp.batch(v,'SL-B5');
 assert (select bool_and(not (c->>'guarantee_letter')::boolean) from jsonb_array_elements(b5->'customers') c),'no guarantee letter for an expired batch';
 assert pg_temp.batch(v,'SL-B2') is null and pg_temp.batch(v,'SL-B6') is null and pg_temp.batch(v,'SL-B7') is null and pg_temp.batch(v,'SL-B8') is null,
   'safe, unknown, blocked and fully reserved batches are not listed';
 -- a longer horizon brings in B2
 assert pg_temp.batch(public.shelf_life_risks(90),'SL-B2') is not null;
end $$;
select pg_temp.fails($$select public.shelf_life_risks(0)$$,'от 1 до 365');

-- ---------- access ----------
select set_config('request.jwt.claim.sub','5e000000-0000-4000-8000-000000000003',false);
select pg_temp.fails($$select public.shelf_life_risks()$$,'Нет доступа к остаткам');
select pg_temp.fails($$select public.run_shelf_life_control()$$,'permission denied');
-- without customers.view the customers are one anonymous group with the real risk, not the 70 % default
select set_config('request.jwt.claim.sub','5e000000-0000-4000-8000-000000000002',false);
do $$
declare b1 jsonb := pg_temp.batch(public.shelf_life_risks(),'SL-B1');
begin
 assert not exists(select 1 from jsonb_array_elements(b1->'customers') c where c ? 'customer_name' or c ? 'customer_id' or c ? 'required_pct' or c ? 'source'),'customer details are hidden';
 assert b1->'customers'=jsonb_build_array(jsonb_build_object('hidden_count',4,'state','below','guarantee_letter',true)), b1->>'customers';
 assert b1->>'state'='below' and b1->'first_deadline'='null'::jsonb,'the same risk as for the director, without hidden dates';
end $$;

-- ---------- daily summary ----------
reset role;
set role service_role;
do $$ begin
 assert public.run_shelf_life_control()>=2,'the director and the employee without customers.view are notified';
 assert public.run_shelf_life_control()=0,'once per employee and day';
end $$;
reset role;
do $$ begin
 assert (select count(*) from public.notifications where dedupe_key='shelf_life_daily:'||current_date and recipient_user_id::text like '5e000000-%')=2;
 assert not exists(select 1 from public.notifications where recipient_user_id='5e000000-0000-4000-8000-000000000003'),'no stock access, no summary';
 assert (select type||'|'||entity_type||'|'||(entity_id is null)::text||'|'||(shipment_id is null)::text from public.notifications
         where recipient_user_id='5e000000-0000-4000-8000-000000000001')='low_shelf_life|shelf_life_control|true|true';
 assert (select title from public.notifications where recipient_user_id='5e000000-0000-4000-8000-000000000001') ~ '^Контроль ОСГ: партий под риском — \d+$';
 assert (select body from public.notifications where recipient_user_id='5e000000-0000-4000-8000-000000000001') !~ 'Клиент|Сок|SL-B','counts only in the text';
end $$;
set role service_role;
do $$ begin
 assert public.run_shelf_life_control(current_date+1)>=2,'the next day brings a new summary';
end $$;
reset role;
-- the recipient sees the summary
set role authenticated;
select set_config('request.jwt.claim.sub','5e000000-0000-4000-8000-000000000001',false);
do $$ begin
 assert (select count(*) from public.notifications where entity_type='shelf_life_control')=2;
end $$;
reset role;

-- the agent changed no batches, balances, orders, reservations or guarantee letters
do $$ begin
 assert (select max(updated_at) from public.inventory_batches) is not distinct from (select b from sl_state);
 assert (select max(updated_at) from public.inventory_balances) is not distinct from (select bal from sl_state);
 assert (select max(updated_at) from public.sales) is not distinct from (select s from sl_state);
 assert (select count(*) from public.inventory_reservations)=(select r from sl_state);
 assert (select count(*) from public.guarantee_letters)=(select g from sl_state);
end $$;

-- ========== Review fixes ==========
-- ---------- the last allowed day matches the sales rule (private.sale_shelf_life_pct) ----------
do $$
declare
 c record; v_last date;
begin
 -- 2027-12-31, 366 days of shelf life, 67.76 %: the sales rule rounds to two digits, so 2027-04-27 still passes
 v_last := private.shelf_life_last_ok_day('2027-12-31','2027-12-31'::date-366,null,67.76);
 assert v_last='2027-04-27', format('last day for 67.76 %%: %s', v_last);
 assert private.sale_shelf_life_pct('2027-12-31','2027-12-31'::date-366,null,v_last)>=67.76;
 assert private.sale_shelf_life_pct('2027-12-31','2027-12-31'::date-366,null,v_last+1)<67.76;
 -- the same property for whole, fractional, 0 % and 100 % requirements, with and without a manufacture date
 for c in select * from (values
   ('2027-12-31'::date,'2027-12-31'::date-366,null::int,67.76),('2027-12-31','2027-12-31'::date-366,null,33.33),
   ('2027-12-31','2027-12-31'::date-366,null,0),('2027-12-31','2027-12-31'::date-366,null,100),
   ('2027-06-30',null,100,70),('2027-06-30',null,365,67.76),('2027-06-30',null,7,0),('2027-06-30',null,7,100),('2027-06-30',null,3,99.99)) x(e,m,d,r)
 loop
  v_last := private.shelf_life_last_ok_day(c.e,c.m,c.d,c.r);
  assert v_last<=c.e, format('%s: never after the expiry date', c);
  assert private.sale_shelf_life_pct(c.e,c.m,c.d,v_last)>=c.r, format('%s: the last day passes (%s)', c, v_last);
  assert v_last=c.e or private.sale_shelf_life_pct(c.e,c.m,c.d,v_last+1)<c.r, format('%s: the next day fails (%s)', c, v_last);
 end loop;
 assert private.shelf_life_last_ok_day('2027-12-31','2027-12-31'::date-366,null,0)='2027-12-31','0 %: until the expiry date';
 assert private.shelf_life_last_ok_day('2027-12-31','2027-12-31'::date-366,null,100)='2027-12-31'::date-366,'100 %: the manufacture day';
 assert private.shelf_life_last_ok_day('2027-06-30',null,100,70)='2027-06-30'::date-70,'without a manufacture date the product shelf life is used';
end $$;

-- ---------- an expired batch is listed even when its shelf life is unknown ----------
create temp table sl_before as select (public_risks->>'unknown_count')::int as unknown
 from (select private.shelf_life_risks(current_date,30,false) as public_risks) x;
grant select on sl_before to authenticated;
set session_replication_role=replica;
insert into public.inventory_batches(id,product_id,batch_number,manufacture_date,expiry_date,status,created_by) values
 ('5e400000-0000-4000-8000-000000000009','5e200000-0000-4000-8000-000000000004','SL-B9',null,current_date-1,'available','5e000000-0000-4000-8000-000000000001');
insert into public.inventory_balances(batch_id,warehouse_id,uom,quantity_on_hand,quantity_reserved)
select '5e400000-0000-4000-8000-000000000009',id,'box',50,0 from public.warehouses where code='AKT';
set session_replication_role=origin;
set role authenticated;
select set_config('request.jwt.claim.sub','5e000000-0000-4000-8000-000000000001',false);
do $$
declare v jsonb := public.shelf_life_risks(); b9 jsonb := pg_temp.batch(public.shelf_life_risks(),'SL-B9');
begin
 assert b9 is not null and b9->>'state'='expired', format('expired batch without shelf life data is listed: %s', b9);
 assert b9->'remaining_pct'='null'::jsonb or not b9 ? 'remaining_pct','its remaining shelf life is not invented';
 assert (v->>'unknown_count')::int=(select unknown from sl_before),'not counted twice as "cannot be calculated"';
end $$;
reset role;
set role service_role;
do $$ begin
 assert public.run_shelf_life_control(current_date+2)>=2;
end $$;
reset role;
do $$ begin
 assert (select body from public.notifications where recipient_user_id='5e000000-0000-4000-8000-000000000001' and dedupe_key='shelf_life_daily:'||(current_date+2))
   ~ 'Срок годности истёк: [2-9]','the daily summary counts it as expired (with SL-B5)';
end $$;

-- ---------- hidden customers keep their real requirements ----------
-- SL-005: customer 7 requires 90 % (card); the batch made T-15, expiring T+85 (100 days) has 85 % today:
-- below 90 %, while the 70 % default would still hold until T+15.
insert into public.counterparties(id,roles,legal_name,short_name,country,tax_id,min_remaining_shelf_life_pct) values
 ('5e100000-0000-4000-8000-000000000007',array['customer'],'Client Seven LLP','Клиент 7','KZ','SL-7',90);
insert into public.products(id,internal_sku,name,manufacturer_id,status,shelf_life_days) values
 ('5e200000-0000-4000-8000-000000000005','SL-005','{"ru":"Йогурт"}','5e100000-0000-4000-8000-000000000009','active',100);
set session_replication_role=replica;
insert into public.sales(id,sale_number,customer_id,warehouse_id,sale_date,planned_shipment_date,status,created_by)
select '5e300000-0000-4000-8000-000000000007','SL-SO-7','5e100000-0000-4000-8000-000000000007',id,current_date-3,current_date-3,'confirmed','5e000000-0000-4000-8000-000000000001'
from public.warehouses where code='AKT';
insert into public.sale_items(sale_id,product_id,quantity,uom) values ('5e300000-0000-4000-8000-000000000007','5e200000-0000-4000-8000-000000000005',5,'box');
insert into public.inventory_batches(id,product_id,batch_number,manufacture_date,expiry_date,status,created_by) values
 ('5e400000-0000-4000-8000-000000000010','5e200000-0000-4000-8000-000000000005','SL-B10',current_date-15,current_date+85,'available','5e000000-0000-4000-8000-000000000001');
insert into public.inventory_balances(batch_id,warehouse_id,uom,quantity_on_hand,quantity_reserved)
select '5e400000-0000-4000-8000-000000000010',id,'box',40,0 from public.warehouses where code='AKT';
set session_replication_role=origin;
set role authenticated;
select set_config('request.jwt.claim.sub','5e000000-0000-4000-8000-000000000001',false);
do $$
declare b jsonb := pg_temp.batch(public.shelf_life_risks(7),'SL-B10');
begin
 assert b->>'state'='below' and (b->'customers'->0->>'customer_name')='Клиент 7' and (b->'customers'->0->>'required_pct')::numeric=90, format('director: %s', b);
end $$;
select set_config('request.jwt.claim.sub','5e000000-0000-4000-8000-000000000002',false);
do $$
declare v jsonb := public.shelf_life_risks(7); b jsonb := pg_temp.batch(public.shelf_life_risks(7),'SL-B10');
begin
 assert b is not null and b->>'state'='below', format('without customers.view the same risk is shown: %s', b);
 assert b->'first_deadline'='null'::jsonb,'no deadline made of a hidden window';
 assert not exists(select 1 from jsonb_array_elements(b->'customers') c where c->>'source'='default'),'no 70 % default in place of a real requirement';
 assert v::text !~ 'Клиент 7|Client Seven|5e100000-0000-4000-8000-000000000007', 'no hidden customer name or id';
 assert not exists(select 1 from jsonb_array_elements(v->'items') i, jsonb_array_elements(i->'customers') c
                   where c ? 'customer_id' or c ? 'customer_name'
                      or ((c ? 'required_pct' or c ? 'source') and c->>'source' is distinct from 'default')),'hidden customers carry no details';
 -- the 70 % line is only for products without any customer, never for hidden ones
 assert not exists(select 1 from jsonb_array_elements(v->'items') i, jsonb_array_elements(i->'customers') c
                   where c->>'source'='default' and i->>'internal_sku' in ('SL-001','SL-005')),'no default for products with customers';
 assert exists(select 1 from jsonb_array_elements(b->'customers') c where (c->>'hidden_count')::int=1),'the hidden customers are counted';
end $$;
reset role;

-- ---------- dates never reveal the requirements of hidden customers ----------
-- Hidden windows of SL-B1 (customers 1-4): T+10, T-40, T-30, T-10; of SL-B10 (customer 7): T-5.
set role authenticated;
select set_config('request.jwt.claim.sub','5e000000-0000-4000-8000-000000000002',false);
do $$
declare
 v jsonb := public.shelf_life_risks(30);
 mine text := pg_temp.mine(v)::text;
 d date;
begin
 foreach d in array array[current_date+10,current_date-40,current_date-30,current_date-10,current_date-5] loop
  assert position(d::text in mine)=0, format('hidden window %s is in the answer: %s', d, mine);
 end loop;
 assert pg_temp.batch(v,'SL-B1')->>'state'='below' and pg_temp.batch(v,'SL-B10')->>'state'='below','the real batches stay at risk';
 assert pg_temp.batch(v,'SL-B1')->'first_deadline'='null'::jsonb and pg_temp.batch(v,'SL-B10')->'first_deadline'='null'::jsonb,
  'no batch deadline made of hidden windows';
 assert not exists(select 1 from jsonb_array_elements(v->'items') i, jsonb_array_elements(i->'customers') c
                   where c ? 'hidden_count' and (c ? 'last_ok_day' or c ? 'required_pct' or c ? 'source' or c ? 'customer_id' or c ? 'customer_name')),
  'the hidden group carries only the count, the state and the guarantee letter hint';
 assert (select bool_and(c ? 'hidden_count') from jsonb_array_elements(pg_temp.batch(v,'SL-B10')->'customers') c),'SL-B10 shows only the hidden group';
end $$;
-- the director still sees the windows
select set_config('request.jwt.claim.sub','5e000000-0000-4000-8000-000000000001',false);
do $$ begin
 assert (pg_temp.batch(public.shelf_life_risks(30),'SL-B1')->>'first_deadline')::date=current_date-40;
 assert (pg_temp.batch(public.shelf_life_risks(30),'SL-B10')->>'first_deadline')::date=current_date-5;
end $$;
reset role;

rollback;
\echo 'shelf_life_control_agent: all checks passed'
