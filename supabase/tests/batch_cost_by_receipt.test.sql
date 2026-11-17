-- 202611160100: batch cost as the weighted average of its receipts (finding Н6, replaces PR #36).
-- Real path: shipment, vehicles, items, receiving, expenses, calculation, approval. Hand calculations are in the
-- comment next to every check. Everything is rolled back.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('c4000000-0000-4000-8000-000000000001','batch-cost-director@example.invalid','{"full_name":"Batch cost director"}'),
 ('c4000000-0000-4000-8000-000000000002','batch-cost-admin@example.invalid','{"full_name":"Batch cost administrator"}'),
 ('c4000000-0000-4000-8000-000000000003','batch-cost-denied@example.invalid','{"full_name":"Batch cost denied administrator"}');
insert into public.user_roles(user_id,role_id) select u.id,r.id from (values
 ('c4000000-0000-4000-8000-000000000001'::uuid,'director'),
 ('c4000000-0000-4000-8000-000000000002'::uuid,'administrator'),
 ('c4000000-0000-4000-8000-000000000003'::uuid,'administrator')) u(id,code) join public.app_roles r on r.code=u.code;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'c4000000-0000-4000-8000-000000000003',id,'deny','Personal deny of purchase prices','c4000000-0000-4000-8000-000000000002'
 from public.permissions where code='prices.purchase.view';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('c4100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Batch cost supplier','FI','C4-SUP');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('c4200000-0000-4000-8000-000000000001','C4-TRUCKS','{"ru":"Две машины"}','c4100000-0000-4000-8000-000000000001','active'),
 ('c4200000-0000-4000-8000-000000000002','C4-RATES','{"ru":"Разные декларации"}','c4100000-0000-4000-8000-000000000001','active'),
 ('c4200000-0000-4000-8000-000000000003','C4-SHIPS','{"ru":"Две поставки"}','c4100000-0000-4000-8000-000000000001','active'),
 ('c4200000-0000-4000-8000-000000000004','C4-BOX12','{"ru":"Коробка по 12"}','c4100000-0000-4000-8000-000000000001','active'),
 ('c4200000-0000-4000-8000-000000000005','C4-NOPACK','{"ru":"Без упаковки"}','c4100000-0000-4000-8000-000000000001','active'),
 ('c4200000-0000-4000-8000-000000000006','C4-SINGLE','{"ru":"Одна машина"}','c4100000-0000-4000-8000-000000000001','active'),
 ('c4200000-0000-4000-8000-000000000007','C4-ASSIST','{"ru":"Ассистент"}','c4100000-0000-4000-8000-000000000001','active');
insert into public.product_packaging(product_id,uom,units_per_parent) values('c4200000-0000-4000-8000-000000000004','box',12);
insert into public.exchange_rates(base_currency_id,quote_currency_id,rate,source,rate_date,created_by)
 select (select id from public.currencies where code='EUR'),(select id from public.currencies where code='KZT'),r.rate,'official',current_date-r.days,
 'c4000000-0000-4000-8000-000000000001' from (values(500::numeric,30),(520::numeric,20)) r(rate,days);

create temporary table c4(k text primary key,id uuid);
grant all on c4 to authenticated;
create function pg_temp.id(p_key text) returns uuid language sql stable as $$ select id from c4 where k=p_key $$;
create function pg_temp.cur(p_code text) returns uuid language sql stable as $$ select id from public.currencies where code=p_code $$;
-- Test reader with the owner's rights: employees cannot select cost columns directly (purchase price access).
create function pg_temp.batch(p_number text) returns public.inventory_batches language sql stable security definer as $$
 select * from public.inventory_batches where batch_number=p_number $$;
-- A shipment in EUR with numbered vehicles; every line is allocated to its vehicle and received into its batch.
-- Lines: [{"vehicle":1,"product":"...","uom":"piece","qty":100,"price":10,"batch":"LOT"}]; items are stored as code:vehicle:batch.
create function pg_temp.ship(p_code text,p_lines jsonb) returns uuid language plpgsql as $$
declare v_ship uuid;v_line jsonb;v_item uuid;v_vehicle int;v_transport uuid;v_count int;
begin
 v_ship:=public.create_shipment_with_stages(p_code,'import','c4100000-0000-4000-8000-000000000001',null,
  (select id from public.routes where status='active' order by created_at limit 1),pg_temp.cur('EUR'),
  (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),auth.uid(),current_date,current_date+14);
 insert into c4 values(p_code,v_ship);
 select max((x->>'vehicle')::int) into v_count from jsonb_array_elements(p_lines) x;
 for v_vehicle in 1..v_count loop perform public.add_shipment_transport(v_ship,null,null,null,null);end loop;
 for v_line in select * from jsonb_array_elements(p_lines) loop
  select id into v_transport from public.shipment_transports where shipment_id=v_ship and sequence_no=(v_line->>'vehicle')::int;
  v_item:=public.allocate_shipment_item(public.create_shipment_item(v_ship,(v_line->>'product')::uuid,v_line->>'uom',
   (v_line->>'qty')::numeric,(v_line->>'price')::numeric,pg_temp.cur('EUR')),v_transport,(v_line->>'qty')::numeric);
  insert into c4 values(p_code||':'||(v_line->>'vehicle')||':'||(v_line->>'batch'),v_item);
  insert into c4 values(p_code||':t'||(v_line->>'vehicle'),v_transport) on conflict do nothing;
 end loop;
 return v_ship;
end $$;
create function pg_temp.receive(p_code text,p_vehicle int,p_lines jsonb) returns void language plpgsql as $$
declare v_transport uuid:=pg_temp.id(p_code||':t'||p_vehicle);v_line jsonb;v_receipt jsonb:='[]';
begin
 for v_line in select * from jsonb_array_elements(p_lines) loop
  v_receipt:=v_receipt||jsonb_build_object('item_id',pg_temp.id(p_code||':'||p_vehicle||':'||(v_line->>'batch')),
   'accepted_quantity',(v_line->>'qty')::numeric,'batch_number',v_line->>'batch','expiry_date',(current_date+300)::text);
 end loop;
 perform public.change_shipment_transport_status(v_transport,'arrived');
 perform public.receive_shipment_transport(v_transport,null,v_receipt,'Кладовщик',null);
end $$;
-- Freight with exact amounts per item: {"code:vehicle:batch": "100.00"}.
create function pg_temp.freight(p_code text,p_amounts jsonb) returns void language plpgsql as $$
declare e uuid;total numeric;lines jsonb;
begin
 select sum(value::numeric),jsonb_agg(jsonb_build_object('item_id',pg_temp.id(key)::text,'amount',value))
  into total,lines from jsonb_each_text(p_amounts);
 e:=public.create_expense(pg_temp.id(p_code),'transport',null,total,pg_temp.cur('EUR'),current_date,false,null,'Freight per vehicle');
 perform public.confirm_expense(e);
 perform public.save_exact_expense_allocation(gen_random_uuid(),e,pg_temp.cur('EUR'),null,
  public.exact_expense_allocation_context(e,pg_temp.cur('EUR'))->>'stamp',lines,'Invoice splits freight by vehicle');
end $$;
create function pg_temp.approve(p_code text,p_currency text default 'EUR') returns uuid language plpgsql as $$
declare calc uuid;begin
 calc:=public.calculate_shipment_cost(pg_temp.id(p_code),pg_temp.cur(p_currency));
 perform public.approve_shipment_cost(calc);
 return calc;
end $$;
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

select set_config('request.jwt.claim.sub','c4000000-0000-4000-8000-000000000001',true);
set local role authenticated;

-- 1. One shipment, two vehicles, one purchase price, different freight per vehicle (the main ARSEO case).
--    Vehicle 1: 100 pcs * 10 + 100 freight = 1100 -> 11.00; vehicle 2: 100 * 10 + 200 = 1200 -> 12.00.
--    Batch: (1100 + 1200) / 200 = 11.50 EUR per piece.
do $$begin
 perform pg_temp.ship('C4-1','[{"vehicle":1,"product":"c4200000-0000-4000-8000-000000000001","uom":"piece","qty":100,"price":10,"batch":"C4-TRUCKS"},
  {"vehicle":2,"product":"c4200000-0000-4000-8000-000000000001","uom":"piece","qty":100,"price":10,"batch":"C4-TRUCKS"}]');
 perform pg_temp.receive('C4-1',1,'[{"qty":100,"batch":"C4-TRUCKS"}]');
 perform pg_temp.receive('C4-1',2,'[{"qty":100,"batch":"C4-TRUCKS"}]');
 assert (pg_temp.batch('C4-TRUCKS')).unit_landed_cost is null,'received but not approved: no cost';
 perform pg_temp.freight('C4-1','{"C4-1:1:C4-TRUCKS":"100.00","C4-1:2:C4-TRUCKS":"200.00"}');
 perform pg_temp.approve('C4-1');
 assert (select unit_landed_cost from public.cost_calculation_items where shipment_item_id=pg_temp.id('C4-1:1:C4-TRUCKS'))=11;
 assert (select unit_landed_cost from public.cost_calculation_items where shipment_item_id=pg_temp.id('C4-1:2:C4-TRUCKS'))=12;
 assert (pg_temp.batch('C4-TRUCKS')).unit_landed_cost=11.5,'two vehicles: (1100+1200)/200 = 11.50';
 assert (pg_temp.batch('C4-TRUCKS')).cost_uom='piece' and (pg_temp.batch('C4-TRUCKS')).cost_basis='receipts';
 assert (pg_temp.batch('C4-TRUCKS')).cost_currency_id=pg_temp.cur('EUR');
end $$;

-- 2. Two vehicles with their own customs declarations on different dates: EUR 500 and 520 KZT.
--    Vehicle 1: 100 pcs * 10 EUR * 500 = 500 000 -> 5000; vehicle 2: 100 * 10 * 520 = 520 000 -> 5200.
--    Batch: (500 000 + 520 000) / 200 = 5100 KZT per piece.
do $$begin
 perform pg_temp.ship('C4-2','[{"vehicle":1,"product":"c4200000-0000-4000-8000-000000000002","uom":"piece","qty":100,"price":10,"batch":"C4-RATES"},
  {"vehicle":2,"product":"c4200000-0000-4000-8000-000000000002","uom":"piece","qty":100,"price":10,"batch":"C4-RATES"}]');
 perform pg_temp.receive('C4-2',1,'[{"qty":100,"batch":"C4-RATES"}]');
 perform pg_temp.receive('C4-2',2,'[{"qty":100,"batch":"C4-RATES"}]');
end $$;
reset role;
insert into public.documents(id,document_type_id,title,document_date,status,uploaded_by)
 select d.id,t.id,d.title,current_date-d.days,'approved','c4000000-0000-4000-8000-000000000001'
 from (values('c4800000-0000-4000-8000-000000000001'::uuid,'Declaration vehicle 1',30),('c4800000-0000-4000-8000-000000000002'::uuid,'Declaration vehicle 2',20)) d(id,title,days)
 cross join public.document_types t where t.code='customs_declaration';
insert into public.document_links(document_id,entity_type,entity_id,created_by) values
 ('c4800000-0000-4000-8000-000000000001','shipment_transport',pg_temp.id('C4-2:t1'),'c4000000-0000-4000-8000-000000000001'),
 ('c4800000-0000-4000-8000-000000000002','shipment_transport',pg_temp.id('C4-2:t2'),'c4000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$begin
 perform pg_temp.approve('C4-2','KZT');
 assert (select unit_landed_cost=5000 and goods_rate=500 from public.cost_calculation_items where shipment_item_id=pg_temp.id('C4-2:1:C4-RATES'));
 assert (select unit_landed_cost=5200 and goods_rate=520 from public.cost_calculation_items where shipment_item_id=pg_temp.id('C4-2:2:C4-RATES'));
 assert (pg_temp.batch('C4-RATES')).unit_landed_cost=5100,'two declaration dates: (500000+520000)/200 = 5100 KZT';
 assert (pg_temp.batch('C4-RATES')).cost_currency_id=pg_temp.cur('KZT');
end $$;

-- 3. Two shipments: A 50 pcs * 10, B 50 pcs * 14. While B is not approved the batch has no approved cost
--    (owner decision 2026-11-16), not the cost of A for all 100 pieces. After both: (500 + 700) / 100 = 12.00.
do $$begin
 perform pg_temp.ship('C4-3A','[{"vehicle":1,"product":"c4200000-0000-4000-8000-000000000003","uom":"piece","qty":50,"price":10,"batch":"C4-SHIPS"}]');
 perform pg_temp.receive('C4-3A',1,'[{"qty":50,"batch":"C4-SHIPS"}]');
 perform pg_temp.approve('C4-3A');
 assert (pg_temp.batch('C4-SHIPS')).unit_landed_cost=10,'one approved receipt: 10.00';
 perform pg_temp.ship('C4-3B','[{"vehicle":1,"product":"c4200000-0000-4000-8000-000000000003","uom":"piece","qty":50,"price":14,"batch":"C4-SHIPS"}]');
 perform pg_temp.receive('C4-3B',1,'[{"qty":50,"batch":"C4-SHIPS"}]');
 assert (pg_temp.batch('C4-SHIPS')).unit_landed_cost is null,'a receipt without approved cost: the batch cost is not approved';
 assert (pg_temp.batch('C4-SHIPS')).cost_currency_id is null and (pg_temp.batch('C4-SHIPS')).cost_calculation_id is null;
 perform pg_temp.approve('C4-3B');
 assert (pg_temp.batch('C4-SHIPS')).unit_landed_cost=12,'two shipments: (50*10 + 50*14)/100 = 12.00';
 -- Approving A again (a new version with the same inputs) keeps the average.
 perform pg_temp.approve('C4-3A');
 assert (pg_temp.batch('C4-SHIPS')).unit_landed_cost=12;
end $$;

-- 4. Boxes and pieces of one batch: 10 boxes * 24 (box of 12) and 60 pcs * 2.50.
--    (240 + 150) / (120 + 60) = 390 / 180 = 2.1667 per piece. Without packaging the units are not comparable.
do $$begin
 perform pg_temp.ship('C4-4A','[{"vehicle":1,"product":"c4200000-0000-4000-8000-000000000004","uom":"box","qty":10,"price":24,"batch":"C4-MIX"},
  {"vehicle":1,"product":"c4200000-0000-4000-8000-000000000005","uom":"box","qty":10,"price":24,"batch":"C4-NOPACK"}]');
 perform pg_temp.receive('C4-4A',1,'[{"qty":10,"batch":"C4-MIX"},{"qty":10,"batch":"C4-NOPACK"}]');
 perform pg_temp.approve('C4-4A');
 assert (pg_temp.batch('C4-MIX')).unit_landed_cost=24 and (pg_temp.batch('C4-MIX')).cost_uom='box','one unit: cost per box';
 perform pg_temp.ship('C4-4B','[{"vehicle":1,"product":"c4200000-0000-4000-8000-000000000004","uom":"piece","qty":60,"price":2.5,"batch":"C4-MIX"},
  {"vehicle":1,"product":"c4200000-0000-4000-8000-000000000005","uom":"piece","qty":60,"price":2.5,"batch":"C4-NOPACK"}]');
 perform pg_temp.receive('C4-4B',1,'[{"qty":60,"batch":"C4-MIX"},{"qty":60,"batch":"C4-NOPACK"}]');
 perform pg_temp.approve('C4-4B');
 assert (pg_temp.batch('C4-MIX')).unit_landed_cost=2.1667 and (pg_temp.batch('C4-MIX')).cost_uom='piece','boxes and pieces: 390/180 per piece';
 assert (pg_temp.batch('C4-NOPACK')).unit_landed_cost is null and (pg_temp.batch('C4-NOPACK')).cost_uom is null,
  'no packaging: boxes and pieces are not converted by guess';
end $$;

-- 5. A single vehicle gives exactly the cost of its item, as before the change.
do $$begin
 perform pg_temp.ship('C4-5','[{"vehicle":1,"product":"c4200000-0000-4000-8000-000000000006","uom":"piece","qty":40,"price":7.25,"batch":"C4-SINGLE"}]');
 perform pg_temp.receive('C4-5',1,'[{"qty":40,"batch":"C4-SINGLE"}]');
 perform pg_temp.approve('C4-5');
 assert (pg_temp.batch('C4-SINGLE')).unit_landed_cost=(select unit_landed_cost from public.cost_calculation_items where shipment_item_id=pg_temp.id('C4-5:1:C4-SINGLE'));
 assert (pg_temp.batch('C4-SINGLE')).unit_landed_cost=7.25;
end $$;

-- 6. Reading: with the unit and basis for prices.purchase.view, refused without it.
do $$begin
 assert (select cost_uom='piece' and unit_landed_cost=11.5 and cost_basis='receipts' and cost_currency_code='EUR'
  from public.my_batch_landed_costs('c4200000-0000-4000-8000-000000000001'));
 assert (select unit_landed_cost=11.5 from public.my_inventory_batch_costs('c4200000-0000-4000-8000-000000000001')),
  'the old reader keeps its result type and sees the new value';
end $$;
reset role;
select set_config('request.jwt.claim.sub','c4000000-0000-4000-8000-000000000003',true);
set local role authenticated;
select pg_temp.fails($q$select * from public.my_batch_landed_costs(null)$q$,'Нет доступа к себестоимости');
reset role;

-- 7. A batch costed by the old rule (its first vehicle) is not touched by migrations or unrelated approvals;
--    an administrator recalculates it, one batch, with preview and reason.
update public.inventory_batches set unit_landed_cost=11,cost_basis='source_item',cost_uom='piece' where batch_number='C4-TRUCKS';
select set_config('request.jwt.claim.sub','c4000000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$begin
 perform pg_temp.approve('C4-5');
 assert (pg_temp.batch('C4-TRUCKS')).unit_landed_cost=11 and (pg_temp.batch('C4-TRUCKS')).cost_basis='source_item',
  'approving another shipment does not rewrite an old batch';
end $$;
-- A director has prices.purchase.view but not the recalculation right.
select pg_temp.fails(format('select public.batch_cost_recalculation_preview(%L)',(pg_temp.batch('C4-TRUCKS')).id),'Нет права пересчитывать');
reset role;
select set_config('request.jwt.claim.sub','c4000000-0000-4000-8000-000000000003',true);
set local role authenticated;
select pg_temp.fails(format('select public.batch_cost_recalculation_preview(%L)',(pg_temp.batch('C4-TRUCKS')).id),'Нет права пересчитывать');
reset role;
select set_config('request.jwt.claim.sub','c4000000-0000-4000-8000-000000000002',true);
set local role authenticated;
create temporary table c4_preview as select public.batch_cost_recalculation_preview((pg_temp.batch('C4-TRUCKS')).id) p;
do $$
declare p jsonb:=(select p from c4_preview);
begin
 assert p->'old'->>'cost'='11.0000' and p->'old'->>'basis'='source_item';
 assert p->'new'->>'cost'='11.5000' and p->'new'->>'uom'='piece' and (p->>'changes')::boolean;
 assert jsonb_array_length(p->'sources')=2 and (select bool_and((s->>'approved')::boolean) from jsonb_array_elements(p->'sources') s);
 assert (pg_temp.batch('C4-TRUCKS')).unit_landed_cost=11,'the preview writes nothing';
end $$;
select pg_temp.fails(format('select public.recalculate_batch_cost(%L,%L,%L)',(pg_temp.batch('C4-TRUCKS')).id,(select p->>'stamp' from c4_preview),'  '),'причину');
select pg_temp.fails(format('select public.recalculate_batch_cost(%L,%L,%L)',(pg_temp.batch('C4-TRUCKS')).id,repeat('0',64),'Пересчёт по двум машинам поставки'),'изменились после предпросмотра');
reset role;
-- The batch changes between the preview and the confirmation: the old preview is refused.
update public.inventory_batches set notes='changed after preview' where batch_number='C4-TRUCKS';
select set_config('request.jwt.claim.sub','c4000000-0000-4000-8000-000000000002',true);
set local role authenticated;
select pg_temp.fails(format('select public.recalculate_batch_cost(%L,%L,%L)',(pg_temp.batch('C4-TRUCKS')).id,(select p->>'stamp' from c4_preview),'Пересчёт по двум машинам поставки'),'изменились после предпросмотра');
select public.recalculate_batch_cost((pg_temp.batch('C4-TRUCKS')).id,
 public.batch_cost_recalculation_preview((pg_temp.batch('C4-TRUCKS')).id)->>'stamp','Пересчёт по двум машинам поставки');
reset role;
do $$begin
 assert (pg_temp.batch('C4-TRUCKS')).unit_landed_cost=11.5 and (pg_temp.batch('C4-TRUCKS')).cost_basis='receipts';
 assert (select count(*)=1 from public.audit_log where action='batch_cost_recalculation' and entity_id=(pg_temp.batch('C4-TRUCKS')).id::text
  and actor_user_id='c4000000-0000-4000-8000-000000000002' and before_data->>'unit_landed_cost'='11.0000'
  and after_data->>'unit_landed_cost'='11.5000' and metadata->>'reason'='Пересчёт по двум машинам поставки'),'the journal keeps who, old, new and why';
 assert (select count(*)=1 from public.cost_calculations where shipment_id=pg_temp.id('C4-1') and status='approved'),
  'the approved calculation of the shipment is not changed by the recalculation';
end $$;
select set_config('request.jwt.claim.sub','c4000000-0000-4000-8000-000000000002',true);
set local role authenticated;
select pg_temp.fails(format('select public.recalculate_batch_cost(%L,%L,%L)',(pg_temp.batch('C4-TRUCKS')).id,
 public.batch_cost_recalculation_preview((pg_temp.batch('C4-TRUCKS')).id)->>'stamp','Повторный пересчёт без изменений'),'не изменится');
reset role;

-- 8. The assistant approves a two-vehicle shipment: its preview shows the averaged batch cost and the check passes.
select set_config('request.jwt.claim.sub','c4000000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$
declare rid uuid:=gen_random_uuid();v jsonb;calc uuid;
begin
 perform pg_temp.ship('C4-8','[{"vehicle":1,"product":"c4200000-0000-4000-8000-000000000007","uom":"piece","qty":100,"price":10,"batch":"C4-ASSIST"},
  {"vehicle":2,"product":"c4200000-0000-4000-8000-000000000007","uom":"piece","qty":100,"price":10,"batch":"C4-ASSIST"}]');
 perform pg_temp.receive('C4-8',1,'[{"qty":100,"batch":"C4-ASSIST"}]');
 perform pg_temp.receive('C4-8',2,'[{"qty":100,"batch":"C4-ASSIST"}]');
 perform pg_temp.freight('C4-8','{"C4-8:1:C4-ASSIST":"100.00","C4-8:2:C4-ASSIST":"200.00"}');
 calc:=public.calculate_shipment_cost(pg_temp.id('C4-8'),pg_temp.cur('EUR'));
 perform public.prepare_assistant_operation(rid,'shipment_cost_approve',jsonb_build_object('calculation_id',calc));
 v:=public.review_assistant_operation(rid);
 assert jsonb_array_length(v->'preview'->'batches')=1;
 assert v->'preview'->'batches'->0->>'new_cost'='11.5000' and v->'preview'->'batches'->0->>'new_uom'='piece';
 perform public.confirm_assistant_operation(rid,(v->>'review_token')::uuid);
 assert (select status='approved' from public.cost_calculations where id=calc);
 assert (pg_temp.batch('C4-ASSIST')).unit_landed_cost=11.5;
end $$;
reset role;

-- 9. Grants: readers and the recalculation are for authenticated holders of the rights only.
do $$begin
 assert not has_function_privilege('anon','public.my_batch_landed_costs(uuid)','execute');
 assert not has_function_privilege('anon','public.recalculate_batch_cost(uuid,text,text)','execute');
 assert not has_function_privilege('authenticated','private.refresh_batch_cost(uuid)','execute');
 assert exists(select 1 from public.role_permissions rp join public.app_roles r on r.id=rp.role_id join public.permissions p on p.id=rp.permission_id
  where r.code='administrator' and p.code='costing.batch_recalculate' and rp.granted);
 assert not exists(select 1 from public.role_permissions rp join public.app_roles r on r.id=rp.role_id join public.permissions p on p.id=rp.permission_id
  where r.code<>'administrator' and p.code='costing.batch_recalculate' and rp.granted);
end $$;
rollback;
\echo batch_cost_by_receipt: all checks passed
