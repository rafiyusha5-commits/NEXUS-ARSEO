-- Prices of order lines after the price list (follow-up of 202611170100 and 202611170200).
-- Owner decisions of 2026-11-18 (damirator1-afk), see docs/sales-price-list.md:
--   * an order cannot be confirmed while one of its lines has no price: the debt of the customer would otherwise
--     miss those lines. Orders confirmed before this migration keep their state;
--   * a line already in the order gets its price in two ways, in a draft or a reserved order only:
--     "recalculate from the price list" (a rate or a condition appeared later) and "set by hand" with a reason;
--     every change is kept in an append-only history and shown in the order history;
--   * a product without a brand in the brand directory is priced like a product whose brand has no condition:
--     the price list price without percent, with the note brand_missing (was: no price, reason no_brand).
-- The price of a commercial program line with a target price is the agreed program price: it is changed in the
-- program, not in the order.
begin;

create or replace function private.resolve_customer_price(p_customer_id uuid, p_product_id uuid, p_uom text,
                                                          p_date date, p_currency_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_terms public.customer_price_terms;
  v_type public.price_types;
  v_fixed public.customer_fixed_prices;
  v_entry public.price_list_entries;
  v_brand uuid;
  v_markup public.customer_brand_markups;
  v_pieces numeric;
  v_rate record;
  v_base numeric;
  v_price numeric;
  v_result jsonb;
begin
  if p_uom is null or p_uom not in ('piece', 'box', 'layer', 'pallet', 'truck') then
    return jsonb_build_object('price', null, 'reason', 'invalid_uom');
  end if;
  v_pieces := private.uom_pieces(p_product_id, p_uom);
  select * into v_terms from public.customer_price_terms t
   where t.customer_id = p_customer_id and t.valid_from <= p_date
   order by t.valid_from desc, t.created_at desc, t.id desc limit 1;
  if v_terms.id is null then
    return jsonb_build_object('price', null, 'reason', 'no_price_type');
  end if;
  select * into v_type from public.price_types where id = v_terms.price_type_id;
  v_result := jsonb_build_object('price_type', v_type.code, 'price_type_name', v_type.name, 'vat_included', v_type.vat_included,
                                 'contract_currency', (select code from public.currencies where id = v_terms.contract_currency_id),
                                 'uom', p_uom, 'pieces_per_uom', v_pieces, 'date', p_date);
  if p_currency_id is not null and p_currency_id <> v_terms.contract_currency_id then
    return v_result || jsonb_build_object('price', null, 'reason', 'currency_mismatch');
  end if;
  if v_pieces is null then
    return v_result || jsonb_build_object('price', null, 'reason', 'no_packaging');
  end if;

  select * into v_fixed from public.customer_fixed_prices f
   where f.customer_id = p_customer_id and f.product_id = p_product_id and f.valid_from <= p_date
   order by f.valid_from desc, f.created_at desc, f.id desc limit 1;
  if v_fixed.id is not null and v_fixed.price is not null then
    if v_fixed.currency_id <> v_terms.contract_currency_id then
      return v_result || jsonb_build_object('price', null, 'reason', 'fixed_price_currency');
    end if;
    return v_result || jsonb_build_object(
      'price', round(v_fixed.price * v_pieces, 2), 'source', 'fixed', 'fixed_price_id', v_fixed.id,
      'base_price', v_fixed.price, 'base_currency', (select code from public.currencies where id = v_fixed.currency_id),
      'percent', null, 'brand', null, 'rate', null, 'rate_date', null, 'rate_path', null);
  end if;

  v_entry := private.price_on(v_type.id, p_product_id, p_date);
  if v_entry.id is null then
    return v_result || jsonb_build_object('price', null, 'reason', 'no_price');
  end if;
  -- No brand in the brand directory is the same as no condition for the brand: price list price without percent.
  v_brand := private.product_brand(p_product_id);
  if v_brand is not null then
    select * into v_markup from public.customer_brand_markups m
     where m.customer_id = p_customer_id and m.brand_id = v_brand and m.valid_from <= p_date
     order by m.valid_from desc, m.created_at desc, m.id desc limit 1;
  end if;

  select * into v_rate from private.official_conversion(v_type.currency_id, v_terms.contract_currency_id, p_date);
  if v_rate.rate is null then
    return v_result || jsonb_build_object('price', null, 'reason', 'no_rate',
      'base_currency', (select code from public.currencies where id = v_type.currency_id));
  end if;
  v_base := v_entry.price * v_rate.rate;
  v_price := round(v_base * (1 + coalesce(v_markup.percent, 0) / 100) * v_pieces, 2);
  return v_result || jsonb_build_object(
    'price', v_price, 'source', 'price_list', 'price_list_entry_id', v_entry.id,
    'base_price', v_entry.price, 'base_currency', (select code from public.currencies where id = v_type.currency_id),
    'brand', (select name from public.brands where id = v_brand),
    'percent', v_markup.percent,
    'note', case when v_brand is null then 'brand_missing' when v_markup.percent is null then 'brand_condition_missing' end,
    'rate', v_rate.rate, 'rate_date', v_rate.rate_date, 'rate_path', v_rate.path);
end $$;
revoke all on function private.resolve_customer_price(uuid, uuid, text, date, uuid) from public, anon, authenticated, service_role;


-- History of price changes of order lines. Append only.
create table if not exists public.sale_item_price_changes (
  id uuid primary key default gen_random_uuid(),
  sale_item_id uuid not null references public.sale_items(id) on delete restrict,
  sale_id uuid not null references public.sales(id) on delete restrict,
  kind text not null check (kind in ('recalculated', 'manual')),
  previous_price numeric(14, 4),
  previous_source text,
  new_price numeric(14, 4) not null check (new_price >= 0),
  new_source text not null,
  reason text check (reason is null or length(reason) between 3 and 1000),
  price_snapshot jsonb,
  changed_by uuid not null references public.profiles(id) on delete restrict,
  changed_at timestamptz not null default clock_timestamp(),
  check ((kind = 'manual') = (reason is not null))
);
create index if not exists sale_item_price_changes_item_idx on public.sale_item_price_changes(sale_item_id, changed_at);
create index if not exists sale_item_price_changes_sale_idx on public.sale_item_price_changes(sale_id, changed_at);
create index if not exists sale_item_price_changes_changed_by_idx on public.sale_item_price_changes(changed_by);
alter table public.sale_item_price_changes enable row level security;
revoke all on public.sale_item_price_changes from public, anon, authenticated, service_role;
grant select on public.sale_item_price_changes to authenticated;
drop policy if exists "employees view sale item price changes" on public.sale_item_price_changes;
create policy "employees view sale item price changes" on public.sale_item_price_changes
  for select to authenticated using ((select private.has_permission('sales.view')));

create or replace function private.guard_sale_item_price_history() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'История цен заказа неизменяема' using errcode = '42501';
end $$;
revoke all on function private.guard_sale_item_price_history() from public, anon, authenticated, service_role;
drop trigger if exists sale_item_price_changes_immutable on public.sale_item_price_changes;
create trigger sale_item_price_changes_immutable before update or delete on public.sale_item_price_changes
  for each row execute function private.guard_sale_item_price_history();

-- No confirmation while a line has no price, whatever confirms the order. Runs before the credit check
-- (sales_receivables_guard), which counts only priced lines.
create or replace function private.sales_price_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if new.status = 'confirmed' and old.status is distinct from 'confirmed' then
    select count(*) into v_count from public.sale_items where sale_id = new.id and unit_price is null;
    if v_count > 0 then
      raise exception 'Подтвердить заказ нельзя: позиций без цены — %. Укажите цену в строках заказа: «Пересчитать из прайса» или «Указать вручную»', v_count
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.sales_price_guard() from public, anon, authenticated, service_role;
drop trigger if exists sales_price_guard on public.sales;
create trigger sales_price_guard before update of status on public.sales
  for each row execute function private.sales_price_guard();

-- The line and its order, locked, for a price change. The order first, as everywhere else.
create or replace function private.lock_sale_item_for_price(p_sale_item_id uuid)
returns public.sale_items
language plpgsql security definer set search_path = '' as $$
declare
  v_sale_id uuid;
  v_item public.sale_items;
begin
  if not (select private.has_permission('sales.manage')) then
    raise exception 'Нет права изменять клиентские заказы' using errcode = '42501';
  end if;
  select sale_id into v_sale_id from public.sale_items where id = p_sale_item_id;
  perform 1 from public.sales where id = v_sale_id and status in ('draft', 'reserved') for update;
  if not found then raise exception 'Цену можно менять только в черновике или зарезервированном заказе до подтверждения'; end if;
  select * into v_item from public.sale_items where id = p_sale_item_id for update;
  if v_item.id is null then raise exception 'Позиция заказа не найдена'; end if;
  if v_item.price_source = 'commercial_program' then
    raise exception 'Цена программы согласована в коммерческой программе: она меняется в программе, а не в заказе';
  end if;
  return v_item;
end $$;
revoke all on function private.lock_sale_item_for_price(uuid) from public, anon, authenticated, service_role;

-- "Recalculate from the price list": the price the line would get now, on the order date in the order currency.
-- No price in the price list: the price does not change and the answer says why.
create or replace function public.reprice_customer_order_item(p_sale_item_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_item public.sale_items;
  v_sale public.sales;
  v_quote jsonb;
  v_price numeric;
begin
  v_item := private.lock_sale_item_for_price(p_sale_item_id);
  select * into v_sale from public.sales where id = v_item.sale_id;
  if v_sale.currency_id is null then
    v_quote := jsonb_build_object('price', null, 'reason', 'order_currency_missing', 'date', v_sale.sale_date);
  else
    v_quote := private.resolve_customer_price(v_sale.customer_id, v_item.product_id, v_item.uom, v_sale.sale_date, v_sale.currency_id);
  end if;
  v_price := (v_quote->>'price')::numeric;
  if v_price is null then
    -- Still no price: a line without a price shows the current reason; a priced line is left as it is.
    if v_item.unit_price is null and v_item.price_snapshot is distinct from v_quote then
      update public.sale_items set price_source = 'none', price_snapshot = v_quote where id = v_item.id;
    end if;
    return jsonb_build_object('changed', false, 'quote', v_quote);
  end if;
  -- The same price from the same source: nothing to record (a repeated click changes nothing).
  if v_item.unit_price is not distinct from v_price and v_item.price_source is not distinct from (v_quote->>'source')
     and v_item.price_snapshot is not distinct from v_quote then
    return jsonb_build_object('changed', false, 'quote', v_quote);
  end if;
  update public.sale_items
     set unit_price = v_price, price_source = v_quote->>'source', price_snapshot = v_quote,
         price_reason = null, price_set_by = null
   where id = v_item.id;
  insert into public.sale_item_price_changes(sale_item_id, sale_id, kind, previous_price, previous_source,
                                             new_price, new_source, reason, price_snapshot, changed_by)
  values (v_item.id, v_item.sale_id, 'recalculated', v_item.unit_price, v_item.price_source,
          v_price, v_quote->>'source', null, v_quote, auth.uid());
  return jsonb_build_object('changed', true, 'quote', v_quote);
end $$;
revoke all on function public.reprice_customer_order_item(uuid) from public, anon, authenticated, service_role;
grant execute on function public.reprice_customer_order_item(uuid) to authenticated;

-- "Set by hand": a price with a reason, as when the line is added with a manual price. The price list quote of the
-- moment is kept next to it.
create or replace function public.set_customer_order_item_price(p_sale_item_id uuid, p_unit_price numeric, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_item public.sale_items;
  v_sale public.sales;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_quote jsonb;
begin
  v_item := private.lock_sale_item_for_price(p_sale_item_id);
  if p_unit_price is null or p_unit_price < 0 then raise exception 'Укажите цену не меньше нуля'; end if;
  if v_reason is null or length(v_reason) not between 3 and 1000 then raise exception 'Укажите причину ручной цены'; end if;
  if v_item.price_source = 'manual' and v_item.unit_price = p_unit_price and v_item.price_reason = v_reason then
    return;
  end if;
  select * into v_sale from public.sales where id = v_item.sale_id;
  v_quote := case when v_sale.currency_id is null
                  then jsonb_build_object('price', null, 'reason', 'order_currency_missing', 'date', v_sale.sale_date)
                  else private.resolve_customer_price(v_sale.customer_id, v_item.product_id, v_item.uom, v_sale.sale_date, v_sale.currency_id) end;
  update public.sale_items
     set unit_price = p_unit_price, price_source = 'manual', price_snapshot = jsonb_build_object('price_list_quote', v_quote),
         price_reason = v_reason, price_set_by = auth.uid()
   where id = v_item.id;
  insert into public.sale_item_price_changes(sale_item_id, sale_id, kind, previous_price, previous_source,
                                             new_price, new_source, reason, price_snapshot, changed_by)
  values (v_item.id, v_item.sale_id, 'manual', v_item.unit_price, v_item.price_source,
          p_unit_price, 'manual', v_reason, jsonb_build_object('price_list_quote', v_quote), auth.uid());
end $$;
revoke all on function public.set_customer_order_item_price(uuid, numeric, text) from public, anon, authenticated, service_role;
grant execute on function public.set_customer_order_item_price(uuid, numeric, text) to authenticated;

commit;
