-- Owner decision of 2026-11-15: the administrator role receives every right of the carrier directory
-- and freight context (202611100300), including the separate right to drivers' IIN and document
-- requisites. Other roles receive nothing here; an access manager (roles.manage) grants them later on
-- /admin/roles or by a personal allow. Personal deny still overrides this role grant.
--
-- drivers.documents.view is one of the ".view" rights required by private.can_read_operational_archive(),
-- so without this grant administrators would lose the operational archive after 202611100300.
begin;

insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true
from public.app_roles r cross join public.permissions p
where r.code='administrator'
  and p.code in (
    'carriers.directory.read',
    'carriers.directory.manage',
    'freight.context.read',
    'freight.context.manage',
    'drivers.documents.view'
  )
on conflict (role_id,permission_id) do update set granted=true;

-- Fail closed if 202611100300 has not created the rights: a silent no-op would leave the archive locked.
do $$
begin
  if (select count(*) from public.role_permissions rp
        join public.app_roles r on r.id=rp.role_id
        join public.permissions p on p.id=rp.permission_id
      where r.code='administrator' and rp.granted
        and p.code in ('carriers.directory.read','carriers.directory.manage','freight.context.read',
                       'freight.context.manage','drivers.documents.view')) <> 5 then
    raise exception 'Не найдены права справочника перевозчиков: сначала примените 202611100300_carrier_directory.sql';
  end if;
end $$;

commit;
