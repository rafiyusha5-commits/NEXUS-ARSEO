-- Phase 7A: permission gate for operational analytics.
-- The dashboard reads existing entities through their own RLS policies, so access
-- to a report never widens access to shipments, sales, inventory, tasks or syncs.

insert into public.permissions(code,module,action,name,description) values
 ('reports.view','reports','view','Отчёты: просмотр','Просмотр операционных показателей в пределах доступных разделов')
on conflict(code) do update set module=excluded.module,action=excluded.action,name=excluded.name,description=excluded.description;

insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true
from public.app_roles r
join public.permissions p on p.code='reports.view'
where r.code in ('director','executive_director','commercial_director','logistics_director','senior_logistics_manager','logistics_specialist','accountant','marketer','administrator')
on conflict(role_id,permission_id) do update set granted=true;

comment on table public.permissions is 'Application permissions, including reports.view for RLS-preserving operational analytics.';
