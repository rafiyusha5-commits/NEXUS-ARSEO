-- Complete the operational shipment workflow: item allocation, transport progress
-- and controlled hold/resume/cancel actions.

create or replace function public.allocate_shipment_item(
  p_item_id uuid,
  p_transport_id uuid,
  p_quantity numeric
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shipment_id uuid;
  v_current_transport_id uuid;
  v_product_id uuid;
  v_uom text;
  v_ordered_quantity numeric;
  v_unit_price numeric;
  v_currency_id uuid;
  v_shipment_locked boolean;
  v_target_item_id uuid;
begin
  if not (select private.has_permission('shipments.update')) then
    raise exception 'Недостаточно прав для распределения товара';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Количество должно быть больше нуля';
  end if;

  select
    item.shipment_id,
    item.shipment_transport_id,
    item.product_id,
    item.uom,
    item.ordered_quantity,
    item.unit_price,
    item.currency_id,
    shipment.is_locked
    into
      v_shipment_id,
      v_current_transport_id,
      v_product_id,
      v_uom,
      v_ordered_quantity,
      v_unit_price,
      v_currency_id,
      v_shipment_locked
  from public.shipment_items item
  join public.shipments shipment on shipment.id = item.shipment_id
  where item.id = p_item_id
  for update of item, shipment;

  if not found then raise exception 'Позиция поставки не найдена'; end if;
  if v_shipment_locked then raise exception 'Закрытая поставка недоступна для изменений'; end if;
  if p_quantity > v_ordered_quantity then
    raise exception 'Нельзя распределить больше заказанного количества';
  end if;
  if p_transport_id is not null and not exists (
    select 1 from public.shipment_transports transport
    where transport.id = p_transport_id
      and transport.shipment_id = v_shipment_id
      and transport.status <> 'cancelled'
  ) then
    raise exception 'Перевозка не относится к этой поставке или отменена';
  end if;
  if v_current_transport_id is not distinct from p_transport_id then
    raise exception 'Позиция уже распределена в выбранную перевозку';
  end if;

  select id into v_target_item_id
  from public.shipment_items
  where shipment_id = v_shipment_id
    and product_id = v_product_id
    and shipment_transport_id is not distinct from p_transport_id
    and id <> p_item_id
  for update;

  if p_quantity = v_ordered_quantity then
    if v_target_item_id is null then
      update public.shipment_items
      set shipment_transport_id = p_transport_id, updated_at = now()
      where id = p_item_id;
      return p_item_id;
    end if;

    update public.shipment_items
    set ordered_quantity = ordered_quantity + p_quantity, updated_at = now()
    where id = v_target_item_id;
    delete from public.shipment_items where id = p_item_id;
    return v_target_item_id;
  end if;

  update public.shipment_items
  set ordered_quantity = ordered_quantity - p_quantity, updated_at = now()
  where id = p_item_id;

  if v_target_item_id is not null then
    update public.shipment_items
    set ordered_quantity = ordered_quantity + p_quantity, updated_at = now()
    where id = v_target_item_id;
    return v_target_item_id;
  end if;

  insert into public.shipment_items(
    shipment_id, shipment_transport_id, product_id, uom,
    ordered_quantity, unit_price, currency_id
  ) values (
    v_shipment_id, p_transport_id, v_product_id, v_uom,
    p_quantity, v_unit_price, v_currency_id
  ) returning id into v_target_item_id;
  return v_target_item_id;
end $$;

create or replace function private.protect_inactive_shipment_children()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shipment_id uuid := case when tg_op = 'DELETE' then old.shipment_id else new.shipment_id end;
  v_status text;
  v_locked boolean;
begin
  select status,is_locked into v_status,v_locked from public.shipments where id=v_shipment_id;
  if v_locked or v_status in ('on_hold','cancelled','closed') then
    raise exception 'Поставка в статусе "%" недоступна для изменений',v_status;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create or replace function public.update_shipment_item(
  p_item_id uuid,
  p_quantity numeric,
  p_unit_price numeric default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_locked boolean;
begin
  if not (select private.has_permission('shipments.update')) then
    raise exception 'Недостаточно прав для изменения товара';
  end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Количество должно быть больше нуля'; end if;
  if p_unit_price is not null and p_unit_price < 0 then raise exception 'Цена не может быть отрицательной'; end if;
  select shipment.is_locked into v_locked
  from public.shipment_items item
  join public.shipments shipment on shipment.id = item.shipment_id
  where item.id = p_item_id;
  if not found then raise exception 'Позиция поставки не найдена'; end if;
  if v_locked then raise exception 'Закрытая поставка недоступна для изменений'; end if;
  update public.shipment_items
  set ordered_quantity = p_quantity, unit_price = p_unit_price, updated_at = now()
  where id = p_item_id;
end $$;

create or replace function public.delete_shipment_item(p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_locked boolean;
begin
  if not (select private.has_permission('shipments.update')) then
    raise exception 'Недостаточно прав для удаления товара';
  end if;
  select shipment.is_locked into v_locked
  from public.shipment_items item
  join public.shipments shipment on shipment.id = item.shipment_id
  where item.id = p_item_id;
  if not found then raise exception 'Позиция поставки не найдена'; end if;
  if v_locked then raise exception 'Закрытая поставка недоступна для изменений'; end if;
  delete from public.shipment_items where id = p_item_id;
end $$;

create or replace function public.change_shipment_transport_status(
  p_transport_id uuid,
  p_status text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_locked boolean;
begin
  if not (select private.has_permission('shipments.change_status')) then
    raise exception 'Недостаточно прав для изменения перевозки';
  end if;
  if p_status not in ('planned','loading','in_transit','at_customs','arrived','unloaded','cancelled') then
    raise exception 'Некорректный статус перевозки';
  end if;
  select shipment.is_locked into v_locked
  from public.shipment_transports transport
  join public.shipments shipment on shipment.id = transport.shipment_id
  where transport.id = p_transport_id;
  if not found then raise exception 'Перевозка не найдена'; end if;
  if v_locked then raise exception 'Закрытая поставка недоступна для изменений'; end if;
  update public.shipment_transports set
    status = p_status,
    actual_loading_date = case when p_status in ('loading','in_transit','at_customs','arrived','unloaded') then coalesce(actual_loading_date,current_date) else actual_loading_date end,
    actual_arrival_date = case when p_status in ('arrived','unloaded') then coalesce(actual_arrival_date,current_date) else actual_arrival_date end,
    updated_at = now()
  where id = p_transport_id;
end $$;

create or replace function public.change_shipment_operational_state(
  p_shipment_id uuid,
  p_action text,
  p_reason text default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_locked boolean;
  v_resume_status text;
begin
  if not (select private.has_permission('shipments.change_status')) then
    raise exception 'Недостаточно прав для изменения поставки';
  end if;
  select status,is_locked into v_status,v_locked
  from public.shipments where id = p_shipment_id for update;
  if not found then raise exception 'Поставка не найдена'; end if;
  if v_locked or v_status = 'closed' then raise exception 'Закрытая поставка недоступна для изменений'; end if;

  if p_action = 'hold' then
    if nullif(trim(p_reason),'') is null then raise exception 'Укажите причину приостановки'; end if;
    if v_status in ('on_hold','cancelled') then raise exception 'Действие недоступно для текущего статуса'; end if;
    update public.shipments set status='on_hold',hold_reason=trim(p_reason),updated_at=now() where id=p_shipment_id;
  elsif p_action = 'resume' then
    if v_status <> 'on_hold' then raise exception 'Возобновить можно только приостановленную поставку'; end if;
    select stage.status_category into v_resume_status
    from public.shipment_stage_runs run
    join public.shipment_stages stage on stage.id=run.stage_id
    where run.shipment_id=p_shipment_id and run.is_required
      and run.status not in ('completed','skipped','not_applicable')
    order by stage.sequence_order limit 1;
    update public.shipments set status=coalesce(v_resume_status,'closed'),hold_reason=null,updated_at=now() where id=p_shipment_id;
  elsif p_action = 'cancel' then
    if nullif(trim(p_reason),'') is null then raise exception 'Укажите причину отмены'; end if;
    if v_status = 'cancelled' then raise exception 'Поставка уже отменена'; end if;
    update public.shipments set status='cancelled',cancel_reason=trim(p_reason),updated_at=now() where id=p_shipment_id;
  else
    raise exception 'Некорректное действие с поставкой';
  end if;
end $$;

revoke all on function public.allocate_shipment_item(uuid,uuid,numeric) from public;
revoke all on function public.update_shipment_item(uuid,numeric,numeric) from public;
revoke all on function public.delete_shipment_item(uuid) from public;
revoke all on function public.change_shipment_transport_status(uuid,text) from public;
revoke all on function public.change_shipment_operational_state(uuid,text,text) from public;
grant execute on function public.allocate_shipment_item(uuid,uuid,numeric) to authenticated;
grant execute on function public.update_shipment_item(uuid,numeric,numeric) to authenticated;
grant execute on function public.delete_shipment_item(uuid) to authenticated;
grant execute on function public.change_shipment_transport_status(uuid,text) to authenticated;
grant execute on function public.change_shipment_operational_state(uuid,text,text) to authenticated;

revoke execute on function private.protect_inactive_shipment_children() from public;

drop trigger if exists protect_inactive_shipment_items on public.shipment_items;
create trigger protect_inactive_shipment_items
before insert or update or delete on public.shipment_items
for each row execute function private.protect_inactive_shipment_children();
drop trigger if exists protect_inactive_shipment_transports on public.shipment_transports;
create trigger protect_inactive_shipment_transports
before insert or update or delete on public.shipment_transports
for each row execute function private.protect_inactive_shipment_children();
drop trigger if exists protect_inactive_shipment_stage_runs on public.shipment_stage_runs;
create trigger protect_inactive_shipment_stage_runs
before insert or update or delete on public.shipment_stage_runs
for each row execute function private.protect_inactive_shipment_children();

drop trigger if exists audit_shipment_items_changes on public.shipment_items;
create trigger audit_shipment_items_changes
after insert or update or delete on public.shipment_items
for each row execute function private.write_access_audit();

comment on function public.allocate_shipment_item(uuid,uuid,numeric) is 'Atomically assigns all or part of one shipment item to a transport and merges duplicate allocations';
comment on function public.change_shipment_operational_state(uuid,text,text) is 'Holds, resumes or cancels an unlocked shipment with a mandatory reason where applicable';
