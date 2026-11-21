-- P5 of the audit of 2026-11-18 (docs/audit-2026-11-18.md): a manual price in a customer order ignored the customer's
-- margin threshold. Owner decisions of 2026-11-21 (rafiyusha5-commits):
--   * a manual price below the customer's threshold is allowed only with the separate right
--     sales.price_below_margin «Цена ниже порога маржи»; everybody else is refused;
--   * the margin of the line is the worst margin among its batches: the batches reserved for the line, otherwise the
--     batches that would ship first (nearest expiry) until they cover the quantity. A margin that cannot be computed
--     (no cost, rate, VAT rate, packaging, stock, price type or order currency) counts as below the threshold;
--   * the threshold is checked when the manual price is set and again when the order is confirmed.
-- A customer without a threshold (or with an empty one) is not checked, as in block 1Б. Prices from the price list,
-- fixed customer prices and commercial programme prices are not affected. Errors name no amounts or margins.
begin;

-- Right ------------------------------------------------------------------------------------------------------
insert into public.permissions(code, module, action, name, description)
values ('sales.price_below_margin', 'sales', 'price_below_margin', 'Цена ниже порога маржи: разрешение',
        'Ручная цена в клиентском заказе ниже порога маржи клиента или без проверки маржи, и подтверждение такого заказа')
on conflict (code) do nothing;

-- As before the change: whoever may change customer orders keeps the ability. Given once, at the first application.
insert into public.role_permissions(role_id, permission_id, granted)
select rp.role_id, p.id, true
  from public.role_permissions rp
  join public.permissions m on m.id = rp.permission_id and m.code = 'sales.manage' and rp.granted
  cross join public.permissions p
 where p.code = 'sales.price_below_margin'
   and not exists (select 1 from public.role_permissions x where x.permission_id = p.id)
on conflict (role_id, permission_id) do nothing;

-- Margin of an order line at its price -------------------------------------------------------------------------
-- Returns {checked, below, reason, threshold_pct, worst_margin_pct, batches}. below is true when the worst margin is
-- under the threshold or a margin cannot be computed. Internal only: the result is never shown to the employee.
create or replace function private.sale_line_margin_check(p_sale_id uuid, p_sale_item_id uuid, p_product_id uuid,
                                                          p_quantity numeric, p_uom text, p_unit_price numeric)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_sale public.sales;
  v_threshold numeric;
  v_terms public.customer_price_terms;
  v_type public.price_types;
  v_need numeric;
  v_have numeric := 0;
  v_free numeric;
  v_batch record;
  v_batches uuid[] := '{}';
  v_margin jsonb;
  v_worst numeric;
  v_reason text;
  v_id uuid;
begin
  select * into v_sale from public.sales where id = p_sale_id;
  v_threshold := (private.customer_margin_threshold(v_sale.customer_id)).threshold_pct;
  if v_threshold is null then
    return jsonb_build_object('checked', false, 'below', false, 'reason', 'no_threshold');
  end if;

  select * into v_terms from public.customer_price_terms t
   where t.customer_id = v_sale.customer_id and t.valid_from <= v_sale.sale_date
   order by t.valid_from desc, t.created_at desc, t.id desc limit 1;
  select * into v_type from public.price_types where id = v_terms.price_type_id;
  if v_type.id is null then
    v_reason := 'no_price_type';
  elsif v_sale.currency_id is null then
    v_reason := 'order_currency_missing';
  end if;

  if v_reason is null then
    -- The batches reserved for the line; without a reservation, those that would ship first.
    if p_sale_item_id is not null then
      select coalesce(array_agg(distinct r.batch_id), '{}') into v_batches
        from public.inventory_reservations r where r.sale_item_id = p_sale_item_id and r.status = 'active';
    end if;
    if cardinality(v_batches) = 0 then
      v_need := p_quantity * private.uom_pieces(p_product_id, p_uom);
      if v_need is null then
        v_reason := 'no_packaging';
      else
        for v_batch in select * from private.margin_batches(p_product_id) loop
          select coalesce(sum((a->>'quantity')::numeric * private.uom_pieces(p_product_id, a->>'uom')), 0) into v_free
            from jsonb_array_elements(v_batch.available) a;
          v_batches := v_batches || v_batch.batch_id;
          v_have := v_have + v_free;
          exit when v_have >= v_need;
        end loop;
      end if;
    end if;
  end if;

  if v_reason is null and cardinality(v_batches) = 0 then
    v_reason := 'no_stock';
  end if;
  if v_reason is null then
    foreach v_id in array v_batches loop
      v_margin := private.batch_margin(v_id, p_unit_price, v_sale.currency_id, p_uom, v_type.vat_included, v_type.market,
                                       v_sale.sale_date);
      if v_margin->>'margin_pct' is null then
        v_reason := coalesce(v_margin->>'reason', 'no_margin');
        exit;
      end if;
      v_worst := least(coalesce(v_worst, (v_margin->>'margin_pct')::numeric), (v_margin->>'margin_pct')::numeric);
    end loop;
  end if;

  return jsonb_build_object('checked', true, 'below', v_reason is not null or v_worst < v_threshold, 'reason', v_reason,
                            'threshold_pct', v_threshold, 'worst_margin_pct', v_worst, 'batches', cardinality(v_batches));
end $$;
revoke all on function private.sale_line_margin_check(uuid, uuid, uuid, numeric, text, numeric) from public, anon, authenticated, service_role;

-- What the employee is told: why, and who may do it. No amounts, no margins.
create or replace function private.margin_guard_message(p_check jsonb)
returns text
language sql immutable set search_path = '' as $$
  select case when p_check->>'reason' is null
    then 'Ручная цена ниже порога маржи клиента. Поставить её может сотрудник с правом «Цена ниже порога маржи»'
    else 'Маржу ручной цены не проверить: ' || case p_check->>'reason'
           when 'no_cost' then 'у партии нет себестоимости'
           when 'no_rate' then 'нет официального курса'
           when 'no_vat_rate' then 'нет ставки НДС'
           when 'no_packaging' then 'нет упаковки товара'
           when 'no_stock' then 'товара нет на складе'
           when 'no_price_type' then 'у клиента нет вида цены'
           when 'order_currency_missing' then 'у заказа нет валюты'
           when 'no_price' then 'цена не больше нуля'
           else 'нет данных' end
         || '. Поставить её может сотрудник с правом «Цена ниже порога маржи»' end
$$;
revoke all on function private.margin_guard_message(jsonb) from public, anon, authenticated, service_role;

-- When the price is set: every path that writes a manual price to a line (adding it, «Указать вручную», a direct
-- write) passes this trigger.
create or replace function private.sale_item_margin_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_check jsonb;
begin
  if new.price_source is distinct from 'manual' then return new; end if;
  if tg_op = 'UPDATE' and old.price_source = 'manual' and old.unit_price is not distinct from new.unit_price then return new; end if;
  if (select private.has_permission('sales.price_below_margin')) then return new; end if;
  v_check := private.sale_line_margin_check(new.sale_id, case when tg_op = 'UPDATE' then new.id end, new.product_id,
                                            new.quantity, new.uom, new.unit_price);
  if (v_check->>'below')::boolean then
    raise exception '%', private.margin_guard_message(v_check) using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function private.sale_item_margin_guard() from public, anon, authenticated, service_role;
drop trigger if exists sale_item_margin_guard on public.sale_items;
create trigger sale_item_margin_guard before insert or update of unit_price, price_source on public.sale_items
  for each row execute function private.sale_item_margin_guard();

-- When the order is confirmed: cost, rates and reservations may have changed since the price was set. Runs after
-- sales_price_guard (no line without a price) and before the credit check, by trigger name.
create or replace function private.sales_price_margin_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_item public.sale_items;
  v_count integer := 0;
begin
  if new.status = 'confirmed' and old.status is distinct from 'confirmed' then
    if (select private.has_permission('sales.price_below_margin')) then return new; end if;
    for v_item in select * from public.sale_items where sale_id = new.id and price_source = 'manual' loop
      if (private.sale_line_margin_check(new.id, v_item.id, v_item.product_id, v_item.quantity, v_item.uom,
                                         v_item.unit_price)->>'below')::boolean then
        v_count := v_count + 1;
      end if;
    end loop;
    if v_count > 0 then
      raise exception 'Подтвердить заказ нельзя: строк с ручной ценой ниже порога маржи клиента или без проверки маржи — %. Подтвердить может сотрудник с правом «Цена ниже порога маржи»', v_count
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.sales_price_margin_guard() from public, anon, authenticated, service_role;
drop trigger if exists sales_price_margin_guard on public.sales;
create trigger sales_price_margin_guard before update of status on public.sales
  for each row execute function private.sales_price_margin_guard();

commit;
