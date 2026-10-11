\set ON_ERROR_STOP 1
begin;

-- Do not depend on pre-existing seed suppliers; imports require a manufacturer.
insert into public.counterparties(id,roles,legal_name,country) values
 ('e3000000-0000-4000-8000-000000000011',array['supplier','manufacturer'],'Calendar Test Factory','FI');

insert into auth.users(id,email,raw_user_meta_data) values
 ('e3000000-0000-4000-8000-000000000001','calendar-director@test.local','{"full_name":"Calendar Director"}'),
 ('e3000000-0000-4000-8000-000000000002','calendar-marketer@test.local','{"full_name":"Calendar Marketer"}');
insert into public.user_roles(user_id,role_id)
select fixture.user_id,role.id from (values
 ('e3000000-0000-4000-8000-000000000001'::uuid,'director'),
 ('e3000000-0000-4000-8000-000000000002'::uuid,'marketer')
) fixture(user_id,role_code) join public.app_roles role on role.code=fixture.role_code;

create temporary table calendar_context(shipment_id uuid,milestone_id uuid);
grant select,insert,update on calendar_context to authenticated;
set role authenticated;
select set_config('request.jwt.claim.sub','e3000000-0000-4000-8000-000000000001',false);
insert into calendar_context(shipment_id)
select public.create_shipment_with_stages(
 'CAL-TEST','import','e3000000-0000-4000-8000-000000000011',null,
 (select id from public.routes where status='active' order by created_at limit 1),(select id from public.currencies where code='EUR'),
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),
 'e3000000-0000-4000-8000-000000000001',current_date-2,current_date+7
);
update calendar_context set milestone_id=public.create_shipment_milestone(shipment_id,'Подать тестовый документ','document',now()-interval '1 day','e3000000-0000-4000-8000-000000000001','Проверка календаря');
do $$declare c calendar_context%rowtype;begin
 select * into c from calendar_context;
 assert exists(select 1 from public.my_shipment_calendar(now()-interval '10 days',now()+interval '20 days') where source_type='milestone' and source_id=c.milestone_id and event_status='overdue'),'an overdue custom milestone is in the unified calendar';
 assert exists(select 1 from public.my_shipment_calendar(now()-interval '10 days',now()+interval '20 days') where shipment_id=c.shipment_id and event_kind='ready'),'shipment ready date is projected';
 begin
  update public.shipment_milestones set title='Direct update must fail' where id=c.milestone_id;
  raise exception 'direct milestone update bypassed the controlled RPC' using errcode='P0099';
 exception when sqlstate 'P0099' then raise;when others then assert sqlerrm~'permission denied',sqlerrm;end;
 perform public.complete_shipment_milestone(c.milestone_id,now());
 assert exists(select 1 from public.my_shipment_calendar(now()-interval '10 days',now()+interval '20 days') where source_id=c.milestone_id and event_status='completed_late'),'plan/fact delay is calculated';
end$$;
reset role;

set role authenticated;
select set_config('request.jwt.claim.sub','e3000000-0000-4000-8000-000000000002',false);
do $$declare shipment uuid=(select shipment_id from calendar_context);begin
 assert private.has_permission('calendar.view'),'marketer can view the calendar';
 assert not private.has_permission('calendar.manage'),'marketer cannot manage milestones';
 begin perform public.create_shipment_milestone(shipment,'Недоступно','other',now()+interval '1 day',null,null);raise exception 'marketer unexpectedly created milestone' using errcode='P0099';
 exception when sqlstate 'P0099' then raise;when others then assert sqlerrm~'Недостаточно прав',sqlerrm;end;
end$$;
reset role;

insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'e3000000-0000-4000-8000-000000000001',id,'deny','calendar test','e3000000-0000-4000-8000-000000000001' from public.permissions where code='calendar.view';
set role authenticated;
select set_config('request.jwt.claim.sub','e3000000-0000-4000-8000-000000000001',false);
do $$begin
 begin perform public.my_shipment_calendar(now()-interval '1 day',now()+interval '1 day');raise exception 'personal deny did not close calendar' using errcode='P0099';
 exception when sqlstate 'P0099' then raise;when others then assert sqlerrm~'Нет доступа',sqlerrm;end;
end$$;
reset role;

rollback;
\echo 'shipment_calendar: all checks passed'
