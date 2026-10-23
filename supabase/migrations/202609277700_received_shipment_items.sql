-- A received shipment item stays as received.
--
-- allocate_shipment_item checked only that the shipment was not closed, so an item already received with one
-- truck could be moved to another truck and received a second time: the stock grew twice for one delivery
-- (audit 13.10.2026, H1). Goods could also be moved into a truck that was already received, where they would
-- never reach the stock. Now:
--   * a received item (it has a line in shipment_transport_receipt_items) cannot be moved to another truck;
--   * nothing can be moved into a truck that has been received;
--   * a received item keeps its ordered quantity (the basis of the recorded shortage or overage); its price may
--     still be corrected for costing;
--   * deleting a received item is refused with a clear message instead of a foreign key error.

create or replace function private.shipment_item_is_received(p_item_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.shipment_transport_receipt_items line where line.shipment_item_id = p_item_id)
$$;
revoke all on function private.shipment_item_is_received(uuid) from public, anon, authenticated, service_role;

create or replace function public.allocate_shipment_item(p_item_id uuid, p_transport_id uuid, p_quantity numeric)
returns uuid
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
  if not private.can_write_shipments('update') then
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
  -- A received item is already in stock: moving it would make the other truck receive it again.
  if private.shipment_item_is_received(p_item_id) then
    raise exception 'Позиция уже принята на склад: перенести её в другой автомобиль нельзя';
  end if;
  -- A received truck is not received again, so goods moved into it would never reach the stock.
  if p_transport_id is not null and exists (
    select 1 from public.shipment_transport_receipts receipt where receipt.shipment_transport_id = p_transport_id
  ) then
    raise exception 'Автомобиль уже принят: добавить в него товар нельзя';
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

create or replace function public.update_shipment_item(p_item_id uuid, p_quantity numeric, p_unit_price numeric default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_locked boolean;v_quantity numeric;v_can_price boolean:=(select private.has_permission('prices.purchase.view'));begin
 if not private.can_write_shipments('update') then raise exception 'Недостаточно прав для изменения товара' using errcode='42501';end if;
 if p_quantity is null or p_quantity<=0 then raise exception 'Количество должно быть больше нуля';end if;
 if p_unit_price is not null and not v_can_price then raise exception 'Нет права изменять закупочную цену' using errcode='42501';end if;
 if p_unit_price is not null and p_unit_price<0 then raise exception 'Цена не может быть отрицательной';end if;
 select s.is_locked,i.ordered_quantity into v_locked,v_quantity from public.shipment_items i join public.shipments s on s.id=i.shipment_id where i.id=p_item_id for update of i;
 if not found then raise exception 'Позиция поставки не найдена';end if;
 if v_locked then raise exception 'Закрытая поставка недоступна для изменений';end if;
 -- After receiving, the ordered quantity is the basis of the recorded shortage or overage; only the price may change.
 if p_quantity<>v_quantity and private.shipment_item_is_received(p_item_id) then
  raise exception 'Позиция уже принята на склад: менять количество нельзя, только цену';
 end if;
 update public.shipment_items set ordered_quantity=p_quantity,
  unit_price=case when v_can_price then p_unit_price else unit_price end,updated_at=now() where id=p_item_id;
end $$;

create or replace function public.delete_shipment_item(p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_locked boolean;
begin
  if not private.can_write_shipments('update') then
    raise exception 'Недостаточно прав для удаления товара';
  end if;
  select shipment.is_locked into v_locked
  from public.shipment_items item
  join public.shipments shipment on shipment.id = item.shipment_id
  where item.id = p_item_id
  for update of item;
  if not found then raise exception 'Позиция поставки не найдена'; end if;
  if v_locked then raise exception 'Закрытая поставка недоступна для изменений'; end if;
  if private.shipment_item_is_received(p_item_id) then
    raise exception 'Позиция уже принята на склад: удалить её нельзя';
  end if;
  delete from public.shipment_items where id = p_item_id;
end $$;

revoke all on function public.allocate_shipment_item(uuid,uuid,numeric) from public, anon, service_role;
revoke all on function public.update_shipment_item(uuid,numeric,numeric) from public, anon, service_role;
revoke all on function public.delete_shipment_item(uuid) from public, anon, service_role;
grant execute on function public.allocate_shipment_item(uuid,uuid,numeric) to authenticated;
grant execute on function public.update_shipment_item(uuid,numeric,numeric) to authenticated;
grant execute on function public.delete_shipment_item(uuid) to authenticated;
