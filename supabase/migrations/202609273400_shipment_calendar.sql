-- Phase 9A: one operational calendar for shipment plans, facts, stages, tasks
-- and additional shipment milestones.

insert into public.permissions(code,module,action,name,description) values
 ('calendar.view','calendar','view','Календарь: просмотр','Просмотр сроков поставок, этапов и задач'),
 ('calendar.manage','calendar','manage','Календарь: контрольные точки','Создание и закрытие дополнительных контрольных точек поставок')
on conflict(code) do update set module=excluded.module,action=excluded.action,name=excluded.name,description=excluded.description;

insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true
from public.app_roles r
join public.permissions p on p.code in ('calendar.view','calendar.manage')
where
 (p.code='calendar.view' and r.code in ('director','executive_director','commercial_director','logistics_director','senior_logistics_manager','logistics_specialist','accountant','marketer','administrator'))
 or
 (p.code='calendar.manage' and r.code in ('director','executive_director','logistics_director','senior_logistics_manager','logistics_specialist','administrator'))
on conflict(role_id,permission_id) do update set granted=true;

create table if not exists public.shipment_milestones (
 id uuid primary key default gen_random_uuid(),
 shipment_id uuid not null references public.shipments(id) on delete cascade,
 title text not null check (char_length(trim(title)) between 2 and 160),
 kind text not null default 'other' check (kind in ('document','customs','payment','inspection','other')),
 planned_at timestamptz not null,
 actual_at timestamptz,
 notes text check (notes is null or char_length(notes)<=1000),
 is_cancelled boolean not null default false,
 responsible_user_id uuid references public.profiles(id) on delete set null,
 created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
-- Older draft of this migration briefly restricted imported actual dates.
alter table public.shipment_milestones drop constraint if exists shipment_milestones_check;
create index if not exists shipment_milestones_period_idx on public.shipment_milestones(planned_at) where not is_cancelled;
create index if not exists shipment_milestones_shipment_idx on public.shipment_milestones(shipment_id,planned_at);

alter table public.shipment_milestones enable row level security;
grant select on public.shipment_milestones to authenticated;
revoke insert,update,delete on public.shipment_milestones from authenticated;
revoke all on public.shipment_milestones from anon;

drop policy if exists "calendar users view milestones" on public.shipment_milestones;
create policy "calendar users view milestones" on public.shipment_milestones for select to authenticated using (
 (select private.has_permission('calendar.view')) and (select private.has_permission('shipments.view'))
);
drop policy if exists "calendar managers create milestones" on public.shipment_milestones;
create policy "calendar managers create milestones" on public.shipment_milestones for insert to authenticated with check (
 (select private.has_permission('calendar.manage')) and (select private.has_permission('shipments.update')) and created_by=(select auth.uid())
);
drop policy if exists "calendar managers update milestones" on public.shipment_milestones;
create policy "calendar managers update milestones" on public.shipment_milestones for update to authenticated using (
 (select private.has_permission('calendar.manage')) and (select private.has_permission('shipments.update'))
) with check (
 (select private.has_permission('calendar.manage')) and (select private.has_permission('shipments.update'))
);

create or replace function public.create_shipment_milestone(
 p_shipment_id uuid,p_title text,p_kind text,p_planned_at timestamptz,
 p_responsible_user_id uuid default null,p_notes text default null
) returns uuid
language plpgsql security definer set search_path=''
as $$
declare v_id uuid; v_locked boolean;
begin
 if not ((select private.has_permission('calendar.manage')) and (select private.has_permission('shipments.update'))) then
  raise exception 'Недостаточно прав для создания контрольной точки';
 end if;
 if nullif(trim(p_title),'') is null or char_length(trim(p_title))>160 then raise exception 'Укажите название до 160 символов'; end if;
 if p_kind not in ('document','customs','payment','inspection','other') then raise exception 'Некорректный тип контрольной точки'; end if;
 if p_planned_at is null then raise exception 'Укажите плановую дату'; end if;
 select is_locked into v_locked from public.shipments where id=p_shipment_id;
 if not found then raise exception 'Поставка не найдена'; end if;
 if v_locked then raise exception 'Закрытая поставка недоступна для изменений'; end if;
 if p_responsible_user_id is not null and not exists(select 1 from public.profiles where id=p_responsible_user_id and is_active and user_type='employee') then
  raise exception 'Ответственный сотрудник не найден';
 end if;
 insert into public.shipment_milestones(shipment_id,title,kind,planned_at,responsible_user_id,notes,created_by)
 values(p_shipment_id,trim(p_title),p_kind,p_planned_at,p_responsible_user_id,nullif(trim(p_notes),''),auth.uid()) returning id into v_id;
 return v_id;
end $$;

create or replace function public.complete_shipment_milestone(p_milestone_id uuid,p_actual_at timestamptz default now())
returns void language plpgsql security definer set search_path=''
as $$
begin
 if not ((select private.has_permission('calendar.manage')) and (select private.has_permission('shipments.update'))) then
  raise exception 'Недостаточно прав для закрытия контрольной точки';
 end if;
 update public.shipment_milestones m set actual_at=coalesce(p_actual_at,now()),is_cancelled=false,updated_at=now()
 where m.id=p_milestone_id and exists(select 1 from public.shipments s where s.id=m.shipment_id and not s.is_locked);
 if not found then raise exception 'Контрольная точка не найдена или поставка закрыта'; end if;
end $$;

create or replace function public.cancel_shipment_milestone(p_milestone_id uuid)
returns void language plpgsql security definer set search_path=''
as $$
begin
 if not ((select private.has_permission('calendar.manage')) and (select private.has_permission('shipments.update'))) then
  raise exception 'Недостаточно прав для отмены контрольной точки';
 end if;
 update public.shipment_milestones m set is_cancelled=true,updated_at=now()
 where m.id=p_milestone_id and m.actual_at is null and exists(select 1 from public.shipments s where s.id=m.shipment_id and not s.is_locked);
 if not found then raise exception 'Контрольная точка не найдена, уже выполнена или поставка закрыта'; end if;
end $$;

create or replace function public.my_shipment_calendar(p_from timestamptz,p_to timestamptz)
returns table(
 source_type text,source_id uuid,shipment_id uuid,event_kind text,title text,
 planned_at timestamptz,actual_at timestamptz,event_status text,
 supplier_id uuid,customer_id uuid,responsible_user_id uuid,
 supplier_name text,customer_name text,route_name text,shipment_number text,
 responsible_name text,details text
)
language plpgsql security invoker set search_path=''
as $$
begin
 if not ((select private.has_permission('calendar.view')) and (select private.has_permission('shipments.view'))) then
  raise exception 'Нет доступа к календарю поставок';
 end if;
 if p_from is null or p_to is null or p_to<=p_from or p_to-p_from>interval '370 days' then
  raise exception 'Период календаря должен быть от 1 до 370 дней';
 end if;
 return query
 with base as (
  select s.id,s.shipment_number,s.supplier_id,s.customer_id,s.responsible_user_id,s.route_id,s.status,
         coalesce(sp.short_name,sp.legal_name) supplier_name,
         coalesce(cp.short_name,cp.legal_name) customer_name,
         coalesce(r.name->>'ru',r.name->>'en','—') route_name,
         rp.full_name responsible_name
  from public.shipments s
  left join public.counterparties sp on sp.id=s.supplier_id
  left join public.counterparties cp on cp.id=s.customer_id
  join public.routes r on r.id=s.route_id
  join public.profiles rp on rp.id=s.responsible_user_id
 ), events as (
  select 'shipment'::text source_type,b.id source_id,b.id shipment_id,'ready'::text event_kind,'Готовность товара'::text title,
         s.planned_ready_date::timestamp at time zone 'Asia/Qyzylorda' planned_at,
         (select sr.completed_at from public.shipment_stage_runs sr join public.shipment_stages st on st.id=sr.stage_id where sr.shipment_id=b.id and st.code='supplier_picking' and sr.shipment_transport_id is null limit 1) actual_at,
         b.supplier_id,b.customer_id,b.responsible_user_id,b.supplier_name,b.customer_name,b.route_name,b.shipment_number,b.responsible_name,null::text details,
         b.status='cancelled' cancelled
  from base b join public.shipments s on s.id=b.id where s.planned_ready_date is not null
  union all
  select 'shipment',b.id,b.id,'arrival','Прибытие поставки',s.planned_arrival_date::timestamp at time zone 'Asia/Qyzylorda',
         (select max(t.actual_arrival_date)::timestamp at time zone 'Asia/Qyzylorda' from public.shipment_transports t where t.shipment_id=b.id and t.status<>'cancelled'),
         b.supplier_id,b.customer_id,b.responsible_user_id,b.supplier_name,b.customer_name,b.route_name,b.shipment_number,b.responsible_name,null,b.status='cancelled'
  from base b join public.shipments s on s.id=b.id where s.planned_arrival_date is not null
  union all
  select 'transport',t.id,b.id,'loading','Погрузка · автомобиль №'||t.sequence_no,t.planned_loading_date::timestamp at time zone 'Asia/Qyzylorda',
         t.actual_loading_date::timestamp at time zone 'Asia/Qyzylorda',b.supplier_id,b.customer_id,b.responsible_user_id,b.supplier_name,b.customer_name,b.route_name,b.shipment_number,b.responsible_name,t.notes,t.status='cancelled'
  from public.shipment_transports t join base b on b.id=t.shipment_id where t.planned_loading_date is not null
  union all
  select 'transport',t.id,b.id,'arrival','Прибытие · автомобиль №'||t.sequence_no,t.planned_arrival_date::timestamp at time zone 'Asia/Qyzylorda',
         t.actual_arrival_date::timestamp at time zone 'Asia/Qyzylorda',b.supplier_id,b.customer_id,b.responsible_user_id,b.supplier_name,b.customer_name,b.route_name,b.shipment_number,b.responsible_name,t.notes,t.status='cancelled'
  from public.shipment_transports t join base b on b.id=t.shipment_id where t.planned_arrival_date is not null
  union all
  select 'stage',sr.id,b.id,'stage',coalesce(st.name->>'ru',st.name->>'en','Этап поставки'),sr.due_at,sr.completed_at,
         b.supplier_id,b.customer_id,coalesce(sr.responsible_user_id,b.responsible_user_id),b.supplier_name,b.customer_name,b.route_name,b.shipment_number,coalesce(rp.full_name,b.responsible_name),sr.status_reason,
         sr.status in ('skipped','not_applicable')
  from public.shipment_stage_runs sr join public.shipment_stages st on st.id=sr.stage_id join base b on b.id=sr.shipment_id left join public.profiles rp on rp.id=sr.responsible_user_id where sr.due_at is not null
  union all
  select 'task',t.id,b.id,'task',t.title,t.due_at,case when t.status='done' then t.completed_at end,b.supplier_id,b.customer_id,t.assignee_user_id,b.supplier_name,b.customer_name,b.route_name,b.shipment_number,rp.full_name,t.description,
         t.status='cancelled'
  from public.tasks t join base b on b.id=t.shipment_id join public.profiles rp on rp.id=t.assignee_user_id
  where t.due_at is not null and (select private.has_permission('tasks.view'))
  union all
  select 'milestone',m.id,b.id,m.kind,m.title,m.planned_at,m.actual_at,b.supplier_id,b.customer_id,coalesce(m.responsible_user_id,b.responsible_user_id),b.supplier_name,b.customer_name,b.route_name,b.shipment_number,coalesce(rp.full_name,b.responsible_name),m.notes,m.is_cancelled
  from public.shipment_milestones m join base b on b.id=m.shipment_id left join public.profiles rp on rp.id=m.responsible_user_id
 )
 select e.source_type,e.source_id,e.shipment_id,e.event_kind,e.title,e.planned_at,e.actual_at,
        case when e.cancelled then 'cancelled'
             when e.actual_at is not null and e.actual_at>e.planned_at then 'completed_late'
             when e.actual_at is not null then 'completed'
             when e.planned_at<now() then 'overdue'
             when e.planned_at<=now()+interval '3 days' then 'due_soon'
             else 'scheduled' end,
        e.supplier_id,e.customer_id,e.responsible_user_id,e.supplier_name,e.customer_name,e.route_name,e.shipment_number,e.responsible_name,e.details
 from events e
 where e.planned_at>=p_from and e.planned_at<p_to
 order by e.planned_at,e.shipment_number,e.title;
end $$;

revoke all on function public.create_shipment_milestone(uuid,text,text,timestamptz,uuid,text) from public,anon,service_role;
revoke all on function public.complete_shipment_milestone(uuid,timestamptz) from public,anon,service_role;
revoke all on function public.cancel_shipment_milestone(uuid) from public,anon,service_role;
revoke all on function public.my_shipment_calendar(timestamptz,timestamptz) from public,anon,service_role;
grant execute on function public.create_shipment_milestone(uuid,text,text,timestamptz,uuid,text) to authenticated;
grant execute on function public.complete_shipment_milestone(uuid,timestamptz) to authenticated;
grant execute on function public.cancel_shipment_milestone(uuid) to authenticated;
grant execute on function public.my_shipment_calendar(timestamptz,timestamptz) to authenticated;

drop trigger if exists audit_shipment_milestones_changes on public.shipment_milestones;
create trigger audit_shipment_milestones_changes after insert or update on public.shipment_milestones for each row execute function private.write_access_audit();

comment on table public.shipment_milestones is 'Additional shipment deadlines not represented by shipment, transport, stage or task dates';
comment on function public.my_shipment_calendar(timestamptz,timestamptz) is 'RLS-preserving unified shipment calendar with plan/fact status';
