-- Audit 2026-10-13, finding Н7 (docs/audit-2026-10-13.md). A truck that had been received could be set back to
-- "planned" or "cancelled": its stock stayed on the warehouse, and a cancelled truck dropped out of the document
-- check, so its CMR and waybills were no longer required. "Unloaded" could also be set by hand without a receipt,
-- after which the truck could not be received (receiving requires "arrived").
-- Now the receipt fixes the status: a received truck stays "unloaded", and only receiving sets "unloaded".
-- Before the receipt the status may still be corrected freely, as before.
create or replace function public.change_shipment_transport_status(p_transport_id uuid, p_status text)
returns void language plpgsql security definer set search_path='' as $$
declare v_locked boolean; v_status text;
begin
  if not private.can_write_shipments('change_status') then
    raise exception 'Недостаточно прав для изменения перевозки';
  end if;
  if p_status not in ('planned','loading','in_transit','at_customs','arrived','unloaded','cancelled') then
    raise exception 'Некорректный статус перевозки';
  end if;
  select shipment.is_locked, transport.status into v_locked, v_status
  from public.shipment_transports transport
  join public.shipments shipment on shipment.id = transport.shipment_id
  where transport.id = p_transport_id
  for update of transport;
  if not found then raise exception 'Перевозка не найдена'; end if;
  if v_locked then raise exception 'Закрытая поставка недоступна для изменений'; end if;
  if exists (select 1 from public.shipment_transport_receipts where shipment_transport_id = p_transport_id) then
    if p_status = v_status then return; end if;
    raise exception 'Автомобиль уже принят на склад: его статус больше не меняется';
  end if;
  if p_status = 'unloaded' and v_status <> 'unloaded' then
    raise exception 'Статус «Разгружен» ставит приёмка: переведите автомобиль в «Прибыл» и примите товар';
  end if;
  update public.shipment_transports set
    status = p_status,
    actual_loading_date = case when p_status in ('loading','in_transit','at_customs','arrived','unloaded') then coalesce(actual_loading_date,current_date) else actual_loading_date end,
    actual_arrival_date = case when p_status in ('arrived','unloaded') then coalesce(actual_arrival_date,current_date) else actual_arrival_date end,
    updated_at = now()
  where id = p_transport_id;
end $$;

revoke all on function public.change_shipment_transport_status(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.change_shipment_transport_status(uuid,text) to authenticated;
