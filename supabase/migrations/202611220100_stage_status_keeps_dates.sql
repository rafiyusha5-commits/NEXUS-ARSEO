-- Pilot of 2026-11-22 (docs/pilot-import-shipment.md, journal): saving a stage that is already completed again set its
-- completion date to the moment of saving: when the stage list of a shipment was saved as a whole, stages completed weeks
-- earlier got the date of the save. Now:
--   * a completed stage saved as completed keeps its completion date (a new reason or performer is still recorded);
--   * a save that changes nothing (same status, reason and performer) changes nothing and writes no history entry.
-- The definition is that of 202609272300 with these two changes only; other statuses behave as before.
begin;

create or replace function public.change_shipment_stage_status(p_run_id uuid,p_status text,p_reason text default null,p_performed_by_name text default null)
returns void language plpgsql security definer set search_path='' as $$
declare v_old text; v_old_reason text; v_old_performer text; v_shipment uuid; v_locked boolean;
  v_reason text := nullif(trim(p_reason),''); v_performer text := nullif(trim(p_performed_by_name),'');
begin
  if not private.can_write_shipments('change_status') then raise exception 'Недостаточно прав'; end if;
  if p_status not in ('pending','in_progress','blocked','completed','skipped','not_applicable') then raise exception 'Некорректный статус этапа'; end if;
  if p_status in ('blocked','skipped','not_applicable') and v_reason is null then raise exception 'Укажите причину'; end if;
  select r.status,r.status_reason,r.performed_by_name,r.shipment_id,s.is_locked into v_old,v_old_reason,v_old_performer,v_shipment,v_locked
    from public.shipment_stage_runs r join public.shipments s on s.id=r.shipment_id where r.id=p_run_id for update of r;
  if not found then raise exception 'Этап поставки не найден'; end if;
  if v_locked then raise exception 'Закрытая поставка недоступна для изменений'; end if;
  -- Saving the stage list again leaves untouched stages as they are.
  if v_old = p_status and v_old_reason is not distinct from v_reason and v_old_performer is not distinct from v_performer then return; end if;
  update public.shipment_stage_runs set status=p_status,status_reason=v_reason,performed_by_name=v_performer,
    started_at=case when p_status='in_progress' then coalesce(started_at,now()) else started_at end,
    -- A stage completed earlier keeps its completion date.
    completed_at=case when p_status='completed' then case when v_old='completed' then coalesce(completed_at,now()) else now() end else null end,
    updated_at=now() where id=p_run_id;
  insert into public.shipment_stage_history(stage_run_id,shipment_id,from_status,to_status,changed_by,performed_by_name,reason) values(p_run_id,v_shipment,v_old,p_status,(select auth.uid()),v_performer,v_reason);
  update public.shipments sh set
    leading_stage_id=(select r.stage_id from public.shipment_stage_runs r join public.shipment_stages st on st.id=r.stage_id where r.shipment_id=v_shipment and r.is_required and r.status not in ('completed','skipped','not_applicable') order by st.sequence_order limit 1),
    status=coalesce((select st.status_category from public.shipment_stage_runs r join public.shipment_stages st on st.id=r.stage_id where r.shipment_id=v_shipment and r.is_required and r.status not in ('completed','skipped','not_applicable') order by st.sequence_order limit 1),'closed'),updated_at=now()
  where sh.id=v_shipment and sh.status not in ('on_hold','cancelled');
end $$;
revoke all on function public.change_shipment_stage_status(uuid,text,text,text) from public, anon, service_role;
grant execute on function public.change_shipment_stage_status(uuid,text,text,text) to authenticated;

commit;
