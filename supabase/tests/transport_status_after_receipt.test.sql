-- Audit finding Н7: the receipt fixes a truck's status. A received truck stays "unloaded" (202609278100), only
-- receiving sets "unloaded" (202609278200), and before the receipt the status can be corrected in either direction.
-- supabase/tests/before/202609278200_transport_status_after_receipt.sql shows both defects before the fix.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('c7a00000-0000-4000-8000-000000000001','transport-director@test.local','{"full_name":"Transport Director"}');
insert into public.user_roles(user_id,role_id) select 'c7a00000-0000-4000-8000-000000000001',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id)
values('c7a10000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Transport supplier','FI','TRS-FI');
insert into public.products(id,internal_sku,name,manufacturer_id,status)
values
 ('c7a20000-0000-4000-8000-000000000001','TRS-001','{"ru":"Товар машины"}','c7a10000-0000-4000-8000-000000000001','active'),
 ('c7a20000-0000-4000-8000-000000000002','TRS-002','{"ru":"Товар второй машины"}','c7a10000-0000-4000-8000-000000000001','active');
create temporary table ts(shipment_id uuid,t1 uuid,t2 uuid,t3 uuid,i1 uuid,i2 uuid);
grant select,insert,update on ts to authenticated;

create function pg_temp.expect_failure(p_sql text,p_expected text) returns void language plpgsql as $$
begin
 execute p_sql;
 raise exception 'expected a failure: %',p_sql using errcode='P0099';
exception when sqlstate 'P0099' then raise;
 when others then
  if position(p_expected in sqlerrm)=0 and sqlstate<>p_expected then raise exception 'unexpected error for %: % (%)',p_sql,sqlerrm,sqlstate;end if;
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub','c7a00000-0000-4000-8000-000000000001',false);
insert into ts(shipment_id) select public.create_shipment_with_stages('TRS','import','c7a10000-0000-4000-8000-000000000001',null,
 (select id from public.routes where status='active' order by created_at limit 1),(select id from public.currencies where code='EUR'),
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),'c7a00000-0000-4000-8000-000000000001',current_date,current_date+14);
select public.add_shipment_transport(shipment_id) from ts;
select public.add_shipment_transport(shipment_id) from ts;
select public.add_shipment_transport(shipment_id) from ts;
update ts set t1=(select id from public.shipment_transports where shipment_id=ts.shipment_id and sequence_no=1),
              t2=(select id from public.shipment_transports where shipment_id=ts.shipment_id and sequence_no=2),
              t3=(select id from public.shipment_transports where shipment_id=ts.shipment_id and sequence_no=3),
              i1=public.create_shipment_item(shipment_id,'c7a20000-0000-4000-8000-000000000001','piece',10,1,(select id from public.currencies where code='EUR')),
              i2=public.create_shipment_item(shipment_id,'c7a20000-0000-4000-8000-000000000002','piece',5,1,(select id from public.currencies where code='EUR'));
select public.allocate_shipment_item(i1,t1,10) from ts;
select public.allocate_shipment_item(i2,t2,5) from ts;
select public.change_shipment_transport_status(t1,'arrived') from ts;
select public.receive_shipment_transport(t1,null,jsonb_build_array(jsonb_build_object('item_id',i1,'accepted_quantity',10,
 'batch_number','TRS-LOT','expiry_date',(current_date+300)::text)),'Receiver') from ts;

-- 1. The received truck keeps its status (the rule of 202609278100, kept by this function).
select pg_temp.expect_failure(format('select public.change_shipment_transport_status(%L,%L)',t1,s),'Автомобиль уже принят на склад')
from ts cross join unnest(array['planned','loading','in_transit','at_customs','arrived','cancelled'])s;
-- 2. Only receiving sets "unloaded"; before the receipt the status is corrected freely.
set role authenticated;
select set_config('request.jwt.claim.sub','c7a00000-0000-4000-8000-000000000001',false);
select pg_temp.expect_failure(format('select public.change_shipment_transport_status(%L,%L)',t2,'unloaded'),'Статус «Разгружен» ставит приёмка') from ts;
select public.change_shipment_transport_status(t2,'in_transit') from ts;
select public.change_shipment_transport_status(t2,'planned') from ts;
select public.change_shipment_transport_status(t2,'arrived') from ts;
select public.receive_shipment_transport(t2,null,jsonb_build_array(jsonb_build_object('item_id',i2,'accepted_quantity',5,
 'batch_number','TRS-LOT-2','expiry_date',(current_date+300)::text)),'Receiver') from ts;
reset role;
do $$begin
 assert (select status='unloaded' from public.shipment_transports where id=(select t2 from ts)),'receiving sets unloaded';
end$$;

-- 3. A truck marked "unloaded" earlier without a receipt can still be put back and received.
update public.shipment_transports set status='unloaded' where id=(select t3 from ts);
set role authenticated;
select set_config('request.jwt.claim.sub','c7a00000-0000-4000-8000-000000000001',false);
select public.change_shipment_transport_status(t3,'unloaded') from ts;
select public.change_shipment_transport_status(t3,'arrived') from ts;
select public.change_shipment_transport_status(t3,'cancelled') from ts;
reset role;
do $$begin
 assert (select status='cancelled' from public.shipment_transports where id=(select t3 from ts)),'a truck without a receipt can still be cancelled';
 assert not has_function_privilege('anon','public.change_shipment_transport_status(uuid,text)','execute'),'anonymous callers are refused';
end$$;

rollback;
