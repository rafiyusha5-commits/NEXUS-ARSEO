-- Block В, part 1 (2026-11-28): scanning — what a code is, Nexus labels for locations and batches, binding an unknown
-- code to a product. Owner decisions of 2026-11-28 (damirator1-afk, defaults of the task accepted), see
-- docs/mobile-warehouse.md:
--   * the phone camera, a Bluetooth scanner working as a keyboard (Enter at the end) and typing — one field (В1);
--   * no offline work in the first version (В2);
--   * labels of locations and batches: A4 sheets and one thermal size, every print recorded (В3);
--   * an unknown code is bound to a product only with products.update, after a confirmation, in the audit log;
--     without the right the answer is "код не найден" and nothing is created (В4).
-- A scan writes nothing by itself: scan_lookup only reads. GS1 strings are parsed in the application; the lookup gets the
-- GTIN (and the batch number of AI 10 when there is one).
begin;

-- Nexus labels: a short opaque code per location or batch. NX- and 8 characters of Crockford base32 (no I, L, O, U).
create table if not exists public.scan_labels (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^NX-[0-9A-HJKMNP-TV-Z]{8}$'),
  target_type text not null check (target_type in ('location', 'batch')),
  location_id uuid references public.warehouse_locations(id) on delete restrict,
  batch_id uuid references public.inventory_batches(id) on delete restrict,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  check ((target_type = 'location') = (location_id is not null)),
  check ((target_type = 'batch') = (batch_id is not null))
);
create unique index if not exists scan_labels_location_unique on public.scan_labels(location_id) where location_id is not null;
create unique index if not exists scan_labels_batch_unique on public.scan_labels(batch_id) where batch_id is not null;
create index if not exists scan_labels_created_by_idx on public.scan_labels(created_by);

-- Every print of a label: the first one and every reprint.
create table if not exists public.scan_label_prints (
  id uuid primary key default gen_random_uuid(),
  label_id uuid not null references public.scan_labels(id) on delete restrict,
  print_format text not null check (print_format in ('a4', 'thermal')),
  copies integer not null check (copies between 1 and 100),
  is_reprint boolean not null,
  printed_by uuid not null references public.profiles(id) on delete restrict,
  printed_at timestamptz not null default clock_timestamp()
);
create index if not exists scan_label_prints_label_idx on public.scan_label_prints(label_id, printed_at desc);
create index if not exists scan_label_prints_printed_by_idx on public.scan_label_prints(printed_by);

alter table public.scan_labels enable row level security;
alter table public.scan_label_prints enable row level security;
revoke all on public.scan_labels, public.scan_label_prints from public, anon, authenticated, service_role;

create or replace function private.guard_scan_history() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'Этикетки и журнал печати не меняются' using errcode = '42501';
end $$;
revoke all on function private.guard_scan_history() from public, anon, authenticated, service_role;
drop trigger if exists scan_labels_immutable on public.scan_labels;
create trigger scan_labels_immutable before update or delete on public.scan_labels
  for each row execute function private.guard_scan_history();
drop trigger if exists scan_label_prints_immutable on public.scan_label_prints;
create trigger scan_label_prints_immutable before update or delete on public.scan_label_prints
  for each row execute function private.guard_scan_history();

create or replace function private.require_scan_view() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not ((select private.has_permission('inventory.view')) or (select private.has_permission('products.view'))) then
    raise exception 'Нет доступа к поиску по коду' using errcode = '42501';
  end if;
end $$;
revoke all on function private.require_scan_view() from public, anon, authenticated, service_role;

-- A new opaque label code; collisions are retried.
create or replace function private.new_scan_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
  v_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_code text;
  v_bytes bytea;
begin
  loop
    v_bytes := decode(md5(gen_random_uuid()::text || clock_timestamp()::text), 'hex');
    v_code := 'NX-';
    for i in 0..7 loop
      v_code := v_code || substr(v_alphabet, (get_byte(v_bytes, i) % 32) + 1, 1);
    end loop;
    exit when not exists (select 1 from public.scan_labels where code = v_code);
  end loop;
  return v_code;
end $$;
revoke all on function private.new_scan_code() from public, anon, authenticated, service_role;

-- Labels of locations or batches, made when missing (the code of a place or batch never changes). Locations need
-- warehouses.update or a stock right; batches a stock right.
create or replace function public.ensure_scan_labels(p_target_type text, p_ids uuid[])
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if p_target_type is null or p_target_type not in ('location', 'batch') then
    raise exception 'Выберите места или партии';
  end if;
  if not ((select private.has_permission('inventory.move')) or (select private.has_permission('inventory.receive'))
          or (select private.has_permission('inventory.control'))
          or (p_target_type = 'location' and (select private.has_permission('warehouses.update')))) then
    raise exception 'Нет права печатать этикетки склада' using errcode = '42501';
  end if;
  if p_ids is null or cardinality(p_ids) = 0 or cardinality(p_ids) > 500 then
    raise exception 'Выберите от 1 до 500 этикеток';
  end if;
  foreach v_id in array p_ids loop
    if p_target_type = 'location' then
      if not exists (select 1 from public.warehouse_locations where id = v_id) then
        raise exception 'Место не найдено';
      end if;
      insert into public.scan_labels(code, target_type, location_id, created_by)
      values (private.new_scan_code(), 'location', v_id, auth.uid()) on conflict do nothing;
    else
      if not exists (select 1 from public.inventory_batches where id = v_id) then
        raise exception 'Партия не найдена';
      end if;
      insert into public.scan_labels(code, target_type, batch_id, created_by)
      values (private.new_scan_code(), 'batch', v_id, auth.uid()) on conflict do nothing;
    end if;
  end loop;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'label_id', l.id, 'code', l.code, 'target_type', l.target_type, 'location_id', l.location_id, 'batch_id', l.batch_id,
             'title', case when l.target_type = 'location' then wl.code else p.internal_sku || ' · ' || b.batch_number end,
             'subtitle', case when l.target_type = 'location' then coalesce(w.name ->> 'ru', w.code) || ' · ' || wl.zone
                              else coalesce(p.name ->> 'ru', p.internal_sku) || coalesce(' · до ' || to_char(b.expiry_date, 'DD.MM.YYYY'), '') end,
             'printed', exists (select 1 from public.scan_label_prints x where x.label_id = l.id))
             order by array_position(p_ids, coalesce(l.location_id, l.batch_id)))
      from public.scan_labels l
      left join public.warehouse_locations wl on wl.id = l.location_id
      left join public.warehouses w on w.id = wl.warehouse_id
      left join public.inventory_batches b on b.id = l.batch_id
      left join public.products p on p.id = b.product_id
     where coalesce(l.location_id, l.batch_id) = any(p_ids) and l.target_type = p_target_type), '[]'::jsonb);
end $$;
revoke all on function public.ensure_scan_labels(text, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.ensure_scan_labels(text, uuid[]) to authenticated;

-- A print of labels: one record per label, marked as a reprint when the label was printed before.
create or replace function public.record_label_print(p_label_ids uuid[], p_format text, p_copies integer)
returns integer
language plpgsql security definer set search_path = '' as $$
declare v_rows integer;
begin
  if not ((select private.has_permission('inventory.move')) or (select private.has_permission('inventory.receive'))
          or (select private.has_permission('inventory.control')) or (select private.has_permission('warehouses.update'))) then
    raise exception 'Нет права печатать этикетки склада' using errcode = '42501';
  end if;
  if p_format is null or p_format not in ('a4', 'thermal') then
    raise exception 'Выберите формат: лист A4 или термопринтер';
  end if;
  if p_copies is null or p_copies not between 1 and 100 then
    raise exception 'Укажите от 1 до 100 копий';
  end if;
  if p_label_ids is null or cardinality(p_label_ids) = 0 or exists (select 1 from unnest(p_label_ids) x(id)
                                                                      where not exists (select 1 from public.scan_labels l where l.id = x.id)) then
    raise exception 'Этикетка не найдена';
  end if;
  insert into public.scan_label_prints(label_id, print_format, copies, is_reprint, printed_by)
  select x.id, p_format, p_copies, exists (select 1 from public.scan_label_prints p where p.label_id = x.id), auth.uid()
    from (select distinct unnest(p_label_ids) as id) x;
  get diagnostics v_rows = row_count;
  return v_rows;
end $$;
revoke all on function public.record_label_print(uuid[], text, integer) from public, anon, authenticated, service_role;
grant execute on function public.record_label_print(uuid[], text, integer) to authenticated;

-- Stock rows of a batch or a location: where, how much is free, the expiry; cost only with purchase prices.
create or replace function private.scan_stock(p_product_id uuid, p_batch_id uuid, p_location_id uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'balance_id', bl.id, 'warehouse_id', bl.warehouse_id, 'warehouse', coalesce(w.name ->> 'ru', w.code),
           'location_id', bl.warehouse_location_id, 'location', wl.code, 'product_id', b.product_id, 'sku', p.internal_sku,
           'product', coalesce(p.name ->> 'ru', p.internal_sku), 'batch_id', b.id, 'batch', b.batch_number, 'expiry_date', b.expiry_date,
           'batch_status', b.status, 'uom', bl.uom, 'on_hand', bl.quantity_on_hand::text, 'reserved', bl.quantity_reserved::text,
           'free', (bl.quantity_on_hand - bl.quantity_reserved)::text,
           'unit_cost', case when (select private.has_permission('prices.purchase.view')) then b.unit_landed_cost::text end,
           'cost_currency', case when (select private.has_permission('prices.purchase.view')) then (select code from public.currencies where id = b.cost_currency_id) end,
           'cost_uom', case when (select private.has_permission('prices.purchase.view')) then b.cost_uom end)
           order by b.expiry_date nulls last, coalesce(w.name ->> 'ru', w.code), wl.code, b.batch_number), '[]'::jsonb)
    from public.inventory_balances bl
    join public.inventory_batches b on b.id = bl.batch_id
    join public.products p on p.id = b.product_id
    join public.warehouses w on w.id = bl.warehouse_id
    left join public.warehouse_locations wl on wl.id = bl.warehouse_location_id
   where bl.quantity_on_hand > 0
     and (select private.has_permission('inventory.view'))
     and (p_product_id is null or b.product_id = p_product_id)
     and (p_batch_id is null or b.id = p_batch_id)
     and (p_location_id is null or bl.warehouse_location_id = p_location_id)
$$;
revoke all on function private.scan_stock(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- What a scanned code is. Read only. kind: location / batch (a Nexus label), product (a product barcode with the unit of
-- its packaging), unknown. p_batch_number: the batch of a GS1 code (AI 10) to narrow the stock of the product.
create or replace function public.scan_lookup(p_code text, p_batch_number text default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_code text := upper(btrim(coalesce(p_code, '')));
  l public.scan_labels;
  v_products jsonb;
begin
  perform private.require_scan_view();
  if v_code = '' or length(v_code) > 200 then
    raise exception 'Пустой или слишком длинный код';
  end if;
  select * into l from public.scan_labels where code = v_code;
  if found and l.target_type = 'location' then
    return jsonb_build_object('kind', 'location', 'code', l.code,
      'location', (select jsonb_build_object('id', wl.id, 'code', wl.code, 'zone', wl.zone, 'status', wl.status, 'warehouse_id', w.id,
                                             'warehouse', coalesce(w.name ->> 'ru', w.code))
                     from public.warehouse_locations wl join public.warehouses w on w.id = wl.warehouse_id where wl.id = l.location_id),
      'stock', private.scan_stock(null, null, l.location_id));
  elsif found then
    return jsonb_build_object('kind', 'batch', 'code', l.code,
      'batch', (select jsonb_build_object('id', b.id, 'batch', b.batch_number, 'expiry_date', b.expiry_date, 'status', b.status,
                                          'product_id', p.id, 'sku', p.internal_sku, 'product', coalesce(p.name ->> 'ru', p.internal_sku))
                  from public.inventory_batches b join public.products p on p.id = b.product_id where b.id = l.batch_id),
      'stock', private.scan_stock(null, l.batch_id, null));
  end if;
  select jsonb_agg(jsonb_build_object(
           'product_id', p.id, 'sku', p.internal_sku, 'product', coalesce(p.name ->> 'ru', p.internal_sku),
           'identifier_type', i.identifier_type, 'uom', coalesce(i.packaging_uom, case i.identifier_type when 'box_barcode' then 'box' else 'piece' end),
           'pieces', private.uom_pieces(p.id, coalesce(i.packaging_uom, case i.identifier_type when 'box_barcode' then 'box' else 'piece' end)),
           -- With a GS1 batch: the stock of that batch only; a batch Nexus does not know has no stock here.
           'stock', case when p_batch_number is null then private.scan_stock(p.id, null, null)
                         else coalesce((select private.scan_stock(p.id, b.id, null) from public.inventory_batches b
                                         where b.product_id = p.id and upper(btrim(b.batch_number)) = upper(btrim(p_batch_number)) limit 1),
                                       '[]'::jsonb) end,
           'batch_found', case when p_batch_number is null then null
                               else exists (select 1 from public.inventory_batches b where b.product_id = p.id
                                             and upper(btrim(b.batch_number)) = upper(btrim(p_batch_number))) end)
           order by p.internal_sku)
    into v_products
    from public.product_identifiers i
    join public.products p on p.id = i.product_id
   where i.identifier_type in ('gtin', 'unit_barcode', 'box_barcode')
     and private.barcode_key(i.value) = private.barcode_key(v_code);
  if v_products is not null then
    return jsonb_build_object('kind', 'product', 'code', v_code, 'products', v_products);
  end if;
  return jsonb_build_object('kind', 'unknown', 'code', v_code, 'can_bind', (select private.has_permission('products.update')));
end $$;
revoke all on function public.scan_lookup(text, text) from public, anon, authenticated, service_role;
grant execute on function public.scan_lookup(text, text) to authenticated;

-- Binding an unknown barcode to a product: products.update, an explicit confirmation, a record in the audit log. A code
-- already known (to this or another product) is refused.
create or replace function public.bind_scan_code(p_code text, p_product_id uuid, p_identifier_type text, p_packaging_uom text,
                                                 p_confirmed boolean)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_code text := btrim(coalesce(p_code, ''));
  v_id uuid;
begin
  if not (select private.has_permission('products.update')) then
    raise exception 'Код не найден. Привязать его к товару может сотрудник с правом изменять товары' using errcode = '42501';
  end if;
  if not coalesce(p_confirmed, false) then
    raise exception 'Подтвердите, что код относится к выбранному товару';
  end if;
  if v_code !~ '^[0-9A-Za-z\-\.]{4,64}$' or upper(v_code) ~ '^NX-' then
    raise exception 'Код не похож на штрихкод товара';
  end if;
  if p_identifier_type is null or p_identifier_type not in ('gtin', 'unit_barcode', 'box_barcode') then
    raise exception 'Выберите вид кода: GTIN, штрихкод штуки или коробки';
  end if;
  if not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'Товар не найден';
  end if;
  if p_packaging_uom is not null and (p_packaging_uom not in ('piece', 'box', 'layer', 'pallet', 'truck')
                                      or private.uom_pieces(p_product_id, p_packaging_uom) is null) then
    raise exception 'У товара не задана упаковка «%»', p_packaging_uom;
  end if;
  if exists (select 1 from public.product_identifiers i where i.identifier_type in ('gtin', 'unit_barcode', 'box_barcode')
              and private.barcode_key(i.value) = private.barcode_key(v_code)) then
    raise exception 'Этот код уже привязан к товару';
  end if;
  insert into public.product_identifiers(product_id, identifier_type, value, packaging_uom)
  values (p_product_id, p_identifier_type, v_code, p_packaging_uom)
  returning id into v_id;
  insert into public.audit_log(actor_user_id, action, entity_type, entity_id, after_data, metadata)
  values (auth.uid(), 'scan_code_bound', 'products', p_product_id::text,
          jsonb_build_object('identifier_id', v_id, 'identifier_type', p_identifier_type, 'value', v_code, 'packaging_uom', p_packaging_uom),
          jsonb_build_object('source', 'scan'));
  return v_id;
end $$;
revoke all on function public.bind_scan_code(text, uuid, text, text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.bind_scan_code(text, uuid, text, text, boolean) to authenticated;

commit;
