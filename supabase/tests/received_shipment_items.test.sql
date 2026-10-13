-- A received shipment item stays as received (202609277700): it cannot be moved to another truck, nothing is
-- moved into a received truck, its ordered quantity is kept (the price may change), and it cannot be deleted.
-- Items not received yet are still distributed, changed and deleted as before.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('d7000000-0000-4000-8000-000000000002','received-director@test.local','{"full_name":"Received Director"}');
insert into public.user_roles(user_id,role_id) select 'd7000000-0000-4000-8000-000000000002',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id)
values('d7100000-0000-4000-8000-000000000002',array['manufacturer','supplier'],'Received supplier','FI','RCV2-FI');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('d7200000-0000-4000-8000-000000000002','RCV2-001','{"ru":"Принятый товар"}','d7100000-0000-4000-8000-000000000002','active'),
 ('d7200000-0000-4000-8000-000000000003','RCV2-002','{"ru":"Товар второго автомобиля"}','d7100000-0000-4000-8000-000000000002','active');

create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql; exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm; end if;
  return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on function pg_temp.fails(text,text) to authenticated;
create temporary table rc(shipment_id uuid,t1 uuid,t2 uuid,t3 uuid,received uuid,waiting uuid,loose uuid);
grant select,insert,update on rc to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub','d7000000-0000-4000-8000-000000000002',false);
insert into rc(shipment_id) select public.create_shipment_with_stages('RCV2','import','d7100000-0000-4000-8000-000000000002',null,
 (select id from public.routes where status='active' order by created_at limit 1),(select id from public.currencies where code='EUR'),
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),'d7000000-0000-4000-8000-000000000002',current_date,current_date+14);
select public.add_shipment_transport(shipment_id) from rc;
select public.add_shipment_transport(shipment_id) from rc;
select public.add_shipment_transport(shipment_id) from rc;
update rc set t1=(select id from public.shipment_transports where shipment_id=rc.shipment_id and sequence_no=1),
              t2=(select id from public.shipment_transports where shipment_id=rc.shipment_id and sequence_no=2),
              t3=(select id from public.shipment_transports where shipment_id=rc.shipment_id and sequence_no=3),
              received=public.create_shipment_item(shipment_id,'d7200000-0000-4000-8000-000000000002','piece',10,1,(select id from public.currencies where code='EUR')),
              waiting=public.create_shipment_item(shipment_id,'d7200000-0000-4000-8000-000000000003','piece',6,2,(select id from public.currencies where code='EUR'));
select public.allocate_shipment_item(received,t1,10) from rc;
select public.allocate_shipment_item(waiting,t2,6) from rc;
select public.change_shipment_transport_status(t1,'arrived') from rc;
select public.receive_shipment_transport(t1,null,jsonb_build_array(jsonb_build_object('item_id',received,'accepted_quantity',10,
 'batch_number','RCV2-LOT','expiry_date',(current_date+300)::text)),'Receiver') from rc;

-- ---------- the received item stays where it was received ----------
select pg_temp.fails($$select public.allocate_shipment_item((select received from rc),(select t2 from rc),10)$$,'уже принята на склад: перенести');
select pg_temp.fails($$select public.allocate_shipment_item((select received from rc),(select t2 from rc),4)$$,'уже принята на склад: перенести');
select pg_temp.fails($$select public.allocate_shipment_item((select received from rc),null,10)$$,'уже принята на склад: перенести');
-- ---------- nothing goes into a received truck ----------
select pg_temp.fails($$select public.allocate_shipment_item((select waiting from rc),(select t1 from rc),6)$$,'Автомобиль уже принят');
select pg_temp.fails($$select public.allocate_shipment_item((select waiting from rc),(select t1 from rc),2)$$,'Автомобиль уже принят');
-- ---------- the quantity of a received item is kept, its price may change; it is not deleted ----------
select pg_temp.fails($$select public.update_shipment_item((select received from rc),3,1)$$,'менять количество нельзя, только цену');
select public.update_shipment_item(received,10,1.25) from rc;
select pg_temp.fails($$select public.delete_shipment_item((select received from rc))$$,'удалить её нельзя');

reset role;
do $$ declare c rc%rowtype; begin
 select * into c from rc;
 assert (select shipment_transport_id=c.t1 and ordered_quantity=10 and received_quantity=10 and unit_price=1.25 from public.shipment_items where id=c.received),
  'the received item stays in truck 1 with its quantity; only the price changed';
 assert (select sum(b.quantity_on_hand) from public.inventory_balances b join public.inventory_batches x on x.id=b.batch_id where x.batch_number='RCV2-LOT')=10,
  'stock received once';
 assert (select count(*) from public.inventory_movements where shipment_item_id=c.received and movement_type='receipt')=1,'one receipt';
 assert not exists(select 1 from public.shipment_items where shipment_transport_id=c.t1 and id<>c.received),'nothing was added to the received truck';
end $$;

-- ---------- items not received yet behave as before ----------
set role authenticated;
select set_config('request.jwt.claim.sub','d7000000-0000-4000-8000-000000000002',false);
update rc set loose=public.allocate_shipment_item(waiting,t3,2);
do $$ declare c rc%rowtype; begin
 select * into c from rc;
 assert (select ordered_quantity=4 and shipment_transport_id=c.t2 from public.shipment_items where id=c.waiting),'4 stay in truck 2';
 assert (select ordered_quantity=2 and shipment_transport_id=c.t3 from public.shipment_items where id=c.loose),'2 move to truck 3';
end $$;
select public.update_shipment_item(waiting,5,2) from rc;
select public.delete_shipment_item(loose) from rc;
reset role;
do $$ declare c rc%rowtype; begin
 select * into c from rc;
 assert (select ordered_quantity=5 from public.shipment_items where id=c.waiting),'the quantity of an item not received changes';
 assert not exists(select 1 from public.shipment_items where id=c.loose),'an item not received is deleted';
end $$;

rollback;
\echo 'received_shipment_items: all checks passed'
