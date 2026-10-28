-- Immutable archive storage. This migration does not archive or remove any business rows.
-- Moving a reviewed test dataset is a separate, owner-authorized maintenance transaction.
create table if not exists private.operational_archives (
  id uuid primary key,
  title text not null check (length(btrim(title)) between 1 and 200),
  reason text not null check (length(btrim(reason)) between 1 and 2000),
  created_at timestamptz not null default now(),
  source_commit text not null check (source_commit ~ '^[0-9a-f]{40}$'),
  manifest jsonb not null check (jsonb_typeof(manifest)='object'),
  records jsonb not null check (jsonb_typeof(records)='object')
);
alter table private.operational_archives enable row level security;
revoke all on private.operational_archives from public,anon,authenticated,service_role;

create or replace function private.guard_operational_archive()
returns trigger language plpgsql set search_path='' as $$
begin raise exception 'Архив доступен только для чтения' using errcode='42501'; end;
$$;
revoke all on function private.guard_operational_archive() from public,anon,authenticated,service_role;
drop trigger if exists immutable_operational_archive on private.operational_archives;
create trigger immutable_operational_archive before update or delete on private.operational_archives
for each row execute function private.guard_operational_archive();

create or replace function private.can_read_operational_archive()
returns boolean language sql stable security definer set search_path='' as $$
  select private.is_employee() and private.has_permission('audit.view')
    and exists (select 1 from public.user_roles ur join public.app_roles r on r.id=ur.role_id
      where ur.user_id=auth.uid() and r.code='administrator' and r.is_enabled
      and (ur.expires_at is null or ur.expires_at>now()))
    -- Full snapshots may contain prices and personal details. Fail closed on any
    -- missing employee read permission; external portal permission is unrelated.
    and not exists (select 1 from public.permissions p
      where (p.code like '%.view' or p.code like 'prices.%')
        and p.code <> 'external_documents.view' and not private.has_permission(p.code));
$$;
revoke all on function private.can_read_operational_archive() from public,anon,authenticated,service_role;

create or replace function public.list_operational_archives()
returns table(id uuid,title text,reason text,created_at timestamptz,source_commit text,manifest jsonb)
language plpgsql stable security definer set search_path='' as $$
begin
  if not private.can_read_operational_archive() then raise exception 'Недостаточно прав для просмотра архива' using errcode='42501'; end if;
  return query select a.id,a.title,a.reason,a.created_at,a.source_commit,a.manifest
    from private.operational_archives a order by a.created_at desc,a.id;
end;
$$;
create or replace function public.read_operational_archive(p_archive_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if not private.can_read_operational_archive() then raise exception 'Недостаточно прав для просмотра архива' using errcode='42501'; end if;
  return (select jsonb_build_object('id',a.id,'title',a.title,'reason',a.reason,
    'created_at',a.created_at,'source_commit',a.source_commit,'manifest',a.manifest,'records',a.records)
    from private.operational_archives a where a.id=p_archive_id);
end;
$$;
revoke all on function public.list_operational_archives() from public,anon,service_role;
revoke all on function public.read_operational_archive(uuid) from public,anon,service_role;
grant execute on function public.list_operational_archives(),public.read_operational_archive(uuid) to authenticated;
comment on table private.operational_archives is 'Immutable owner-authorized historical datasets, excluded from live operational tables. No write RPC.';

-- Preserve archived shipment numbers; old migration repeats retain this compatibility too.
create or replace function public.create_shipment_with_stages(
  p_project_code text,p_type text,p_supplier_id uuid,p_customer_id uuid,p_route_id uuid,
  p_currency_id uuid,p_warehouse_id uuid,p_responsible_user_id uuid,p_planned_ready_date date default null,p_planned_arrival_date date default null
) returns uuid language plpgsql security definer set search_path='' set timezone='Asia/Almaty' as $$
declare v_template uuid; v_shipment uuid; v_number text; v_year text; v_serial text;
begin
  if not private.can_write_shipments('create') then raise exception 'Недостаточно прав для создания поставки'; end if;
  if p_type not in ('import','export','domestic_transfer') then raise exception 'Некорректный тип поставки'; end if;
  if not private.is_active_employee(p_responsible_user_id) then raise exception 'Ответственный сотрудник не найден или неактивен'; end if;
  v_year := to_char(current_date,'YYYY');
  perform pg_advisory_xact_lock(hashtext('nexus_shipment_number_' || v_year));
  select id into v_template from public.process_templates where status='active' and is_default and (shipment_type=p_type or shipment_type is null) order by version desc limit 1;
  if v_template is null then raise exception 'Активный шаблон процесса не найден'; end if;
  if to_regclass('private.operational_archives') is null then
    select (coalesce(max(substring(shipment_number from '^NAR-' || v_year || '-([0-9]+)$')::numeric),0)+1)::text
      into v_serial from public.shipments;
  else
    select (coalesce(max(substring(shipment_number from '^NAR-' || v_year || '-([0-9]+)$')::numeric),0)+1)::text
      into v_serial from (
        select shipment_number from public.shipments
        union all
        select entry->>'shipment_number' from private.operational_archives a
          cross join lateral jsonb_array_elements(coalesce(a.records->'shipments','[]'::jsonb)) entry
      ) occupied_numbers;
  end if;
  v_number := 'NAR-' || v_year || '-' || lpad(v_serial,greatest(4,length(v_serial)),'0');
  insert into public.shipments(shipment_number,project_code,type,supplier_id,customer_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,planned_ready_date,planned_arrival_date,created_by)
  values(v_number,nullif(trim(p_project_code),''),p_type,p_supplier_id,p_customer_id,p_route_id,v_template,p_currency_id,p_warehouse_id,p_responsible_user_id,p_planned_ready_date,p_planned_arrival_date,(select auth.uid())) returning id into v_shipment;
  insert into public.shipment_stage_runs(shipment_id,stage_id,is_required,status,responsible_user_id,status_reason)
  select v_shipment,s.id,s.requirement='required',case when s.requirement='conditional' then 'not_applicable' else 'pending' end,p_responsible_user_id,
    case when s.requirement='conditional' then 'Будет активирован при выполнении условия' end
  from public.shipment_stages s where s.process_template_id=v_template and s.is_active;
  update public.shipments set leading_stage_id=(select id from public.shipment_stages where process_template_id=v_template and sequence_order=1) where id=v_shipment;
  return v_shipment;
end $$;

notify pgrst, 'reload schema';
