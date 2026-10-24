\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('a8240000-0000-4000-8000-000000000001','assistant-receiving@test.local','{"full_name":"Receipt operator"}'),
 ('a8240000-0000-4000-8000-000000000002','assistant-receiving-other@test.local','{"full_name":"Other operator"}');
insert into public.user_roles(user_id,role_id) select u,r.id from unnest(array[
 'a8240000-0000-4000-8000-000000000001'::uuid,'a8240000-0000-4000-8000-000000000002'::uuid]) u
 cross join public.app_roles r where r.code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id)
values('a8241000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Assistant receipt supplier','FI','AR-24');
insert into public.products(id,internal_sku,name,manufacturer_id,status)
values('a8242000-0000-4000-8000-000000000001','AR-24','{"ru":"Товар приёмки"}','a8241000-0000-4000-8000-000000000001','active');
create temporary table ar_context(shipment uuid,transport uuid,item uuid,payload jsonb,token uuid);
grant all on ar_context to authenticated;
set role authenticated;
select set_config('request.jwt.claim.sub','a8240000-0000-4000-8000-000000000001',true);
insert into ar_context(shipment) select public.create_shipment_with_stages('AR-24','import','a8241000-0000-4000-8000-000000000001',null,
 (select id from public.routes where status='active' order by created_at limit 1),
 (select id from public.currencies where code='EUR'),
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),
 'a8240000-0000-4000-8000-000000000001',current_date,current_date+14);
select public.add_shipment_transport(shipment) from ar_context;
update ar_context c set transport=(select id from public.shipment_transports where shipment_id=c.shipment and sequence_no=1),
 item=public.create_shipment_item(c.shipment,'a8242000-0000-4000-8000-000000000001','piece',100,1,(select id from public.currencies where code='EUR'));
select public.allocate_shipment_item(item,transport,100) from ar_context;
select public.change_shipment_transport_status(transport,'arrived') from ar_context;
update ar_context set payload=jsonb_build_object('transport_id',transport,'location_id',null,'lines',jsonb_build_array(jsonb_build_object(
 'item_id',item,'accepted_quantity','92','damaged_quantity','3','batch_number','AR-24-LOT',
 'manufacture_date',null,'expiry_date',(current_date+335)::text,'discrepancy_reason','5 missing and 3 damaged')));
do $$declare c ar_context; v jsonb; bad jsonb; begin
 select * into c from ar_context;
 foreach bad in array array[c.payload||'{"ignore":true}',jsonb_set(c.payload,'{lines,0,accepted_quantity}','"-1"'),
  jsonb_set(c.payload,'{lines,0,discrepancy_reason}','null'),jsonb_set(c.payload,'{lines}','[]')] loop
  begin
   perform public.prepare_assistant_operation(gen_random_uuid(),'shipment_transport_receive',bad);
   raise exception 'accepted invalid payload' using errcode='P0099';
  exception when sqlstate 'P0099' then raise; when others then assert sqlerrm='ASSISTANT_RECEIVING_INVALID';end;
 end loop;
 perform public.prepare_assistant_operation('a8243000-0000-4000-8000-000000000001','shipment_transport_receive',c.payload);
 v:=public.review_assistant_operation('a8243000-0000-4000-8000-000000000001');
 assert v->>'status'='awaiting_confirmation';
 assert not (v->'preview') ? 'state_stamp';
 assert v#>>'{preview,lines,0,basis}'='ordered';
 assert (v#>>'{preview,lines,0,shortage}')::numeric=5;
 assert not exists(select 1 from public.shipment_transport_receipts where shipment_transport_id=c.transport);
 assert not exists(select 1 from public.inventory_movements where shipment_transport_id=c.transport);
 update ar_context set token=(v->>'review_token')::uuid;
end $$;
-- Another employee cannot use the author/token pair.
reset role;
do $$declare permission text; begin
 foreach permission in array array['agent.use','shipments.view','inventory.receive','inventory.view','products.view','warehouses.view'] loop
  insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
   select 'a8240000-0000-4000-8000-000000000001',id,'deny','Synthetic receiving deny','a8240000-0000-4000-8000-000000000001' from public.permissions where code=permission;
  begin perform public.confirm_assistant_operation('a8243000-0000-4000-8000-000000000001',(select token from ar_context));
   raise exception 'permission bypass' using errcode='P0099';
  exception when sqlstate 'P0099' then raise; when insufficient_privilege then null;end;
  begin perform public.review_assistant_operation('a8243000-0000-4000-8000-000000000001');
   raise exception 'review permission bypass' using errcode='P0099';
  exception when sqlstate 'P0099' then raise; when insufficient_privilege then null;end;
  delete from public.user_permission_overrides where user_id='a8240000-0000-4000-8000-000000000001' and permission_id=(select id from public.permissions where code=permission);
 end loop;
end $$;
-- Failure after inventory writes must roll back the whole native transaction.
savepoint forced_failure;
create function pg_temp.ar_failure() returns trigger language plpgsql as $$begin raise exception 'synthetic private failure';end $$;
create trigger ar_fail before insert on public.shipment_transport_receipt_items for each row execute function pg_temp.ar_failure();
set local role authenticated;
do $$begin
 begin perform public.confirm_assistant_operation('a8243000-0000-4000-8000-000000000001',(select token from ar_context));
  raise exception 'forced failure ignored' using errcode='P0099';
 exception when sqlstate 'P0099' then raise; when others then assert sqlerrm='ASSISTANT_RECEIVING_REFUSED';end;
 assert not exists(select 1 from public.shipment_transport_receipts where shipment_transport_id=(select transport from ar_context));
 assert not exists(select 1 from public.inventory_movements where shipment_transport_id=(select transport from ar_context));
 assert not exists(select 1 from public.inventory_batches where source_shipment_transport_id=(select transport from ar_context));
end $$;
rollback to forced_failure;
set role authenticated;
select set_config('request.jwt.claim.sub','a8240000-0000-4000-8000-000000000002',true);
do $$begin
 begin perform public.confirm_assistant_operation('a8243000-0000-4000-8000-000000000001',(select token from ar_context));
 raise exception 'foreign author accepted' using errcode='P0099';
 exception when sqlstate 'P0099' then raise; when others then assert sqlerrm='ASSISTANT_OPERATION_DENIED';end;
end $$;
select set_config('request.jwt.claim.sub','a8240000-0000-4000-8000-000000000001',true);
-- Changed source requires a fresh review, without a stock side effect.
reset role;
update public.shipment_items set shipped_quantity=99 where id=(select item from ar_context);
set role authenticated;
do $$begin
 begin perform public.confirm_assistant_operation('a8243000-0000-4000-8000-000000000001',(select token from ar_context));
 raise exception 'stale receipt accepted' using errcode='P0099';
 exception when sqlstate 'P0099' then raise; when others then assert sqlerrm='ASSISTANT_OPERATION_STALE';end;
 assert not exists(select 1 from public.shipment_transport_receipts where shipment_transport_id=(select transport from ar_context));
end $$;
-- New explicit review of current source. Never reuse the stale token.
select public.prepare_assistant_operation('a8243000-0000-4000-8000-000000000002','shipment_transport_receive',payload) from ar_context;
update ar_context set token=(public.review_assistant_operation('a8243000-0000-4000-8000-000000000002')->>'review_token')::uuid;
do $$declare v jsonb; again jsonb; c ar_context; begin
 select * into c from ar_context;
 v:=public.confirm_assistant_operation('a8243000-0000-4000-8000-000000000002',c.token);
 again:=public.confirm_assistant_operation('a8243000-0000-4000-8000-000000000002',c.token);
 assert v=again and v->>'status'='completed';
 assert (select count(*) from public.shipment_transport_receipts where shipment_transport_id=c.transport)=1;
 assert (select accepted_quantity=92 and damaged_quantity=3 and shortage_quantity=4 from public.shipment_transport_receipt_items where receipt_id=(v->>'result_id')::uuid);
 assert (select sum(quantity) from public.inventory_movements where shipment_transport_id=c.transport and movement_type='receipt')=92;
 assert (select status from public.shipment_transports where id=c.transport)='unloaded';
end $$;
reset role;
rollback;
