-- Block 1a: sales price list, customer price conditions, brands, VAT setting and the price a customer gets.
-- Owner decisions of 2026-11-16/17 (damirator1-afk), see docs/sales-price-list.md.
--
-- The price list is built only from data Nexus already holds: the calculator snapshot imported read-only into
-- public.product_master_data (sales columns). No new Google access. Every price is a dated, append-only entry
-- with its origin (calculator or manual) and source snapshot; nothing is ever overwritten.
-- Substitution into customer orders is block 1b; this migration only provides the rules and a quote function.
begin;

-- Rights ---------------------------------------------------------------------------------------------------
insert into public.permissions(code, module, action, name, description)
values ('pricing.list.manage', 'pricing', 'list_manage', 'Прайс: изменение',
        'Загрузка цен из калькулятора, ручная корректировка, бренды и ставка НДС')
on conflict (code) do nothing;

insert into public.permissions(code, module, action, name, description)
values ('pricing.customer_terms.manage', 'pricing', 'customer_terms_manage', 'Условия цен клиентов: изменение',
        'Вид цены, валюта контракта, процент по бренду и фиксированные цены клиента')
on conflict (code) do nothing;

insert into public.role_permissions(role_id, permission_id, granted)
select r.id, p.id, true
  from public.app_roles r
  cross join public.permissions p
 where (p.code = 'pricing.list.manage' and r.code = 'administrator')
    or (p.code = 'pricing.customer_terms.manage' and r.code in ('administrator', 'commercial_director'))
on conflict (role_id, permission_id) do nothing;

-- Price types ----------------------------------------------------------------------------------------------
create table if not exists public.price_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  name text not null check (length(btrim(name)) between 2 and 120),
  market text not null check (market in ('KZ', 'RU', 'KG')),
  currency_id uuid not null references public.currencies(id),
  vat_included boolean not null,
  payment_terms text check (payment_terms in ('prepayment', 'realization', 'consignment')),
  is_reference boolean not null default false,
  source_column_key text,
  source_position integer check (source_position > 0),
  source_field_ru text,
  is_active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  check ((source_column_key is null) = (source_position is null)),
  check ((source_column_key is null) = (source_field_ru is null))
);

alter table public.price_types enable row level security;
revoke all on public.price_types from public, anon, authenticated, service_role;

-- Calculator keys verified on 2026-11-16 by running the Nexus parser on the owner's file. The established
-- prices carry the ".2" suffix: the unsuffixed keys at positions 63/64/68 are calculated prices that the parser
-- labels as established (reported separately). Position and label are checked at every import.
insert into public.price_types(code, name, market, currency_id, vat_included, payment_terms, is_reference,
                               source_column_key, source_position, source_field_ru, sort_order)
select v.code, v.name, v.market, c.id, v.vat, v.terms, v.reference, v.key, v.position, v.field, v.sort_order
  from (values
    ('kz_prepayment', 'Казахстан, предоплата', 'KZ', 'KZT', true, 'prepayment', false,
     'source.установленные_цены.цп_в_кз_сеть_с_ндс_тенге.2', 72, 'ЦП в КЗ сеть с НДС, тенге', 10),
    ('kz_realization', 'Казахстан, реализация', 'KZ', 'KZT', true, 'realization', false,
     'source.установленные_цены.цп_в_кз_сеть_с_ндс_тенге_реализация.2', 73, 'ЦП в КЗ сеть с НДС, тенге (РЕАЛИЗАЦИЯ)', 20),
    ('kz_consignment', 'Казахстан, консигнация', 'KZ', 'KZT', true, 'consignment', false,
     null, null, null, 30),
    ('export_ru', 'Экспорт в Россию', 'RU', 'KZT', false, null, false,
     'source.установленные_цены.россия_dap_рц_мск_без_ндс_kzt.2', 76, 'РОССИЯ DAP РЦ МСК, БЕЗ НДС KZT', 40),
    ('lenta', 'Лента', 'RU', 'KZT', false, null, false,
     'source.установленные_цены.цп_лента', 78, 'ЦП Лента', 50),
    ('export_kg', 'Экспорт в Кыргызстан', 'KG', 'EUR', false, null, false,
     'source.установленные_цены.кыргызстан_exw_ala_без_ндс_eur', 79, 'КЫРГЫЗСТАН EXW ALA БЕЗ НДС EUR', 60),
    ('kz_rrp', 'РРЦ, справочно', 'KZ', 'KZT', true, null, true,
     'source.установленные_цены.ррц_тенге.2', 74, 'РРЦ, тенге', 90)
  ) v(code, name, market, currency, vat, terms, reference, key, position, field, sort_order)
  join public.currencies c on c.code = v.currency
on conflict (code) do nothing;

-- Price list entries: append-only history --------------------------------------------------------------------
create table if not exists public.price_list_entries (
  id uuid primary key default gen_random_uuid(),
  price_type_id uuid not null references public.price_types(id),
  product_id uuid not null references public.products(id),
  price numeric(14, 4) not null check (price > 0),
  uom text not null default 'piece' check (uom = 'piece'),
  valid_from date not null,
  origin text not null check (origin in ('calculator', 'manual')),
  reason text check (reason is null or length(btrim(reason)) between 3 and 1000),
  source jsonb not null default '{}'::jsonb check (jsonb_typeof(source) = 'object'),
  request_id uuid,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp(),
  check (origin <> 'manual' or reason is not null)
);

create index if not exists price_list_entries_lookup_idx
  on public.price_list_entries(price_type_id, product_id, valid_from desc, created_at desc);
create index if not exists price_list_entries_product_idx on public.price_list_entries(product_id);
create index if not exists price_list_entries_created_by_idx on public.price_list_entries(created_by);

alter table public.price_list_entries enable row level security;
revoke all on public.price_list_entries from public, anon, authenticated, service_role;

create table if not exists private.price_list_imports (
  id uuid primary key,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp(),
  stamp text not null,
  valid_from date not null,
  decisions jsonb not null,
  summary jsonb not null
);
alter table private.price_list_imports enable row level security;
revoke all on private.price_list_imports from public, anon, authenticated, service_role;

-- Brands -----------------------------------------------------------------------------------------------------
create or replace function private.brand_key(p_value text) returns text
language sql immutable set search_path = '' as $$
  select nullif(upper(regexp_replace(btrim(coalesce(p_value, '')), '\s+', ' ', 'g')), '')
$$;
revoke all on function private.brand_key(text) from public, anon, authenticated, service_role;

create table if not exists public.brands (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  brand_key text not null unique,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists brands_created_by_idx on public.brands(created_by);
alter table public.brands enable row level security;
revoke all on public.brands from public, anon, authenticated, service_role;

-- The brand of a product: exact match of the normalized text of products.brand with the directory.
-- Product cards are never rewritten; texts without a directory brand are listed as discrepancies.
create or replace function private.product_brand(p_product_id uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select b.id from public.products p join public.brands b on b.brand_key = private.brand_key(p.brand) where p.id = p_product_id
$$;
revoke all on function private.product_brand(uuid) from public, anon, authenticated, service_role;

-- Customer conditions: append-only, dated -------------------------------------------------------------------
create table if not exists public.customer_price_terms (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.counterparties(id),
  price_type_id uuid not null references public.price_types(id),
  contract_currency_id uuid not null references public.currencies(id),
  valid_from date not null,
  reason text not null check (length(btrim(reason)) between 3 and 1000),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists customer_price_terms_lookup_idx on public.customer_price_terms(customer_id, valid_from desc, created_at desc);
create index if not exists customer_price_terms_type_idx on public.customer_price_terms(price_type_id);
create index if not exists customer_price_terms_currency_idx on public.customer_price_terms(contract_currency_id);
create index if not exists customer_price_terms_created_by_idx on public.customer_price_terms(created_by);

create table if not exists public.customer_brand_markups (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.counterparties(id),
  brand_id uuid not null references public.brands(id),
  percent numeric(7, 3) check (percent is null or (percent > -100 and percent <= 1000)),
  valid_from date not null,
  reason text not null check (length(btrim(reason)) between 3 and 1000),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists customer_brand_markups_lookup_idx on public.customer_brand_markups(customer_id, brand_id, valid_from desc, created_at desc);
create index if not exists customer_brand_markups_brand_idx on public.customer_brand_markups(brand_id);
create index if not exists customer_brand_markups_created_by_idx on public.customer_brand_markups(created_by);

create table if not exists public.customer_fixed_prices (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.counterparties(id),
  product_id uuid not null references public.products(id),
  price numeric(14, 4) check (price is null or price > 0),
  currency_id uuid not null references public.currencies(id),
  uom text not null default 'piece' check (uom = 'piece'),
  valid_from date not null,
  reason text not null check (length(btrim(reason)) between 3 and 1000),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists customer_fixed_prices_lookup_idx on public.customer_fixed_prices(customer_id, product_id, valid_from desc, created_at desc);
create index if not exists customer_fixed_prices_product_idx on public.customer_fixed_prices(product_id);
create index if not exists customer_fixed_prices_currency_idx on public.customer_fixed_prices(currency_id);
create index if not exists customer_fixed_prices_created_by_idx on public.customer_fixed_prices(created_by);

create table if not exists public.vat_rates (
  id uuid primary key default gen_random_uuid(),
  country text not null check (country ~ '^[A-Z]{2}$'),
  rate numeric(6, 4) not null check (rate >= 0 and rate < 1),
  valid_from date not null,
  reason text not null check (length(btrim(reason)) between 3 and 1000),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists vat_rates_lookup_idx on public.vat_rates(country, valid_from desc, created_at desc);
create index if not exists vat_rates_created_by_idx on public.vat_rates(created_by);

alter table public.customer_price_terms enable row level security;
alter table public.customer_brand_markups enable row level security;
alter table public.customer_fixed_prices enable row level security;
alter table public.vat_rates enable row level security;
revoke all on public.customer_price_terms, public.customer_brand_markups, public.customer_fixed_prices, public.vat_rates
  from public, anon, authenticated, service_role;

-- History is never edited or deleted.
create or replace function private.guard_price_history() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'История цен неизменяема' using errcode = '42501';
end $$;
revoke all on function private.guard_price_history() from public, anon, authenticated, service_role;

drop trigger if exists price_list_entries_immutable on public.price_list_entries;
create trigger price_list_entries_immutable before update or delete on public.price_list_entries
  for each row execute function private.guard_price_history();
drop trigger if exists customer_price_terms_immutable on public.customer_price_terms;
create trigger customer_price_terms_immutable before update or delete on public.customer_price_terms
  for each row execute function private.guard_price_history();
drop trigger if exists customer_brand_markups_immutable on public.customer_brand_markups;
create trigger customer_brand_markups_immutable before update or delete on public.customer_brand_markups
  for each row execute function private.guard_price_history();
drop trigger if exists customer_fixed_prices_immutable on public.customer_fixed_prices;
create trigger customer_fixed_prices_immutable before update or delete on public.customer_fixed_prices
  for each row execute function private.guard_price_history();
drop trigger if exists vat_rates_immutable on public.vat_rates;
create trigger vat_rates_immutable before update or delete on public.vat_rates
  for each row execute function private.guard_price_history();

-- Access helpers ---------------------------------------------------------------------------------------------
create or replace function private.require_price_list_view() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (select private.has_permission('sales.view')) or not (select private.has_permission('products.view')) then
    raise exception 'Нет доступа к прайсу' using errcode = '42501';
  end if;
end $$;

create or replace function private.require_price_list_manage() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_price_list_view();
  if not (select private.has_permission('pricing.list.manage')) then
    raise exception 'Нет права изменять прайс' using errcode = '42501';
  end if;
end $$;

create or replace function private.require_customer_terms(p_customer_id uuid, p_write boolean) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_price_list_view();
  if not (select private.has_permission('customers.view'))
     or not exists (select 1 from public.counterparties c where c.id = p_customer_id and 'customer' = any(c.roles)) then
    raise exception 'Клиент не найден или недоступен' using errcode = '42501';
  end if;
  if p_write and not (select private.has_permission('pricing.customer_terms.manage')) then
    raise exception 'Нет права изменять условия цен клиента' using errcode = '42501';
  end if;
end $$;

revoke all on function private.require_price_list_view(), private.require_price_list_manage(), private.require_customer_terms(uuid, boolean)
  from public, anon, authenticated, service_role;

-- Effective values on a date ----------------------------------------------------------------------------------
create or replace function private.price_on(p_price_type_id uuid, p_product_id uuid, p_date date)
returns public.price_list_entries
language sql stable security definer set search_path = '' as $$
  select e.* from public.price_list_entries e
   where e.price_type_id = p_price_type_id and e.product_id = p_product_id and e.valid_from <= p_date
   order by e.valid_from desc, e.created_at desc, e.id desc
   limit 1
$$;

create or replace function private.vat_rate_on(p_country text, p_date date) returns numeric
language sql stable security definer set search_path = '' as $$
  select v.rate from public.vat_rates v
   where v.country = p_country and v.valid_from <= p_date
   order by v.valid_from desc, v.created_at desc, v.id desc
   limit 1
$$;

revoke all on function private.price_on(uuid, uuid, date), private.vat_rate_on(text, date) from public, anon, authenticated, service_role;

-- Official rate between two currencies on a date: the same day, else the latest official rate not older than
-- 7 days (owner decision). Direct pair, inverse pair, or through tenge with both legs of one date. Never a bank
-- rate, never 1 for different currencies. private.finance_rate (costing) is not changed.
create or replace function private.official_conversion(p_from uuid, p_to uuid, p_date date)
returns table(rate numeric, rate_date date, path text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_kzt uuid := (select id from public.currencies where code = 'KZT');
  v_day date;
  v_a numeric;
  v_b numeric;
begin
  if p_from = p_to then
    return query select 1::numeric, p_date, 'same'::text;
    return;
  end if;
  for v_day in select d::date from generate_series(p_date, p_date - 7, interval '-1 day') d loop
    select r.rate into v_a from public.exchange_rates r
     where r.source = 'official' and r.rate_date = v_day and r.base_currency_id = p_from and r.quote_currency_id = p_to
     order by r.created_at desc, r.id desc limit 1;
    if v_a is not null then
      return query select v_a, v_day, 'direct'::text;
      return;
    end if;
    select r.rate into v_a from public.exchange_rates r
     where r.source = 'official' and r.rate_date = v_day and r.base_currency_id = p_to and r.quote_currency_id = p_from
     order by r.created_at desc, r.id desc limit 1;
    if v_a is not null and v_a > 0 then
      return query select 1 / v_a, v_day, 'inverse'::text;
      return;
    end if;
    if p_from <> v_kzt and p_to <> v_kzt then
      select coalesce(
               (select r.rate from public.exchange_rates r where r.source = 'official' and r.rate_date = v_day
                   and r.base_currency_id = p_from and r.quote_currency_id = v_kzt order by r.created_at desc, r.id desc limit 1),
               (select 1 / r.rate from public.exchange_rates r where r.source = 'official' and r.rate_date = v_day
                   and r.base_currency_id = v_kzt and r.quote_currency_id = p_from and r.rate > 0 order by r.created_at desc, r.id desc limit 1))
        into v_a;
      select coalesce(
               (select r.rate from public.exchange_rates r where r.source = 'official' and r.rate_date = v_day
                   and r.base_currency_id = v_kzt and r.quote_currency_id = p_to order by r.created_at desc, r.id desc limit 1),
               (select 1 / r.rate from public.exchange_rates r where r.source = 'official' and r.rate_date = v_day
                   and r.base_currency_id = p_to and r.quote_currency_id = v_kzt and r.rate > 0 order by r.created_at desc, r.id desc limit 1))
        into v_b;
      if v_a is not null and v_b is not null then
        return query select v_a * v_b, v_day, 'via_kzt'::text;
        return;
      end if;
    end if;
  end loop;
end $$;
revoke all on function private.official_conversion(uuid, uuid, date) from public, anon, authenticated, service_role;

-- The price a customer gets for a product on a date, in the customer's contract currency. Never guesses:
-- a missing piece of data gives a reason instead of a price. Order of rules (owner decisions):
--   fixed price of the customer for the product -> price of the customer's price type with the customer's
--   percent for the product's brand (no condition: price list price, noted) ; currency conversion first,
--   then percent, then rounding to 2 decimals; another unit only through explicit packaging.
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
  v_brand := private.product_brand(p_product_id);
  if v_brand is null then
    return v_result || jsonb_build_object('price', null, 'reason', 'no_brand');
  end if;
  select * into v_markup from public.customer_brand_markups m
   where m.customer_id = p_customer_id and m.brand_id = v_brand and m.valid_from <= p_date
   order by m.valid_from desc, m.created_at desc, m.id desc limit 1;

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
    'note', case when v_markup.percent is null then 'brand_condition_missing' end,
    'rate', v_rate.rate, 'rate_date', v_rate.rate_date, 'rate_path', v_rate.path);
end $$;
revoke all on function private.resolve_customer_price(uuid, uuid, text, date, uuid) from public, anon, authenticated, service_role;

-- What the order would get: for the customer card and the price list screen. Read only.
create or replace function public.customer_price_quote(p_customer_id uuid, p_product_id uuid, p_uom text default 'piece',
                                                       p_date date default null, p_currency_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_customer_terms(p_customer_id, false);
  return private.resolve_customer_price(p_customer_id, p_product_id, p_uom, coalesce(p_date, private.business_today()), p_currency_id);
end $$;
revoke all on function public.customer_price_quote(uuid, uuid, text, date, uuid) from public, anon, authenticated, service_role;
grant execute on function public.customer_price_quote(uuid, uuid, text, date, uuid) to authenticated;

-- Import from the calculator snapshot ---------------------------------------------------------------------
create or replace function private.calculator_price_value(p_value jsonb) returns numeric
language plpgsql immutable set search_path = '' as $$
declare v_text text;
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    return null;
  end if;
  if jsonb_typeof(p_value) = 'number' then
    return (p_value #>> '{}')::numeric;
  end if;
  if jsonb_typeof(p_value) <> 'string' then
    return null;
  end if;
  v_text := replace(regexp_replace(btrim(p_value #>> '{}'), '[\s ]', '', 'g'), ',', '.');
  if v_text !~ '^[0-9]+(\.[0-9]+)?$' then
    return null;
  end if;
  return v_text::numeric;
end $$;
revoke all on function private.calculator_price_value(jsonb) from public, anon, authenticated, service_role;

-- One row per price type with a column and product with calculator data. Statuses:
--   new / unchanged / changed / conflict (a manual correction after the last import and the sheet changed) /
--   kept_manual (the sheet equals the last import, a manual correction stays) /
--   missing (the cell is empty while Nexus has a price: the price stays) / invalid.
-- An empty cell without a price in Nexus is not a row at all.
create or replace function private.price_list_import_rows(p_date date)
returns table(price_type_id uuid, product_id uuid, status text, sheet_value numeric, raw_value jsonb, current_price numeric,
              current_origin text, last_import_price numeric, source_row integer, imported_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with types as (
    select t.* from public.price_types t where t.is_active and t.source_column_key is not null
  ), data as (
    select t.id as type_id, d.product_id, d.source_row, d.imported_at, d.sales_data -> t.source_column_key as raw
      from types t cross join public.product_master_data d
     where d.source_key = 'arseo-master-calculator'
  ), enriched as (
    select x.*, private.calculator_price_value(x.raw) as value,
           cur.price as cur_price, cur.origin as cur_origin,
           (select e.price from public.price_list_entries e where e.price_type_id = x.type_id and e.product_id = x.product_id
               and e.origin = 'calculator' order by e.created_at desc, e.id desc limit 1) as last_import,
           exists(select 1 from public.price_list_entries e where e.price_type_id = x.type_id and e.product_id = x.product_id
               and e.origin = 'manual' and e.created_at > coalesce((select max(i.created_at) from public.price_list_entries i
                   where i.price_type_id = x.type_id and i.product_id = x.product_id and i.origin = 'calculator'), '-infinity')) as manual_after
      from data x
      left join lateral (select * from private.price_on(x.type_id, x.product_id, p_date)) cur on true
  )
  select type_id, product_id,
         case
           when raw is null or jsonb_typeof(raw) = 'null' or (jsonb_typeof(raw) = 'string' and btrim(raw #>> '{}') = '') then 'missing'
           when value is null or value <= 0 then 'invalid'
           when cur_price is null then 'new'
           when manual_after and value is distinct from last_import then 'conflict'
           when manual_after then 'kept_manual'
           when value = cur_price then 'unchanged'
           else 'changed'
         end,
         value, raw, cur_price, cur_origin, last_import, source_row, imported_at
    from enriched
   where cur_price is not null
      or not (raw is null or jsonb_typeof(raw) = 'null' or (jsonb_typeof(raw) = 'string' and btrim(raw #>> '{}') = ''))
$$;
revoke all on function private.price_list_import_rows(date) from public, anon, authenticated, service_role;

create or replace function private.price_list_import_structure() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('price_type', t.code, 'expected_key', t.source_column_key,
           'expected_position', t.source_position, 'expected_field', t.source_field_ru,
           'found', c.value) order by t.sort_order), '[]'::jsonb)
    from public.price_types t
    left join public.product_master_sources s on s.source_key = 'arseo-master-calculator'
    left join lateral (select x.value from jsonb_array_elements(s.columns) x where x.value->>'key' = t.source_column_key limit 1) c on true
   where t.is_active and t.source_column_key is not null
     and (c.value is null
          or (c.value->>'position')::integer is distinct from t.source_position
          or private.brand_key(c.value->>'field_ru') is distinct from private.brand_key(t.source_field_ru)
          or c.value->>'visibility' is distinct from 'sales')
$$;
revoke all on function private.price_list_import_structure() from public, anon, authenticated, service_role;

create or replace function public.price_list_import_preview(p_valid_from date default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_date date := coalesce(p_valid_from, private.business_today());
  v_problems jsonb;
  v_rows jsonb;
begin
  perform private.require_price_list_manage();
  v_problems := private.price_list_import_structure();
  if jsonb_array_length(v_problems) > 0 then
    return jsonb_build_object('ok', false, 'reason', 'structure_changed', 'problems', v_problems);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'price_type', t.code, 'price_type_name', t.name, 'product_id', r.product_id, 'sku', p.internal_sku,
           'product', coalesce(p.name->>'ru', p.internal_sku), 'status', r.status,
           'sheet_value', r.sheet_value::text, 'current_price', r.current_price::text, 'current_origin', r.current_origin,
           'last_import_price', r.last_import_price::text, 'source_row', r.source_row)
         order by t.sort_order, p.internal_sku), '[]'::jsonb)
    into v_rows
    from private.price_list_import_rows(v_date) r
    join public.price_types t on t.id = r.price_type_id
    join public.products p on p.id = r.product_id
   where r.status <> 'unchanged';
  return jsonb_build_object(
    'ok', true, 'valid_from', v_date,
    'counts', (select jsonb_object_agg(status, n) from (select status, count(*) n from private.price_list_import_rows(v_date) group by status) s),
    'rows', v_rows,
    'stamp', encode(sha256(convert_to(jsonb_build_object(
       'rows', (select jsonb_agg(to_jsonb(r) order by r.price_type_id, r.product_id) from private.price_list_import_rows(v_date) r),
       'date', v_date)::text, 'UTF8')), 'hex'));
end $$;
revoke all on function public.price_list_import_preview(date) from public, anon, authenticated, service_role;
grant execute on function public.price_list_import_preview(date) to authenticated;

-- Applies new and changed sheet prices; every conflict needs an explicit decision ("price_type:product_id" ->
-- "take_sheet" or "keep_manual"). Nothing is written to Google; nothing is overwritten silently.
create or replace function public.confirm_price_list_import(p_request_id uuid, p_stamp text, p_valid_from date,
                                                            p_decisions jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_preview jsonb;
  v_row record;
  v_key text;
  v_decision text;
  v_applied integer := 0;
  v_kept integer := 0;
  v_prior private.price_list_imports;
  v_source jsonb;
begin
  perform private.require_price_list_manage();
  if p_request_id is null or p_stamp is null or p_valid_from is null then
    raise exception 'Откройте предпросмотр загрузки заново';
  end if;
  if jsonb_typeof(coalesce(p_decisions, '{}'::jsonb)) <> 'object' then
    raise exception 'Некорректные решения по расхождениям';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('price-list-import', 0));
  select * into v_prior from private.price_list_imports where id = p_request_id;
  if found then
    if v_prior.created_by <> auth.uid() or v_prior.stamp <> p_stamp then
      raise exception 'Идентификатор загрузки уже использован';
    end if;
    return v_prior.summary;
  end if;
  lock table public.price_list_entries in share row exclusive mode;
  perform private.require_price_list_manage();
  v_preview := public.price_list_import_preview(p_valid_from);
  if not (v_preview->>'ok')::boolean then
    raise exception 'Структура таблицы изменилась. Загрузка остановлена';
  end if;
  if v_preview->>'stamp' is distinct from p_stamp then
    raise exception 'Данные изменились после предпросмотра. Откройте предпросмотр заново' using errcode = '40001';
  end if;
  for v_row in
    select r.*, t.code, t.source_column_key, t.source_position, d.imported_at as master_imported_at
      from private.price_list_import_rows(p_valid_from) r
      join public.price_types t on t.id = r.price_type_id
      join public.product_master_data d on d.product_id = r.product_id and d.source_key = 'arseo-master-calculator'
     where r.status in ('new', 'changed', 'conflict')
     order by t.sort_order, r.product_id
  loop
    v_key := v_row.code || ':' || v_row.product_id;
    v_decision := p_decisions->>v_key;
    if v_row.status = 'conflict' then
      if v_decision is null or v_decision not in ('take_sheet', 'keep_manual') then
        raise exception 'Выберите, что оставить, для каждого расхождения с ручной корректировкой';
      end if;
      if v_decision = 'keep_manual' then
        v_kept := v_kept + 1;
        continue;
      end if;
    end if;
    v_source := jsonb_build_object('column_key', v_row.source_column_key, 'position', v_row.source_position,
                                   'source_row', v_row.source_row, 'master_imported_at', v_row.master_imported_at,
                                   'raw', v_row.raw_value, 'import_id', p_request_id,
                                   'replaced_manual', v_row.status = 'conflict');
    insert into public.price_list_entries(price_type_id, product_id, price, valid_from, origin, reason, source, request_id, created_by)
    values (v_row.price_type_id, v_row.product_id, v_row.sheet_value, p_valid_from, 'calculator',
            case when v_row.status = 'conflict' then 'Выбрана цена таблицы вместо ручной корректировки' end,
            v_source, p_request_id, auth.uid());
    v_applied := v_applied + 1;
  end loop;
  insert into private.price_list_imports(id, created_by, stamp, valid_from, decisions, summary)
  values (p_request_id, auth.uid(), p_stamp, p_valid_from, coalesce(p_decisions, '{}'::jsonb),
          jsonb_build_object('applied', v_applied, 'kept_manual', v_kept, 'counts', v_preview->'counts'));
  return jsonb_build_object('applied', v_applied, 'kept_manual', v_kept, 'counts', v_preview->'counts');
end $$;
revoke all on function public.confirm_price_list_import(uuid, text, date, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.confirm_price_list_import(uuid, text, date, jsonb) to authenticated;

-- Manual correction by the price manager: with a reason and a start date; survives the next import.
create or replace function public.set_price_list_price(p_request_id uuid, p_price_type_id uuid, p_product_id uuid,
                                                       p_price numeric, p_valid_from date, p_reason text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform private.require_price_list_manage();
  if p_request_id is null then
    raise exception 'Обновите страницу';
  end if;
  select id into v_id from public.price_list_entries where request_id = p_request_id and origin = 'manual';
  if found then
    return v_id;
  end if;
  if p_price is null or p_price <= 0 or p_price > 1e10 then
    raise exception 'Укажите цену больше нуля';
  end if;
  if p_valid_from is null then
    raise exception 'Укажите дату начала действия';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 1000 then
    raise exception 'Укажите причину корректировки';
  end if;
  if not exists (select 1 from public.price_types where id = p_price_type_id and is_active)
     or not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'Вид цены или товар не найден';
  end if;
  insert into public.price_list_entries(price_type_id, product_id, price, valid_from, origin, reason, source, request_id, created_by)
  values (p_price_type_id, p_product_id, round(p_price, 4), p_valid_from, 'manual', btrim(p_reason), '{}'::jsonb, p_request_id, auth.uid())
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.set_price_list_price(uuid, uuid, uuid, numeric, date, text) from public, anon, authenticated, service_role;
grant execute on function public.set_price_list_price(uuid, uuid, uuid, numeric, date, text) to authenticated;

-- Reading the price list: sales prices only. Calculated prices, margins and costs are never returned here.
create or replace function public.price_list(p_date date default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_date date := coalesce(p_date, private.business_today());
begin
  perform private.require_price_list_view();
  return jsonb_build_object(
    'date', v_date,
    'types', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'code', t.code, 'name', t.name, 'market', t.market,
               'currency', c.code, 'vat_included', t.vat_included, 'payment_terms', t.payment_terms,
               'is_reference', t.is_reference, 'from_sheet', t.source_column_key is not null) order by t.sort_order), '[]'::jsonb)
               from public.price_types t join public.currencies c on c.id = t.currency_id where t.is_active),
    'products', (select coalesce(jsonb_agg(x.row order by x.sku), '[]'::jsonb) from (
       select p.internal_sku as sku, jsonb_build_object('id', p.id, 'sku', p.internal_sku, 'name', coalesce(p.name->>'ru', p.internal_sku),
              'brand', p.brand, 'brand_known', private.product_brand(p.id) is not null,
              'prices', (select coalesce(jsonb_object_agg(t.code, jsonb_build_object('price', e.price::text, 'origin', e.origin,
                           'valid_from', e.valid_from, 'reason', e.reason)), '{}'::jsonb)
                           from public.price_types t cross join lateral (select * from private.price_on(t.id, p.id, v_date)) e
                          where t.is_active and e.id is not null)) as row
         from public.products p
        where p.status = 'active'
          and exists (select 1 from public.price_list_entries e where e.product_id = p.id)) x));
end $$;
revoke all on function public.price_list(date) from public, anon, authenticated, service_role;
grant execute on function public.price_list(date) to authenticated;

create or replace function public.price_list_history(p_product_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_price_list_view();
  return (select coalesce(jsonb_agg(jsonb_build_object('price_type', t.name, 'price', e.price::text, 'valid_from', e.valid_from,
            'origin', e.origin, 'reason', e.reason, 'created_at', e.created_at, 'author', pr.full_name,
            'source_row', e.source->>'source_row') order by e.created_at desc, e.id desc), '[]'::jsonb)
            from public.price_list_entries e join public.price_types t on t.id = e.price_type_id
            left join public.profiles pr on pr.id = e.created_by
           where e.product_id = p_product_id);
end $$;
revoke all on function public.price_list_history(uuid) from public, anon, authenticated, service_role;
grant execute on function public.price_list_history(uuid) to authenticated;

-- Brands -------------------------------------------------------------------------------------------------------
create or replace function public.save_brand(p_name text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_key text := private.brand_key(p_name);
begin
  perform private.require_price_list_manage();
  if v_key is null or length(btrim(p_name)) > 120 then
    raise exception 'Укажите название бренда';
  end if;
  select id into v_id from public.brands where brand_key = v_key;
  if found then
    return v_id;
  end if;
  insert into public.brands(name, brand_key, created_by) values (btrim(p_name), v_key, auth.uid()) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.save_brand(text) from public, anon, authenticated, service_role;
grant execute on function public.save_brand(text) to authenticated;

-- Brands of the directory and the brand texts of product cards that match no brand (not rewritten).
create or replace function public.brand_overview()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_price_list_view();
  return jsonb_build_object(
    'brands', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name,
               'products', (select count(*) from public.products p where private.brand_key(p.brand) = b.brand_key)) order by b.name), '[]'::jsonb)
               from public.brands b),
    'unmatched', (select coalesce(jsonb_agg(jsonb_build_object('text', x.brand, 'products', x.n) order by x.n desc, x.brand), '[]'::jsonb)
                  from (select coalesce(p.brand, '') as brand, count(*) n from public.products p
                         where p.status = 'active' and not exists (select 1 from public.brands b where b.brand_key = private.brand_key(p.brand))
                         group by coalesce(p.brand, '')) x));
end $$;
revoke all on function public.brand_overview() from public, anon, authenticated, service_role;
grant execute on function public.brand_overview() to authenticated;

-- VAT ----------------------------------------------------------------------------------------------------------
create or replace function public.set_vat_rate(p_country text, p_rate numeric, p_valid_from date, p_reason text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_price_list_manage();
  if p_country is null or p_country !~ '^[A-Z]{2}$' or p_rate is null or p_rate < 0 or p_rate >= 1 or p_valid_from is null then
    raise exception 'Укажите страну, ставку (доля, например 0.12) и дату начала';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 1000 then
    raise exception 'Укажите основание ставки';
  end if;
  insert into public.vat_rates(country, rate, valid_from, reason, created_by)
  values (p_country, p_rate, p_valid_from, btrim(p_reason), auth.uid()) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.set_vat_rate(text, numeric, date, text) from public, anon, authenticated, service_role;
grant execute on function public.set_vat_rate(text, numeric, date, text) to authenticated;

create or replace function public.vat_rate_history()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_price_list_view();
  return (select coalesce(jsonb_agg(jsonb_build_object('country', v.country, 'rate', v.rate::text, 'valid_from', v.valid_from,
            'reason', v.reason, 'created_at', v.created_at, 'author', p.full_name) order by v.valid_from desc, v.created_at desc), '[]'::jsonb)
            from public.vat_rates v left join public.profiles p on p.id = v.created_by);
end $$;
revoke all on function public.vat_rate_history() from public, anon, authenticated, service_role;
grant execute on function public.vat_rate_history() to authenticated;

-- Customer conditions ------------------------------------------------------------------------------------------
create or replace function public.set_customer_price_terms(p_customer_id uuid, p_price_type_id uuid, p_contract_currency_id uuid,
                                                           p_valid_from date, p_reason text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_customer_terms(p_customer_id, true);
  if not exists (select 1 from public.price_types where id = p_price_type_id and is_active and not is_reference) then
    raise exception 'Выберите вид цены';
  end if;
  if not exists (select 1 from public.currencies where id = p_contract_currency_id) or p_valid_from is null then
    raise exception 'Укажите валюту контракта и дату начала';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 1000 then
    raise exception 'Укажите причину изменения условий';
  end if;
  insert into public.customer_price_terms(customer_id, price_type_id, contract_currency_id, valid_from, reason, created_by)
  values (p_customer_id, p_price_type_id, p_contract_currency_id, p_valid_from, btrim(p_reason), auth.uid()) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.set_customer_price_terms(uuid, uuid, uuid, date, text) from public, anon, authenticated, service_role;
grant execute on function public.set_customer_price_terms(uuid, uuid, uuid, date, text) to authenticated;

-- Percent to the price list for one brand (negative = discount). A null percent ends the condition from the date.
create or replace function public.set_customer_brand_markup(p_customer_id uuid, p_brand_id uuid, p_percent numeric,
                                                            p_valid_from date, p_reason text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_customer_terms(p_customer_id, true);
  if not exists (select 1 from public.brands where id = p_brand_id) or p_valid_from is null then
    raise exception 'Выберите бренд и дату начала';
  end if;
  if p_percent is not null and (p_percent <= -100 or p_percent > 1000) then
    raise exception 'Процент должен быть больше -100 и не больше 1000';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 1000 then
    raise exception 'Укажите причину изменения условий';
  end if;
  insert into public.customer_brand_markups(customer_id, brand_id, percent, valid_from, reason, created_by)
  values (p_customer_id, p_brand_id, p_percent, p_valid_from, btrim(p_reason), auth.uid()) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.set_customer_brand_markup(uuid, uuid, numeric, date, text) from public, anon, authenticated, service_role;
grant execute on function public.set_customer_brand_markup(uuid, uuid, numeric, date, text) to authenticated;

-- Fixed price per piece in the contract currency; a null price ends it from the date.
create or replace function public.set_customer_fixed_price(p_customer_id uuid, p_product_id uuid, p_price numeric,
                                                           p_currency_id uuid, p_valid_from date, p_reason text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_customer_terms(p_customer_id, true);
  if not exists (select 1 from public.products where id = p_product_id) or p_valid_from is null
     or not exists (select 1 from public.currencies where id = p_currency_id) then
    raise exception 'Выберите товар, валюту и дату начала';
  end if;
  if p_price is not null and (p_price <= 0 or p_price > 1e10) then
    raise exception 'Цена должна быть больше нуля';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 1000 then
    raise exception 'Укажите причину изменения условий';
  end if;
  insert into public.customer_fixed_prices(customer_id, product_id, price, currency_id, valid_from, reason, created_by)
  values (p_customer_id, p_product_id, round(p_price, 4), p_currency_id, p_valid_from, btrim(p_reason), auth.uid()) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.set_customer_fixed_price(uuid, uuid, numeric, uuid, date, text) from public, anon, authenticated, service_role;
grant execute on function public.set_customer_fixed_price(uuid, uuid, numeric, uuid, date, text) to authenticated;

create or replace function public.customer_price_conditions(p_customer_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_customer_terms(p_customer_id, false);
  return jsonb_build_object(
    'can_manage', private.has_permission('pricing.customer_terms.manage'),
    'price_types', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'currency', c.code,
               'vat_included', t.vat_included) order by t.sort_order), '[]'::jsonb)
               from public.price_types t join public.currencies c on c.id = t.currency_id where t.is_active and not t.is_reference),
    'brands', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name) order by b.name), '[]'::jsonb) from public.brands b),
    'terms', (select coalesce(jsonb_agg(jsonb_build_object('price_type', t.name, 'price_type_id', t.id, 'currency', c.code,
               'valid_from', x.valid_from, 'reason', x.reason, 'created_at', x.created_at, 'author', p.full_name)
               order by x.valid_from desc, x.created_at desc), '[]'::jsonb)
               from public.customer_price_terms x join public.price_types t on t.id = x.price_type_id
               join public.currencies c on c.id = x.contract_currency_id left join public.profiles p on p.id = x.created_by
              where x.customer_id = p_customer_id),
    'markups', (select coalesce(jsonb_agg(jsonb_build_object('brand', b.name, 'brand_id', b.id, 'percent', x.percent::text,
               'valid_from', x.valid_from, 'reason', x.reason, 'created_at', x.created_at, 'author', p.full_name)
               order by b.name, x.valid_from desc, x.created_at desc), '[]'::jsonb)
               from public.customer_brand_markups x join public.brands b on b.id = x.brand_id left join public.profiles p on p.id = x.created_by
              where x.customer_id = p_customer_id),
    'fixed', (select coalesce(jsonb_agg(jsonb_build_object('product', coalesce(pr.name->>'ru', pr.internal_sku), 'sku', pr.internal_sku,
               'product_id', pr.id, 'price', x.price::text, 'currency', c.code, 'valid_from', x.valid_from, 'reason', x.reason,
               'created_at', x.created_at, 'author', p.full_name) order by pr.internal_sku, x.valid_from desc, x.created_at desc), '[]'::jsonb)
               from public.customer_fixed_prices x join public.products pr on pr.id = x.product_id join public.currencies c on c.id = x.currency_id
               left join public.profiles p on p.id = x.created_by
              where x.customer_id = p_customer_id));
end $$;
revoke all on function public.customer_price_conditions(uuid) from public, anon, authenticated, service_role;
grant execute on function public.customer_price_conditions(uuid) to authenticated;

commit;
