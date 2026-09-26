create extension if not exists pgcrypto;
create schema if not exists private;

create table public.app_roles (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  is_system boolean not null default true,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  module text not null,
  action text not null,
  name text not null,
  description text,
  unique (module, action)
);

create table public.role_permissions (
  role_id uuid not null references public.app_roles(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  granted boolean not null default true,
  primary key (role_id, permission_id)
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  job_title text,
  locale text not null default 'ru' check (locale in ('ru', 'kk', 'en')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_roles (
  user_id uuid not null references public.profiles(id) on delete cascade,
  role_id uuid not null references public.app_roles(id) on delete restrict,
  assigned_by uuid references public.profiles(id) on delete set null,
  assigned_at timestamptz not null default now(),
  primary key (user_id, role_id)
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id text,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_log_actor_created_idx on public.audit_log(actor_user_id, created_at desc);
create index audit_log_entity_idx on public.audit_log(entity_type, entity_id, created_at desc);

insert into public.app_roles (code, name) values
  ('director', 'Директор'),
  ('executive_director', 'Исполнительный директор'),
  ('commercial_director', 'Коммерческий директор'),
  ('logistics_director', 'Директор по логистике'),
  ('senior_logistics_manager', 'Старший менеджер по логистике'),
  ('logistics_specialist', 'Специалист по логистике'),
  ('accountant', 'Бухгалтер'),
  ('marketer', 'Маркетолог'),
  ('administrator', 'Администратор системы')
on conflict (code) do update set name = excluded.name;

insert into public.permissions (code, module, action, name) values
  ('users.view', 'users', 'view', 'Просмотр сотрудников'),
  ('users.manage', 'users', 'manage', 'Управление сотрудниками'),
  ('roles.manage', 'roles', 'manage', 'Управление ролями и правами'),
  ('shipments.view', 'shipments', 'view', 'Просмотр поставок'),
  ('shipments.create', 'shipments', 'create', 'Создание поставок'),
  ('shipments.update', 'shipments', 'update', 'Изменение поставок'),
  ('shipments.approve', 'shipments', 'approve', 'Согласование поставок'),
  ('documents.view', 'documents', 'view', 'Просмотр документов'),
  ('documents.manage', 'documents', 'manage', 'Загрузка и изменение документов'),
  ('finance.view', 'finance', 'view', 'Просмотр финансов'),
  ('finance.manage', 'finance', 'manage', 'Изменение финансовых данных'),
  ('audit.view', 'audit', 'view', 'Просмотр журнала действий')
on conflict (code) do update set name = excluded.name;

insert into public.role_permissions (role_id, permission_id)
select role.id, permission.id
from public.app_roles role
cross join public.permissions permission
where role.code = 'administrator'
on conflict (role_id, permission_id) do update set granted = true;

create or replace function private.has_role(required_role text)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.app_roles ar on ar.id = ur.role_id
    join public.profiles p on p.id = ur.user_id
    where ur.user_id = (select auth.uid())
      and ar.code = required_role
      and ar.is_enabled
      and p.is_active
  );
$$;

revoke execute on function private.has_role(text) from public;
grant usage on schema private to authenticated;
grant execute on function private.has_role(text) to authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), new.email, 'Новый сотрудник'));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

alter table public.app_roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.audit_log enable row level security;

revoke all on public.app_roles, public.permissions, public.role_permissions, public.profiles, public.user_roles, public.audit_log from anon;
grant select on public.app_roles, public.permissions, public.role_permissions, public.profiles, public.user_roles to authenticated;
grant insert, update, delete on public.app_roles, public.role_permissions, public.user_roles to authenticated;
grant update on public.profiles to authenticated;
grant insert on public.audit_log to authenticated;
grant select on public.audit_log to authenticated;
grant usage, select on sequence public.audit_log_id_seq to authenticated;

create policy "authenticated users view active roles" on public.app_roles
  for select to authenticated using (is_enabled);
create policy "authenticated users view permissions" on public.permissions
  for select to authenticated using (true);
create policy "authenticated users view role permissions" on public.role_permissions
  for select to authenticated using (true);
create policy "authenticated users view profiles" on public.profiles
  for select to authenticated using (is_active);
create policy "administrators create roles" on public.app_roles
  for insert to authenticated with check ((select private.has_role('administrator')));
create policy "administrators update roles" on public.app_roles
  for update to authenticated
  using ((select private.has_role('administrator')))
  with check ((select private.has_role('administrator')));
create policy "administrators archive roles" on public.app_roles
  for delete to authenticated using ((select private.has_role('administrator')));
create policy "administrators grant permissions" on public.role_permissions
  for insert to authenticated with check ((select private.has_role('administrator')));
create policy "administrators update permissions" on public.role_permissions
  for update to authenticated
  using ((select private.has_role('administrator')))
  with check ((select private.has_role('administrator')));
create policy "administrators revoke permissions" on public.role_permissions
  for delete to authenticated using ((select private.has_role('administrator')));
create policy "administrators update profiles" on public.profiles
  for update to authenticated
  using ((select private.has_role('administrator')))
  with check ((select private.has_role('administrator')));
create policy "users view own roles or administrators view all" on public.user_roles
  for select to authenticated
  using (user_id = (select auth.uid()) or (select private.has_role('administrator')));
create policy "administrators assign roles" on public.user_roles
  for insert to authenticated with check ((select private.has_role('administrator')));
create policy "administrators update role assignments" on public.user_roles
  for update to authenticated
  using ((select private.has_role('administrator')))
  with check ((select private.has_role('administrator')));
create policy "administrators remove role assignments" on public.user_roles
  for delete to authenticated using ((select private.has_role('administrator')));
create policy "users append their own audit events" on public.audit_log
  for insert to authenticated
  with check (actor_user_id = (select auth.uid()));
create policy "leaders view audit events" on public.audit_log
  for select to authenticated
  using (
    actor_user_id = (select auth.uid())
    or (select private.has_role('administrator'))
    or (select private.has_role('director'))
  );

comment on table public.profiles is 'ARSEO employee profile linked one-to-one with Supabase Auth';
comment on table public.audit_log is 'Immutable application audit trail; updates and deletes are intentionally not granted';
