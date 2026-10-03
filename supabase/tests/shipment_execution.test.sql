-- Shipment execution: atomic allocation, transport progress and operational state.

\set ON_ERROR_STOP 1

create schema if not exists tests;
grant usage on schema tests to authenticated;
create or replace function tests.act_as(p_user uuid) returns void
language sql as $$ select set_config('request.jwt.claim.sub',p_user::text,false) $$;
grant execute on function tests.act_as(uuid) to authenticated;

insert into auth.users(id,email,raw_user_meta_data) values
  ('d7000000-0000-4000-8000-000000000001','shipment-director@test.local','{"full_name":"Shipment Director"}'),
  ('d7000000-0000-4000-8000-000000000002','shipment-accountant@test.local','{"full_name":"Shipment Accountant"}');

insert into public.user_roles(user_id,role_id)
select fixture.user_id,role.id
from (values
  ('d7000000-0000-4000-8000-000000000001'::uuid,'director'),
  ('d7000000-0000-4000-8000-000000000002'::uuid,'accountant')
) fixture(user_id,role_code)
join public.app_roles role on role.code=fixture.role_code;

insert into public.counterparties(id,roles,legal_name,country,tax_id)
values('d8000000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Shipment Test Factory','FI','SHIP-TEST-FI');
insert into public.products(id,internal_sku,name,manufacturer_id,status)
values('d9000000-0000-4000-8000-000000000001','SHIP-TEST-001','{"ru":"Тестовый товар поставки"}',
       'd8000000-0000-4000-8000-000000000001','active');

create table tests.shipment_execution_context(
  shipment_id uuid,
  item_id uuid,
  transport_one uuid,
  transport_two uuid
);
grant select,insert,update on tests.shipment_execution_context to authenticated;

set role authenticated;
select tests.act_as('d7000000-0000-4000-8000-000000000001');
insert into tests.shipment_execution_context(shipment_id)
select public.create_shipment_with_stages(
  'SHIP-TEST','import','d8000000-0000-4000-8000-000000000001',null,
  (select id from public.routes where status='active' order by created_at limit 1),
  (select id from public.currencies where code='EUR'),
  (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),
  'd7000000-0000-4000-8000-000000000001',current_date,current_date+14
);

do $$
declare v_shipment uuid;
begin
  select shipment_id into v_shipment from tests.shipment_execution_context;
  assert (
    select count(*) = 2
    from public.shipment_stage_runs run
    join public.shipment_stages stage on stage.id = run.stage_id
    where run.shipment_id = v_shipment
      and stage.code in ('broker_processing','customs_clearance')
      and run.is_required
      and run.status = 'pending'
  ), 'import shipment activates mandatory broker and customs stages';
end $$;

-- Vehicles are added through the RPC: direct writes to shipment_transports are closed
-- by 202609272300_database_security_hardening.sql.
select public.add_shipment_transport(shipment_id) from tests.shipment_execution_context;
select public.add_shipment_transport(shipment_id) from tests.shipment_execution_context;
update tests.shipment_execution_context c set
  item_id=public.create_shipment_item(c.shipment_id,'d9000000-0000-4000-8000-000000000001','piece',100,2.5,
       (select id from public.currencies where code='EUR')),
  transport_one=(select t.id from public.shipment_transports t where t.shipment_id=c.shipment_id and t.sequence_no=1),
  transport_two=(select t.id from public.shipment_transports t where t.shipment_id=c.shipment_id and t.sequence_no=2);
reset role;

set role authenticated;
select tests.act_as('d7000000-0000-4000-8000-000000000001');
do $$
declare context tests.shipment_execution_context%rowtype;
begin
  select * into context from tests.shipment_execution_context;
  perform public.allocate_shipment_item(context.item_id,context.transport_one,60);
  assert (select sum(ordered_quantity) from public.shipment_items where shipment_id=context.shipment_id)=100,
    'partial allocation preserves total quantity';
  assert (select ordered_quantity from public.shipment_items where shipment_id=context.shipment_id and shipment_transport_id=context.transport_one)=60,
    'first transport receives allocated quantity';

  select id into context.item_id from public.shipment_items
  where shipment_id=context.shipment_id and shipment_transport_id is null;
  perform public.allocate_shipment_item(context.item_id,context.transport_two,40);
  assert not exists(select 1 from public.shipment_items where shipment_id=context.shipment_id and shipment_transport_id is null),
    'all goods are assigned after the second allocation';

  select id into context.item_id from public.shipment_items
  where shipment_id=context.shipment_id and shipment_transport_id=context.transport_one;
  perform public.allocate_shipment_item(context.item_id,context.transport_two,10);
  assert (select ordered_quantity from public.shipment_items where shipment_id=context.shipment_id and shipment_transport_id=context.transport_one)=50,
    'source allocation is reduced';
  assert (select ordered_quantity from public.shipment_items where shipment_id=context.shipment_id and shipment_transport_id=context.transport_two)=50,
    'existing target allocation is merged';

  perform public.change_shipment_transport_status(context.transport_one,'in_transit');
  assert (select status='in_transit' and actual_loading_date is not null from public.shipment_transports where id=context.transport_one),
    'transport progress records the actual loading date';

  perform public.change_shipment_operational_state(context.shipment_id,'hold','Ожидание документов');
  assert (select status='on_hold' and hold_reason='Ожидание документов' from public.shipments where id=context.shipment_id),
    'shipment is held with a reason';
  perform public.change_shipment_operational_state(context.shipment_id,'resume');
  assert (select status='planning' and hold_reason is null from public.shipments where id=context.shipment_id),
    'shipment resumes from its leading stage';
  perform public.change_shipment_operational_state(context.shipment_id,'cancel','Тестовая отмена');
  assert (select status='cancelled' and cancel_reason='Тестовая отмена' from public.shipments where id=context.shipment_id),
    'shipment is cancelled with a reason';

  begin
    perform public.update_shipment_item(context.item_id,25,2.5);
    raise exception 'cancelled shipment unexpectedly changed' using errcode='P0099';
  exception
    when sqlstate 'P0099' then raise;
    when others then
      assert sqlerrm ~ 'недоступна для изменений',format('unexpected protection error: %s',sqlerrm);
  end;
end $$;

select tests.act_as('d7000000-0000-4000-8000-000000000002');
do $$
declare context tests.shipment_execution_context%rowtype;
begin
  select * into context from tests.shipment_execution_context;
  begin
    perform public.change_shipment_operational_state(context.shipment_id,'hold','Нет прав');
    raise exception 'accountant unexpectedly changed shipment' using errcode='P0099';
  exception
    when sqlstate 'P0099' then raise;
    when others then assert sqlerrm ~ 'Недостаточно прав',format('unexpected permission error: %s',sqlerrm);
  end;
end $$;
reset role;

\echo 'shipment_execution: all checks passed'
