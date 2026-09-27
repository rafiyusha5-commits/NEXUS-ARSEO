-- Phase 0: profiles, role permissions, personal overrides and access audit.

alter table public.profiles
  add column if not exists user_type text not null default 'employee',
  add column if not exists email text,
  add column if not exists phone text,
  add column if not exists whatsapp_phone text,
  add column if not exists notification_preferences jsonb not null
    default '{"in_app": true, "email": true, "whatsapp": false}'::jsonb,
  add column if not exists deactivated_at timestamptz,
  add column if not exists deactivated_by uuid references public.profiles(id) on delete set null;

alter table public.app_roles
  add column if not exists audience text not null default 'internal';

alter table public.role_permissions
  add column if not exists scope text[] not null default '{}';

alter table public.user_roles
  add column if not exists expires_at timestamptz;

update public.profiles profile
set email = auth_user.email
from auth.users auth_user
where auth_user.id = profile.id
  and profile.email is null;

create unique index if not exists profiles_email_unique
  on public.profiles(lower(email)) where email is not null;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), new.email, 'Новый сотрудник'),
    new.email
  );
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_user_type_check'
  ) then
    alter table public.profiles
      add constraint profiles_user_type_check
      check (user_type in ('employee', 'external'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'app_roles_audience_check'
  ) then
    alter table public.app_roles
      add constraint app_roles_audience_check
      check (audience in ('internal', 'external'));
  end if;
end;
$$;

create table public.user_permission_overrides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  effect text not null check (effect in ('allow', 'deny')),
  scope text[] not null default '{}',
  reason text not null,
  granted_by uuid not null references public.profiles(id) on delete restrict,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at is null or expires_at > granted_at),
  check ((revoked_at is null and revoked_by is null) or (revoked_at is not null and revoked_by is not null))
);

create unique index user_permission_overrides_active_unique
  on public.user_permission_overrides(user_id, permission_id)
  where revoked_at is null;
create index user_permission_overrides_user_idx
  on public.user_permission_overrides(user_id, granted_at desc);

create or replace function private.is_employee()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.is_active
      and p.user_type = 'employee'
  );
$$;

create or replace function private.has_permission(required_permission text)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select
    (select private.is_employee())
    and not exists (
      select 1
      from public.user_permission_overrides override_rule
      join public.permissions permission on permission.id = override_rule.permission_id
      where override_rule.user_id = (select auth.uid())
        and permission.code = required_permission
        and override_rule.effect = 'deny'
        and override_rule.revoked_at is null
        and (override_rule.expires_at is null or override_rule.expires_at > now())
    )
    and (
      exists (
        select 1
        from public.user_permission_overrides override_rule
        join public.permissions permission on permission.id = override_rule.permission_id
        where override_rule.user_id = (select auth.uid())
          and permission.code = required_permission
          and override_rule.effect = 'allow'
          and override_rule.revoked_at is null
          and (override_rule.expires_at is null or override_rule.expires_at > now())
      )
      or exists (
        select 1
        from public.user_roles user_role
        join public.app_roles role on role.id = user_role.role_id
        join public.role_permissions role_permission on role_permission.role_id = role.id
        join public.permissions permission on permission.id = role_permission.permission_id
        where user_role.user_id = (select auth.uid())
          and role.is_enabled
          and role_permission.granted
          and permission.code = required_permission
          and (user_role.expires_at is null or user_role.expires_at > now())
      )
    );
$$;

revoke execute on function private.is_employee() from public;
revoke execute on function private.has_permission(text) from public;
grant usage on schema private to authenticated;
grant execute on function private.is_employee() to authenticated;
grant execute on function private.has_permission(text) to authenticated;

insert into public.role_permissions (role_id, permission_id, granted)
select role.id, permission.id, true
from public.app_roles role
join public.permissions permission on permission.code = 'users.view'
  or (role.code = 'director' and permission.code in ('users.manage', 'roles.manage', 'audit.view'))
where role.code in (
  'director', 'executive_director', 'commercial_director', 'logistics_director',
  'senior_logistics_manager', 'logistics_specialist', 'accountant', 'marketer', 'administrator'
)
on conflict (role_id, permission_id) do update set granted = excluded.granted;

alter table public.user_permission_overrides enable row level security;
grant select, insert, update on public.user_permission_overrides to authenticated;

drop policy if exists "users view own overrides or access managers view all" on public.user_permission_overrides;
create policy "users view own overrides or access managers view all"
  on public.user_permission_overrides for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select private.has_permission('roles.manage'))
  );

drop policy if exists "access managers grant overrides" on public.user_permission_overrides;
create policy "access managers grant overrides"
  on public.user_permission_overrides for insert to authenticated
  with check (
    (select private.has_permission('roles.manage'))
    and granted_by = (select auth.uid())
  );

drop policy if exists "access managers revoke overrides" on public.user_permission_overrides;
create policy "access managers revoke overrides"
  on public.user_permission_overrides for update to authenticated
  using ((select private.has_permission('roles.manage')))
  with check ((select private.has_permission('roles.manage')));

drop policy if exists "authenticated users view active roles" on public.app_roles;
create policy "employees view enabled roles or access managers view all"
  on public.app_roles for select to authenticated
  using (
    (is_enabled and (select private.is_employee()))
    or (select private.has_permission('roles.manage'))
  );

drop policy if exists "authenticated users view profiles" on public.profiles;
create policy "employees view active profiles or user managers view all"
  on public.profiles for select to authenticated
  using (
    (is_active and (select private.is_employee()))
    or (select private.has_permission('users.manage'))
  );

drop policy if exists "administrators create roles" on public.app_roles;
drop policy if exists "administrators update roles" on public.app_roles;
drop policy if exists "administrators archive roles" on public.app_roles;
create policy "access managers create roles" on public.app_roles
  for insert to authenticated with check ((select private.has_permission('roles.manage')));
create policy "access managers update roles" on public.app_roles
  for update to authenticated
  using ((select private.has_permission('roles.manage')))
  with check ((select private.has_permission('roles.manage')));
create policy "access managers delete custom roles" on public.app_roles
  for delete to authenticated
  using (not is_system and (select private.has_permission('roles.manage')));

drop policy if exists "administrators grant permissions" on public.role_permissions;
drop policy if exists "administrators update permissions" on public.role_permissions;
drop policy if exists "administrators revoke permissions" on public.role_permissions;
create policy "access managers grant permissions" on public.role_permissions
  for insert to authenticated with check ((select private.has_permission('roles.manage')));
create policy "access managers update permissions" on public.role_permissions
  for update to authenticated
  using ((select private.has_permission('roles.manage')))
  with check ((select private.has_permission('roles.manage')));
create policy "access managers revoke permissions" on public.role_permissions
  for delete to authenticated using ((select private.has_permission('roles.manage')));

drop policy if exists "administrators update profiles" on public.profiles;
create policy "user managers update profiles" on public.profiles
  for update to authenticated
  using ((select private.has_permission('users.manage')))
  with check ((select private.has_permission('users.manage')));

drop policy if exists "administrators assign roles" on public.user_roles;
drop policy if exists "administrators update role assignments" on public.user_roles;
drop policy if exists "administrators remove role assignments" on public.user_roles;
drop policy if exists "users view own roles or administrators view all" on public.user_roles;
create policy "users view own roles or access managers view all" on public.user_roles
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select private.has_permission('roles.manage'))
  );
create policy "access managers assign roles" on public.user_roles
  for insert to authenticated with check ((select private.has_permission('roles.manage')));
create policy "access managers update role assignments" on public.user_roles
  for update to authenticated
  using ((select private.has_permission('roles.manage')))
  with check ((select private.has_permission('roles.manage')));
create policy "access managers remove role assignments" on public.user_roles
  for delete to authenticated using ((select private.has_permission('roles.manage')));

create or replace function private.write_access_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_row jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  new_row jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  row_id text := coalesce(
    new_row ->> 'id', old_row ->> 'id',
    new_row ->> 'user_id', old_row ->> 'user_id',
    new_row ->> 'role_id', old_row ->> 'role_id'
  );
begin
  insert into public.audit_log (
    actor_user_id, action, entity_type, entity_id,
    before_data, after_data, metadata
  ) values (
    (select auth.uid()), lower(tg_op), tg_table_name, row_id,
    old_row, new_row, jsonb_build_object('source', 'database')
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke execute on function private.write_access_audit() from public;

drop trigger if exists audit_profiles_changes on public.profiles;
create trigger audit_profiles_changes
  after insert or update on public.profiles
  for each row execute function private.write_access_audit();
drop trigger if exists audit_app_roles_changes on public.app_roles;
create trigger audit_app_roles_changes
  after insert or update or delete on public.app_roles
  for each row execute function private.write_access_audit();
drop trigger if exists audit_role_permissions_changes on public.role_permissions;
create trigger audit_role_permissions_changes
  after insert or update or delete on public.role_permissions
  for each row execute function private.write_access_audit();
drop trigger if exists audit_user_roles_changes on public.user_roles;
create trigger audit_user_roles_changes
  after insert or update or delete on public.user_roles
  for each row execute function private.write_access_audit();
drop trigger if exists audit_user_permission_overrides_changes on public.user_permission_overrides;
create trigger audit_user_permission_overrides_changes
  after insert or update on public.user_permission_overrides
  for each row execute function private.write_access_audit();

create or replace function private.protect_last_administrator_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_role_code text;
  remaining_admins integer;
begin
  select code into old_role_code from public.app_roles where id = old.role_id;
  if old_role_code <> 'administrator' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and new.role_id = old.role_id and new.user_id = old.user_id then
    return new;
  end if;
  select count(*) into remaining_admins
  from public.user_roles ur
  join public.app_roles ar on ar.id = ur.role_id and ar.code = 'administrator'
  join public.profiles p on p.id = ur.user_id and p.is_active
  where ur.user_id <> old.user_id;
  if remaining_admins = 0 then
    raise exception 'Нельзя снять роль у последнего активного администратора';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_last_administrator_role on public.user_roles;
create trigger protect_last_administrator_role
  before update or delete on public.user_roles
  for each row execute function private.protect_last_administrator_role();

create or replace function private.protect_last_administrator_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  is_admin boolean;
  remaining_admins integer;
begin
  if old.is_active = false or new.is_active = true then
    return new;
  end if;
  select exists (
    select 1 from public.user_roles ur
    join public.app_roles ar on ar.id = ur.role_id
    where ur.user_id = old.id and ar.code = 'administrator'
  ) into is_admin;
  if not is_admin then
    return new;
  end if;
  select count(*) into remaining_admins
  from public.user_roles ur
  join public.app_roles ar on ar.id = ur.role_id and ar.code = 'administrator'
  join public.profiles p on p.id = ur.user_id and p.is_active
  where ur.user_id <> old.id;
  if remaining_admins = 0 then
    raise exception 'Нельзя отключить последнего активного администратора';
  end if;
  return new;
end;
$$;

drop trigger if exists protect_last_administrator_profile on public.profiles;
create trigger protect_last_administrator_profile
  before update of is_active on public.profiles
  for each row execute function private.protect_last_administrator_profile();

create or replace function private.protect_administrator_management_permission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  role_code text;
  permission_code text;
begin
  select code into role_code from public.app_roles where id = old.role_id;
  select code into permission_code from public.permissions where id = old.permission_id;
  if role_code = 'administrator'
    and permission_code = 'roles.manage'
    and (tg_op = 'DELETE' or new.granted = false) then
    raise exception 'Нельзя отозвать управление ролями у системного администратора';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_administrator_management_permission on public.role_permissions;
create trigger protect_administrator_management_permission
  before update or delete on public.role_permissions
  for each row execute function private.protect_administrator_management_permission();

comment on table public.user_permission_overrides is
  'Per-user permission grants and denials layered over role permissions';
comment on function private.has_permission(text) is
  'Checks active profile, personal deny/allow overrides, enabled roles and active role assignments';
