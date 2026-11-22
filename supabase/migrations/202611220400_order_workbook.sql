-- «Вн расчеты» → поставка (2026-11-22). The employee reviews what the order workbook of the shipment's Drive folder
-- would change and applies the ticked changes in one transaction: the planned ready date (the factory loading date),
-- new supplier order lines and changed quantities or invoice prices of existing single lines. Every change goes
-- through the existing item functions and their permission, price and receiving rules. An item changed since the
-- employee looked at it stops the whole apply. Lines split across vehicles are not touched here. Google Sheets is
-- only read; this function receives the reviewed values, never a sheet.
begin;

create or replace function public.apply_order_workbook(p_shipment_id uuid, p_planned_ready_date date, p_add jsonb, p_update jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_shipment public.shipments%rowtype; v_item jsonb; v_added integer := 0; v_updated integer := 0; v_eur uuid;
begin
  if not private.can_write_shipments('update') then raise exception 'Недостаточно прав для изменения поставки' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(p_add, '[]')) <> 'array' or jsonb_typeof(coalesce(p_update, '[]')) <> 'array'
     or jsonb_array_length(coalesce(p_add, '[]')) + jsonb_array_length(coalesce(p_update, '[]')) > 500 then
    raise exception 'Некорректный список изменений' using errcode = 'P0001';
  end if;
  select * into v_shipment from public.shipments where id = p_shipment_id for update;
  if not found then raise exception 'Поставка недоступна' using errcode = 'P0001'; end if;
  if v_shipment.is_locked or v_shipment.status in ('closed', 'cancelled') then raise exception 'Поставка закрыта для изменений' using errcode = 'P0001'; end if;
  if p_planned_ready_date is not null then
    if p_planned_ready_date not between date '2000-01-01' and date '2100-12-31' then raise exception 'Некорректная дата готовности' using errcode = 'P0001'; end if;
    update public.shipments set planned_ready_date = p_planned_ready_date, updated_at = now() where id = p_shipment_id;
  end if;
  -- Workbook prices are in euro.
  select id into v_eur from public.currencies where code = 'EUR';
  for v_item in select * from jsonb_array_elements(coalesce(p_add, '[]')) loop
    if exists (select 1 from public.shipment_items where shipment_id = p_shipment_id and product_id = (v_item->>'product_id')::uuid) then
      raise exception 'Товар уже есть в поставке. Обновите страницу и проверьте изменения снова' using errcode = 'P0001';
    end if;
    perform public.create_shipment_item(p_shipment_id, (v_item->>'product_id')::uuid, 'piece', (v_item->>'quantity')::numeric,
      nullif(v_item->>'price', '')::numeric, case when nullif(v_item->>'price', '') is null then null else v_eur end);
    v_added := v_added + 1;
  end loop;
  for v_item in select * from jsonb_array_elements(coalesce(p_update, '[]')) loop
    if not exists (select 1 from public.shipment_items i where i.id = (v_item->>'item_id')::uuid and i.shipment_id = p_shipment_id
        and i.ordered_quantity = (v_item->>'seen_quantity')::numeric and i.unit_price is not distinct from nullif(v_item->>'seen_price', '')::numeric
        and (select count(*) from public.shipment_items o where o.shipment_id = p_shipment_id and o.product_id = i.product_id) = 1) then
      raise exception 'Позиция поставки изменилась после просмотра. Обновите страницу и проверьте изменения снова' using errcode = 'P0001';
    end if;
    perform public.update_shipment_item((v_item->>'item_id')::uuid, (v_item->>'quantity')::numeric, nullif(v_item->>'price', '')::numeric);
    v_updated := v_updated + 1;
  end loop;
  return jsonb_build_object('added', v_added, 'updated', v_updated, 'ready_date', p_planned_ready_date is not null);
end $$;
revoke all on function public.apply_order_workbook(uuid, date, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.apply_order_workbook(uuid, date, jsonb, jsonb) to authenticated;

commit;
