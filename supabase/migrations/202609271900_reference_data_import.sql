-- Transactional import of the cleaned counterparty and product reference data.
--
-- public.import_reference_data(p_payload, p_dry_run) takes one package (format
-- "nexus-reference-import", version 1) and creates or updates counterparties with their
-- roles, products, product_identifiers and product_packaging in a single transaction.
-- Dry-run executes the same code path inside a savepoint that is always rolled back and
-- returns a per-row report (create / update / unchanged / conflict / error). A real run
-- aborts the whole package when any row is a conflict or an error.
--
-- Prices, costs, margins, currencies and contract terms are not part of the format: any
-- key outside the per-object whitelist makes the row an error.
--
-- Idempotent: functions are replaced, the index and trigger are re-created.

-- 1. Barcode key and database-wide barcode ownership --------------------------------------

-- Normalised comparison key for global barcodes: numeric codes are compared as GTIN-14
-- (a 13-digit EAN and its 14-digit form with a leading zero are the same code).
create or replace function private.barcode_key(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when btrim(p_value) ~ '^[0-9]{1,14}$' then lpad(btrim(p_value), 14, '0')
    else upper(btrim(p_value))
  end;
$$;

create index if not exists product_identifiers_barcode_key_idx
  on public.product_identifiers (private.barcode_key(value))
  where identifier_type in ('gtin', 'unit_barcode', 'box_barcode');

-- GS1 check digit for GTIN-8/12/13/14.
create or replace function private.gtin_is_valid(p_value text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(
    p_value ~ '^[0-9]+$' and length(p_value) in (8, 12, 13, 14)
    and (
      select (10 - sum(substr(p_value, length(p_value) - i, 1)::int * case when i % 2 = 1 then 3 else 1 end)::int % 10) % 10
      from generate_series(1, length(p_value) - 1) as i
    ) = right(p_value, 1)::int,
    false);
$$;

-- One global barcode (GTIN, unit or box barcode) may belong to one product only, whatever
-- identifier type it was recorded under. Enforced for every write, not only for imports.
create or replace function private.guard_product_barcode()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_owner text;
begin
  if new.identifier_type not in ('gtin', 'unit_barcode', 'box_barcode') then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.value = old.value and new.identifier_type = old.identifier_type
     and new.product_id = old.product_id then
    return new;
  end if;
  v_key := private.barcode_key(new.value);
  -- Serialises concurrent writers of the same code.
  perform pg_advisory_xact_lock(hashtextextended('nexus.barcode:' || v_key, 0));
  select p.internal_sku into v_owner
  from public.product_identifiers pi
  join public.products p on p.id = pi.product_id
  where pi.identifier_type in ('gtin', 'unit_barcode', 'box_barcode')
    and private.barcode_key(pi.value) = v_key
    and pi.product_id <> new.product_id
  limit 1;
  if v_owner is not null then
    raise exception 'Штрихкод % уже принадлежит товару %', new.value, v_owner
      using errcode = '23505';
  end if;
  return new;
end;
$$;

drop trigger if exists guard_product_barcode on public.product_identifiers;
create trigger guard_product_barcode
  before insert or update of identifier_type, value, product_id on public.product_identifiers
  for each row execute function private.guard_product_barcode();

-- 2. Value helpers (raise a readable error; the caller turns it into a row "error") ------

create or replace function private.ri_check_keys(p_object jsonb, p_allowed text[], p_what text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
begin
  if jsonb_typeof(p_object) is distinct from 'object' then
    raise exception '%: ожидается объект', p_what;
  end if;
  for v_key in select jsonb_object_keys(p_object) loop
    if v_key = any(p_allowed) then
      continue;
    end if;
    if v_key ~* '(price|cost|margin|markup|discount|rebate|bonus|contract|payment|incoterm|currency|контракт|цен[аыу]|себестоим|марж|наценк|скидк|бонус|договор|оплат|валют|услови)' then
      raise exception '%: поле «%» похоже на цену или коммерческое условие — такие данные в импорт справочника не включаются', p_what, v_key;
    end if;
    raise exception '%: неизвестное поле «%»', p_what, v_key;
  end loop;
end;
$$;

create or replace function private.ri_text(p_object jsonb, p_key text, p_max integer, p_what text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value jsonb := p_object -> p_key;
  v_text text;
begin
  if v_value is null or jsonb_typeof(v_value) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v_value) <> 'string' then
    raise exception '%: поле «%» должно быть строкой', p_what, p_key;
  end if;
  v_text := nullif(btrim(v_value #>> '{}'), '');
  if v_text is not null and length(v_text) > p_max then
    raise exception '%: поле «%» длиннее % символов', p_what, p_key, p_max;
  end if;
  return v_text;
end;
$$;

create or replace function private.ri_bool(p_object jsonb, p_key text, p_what text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value jsonb := p_object -> p_key;
begin
  if v_value is null or jsonb_typeof(v_value) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v_value) <> 'boolean' then
    raise exception '%: поле «%» должно быть true или false', p_what, p_key;
  end if;
  return (v_value #>> '{}')::boolean;
end;
$$;

-- Non-negative number with at most p_scale decimals, below p_max. p_positive requires > 0.
create or replace function private.ri_number(
  p_object jsonb, p_key text, p_scale integer, p_max numeric, p_positive boolean, p_what text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value jsonb := p_object -> p_key;
  v_number numeric;
begin
  if v_value is null or jsonb_typeof(v_value) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v_value) <> 'number' then
    raise exception '%: поле «%» должно быть числом', p_what, p_key;
  end if;
  v_number := (v_value #>> '{}')::numeric;
  if v_number < 0 or (p_positive and v_number = 0) then
    raise exception '%: поле «%» должно быть %', p_what, p_key,
      case when p_positive then 'больше нуля' else 'не меньше нуля' end;
  end if;
  if v_number <> round(v_number, p_scale) then
    raise exception '%: в поле «%» допускается не больше % знаков после запятой', p_what, p_key, p_scale;
  end if;
  if v_number >= p_max then
    raise exception '%: поле «%» слишком большое', p_what, p_key;
  end if;
  return v_number;
end;
$$;

-- {"ru": ..., "en": ..., "kk": ...} with non-empty strings; null when absent.
create or replace function private.ri_localized(p_object jsonb, p_key text, p_max integer, p_what text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value jsonb := p_object -> p_key;
  v_result jsonb := '{}'::jsonb;
  v_lang text;
  v_text text;
begin
  if v_value is null or jsonb_typeof(v_value) = 'null' then
    return null;
  end if;
  perform private.ri_check_keys(v_value, array['ru', 'en', 'kk'], p_what || ', ' || p_key);
  for v_lang in select jsonb_object_keys(v_value) loop
    v_text := private.ri_text(v_value, v_lang, p_max, p_what || ', ' || p_key);
    if v_text is not null then
      v_result := v_result || jsonb_build_object(v_lang, v_text);
    end if;
  end loop;
  return nullif(v_result, '{}'::jsonb);
end;
$$;

-- КБЖУ: basis (100g / 100ml / serving) and non-negative amounts with up to 3 decimals.
create or replace function private.ri_nutrition(p_object jsonb, p_what text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_value jsonb := p_object -> 'nutrition_facts';
  v_result jsonb := '{}'::jsonb;
  v_key text;
  v_basis text;
  v_number numeric;
  v_grams text[] := array['protein_g', 'fat_g', 'saturated_fat_g', 'carbohydrates_g', 'sugars_g', 'fiber_g', 'salt_g'];
begin
  if v_value is null or jsonb_typeof(v_value) = 'null' then
    return null;
  end if;
  perform private.ri_check_keys(v_value, array['basis', 'energy_kcal', 'energy_kj'] || v_grams, p_what || ', КБЖУ');
  v_basis := private.ri_text(v_value, 'basis', 20, p_what || ', КБЖУ');
  if v_basis is not null and v_basis not in ('100g', '100ml', 'serving') then
    raise exception '%, КБЖУ: basis должен быть 100g, 100ml или serving', p_what;
  end if;
  if v_basis is not null then
    v_result := jsonb_build_object('basis', v_basis);
  end if;
  foreach v_key in array (array['energy_kcal', 'energy_kj'] || v_grams) loop
    v_number := private.ri_number(v_value, v_key, 3, 100000, false, p_what || ', КБЖУ');
    if v_number is null then
      continue;
    end if;
    if v_key = any(v_grams) and coalesce(v_basis, '100g') in ('100g', '100ml') and v_number > 100 then
      raise exception '%, КБЖУ: % больше 100 г на 100 г', p_what, v_key;
    end if;
    v_result := v_result || jsonb_build_object(v_key, v_number);
  end loop;
  return nullif(v_result, '{}'::jsonb);
end;
$$;

-- private.can_access_counterparty() evaluated against permissions read once per import
-- (has_permission is too expensive to call for every row of a large package).
create or replace function private.ri_can(p_perms jsonb, p_action text, p_roles text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    ('customer' = any(p_roles) and (p_perms ->> ('customers.' || p_action))::boolean)
    or (p_roles && array['manufacturer', 'supplier', 'carrier', 'broker', 'printing_house', 'other']
      and (p_perms ->> ('suppliers.' || p_action))::boolean),
    false);
$$;

-- Resolves a counterparty reference: first a ref from this package, then an existing,
-- non-archived counterparty by tax ID or exact legal name. Checks the role and that the
-- importing user may see the counterparty. Raises NX409 (conflict) when ambiguous.
create or replace function private.ri_resolve_counterparty(
  p_ref text, p_refs jsonb, p_roles text[], p_perms jsonb, p_what text)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_entry jsonb := p_refs -> lower(p_ref);
  v_ids uuid[];
  v_party public.counterparties%rowtype;
begin
  if v_entry is not null then
    if (v_entry ->> 'failed')::boolean then
      raise exception '%: контрагент «%» из этого пакета не импортирован (конфликт или ошибка)', p_what, p_ref;
    end if;
    select * into v_party from public.counterparties where id = (v_entry ->> 'id')::uuid;
  else
    select array_agg(c.id) into v_ids
    from public.counterparties c
    where c.status <> 'archived'
      and (c.tax_id = p_ref or lower(c.legal_name) = lower(p_ref));
    if coalesce(cardinality(v_ids), 0) = 0 then
      raise exception '%: контрагент «%» не найден', p_what, p_ref;
    end if;
    if cardinality(v_ids) > 1 then
      raise exception '%: ссылке «%» соответствует несколько контрагентов, укажите БИН/ИНН', p_what, p_ref
        using errcode = 'NX409';
    end if;
    select * into v_party from public.counterparties where id = v_ids[1];
  end if;
  if not private.ri_can(p_perms, 'view', v_party.roles) then
    raise exception '%: нет доступа к контрагенту «%»', p_what, p_ref;
  end if;
  if not (v_party.roles && p_roles) then
    raise exception '%: у контрагента «%» нет роли %', p_what, p_ref,
      array_to_string(p_roles, ' или ');
  end if;
  return v_party.id;
end;
$$;

-- 3. The import itself -----------------------------------------------------------------

create or replace function private.run_reference_import(p_payload jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  c_roles constant text[] := array['manufacturer', 'supplier', 'customer', 'carrier', 'broker', 'printing_house', 'other'];
  c_uoms constant text[] := array['piece', 'box', 'layer', 'pallet', 'truck'];
  c_barcodes constant text[] := array['gtin', 'unit_barcode', 'box_barcode'];
  v_parties jsonb;
  v_products jsonb;
  v_items jsonb[] := '{}';
  v_refs jsonb := '{}'::jsonb;
  v_perms jsonb;
  v_matched uuid[] := '{}';
  v_dup_refs text[];
  v_dup_skus text[];
  v_dup_barcodes text[];
  v_item jsonb;
  v_idx bigint;
  v_child jsonb;
  v_child_idx bigint;
  v_row integer;
  v_what text;
  v_key text;
  v_label text;
  v_status text;
  v_message text;
  v_changes text[];
  v_id uuid;
  v_product_ok boolean;
  v_seen_uoms text[];
  -- counterparty fields
  v_party public.counterparties%rowtype;
  v_candidates uuid[];
  v_legal_name text;
  v_short_name text;
  v_country text;
  v_tax_id text;
  v_registration text;
  v_website text;
  v_locale text;
  v_roles text[];
  v_new_roles text[];
  -- product fields
  v_product public.products%rowtype;
  v_sku text;
  v_name jsonb;
  v_manufacturer_ref text;
  v_manufacturer_id uuid;
  v_brand text;
  v_origin text;
  v_hs_code text;
  v_shelf_life numeric;
  v_composition jsonb;
  v_nutrition jsonb;
  v_regime text;
  v_range text;
  v_base_uom text;
  v_sticker boolean;
  v_marking boolean;
  v_product_status text;
  -- identifier fields
  v_identifier public.product_identifiers%rowtype;
  v_type text;
  v_value text;
  v_barcode_key text;
  v_owner text;
  v_party_ref text;
  v_party_id uuid;
  v_packaging_uom text;
  v_primary boolean;
  -- packaging fields
  v_packaging public.product_packaging%rowtype;
  v_uom text;
  v_units numeric;
  v_gross numeric;
  v_net numeric;
  v_volume numeric;
  v_length numeric;
  v_width numeric;
  v_height numeric;
begin
  -- Package envelope ------------------------------------------------------------------
  perform private.ri_check_keys(p_payload, array['format', 'version', 'counterparties', 'products'], 'Пакет');
  if p_payload ->> 'format' is distinct from 'nexus-reference-import' or p_payload -> 'version' is distinct from '1'::jsonb then
    raise exception 'Пакет: ожидается format = "nexus-reference-import" и version = 1';
  end if;
  v_parties := coalesce(p_payload -> 'counterparties', '[]'::jsonb);
  v_products := coalesce(p_payload -> 'products', '[]'::jsonb);
  if jsonb_typeof(v_parties) <> 'array' or jsonb_typeof(v_products) <> 'array' then
    raise exception 'Пакет: counterparties и products должны быть массивами';
  end if;
  if jsonb_array_length(v_parties) + jsonb_array_length(v_products) = 0 then
    raise exception 'Пакет пуст';
  end if;
  if jsonb_array_length(v_parties) > 1000 or jsonb_array_length(v_products) > 1000 then
    raise exception 'Пакет слишком большой: не больше 1000 контрагентов и 1000 товаров; разделите файл';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_products) p
    where jsonb_typeof(p -> 'identifiers') = 'array' and jsonb_array_length(p -> 'identifiers') > 20
       or jsonb_typeof(p -> 'packaging') = 'array' and jsonb_array_length(p -> 'packaging') > 5
  ) then
    raise exception 'Пакет: у товара не больше 20 идентификаторов и 5 уровней упаковки';
  end if;

  select jsonb_object_agg(code, private.has_permission(code)) into v_perms
  from unnest(array['customers.view', 'customers.create', 'customers.update',
                    'suppliers.view', 'suppliers.create', 'suppliers.update']) as code;

  -- Duplicates inside the package make every copy a conflict.
  select coalesce(array_agg(k), '{}') into v_dup_refs from (
    select lower(btrim(coalesce(p ->> 'ref', p ->> 'tax_id', p ->> 'legal_name'))) as k
    from jsonb_array_elements(v_parties) p
    where jsonb_typeof(p) = 'object'
    group by 1 having count(*) > 1
  ) d where k is not null;
  select coalesce(array_agg(k), '{}') into v_dup_skus from (
    select btrim(p ->> 'internal_sku') as k
    from jsonb_array_elements(v_products) p
    where jsonb_typeof(p) = 'object'
    group by 1 having count(*) > 1
  ) d where k is not null;
  select coalesce(array_agg(k), '{}') into v_dup_barcodes from (
    select private.barcode_key(i ->> 'value') as k
    from jsonb_array_elements(v_products) p
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(p -> 'identifiers') = 'array' then p -> 'identifiers' else '[]'::jsonb end) i
    where jsonb_typeof(p) = 'object' and jsonb_typeof(i) = 'object'
      and i ->> 'type' = any(c_barcodes) and jsonb_typeof(i -> 'value') = 'string'
    group by 1 having count(distinct btrim(p ->> 'internal_sku')) > 1
  ) d where k is not null;

  -- Counterparties ----------------------------------------------------------------------
  for v_item, v_idx in select e.value, e.ordinality from jsonb_array_elements(v_parties) with ordinality e loop
    v_row := case when jsonb_typeof(v_item -> 'row') = 'number' and (v_item ->> 'row')::numeric between 1 and 1000000
      then (v_item ->> 'row')::numeric::integer else v_idx::integer end;
    v_what := format('Контрагент, строка %s', v_row);
    v_key := null; v_label := null; v_id := null; v_message := null; v_changes := '{}';
    begin
      v_label := coalesce(private.ri_text(v_item, 'ref', 300, v_what), private.ri_text(v_item, 'tax_id', 50, v_what),
        private.ri_text(v_item, 'legal_name', 300, v_what));
      v_key := lower(v_label);
      perform private.ri_check_keys(v_item,
        array['row', 'ref', 'legal_name', 'short_name', 'roles', 'country', 'tax_id', 'registration_number', 'website', 'preferred_locale'],
        v_what);
      v_legal_name := private.ri_text(v_item, 'legal_name', 300, v_what);
      v_short_name := private.ri_text(v_item, 'short_name', 200, v_what);
      v_country := private.ri_text(v_item, 'country', 2, v_what);
      v_tax_id := private.ri_text(v_item, 'tax_id', 50, v_what);
      v_registration := private.ri_text(v_item, 'registration_number', 100, v_what);
      v_website := private.ri_text(v_item, 'website', 300, v_what);
      v_locale := private.ri_text(v_item, 'preferred_locale', 2, v_what);
      if v_legal_name is null then
        raise exception '%: не указано юридическое название', v_what;
      end if;
      if v_country is null or v_country !~ '^[A-Z]{2}$' then
        raise exception '%: страна — двухбуквенный код ISO (KZ, FI)', v_what;
      end if;
      if v_locale is not null and v_locale not in ('ru', 'kk', 'en') then
        raise exception '%: язык — ru, kk или en', v_what;
      end if;
      if jsonb_typeof(v_item -> 'roles') is distinct from 'array' or jsonb_array_length(v_item -> 'roles') = 0 then
        raise exception '%: укажите хотя бы одну роль', v_what;
      end if;
      select array_agg(distinct r) into v_roles from jsonb_array_elements_text(v_item -> 'roles') r;
      if not (v_roles <@ c_roles) then
        raise exception '%: неизвестная роль (допустимо: %)', v_what, array_to_string(c_roles, ', ');
      end if;
      if v_key = any(v_dup_refs) then
        raise exception 'Ссылка «%» повторяется в пакете', v_label using errcode = 'NX409';
      end if;

      -- Match: tax ID first, then the legal name within the country.
      v_party := null;
      if v_tax_id is not null then
        select * into v_party from public.counterparties where country = v_country and tax_id = v_tax_id;
      end if;
      if v_party.id is null then
        select array_agg(id) into v_candidates from public.counterparties
        where country = v_country and lower(legal_name) = lower(v_legal_name);
        if cardinality(v_candidates) > 1 then
          raise exception 'Найдено несколько контрагентов «%» в %; укажите БИН/ИНН', v_legal_name, v_country using errcode = 'NX409';
        end if;
        if cardinality(v_candidates) = 1 then
          select * into v_party from public.counterparties where id = v_candidates[1];
          if v_tax_id is not null and nullif(v_party.tax_id, '') is not null and v_party.tax_id <> v_tax_id then
            raise exception 'Контрагент «%» уже есть с другим БИН/ИНН (%)', v_legal_name, v_party.tax_id using errcode = 'NX409';
          end if;
        end if;
      end if;

      if v_party.id is null then
        if not private.ri_can(v_perms, 'create', v_roles) then
          raise exception 'Недостаточно прав для создания контрагента с ролями %', array_to_string(v_roles, ', ');
        end if;
        insert into public.counterparties (roles, legal_name, short_name, country, tax_id, registration_number, website, preferred_locale, status)
        values (v_roles, v_legal_name, v_short_name, v_country, v_tax_id, v_registration, v_website, v_locale, 'active')
        returning id into v_id;
        v_status := 'create';
      else
        if v_party.id = any(v_matched) then
          raise exception 'Контрагент «%» уже сопоставлен с другой строкой пакета', v_party.legal_name using errcode = 'NX409';
        end if;
        if v_party.status = 'archived' then
          raise exception 'Контрагент «%» в архиве', v_party.legal_name using errcode = 'NX409';
        end if;
        -- Roles are only added: removing a role could orphan products and documents.
        v_new_roles := v_party.roles || array(select r from unnest(v_roles) r where r <> all(v_party.roles) order by r);
        if v_legal_name is distinct from v_party.legal_name then v_changes := v_changes || 'legal_name'::text; end if;
        if v_short_name is not null and v_short_name is distinct from v_party.short_name then v_changes := v_changes || 'short_name'::text; end if;
        if v_tax_id is not null and v_tax_id is distinct from v_party.tax_id then v_changes := v_changes || 'tax_id'::text; end if;
        if v_registration is not null and v_registration is distinct from v_party.registration_number then v_changes := v_changes || 'registration_number'::text; end if;
        if v_website is not null and v_website is distinct from v_party.website then v_changes := v_changes || 'website'::text; end if;
        if v_locale is not null and v_locale is distinct from v_party.preferred_locale then v_changes := v_changes || 'preferred_locale'::text; end if;
        if v_new_roles <> v_party.roles then v_changes := v_changes || 'roles'::text; end if;
        if cardinality(v_changes) > 0 then
          if not private.ri_can(v_perms, 'update', v_party.roles)
             or not private.ri_can(v_perms, 'update', v_new_roles) then
            raise exception 'Недостаточно прав для изменения контрагента «%»', v_party.legal_name;
          end if;
          update public.counterparties set
            legal_name = v_legal_name,
            short_name = coalesce(v_short_name, short_name),
            tax_id = coalesce(v_tax_id, tax_id),
            registration_number = coalesce(v_registration, registration_number),
            website = coalesce(v_website, website),
            preferred_locale = coalesce(v_locale, preferred_locale),
            roles = v_new_roles,
            updated_at = now()
          where id = v_party.id;
          v_status := 'update';
        else
          if not private.ri_can(v_perms, 'view', v_party.roles) then
            raise exception 'Нет доступа к контрагенту «%»', v_party.legal_name;
          end if;
          v_status := 'unchanged';
        end if;
        v_id := v_party.id;
      end if;
    exception
      when sqlstate 'NX409' then v_status := 'conflict'; v_message := sqlerrm;
      when others then v_status := 'error'; v_message := sqlerrm;
    end;
    if v_key is not null and not v_refs ? v_key then
      v_refs := v_refs || jsonb_build_object(v_key,
        case when v_status in ('conflict', 'error') then '{"failed": true}'::jsonb else jsonb_build_object('id', v_id) end);
    end if;
    if v_id is not null then
      v_matched := v_matched || v_id;
    end if;
    v_items := array_append(v_items, jsonb_build_object('entity', 'counterparty', 'row', v_row,
      'key', coalesce(v_label, format('#%s', v_idx)), 'status', v_status, 'changes', to_jsonb(v_changes), 'message', v_message));
  end loop;

  -- Products with identifiers and packaging ---------------------------------------------
  for v_item, v_idx in select e.value, e.ordinality from jsonb_array_elements(v_products) with ordinality e loop
    v_row := case when jsonb_typeof(v_item -> 'row') = 'number' and (v_item ->> 'row')::numeric between 1 and 1000000
      then (v_item ->> 'row')::numeric::integer else v_idx::integer end;
    v_what := format('Товар, строка %s', v_row);
    v_sku := null; v_id := null; v_message := null; v_changes := '{}'; v_product_ok := false;
    begin
      v_sku := private.ri_text(v_item, 'internal_sku', 64, v_what);
      perform private.ri_check_keys(v_item,
        array['row', 'internal_sku', 'name', 'manufacturer', 'brand', 'country_of_origin', 'hs_code', 'shelf_life_days',
              'composition', 'nutrition_facts', 'temperature_regime', 'temperature_range', 'base_uom',
              'requires_sticker', 'requires_marking', 'status', 'identifiers', 'packaging'],
        v_what);
      if v_sku is null then
        raise exception '%: не указан внутренний артикул (internal_sku)', v_what;
      end if;
      v_what := format('Товар %s (строка %s)', v_sku, v_row);
      if v_sku = any(v_dup_skus) then
        raise exception 'Артикул % повторяется в пакете', v_sku using errcode = 'NX409';
      end if;
      v_name := private.ri_localized(v_item, 'name', 300, v_what);
      v_manufacturer_ref := private.ri_text(v_item, 'manufacturer', 300, v_what);
      v_brand := private.ri_text(v_item, 'brand', 200, v_what);
      v_origin := private.ri_text(v_item, 'country_of_origin', 2, v_what);
      v_hs_code := private.ri_text(v_item, 'hs_code', 10, v_what);
      v_shelf_life := private.ri_number(v_item, 'shelf_life_days', 0, 36501, true, v_what);
      v_composition := private.ri_localized(v_item, 'composition', 4000, v_what);
      v_nutrition := private.ri_nutrition(v_item, v_what);
      v_regime := private.ri_text(v_item, 'temperature_regime', 20, v_what);
      v_range := private.ri_text(v_item, 'temperature_range', 50, v_what);
      v_base_uom := private.ri_text(v_item, 'base_uom', 20, v_what);
      v_sticker := private.ri_bool(v_item, 'requires_sticker', v_what);
      v_marking := private.ri_bool(v_item, 'requires_marking', v_what);
      v_product_status := private.ri_text(v_item, 'status', 20, v_what);
      if v_origin is not null and v_origin !~ '^[A-Z]{2}$' then
        raise exception '%: страна происхождения — двухбуквенный код ISO', v_what;
      end if;
      if v_hs_code is not null and v_hs_code !~ '^[0-9]{4,10}$' then
        raise exception '%: код ТН ВЭД — от 4 до 10 цифр', v_what;
      end if;
      if v_regime is not null and v_regime not in ('frozen', 'chilled', 'ambient') then
        raise exception '%: температурный режим — frozen, chilled или ambient', v_what;
      end if;
      if v_base_uom is not null and v_base_uom <> all(c_uoms) then
        raise exception '%: неизвестная базовая единица «%»', v_what, v_base_uom;
      end if;
      if v_product_status is not null and v_product_status not in ('draft', 'active', 'discontinued') then
        raise exception '%: статус — draft, active или discontinued', v_what;
      end if;
      if (v_item ? 'identifiers' and jsonb_typeof(v_item -> 'identifiers') not in ('array', 'null'))
         or (v_item ? 'packaging' and jsonb_typeof(v_item -> 'packaging') not in ('array', 'null')) then
        raise exception '%: identifiers и packaging должны быть массивами', v_what;
      end if;
      if v_manufacturer_ref is not null then
        v_manufacturer_id := private.ri_resolve_counterparty(v_manufacturer_ref, v_refs, array['manufacturer'], v_perms, v_what);
      else
        v_manufacturer_id := null;
      end if;

      select * into v_product from public.products where internal_sku = v_sku for update;
      if v_product.id is null then
        if v_name is null or v_name ->> 'ru' is null then
          raise exception '%: для нового товара нужно название на русском (name.ru)', v_what;
        end if;
        if v_manufacturer_id is null then
          raise exception '%: для нового товара нужен производитель', v_what;
        end if;
        insert into public.products (internal_sku, name, manufacturer_id, brand, country_of_origin, composition, nutrition_facts,
          hs_code, temperature_regime, temperature_range, shelf_life_days, base_uom, requires_marking, requires_sticker, status)
        values (v_sku, v_name, v_manufacturer_id, v_brand, v_origin, v_composition, v_nutrition,
          v_hs_code, v_regime, v_range, v_shelf_life::integer, coalesce(v_base_uom, 'piece'), coalesce(v_marking, false),
          coalesce(v_sticker, false), coalesce(v_product_status, 'active'))
        returning id into v_id;
        v_status := 'create';
      else
        if v_product.status = 'archived' then
          raise exception 'Товар % в архиве', v_sku using errcode = 'NX409';
        end if;
        -- Absent fields keep their values; localized texts and КБЖУ are merged by key.
        v_name := v_product.name || coalesce(v_name, '{}'::jsonb);
        v_composition := case when v_composition is null then v_product.composition else coalesce(v_product.composition, '{}'::jsonb) || v_composition end;
        v_nutrition := case when v_nutrition is null then v_product.nutrition_facts else coalesce(v_product.nutrition_facts, '{}'::jsonb) || v_nutrition end;
        v_manufacturer_id := coalesce(v_manufacturer_id, v_product.manufacturer_id);
        if v_name <> v_product.name then v_changes := v_changes || 'name'::text; end if;
        if v_manufacturer_id <> v_product.manufacturer_id then v_changes := v_changes || 'manufacturer'::text; end if;
        if v_brand is not null and v_brand is distinct from v_product.brand then v_changes := v_changes || 'brand'::text; end if;
        if v_origin is not null and v_origin is distinct from v_product.country_of_origin then v_changes := v_changes || 'country_of_origin'::text; end if;
        if v_hs_code is not null and v_hs_code is distinct from v_product.hs_code then v_changes := v_changes || 'hs_code'::text; end if;
        if v_shelf_life is not null and v_shelf_life::integer is distinct from v_product.shelf_life_days then v_changes := v_changes || 'shelf_life_days'::text; end if;
        if v_composition is distinct from v_product.composition then v_changes := v_changes || 'composition'::text; end if;
        if v_nutrition is distinct from v_product.nutrition_facts then v_changes := v_changes || 'nutrition_facts'::text; end if;
        if v_regime is not null and v_regime is distinct from v_product.temperature_regime then v_changes := v_changes || 'temperature_regime'::text; end if;
        if v_range is not null and v_range is distinct from v_product.temperature_range then v_changes := v_changes || 'temperature_range'::text; end if;
        if v_base_uom is not null and v_base_uom is distinct from v_product.base_uom then v_changes := v_changes || 'base_uom'::text; end if;
        if v_sticker is not null and v_sticker is distinct from v_product.requires_sticker then v_changes := v_changes || 'requires_sticker'::text; end if;
        if v_marking is not null and v_marking is distinct from v_product.requires_marking then v_changes := v_changes || 'requires_marking'::text; end if;
        if v_product_status is not null and v_product_status is distinct from v_product.status then v_changes := v_changes || 'status'::text; end if;
        if cardinality(v_changes) > 0 then
          update public.products set
            name = v_name,
            manufacturer_id = v_manufacturer_id,
            brand = coalesce(v_brand, brand),
            country_of_origin = coalesce(v_origin, country_of_origin),
            hs_code = coalesce(v_hs_code, hs_code),
            shelf_life_days = coalesce(v_shelf_life::integer, shelf_life_days),
            composition = v_composition,
            nutrition_facts = v_nutrition,
            temperature_regime = coalesce(v_regime, temperature_regime),
            temperature_range = coalesce(v_range, temperature_range),
            base_uom = coalesce(v_base_uom, base_uom),
            requires_sticker = coalesce(v_sticker, requires_sticker),
            requires_marking = coalesce(v_marking, requires_marking),
            status = coalesce(v_product_status, status),
            updated_at = now()
          where id = v_product.id;
          v_status := 'update';
        else
          v_status := 'unchanged';
        end if;
        v_id := v_product.id;
      end if;
      v_product_ok := true;
    exception
      when sqlstate 'NX409' then v_status := 'conflict'; v_message := sqlerrm;
      when others then v_status := 'error'; v_message := sqlerrm;
    end;
    v_items := array_append(v_items, jsonb_build_object('entity', 'product', 'row', v_row,
      'key', coalesce(v_sku, format('#%s', v_idx)), 'status', v_status, 'changes', to_jsonb(v_changes), 'message', v_message));
    if not v_product_ok then
      continue;
    end if;

    -- Identifiers of this product.
    for v_child, v_child_idx in
      select e.value, e.ordinality
      from jsonb_array_elements(case when jsonb_typeof(v_item -> 'identifiers') = 'array' then v_item -> 'identifiers' else '[]'::jsonb end) with ordinality e
    loop
      v_what := format('Идентификатор %s товара %s (строка %s)', v_child_idx, v_sku, v_row);
      v_label := format('%s · #%s', v_sku, v_child_idx);
      v_message := null; v_changes := '{}';
      begin
        perform private.ri_check_keys(v_child, array['type', 'value', 'counterparty', 'packaging_uom', 'is_primary'], v_what);
        v_type := private.ri_text(v_child, 'type', 20, v_what);
        v_value := private.ri_text(v_child, 'value', 100, v_what);
        v_party_ref := private.ri_text(v_child, 'counterparty', 300, v_what);
        v_packaging_uom := private.ri_text(v_child, 'packaging_uom', 20, v_what);
        v_primary := private.ri_bool(v_child, 'is_primary', v_what);
        if v_type is null or v_type not in ('supplier_sku', 'gtin', 'unit_barcode', 'box_barcode') then
          raise exception '%: тип — supplier_sku, gtin, unit_barcode или box_barcode', v_what;
        end if;
        if v_value is null then
          raise exception '%: не указано значение', v_what;
        end if;
        v_label := format('%s · %s %s', v_sku, v_type, v_value);
        if v_packaging_uom is not null and v_packaging_uom <> all(c_uoms) then
          raise exception '%: неизвестный уровень упаковки «%»', v_what, v_packaging_uom;
        end if;
        if v_type = 'gtin' and not private.gtin_is_valid(v_value) then
          raise exception '%: GTIN % — нужно 8, 12, 13 или 14 цифр с верной контрольной цифрой', v_what, v_value;
        end if;
        if v_type in ('unit_barcode', 'box_barcode') and v_value !~ '^[0-9A-Za-z-]{4,48}$' then
          raise exception '%: штрихкод % — от 4 до 48 латинских букв, цифр или дефисов', v_what, v_value;
        end if;

        v_identifier := null;
        if v_type = any(c_barcodes) then
          if v_party_ref is not null then
            raise exception '%: у штрихкода не указывается контрагент', v_what;
          end if;
          v_barcode_key := private.barcode_key(v_value);
          if v_barcode_key = any(v_dup_barcodes) then
            raise exception 'Штрихкод % указан у нескольких товаров пакета', v_value using errcode = 'NX409';
          end if;
          select p.internal_sku into v_owner
          from public.product_identifiers pi join public.products p on p.id = pi.product_id
          where pi.identifier_type in ('gtin', 'unit_barcode', 'box_barcode') and private.barcode_key(pi.value) = v_barcode_key
            and pi.product_id <> v_id
          limit 1;
          if v_owner is not null then
            raise exception 'Штрихкод % уже принадлежит товару %', v_value, v_owner using errcode = 'NX409';
          end if;
          select * into v_identifier from public.product_identifiers
          where identifier_type in ('gtin', 'unit_barcode', 'box_barcode') and private.barcode_key(value) = v_barcode_key
            and product_id = v_id and identifier_type = v_type
          limit 1;
          v_party_id := null;
        else
          if length(v_value) > 100 then
            raise exception '%: артикул поставщика длиннее 100 символов', v_what;
          end if;
          if v_party_ref is null then
            raise exception '%: для артикула поставщика нужен контрагент (counterparty)', v_what;
          end if;
          v_party_id := private.ri_resolve_counterparty(v_party_ref, v_refs, array['supplier', 'manufacturer'], v_perms, v_what);
          select * into v_identifier from public.product_identifiers
          where identifier_type = 'supplier_sku' and counterparty_id = v_party_id and value = v_value;
          if v_identifier.id is not null and v_identifier.product_id <> v_id then
            select internal_sku into v_owner from public.products where id = v_identifier.product_id;
            raise exception 'Артикул поставщика % уже принадлежит товару %', v_value, v_owner using errcode = 'NX409';
          end if;
        end if;

        if v_identifier.id is null then
          insert into public.product_identifiers (product_id, identifier_type, value, counterparty_id, packaging_uom, is_primary)
          values (v_id, v_type, v_value, v_party_id, v_packaging_uom, coalesce(v_primary, false));
          v_status := 'create';
        else
          if v_packaging_uom is not null and v_packaging_uom is distinct from v_identifier.packaging_uom then v_changes := v_changes || 'packaging_uom'::text; end if;
          if v_primary is not null and v_primary <> v_identifier.is_primary then v_changes := v_changes || 'is_primary'::text; end if;
          if cardinality(v_changes) > 0 then
            update public.product_identifiers set
              packaging_uom = coalesce(v_packaging_uom, packaging_uom),
              is_primary = coalesce(v_primary, is_primary),
              updated_at = now()
            where id = v_identifier.id;
            v_status := 'update';
          else
            v_status := 'unchanged';
          end if;
        end if;
      exception
        when sqlstate 'NX409' then v_status := 'conflict'; v_message := sqlerrm;
        when others then v_status := 'error'; v_message := sqlerrm;
      end;
      v_items := array_append(v_items, jsonb_build_object('entity', 'identifier', 'row', v_row,
        'key', v_label, 'status', v_status, 'changes', to_jsonb(v_changes), 'message', v_message));
    end loop;

    -- Packaging levels of this product.
    v_seen_uoms := '{}';
    for v_child, v_child_idx in
      select e.value, e.ordinality
      from jsonb_array_elements(case when jsonb_typeof(v_item -> 'packaging') = 'array' then v_item -> 'packaging' else '[]'::jsonb end) with ordinality e
    loop
      v_what := format('Упаковка %s товара %s (строка %s)', v_child_idx, v_sku, v_row);
      v_label := format('%s · #%s', v_sku, v_child_idx);
      v_message := null; v_changes := '{}';
      begin
        perform private.ri_check_keys(v_child,
          array['uom', 'units_per_parent', 'gross_weight_kg', 'net_weight_kg', 'volume_m3', 'length_cm', 'width_cm', 'height_cm'], v_what);
        v_uom := private.ri_text(v_child, 'uom', 20, v_what);
        if v_uom is null or v_uom <> all(c_uoms) then
          raise exception '%: уровень — piece, box, layer, pallet или truck', v_what;
        end if;
        v_label := format('%s · %s', v_sku, v_uom);
        if v_uom = any(v_seen_uoms) then
          raise exception 'Уровень упаковки % указан дважды', v_uom using errcode = 'NX409';
        end if;
        v_seen_uoms := v_seen_uoms || v_uom;
        v_units := private.ri_number(v_child, 'units_per_parent', 3, 1000000000, true, v_what);
        v_gross := private.ri_number(v_child, 'gross_weight_kg', 3, 10000000, false, v_what);
        v_net := private.ri_number(v_child, 'net_weight_kg', 3, 10000000, false, v_what);
        v_volume := private.ri_number(v_child, 'volume_m3', 4, 1000000, false, v_what);
        v_length := private.ri_number(v_child, 'length_cm', 2, 1000000, false, v_what);
        v_width := private.ri_number(v_child, 'width_cm', 2, 1000000, false, v_what);
        v_height := private.ri_number(v_child, 'height_cm', 2, 1000000, false, v_what);

        select * into v_packaging from public.product_packaging where product_id = v_id and uom = v_uom for update;
        if coalesce(v_net, v_packaging.net_weight_kg) > coalesce(v_gross, v_packaging.gross_weight_kg) then
          raise exception '%: вес нетто больше веса брутто', v_what;
        end if;
        if v_packaging.id is null then
          if v_units is null then
            raise exception '%: для нового уровня упаковки нужно units_per_parent', v_what;
          end if;
          insert into public.product_packaging (product_id, uom, units_per_parent, gross_weight_kg, net_weight_kg, volume_m3, length_cm, width_cm, height_cm)
          values (v_id, v_uom, v_units, v_gross, v_net, v_volume, v_length, v_width, v_height);
          v_status := 'create';
        else
          if v_units is not null and v_units <> v_packaging.units_per_parent then v_changes := v_changes || 'units_per_parent'::text; end if;
          if v_gross is not null and v_gross is distinct from v_packaging.gross_weight_kg then v_changes := v_changes || 'gross_weight_kg'::text; end if;
          if v_net is not null and v_net is distinct from v_packaging.net_weight_kg then v_changes := v_changes || 'net_weight_kg'::text; end if;
          if v_volume is not null and v_volume is distinct from v_packaging.volume_m3 then v_changes := v_changes || 'volume_m3'::text; end if;
          if v_length is not null and v_length is distinct from v_packaging.length_cm then v_changes := v_changes || 'length_cm'::text; end if;
          if v_width is not null and v_width is distinct from v_packaging.width_cm then v_changes := v_changes || 'width_cm'::text; end if;
          if v_height is not null and v_height is distinct from v_packaging.height_cm then v_changes := v_changes || 'height_cm'::text; end if;
          if cardinality(v_changes) > 0 then
            update public.product_packaging set
              units_per_parent = coalesce(v_units, units_per_parent),
              gross_weight_kg = coalesce(v_gross, gross_weight_kg),
              net_weight_kg = coalesce(v_net, net_weight_kg),
              volume_m3 = coalesce(v_volume, volume_m3),
              length_cm = coalesce(v_length, length_cm),
              width_cm = coalesce(v_width, width_cm),
              height_cm = coalesce(v_height, height_cm),
              updated_at = now()
            where id = v_packaging.id;
            v_status := 'update';
          else
            v_status := 'unchanged';
          end if;
        end if;
      exception
        when sqlstate 'NX409' then v_status := 'conflict'; v_message := sqlerrm;
        when others then v_status := 'error'; v_message := sqlerrm;
      end;
      v_items := array_append(v_items, jsonb_build_object('entity', 'packaging', 'row', v_row,
        'key', v_label, 'status', v_status, 'changes', to_jsonb(v_changes), 'message', v_message));
    end loop;
  end loop;

  return jsonb_build_object(
    'summary', (
      select jsonb_build_object(
        'create', count(*) filter (where i ->> 'status' = 'create'),
        'update', count(*) filter (where i ->> 'status' = 'update'),
        'unchanged', count(*) filter (where i ->> 'status' = 'unchanged'),
        'conflict', count(*) filter (where i ->> 'status' = 'conflict'),
        'error', count(*) filter (where i ->> 'status' = 'error'))
      from unnest(v_items) i),
    'items', to_jsonb(v_items));
end;
$$;

-- Public entry point. p_dry_run defaults to true so a bare call never writes.
create or replace function public.import_reference_data(p_payload jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report jsonb;
  v_problems jsonb;
begin
  if not ((select private.has_permission('products.create')) and (select private.has_permission('products.update'))) then
    raise exception 'Недостаточно прав для импорта справочника: нужны права «Товары: создание» и «Товары: изменение»'
      using errcode = '42501';
  end if;
  if p_payload is null then
    raise exception 'Пакет пуст';
  end if;
  -- One import at a time: row matching reads what earlier rows of the package wrote.
  perform pg_advisory_xact_lock(hashtextextended('nexus.reference_import', 0));

  if coalesce(p_dry_run, true) then
    begin
      v_report := private.run_reference_import(p_payload);
      raise exception 'dry run' using errcode = 'NXDRY';
    exception
      when sqlstate 'NXDRY' then null; -- everything written above is rolled back
    end;
    return v_report || jsonb_build_object('dry_run', true, 'applied', false);
  end if;

  v_report := private.run_reference_import(p_payload);
  if (v_report #>> '{summary,conflict}')::int + (v_report #>> '{summary,error}')::int > 0 then
    select coalesce(jsonb_agg(i), '[]'::jsonb) into v_problems
    from (
      select i from jsonb_array_elements(v_report -> 'items') i
      where i ->> 'status' in ('conflict', 'error')
      limit 200
    ) p;
    raise exception 'Импорт отменён: конфликтов %, ошибок %. Ни одна запись не сохранена.',
      v_report #>> '{summary,conflict}', v_report #>> '{summary,error}'
      using errcode = 'NX422',
        detail = jsonb_build_object('summary', v_report -> 'summary', 'items', v_problems)::text;
  end if;
  return v_report || jsonb_build_object('dry_run', false, 'applied', true);
end;
$$;

-- 4. Privileges ------------------------------------------------------------------------

revoke execute on function private.barcode_key(text) from public;
revoke execute on function private.gtin_is_valid(text) from public;
revoke execute on function private.guard_product_barcode() from public;
revoke execute on function private.ri_check_keys(jsonb, text[], text) from public;
revoke execute on function private.ri_text(jsonb, text, integer, text) from public;
revoke execute on function private.ri_bool(jsonb, text, text) from public;
revoke execute on function private.ri_number(jsonb, text, integer, numeric, boolean, text) from public;
revoke execute on function private.ri_localized(jsonb, text, integer, text) from public;
revoke execute on function private.ri_nutrition(jsonb, text) from public;
revoke execute on function private.ri_can(jsonb, text, text[]) from public;
revoke execute on function private.ri_resolve_counterparty(text, jsonb, text[], jsonb, text) from public;
revoke execute on function private.run_reference_import(jsonb) from public;
-- The barcode index expression is evaluated for the writing role.
grant execute on function private.barcode_key(text) to authenticated, service_role;

revoke execute on function public.import_reference_data(jsonb, boolean) from public, anon;
grant execute on function public.import_reference_data(jsonb, boolean) to authenticated;

comment on function public.import_reference_data(jsonb, boolean) is
  'Transactional, idempotent import of counterparties, products, identifiers and packaging (format nexus-reference-import v1). Dry-run by default.';
