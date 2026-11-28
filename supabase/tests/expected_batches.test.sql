-- 202611280700: batch labels printed before the goods arrive. Batches of the packing list per shipment item, their labels
-- printed in advance (also by logistics without warehouse rights), the receipt binding a label only to the same batch
-- number of the same item with the expiry of the packing list; an unmatched label stays unbound and says why; a label
-- of a received batch is the batch's only code. Synthetic data; rolled back.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('eb000000-0000-4000-8000-000000000001','prelabel-director@example.invalid','{"full_name":"Prelabel Director"}'),
 ('eb000000-0000-4000-8000-000000000002','prelabel-logist@example.invalid','{"full_name":"Prelabel Logist"}'),
 ('eb000000-0000-4000-8000-000000000003','prelabel-none@example.invalid','{"full_name":"Prelabel Viewer"}');
insert into public.user_roles(user_id,role_id) select u.id::uuid,r.id from (values
 ('eb000000-0000-4000-8000-000000000001'),('eb000000-0000-4000-8000-000000000002'),('eb000000-0000-4000-8000-000000000003')) u(id)
 join public.app_roles r on r.code='director';
-- The logist edits shipments but has no warehouse right; the viewer sees shipments and edits nothing.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select v.u::uuid,p.id,'deny','prelabel test','eb000000-0000-4000-8000-000000000001'
   from (values ('eb000000-0000-4000-8000-000000000002','inventory.move'),('eb000000-0000-4000-8000-000000000002','inventory.receive'),
                ('eb000000-0000-4000-8000-000000000002','inventory.control'),('eb000000-0000-4000-8000-000000000002','warehouses.update'),
                ('eb000000-0000-4000-8000-000000000003','inventory.receive'),('eb000000-0000-4000-8000-000000000003','shipments.update')) v(u,code)
   join public.permissions p on p.code=v.code;
insert into public.counterparties(id,roles,legal_name,country,tax_id)
values('eb100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Prelabel supplier','TR','PRE-TEST-TR');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('eb200000-0000-4000-8000-000000000001','PRE-1','{"ru":"Шоколад"}','eb100000-0000-4000-8000-000000000001','active'),
 ('eb200000-0000-4000-8000-000000000002','PRE-2','{"ru":"Вафли"}','eb100000-0000-4000-8000-000000000001','active'),
 ('eb200000-0000-4000-8000-000000000003','PRE-3','{"ru":"Печенье"}','eb100000-0000-4000-8000-000000000001','active');
create schema if not exists tests;
create table tests.pre(k text primary key,id uuid);
grant usage on schema tests to authenticated;
grant all on tests.pre to authenticated;
create function pg_temp.id(p text) returns uuid language sql stable as $$select id from tests.pre where k=p$$;
create function pg_temp.code(p_label uuid) returns text language sql stable security definer as $$select code from public.scan_labels where id=p_label$$;
create function pg_temp.code_of(p_expected uuid) returns text language sql stable security definer as $$select code from public.scan_labels where expected_batch_id=p_expected$$;
create function pg_temp.batch(p_number text) returns uuid language sql stable security definer as $$select id from public.inventory_batches where batch_number=p_number$$;
create function pg_temp.batches(p_number text) returns table(id uuid, expiry_date date) language sql stable security definer as
 $$select id,expiry_date from public.inventory_batches where batch_number=p_number$$;
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- A shipment with one truck: 100 pieces of PRE-1 and 50 of PRE-2; one more item not yet on a truck.
set role authenticated;
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',true);
insert into tests.pre values ('shipment',public.create_shipment_with_stages(
 'PRE-TEST','import','eb100000-0000-4000-8000-000000000001',null,
 (select id from public.routes where status='active' order by created_at limit 1),(select id from public.currencies where code='EUR'),
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),
 'eb000000-0000-4000-8000-000000000001',current_date,current_date+14));
select public.add_shipment_transport(pg_temp.id('shipment'));
insert into tests.pre select 'truck',id from public.shipment_transports where shipment_id=pg_temp.id('shipment') and sequence_no=1;
insert into tests.pre values
 ('item1',public.create_shipment_item(pg_temp.id('shipment'),'eb200000-0000-4000-8000-000000000001','piece',100,1,(select id from public.currencies where code='EUR'))),
 ('item2',public.create_shipment_item(pg_temp.id('shipment'),'eb200000-0000-4000-8000-000000000002','piece',50,1,(select id from public.currencies where code='EUR'))),
 ('item3',public.create_shipment_item(pg_temp.id('shipment'),'eb200000-0000-4000-8000-000000000003','piece',10,1,(select id from public.currencies where code='EUR')));
select public.allocate_shipment_item(pg_temp.id('item1'),pg_temp.id('truck'),100);
select public.allocate_shipment_item(pg_temp.id('item2'),pg_temp.id('truck'),50);

-- 1. Batches of the packing list: entered once per item and number; the rules of a batch hold.
insert into tests.pre values
 ('A',public.add_expected_batch(pg_temp.id('item1'),' LOT-A ',current_date+400,current_date-10,60,3,'packing_list','Packing list 7781')),
 ('B',public.add_expected_batch(pg_temp.id('item1'),'LOT-B',current_date+350,null,30,2,'packing_list','Packing list 7781')),
 ('Z',public.add_expected_batch(pg_temp.id('item1'),'LOT-Z',current_date+300,null,10,1,'packing_list',null)),
 ('Q',public.add_expected_batch(pg_temp.id('item1'),'LOT-Q',current_date+300,null,null,null,'manual',null)),
 ('C',public.add_expected_batch(pg_temp.id('item2'),'LOT-C',null,null,20,null,'packing_list',null)),
 ('S',public.add_expected_batch(pg_temp.id('item2'),'LOT-S',current_date+450,null,30,2,'packing_list',null)),
 ('X',public.add_expected_batch(pg_temp.id('item2'),'LOT-X',current_date+200,null,null,null,'manual',null)),
 ('R',public.add_expected_batch(pg_temp.id('item3'),'LOT-R',current_date+200,null,null,null,'manual',null));
select pg_temp.fails($q$select public.add_expected_batch(pg_temp.id('item1'),'lot-a',null,null,null,null,'manual',null)$q$,'Партия LOT-A уже есть у этой позиции');
select pg_temp.fails($q$select public.add_expected_batch(pg_temp.id('item1'),'  ',null,null,null,null,'manual',null)$q$,'номер партии');
select pg_temp.fails($q$select public.add_expected_batch(pg_temp.id('item1'),'LOT-E',current_date,current_date+1,null,null,'manual',null)$q$,'позже срока');
select pg_temp.fails($q$select public.add_expected_batch(pg_temp.id('item1'),'LOT-E',null,null,0,null,'manual',null)$q$,'положительное');
select pg_temp.fails($q$select public.add_expected_batch(pg_temp.id('item1'),'LOT-E',null,null,1.0005,null,'manual',null)$q$,'трёх знаков');
select pg_temp.fails($q$select public.add_expected_batch(pg_temp.id('item1'),'LOT-E',null,null,null,101,'manual',null)$q$,'от 1 до 100');
select pg_temp.fails($q$select public.add_expected_batch(pg_temp.id('item1'),'LOT-E',null,null,null,null,'guess',null)$q$,'источник');
select pg_temp.fails($q$select public.add_expected_batch(gen_random_uuid(),'LOT-E',null,null,null,null,'manual',null)$q$,'Позиция поставки не найдена');
-- A mistake is cancelled with a reason, never deleted.
select pg_temp.fails($q$select public.cancel_expected_batch(pg_temp.id('X'),' ')$q$,'причину');
select public.cancel_expected_batch(pg_temp.id('X'),'Нет в упаковочном листе');
select pg_temp.fails($q$select public.cancel_expected_batch(pg_temp.id('X'),'ещё раз')$q$,'только ожидаемую');
do $$
declare v jsonb := public.shipment_expected_batches(pg_temp.id('shipment')); i1 jsonb; i2 jsonb;
begin
 assert (v->>'can_manage')::boolean;
 select x into i1 from jsonb_array_elements(v->'items') x where x->>'item_id'=pg_temp.id('item1')::text;
 select x into i2 from jsonb_array_elements(v->'items') x where x->>'item_id'=pg_temp.id('item2')::text;
 assert jsonb_array_length(i1->'batches')=4 and i1->>'transport_no'='1' and not (i1->>'received')::boolean;
 assert i1->'batches'->0->>'batch'='LOT-Q' and i1->'batches'->0->>'state'='expected' and i1->'batches'->0->>'label_code' is null,
   'by expiry, then number; without a label until printed';
 assert (select x->>'batch' from jsonb_array_elements(i1->'batches') x where x->>'id'=pg_temp.id('A')::text)='LOT-A','the number is trimmed';
 assert i2->'batches'->-1->>'state'='cancelled' and i2->'batches'->-1->>'note'='Нет в упаковочном листе','a cancelled batch comes last with its reason';
end $$;
reset role;
do $$begin
 assert not has_table_privilege('authenticated','public.expected_batches','select');
 assert not has_table_privilege('authenticated','public.expected_batches','update');
 assert not has_function_privilege('anon','public.add_expected_batch(uuid,text,date,date,numeric,integer,text,text)','execute');
end $$;

-- 2. Labels printed in advance: logistics without warehouse rights may print them (and only them).
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000002',true);
set local role authenticated;
do $$
declare v jsonb := public.ensure_scan_labels('expected_batch',array[pg_temp.id('A'),pg_temp.id('B'),pg_temp.id('C'),pg_temp.id('Z'),pg_temp.id('Q'),pg_temp.id('A'),pg_temp.id('S')]);
        w jsonb;
begin
 assert jsonb_array_length(v)=6,'one label per batch, duplicates of the request ignored';
 assert v->0->>'title'='PRE-1 · LOT-A' and v->0->>'subtitle'='Шоколад · до '||to_char(current_date+400,'DD.MM.YYYY') and (v->0->>'code') ~ '^NX-[0-9A-HJKMNP-TV-Z]{8}$';
 assert v->2->>'title'='PRE-2 · LOT-C' and v->2->>'subtitle'='Вафли','no expiry in the list, none on the label';
 w := public.ensure_scan_labels('expected_batch',array[pg_temp.id('A')]);
 assert w->0->>'code'=v->0->>'code','the code never changes';
 assert public.record_label_print((select array_agg((x->>'label_id')::uuid) from jsonb_array_elements(v) x),'thermal',3)=6;
 insert into tests.pre values ('labelA',(v->0->>'label_id')::uuid),('labelB',(v->1->>'label_id')::uuid),('labelZ',(v->3->>'label_id')::uuid),
                              ('labelQ',(v->4->>'label_id')::uuid),('labelC',(v->2->>'label_id')::uuid);
end $$;
select pg_temp.fails($q$select public.ensure_scan_labels('expected_batch',array[pg_temp.id('X')])$q$,'отменена');
select pg_temp.fails($q$select public.ensure_scan_labels('batch',array[gen_random_uuid()])$q$,'Нет права печатать этикетки склада');
reset role;
-- A location label is not the logist's to print.
insert into public.warehouse_locations(id,warehouse_id,code,zone,status)
select 'eb300000-0000-4000-8000-000000000001',destination_warehouse_id,'PRE-RCV','receiving','active' from public.shipments where id=pg_temp.id('shipment');
insert into public.scan_labels(id,code,target_type,location_id,created_by)
values ('eb400000-0000-4000-8000-000000000001','NX-0000PRE1','location','eb300000-0000-4000-8000-000000000001','eb000000-0000-4000-8000-000000000001');
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000002',true);
set local role authenticated;
select pg_temp.fails($q$select public.record_label_print(array[pg_temp.id('labelA'),'eb400000-0000-4000-8000-000000000001'::uuid],'a4',1)$q$,'Нет права печатать');
reset role;
-- Without the right to prepare batches: nothing is added, cancelled or printed.
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000003',true);
set local role authenticated;
select pg_temp.fails($q$select public.add_expected_batch(pg_temp.id('item1'),'LOT-N',null,null,null,null,'manual',null)$q$,'Нет права готовить партии');
select pg_temp.fails($q$select public.cancel_expected_batch(pg_temp.id('Q'),'нет')$q$,'Нет права готовить партии');
select pg_temp.fails($q$select public.ensure_scan_labels('expected_batch',array[pg_temp.id('Q')])$q$,'Нет права печатать этикетки партий');
do $$begin assert not (public.shipment_expected_batches(pg_temp.id('shipment'))->>'can_manage')::boolean;end $$;
reset role;

-- 3. Before the truck: the label says what is expected.
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$
declare v jsonb := public.scan_lookup(pg_temp.code(pg_temp.id('labelA')));
begin
 assert v->>'kind'='expected' and v->'expected'->>'state'='expected' and v->'expected'->>'batch'='LOT-A' and v->'expected'->>'sku'='PRE-1'
   and v->'expected'->>'shipment'=public.shipment_expected_batches(pg_temp.id('shipment'))->>'shipment_number' and v->'expected'->>'transport_no'='1' and (v->'expected'->>'quantity')::numeric=60;
end $$;

-- 4. The receipt: LOT-A as listed; LOT-B with another expiry; LOT-Z not accepted at all; lot-c in other letters and
--    without an expiry in the list; LOT-Q not in the receipt.
select public.change_shipment_transport_status(pg_temp.id('truck'),'arrived');
-- Batches of the packing list are filled in: the receipt needs the confirmation that the expiries were compared with
-- the boxes — refused without it, by the old way too, and nothing is written.
create function pg_temp.lines() returns jsonb language sql stable as $l$select jsonb_build_array(
  jsonb_build_object('item_id',pg_temp.id('item1'),'expected_quantity',60,'accepted_quantity',60,'damaged_quantity',0,'batch_number','LOT-A','expiry_date',(current_date+400)::text),
  jsonb_build_object('item_id',pg_temp.id('item1'),'expected_quantity',30,'accepted_quantity',30,'damaged_quantity',0,'batch_number','LOT-B','expiry_date',(current_date+351)::text),
  jsonb_build_object('item_id',pg_temp.id('item1'),'expected_quantity',10,'accepted_quantity',0,'damaged_quantity',0,'batch_number','LOT-Z','expiry_date',(current_date+300)::text,'discrepancy_reason','Не пришла'),
  -- LOT-S came with two expiries, the one of the packing list second: the label still binds to it.
  jsonb_build_object('item_id',pg_temp.id('item2'),'expected_quantity',20,'accepted_quantity',20,'damaged_quantity',0,'batch_number','LOT-S','expiry_date',(current_date+460)::text),
  jsonb_build_object('item_id',pg_temp.id('item2'),'expected_quantity',10,'accepted_quantity',10,'damaged_quantity',0,'batch_number','LOT-S','expiry_date',(current_date+450)::text),
  jsonb_build_object('item_id',pg_temp.id('item2'),'expected_quantity',20,'accepted_quantity',20,'damaged_quantity',0,'batch_number','lot-c','expiry_date',(current_date+500)::text))
$l$;
grant execute on function pg_temp.lines() to authenticated;
select pg_temp.fails($q$select public.receive_shipment_transport(pg_temp.id('truck'),'eb300000-0000-4000-8000-000000000001',pg_temp.lines(),'Prelabel Receiver',null)$q$,
                     'сроки сверены с маркировкой');
select pg_temp.fails($q$select public.receive_shipment_transport_checked(pg_temp.id('truck'),'eb300000-0000-4000-8000-000000000001',pg_temp.lines(),'Prelabel Receiver',null,false)$q$,
                     'сроки сверены с маркировкой');
do $$begin assert not (select bool_or((i->>'received')::boolean) from jsonb_array_elements(public.shipment_expected_batches(pg_temp.id('shipment'))->'items') i),'nothing received';end $$;
select public.receive_shipment_transport_checked(pg_temp.id('truck'),'eb300000-0000-4000-8000-000000000001',pg_temp.lines(),'Prelabel Receiver',null,true);
select pg_temp.fails($q$select public.add_expected_batch(pg_temp.id('item1'),'LOT-LATE',null,null,null,null,'manual',null)$q$,'уже принята');
select pg_temp.fails($q$select public.cancel_expected_batch(pg_temp.id('A'),'поздно')$q$,'только ожидаемую');
do $$
declare v jsonb := public.shipment_expected_batches(pg_temp.id('shipment'));
        s jsonb;
begin
 select jsonb_object_agg(x->>'batch',x) into s from jsonb_array_elements(v->'items') i, jsonb_array_elements(i->'batches') x;
 assert s->'LOT-A'->>'state'='received' and s->'LOT-A'->>'batch_id'=pg_temp.batch('LOT-A')::text;
 assert s->'LOT-B'->>'state'='mismatch' and s->'LOT-B'->>'batch_id' is null
   and s->'LOT-B'->>'note'='Срок по упаковочному листу '||to_char(current_date+350,'DD.MM.YYYY')||', при приёмке '||to_char(current_date+351,'DD.MM.YYYY')||': наклейка не привязана';
 assert s->'LOT-Z'->>'state'='not_received' and s->'LOT-Z'->>'note' like 'Партия не принята%';
 assert s->'LOT-Q'->>'state'='missing','listed, but not in the receipt';
 assert s->'LOT-C'->>'state'='received','the number in other letters, no expiry in the list to compare';
 assert s->'LOT-S'->>'state'='received' and s->'LOT-S'->>'batch_id'=(select id::text from pg_temp.batches('LOT-S') x where x.expiry_date=current_date+450),
   'mixed expiries: the label binds to the part with the expiry of the packing list, whatever the order of the lines';
 assert s->'LOT-S'->'other_expiries'=jsonb_build_array(current_date+460),'the part with another expiry is named: it has no label of the list';
 assert s->'LOT-A'->'other_expiries'='[]'::jsonb;
 assert s->'LOT-A'->>'expiry_checked_by'='Prelabel Director' and s->'LOT-A'->>'expiry_checked_at' is not null,'who confirmed the expiries is kept';
 assert s->'LOT-R'->>'expiry_checked_by' is null,'only the batches of the truck received';
 assert s->'LOT-R'->>'state'='expected','the item on no truck yet stays expected';
end $$;

-- 5. After the receipt: the bound label is the batch's (with its stock); an unbound one says why; the batch keeps one code.
do $$
declare a jsonb := public.scan_lookup(pg_temp.code(pg_temp.id('labelA')));
        b jsonb := public.scan_lookup(pg_temp.code(pg_temp.id('labelB')));
        q jsonb := public.scan_lookup(pg_temp.code(pg_temp.id('labelQ')));
        sl jsonb := public.scan_lookup(pg_temp.code_of(pg_temp.id('S')));
        l jsonb;
begin
 assert a->>'kind'='batch' and a->'batch'->>'batch'='LOT-A' and (a->'stock'->0->>'on_hand')::numeric=60 and a->'stock'->0->>'location'='PRE-RCV';
 assert b->>'kind'='expected' and b->'expected'->>'state'='mismatch' and b->'expected'->>'note' like 'Срок по упаковочному листу%';
 assert q->>'kind'='expected' and q->'expected'->>'state'='missing';
 assert sl->>'kind'='batch' and (sl->'batch'->>'expiry_date')::date=current_date+450
   and sl->'batch'->'other_expiries'=jsonb_build_array(current_date+460),'scanning the label warns: the same number has another expiry in stock';
 assert a->'batch'->'other_expiries'='[]'::jsonb;
 l := public.ensure_scan_labels('batch',array[pg_temp.batch('LOT-A')]);
 assert jsonb_array_length(l)=1 and l->0->>'label_id'=pg_temp.id('labelA')::text and l->0->>'title'='PRE-1 · LOT-A',
   'the label printed in advance is the batch label: no second code';
 l := public.ensure_scan_labels('batch',array[pg_temp.batch('LOT-B')]);
 assert l->0->>'target_type'='batch' and l->0->>'label_id'<>pg_temp.id('labelB')::text,'an unbound batch gets its own label';
end $$;
reset role;
do $$begin
 assert (select count(*) from public.scan_labels where target_type='batch' and batch_id=pg_temp.batch('LOT-A'))=0;
end $$;

-- 6. An item removed from the shipment: its batches are void, their labels say so.
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',true);
set local role authenticated;
select public.ensure_scan_labels('expected_batch',array[pg_temp.id('R')]);
reset role;
delete from public.shipment_items where id=pg_temp.id('item3');
set local role authenticated;
do $$
declare v jsonb := public.shipment_expected_batches(pg_temp.id('shipment'));
        r jsonb := public.scan_lookup(pg_temp.code_of(pg_temp.id('R')));
begin
 assert v->'orphans'->0->>'batch'='LOT-R';
 assert r->>'kind'='expected' and r->'expected'->>'state'='removed';
end $$;
reset role;
rollback;
