-- Phase 2C: controlled warehouse transfers and write-offs.

alter table public.inventory_movements
  add column if not exists transfer_group_id uuid,
  add column if not exists performed_by_name text;

create index if not exists inventory_movements_transfer_group_idx
  on public.inventory_movements(transfer_group_id)
  where transfer_group_id is not null;

create or replace function public.transfer_inventory_batch(
  p_balance_id uuid,
  p_to_warehouse_id uuid,
  p_to_location_id uuid,
  p_quantity numeric,
  p_reference text default null,
  p_reason text default null,
  p_performed_by_name text default null
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  v_source record;
  v_destination_id uuid;
  v_group_id uuid:=gen_random_uuid();
begin
  if not (select private.has_permission('inventory.move')) then
    raise exception 'Недостаточно прав для перемещения товара';
  end if;
  if p_quantity is null or p_quantity<=0 then raise exception 'Количество должно быть больше нуля'; end if;

  select balance.id,balance.batch_id,balance.warehouse_id,balance.warehouse_location_id,balance.uom,
    balance.quantity_on_hand-balance.quantity_reserved as available,batch.status
  into v_source
  from public.inventory_balances balance
  join public.inventory_batches batch on batch.id=balance.batch_id
  where balance.id=p_balance_id
  for update of balance;
  if not found then raise exception 'Исходный остаток не найден'; end if;
  if v_source.status<>'available' then raise exception 'Партия недоступна для перемещения'; end if;
  if p_quantity>v_source.available then raise exception 'Недостаточный доступный остаток'; end if;
  if not exists(select 1 from public.warehouses where id=p_to_warehouse_id and status='active') then
    raise exception 'Склад назначения недоступен';
  end if;
  if p_to_location_id is not null and not exists(
    select 1 from public.warehouse_locations
    where id=p_to_location_id and warehouse_id=p_to_warehouse_id and status='active'
  ) then raise exception 'Зона не относится к складу назначения'; end if;
  if v_source.warehouse_id=p_to_warehouse_id and v_source.warehouse_location_id is not distinct from p_to_location_id then
    raise exception 'Исходное место и место назначения совпадают';
  end if;

  update public.inventory_balances set quantity_on_hand=quantity_on_hand-p_quantity,updated_at=now()
  where id=v_source.id;

  select id into v_destination_id from public.inventory_balances
  where batch_id=v_source.batch_id and warehouse_id=p_to_warehouse_id
    and warehouse_location_id is not distinct from p_to_location_id and uom=v_source.uom
  for update;
  if v_destination_id is null then
    insert into public.inventory_balances(batch_id,warehouse_id,warehouse_location_id,uom,quantity_on_hand)
    values(v_source.batch_id,p_to_warehouse_id,p_to_location_id,v_source.uom,p_quantity)
    on conflict do nothing returning id into v_destination_id;
    if v_destination_id is null then
      select id into v_destination_id from public.inventory_balances
      where batch_id=v_source.batch_id and warehouse_id=p_to_warehouse_id
        and warehouse_location_id is not distinct from p_to_location_id and uom=v_source.uom
      for update;
      update public.inventory_balances set quantity_on_hand=quantity_on_hand+p_quantity,updated_at=now()
      where id=v_destination_id;
    end if;
  else
    update public.inventory_balances set quantity_on_hand=quantity_on_hand+p_quantity,updated_at=now()
    where id=v_destination_id;
  end if;

  insert into public.inventory_movements(batch_id,movement_type,quantity,uom,from_warehouse_id,from_location_id,reference,reason,transfer_group_id,performed_by_name)
  values(v_source.batch_id,'transfer',p_quantity,v_source.uom,v_source.warehouse_id,v_source.warehouse_location_id,
    nullif(trim(p_reference),''),nullif(trim(p_reason),''),v_group_id,nullif(trim(p_performed_by_name),''));
  insert into public.inventory_movements(batch_id,movement_type,quantity,uom,to_warehouse_id,to_location_id,reference,reason,transfer_group_id,performed_by_name)
  values(v_source.batch_id,'transfer',p_quantity,v_source.uom,p_to_warehouse_id,p_to_location_id,
    nullif(trim(p_reference),''),nullif(trim(p_reason),''),v_group_id,nullif(trim(p_performed_by_name),''));
  return v_group_id;
end $$;

create or replace function public.write_off_inventory(
  p_balance_id uuid,
  p_quantity numeric,
  p_reason text,
  p_reference text default null,
  p_performed_by_name text default null
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  v_source record;
  v_movement_id uuid;
begin
  if not (select private.has_permission('inventory.write_off')) then
    raise exception 'Недостаточно прав для списания товара';
  end if;
  if p_quantity is null or p_quantity<=0 then raise exception 'Количество должно быть больше нуля'; end if;
  if nullif(trim(p_reason),'') is null then raise exception 'Укажите причину списания'; end if;

  select balance.id,balance.batch_id,balance.warehouse_id,balance.warehouse_location_id,balance.uom,
    balance.quantity_on_hand-balance.quantity_reserved as available
  into v_source from public.inventory_balances balance
  where balance.id=p_balance_id for update;
  if not found then raise exception 'Остаток не найден'; end if;
  if p_quantity>v_source.available then raise exception 'Недостаточный доступный остаток'; end if;

  update public.inventory_balances set quantity_on_hand=quantity_on_hand-p_quantity,updated_at=now()
  where id=v_source.id;
  insert into public.inventory_movements(batch_id,movement_type,quantity,uom,from_warehouse_id,from_location_id,reference,reason,performed_by_name)
  values(v_source.batch_id,'write_off',p_quantity,v_source.uom,v_source.warehouse_id,v_source.warehouse_location_id,
    nullif(trim(p_reference),''),trim(p_reason),nullif(trim(p_performed_by_name),''))
  returning id into v_movement_id;

  update public.inventory_batches batch set status='depleted',updated_at=now()
  where id=v_source.batch_id
    and not exists(select 1 from public.inventory_balances balance where balance.batch_id=batch.id and balance.quantity_on_hand>0);
  return v_movement_id;
end $$;

revoke all on function public.transfer_inventory_batch(uuid,uuid,uuid,numeric,text,text,text) from public;
revoke all on function public.write_off_inventory(uuid,numeric,text,text,text) from public;
grant execute on function public.transfer_inventory_batch(uuid,uuid,uuid,numeric,text,text,text) to authenticated;
grant execute on function public.write_off_inventory(uuid,numeric,text,text,text) to authenticated;

comment on function public.transfer_inventory_batch(uuid,uuid,uuid,numeric,text,text,text) is 'Atomically transfers one batch balance and records linked outgoing and incoming movements';
comment on function public.write_off_inventory(uuid,numeric,text,text,text) is 'Writes off available stock with a required reason and immutable movement record';
