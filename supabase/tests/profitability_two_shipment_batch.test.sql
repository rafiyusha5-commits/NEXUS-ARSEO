-- Audit of 2026-11-18, finding Н3: "profitability attributes a batch received from two shipments to the first one".
-- Receiving the same batch (product, number, expiry) in a second shipment adds to the existing batch, whose source
-- stays the first shipment item (202611010100). Before 202611210300 the report by shipment put every sale of such a
-- batch under the first shipment (this test failed there: S2 had no row). Owner decision of 2026-11-21: share the
-- batch between its shipments in proportion to the pieces each received. Synthetic data only; rolled back.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('ad300000-0000-4000-8000-000000000001','profit-director@example.invalid','{"full_name":"Profit director"}'),
 ('ad300000-0000-4000-8000-000000000002','profit-denied@example.invalid','{"full_name":"Director without purchase prices"}');
insert into public.user_roles(user_id,role_id) select u.id,r.id from (values
 ('ad300000-0000-4000-8000-000000000001'::uuid,'director'),('ad300000-0000-4000-8000-000000000002'::uuid,'director')) u(id,code)
 join public.app_roles r on r.code=u.code;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'ad300000-0000-4000-8000-000000000002',id,'deny','No purchase prices','ad300000-0000-4000-8000-000000000001'
 from public.permissions where code='prices.purchase.view';
-- The test user also needs the rights of the whole path (reports, returns, stock moves) whatever the role gives.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'ad300000-0000-4000-8000-000000000001',id,'allow','Synthetic full path','ad300000-0000-4000-8000-000000000001'
 from public.permissions where code in ('reports.view','sales.returns','inventory.move','sales.reserve','sales.manage','sales.view','sales.override_fefo');
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'ad300000-0000-4000-8000-000000000002',id,'allow','Synthetic reports','ad300000-0000-4000-8000-000000000001'
 from public.permissions where code='reports.view';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('ad310000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Profit supplier','FI','AD3-SUP'),
 ('ad310000-0000-4000-8000-000000000011',array['customer'],'Казахстанский клиент','KZ','AD3-C1'),
 ('ad310000-0000-4000-8000-000000000012',array['customer'],'Экспортный клиент','RU','AD3-C2');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('ad320000-0000-4000-8000-000000000001','AD3-A','{"ru":"Товар A"}','ad310000-0000-4000-8000-000000000001','active'),
 ('ad320000-0000-4000-8000-000000000002','AD3-B','{"ru":"Товар B"}','ad310000-0000-4000-8000-000000000001','active');
insert into public.exchange_rates(base_currency_id,quote_currency_id,rate,source,rate_date,created_by)
 select (select id from public.currencies where code='EUR'),(select id from public.currencies where code='KZT'),500,'official',current_date-1,
 'ad300000-0000-4000-8000-000000000001';
insert into public.vat_rates(country,rate,valid_from,reason,created_by) values ('KZ',0.12,'2020-01-01','Синтетическая ставка','ad300000-0000-4000-8000-000000000001');

create temporary table d7(k text primary key,id uuid);
grant all on d7 to authenticated;
create function pg_temp.id(p_key text) returns uuid language sql stable as $$ select id from d7 where k=p_key $$;
create function pg_temp.cur(p_code text) returns uuid language sql stable as $$ select id from public.currencies where code=p_code $$;
create function pg_temp.wh() returns uuid language sql stable security definer as $$
 select id from public.warehouses where status='active' and not is_virtual order by code limit 1 $$;
create function pg_temp.batch(p_number text) returns uuid language sql stable security definer as $$
 select id from public.inventory_batches where batch_number=p_number $$;
-- A shipment of one vehicle: lines [{"product":..,"qty":..,"price":..,"batch":..,"expiry_days":..}], received and approved in EUR.
create function pg_temp.ship(p_code text,p_lines jsonb) returns void language plpgsql as $$
declare v_ship uuid;v_t uuid;v_line jsonb;v_receipt jsonb:='[]';v_item uuid;
begin
 v_ship:=public.create_shipment_with_stages(p_code,'import','ad310000-0000-4000-8000-000000000001',null,
  (select id from public.routes where status='active' order by created_at limit 1),pg_temp.cur('EUR'),pg_temp.wh(),auth.uid(),current_date,current_date+14);
 insert into d7 values(p_code,v_ship);
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
 perform public.approve_shipment_cost(public.calculate_shipment_cost(v_ship,pg_temp.cur('EUR')));
end $$;
create function pg_temp.keyed(p_report jsonb,p_key uuid) returns jsonb language sql immutable as $$
 select r from jsonb_array_elements(p_report->'rows') r where r->>'key'=p_key::text $$;
grant execute on all functions in schema pg_temp to authenticated;

select set_config('request.jwt.claim.sub','ad300000-0000-4000-8000-000000000001',true);
set local role authenticated;
-- S1 brings 50 pcs of A in batch N3 at 10 EUR, S2 brings 50 more pcs of the same batch at 20 EUR.
select pg_temp.ship('AD3-S1','[{"product":"ad320000-0000-4000-8000-000000000001","qty":50,"price":10,"batch":"AD3-N3","expiry_days":200}]');
select pg_temp.ship('AD3-S2','[{"product":"ad320000-0000-4000-8000-000000000001","qty":50,"price":20,"batch":"AD3-N3","expiry_days":200}]');
-- All 100 pcs are sold to C1.
do $$
declare v_item uuid;
begin
 insert into d7 values('sale',public.create_customer_order('ad310000-0000-4000-8000-000000000011',null,pg_temp.wh(),current_date+1,pg_temp.cur('KZT'),null));
 v_item:=public.add_customer_order_item(pg_temp.id('sale'),'ad320000-0000-4000-8000-000000000001',100,'piece',11200,0,'Цена по письму клиента');
 perform public.reserve_customer_order_item_fefo(v_item);
 perform public.confirm_customer_order(pg_temp.id('sale'));
 perform public.fulfill_customer_order(pg_temp.id('sale'));
end $$;
reset role;
do $$begin
 assert (select count(*) from public.inventory_batches where batch_number='AD3-N3')=1,'one batch received by two shipments';
 assert (select count(*) from public.inventory_movements m join public.inventory_batches b on b.id=m.batch_id
          where b.batch_number='AD3-N3' and m.movement_type='receipt')=2,'two receipts';
end $$;
select set_config('request.jwt.claim.sub','ad300000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$
declare s jsonb;
begin
 s:=public.profitability_report('shipment',current_date-1,current_date+1);
 -- 100 pcs x 11 200 KZT with 12 % VAT = 1 000 000 KZT without VAT; S1 and S2 received 50 pcs each: 500 000 each.
 -- The batch cost is the weighted average (10 + 20) / 2 = 15 EUR x 500 = 7 500 KZT per piece: 375 000 each.
 assert (pg_temp.keyed(s,pg_temp.id('AD3-S1'))->>'sales_net')::numeric=500000,'S1: half of the revenue';
 assert (pg_temp.keyed(s,pg_temp.id('AD3-S2'))->>'sales_net')::numeric=500000,'S2: the other half, with a row of its own';
 assert (pg_temp.keyed(s,pg_temp.id('AD3-S1'))->>'cost')::numeric=375000 and (pg_temp.keyed(s,pg_temp.id('AD3-S2'))->>'cost')::numeric=375000,
   'each shipment carries half of the weighted cost';
 -- The detailed lines name both shipments with their shares.
 assert (select l->>'shipment' from jsonb_array_elements(public.profitability_lines(current_date-1,current_date+1)) l
          where l->>'batch'='AD3-N3' limit 1)=(select string_agg(shipment_number||' 50.0 %',', ' order by shipment_number)
                                                  from public.shipments where id in (pg_temp.id('AD3-S1'),pg_temp.id('AD3-S2')));
end $$;
reset role;
\echo profitability_two_shipment_batch: a batch of two shipments is shared between them by received pieces
rollback;
