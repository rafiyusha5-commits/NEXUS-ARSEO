-- «Вн расчеты» → поставка: цена из таблицы — в евро, и валюта позиции это отражает (аудит 24.11.2026, Б1).
-- 202611220400 передавал цену из таблицы в update_shipment_item, а валюту позиции не трогал: позиция без цены получала
-- цену в евро при пустой валюте, и расчёт себестоимости поставки останавливался на «не заполнена закупочная цена».
-- Запрет менять цену позиции в другой валюте был только на экране. Теперь в базе:
--   * новая цена позиции без валюты записывается вместе с валютой EUR;
--   * цену позиции в другой валюте таблица не меняет (отказ); количество меняется, если цена передана прежней;
--   * пустая цена оставляет цену позиции как есть (раньше функция её стирала; экран подставлял прежнюю цену).
-- Остальное — как в 202611220400: одна транзакция, отказ при изменённой после просмотра позиции, разнесённой по машинам
-- позиции, товаре, который уже есть в поставке, закрытой поставке и без права shipments.update.
begin;

create or replace function public.apply_order_workbook(p_shipment_id uuid, p_planned_ready_date date, p_add jsonb, p_update jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_shipment public.shipments%rowtype; v_item jsonb; v_row public.shipment_items%rowtype; v_price numeric;
        v_added integer := 0; v_updated integer := 0; v_eur uuid; v_can_price boolean;
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
  v_can_price := (select private.has_permission('prices.purchase.view'));
  for v_item in select * from jsonb_array_elements(coalesce(p_add, '[]')) loop
    if exists (select 1 from public.shipment_items where shipment_id = p_shipment_id and product_id = (v_item->>'product_id')::uuid) then
      raise exception 'Товар уже есть в поставке. Обновите страницу и проверьте изменения снова' using errcode = 'P0001';
    end if;
    perform public.create_shipment_item(p_shipment_id, (v_item->>'product_id')::uuid, 'piece', (v_item->>'quantity')::numeric,
      nullif(v_item->>'price', '')::numeric, case when nullif(v_item->>'price', '') is null then null else v_eur end);
    v_added := v_added + 1;
  end loop;
  for v_item in select * from jsonb_array_elements(coalesce(p_update, '[]')) loop
    select i.* into v_row from public.shipment_items i
     where i.id = (v_item->>'item_id')::uuid and i.shipment_id = p_shipment_id for update;
    if not found or v_row.ordered_quantity <> (v_item->>'seen_quantity')::numeric
       or v_row.unit_price is distinct from nullif(v_item->>'seen_price', '')::numeric
       or (select count(*) from public.shipment_items o where o.shipment_id = p_shipment_id and o.product_id = v_row.product_id) <> 1 then
      raise exception 'Позиция поставки изменилась после просмотра. Обновите страницу и проверьте изменения снова' using errcode = 'P0001';
    end if;
    -- An empty workbook price keeps the item's price.
    v_price := coalesce(nullif(v_item->>'price', '')::numeric, v_row.unit_price);
    if v_price is distinct from v_row.unit_price and v_row.currency_id <> v_eur then
      raise exception 'Цена позиции указана в другой валюте: «Вн расчеты» (евро) меняют у неё только количество' using errcode = 'P0001';
    end if;
    -- Without the purchase price right an unchanged price is not passed on: update_shipment_item keeps it.
    perform public.update_shipment_item(v_row.id, (v_item->>'quantity')::numeric,
      case when not v_can_price and v_price is not distinct from v_row.unit_price then null else v_price end);
    if v_price is distinct from v_row.unit_price and v_row.currency_id is null then
      update public.shipment_items set currency_id = v_eur, updated_at = now() where id = v_row.id;
    end if;
    v_updated := v_updated + 1;
  end loop;
  return jsonb_build_object('added', v_added, 'updated', v_updated, 'ready_date', p_planned_ready_date is not null);
end $$;
revoke all on function public.apply_order_workbook(uuid, date, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.apply_order_workbook(uuid, date, jsonb, jsonb) to authenticated;

commit;
