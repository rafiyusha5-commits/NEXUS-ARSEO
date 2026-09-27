-- Phase 2: shipments, the 18-stage RVI process, tasks and notifications.

create table if not exists public.process_templates (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  version integer not null default 1 check (version > 0),
  name jsonb not null,
  shipment_type text check (shipment_type in ('import','export','domestic_transfer')),
  route_id uuid references public.routes(id) on delete set null,
  enforcement_mode text not null default 'advisory' check (enforcement_mode in ('advisory','strict')),
  is_default boolean not null default false,
  status text not null default 'draft' check (status in ('draft','active','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(code, version)
);

create table if not exists public.shipment_stages (
  id uuid primary key default gen_random_uuid(),
  process_template_id uuid not null references public.process_templates(id) on delete cascade,
  code text not null,
  name jsonb not null,
  sequence_order integer not null check (sequence_order > 0),
  requirement text not null check (requirement in ('required','optional','conditional')),
  condition_rules jsonb,
  predecessor_codes text[] not null default '{}',
  parallel_group text,
  scope text not null default 'shipment' check (scope in ('shipment','transport')),
  default_responsible_role text,
  sla_days integer check (sla_days is null or sla_days > 0),
  status_category text not null check (status_category in ('planning','in_production','preparing_transport','in_transit','customs','receiving','sales','closed')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(process_template_id, code),
  unique(process_template_id, sequence_order)
);

create table if not exists public.shipments (
  id uuid primary key default gen_random_uuid(),
  shipment_number text not null unique,
  project_code text,
  type text not null check (type in ('import','export','domestic_transfer')),
  supplier_id uuid references public.counterparties(id) on delete restrict,
  customer_id uuid references public.counterparties(id) on delete restrict,
  route_id uuid not null references public.routes(id) on delete restrict,
  contract_id uuid references public.contracts(id) on delete set null,
  process_template_id uuid not null references public.process_templates(id) on delete restrict,
  status text not null default 'planning' check (status in ('planning','in_production','preparing_transport','in_transit','customs','receiving','sales','closed','on_hold','cancelled')),
  leading_stage_id uuid references public.shipment_stages(id) on delete set null,
  currency_id uuid not null references public.currencies(id) on delete restrict,
  incoterms text,
  destination_warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  responsible_user_id uuid not null references public.profiles(id) on delete restrict,
  planned_ready_date date,
  planned_arrival_date date,
  hold_reason text,
  cancel_reason text,
  is_locked boolean not null default false,
  closed_at timestamptz,
  closed_by uuid references public.profiles(id) on delete set null,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (type <> 'import' or supplier_id is not null),
  check (type <> 'export' or customer_id is not null)
);

create table if not exists public.shipment_transports (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipments(id) on delete cascade,
  sequence_no integer not null check (sequence_no > 0),
  carrier_id uuid references public.carriers(id) on delete set null,
  vehicle_id uuid references public.vehicles(id) on delete set null,
  driver_name text,
  driver_phone text,
  temperature_setpoint text,
  planned_loading_date date,
  actual_loading_date date,
  planned_arrival_date date,
  actual_arrival_date date,
  status text not null default 'planned' check (status in ('planned','loading','in_transit','at_customs','arrived','unloaded','cancelled')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(shipment_id, sequence_no)
);

create table if not exists public.shipment_items (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipments(id) on delete cascade,
  shipment_transport_id uuid references public.shipment_transports(id) on delete set null,
  product_id uuid not null references public.products(id) on delete restrict,
  uom text not null default 'piece' check (uom in ('piece','box','layer','pallet','truck')),
  ordered_quantity numeric(14,3) not null check (ordered_quantity > 0),
  confirmed_quantity numeric(14,3),
  shipped_quantity numeric(14,3),
  received_quantity numeric(14,3),
  unit_price numeric(14,4) check (unit_price is null or unit_price >= 0),
  currency_id uuid references public.currencies(id) on delete set null,
  discrepancy_reason text,
  discrepancy_accepted_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists shipment_items_unique_transport_product
  on public.shipment_items(shipment_id, coalesce(shipment_transport_id, '00000000-0000-0000-0000-000000000000'::uuid), product_id);

create table if not exists public.shipment_stage_runs (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipments(id) on delete cascade,
  stage_id uuid not null references public.shipment_stages(id) on delete restrict,
  shipment_transport_id uuid references public.shipment_transports(id) on delete cascade,
  is_required boolean not null default true,
  status text not null default 'pending' check (status in ('pending','in_progress','blocked','completed','skipped','not_applicable')),
  responsible_user_id uuid references public.profiles(id) on delete set null,
  performed_by_name text,
  due_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  status_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists shipment_stage_runs_unique_scope
  on public.shipment_stage_runs(shipment_id, stage_id, coalesce(shipment_transport_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table if not exists public.shipment_stage_history (
  id uuid primary key default gen_random_uuid(),
  stage_run_id uuid not null references public.shipment_stage_runs(id) on delete restrict,
  shipment_id uuid not null references public.shipments(id) on delete restrict,
  from_status text not null,
  to_status text not null,
  changed_by uuid not null references public.profiles(id) on delete restrict,
  performed_by_name text,
  reason text,
  warnings jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.customs_clearances (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipments(id) on delete cascade,
  shipment_transport_id uuid references public.shipment_transports(id) on delete set null,
  broker_id uuid references public.brokers(id) on delete set null,
  country text not null check (country ~ '^[A-Z]{2}$'),
  declaration_number text,
  status text not null default 'pending' check (status in ('pending','submitted','in_progress','cleared','rejected','on_hold')),
  submitted_at timestamptz,
  cleared_at timestamptz,
  customs_value numeric(14,2),
  duties_amount numeric(14,2),
  fees_amount numeric(14,2),
  currency_id uuid references public.currencies(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.approvals (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  approver_user_id uuid references public.profiles(id) on delete set null,
  approver_role text,
  requested_by uuid not null references public.profiles(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  comment text,
  check (approver_user_id is not null or approver_role is not null)
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  entity_type text,
  entity_id uuid,
  assignee_user_id uuid not null references public.profiles(id) on delete restrict,
  created_by uuid references public.profiles(id) on delete set null,
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  due_at timestamptz,
  status text not null default 'open' check (status in ('open','in_progress','done','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  author_user_id uuid not null references public.profiles(id) on delete restrict,
  body text not null,
  visibility text not null default 'internal' check (visibility in ('internal','shared_with_counterparty')),
  edited_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null check (type in ('deadline','overdue','approval_request','approval_decision','status_change','discrepancy','low_shelf_life','document_uploaded','sync_error','system')),
  title text not null,
  body text,
  entity_type text,
  entity_id uuid,
  is_read boolean not null default false,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications(id) on delete cascade,
  channel text not null check (channel in ('in_app','email','whatsapp')),
  status text not null default 'queued' check (status in ('queued','sent','delivered','failed','skipped')),
  attempted_at timestamptz,
  error_message text,
  created_at timestamptz not null default now()
);

alter table public.routes add column if not exists default_process_template_id uuid references public.process_templates(id) on delete set null;

insert into public.permissions(code,module,action,name,description) values
  ('shipments.change_status','shipments','change_status','Поставки: этапы','Изменение статусов этапов поставки'),
  ('tasks.view','tasks','view','Задачи: просмотр','Просмотр назначенных задач'),
  ('tasks.create','tasks','create','Задачи: создание','Создание задач'),
  ('tasks.update','tasks','update','Задачи: изменение','Изменение задач')
on conflict (code) do nothing;

insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true from public.app_roles r cross join public.permissions p
where (p.module = 'shipments' and (
  r.code in ('administrator','director','executive_director','logistics_director','senior_logistics_manager')
  or (r.code = 'logistics_specialist' and p.action in ('view','create','update','change_status'))
  or (r.code in ('commercial_director','accountant','marketer') and p.action = 'view')
)) or (p.module = 'tasks' and r.code <> 'external_client')
on conflict (role_id,permission_id) do update set granted=excluded.granted;

insert into public.process_templates(code,version,name,shipment_type,enforcement_mode,is_default,status)
values ('import_eu_kz',1,'{"ru":"Импорт из Европы в Казахстан","en":"EU to Kazakhstan import"}','import','advisory',true,'active')
on conflict (code,version) do update set status='active',is_default=true;

with template as (select id from public.process_templates where code='import_eu_kz' and version=1), stages(code,name,seq,req,preds,grp,scope,role,category) as (values
 ('supplier_request','Запрос информации у производителя',1,'required','{}'::text[],null,'shipment','senior_logistics_manager','planning'),
 ('order_draft','Создание заказа',2,'required',array['supplier_request'],null,'shipment','senior_logistics_manager','planning'),
 ('order_approval','Согласование заказа',3,'required',array['order_draft'],null,'shipment','senior_logistics_manager','planning'),
 ('supplier_picking','Сбор товара производителем',4,'required',array['order_approval'],'pre_shipment','shipment','senior_logistics_manager','in_production'),
 ('documents_check','Получение и проверка документов',5,'required',array['order_approval'],'pre_shipment','shipment','senior_logistics_manager','in_production'),
 ('transport_preparation','Подготовка перевозки',6,'required',array['order_approval'],'pre_shipment','shipment','senior_logistics_manager','preparing_transport'),
 ('dispatched','Отгрузка',7,'required',array['supplier_picking','transport_preparation'],null,'transport','logistics_specialist','in_transit'),
 ('in_transit','Перевозка в Казахстан',8,'required',array['dispatched'],null,'transport','logistics_specialist','in_transit'),
 ('broker_processing','Работа с брокером',9,'conditional',array['documents_check'],null,'shipment','logistics_director','customs'),
 ('customs_clearance','Таможенное оформление',10,'conditional',array['broker_processing','in_transit'],null,'transport','logistics_director','customs'),
 ('warehouse_receiving','Приёмка на складе в Актобе',11,'required',array['customs_clearance','in_transit'],null,'transport','logistics_specialist','receiving'),
 ('quantity_check','Проверка фактического количества',12,'required',array['warehouse_receiving'],'receiving','transport','logistics_specialist','receiving'),
 ('batch_registration','Регистрация партий и сроков годности',13,'required',array['warehouse_receiving'],'receiving','transport','logistics_specialist','receiving'),
 ('stickering','Стикеровка',14,'conditional',array['batch_registration'],null,'shipment','senior_logistics_manager','receiving'),
 ('marking','Нанесение кодов маркировки',15,'conditional',array['batch_registration'],null,'shipment','senior_logistics_manager','receiving'),
 ('putaway','Размещение на складе',16,'required',array['batch_registration'],null,'transport','logistics_specialist','receiving'),
 ('sales_or_export','Продажа или подготовка экспорта',17,'required',array['putaway'],null,'shipment','commercial_director','sales'),
 ('closed','Закрытие поставки',18,'required',array['sales_or_export'],null,'shipment','senior_logistics_manager','closed')
)
insert into public.shipment_stages(process_template_id,code,name,sequence_order,requirement,predecessor_codes,parallel_group,scope,default_responsible_role,status_category)
select template.id,stages.code,jsonb_build_object('ru',stages.name),stages.seq,stages.req,stages.preds,stages.grp,stages.scope,stages.role,stages.category from template,stages
on conflict (process_template_id,code) do update set name=excluded.name,sequence_order=excluded.sequence_order,requirement=excluded.requirement,predecessor_codes=excluded.predecessor_codes,parallel_group=excluded.parallel_group,scope=excluded.scope,default_responsible_role=excluded.default_responsible_role,status_category=excluded.status_category,is_active=true;

create or replace function public.create_shipment_with_stages(
  p_project_code text,p_type text,p_supplier_id uuid,p_customer_id uuid,p_route_id uuid,
  p_currency_id uuid,p_warehouse_id uuid,p_responsible_user_id uuid,p_planned_ready_date date default null,p_planned_arrival_date date default null
) returns uuid language plpgsql security invoker set search_path='' as $$
declare v_template uuid; v_shipment uuid; v_number text; v_year text;
begin
  if not (select private.has_permission('shipments.create')) then raise exception 'Недостаточно прав для создания поставки'; end if;
  v_year := to_char(current_date,'YYYY');
  perform pg_advisory_xact_lock(hashtext('nexus_shipment_number_' || v_year));
  select id into v_template from public.process_templates where status='active' and is_default and (shipment_type=p_type or shipment_type is null) order by version desc limit 1;
  if v_template is null then raise exception 'Активный шаблон процесса не найден'; end if;
  select 'NAR-' || v_year || '-' || lpad((count(*)+1)::text,4,'0') into v_number from public.shipments where extract(year from created_at)=extract(year from current_date);
  insert into public.shipments(shipment_number,project_code,type,supplier_id,customer_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,planned_ready_date,planned_arrival_date)
  values(v_number,nullif(trim(p_project_code),''),p_type,p_supplier_id,p_customer_id,p_route_id,v_template,p_currency_id,p_warehouse_id,p_responsible_user_id,p_planned_ready_date,p_planned_arrival_date) returning id into v_shipment;
  insert into public.shipment_stage_runs(shipment_id,stage_id,is_required,status,responsible_user_id,status_reason)
  select v_shipment,s.id,s.requirement='required',case when s.requirement='conditional' then 'not_applicable' else 'pending' end,p_responsible_user_id,
    case when s.requirement='conditional' then 'Будет активирован при выполнении условия' end
  from public.shipment_stages s where s.process_template_id=v_template and s.is_active;
  update public.shipments set leading_stage_id=(select id from public.shipment_stages where process_template_id=v_template and sequence_order=1) where id=v_shipment;
  return v_shipment;
end $$;
grant execute on function public.create_shipment_with_stages(text,text,uuid,uuid,uuid,uuid,uuid,uuid,date,date) to authenticated;

create or replace function public.change_shipment_stage_status(p_run_id uuid,p_status text,p_reason text default null,p_performed_by_name text default null)
returns void language plpgsql security invoker set search_path='' as $$
declare v_old text; v_shipment uuid; v_stage uuid; v_locked boolean;
begin
  if not (select private.has_permission('shipments.change_status')) then raise exception 'Недостаточно прав'; end if;
  if p_status in ('blocked','skipped','not_applicable') and nullif(trim(p_reason),'') is null then raise exception 'Укажите причину'; end if;
  select r.status,r.shipment_id,r.stage_id,s.is_locked into v_old,v_shipment,v_stage,v_locked from public.shipment_stage_runs r join public.shipments s on s.id=r.shipment_id where r.id=p_run_id for update;
  if v_locked then raise exception 'Закрытая поставка недоступна для изменений'; end if;
  update public.shipment_stage_runs set status=p_status,status_reason=nullif(trim(p_reason),''),performed_by_name=nullif(trim(p_performed_by_name),''),started_at=case when p_status='in_progress' then coalesce(started_at,now()) else started_at end,completed_at=case when p_status='completed' then now() else null end,updated_at=now() where id=p_run_id;
  insert into public.shipment_stage_history(stage_run_id,shipment_id,from_status,to_status,changed_by,performed_by_name,reason) values(p_run_id,v_shipment,v_old,p_status,auth.uid(),nullif(trim(p_performed_by_name),''),nullif(trim(p_reason),''));
  update public.shipments sh set
    leading_stage_id=(select r.stage_id from public.shipment_stage_runs r join public.shipment_stages st on st.id=r.stage_id where r.shipment_id=v_shipment and r.is_required and r.status not in ('completed','skipped','not_applicable') order by st.sequence_order limit 1),
    status=coalesce((select st.status_category from public.shipment_stage_runs r join public.shipment_stages st on st.id=r.stage_id where r.shipment_id=v_shipment and r.is_required and r.status not in ('completed','skipped','not_applicable') order by st.sequence_order limit 1),'closed'),updated_at=now()
  where sh.id=v_shipment and sh.status not in ('on_hold','cancelled');
end $$;
grant execute on function public.change_shipment_stage_status(uuid,text,text,text) to authenticated;

do $$ declare t text; begin
  foreach t in array array['process_templates','shipment_stages','shipments','shipment_transports','shipment_items','shipment_stage_runs','shipment_stage_history','customs_clearances','approvals','tasks','comments','notifications','notification_deliveries'] loop
    execute format('alter table public.%I enable row level security',t);
  end loop;
end $$;

grant select,insert,update on public.process_templates,public.shipment_stages,public.shipments,public.shipment_transports,public.shipment_items,public.shipment_stage_runs,public.customs_clearances,public.approvals,public.tasks,public.comments,public.notifications,public.notification_deliveries to authenticated;
grant select,insert on public.shipment_stage_history to authenticated;

create policy "employees view process templates" on public.process_templates for select to authenticated using ((select private.is_employee()));
create policy "settings managers create process templates" on public.process_templates for insert to authenticated with check ((select private.has_permission('roles.manage')));
create policy "settings managers update process templates" on public.process_templates for update to authenticated using ((select private.has_permission('roles.manage')));
create policy "employees view shipment stages" on public.shipment_stages for select to authenticated using ((select private.is_employee()));
create policy "settings managers create shipment stages" on public.shipment_stages for insert to authenticated with check ((select private.has_permission('roles.manage')));
create policy "settings managers update shipment stages" on public.shipment_stages for update to authenticated using ((select private.has_permission('roles.manage')));

create policy "employees view shipments" on public.shipments for select to authenticated using ((select private.has_permission('shipments.view')));
create policy "employees create shipments" on public.shipments for insert to authenticated with check ((select private.has_permission('shipments.create')) and created_by=(select auth.uid()));
create policy "employees update shipments" on public.shipments for update to authenticated using ((select private.has_permission('shipments.update'))) with check ((select private.has_permission('shipments.update')));

create policy "employees view shipment transports" on public.shipment_transports for select to authenticated using ((select private.has_permission('shipments.view')));
create policy "employees create shipment transports" on public.shipment_transports for insert to authenticated with check ((select private.has_permission('shipments.update')));
create policy "employees update shipment transports" on public.shipment_transports for update to authenticated using ((select private.has_permission('shipments.update')));
create policy "employees view shipment items" on public.shipment_items for select to authenticated using ((select private.has_permission('shipments.view')));
create policy "employees create shipment items" on public.shipment_items for insert to authenticated with check ((select private.has_permission('shipments.update')));
create policy "employees update shipment items" on public.shipment_items for update to authenticated using ((select private.has_permission('shipments.update')));
create policy "employees view stage runs" on public.shipment_stage_runs for select to authenticated using ((select private.has_permission('shipments.view')));
create policy "employees create stage runs" on public.shipment_stage_runs for insert to authenticated with check ((select private.has_permission('shipments.create')));
create policy "employees update stage runs" on public.shipment_stage_runs for update to authenticated using ((select private.has_permission('shipments.change_status')));
create policy "employees view stage history" on public.shipment_stage_history for select to authenticated using ((select private.has_permission('shipments.view')));
create policy "employees append stage history" on public.shipment_stage_history for insert to authenticated with check (changed_by=(select auth.uid()) and (select private.has_permission('shipments.change_status')));

create policy "employees view customs" on public.customs_clearances for select to authenticated using ((select private.has_permission('shipments.view')));
create policy "logistics create customs" on public.customs_clearances for insert to authenticated with check ((select private.has_permission('shipments.update')));
create policy "logistics update customs" on public.customs_clearances for update to authenticated using ((select private.has_permission('shipments.update')));
create policy "employees view approvals" on public.approvals for select to authenticated using (requested_by=(select auth.uid()) or approver_user_id=(select auth.uid()) or (select private.has_permission('shipments.approve')));
create policy "employees create approvals" on public.approvals for insert to authenticated with check (requested_by=(select auth.uid()));
create policy "approvers update approvals" on public.approvals for update to authenticated using (approver_user_id=(select auth.uid()) or (select private.has_permission('shipments.approve')));
create policy "users view relevant tasks" on public.tasks for select to authenticated using (assignee_user_id=(select auth.uid()) or created_by=(select auth.uid()) or (select private.has_permission('tasks.view')));
create policy "users create tasks" on public.tasks for insert to authenticated with check ((select private.has_permission('tasks.create')) and created_by=(select auth.uid()));
create policy "users update tasks" on public.tasks for update to authenticated using (assignee_user_id=(select auth.uid()) or (select private.has_permission('tasks.update')));
create policy "employees view comments" on public.comments for select to authenticated using ((select private.is_employee()));
create policy "employees create comments" on public.comments for insert to authenticated with check ((select private.is_employee()) and author_user_id=(select auth.uid()));
create policy "authors update comments" on public.comments for update to authenticated using (author_user_id=(select auth.uid()));
create policy "users view own notifications" on public.notifications for select to authenticated using (recipient_user_id=(select auth.uid()));
create policy "users update own notifications" on public.notifications for update to authenticated using (recipient_user_id=(select auth.uid()));
create policy "users view own notification deliveries" on public.notification_deliveries for select to authenticated using (exists(select 1 from public.notifications n where n.id=notification_id and n.recipient_user_id=(select auth.uid())));

do $$ declare t text; begin
  foreach t in array array['process_templates','shipment_stages','shipments','shipment_transports','shipment_items','shipment_stage_runs','customs_clearances','approvals','tasks','comments'] loop
    execute format('drop trigger if exists audit_%I_changes on public.%I',t,t);
    execute format('create trigger audit_%I_changes after insert or update on public.%I for each row execute function private.write_access_audit()',t,t);
  end loop;
end $$;

comment on table public.shipments is 'ARSEO import, export and domestic transfer shipments';
comment on table public.shipment_stage_history is 'Append-only history of shipment stage transitions';
