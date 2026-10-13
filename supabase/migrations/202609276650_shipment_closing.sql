-- Closing a shipment.
--
-- The shipment status follows the category of the first unfinished required stage. The last stage,
-- «Закрытие поставки», has the category "closed", so the shipment became "closed" as soon as the stage
-- before it was done; the protection of closed shipments then rejected completing the closing stage
-- itself. Such a shipment was neither locked nor dated, and nothing could reopen it.
--
-- Now:
--   * "closed" is set only when every required stage is done; until then the shipment waits in "sales";
--   * closing locks the shipment and records when and by whom (closed_at, closed_by);
--   * a manager with shipments.reopen may reopen a closed shipment with a reason: the closing stage
--     returns to work, the other stages stay done, the reason goes into the stage history;
--   * shipments already stuck in "closed" are repaired once (see the end of the file).

insert into public.permissions(code,module,action,name,description) values
  ('shipments.reopen','shipments','reopen','Поставки: повторное открытие','Повторное открытие закрытой поставки с указанием причины')
on conflict (code) do update set name=excluded.name,description=excluded.description;

insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true from public.app_roles r cross join public.permissions p
where p.code='shipments.reopen' and r.code in ('administrator','director','executive_director')
on conflict (role_id,permission_id) do nothing;

-- One place for the rule, whichever function derived the status (stage change, vehicle receiving).
create or replace function private.shipment_closing_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'closed' and old.status is distinct from 'closed' then
    if exists (
      select 1 from public.shipment_stage_runs run
      where run.shipment_id = new.id and run.is_required
        and run.status not in ('completed', 'skipped', 'not_applicable')
    ) then
      -- Only the closing stage itself is left: the shipment is ready to close, not closed.
      new.status := 'sales';
    else
      new.is_locked := true;
      new.closed_at := coalesce(new.closed_at, now());
      new.closed_by := coalesce(new.closed_by, (select auth.uid()));
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists shipment_closing_state on public.shipments;
create trigger shipment_closing_state
before update of status on public.shipments
for each row execute function private.shipment_closing_state();

create or replace function public.reopen_shipment(p_shipment_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shipment public.shipments%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_run record;
begin
  if not (select private.has_permission('shipments.reopen')) then
    raise exception 'Недостаточно прав для повторного открытия поставки' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'Укажите причину повторного открытия';
  end if;
  if length(v_reason) > 500 then
    raise exception 'Причина не должна быть длиннее 500 символов';
  end if;
  select * into v_shipment from public.shipments where id = p_shipment_id for update;
  if not found then
    raise exception 'Поставка не найдена';
  end if;
  if v_shipment.status <> 'closed' then
    raise exception 'Открыть повторно можно только закрытую поставку';
  end if;

  -- The shipment first, so the protection of closed shipments lets the stage change through.
  update public.shipments
  set status = 'sales', is_locked = false, closed_at = null, closed_by = null, updated_at = now()
  where id = p_shipment_id;

  for v_run in
    select run.id, run.status
    from public.shipment_stage_runs run
    join public.shipment_stages stage on stage.id = run.stage_id
    where run.shipment_id = p_shipment_id and stage.status_category = 'closed'
      and run.status in ('completed', 'skipped')
    for update of run
  loop
    update public.shipment_stage_runs
    set status = 'in_progress', completed_at = null, status_reason = v_reason, updated_at = now()
    where id = v_run.id;
    insert into public.shipment_stage_history(stage_run_id, shipment_id, from_status, to_status, changed_by, reason)
    values (v_run.id, p_shipment_id, v_run.status, 'in_progress', (select auth.uid()),
            'Повторное открытие поставки: ' || v_reason);
  end loop;

  update public.shipments
  set leading_stage_id = (
    select run.stage_id from public.shipment_stage_runs run
    join public.shipment_stages stage on stage.id = run.stage_id
    where run.shipment_id = p_shipment_id and run.is_required
      and run.status not in ('completed', 'skipped', 'not_applicable')
    order by stage.sequence_order limit 1)
  where id = p_shipment_id;
end;
$$;

revoke all on function private.shipment_closing_state() from public, anon, authenticated, service_role;
revoke all on function public.reopen_shipment(uuid, text) from public, anon, service_role;
grant execute on function public.reopen_shipment(uuid, text) to authenticated;

comment on function public.reopen_shipment(uuid, text) is
  'Reopens a closed shipment with a mandatory reason: unlocks it and returns the closing stage to work';

-- One-time repair, safe to repeat. Stuck shipments (closed while a required stage is open) wait for
-- closing again; truly finished ones are locked with the time and the employee of the last completion.
update public.shipments s
set status = 'sales', updated_at = now()
where s.status = 'closed'
  and exists (select 1 from public.shipment_stage_runs run
              where run.shipment_id = s.id and run.is_required
                and run.status not in ('completed', 'skipped', 'not_applicable'));

update public.shipments s
set is_locked = true,
    closed_at = coalesce(s.closed_at,
      (select max(run.completed_at) from public.shipment_stage_runs run where run.shipment_id = s.id), s.updated_at),
    closed_by = coalesce(s.closed_by,
      (select h.changed_by from public.shipment_stage_history h where h.shipment_id = s.id and h.to_status in ('completed', 'skipped')
       order by h.created_at desc limit 1))
where s.status = 'closed' and (not s.is_locked or s.closed_at is null);
