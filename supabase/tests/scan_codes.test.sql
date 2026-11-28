-- 202611280500: scanning. Every kind of code (unit and box barcodes, GTIN with and without leading zeros, Nexus labels of
-- a location and a batch, a GS1 batch number), an unknown code without and with the right to bind it, a lookup that
-- writes nothing, labels made once and every print recorded. Synthetic data; rolled back.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('ce000000-0000-4000-8000-000000000001','scan-store@example.invalid','{"full_name":"Storekeeper"}'),
 ('ce000000-0000-4000-8000-000000000002','scan-products@example.invalid','{"full_name":"Product manager"}'),
 ('ce000000-0000-4000-8000-000000000003','scan-none@example.invalid','{"full_name":"Without stock"}');
insert into public.user_roles(user_id,role_id) select u.id::uuid,r.id from (values
 ('ce000000-0000-4000-8000-000000000001','logistics_specialist'),('ce000000-0000-4000-8000-000000000002','director'),
 ('ce000000-0000-4000-8000-000000000003','logistics_specialist')) u(id,code) join public.app_roles r on r.code=u.code;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select v.u::uuid,p.id,v.e,'scan test','ce000000-0000-4000-8000-000000000002'
   from (values ('ce000000-0000-4000-8000-000000000001','products.update','deny'),('ce000000-0000-4000-8000-000000000001','prices.purchase.view','deny'),
                ('ce000000-0000-4000-8000-000000000002','products.update','allow'),('ce000000-0000-4000-8000-000000000002','inventory.view','allow'),
                ('ce000000-0000-4000-8000-000000000003','inventory.view','deny'),('ce000000-0000-4000-8000-000000000003','products.view','deny')) v(u,code,e)
   join public.permissions p on p.code=v.code;
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
create function pg_temp.writes() returns bigint language sql stable security definer as $$
 select (select count(*) from public.scan_labels)+(select count(*) from public.scan_label_prints)+(select count(*) from public.product_identifiers)
       +(select count(*) from public.audit_log)+(select count(*) from public.inventory_movements) $$;
grant execute on all functions in schema pg_temp to authenticated;

-- A product with a unit barcode, a box barcode (12 pieces) and a GTIN-14; two batches at two locations.
insert into public.counterparties(id,roles,legal_name,country) values ('ce100000-0000-4000-8000-000000000001',array['manufacturer'],'Scan maker','FI');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('ce200000-0000-4000-8000-000000000001','SCAN-1','{"ru":"Шоколад"}','ce100000-0000-4000-8000-000000000001','active'),
 ('ce200000-0000-4000-8000-000000000002','SCAN-2','{"ru":"Вафли"}','ce100000-0000-4000-8000-000000000001','active');
insert into public.product_packaging(product_id,uom,units_per_parent) values ('ce200000-0000-4000-8000-000000000001','box',12);
insert into public.product_identifiers(product_id,identifier_type,value,packaging_uom) values
 ('ce200000-0000-4000-8000-000000000001','unit_barcode','4601234567893',null),
 ('ce200000-0000-4000-8000-000000000001','box_barcode','14601234567890','box'),
 ('ce200000-0000-4000-8000-000000000001','gtin','04601234567800',null);
insert into public.warehouse_locations(id,warehouse_id,code,zone) select v.id::uuid,(select id from public.warehouses where status='active' and not is_virtual order by code limit 1),v.c,'storage'
  from (values ('ce300000-0000-4000-8000-000000000001','SCAN-A1'),('ce300000-0000-4000-8000-000000000002','SCAN-A2')) v(id,c);
insert into public.inventory_batches(id,product_id,batch_number,expiry_date,created_by,unit_landed_cost,cost_currency_id,cost_uom) values
 ('ce400000-0000-4000-8000-000000000001','ce200000-0000-4000-8000-000000000001','LOT-77',current_date+120,'ce000000-0000-4000-8000-000000000002',450,
  (select id from public.currencies where code='KZT'),'piece'),
 ('ce400000-0000-4000-8000-000000000002','ce200000-0000-4000-8000-000000000001','LOT-88',current_date+300,'ce000000-0000-4000-8000-000000000002',null,null,null);
insert into public.inventory_balances(batch_id,warehouse_id,warehouse_location_id,uom,quantity_on_hand,quantity_reserved)
select v.b::uuid,(select id from public.warehouses where status='active' and not is_virtual order by code limit 1),v.l::uuid,'piece',v.q,v.r
  from (values ('ce400000-0000-4000-8000-000000000001','ce300000-0000-4000-8000-000000000001',30,10),
               ('ce400000-0000-4000-8000-000000000002','ce300000-0000-4000-8000-000000000002',50,0)) v(b,l,q,r);

-- 1. Labels: made once per location or batch, opaque, every print recorded (the second is a reprint).
select set_config('request.jwt.claim.sub','ce000000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$
declare v jsonb := public.ensure_scan_labels('location',array['ce300000-0000-4000-8000-000000000001','ce300000-0000-4000-8000-000000000002']::uuid[]);
        w jsonb;
begin
 assert jsonb_array_length(v)=2 and v->0->>'title'='SCAN-A1' and (v->0->>'code') ~ '^NX-[0-9A-HJKMNP-TV-Z]{8}$' and not (v->0->>'printed')::boolean;
 w := public.ensure_scan_labels('location',array['ce300000-0000-4000-8000-000000000001']::uuid[]);
 assert w->0->>'code'=v->0->>'code','the code of a place never changes';
 perform set_config('tests.loc_label',v->0->>'label_id',true);
 perform set_config('tests.loc_code',v->0->>'code',true);
 v := public.ensure_scan_labels('batch',array['ce400000-0000-4000-8000-000000000001']::uuid[]);
 assert v->0->>'title'='SCAN-1 · LOT-77' and v->0->>'subtitle' like 'Шоколад · до %';
 perform set_config('tests.batch_code',v->0->>'code',true);
 assert public.record_label_print(array[current_setting('tests.loc_label')::uuid],'a4',1)=1;
 assert public.record_label_print(array[current_setting('tests.loc_label')::uuid],'thermal',2)=1;
end $$;
select pg_temp.fails($q$select public.record_label_print(array[gen_random_uuid()],'a4',1)$q$,'не найдена');
select pg_temp.fails($q$select public.record_label_print(array[current_setting('tests.loc_label')::uuid],'a5',1)$q$,'лист A4 или термопринтер');
reset role;
do $$begin
 assert (select array_agg(is_reprint order by printed_at) from public.scan_label_prints where label_id=current_setting('tests.loc_label')::uuid)='{f,t}',
   'the second print is a reprint';
end $$;
select pg_temp.fails($q$update public.scan_labels set code='NX-00000000'$q$,'не меняются');
select pg_temp.fails($q$delete from public.scan_label_prints$q$,'не меняются');

-- 2. Lookup of every kind of code; it writes nothing.
select set_config('tests.writes',pg_temp.writes()::text,true);
set local role authenticated;
do $$
declare v jsonb;
begin
 v := public.scan_lookup('4601234567893');
 assert v->>'kind'='product' and v->'products'->0->>'sku'='SCAN-1' and v->'products'->0->>'uom'='piece' and (v->'products'->0->>'pieces')::numeric=1;
 assert jsonb_array_length(v->'products'->0->'stock')=2,'both batches with stock';
 assert (select (x->>'free')::numeric from jsonb_array_elements(v->'products'->0->'stock') x where x->>'batch'='LOT-77')=20,'30 on hand, 10 reserved';
 assert (select x->>'unit_cost' from jsonb_array_elements(v->'products'->0->'stock') x where x->>'batch'='LOT-77') is null,'no cost without purchase prices';
 v := public.scan_lookup(' 14601234567890 ');
 assert v->'products'->0->>'uom'='box' and (v->'products'->0->>'pieces')::numeric=12,'a box barcode is a box of 12';
 v := public.scan_lookup('4601234567800');
 assert v->>'kind'='product' and v->'products'->0->>'identifier_type'='gtin','GTIN-13 finds the GTIN stored with a leading zero';
 v := public.scan_lookup('04601234567800','lot-77');
 assert (v->'products'->0->>'batch_found')::boolean and jsonb_array_length(v->'products'->0->'stock')=1
    and v->'products'->0->'stock'->0->>'batch'='LOT-77','the GS1 batch narrows the stock';
 v := public.scan_lookup('04601234567800','LOT-99');
 assert not (v->'products'->0->>'batch_found')::boolean and jsonb_array_length(v->'products'->0->'stock')=0;
 v := public.scan_lookup(lower(current_setting('tests.loc_code')));
 assert v->>'kind'='location' and v->'location'->>'code'='SCAN-A1' and jsonb_array_length(v->'stock')=1 and v->'stock'->0->>'batch'='LOT-77';
 v := public.scan_lookup(current_setting('tests.batch_code'));
 assert v->>'kind'='batch' and v->'batch'->>'batch'='LOT-77' and v->'stock'->0->>'location'='SCAN-A1';
 v := public.scan_lookup('2000000000001');
 assert v->>'kind'='unknown' and not (v->>'can_bind')::boolean,'unknown, and this employee may not bind it';
end $$;
select pg_temp.fails($q$select public.scan_lookup('')$q$,'Пустой');
reset role;
do $$begin assert pg_temp.writes()=current_setting('tests.writes')::bigint,'a scan writes nothing';end $$;

-- 3. An unknown code: refused without products.update (nothing created); bound with it, confirmed, in the audit log.
set local role authenticated;
select pg_temp.fails($q$select public.bind_scan_code('2000000000001','ce200000-0000-4000-8000-000000000002','unit_barcode',null,true)$q$,'Код не найден');
reset role;
do $$begin assert pg_temp.writes()=current_setting('tests.writes')::bigint,'a refused binding creates nothing';end $$;
select set_config('request.jwt.claim.sub','ce000000-0000-4000-8000-000000000002',true);
set local role authenticated;
do $$begin assert (public.scan_lookup('2000000000001')->>'can_bind')::boolean;end $$;
select pg_temp.fails($q$select public.bind_scan_code('2000000000001','ce200000-0000-4000-8000-000000000002','unit_barcode',null,false)$q$,'Подтвердите');
select pg_temp.fails($q$select public.bind_scan_code('2000000000001','ce200000-0000-4000-8000-000000000002','box_barcode','box',true)$q$,'не задана упаковка');
select pg_temp.fails($q$select public.bind_scan_code(current_setting('tests.loc_code'),'ce200000-0000-4000-8000-000000000002','unit_barcode',null,true)$q$,'не похож');
select public.bind_scan_code('2000000000001','ce200000-0000-4000-8000-000000000002','unit_barcode',null,true);
select pg_temp.fails($q$select public.bind_scan_code('02000000000001','ce200000-0000-4000-8000-000000000001','unit_barcode',null,true)$q$,'уже привязан');
do $$declare v jsonb := public.scan_lookup('2000000000001');begin
 assert v->>'kind'='product' and v->'products'->0->>'sku'='SCAN-2';
 assert (select x->>'unit_cost' from jsonb_array_elements(public.scan_lookup('4601234567893')->'products'->0->'stock') x where x->>'batch'='LOT-77')='450.0000',
   'cost with purchase prices';
end $$;
reset role;
do $$begin
 assert (select count(*)=1 from public.audit_log where action='scan_code_bound' and actor_user_id='ce000000-0000-4000-8000-000000000002'
          and after_data->>'value'='2000000000001');
end $$;

-- 4. Without stock and products rights: no lookup.
select set_config('request.jwt.claim.sub','ce000000-0000-4000-8000-000000000003',true);
set local role authenticated;
select pg_temp.fails($q$select public.scan_lookup('4601234567893')$q$,'Нет доступа к поиску по коду');
select pg_temp.fails($q$select * from public.scan_labels$q$,'permission denied');
reset role;

rollback;
\echo 'scan_codes: all checks passed'
