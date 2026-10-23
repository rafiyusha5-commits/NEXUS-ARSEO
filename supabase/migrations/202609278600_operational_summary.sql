-- Operational analytics counted in the database. Audit 2026-10-13, finding Н8.
--
-- /analytics loaded every shipment, stage run, order and task and counted them in the application. The API returns
-- at most 1000 rows per request, so with about 18 stages per shipment "Этапы под контролем" went silently low after
-- about 55 shipments, and the other figures after 1000 rows. operational_summary() returns the counts themselves.
--
-- It runs with the rights of the caller (security invoker): the rows are read through the same RLS policies as the
-- lists, so the figures never show more than the person could open. A block is returned only with its source
-- permission, as on the page. The business day is the day in Kazakhstan.
begin;

create or replace function public.operational_summary()
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare
  v_today date:=(now() at time zone 'Asia/Almaty')::date;
  v_result jsonb;
  v_block jsonb;
begin
  if not (select private.has_permission('reports.view')) then
    raise exception 'Нет доступа к отчётам' using errcode='42501';
  end if;
  v_result:=jsonb_build_object('today',v_today);

  if (select private.has_permission('shipments.view')) then
    select jsonb_build_object(
      'total',count(*),
      'active',count(*) filter (where s.status not in ('closed','cancelled')),
      'late',count(*) filter (where s.status not in ('closed','cancelled') and s.planned_arrival_date<v_today),
      'by_status',coalesce((select jsonb_object_agg(g.status,g.n) from (
        select x.status,count(*) n from public.shipments x group by x.status) g),'{}'::jsonb))
    into v_block from public.shipments s;
    v_result:=v_result||jsonb_build_object('shipments',v_block);

    select jsonb_build_object(
      'blocked',count(*) filter (where r.status='blocked'),
      'late',count(*) filter (where r.is_required and r.status not in ('completed','skipped','not_applicable') and r.due_at<now()),
      'attention',count(*) filter (where r.status='blocked'
        or (r.is_required and r.status not in ('completed','skipped','not_applicable') and r.due_at<now())))
    into v_block from public.shipment_stage_runs r;
    v_result:=v_result||jsonb_build_object('stages',v_block);
  end if;

  if (select private.has_permission('sales.view')) then
    select jsonb_build_object(
      'total',count(*),
      'open',count(*) filter (where s.status not in ('shipped','cancelled')),
      'late',count(*) filter (where s.status not in ('shipped','cancelled') and s.planned_shipment_date<v_today),
      'by_status',coalesce((select jsonb_object_agg(g.status,g.n) from (
        select x.status,count(*) n from public.sales x group by x.status) g),'{}'::jsonb))
    into v_block from public.sales s;
    v_result:=v_result||jsonb_build_object('sales',v_block);
  end if;

  if (select private.has_permission('inventory.view')) then
    select jsonb_build_object('risk',count(*)) into v_block
    from public.inventory_fifo_status f where f.shelf_life_state in ('critical','expired');
    v_result:=v_result||jsonb_build_object('inventory',v_block);
  end if;

  if (select private.has_permission('tasks.view')) then
    select jsonb_build_object(
      'open',count(*) filter (where t.status not in ('done','cancelled')),
      'late',count(*) filter (where t.status not in ('done','cancelled') and t.due_at<now()))
    into v_block from public.tasks t;
    v_result:=v_result||jsonb_build_object('tasks',v_block);
  end if;

  return v_result;
end $$;
revoke all on function public.operational_summary() from public, anon, service_role;
grant execute on function public.operational_summary() to authenticated;

commit;
