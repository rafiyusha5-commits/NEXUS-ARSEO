-- Stock that arrives into a depleted batch is sellable again.
--
-- Receiving finds an existing batch by product, batch number and expiry date and adds the stock to it, but kept
-- its status. A batch that had been sold out ("depleted") stayed depleted with stock on hand, and reservation,
-- issue and transfer take only available batches, so the goods could not be sold (audit 13.10.2026, H2). The
-- same happened to an inventory count that found more of a sold-out batch. Now:
--   * whenever the stock of a batch grows (any receipt, transfer, adjustment or reversal), a depleted batch
--     becomes available; quarantined and blocked batches keep their status;
--   * a direct write-off turns only an available batch into depleted, so a quarantined or blocked batch no
--     longer loses its status when its last units are written off;
--   * batches already stuck as depleted with stock are repaired once (end of the file).

create or replace function private.inventory_balance_restock()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.quantity_on_hand > 0 and (tg_op = 'INSERT' or new.quantity_on_hand > old.quantity_on_hand) then
    update public.inventory_batches set status = 'available', updated_at = now()
    where id = new.batch_id and status = 'depleted';
  end if;
  return null;
end $$;
revoke all on function private.inventory_balance_restock() from public, anon, authenticated, service_role;

drop trigger if exists inventory_balance_restock on public.inventory_balances;
create trigger inventory_balance_restock
after insert or update of quantity_on_hand on public.inventory_balances
for each row execute function private.inventory_balance_restock();

create or replace function public.write_off_inventory(p_balance_id uuid, p_quantity numeric, p_reason text, p_reference text default null, p_performed_by_name text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
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

  -- Only an available batch becomes depleted: a quarantined or blocked one keeps its status and reason.
  update public.inventory_batches batch set status='depleted',updated_at=now()
  where id=v_source.batch_id and batch.status='available'
    and not exists(select 1 from public.inventory_balances balance where balance.batch_id=batch.id and balance.quantity_on_hand>0);
  return v_movement_id;
end $$;

revoke all on function public.write_off_inventory(uuid,numeric,text,text,text) from public, anon, service_role;
grant execute on function public.write_off_inventory(uuid,numeric,text,text,text) to authenticated;

-- One-time repair, safe to repeat: a depleted batch that has stock is available.
update public.inventory_batches batch set status = 'available', updated_at = now()
where batch.status = 'depleted'
  and exists (select 1 from public.inventory_balances balance where balance.batch_id = batch.id and balance.quantity_on_hand > 0);
