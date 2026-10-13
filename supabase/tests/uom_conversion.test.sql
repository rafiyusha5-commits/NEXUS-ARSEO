-- Unit conversion: an order in boxes is reserved from stock received in pieces (and back), through
-- the product packaging (pieces per unit). Exactness, missing packaging, override, guarantee letters and shipping.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('f7000000-0000-4000-8000-000000000001','uom-director@test.local','{"full_name":"UOM Director"}');
insert into public.user_roles(user_id,role_id)
select 'f7000000-0000-4000-8000-000000000001',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id,min_remaining_shelf_life_pct) values
 ('f7100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'UOM Supplier','FI','UOM-SUP',null),
 ('f7100000-0000-4000-8000-000000000002',array['customer'],'UOM Customer','KZ','UOM-CUS',null),
 ('f7100000-0000-4000-8000-000000000003',array['customer'],'UOM Strict Customer','KZ','UOM-CUS-60',60);
insert into public.products(id,internal_sku,name,manufacturer_id,status,shelf_life_days) values
 ('f7200000-0000-4000-8000-000000000001','UOM-001','{"ru":"Товар в коробах по 12"}','f7100000-0000-4000-8000-000000000001','active',400),
 ('f7200000-0000-4000-8000-000000000002','UOM-002','{"ru":"Товар без упаковки"}','f7100000-0000-4000-8000-000000000001','active',400),
 ('f7200000-0000-4000-8000-000000000003','UOM-003','{"ru":"Паллета не кратна коробу"}','f7100000-0000-4000-8000-000000000001','active',400);
-- units_per_parent: pieces in one unit of the level.
insert into public.product_packaging(product_id,uom,units_per_parent) values
 ('f7200000-0000-4000-8000-000000000001','piece',1),
 ('f7200000-0000-4000-8000-000000000001','box',12),
 ('f7200000-0000-4000-8000-000000000001','pallet',60),
 ('f7200000-0000-4000-8000-000000000003','box',12),
 ('f7200000-0000-4000-8000-000000000003','pallet',50);

create temporary table uom_context(warehouse_id uuid,sale_id uuid,item_id uuid,sale2_id uuid,item2_id uuid,letter_id uuid);
grant select,insert,update on uom_context to authenticated;
insert into uom_context(warehouse_id) select id from public.warehouses where status='active' and not is_virtual order by code limit 1;

-- EARLY and LATE are received in pieces (as from the purchase plan), BOXED is kept in boxes.
insert into public.inventory_batches(id,product_id,batch_number,manufacture_date,expiry_date,created_by) values
 ('f7300000-0000-4000-8000-000000000001','f7200000-0000-4000-8000-000000000001','UOM-EARLY',current_date-300,current_date+100,'f7000000-0000-4000-8000-000000000001'),
 ('f7300000-0000-4000-8000-000000000002','f7200000-0000-4000-8000-000000000001','UOM-LATE',current_date-100,current_date+300,'f7000000-0000-4000-8000-000000000001'),
 ('f7300000-0000-4000-8000-000000000003','f7200000-0000-4000-8000-000000000001','UOM-BOXED',current_date-200,current_date+200,'f7000000-0000-4000-8000-000000000001'),
 ('f7300000-0000-4000-8000-000000000004','f7200000-0000-4000-8000-000000000002','UOM-NOPACK',current_date-100,current_date+300,'f7000000-0000-4000-8000-000000000001'),
 ('f7300000-0000-4000-8000-000000000005','f7200000-0000-4000-8000-000000000003','UOM-PALLET50',current_date-100,current_date+200,'f7000000-0000-4000-8000-000000000001'),
 ('f7300000-0000-4000-8000-000000000006','f7200000-0000-4000-8000-000000000003','UOM-LOOSE',current_date-100,current_date+300,'f7000000-0000-4000-8000-000000000001');
insert into public.inventory_balances(id,batch_id,warehouse_id,uom,quantity_on_hand)
select v.id::uuid,v.batch::uuid,c.warehouse_id,v.uom,v.qty from uom_context c cross join (values
 ('f7400000-0000-4000-8000-000000000001','f7300000-0000-4000-8000-000000000001','piece',30),
 ('f7400000-0000-4000-8000-000000000002','f7300000-0000-4000-8000-000000000002','piece',120),
 ('f7400000-0000-4000-8000-000000000003','f7300000-0000-4000-8000-000000000003','box',3),
 ('f7400000-0000-4000-8000-000000000004','f7300000-0000-4000-8000-000000000004','piece',500),
 ('f7400000-0000-4000-8000-000000000005','f7300000-0000-4000-8000-000000000005','pallet',1),
 ('f7400000-0000-4000-8000-000000000006','f7300000-0000-4000-8000-000000000006','piece',30)) v(id,batch,uom,qty);

-- Conversion helper.
do $$ begin
 assert private.convert_uom('f7200000-0000-4000-8000-000000000001',24,'piece','box')=2,'24 pieces are 2 boxes of 12';
 assert private.convert_uom('f7200000-0000-4000-8000-000000000001',1,'pallet','box')=5,'a pallet of 60 holds 5 boxes of 12';
 assert private.convert_uom('f7200000-0000-4000-8000-000000000001',30,'piece','box')=2.5,'30 pieces are exactly 2.5 boxes';
 assert private.convert_uom('f7200000-0000-4000-8000-000000000001',5,'piece','box') is null,'5 pieces are not an exact amount of boxes';
 assert private.convert_uom('f7200000-0000-4000-8000-000000000002',1,'box','piece') is null,'missing packaging gives no conversion';
 assert private.convert_uom('f7200000-0000-4000-8000-000000000002',7,'box','box')=7,'same unit needs no packaging';
 assert private.uom_pieces('f7200000-0000-4000-8000-000000000002','piece')=1,'a piece is always one piece';
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub','f7000000-0000-4000-8000-000000000001',false);

-- 1. An order of 3 boxes needs 36 pieces. By expiry: EARLY (30 pieces) covers 2.5 boxes, then BOXED gives
--    the remaining half box in its own unit, because half a box is an exact amount.
update uom_context set sale_id=public.create_customer_order('f7100000-0000-4000-8000-000000000002',null,warehouse_id,current_date+10,
 (select id from public.currencies where code='KZT'),null);
update uom_context set item_id=public.add_customer_order_item(sale_id,'f7200000-0000-4000-8000-000000000001',3,'box',null,null);
select public.reserve_customer_order_item_fefo(item_id) from uom_context;
do $$ declare c uom_context%rowtype;
begin
 select * into c from uom_context;
 assert (select quantity_reserved=30 from public.inventory_balances where id='f7400000-0000-4000-8000-000000000001'),'all 30 pieces of the earliest batch';
 assert (select quantity=30 and uom='piece' and sale_quantity=2.5 from public.inventory_reservations
         where sale_item_id=c.item_id and status='active' and batch_id='f7300000-0000-4000-8000-000000000001'),'30 pieces cover 2.5 boxes';
 assert (select quantity=0.5 and uom='box' and sale_quantity=0.5 from public.inventory_reservations
         where sale_item_id=c.item_id and status='active' and batch_id='f7300000-0000-4000-8000-000000000003'),'the rest comes from the next batch by expiry, in its own unit';
 assert (select sum(sale_quantity)=3 from public.inventory_reservations where sale_item_id=c.item_id and status='active'),'the order line is covered in boxes';
 assert (select status='reserved' from public.sales where id=c.sale_id),'a fully covered order is reserved';
end $$;
select public.cancel_customer_order(sale_id,'Тест пересчёта') from uom_context;
do $$ begin
 assert (select coalesce(sum(quantity_reserved),0)=0 from public.inventory_balances where id::text like 'f7400000-%'),'cancellation releases stock in its own units';
end $$;

-- 2. An order of 25 pieces: BOXED is not first now (EARLY is), so make EARLY unavailable to reach the boxes.
reset role;
update public.inventory_batches set status='blocked',status_reason='тест' where id='f7300000-0000-4000-8000-000000000001';
set role authenticated;
select set_config('request.jwt.claim.sub','f7000000-0000-4000-8000-000000000001',false);
update uom_context set sale_id=public.create_customer_order('f7100000-0000-4000-8000-000000000002',null,warehouse_id,current_date+10,
 (select id from public.currencies where code='KZT'),null);
update uom_context set item_id=public.add_customer_order_item(sale_id,'f7200000-0000-4000-8000-000000000001',25,'piece',null,null);
select public.reserve_customer_order_item_fefo(item_id) from uom_context;
do $$ declare c uom_context%rowtype;
begin
 select * into c from uom_context;
 -- 25 pieces are 2.0833 boxes: two whole boxes (24 pieces), never a box split into an inexact remainder.
 assert (select quantity=2 and uom='box' and sale_quantity=24 from public.inventory_reservations
         where sale_item_id=c.item_id and status='active' and batch_id='f7300000-0000-4000-8000-000000000003'),'whole boxes when the box does not divide';
 assert (select quantity=1 and uom='piece' and sale_quantity=1 from public.inventory_reservations
         where sale_item_id=c.item_id and status='active' and batch_id='f7300000-0000-4000-8000-000000000002'),'the last piece from the next batch';
 assert (select status='reserved' from public.sales where id=c.sale_id),'the order in pieces is fully reserved';
end $$;

-- 2b. A pallet of 50 does not hold a whole number of boxes of 12: an order of 5 boxes takes 4 whole
--     boxes from the pallet (0.96 pallet = 48 pieces) and the fifth box from the loose pieces.
update uom_context set sale2_id=public.create_customer_order('f7100000-0000-4000-8000-000000000002',null,warehouse_id,current_date+10,
 (select id from public.currencies where code='KZT'),null);
update uom_context set item2_id=public.add_customer_order_item(sale2_id,'f7200000-0000-4000-8000-000000000003',5,'box',null,null);
select public.reserve_customer_order_item_fefo(item2_id) from uom_context;
do $$ declare c uom_context%rowtype;
begin
 select * into c from uom_context;
 assert (select quantity=0.96 and uom='pallet' and sale_quantity=4 from public.inventory_reservations
         where sale_item_id=c.item2_id and status='active' and batch_id='f7300000-0000-4000-8000-000000000005'),'whole boxes from a pallet that is not a multiple of the box';
 assert (select quantity=12 and uom='piece' and sale_quantity=1 from public.inventory_reservations
         where sale_item_id=c.item2_id and status='active' and batch_id='f7300000-0000-4000-8000-000000000006'),'the fifth box from loose pieces';
 assert (select status='reserved' from public.sales where id=c.sale2_id),'5 boxes are reserved';
end $$;
select public.cancel_customer_order(sale2_id,'Тест пересчёта') from uom_context;

-- 3. Override: the order of 25 pieces cannot come from boxes of 12 alone, but 24 pieces can.
do $$ begin
 begin
  perform public.reserve_customer_order_item_override((select item_id from uom_context),'f7400000-0000-4000-8000-000000000003','Клиент просит целые коробки');
  raise exception 'inexact override accepted' using errcode='P0099';
 exception when sqlstate 'P0099' then raise; when others then
  assert position('не пересчитывается в единицы остатка' in sqlerrm)>0,'inexact override is explained: '||sqlerrm;
 end;
 -- The failed override changed nothing.
 assert (select count(*)=2 from public.inventory_reservations where sale_item_id=(select item_id from uom_context) and status='active'),'failed override keeps the reservation';
end $$;
select public.cancel_customer_order(sale_id,'Тест пересчёта') from uom_context;

update uom_context set sale_id=public.create_customer_order('f7100000-0000-4000-8000-000000000002',null,warehouse_id,current_date+10,
 (select id from public.currencies where code='KZT'),null);
update uom_context set item_id=public.add_customer_order_item(sale_id,'f7200000-0000-4000-8000-000000000001',2,'box',null,null);
select public.reserve_customer_order_item_override(item_id,'f7400000-0000-4000-8000-000000000002','Свежая партия по просьбе клиента') from uom_context;
do $$ declare c uom_context%rowtype;
begin
 select * into c from uom_context;
 assert (select quantity=24 and uom='piece' and sale_quantity=2 and is_fefo_override from public.inventory_reservations
         where sale_item_id=c.item_id and status='active'),'override of 2 boxes holds 24 pieces of the chosen batch';
 assert (select quantity_reserved=24 from public.inventory_balances where id='f7400000-0000-4000-8000-000000000002'),'24 pieces are reserved on the balance';
 assert (select status='reserved' from public.sales where id=c.sale_id),'the overridden order is reserved';
end $$;
-- Choosing the same balance again counts the stock this line already holds there.
select public.reserve_customer_order_item_override(item_id,'f7400000-0000-4000-8000-000000000002','Повторный выбор') from uom_context;
do $$ begin
 assert (select quantity_reserved=24 from public.inventory_balances where id='f7400000-0000-4000-8000-000000000002'),'repeated override does not double the reservation';
end $$;
select public.cancel_customer_order(sale_id,'Тест пересчёта') from uom_context;

-- 4. Not enough stock: the whole reservation is rolled back and the shortage is given in the order unit.
update uom_context set sale_id=public.create_customer_order('f7100000-0000-4000-8000-000000000002',null,warehouse_id,current_date+10,
 (select id from public.currencies where code='KZT'),null);
update uom_context set item_id=public.add_customer_order_item(sale_id,'f7200000-0000-4000-8000-000000000001',14,'box',null,null);
do $$ begin
 begin
  perform public.reserve_customer_order_item_fefo((select item_id from uom_context));
  raise exception 'over-reservation accepted' using errcode='P0099';
 exception when sqlstate 'P0099' then raise; when others then
  -- Available: LATE 120 pieces = 10 boxes and BOXED 3 boxes: 13 of 14 boxes.
  assert position('не хватает 1 кор.' in sqlerrm)>0,'shortage in boxes: '||sqlerrm;
 end;
 assert not exists(select 1 from public.inventory_reservations where sale_item_id=(select item_id from uom_context)),'nothing is reserved';
 assert (select coalesce(sum(quantity_reserved),0)=0 from public.inventory_balances where id::text like 'f7400000-%'),'balances are untouched';
end $$;
select public.cancel_customer_order(sale_id,'Тест пересчёта') from uom_context;

-- 5. Missing packaging: the message names the unit to fill in; stock in the same unit still works.
update uom_context set sale_id=public.create_customer_order('f7100000-0000-4000-8000-000000000002',null,warehouse_id,current_date+10,
 (select id from public.currencies where code='KZT'),null);
update uom_context set item_id=public.add_customer_order_item(sale_id,'f7200000-0000-4000-8000-000000000002',2,'box',null,null);
do $$ begin
 begin
  perform public.reserve_customer_order_item_fefo((select item_id from uom_context));
  raise exception 'reserved without packaging' using errcode='P0099';
 exception when sqlstate 'P0099' then raise; when others then
  assert position('не задана упаковка товара: кор.' in sqlerrm)>0,'missing box packaging is named: '||sqlerrm;
 end;
end $$;
update uom_context set item2_id=public.add_customer_order_item(sale_id,'f7200000-0000-4000-8000-000000000002',40,'piece',null,null);
select public.reserve_customer_order_item_fefo(item2_id) from uom_context;
do $$ begin
 assert (select quantity=40 and uom='piece' and sale_quantity=40 from public.inventory_reservations where sale_item_id=(select item2_id from uom_context) and status='active'),'same unit needs no packaging';
 assert (select status='draft' from public.sales where id=(select sale_id from uom_context)),'an order with an unreserved line stays draft';
end $$;
select public.cancel_customer_order(sale_id,'Тест пересчёта') from uom_context;

-- 6. Guarantee letter: in the unit of the order, one row per line and batch.
reset role;
update public.inventory_batches set status='available',status_reason=null where id='f7300000-0000-4000-8000-000000000001';
set role authenticated;
select set_config('request.jwt.claim.sub','f7000000-0000-4000-8000-000000000001',false);
update uom_context set sale2_id=public.create_customer_order('f7100000-0000-4000-8000-000000000003',null,warehouse_id,current_date+10,
 (select id from public.currencies where code='KZT'),null);
update uom_context set item2_id=public.add_customer_order_item(sale2_id,'f7200000-0000-4000-8000-000000000001',2,'box',null,null);
select public.reserve_customer_order_item_fefo(item2_id) from uom_context;
update uom_context set letter_id=public.create_sale_guarantee_letter(sale2_id,'Тест пересчёта');
do $$ declare c uom_context%rowtype;
begin
 select * into c from uom_context;
 -- EARLY (30 pieces, about 22% of its life left) covers all 2 boxes = 24 pieces.
 assert (select quantity=24 and uom='piece' and sale_quantity=2 from public.inventory_reservations where sale_item_id=c.item2_id and status='active'),'24 pieces of the earliest batch';
 assert (select count(*)=1 and min(quantity)=2 from public.guarantee_letter_items where guarantee_letter_id=c.letter_id),'the letter states 2 boxes, the unit of the order';
 begin
  perform public.confirm_customer_order(c.sale2_id);
  raise exception 'confirmed without approved letter' using errcode='P0099';
 exception when sqlstate 'P0099' then raise; when others then assert position('гарантийное письмо' in sqlerrm)>0,'letter is still required'; end;
end $$;
select public.change_sale_guarantee_status(letter_id,'approved') from uom_context;
select public.confirm_customer_order(sale2_id) from uom_context;
do $$ begin
 assert (select status='confirmed' from public.sales where id=(select sale2_id from uom_context)),'approved letter in order units allows confirmation';
end $$;

-- 6b. Shipping (202609276600): the order in boxes is issued from the stock in pieces it was reserved from,
--     and the approved letter in boxes covers that batch.
select public.fulfill_customer_order(sale2_id) from uom_context;
do $$ declare c uom_context%rowtype;
begin
 select * into c from uom_context;
 assert (select status='shipped' and shipped_at is not null from public.sales where id=c.sale2_id),'shipped';
 assert (select bool_and(status='fulfilled') from public.inventory_reservations where sale_item_id=c.item2_id),'reservations fulfilled';
 assert (select count(*)=1 and min(quantity)=24 and min(uom)='piece' from public.inventory_movements
         where sale_item_id=c.item2_id and movement_type='issue'),'issued as 24 pieces, the unit of the stock';
 assert (select quantity_on_hand=6 and quantity_reserved=0 from public.inventory_balances where id='f7400000-0000-4000-8000-000000000001'),
  '30 - 24 pieces stay, nothing reserved';
end $$;
-- A repeated call returns the same order without a second issue.
select public.fulfill_customer_order(sale2_id) from uom_context;
do $$ begin
 assert (select count(*)=1 from public.inventory_movements where sale_item_id=(select item2_id from uom_context) and movement_type='issue'),'no second issue';
end $$;

reset role;

-- 7. Any other writer that gives only the stock amount gets the order amount filled in, and the unit
--    of a reservation always matches its balance.
do $$ declare v_item uuid; v_sale uuid;
begin
 insert into public.sales(sale_number,customer_id,warehouse_id,planned_shipment_date,created_by)
 select 'SO-UOM-TRIGGER','f7100000-0000-4000-8000-000000000002',warehouse_id,current_date+5,'f7000000-0000-4000-8000-000000000001' from uom_context
 returning id into v_sale;
 insert into public.sale_items(sale_id,product_id,quantity,uom) values(v_sale,'f7200000-0000-4000-8000-000000000001',1,'box') returning id into v_item;
 insert into public.inventory_reservations(sale_item_id,inventory_balance_id,batch_id,quantity,remaining_shelf_life_pct,created_by)
 values(v_item,'f7400000-0000-4000-8000-000000000002','f7300000-0000-4000-8000-000000000002',12,90,'f7000000-0000-4000-8000-000000000001');
 assert (select uom='piece' and sale_quantity=1 from public.inventory_reservations where sale_item_id=v_item),'12 pieces are filled in as 1 box';
 begin
  insert into public.inventory_reservations(sale_item_id,inventory_balance_id,batch_id,quantity,uom,sale_quantity,remaining_shelf_life_pct,created_by)
  values(v_item,'f7400000-0000-4000-8000-000000000003','f7300000-0000-4000-8000-000000000003',1,'piece',1,90,'f7000000-0000-4000-8000-000000000001');
  raise exception 'unit mismatch accepted' using errcode='P0099';
 exception when sqlstate 'P0099' then raise; when others then assert position('единицей остатка' in sqlerrm)>0,'unit must match the balance'; end;
 begin
  insert into public.inventory_reservations(sale_item_id,inventory_balance_id,batch_id,quantity,remaining_shelf_life_pct,created_by)
  values(v_item,'f7400000-0000-4000-8000-000000000001','f7300000-0000-4000-8000-000000000001',5,90,'f7000000-0000-4000-8000-000000000001');
  raise exception 'inexact reservation accepted' using errcode='P0099';
 exception when sqlstate 'P0099' then raise; when others then assert position('без остатка' in sqlerrm)>0,'inexact amount is refused'; end;
 begin
  insert into public.inventory_reservations(sale_item_id,inventory_balance_id,batch_id,quantity,uom,sale_quantity,remaining_shelf_life_pct,created_by)
  values(v_item,'f7400000-0000-4000-8000-000000000001','f7300000-0000-4000-8000-000000000001',12,'piece',2,90,'f7000000-0000-4000-8000-000000000001');
  raise exception 'inconsistent order amount accepted' using errcode='P0099';
 exception when sqlstate 'P0099' then raise; when others then assert position('не соответствует упаковке' in sqlerrm)>0,'order amount must match the packaging'; end;
 -- Changing the stock amount alone recalculates the order amount.
 update public.inventory_reservations set quantity=24 where sale_item_id=v_item;
 assert (select sale_quantity=2 from public.inventory_reservations where sale_item_id=v_item),'24 pieces are recalculated as 2 boxes';
end $$;

rollback;
