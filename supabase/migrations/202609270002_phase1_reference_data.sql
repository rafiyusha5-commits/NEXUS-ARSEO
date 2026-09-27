-- Phase 1A: reference data for counterparties, products, warehouses and routes.

create table if not exists public.currencies (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z]{3}$'),
  name jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.counterparties (
  id uuid primary key default gen_random_uuid(),
  roles text[] not null check (cardinality(roles) > 0),
  legal_name text not null,
  short_name text,
  country text not null check (country ~ '^[A-Z]{2}$'),
  tax_id text,
  registration_number text,
  website text,
  default_currency_id uuid references public.currencies(id) on delete set null,
  preferred_locale text check (preferred_locale in ('ru', 'kk', 'en')),
  min_remaining_shelf_life_pct numeric(5,2) check (min_remaining_shelf_life_pct between 0 and 100),
  status text not null default 'active' check (status in ('active', 'on_hold', 'archived')),
  notes text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists counterparties_country_tax_id_unique
  on public.counterparties(country, tax_id) where tax_id is not null and tax_id <> '';
create index if not exists counterparties_roles_idx on public.counterparties using gin(roles);

create table if not exists public.counterparties_contacts (
  id uuid primary key default gen_random_uuid(),
  counterparty_id uuid not null references public.counterparties(id) on delete cascade,
  full_name text not null,
  position text,
  phone text,
  whatsapp_phone text,
  email text,
  is_primary boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists counterparties_contacts_parent_idx on public.counterparties_contacts(counterparty_id);

create table if not exists public.contracts (
  id uuid primary key default gen_random_uuid(),
  counterparty_id uuid not null references public.counterparties(id) on delete restrict,
  number text not null,
  type text not null check (type in ('supply', 'sale', 'service', 'agency', 'nda', 'other')),
  currency_id uuid references public.currencies(id) on delete set null,
  sign_date date,
  valid_from date,
  valid_to date,
  incoterms text,
  status text not null default 'draft' check (status in ('draft', 'active', 'expired', 'terminated')),
  notes text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(counterparty_id, number),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  internal_sku text not null unique,
  name jsonb not null check (nullif(trim(name ->> 'ru'), '') is not null),
  manufacturer_id uuid not null references public.counterparties(id) on delete restrict,
  brand text,
  country_of_origin text check (country_of_origin is null or country_of_origin ~ '^[A-Z]{2}$'),
  composition jsonb,
  nutrition_facts jsonb,
  hs_code text,
  temperature_regime text check (temperature_regime is null or temperature_regime in ('frozen', 'chilled', 'ambient')),
  temperature_range text,
  shelf_life_days integer check (shelf_life_days is null or shelf_life_days > 0),
  base_uom text not null default 'piece' check (base_uom in ('piece', 'box', 'layer', 'pallet', 'truck')),
  default_currency_id uuid references public.currencies(id) on delete set null,
  base_purchase_price numeric(14,4) check (base_purchase_price is null or base_purchase_price >= 0),
  requires_marking boolean not null default false,
  requires_sticker boolean not null default false,
  status text not null default 'draft' check (status in ('draft', 'active', 'discontinued', 'archived')),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists products_manufacturer_idx on public.products(manufacturer_id);

create table if not exists public.contract_terms (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  term_type text not null check (term_type in ('price', 'payment_terms', 'delivery_terms', 'min_remaining_shelf_life_pct', 'return_terms', 'promo_terms', 'penalty', 'other')),
  product_id uuid references public.products(id) on delete set null,
  value_numeric numeric(14,4),
  value_text text,
  valid_from date,
  valid_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (value_numeric is not null or nullif(trim(value_text), '') is not null),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);

create table if not exists public.product_identifiers (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  identifier_type text not null check (identifier_type in ('supplier_sku', 'gtin', 'unit_barcode', 'box_barcode')),
  value text not null,
  counterparty_id uuid references public.counterparties(id) on delete restrict,
  packaging_uom text check (packaging_uom is null or packaging_uom in ('piece', 'box', 'layer', 'pallet', 'truck')),
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (identifier_type <> 'supplier_sku' or counterparty_id is not null)
);
create unique index if not exists product_identifiers_global_unique
  on public.product_identifiers(identifier_type, value)
  where identifier_type in ('gtin', 'unit_barcode', 'box_barcode');
create unique index if not exists product_identifiers_supplier_unique
  on public.product_identifiers(counterparty_id, value)
  where identifier_type = 'supplier_sku';

create table if not exists public.product_packaging (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  uom text not null check (uom in ('piece', 'box', 'layer', 'pallet', 'truck')),
  units_per_parent numeric(12,3) not null check (units_per_parent > 0),
  gross_weight_kg numeric(10,3) check (gross_weight_kg is null or gross_weight_kg >= 0),
  net_weight_kg numeric(10,3) check (net_weight_kg is null or net_weight_kg >= 0),
  volume_m3 numeric(10,4) check (volume_m3 is null or volume_m3 >= 0),
  length_cm numeric(8,2) check (length_cm is null or length_cm >= 0),
  width_cm numeric(8,2) check (width_cm is null or width_cm >= 0),
  height_cm numeric(8,2) check (height_cm is null or height_cm >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(product_id, uom)
);

create table if not exists public.warehouses (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name jsonb not null check (nullif(trim(name ->> 'ru'), '') is not null),
  city text,
  country text,
  address text,
  is_main_hub boolean not null default false,
  is_virtual boolean not null default false,
  head_user_id uuid references public.profiles(id) on delete set null,
  head_name text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (is_virtual or (city is not null and country is not null))
);

create table if not exists public.warehouse_locations (
  id uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references public.warehouses(id) on delete cascade,
  code text not null,
  zone text not null check (zone in ('receiving', 'storage', 'picking', 'quarantine', 'stickering', 'shipping')),
  temperature_regime text,
  status text not null default 'active' check (status in ('active', 'blocked', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(warehouse_id, code)
);

create table if not exists public.routes (
  id uuid primary key default gen_random_uuid(),
  origin_country text not null check (origin_country ~ '^[A-Z]{2}$'),
  destination_country text not null check (destination_country ~ '^[A-Z]{2}$'),
  name jsonb not null check (nullif(trim(name ->> 'ru'), '') is not null),
  via_countries text[] not null default '{}',
  typical_transit_days integer check (typical_transit_days is null or typical_transit_days > 0),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists routes_direction_name_unique
  on public.routes(origin_country, destination_country, (name ->> 'ru'));

create table if not exists public.carriers (
  id uuid primary key default gen_random_uuid(),
  counterparty_id uuid not null unique references public.counterparties(id) on delete restrict,
  transport_types text[] not null default '{}',
  has_refrigerated_fleet boolean,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vehicles (
  id uuid primary key default gen_random_uuid(),
  carrier_id uuid not null references public.carriers(id) on delete cascade,
  plate_number text not null unique,
  trailer_plate_number text,
  vehicle_type text not null check (vehicle_type in ('truck', 'trailer', 'refrigerator')),
  temperature_capability text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.brokers (
  id uuid primary key default gen_random_uuid(),
  counterparty_id uuid not null unique references public.counterparties(id) on delete restrict,
  countries_serviced text[] not null default '{}',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles
  add column if not exists counterparty_id uuid references public.counterparties(id) on delete set null,
  add column if not exists primary_warehouse_id uuid references public.warehouses(id) on delete set null;

insert into public.currencies(code, name) values
  ('KZT', '{"ru":"Тенге","en":"Kazakhstani tenge","kk":"Теңге"}'),
  ('RUB', '{"ru":"Российский рубль","en":"Russian ruble","kk":"Ресей рублі"}'),
  ('EUR', '{"ru":"Евро","en":"Euro","kk":"Еуро"}')
on conflict (code) do update set name = excluded.name, is_active = true;

insert into public.warehouses(code, name, city, country, is_main_hub, is_virtual) values
  ('AKT', '{"ru":"Актобе","en":"Aktobe","kk":"Ақтөбе"}', 'Актобе', 'KZ', true, false),
  ('AST', '{"ru":"Астана","en":"Astana","kk":"Астана"}', 'Астана', 'KZ', false, false),
  ('ALA', '{"ru":"Алматы","en":"Almaty","kk":"Алматы"}', 'Алматы', 'KZ', false, false),
  ('IN_TRANSIT', '{"ru":"В пути","en":"In transit","kk":"Жолда"}', null, null, false, true)
on conflict (code) do update set name = excluded.name, city = excluded.city, country = excluded.country,
  is_main_hub = excluded.is_main_hub, is_virtual = excluded.is_virtual, status = 'active';

insert into public.routes(origin_country, destination_country, name) values
  ('FI','KZ','{"ru":"Финляндия → Казахстан"}'), ('NL','KZ','{"ru":"Нидерланды → Казахстан"}'),
  ('DE','KZ','{"ru":"Германия → Казахстан"}'), ('BE','KZ','{"ru":"Бельгия → Казахстан"}'),
  ('TR','KZ','{"ru":"Турция → Казахстан"}'), ('TR','GE','{"ru":"Турция → Грузия"}'),
  ('GE','RU','{"ru":"Грузия → Россия"}'), ('KZ','RU','{"ru":"Казахстан → Россия"}'),
  ('KZ','KG','{"ru":"Казахстан → Кыргызстан"}')
on conflict do nothing;

insert into public.permissions(code, module, action, name, description)
select module || '.' || action, module, action,
  case module when 'customers' then 'Клиенты' when 'suppliers' then 'Поставщики'
    when 'products' then 'Товары' else 'Склады' end || ': ' ||
  case action when 'view' then 'просмотр' when 'create' then 'создание'
    when 'update' then 'изменение' else 'архивирование' end,
  'Право фазы 1'
from unnest(array['customers','suppliers','products','warehouses']) module
cross join unnest(array['view','create','update','archive']) action
on conflict (code) do nothing;

insert into public.role_permissions(role_id, permission_id, granted)
select role.id, permission.id, true
from public.app_roles role
join public.permissions permission on permission.module in ('customers','suppliers','products','warehouses')
where
  role.code in ('administrator','director','logistics_director')
  or (role.code in ('executive_director','senior_logistics_manager','logistics_specialist') and permission.action in ('view','create','update'))
  or (role.code = 'commercial_director' and (
    permission.module = 'customers' or (permission.module in ('suppliers','products','warehouses') and permission.action = 'view')
  ))
  or (role.code in ('accountant','marketer') and permission.action = 'view')
on conflict (role_id, permission_id) do update set granted = excluded.granted;

create or replace function private.can_access_counterparty(required_action text, party_roles text[])
returns boolean language sql security definer set search_path = '' stable as $$
  select
    ('customer' = any(party_roles) and (select private.has_permission('customers.' || required_action)))
    or (party_roles && array['manufacturer','supplier','carrier','broker','printing_house','other']
      and (select private.has_permission('suppliers.' || required_action)));
$$;
create or replace function private.can_access_counterparty_record(required_action text, party_id uuid)
returns boolean language sql security definer set search_path = '' stable as $$
  select exists (
    select 1 from public.counterparties c
    where c.id = party_id and (select private.can_access_counterparty(required_action, c.roles))
  );
$$;
revoke execute on function private.can_access_counterparty(text,text[]) from public;
revoke execute on function private.can_access_counterparty_record(text,uuid) from public;
grant execute on function private.can_access_counterparty(text,text[]) to authenticated;
grant execute on function private.can_access_counterparty_record(text,uuid) to authenticated;

alter table public.currencies enable row level security;
alter table public.counterparties enable row level security;
alter table public.counterparties_contacts enable row level security;
alter table public.contracts enable row level security;
alter table public.contract_terms enable row level security;
alter table public.products enable row level security;
alter table public.product_identifiers enable row level security;
alter table public.product_packaging enable row level security;
alter table public.warehouses enable row level security;
alter table public.warehouse_locations enable row level security;
alter table public.routes enable row level security;
alter table public.carriers enable row level security;
alter table public.vehicles enable row level security;
alter table public.brokers enable row level security;

grant select, insert, update on public.currencies, public.counterparties, public.counterparties_contacts,
  public.contracts, public.contract_terms, public.products, public.product_identifiers,
  public.product_packaging, public.warehouses, public.warehouse_locations, public.routes,
  public.carriers, public.vehicles, public.brokers to authenticated;

create policy "employees view currencies" on public.currencies for select to authenticated using ((select private.is_employee()));
create policy "product managers create currencies" on public.currencies for insert to authenticated with check ((select private.has_permission('products.create')));
create policy "product managers update currencies" on public.currencies for update to authenticated using ((select private.has_permission('products.update'))) with check ((select private.has_permission('products.update')));

create policy "employees view permitted counterparties" on public.counterparties for select to authenticated using ((select private.can_access_counterparty('view', roles)));
create policy "employees create permitted counterparties" on public.counterparties for insert to authenticated with check ((select private.can_access_counterparty('create', roles)));
create policy "employees update permitted counterparties" on public.counterparties for update to authenticated using ((select private.can_access_counterparty('update', roles))) with check ((select private.can_access_counterparty('update', roles)));

create policy "employees view permitted contacts" on public.counterparties_contacts for select to authenticated using ((select private.can_access_counterparty_record('view', counterparty_id)));
create policy "employees create permitted contacts" on public.counterparties_contacts for insert to authenticated with check ((select private.can_access_counterparty_record('create', counterparty_id)));
create policy "employees update permitted contacts" on public.counterparties_contacts for update to authenticated using ((select private.can_access_counterparty_record('update', counterparty_id))) with check ((select private.can_access_counterparty_record('update', counterparty_id)));
create policy "employees view permitted contracts" on public.contracts for select to authenticated using ((select private.can_access_counterparty_record('view', counterparty_id)));
create policy "employees create permitted contracts" on public.contracts for insert to authenticated with check ((select private.can_access_counterparty_record('create', counterparty_id)));
create policy "employees update permitted contracts" on public.contracts for update to authenticated using ((select private.can_access_counterparty_record('update', counterparty_id))) with check ((select private.can_access_counterparty_record('update', counterparty_id)));
create policy "employees view permitted contract terms" on public.contract_terms for select to authenticated using (exists (select 1 from public.contracts c where c.id = contract_id and (select private.can_access_counterparty_record('view', c.counterparty_id))));
create policy "employees create permitted contract terms" on public.contract_terms for insert to authenticated with check (exists (select 1 from public.contracts c where c.id = contract_id and (select private.can_access_counterparty_record('create', c.counterparty_id))));
create policy "employees update permitted contract terms" on public.contract_terms for update to authenticated using (exists (select 1 from public.contracts c where c.id = contract_id and (select private.can_access_counterparty_record('update', c.counterparty_id)))) with check (exists (select 1 from public.contracts c where c.id = contract_id and (select private.can_access_counterparty_record('update', c.counterparty_id))));

create policy "employees view products" on public.products for select to authenticated using ((select private.has_permission('products.view')));
create policy "employees create products" on public.products for insert to authenticated with check ((select private.has_permission('products.create')));
create policy "employees update products" on public.products for update to authenticated using ((select private.has_permission('products.update'))) with check ((select private.has_permission('products.update')));
create policy "employees view product identifiers" on public.product_identifiers for select to authenticated using ((select private.has_permission('products.view')));
create policy "employees create product identifiers" on public.product_identifiers for insert to authenticated with check ((select private.has_permission('products.create')));
create policy "employees update product identifiers" on public.product_identifiers for update to authenticated using ((select private.has_permission('products.update'))) with check ((select private.has_permission('products.update')));
create policy "employees view product packaging" on public.product_packaging for select to authenticated using ((select private.has_permission('products.view')));
create policy "employees create product packaging" on public.product_packaging for insert to authenticated with check ((select private.has_permission('products.create')));
create policy "employees update product packaging" on public.product_packaging for update to authenticated using ((select private.has_permission('products.update'))) with check ((select private.has_permission('products.update')));

create policy "employees view warehouses" on public.warehouses for select to authenticated using ((select private.has_permission('warehouses.view')));
create policy "employees create warehouses" on public.warehouses for insert to authenticated with check ((select private.has_permission('warehouses.create')));
create policy "employees update warehouses" on public.warehouses for update to authenticated using ((select private.has_permission('warehouses.update'))) with check ((select private.has_permission('warehouses.update')));
create policy "employees view warehouse locations" on public.warehouse_locations for select to authenticated using ((select private.has_permission('warehouses.view')));
create policy "employees create warehouse locations" on public.warehouse_locations for insert to authenticated with check ((select private.has_permission('warehouses.create')));
create policy "employees update warehouse locations" on public.warehouse_locations for update to authenticated using ((select private.has_permission('warehouses.update'))) with check ((select private.has_permission('warehouses.update')));

create policy "employees view routes" on public.routes for select to authenticated using ((select private.has_permission('suppliers.view')));
create policy "employees create routes" on public.routes for insert to authenticated with check ((select private.has_permission('suppliers.create')));
create policy "employees update routes" on public.routes for update to authenticated using ((select private.has_permission('suppliers.update'))) with check ((select private.has_permission('suppliers.update')));
create policy "employees view carriers" on public.carriers for select to authenticated using ((select private.has_permission('suppliers.view')));
create policy "employees create carriers" on public.carriers for insert to authenticated with check ((select private.has_permission('suppliers.create')));
create policy "employees update carriers" on public.carriers for update to authenticated using ((select private.has_permission('suppliers.update'))) with check ((select private.has_permission('suppliers.update')));
create policy "employees view vehicles" on public.vehicles for select to authenticated using ((select private.has_permission('suppliers.view')));
create policy "employees create vehicles" on public.vehicles for insert to authenticated with check ((select private.has_permission('suppliers.create')));
create policy "employees update vehicles" on public.vehicles for update to authenticated using ((select private.has_permission('suppliers.update'))) with check ((select private.has_permission('suppliers.update')));
create policy "employees view brokers" on public.brokers for select to authenticated using ((select private.has_permission('suppliers.view')));
create policy "employees create brokers" on public.brokers for insert to authenticated with check ((select private.has_permission('suppliers.create')));
create policy "employees update brokers" on public.brokers for update to authenticated using ((select private.has_permission('suppliers.update'))) with check ((select private.has_permission('suppliers.update')));

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'currencies','counterparties','counterparties_contacts','contracts','contract_terms',
    'products','product_identifiers','product_packaging','warehouses','warehouse_locations',
    'routes','carriers','vehicles','brokers'
  ] loop
    execute format('drop trigger if exists audit_%I_changes on public.%I', table_name, table_name);
    execute format('create trigger audit_%I_changes after insert or update on public.%I for each row execute function private.write_access_audit()', table_name, table_name);
  end loop;
end $$;

comment on table public.counterparties is 'Unified ARSEO registry of customers, suppliers and logistics partners';
comment on table public.products is 'Product master data with multilingual names and trade attributes';
comment on table public.warehouses is 'Physical and virtual ARSEO warehouses';
