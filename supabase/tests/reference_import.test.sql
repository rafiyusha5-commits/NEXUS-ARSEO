-- Transactional reference-data import (migration 202609271900): permissions, dry-run,
-- all-or-nothing apply, idempotent re-import, GTIN conflicts and counterparty roles.
-- All names, tax IDs and barcodes are fictitious; GTINs use the in-store prefix 2.

\set ON_ERROR_STOP 1

create schema if not exists tests;
grant usage on schema tests to authenticated;

create or replace function tests.expect_error(p_sql text, p_pattern text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'expected error "%" but statement succeeded: %', p_pattern, p_sql
    using errcode = 'P0099';
exception
  when sqlstate 'P0099' then raise;
  when others then
    if sqlerrm !~* p_pattern then
      raise exception 'expected error "%" but got "%" for: %', p_pattern, sqlerrm, p_sql
        using errcode = 'P0099';
    end if;
end;
$$;

create or replace function tests.act_as(p_user uuid) returns void
language sql as $$ select set_config('request.jwt.claim.sub', p_user::text, false) $$;

-- Packages are kept in a table so each check can refer to them by name.
create table if not exists tests.ri_packages (name text primary key, payload jsonb not null);
create or replace function tests.ri(p_name text, p_dry_run boolean default true) returns jsonb
language sql as $$
  select public.import_reference_data((select payload from tests.ri_packages where name = p_name), p_dry_run)
$$;
-- Status of one report item by entity and key.
create or replace function tests.ri_status(p_report jsonb, p_entity text, p_key text) returns text
language sql as $$
  select i ->> 'status' from jsonb_array_elements(p_report -> 'items') i
  where i ->> 'entity' = p_entity and i ->> 'key' = p_key
$$;
grant select on tests.ri_packages to authenticated;
grant execute on all functions in schema tests to authenticated;

-- Fixtures (as postgres) ---------------------------------------------------------------

insert into auth.users (id, email, raw_user_meta_data) values
  ('c7000000-0000-4000-8000-000000000001', 'ri-director@test.local', '{"full_name":"Директор"}'),
  ('c7000000-0000-4000-8000-000000000002', 'ri-accountant@test.local', '{"full_name":"Бухгалтер"}'),
  ('c7000000-0000-4000-8000-000000000003', 'ri-commercial@test.local', '{"full_name":"Коммерческий директор"}'),
  ('c7000000-0000-4000-8000-000000000004', 'ri-specialist@test.local', '{"full_name":"Специалист"}');

insert into public.user_roles (user_id, role_id)
select u.id::uuid, r.id
from (values
  ('c7000000-0000-4000-8000-000000000001', 'director'),
  ('c7000000-0000-4000-8000-000000000002', 'accountant'),
  ('c7000000-0000-4000-8000-000000000003', 'commercial_director'),
  ('c7000000-0000-4000-8000-000000000004', 'logistics_specialist')
) as u(id, role_code)
join public.app_roles r on r.code = u.role_code;

-- The specialist keeps the product rights but may not create suppliers.
insert into public.user_permission_overrides (user_id, permission_id, effect, reason, granted_by)
select 'c7000000-0000-4000-8000-000000000004', p.id, 'deny', 'reference import test', 'c7000000-0000-4000-8000-000000000001'
from public.permissions p where p.code = 'suppliers.create';

insert into public.counterparties (id, roles, legal_name, country, tax_id) values
  ('c8000000-0000-4000-8000-000000000001', array['customer'], 'RI Retail Chain LLP', 'KZ', 'RI-KZ-001'),
  ('c8000000-0000-4000-8000-000000000002', array['manufacturer'], 'RI Legacy Foods', 'NL', null);

insert into tests.ri_packages (name, payload) values
('base', $json${
  "format": "nexus-reference-import", "version": 1,
  "counterparties": [
    {"row": 2, "ref": "maker", "legal_name": "RI Confectionery Oy", "short_name": "RI Candy", "roles": ["manufacturer", "supplier"],
     "country": "FI", "tax_id": "RI-FI-001", "preferred_locale": "en"},
    {"row": 3, "ref": "dist", "legal_name": "RI Distribution GmbH", "roles": ["supplier"], "country": "DE"}
  ],
  "products": [
    {"row": 2, "internal_sku": "RI-001", "name": {"ru": "Конфеты RI 200 г", "en": "RI sweets 200 g"}, "manufacturer": "maker",
     "brand": "RI", "country_of_origin": "FI", "hs_code": "1806903100", "shelf_life_days": 365,
     "composition": {"ru": "сахар, какао"}, "nutrition_facts": {"basis": "100g", "energy_kcal": 530, "protein_g": 6.5, "fat_g": 30, "carbohydrates_g": 58},
     "temperature_regime": "ambient", "temperature_range": "+5…+25 °C", "requires_sticker": true, "requires_marking": false,
     "identifiers": [
       {"type": "gtin", "value": "2000000000015", "is_primary": true},
       {"type": "unit_barcode", "value": "2000000000015"},
       {"type": "box_barcode", "value": "12000000000012", "packaging_uom": "box"},
       {"type": "supplier_sku", "value": "ART-001", "counterparty": "maker", "is_primary": true}
     ],
     "packaging": [
       {"uom": "piece", "units_per_parent": 1, "gross_weight_kg": 0.22, "net_weight_kg": 0.2},
       {"uom": "box", "units_per_parent": 12, "gross_weight_kg": 2.8, "volume_m3": 0.012, "length_cm": 30, "width_cm": 20, "height_cm": 20}
     ]},
    {"row": 3, "internal_sku": "RI-002", "name": {"ru": "Шоколад RI 100 г"}, "manufacturer": "RI-FI-001",
     "identifiers": [{"type": "gtin", "value": "2000000000022"}]}
  ]
}$json$),
('update', $json${
  "format": "nexus-reference-import", "version": 1,
  "counterparties": [
    {"ref": "dist", "legal_name": "RI Distribution GmbH", "roles": ["manufacturer"], "country": "DE"}
  ],
  "products": [
    {"internal_sku": "RI-001", "name": {"kk": "RI кәмпиттері 200 г"}, "brand": "RI Premium",
     "packaging": [{"uom": "box", "gross_weight_kg": 2.9}]},
    {"internal_sku": "RI-002", "manufacturer": "RI Legacy Foods"}
  ]
}$json$),
('gtin_taken', $json${
  "format": "nexus-reference-import", "version": 1,
  "products": [
    {"row": 2, "internal_sku": "RI-003", "name": {"ru": "Новый товар"}, "manufacturer": "RI Confectionery Oy",
     "identifiers": [{"type": "gtin", "value": "2000000000039"}]},
    {"row": 3, "internal_sku": "RI-004", "name": {"ru": "Товар с чужим GTIN"}, "manufacturer": "RI Confectionery Oy",
     "identifiers": [{"type": "gtin", "value": "2000000000015"}]}
  ]
}$json$),
('gtin14_ok_ref', $json${
  "format": "nexus-reference-import", "version": 1,
  "products": [
    {"internal_sku": "RI-005", "name": {"ru": "Товар"}, "manufacturer": "RI-FI-001",
     "identifiers": [{"type": "gtin", "value": "02000000000022"}]}
  ]
}$json$),
('gtin_twice', $json${
  "format": "nexus-reference-import", "version": 1,
  "products": [
    {"internal_sku": "RI-006", "name": {"ru": "Первый"}, "manufacturer": "RI-FI-001",
     "identifiers": [{"type": "gtin", "value": "2000000000046"}]},
    {"internal_sku": "RI-007", "name": {"ru": "Второй"}, "manufacturer": "RI-FI-001",
     "identifiers": [{"type": "unit_barcode", "value": "2000000000046"}]}
  ]
}$json$),
('wrong_roles', $json${
  "format": "nexus-reference-import", "version": 1,
  "products": [
    {"internal_sku": "RI-008", "name": {"ru": "Производитель — клиент"}, "manufacturer": "RI Retail Chain LLP"},
    {"internal_sku": "RI-009", "name": {"ru": "Артикул клиента"}, "manufacturer": "RI-FI-001",
     "identifiers": [{"type": "supplier_sku", "value": "X-1", "counterparty": "RI-KZ-001"}]}
  ]
}$json$),
('bad_middle_row', $json${
  "format": "nexus-reference-import", "version": 1,
  "products": [
    {"row": 2, "internal_sku": "RI-010", "name": {"ru": "Хорошая строка 1"}, "manufacturer": "RI-FI-001"},
    {"row": 3, "internal_sku": "RI-011", "name": {"ru": "Плохая страна"}, "manufacturer": "RI-FI-001", "country_of_origin": "Finland"},
    {"row": 4, "internal_sku": "RI-012", "name": {"ru": "Хорошая строка 2"}, "manufacturer": "RI-FI-001"}
  ]
}$json$),
('price', $json${
  "format": "nexus-reference-import", "version": 1,
  "products": [
    {"internal_sku": "RI-013", "name": {"ru": "С ценой"}, "manufacturer": "RI-FI-001", "base_purchase_price": 1.5}
  ]
}$json$),
('bad_gtin', $json${
  "format": "nexus-reference-import", "version": 1,
  "products": [
    {"internal_sku": "RI-014", "name": {"ru": "Неверный GTIN"}, "manufacturer": "RI-FI-001",
     "identifiers": [{"type": "gtin", "value": "2000000000016"}]}
  ]
}$json$),
('new_supplier', $json${
  "format": "nexus-reference-import", "version": 1,
  "counterparties": [{"legal_name": "RI New Supplier AB", "roles": ["supplier"], "country": "SE"}],
  "products": [{"internal_sku": "RI-001", "brand": "RI Premium"}]
}$json$),
('products_only', $json${
  "format": "nexus-reference-import", "version": 1,
  "products": [{"internal_sku": "RI-015", "name": {"ru": "Товар специалиста"}, "manufacturer": "RI-FI-001",
                "packaging": [{"uom": "box", "units_per_parent": 6}]}]
}$json$);

-- 1. Grants and permissions ------------------------------------------------------------

do $$
begin
  assert not has_function_privilege('anon', 'public.import_reference_data(jsonb, boolean)', 'execute'), 'anon must not import';
  assert has_function_privilege('authenticated', 'public.import_reference_data(jsonb, boolean)', 'execute'), 'employees call the RPC';
  assert not has_function_privilege('authenticated', 'private.run_reference_import(jsonb)', 'execute'), 'the worker is not callable directly';
  assert (select prosecdef from pg_proc where oid = 'public.import_reference_data(jsonb, boolean)'::regprocedure), 'runs as definer';
  assert (select proconfig from pg_proc where oid = 'public.import_reference_data(jsonb, boolean)'::regprocedure) = array['search_path=""'],
    'definer function pins an empty search_path';
end;
$$;

set role authenticated;
select tests.act_as('c7000000-0000-4000-8000-000000000002'); -- accountant: products.view only
select tests.expect_error($$ select tests.ri('base') $$, 'Недостаточно прав для импорта');
select tests.expect_error($$ select tests.ri('base', false) $$, 'Недостаточно прав для импорта');
select tests.act_as('c7000000-0000-4000-8000-000000000003'); -- commercial director: products.view only
select tests.expect_error($$ select tests.ri('base') $$, 'Недостаточно прав для импорта');
reset role;

-- 2. Dry-run reports and writes nothing -------------------------------------------------

create table tests.ri_counts as
select (select count(*) from public.audit_log) as audit_rows,
       (select count(*) from public.counterparties) as parties,
       (select count(*) from public.products) as products;

set role authenticated;
select tests.act_as('c7000000-0000-4000-8000-000000000001');
do $$
declare
  v jsonb := tests.ri('base');
begin
  assert (v ->> 'dry_run')::boolean and not (v ->> 'applied')::boolean, 'marked as dry-run';
  assert v -> 'summary' = '{"create": 11, "update": 0, "unchanged": 0, "conflict": 0, "error": 0}'::jsonb,
    format('dry-run summary: %s', v -> 'summary');
  assert tests.ri_status(v, 'product', 'RI-001') = 'create', 'product will be created';
  assert tests.ri_status(v, 'identifier', 'RI-001 · supplier_sku ART-001') = 'create', 'supplier article will be created';
  assert tests.ri_status(v, 'packaging', 'RI-001 · box') = 'create', 'box level will be created';
end;
$$;
reset role;

do $$
begin
  assert (select count(*) from public.audit_log) = (select audit_rows from tests.ri_counts), 'dry-run leaves no audit rows';
  assert (select count(*) from public.counterparties) = (select parties from tests.ri_counts), 'dry-run creates no counterparties';
  assert (select count(*) from public.products) = (select products from tests.ri_counts), 'dry-run creates no products';
end;
$$;

-- 3. Apply and re-apply ----------------------------------------------------------------

set role authenticated;
select tests.act_as('c7000000-0000-4000-8000-000000000001');
do $$
declare
  v jsonb := tests.ri('base', false);
begin
  assert (v ->> 'applied')::boolean, 'applied';
  assert (v #>> '{summary,create}')::int = 11 and (v #>> '{summary,conflict}')::int = 0 and (v #>> '{summary,error}')::int = 0,
    format('apply summary: %s', v -> 'summary');
end;
$$;
reset role;

create table tests.ri_after_base as
select p.internal_sku, p.updated_at from public.products p where p.internal_sku like 'RI-%';

do $$
declare
  v_product public.products%rowtype;
begin
  select * into v_product from public.products where internal_sku = 'RI-001';
  assert v_product.name = '{"ru": "Конфеты RI 200 г", "en": "RI sweets 200 g"}'::jsonb, 'localized name stored';
  assert v_product.manufacturer_id = (select id from public.counterparties where tax_id = 'RI-FI-001'), 'manufacturer by package ref';
  assert v_product.hs_code = '1806903100' and v_product.shelf_life_days = 365 and v_product.country_of_origin = 'FI', 'trade attributes';
  assert v_product.nutrition_facts ->> 'energy_kcal' = '530' and v_product.composition ->> 'ru' = 'сахар, какао', 'nutrition and composition';
  assert v_product.temperature_regime = 'ambient' and v_product.requires_sticker and v_product.status = 'active', 'flags and defaults';
  assert v_product.base_purchase_price is null and v_product.default_currency_id is null, 'no prices or currency written';
  assert (select count(*) from public.product_identifiers where product_id = v_product.id) = 4, 'four identifiers';
  assert (select counterparty_id from public.product_identifiers where product_id = v_product.id and identifier_type = 'supplier_sku')
    = (select id from public.counterparties where legal_name = 'RI Confectionery Oy'), 'supplier article bound to the factory-manufacturer';
  assert (select units_per_parent from public.product_packaging where product_id = v_product.id and uom = 'box') = 12, 'box level';
  assert (select manufacturer_id from public.products where internal_sku = 'RI-002') = v_product.manufacturer_id,
    'a tax ID resolves an in-package counterparty';
end;
$$;

set role authenticated;
select tests.act_as('c7000000-0000-4000-8000-000000000001');
do $$
declare
  v jsonb := tests.ri('base', false);
begin
  assert v -> 'summary' = '{"create": 0, "update": 0, "unchanged": 11, "conflict": 0, "error": 0}'::jsonb,
    format('re-import must change nothing: %s', v -> 'summary');
end;
$$;
reset role;

do $$
begin
  assert (select count(*) from public.counterparties where legal_name like 'RI %') = 4, 'no duplicate counterparties';
  assert (select count(*) from public.products where internal_sku like 'RI-%') = 2, 'no duplicate products';
  assert (select count(*) from public.product_identifiers pi join public.products p on p.id = pi.product_id where p.internal_sku like 'RI-%') = 5,
    'no duplicate identifiers';
  assert (select count(*) from public.product_packaging pp join public.products p on p.id = pp.product_id where p.internal_sku like 'RI-%') = 2,
    'no duplicate packaging';
  assert not exists (select 1 from public.products p join tests.ri_after_base a using (internal_sku) where p.updated_at <> a.updated_at),
    'unchanged rows are not rewritten';
end;
$$;

-- 4. Updates merge instead of overwriting ----------------------------------------------

set role authenticated;
select tests.act_as('c7000000-0000-4000-8000-000000000001');
do $$
declare
  v jsonb := tests.ri('update', false);
begin
  assert tests.ri_status(v, 'counterparty', 'dist') = 'update', 'role added to an existing counterparty';
  assert tests.ri_status(v, 'product', 'RI-001') = 'update', 'product updated';
  assert tests.ri_status(v, 'packaging', 'RI-001 · box') = 'update', 'packaging updated';
  assert tests.ri_status(v, 'product', 'RI-002') = 'update', 'manufacturer switched to an existing counterparty';
  assert (v #>> '{summary,conflict}')::int = 0 and (v #>> '{summary,error}')::int = 0, format('clean update: %s', v);
end;
$$;
reset role;

do $$
begin
  assert (select roles from public.counterparties where legal_name = 'RI Distribution GmbH') = array['supplier', 'manufacturer'],
    'roles are merged, never removed';
  assert (select name from public.products where internal_sku = 'RI-001')
    = '{"ru": "Конфеты RI 200 г", "en": "RI sweets 200 g", "kk": "RI кәмпиттері 200 г"}'::jsonb, 'names merged by language';
  assert (select brand from public.products where internal_sku = 'RI-001') = 'RI Premium', 'brand updated';
  assert (select hs_code from public.products where internal_sku = 'RI-001') = '1806903100', 'absent fields keep their value';
  assert (select (gross_weight_kg, units_per_parent) from public.product_packaging pp join public.products p on p.id = pp.product_id
          where p.internal_sku = 'RI-001' and pp.uom = 'box') = (2.9::numeric(10,3), 12::numeric(12,3)), 'packaging merged';
  assert (select manufacturer_id from public.products where internal_sku = 'RI-002') = 'c8000000-0000-4000-8000-000000000002',
    'existing counterparty resolved by legal name';
end;
$$;

-- 5. GTIN conflicts and all-or-nothing -------------------------------------------------

set role authenticated;
select tests.act_as('c7000000-0000-4000-8000-000000000001');
do $$
declare
  v jsonb := tests.ri('gtin_taken');
begin
  assert tests.ri_status(v, 'product', 'RI-003') = 'create' and tests.ri_status(v, 'product', 'RI-004') = 'create', 'products themselves are fine';
  assert tests.ri_status(v, 'identifier', 'RI-004 · gtin 2000000000015') = 'conflict', 'GTIN of another product is a conflict';
  assert (v #>> '{summary,conflict}')::int = 1, format('one conflict: %s', v -> 'summary');
end;
$$;
select tests.expect_error($$ select tests.ri('gtin_taken', false) $$, 'Импорт отменён: конфликтов 1');

-- A 14-digit form with a leading zero is the same GTIN as the 13-digit one.
do $$
declare
  v jsonb := tests.ri('gtin14_ok_ref');
begin
  assert tests.ri_status(v, 'identifier', 'RI-005 · gtin 02000000000022') = 'conflict', format('GTIN-14 matches GTIN-13: %s', v);
end;
$$;

-- The same barcode on two products of one package: both copies conflict, whatever the type.
do $$
declare
  v jsonb := tests.ri('gtin_twice');
begin
  assert tests.ri_status(v, 'identifier', 'RI-006 · gtin 2000000000046') = 'conflict'
     and tests.ri_status(v, 'identifier', 'RI-007 · unit_barcode 2000000000046') = 'conflict', format('in-package duplicates: %s', v);
end;
$$;

-- One bad row cancels the whole package.
do $$
declare
  v jsonb := tests.ri('bad_middle_row');
begin
  assert tests.ri_status(v, 'product', 'RI-011') = 'error', 'invalid country is a row error';
  assert (v #>> '{summary,create}')::int = 2 and (v #>> '{summary,error}')::int = 1, format('summary: %s', v -> 'summary');
end;
$$;
select tests.expect_error($$ select tests.ri('bad_middle_row', false) $$, 'Импорт отменён: конфликтов 0, ошибок 1');
reset role;

do $$
begin
  assert not exists (select 1 from public.products where internal_sku in ('RI-003', 'RI-004', 'RI-005', 'RI-006', 'RI-007', 'RI-010', 'RI-011', 'RI-012')),
    'rejected packages leave no products behind';
  assert (select count(*) from public.product_identifiers where value in ('2000000000039', '2000000000046')) = 0,
    'rejected packages leave no identifiers behind';
end;
$$;

-- A barcode can not be attached to a second product outside the import either.
set role authenticated;
select tests.act_as('c7000000-0000-4000-8000-000000000001');
select tests.expect_error($$
  insert into public.product_identifiers (product_id, identifier_type, value)
  select id, 'unit_barcode', '2000000000015' from public.products where internal_sku = 'RI-002'
$$, 'уже принадлежит товару RI-001');
select tests.expect_error($$
  insert into public.product_identifiers (product_id, identifier_type, value)
  select id, 'box_barcode', '02000000000015' from public.products where internal_sku = 'RI-002'
$$, 'уже принадлежит товару RI-001');
-- A new code, or the same code under another type of the same product, is fine
-- (the barcode index expression is executable by authenticated).
do $$
begin
  insert into public.product_identifiers (product_id, identifier_type, value)
  select id, 'box_barcode', 'RI-BOX-0002' from public.products where internal_sku = 'RI-002';
  insert into public.product_identifiers (product_id, identifier_type, value)
  select id, 'unit_barcode', '2000000000022' from public.products where internal_sku = 'RI-002';
end;
$$;

-- 6. Counterparty roles ----------------------------------------------------------------

do $$
declare
  v jsonb := tests.ri('wrong_roles');
begin
  assert tests.ri_status(v, 'product', 'RI-008') = 'error', 'a customer is not a manufacturer';
  assert (select i ->> 'message' from jsonb_array_elements(v -> 'items') i where i ->> 'key' = 'RI-008') ~ 'нет роли manufacturer',
    format('role message: %s', v);
  assert tests.ri_status(v, 'identifier', 'RI-009 · supplier_sku X-1') = 'error', 'a customer can not own a supplier article';
end;
$$;

-- 7. Validation: prices, GTIN check digit -----------------------------------------------

do $$
declare
  v jsonb := tests.ri('price');
begin
  assert tests.ri_status(v, 'product', 'RI-013') = 'error', 'price field rejected';
  assert (select i ->> 'message' from jsonb_array_elements(v -> 'items') i where i ->> 'entity' = 'product') ~ 'похоже на цену',
    format('price message: %s', v);
end;
$$;
do $$
declare
  v jsonb := tests.ri('bad_gtin');
begin
  assert tests.ri_status(v, 'identifier', 'RI-014 · gtin 2000000000016') = 'error', format('check digit verified: %s', v);
end;
$$;
select tests.expect_error($$ select public.import_reference_data('{"format": "other", "version": 1, "products": []}'::jsonb) $$, 'format');
select tests.expect_error($$ select public.import_reference_data('{"format": "nexus-reference-import", "version": 1}'::jsonb) $$, 'Пакет пуст');
reset role;

-- 8. Counterparty rights are checked per row ---------------------------------------------

set role authenticated;
select tests.act_as('c7000000-0000-4000-8000-000000000004'); -- specialist with suppliers.create denied
do $$
declare
  v jsonb := tests.ri('new_supplier');
begin
  assert tests.ri_status(v, 'counterparty', 'RI New Supplier AB') = 'error', format('no right to create a supplier: %s', v);
end;
$$;
select tests.expect_error($$ select tests.ri('new_supplier', false) $$, 'Импорт отменён');
do $$
declare
  v jsonb := tests.ri('products_only', false);
begin
  assert (v ->> 'applied')::boolean and (v #>> '{summary,create}')::int = 2, format('specialist imports products: %s', v);
end;
$$;
reset role;

do $$
begin
  assert not exists (select 1 from public.counterparties where legal_name = 'RI New Supplier AB'), 'denied counterparty not created';
  assert (select brand from public.products where internal_sku = 'RI-001') = 'RI Premium', 'rejected package did not touch products';
  assert (select actor_user_id from public.audit_log where entity_type = 'products'
          and after_data ->> 'internal_sku' = 'RI-015' and action = 'insert') = 'c7000000-0000-4000-8000-000000000004',
    'audit records the importing user';
end;
$$;

-- 9. The documented example (docs/reference-import.example.json, the same as the
-- downloadable JSON template) is accepted by the database as is ------------------------

\set example_path :repo_root '/docs/reference-import.example.json'
\set example `cat :example_path`
insert into tests.ri_packages (name, payload) values ('docs_example', :'example');

set role authenticated;
select tests.act_as('c7000000-0000-4000-8000-000000000001');
do $$
declare
  v jsonb := tests.ri('docs_example', false);
begin
  assert (v #>> '{summary,conflict}')::int = 0 and (v #>> '{summary,error}')::int = 0, format('docs example imports cleanly: %s', v);
  assert (v #>> '{summary,create}')::int = 10, format('docs example creates every row: %s', v -> 'summary');
  v := tests.ri('docs_example', false);
  assert (v #>> '{summary,unchanged}')::int = 10, format('docs example is idempotent: %s', v -> 'summary');
end;
$$;
reset role;

\echo 'reference_import: all checks passed'
