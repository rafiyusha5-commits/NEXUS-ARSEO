-- Block А (2026-11-28): inventory counts — a recount of a warehouse (all of it, or some locations, zones or products).
-- Owner decisions of 2026-11-28 (damirator1-afk, defaults of the task accepted), see docs/inventory-counts.md:
--   * full and partial counts (А1); blind by default: the people counting never get the book quantity (А2);
--   * while a count is open, stock of the counted locations cannot change: any change of quantity on hand there is
--     refused with the count number; other locations work as usual (А3);
--   * lines with a difference above the tolerance (0 by default, set by the administrator) are counted again by another
--     employee (А4);
--   * the result is approved and posted with inventory.count.approve (administrator and directors by default) (А5);
--   * differences in money at the batch cost, only with prices.purchase.view (А6).
-- Stock changes only through the existing adjustment document (202609273800): the count creates one document with a
-- line per difference (decreases with a reason from the loss reasons of 202611280100) and posts it; cancelling a posted
-- count cancels that document with its own reversal. Every check of those functions stays.
begin;

-- Permissions (a module of their own: the inventory grants of 202609271200 are re-applied by module) ----------------
insert into public.permissions(code, module, action, name, description) values
  ('inventory.count.manage', 'inventory_count', 'manage', 'Инвентаризация: ведение',
   'Создать пересчёт, задать состав, начать и завершить подсчёт, отменить'),
  ('inventory.count.record', 'inventory_count', 'record', 'Инвентаризация: подсчёт', 'Вносить посчитанное количество'),
  ('inventory.count.approve', 'inventory_count', 'approve', 'Инвентаризация: утверждение',
   'Видеть учётный остаток пересчёта, разобрать расхождения и провести пересчёт'),
  ('inventory.count.settings', 'inventory_count', 'settings', 'Инвентаризация: допуск',
   'Допуск расхождения, при котором повторный подсчёт не нужен')
on conflict (code) do nothing;

insert into public.role_permissions(role_id, permission_id, granted)
select r.id, p.id, true
  from public.app_roles r
  join public.permissions p on (
       (p.code in ('inventory.count.manage', 'inventory.count.record')
        and r.code in ('administrator', 'director', 'executive_director', 'logistics_director', 'senior_logistics_manager', 'logistics_specialist'))
    or (p.code = 'inventory.count.approve' and r.code in ('administrator', 'director', 'executive_director', 'logistics_director'))
    or (p.code = 'inventory.count.settings' and r.code = 'administrator'))
on conflict (role_id, permission_id) do nothing;

-- Tables ---------------------------------------------------------------------------------------------------------
create sequence if not exists public.inventory_count_no_seq;

create table if not exists public.inventory_counts (
  id uuid primary key default gen_random_uuid(),
  count_number text not null unique,
  warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  kind text not null check (kind in ('full', 'partial')),
  blind boolean not null default true,
  status text not null default 'draft' check (status in ('draft', 'counting', 'recount', 'review', 'posted', 'cancelled')),
  responsible_user_id uuid references public.profiles(id) on delete restrict,
  note text check (note is null or length(note) <= 1000),
  tolerance_pieces numeric(14, 3) not null default 0 check (tolerance_pieces >= 0),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  started_by uuid references public.profiles(id) on delete restrict,
  started_at timestamptz,
  review_at timestamptz,
  posted_by uuid references public.profiles(id) on delete restrict,
  posted_at timestamptz,
  adjustment_document_id uuid references public.inventory_operation_documents(id) on delete restrict,
  cancelled_by uuid references public.profiles(id) on delete restrict,
  cancelled_at timestamptz,
  cancellation_reason text check (cancellation_reason is null or length(cancellation_reason) <= 500),
  updated_at timestamptz not null default now(),
  check (status <> 'cancelled' or (cancelled_at is not null and nullif(btrim(cancellation_reason), '') is not null))
);
-- One open count per warehouse: the lock of locations never depends on two counts at once.
create unique index if not exists inventory_counts_one_open on public.inventory_counts(warehouse_id)
  where status in ('counting', 'recount', 'review');
create index if not exists inventory_counts_warehouse_idx on public.inventory_counts(warehouse_id, created_at desc);
create index if not exists inventory_counts_status_idx on public.inventory_counts(status, created_at desc);
create index if not exists inventory_counts_responsible_idx on public.inventory_counts(responsible_user_id);
create index if not exists inventory_counts_created_by_idx on public.inventory_counts(created_by);
create index if not exists inventory_counts_started_by_idx on public.inventory_counts(started_by);
create index if not exists inventory_counts_posted_by_idx on public.inventory_counts(posted_by);
create index if not exists inventory_counts_cancelled_by_idx on public.inventory_counts(cancelled_by);
create index if not exists inventory_counts_document_idx on public.inventory_counts(adjustment_document_id);

-- What a partial count covers: locations (or stock without a location) and/or products. Both kinds given: both apply.
create table if not exists public.inventory_count_scope (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references public.inventory_counts(id) on delete restrict,
  scope_type text not null check (scope_type in ('location', 'no_location', 'product')),
  location_id uuid references public.warehouse_locations(id) on delete restrict,
  product_id uuid references public.products(id) on delete restrict,
  check ((scope_type = 'location') = (location_id is not null)),
  check ((scope_type = 'product') = (product_id is not null))
);
create unique index if not exists inventory_count_scope_unique on public.inventory_count_scope(
  count_id, scope_type, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(product_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists inventory_count_scope_location_idx on public.inventory_count_scope(location_id);
create index if not exists inventory_count_scope_product_idx on public.inventory_count_scope(product_id);

-- The book at the start: every balance of the scope with stock or a reservation.
create table if not exists public.inventory_count_snapshot (
  count_id uuid not null references public.inventory_counts(id) on delete restrict,
  balance_id uuid not null references public.inventory_balances(id) on delete restrict,
  batch_id uuid not null references public.inventory_batches(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  location_id uuid references public.warehouse_locations(id) on delete restrict,
  uom text not null,
  quantity_on_hand numeric(14, 3) not null,
  quantity_reserved numeric(14, 3) not null,
  primary key (count_id, balance_id)
);
create index if not exists inventory_count_snapshot_balance_idx on public.inventory_count_snapshot(balance_id);
create index if not exists inventory_count_snapshot_batch_idx on public.inventory_count_snapshot(batch_id);
create index if not exists inventory_count_snapshot_product_idx on public.inventory_count_snapshot(product_id);
create index if not exists inventory_count_snapshot_location_idx on public.inventory_count_snapshot(location_id);

-- What was counted: one record per count of a location, product, batch (null: not identified) and unit. A correction
-- is a new record that supersedes an earlier one; nothing is overwritten. Records of one key add up, so two people
-- counting the same location lose nothing.
create table if not exists public.inventory_count_entries (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references public.inventory_counts(id) on delete restrict,
  round smallint not null check (round in (1, 2)),
  location_id uuid references public.warehouse_locations(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  batch_id uuid references public.inventory_batches(id) on delete restrict,
  uom text not null check (uom in ('piece', 'box', 'layer', 'pallet', 'truck')),
  quantity numeric(14, 3) not null check (quantity >= 0),
  pieces numeric not null check (pieces >= 0),
  note text check (note is null or length(note) <= 500),
  supersedes_entry_id uuid unique references public.inventory_count_entries(id) on delete restrict,
  counted_by uuid not null references public.profiles(id) on delete restrict,
  counted_at timestamptz not null default clock_timestamp()
);
create index if not exists inventory_count_entries_count_idx on public.inventory_count_entries(count_id, round, location_id, product_id);
create index if not exists inventory_count_entries_location_idx on public.inventory_count_entries(location_id);
create index if not exists inventory_count_entries_product_idx on public.inventory_count_entries(product_id);
create index if not exists inventory_count_entries_batch_idx on public.inventory_count_entries(batch_id);
create index if not exists inventory_count_entries_counted_by_idx on public.inventory_count_entries(counted_by);

-- Lines: the book against the count per location, batch and unit, built when counting ends; the decisions of review.
create table if not exists public.inventory_count_lines (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references public.inventory_counts(id) on delete restrict,
  location_id uuid references public.warehouse_locations(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  batch_id uuid references public.inventory_batches(id) on delete restrict,
  uom text not null,
  balance_id uuid references public.inventory_balances(id) on delete restrict,
  book_quantity numeric(14, 3) not null default 0,
  reserved_quantity numeric(14, 3) not null default 0,
  counted_quantity numeric(14, 3) not null default 0,
  recount_quantity numeric(14, 3),
  needs_recount boolean not null default false,
  kind text not null check (kind in ('match', 'shortage', 'surplus', 'unknown_batch')),
  other_location boolean not null default false,
  reason_code text references public.inventory_loss_reasons(code) on delete restrict,
  pair_line_id uuid references public.inventory_count_lines(id) on delete restrict,
  assigned_batch_id uuid references public.inventory_batches(id) on delete restrict,
  ignored boolean not null default false,
  decided_by uuid references public.profiles(id) on delete restrict,
  decided_at timestamptz
);
create unique index if not exists inventory_count_lines_key on public.inventory_count_lines(
  count_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid), product_id,
  coalesce(batch_id, '00000000-0000-0000-0000-000000000000'::uuid), uom);
create index if not exists inventory_count_lines_location_idx on public.inventory_count_lines(location_id);
create index if not exists inventory_count_lines_product_idx on public.inventory_count_lines(product_id);
create index if not exists inventory_count_lines_batch_idx on public.inventory_count_lines(batch_id);
create index if not exists inventory_count_lines_balance_idx on public.inventory_count_lines(balance_id);
create index if not exists inventory_count_lines_reason_idx on public.inventory_count_lines(reason_code);
create index if not exists inventory_count_lines_pair_idx on public.inventory_count_lines(pair_line_id);
create index if not exists inventory_count_lines_assigned_idx on public.inventory_count_lines(assigned_batch_id);
create index if not exists inventory_count_lines_decided_by_idx on public.inventory_count_lines(decided_by);

create table if not exists public.inventory_count_settings (
  id boolean primary key default true check (id),
  tolerance_pieces numeric(14, 3) not null default 0 check (tolerance_pieces >= 0),
  updated_by uuid references public.profiles(id) on delete restrict,
  updated_at timestamptz not null default now()
);
create index if not exists inventory_count_settings_updated_by_idx on public.inventory_count_settings(updated_by);
insert into public.inventory_count_settings(id) values (true) on conflict (id) do nothing;

alter table public.inventory_counts enable row level security;
alter table public.inventory_count_scope enable row level security;
alter table public.inventory_count_snapshot enable row level security;
alter table public.inventory_count_entries enable row level security;
alter table public.inventory_count_lines enable row level security;
alter table public.inventory_count_settings enable row level security;
revoke all on public.inventory_counts, public.inventory_count_scope, public.inventory_count_snapshot,
  public.inventory_count_entries, public.inventory_count_lines, public.inventory_count_settings
  from public, anon, authenticated, service_role;
revoke all on sequence public.inventory_count_no_seq from public, anon, authenticated, service_role;

-- Count records are history.
create or replace function private.guard_inventory_count_entries() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'Записи подсчёта не меняются: исправление вносится новой записью' using errcode = '42501';
end $$;
revoke all on function private.guard_inventory_count_entries() from public, anon, authenticated, service_role;
drop trigger if exists inventory_count_entries_immutable on public.inventory_count_entries;
create trigger inventory_count_entries_immutable before update or delete on public.inventory_count_entries
  for each row execute function private.guard_inventory_count_entries();

-- Scope and lock ---------------------------------------------------------------------------------------------------
-- Does a count cover stock of a product at a location (null: without a location) of its warehouse?
create or replace function private.inventory_count_covers(p_count_id uuid, p_location_id uuid, p_product_id uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select c.kind = 'full'
      or ((not exists (select 1 from public.inventory_count_scope s where s.count_id = c.id and s.scope_type in ('location', 'no_location'))
           or exists (select 1 from public.inventory_count_scope s
                       where s.count_id = c.id
                         and ((s.scope_type = 'location' and s.location_id = p_location_id)
                              or (s.scope_type = 'no_location' and p_location_id is null))))
          and (not exists (select 1 from public.inventory_count_scope s where s.count_id = c.id and s.scope_type = 'product')
               or exists (select 1 from public.inventory_count_scope s
                           where s.count_id = c.id and s.scope_type = 'product' and s.product_id = p_product_id)))
    from public.inventory_counts c
   where c.id = p_count_id
$$;
revoke all on function private.inventory_count_covers(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- While a count is open, quantity on hand of the counted stock does not change, except by the posting of that count.
create or replace function private.guard_counted_balance() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_count record;
  v_product uuid;
begin
  if tg_op = 'UPDATE' and new.quantity_on_hand is not distinct from old.quantity_on_hand then
    return new;
  end if;
  if tg_op = 'INSERT' and new.quantity_on_hand = 0 then
    return new;
  end if;
  select c.id, c.count_number into v_count
    from public.inventory_counts c
   where c.warehouse_id = new.warehouse_id and c.status in ('counting', 'recount', 'review');
  if not found then
    return new;
  end if;
  select product_id into v_product from public.inventory_batches where id = new.batch_id;
  if private.inventory_count_covers(v_count.id, new.warehouse_location_id, v_product)
     and current_setting('nexus.inventory_count_posting', true) is distinct from v_count.id::text then
    raise exception 'Идёт инвентаризация % на месте %: движения по нему заблокированы до проведения или отмены пересчёта',
      v_count.count_number,
      coalesce((select code from public.warehouse_locations where id = new.warehouse_location_id), 'без зоны');
  end if;
  return new;
end $$;
revoke all on function private.guard_counted_balance() from public, anon, authenticated, service_role;
drop trigger if exists inventory_balances_count_lock on public.inventory_balances;
create trigger inventory_balances_count_lock before insert or update of quantity_on_hand on public.inventory_balances
  for each row execute function private.guard_counted_balance();

-- Access -----------------------------------------------------------------------------------------------------------
create or replace function private.require_count_permission(p_code text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (select private.has_permission(p_code)) then
    raise exception 'Нет права: %', case p_code
      when 'inventory.count.manage' then 'вести инвентаризацию'
      when 'inventory.count.record' then 'вносить подсчёт'
      when 'inventory.count.approve' then 'утверждать инвентаризацию'
      when 'inventory.count.settings' then 'менять допуск инвентаризации'
      else p_code end using errcode = '42501';
  end if;
end $$;
revoke all on function private.require_count_permission(text) from public, anon, authenticated, service_role;

create or replace function private.can_see_counts() returns boolean
language sql stable security definer set search_path = '' as $$
  select (select private.has_permission('inventory.view')) or (select private.has_permission('inventory.count.manage'))
      or (select private.has_permission('inventory.count.record')) or (select private.has_permission('inventory.count.approve'))
$$;
revoke all on function private.can_see_counts() from public, anon, authenticated, service_role;

-- Header, scope and start ------------------------------------------------------------------------------------------
create or replace function public.create_inventory_count(p_warehouse_id uuid, p_kind text, p_blind boolean default true,
                                                         p_responsible_user_id uuid default null, p_note text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_count_permission('inventory.count.manage');
  if not exists (select 1 from public.warehouses where id = p_warehouse_id and status = 'active') then
    raise exception 'Склад не найден или не действует';
  end if;
  if p_kind is null or p_kind not in ('full', 'partial') then
    raise exception 'Выберите вид пересчёта: весь склад или часть';
  end if;
  if p_responsible_user_id is not null and not private.is_active_employee(p_responsible_user_id) then
    raise exception 'Ответственный не найден';
  end if;
  insert into public.inventory_counts(count_number, warehouse_id, kind, blind, responsible_user_id, note, created_by)
  values ('ИНВ-' || lpad(nextval('public.inventory_count_no_seq')::text, 6, '0'), p_warehouse_id, p_kind, coalesce(p_blind, true),
          coalesce(p_responsible_user_id, auth.uid()), nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.create_inventory_count(uuid, text, boolean, uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.create_inventory_count(uuid, text, boolean, uuid, text) to authenticated;

-- The scope of a partial count in a draft: locations, whole zones (their active locations), stock without a location,
-- products. Replaces the previous scope.
create or replace function public.set_inventory_count_scope(p_count_id uuid, p_location_ids uuid[], p_zones text[],
                                                            p_no_location boolean, p_product_ids uuid[])
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  c public.inventory_counts;
  v_rows integer;
begin
  perform private.require_count_permission('inventory.count.manage');
  select * into c from public.inventory_counts where id = p_count_id for update;
  if not found then
    raise exception 'Инвентаризация не найдена';
  end if;
  if c.status <> 'draft' then
    raise exception 'Состав меняется только в черновике';
  end if;
  if c.kind <> 'partial' then
    raise exception 'Пересчёт всего склада не требует состава';
  end if;
  if exists (select 1 from unnest(coalesce(p_location_ids, '{}')) x(id)
              where not exists (select 1 from public.warehouse_locations l where l.id = x.id and l.warehouse_id = c.warehouse_id)) then
    raise exception 'Место не относится к складу пересчёта';
  end if;
  if exists (select 1 from unnest(coalesce(p_zones, '{}')) z(zone)
              where z.zone not in ('receiving', 'storage', 'picking', 'quarantine', 'stickering', 'shipping')) then
    raise exception 'Неизвестная зона склада';
  end if;
  if exists (select 1 from unnest(coalesce(p_product_ids, '{}')) x(id) where not exists (select 1 from public.products p where p.id = x.id)) then
    raise exception 'Товар не найден';
  end if;
  delete from public.inventory_count_scope where count_id = c.id;
  insert into public.inventory_count_scope(count_id, scope_type, location_id)
  select distinct c.id, 'location', l.id
    from public.warehouse_locations l
   where l.warehouse_id = c.warehouse_id
     and (l.id = any(coalesce(p_location_ids, '{}')) or (l.zone = any(coalesce(p_zones, '{}')) and l.status = 'active'));
  if coalesce(p_no_location, false) then
    insert into public.inventory_count_scope(count_id, scope_type) values (c.id, 'no_location');
  end if;
  insert into public.inventory_count_scope(count_id, scope_type, product_id)
  select distinct c.id, 'product', x.id from unnest(coalesce(p_product_ids, '{}')) x(id);
  select count(*) into v_rows from public.inventory_count_scope where count_id = c.id;
  update public.inventory_counts set updated_at = now() where id = c.id;
  return v_rows;
end $$;
revoke all on function public.set_inventory_count_scope(uuid, uuid[], text[], boolean, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.set_inventory_count_scope(uuid, uuid[], text[], boolean, uuid[]) to authenticated;

-- Start: the book of the scope is remembered and the scope is locked.
create or replace function public.start_inventory_count(p_count_id uuid)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  c public.inventory_counts;
  v_rows integer;
begin
  perform private.require_count_permission('inventory.count.manage');
  select * into c from public.inventory_counts where id = p_count_id for update;
  if not found then
    raise exception 'Инвентаризация не найдена';
  end if;
  if c.status <> 'draft' then
    raise exception 'Начать можно только черновик';
  end if;
  if c.kind = 'partial' and not exists (select 1 from public.inventory_count_scope where count_id = c.id) then
    raise exception 'Задайте состав: места, зоны или товары';
  end if;
  if exists (select 1 from public.inventory_counts o where o.warehouse_id = c.warehouse_id and o.status in ('counting', 'recount', 'review')) then
    raise exception 'На складе уже идёт инвентаризация: завершите или отмените её';
  end if;
  update public.inventory_counts
     set status = 'counting', started_by = auth.uid(), started_at = clock_timestamp(), updated_at = now(),
         tolerance_pieces = (select tolerance_pieces from public.inventory_count_settings where id)
   where id = c.id;
  insert into public.inventory_count_snapshot(count_id, balance_id, batch_id, product_id, location_id, uom, quantity_on_hand, quantity_reserved)
  select c.id, b.id, b.batch_id, ib.product_id, b.warehouse_location_id, b.uom, b.quantity_on_hand, b.quantity_reserved
    from public.inventory_balances b
    join public.inventory_batches ib on ib.id = b.batch_id
   where b.warehouse_id = c.warehouse_id
     and (b.quantity_on_hand > 0 or b.quantity_reserved > 0)
     and private.inventory_count_covers(c.id, b.warehouse_location_id, ib.product_id);
  get diagnostics v_rows = row_count;
  insert into public.audit_log(actor_user_id, action, entity_type, entity_id, after_data)
  values (auth.uid(), 'inventory_count_started', 'inventory_counts', c.id::text, jsonb_build_object('snapshot_rows', v_rows));
  return v_rows;
end $$;
revoke all on function public.start_inventory_count(uuid) from public, anon, authenticated, service_role;
grant execute on function public.start_inventory_count(uuid) to authenticated;

-- Counting ---------------------------------------------------------------------------------------------------------
-- A count of a location (null: stock without a location), product, batch (null: batch not identified) and unit, in the
-- round the person counted in (1 or 2). In the recount only the lines to recount, and only by someone who did not count that line the first time. p_supersedes:
-- the earlier record this one corrects (same line and round).
create or replace function public.record_inventory_count(p_count_id uuid, p_round smallint, p_location_id uuid, p_product_id uuid,
                                                         p_batch_id uuid, p_uom text, p_quantity numeric, p_note text default null,
                                                         p_supersedes_entry_id uuid default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  c public.inventory_counts;
  v_round smallint;
  v_pieces numeric;
  v_old public.inventory_count_entries;
  v_id uuid;
begin
  perform private.require_count_permission('inventory.count.record');
  -- Shared lock: records go in side by side; ending the round waits for them and they wait for it.
  select * into c from public.inventory_counts where id = p_count_id for share;
  if not found then
    raise exception 'Инвентаризация не найдена';
  end if;
  if c.status not in ('counting', 'recount') then
    raise exception 'Подсчёт закрыт: инвентаризация не в подсчёте';
  end if;
  v_round := case when c.status = 'counting' then 1 else 2 end;
  -- The round the person counted in: a first count sent while the round ends never becomes the recount.
  if p_round is distinct from v_round then
    raise exception 'Подсчёт закрыт: идёт % тур, обновите страницу', case v_round when 1 then 'первый' else 'повторный' end;
  end if;
  if p_location_id is not null and not exists (select 1 from public.warehouse_locations where id = p_location_id and warehouse_id = c.warehouse_id) then
    raise exception 'Место не относится к складу пересчёта';
  end if;
  if not exists (select 1 from public.products where id = p_product_id) then
    raise exception 'Товар не найден';
  end if;
  if not private.inventory_count_covers(c.id, p_location_id, p_product_id) then
    raise exception 'Это место или товар не входит в пересчёт';
  end if;
  if p_batch_id is not null and not exists (select 1 from public.inventory_batches where id = p_batch_id and product_id = p_product_id) then
    raise exception 'Партия относится к другому товару';
  end if;
  if p_uom is null or p_uom not in ('piece', 'box', 'layer', 'pallet', 'truck') then
    raise exception 'Укажите единицу';
  end if;
  v_pieces := private.uom_pieces(p_product_id, p_uom);
  if v_pieces is null or v_pieces <= 0 then
    raise exception 'У товара не задана упаковка «%»: посчитайте в штуках или заполните упаковку', p_uom;
  end if;
  if p_quantity is null or p_quantity < 0 or round(p_quantity, 3) <> p_quantity or p_quantity >= 1e10 then
    raise exception 'Укажите количество не меньше нуля, до трёх знаков';
  end if;
  if v_round = 2 then
    if not exists (select 1 from public.inventory_count_lines l
                    where l.count_id = c.id and l.needs_recount and l.location_id is not distinct from p_location_id
                      and l.product_id = p_product_id and l.batch_id is not distinct from p_batch_id and l.uom = p_uom) then
      raise exception 'Эту позицию пересчитывать не нужно';
    end if;
    if exists (select 1 from public.inventory_count_entries e
                where e.count_id = c.id and e.round = 1 and e.counted_by = auth.uid() and e.location_id is not distinct from p_location_id
                  and e.product_id = p_product_id and e.batch_id is not distinct from p_batch_id and e.uom = p_uom) then
      raise exception 'Повторный подсчёт делает другой сотрудник';
    end if;
  end if;
  if p_supersedes_entry_id is not null then
    select * into v_old from public.inventory_count_entries where id = p_supersedes_entry_id;
    if not found or v_old.count_id <> c.id or v_old.round <> v_round or v_old.location_id is distinct from p_location_id
       or v_old.product_id <> p_product_id or v_old.batch_id is distinct from p_batch_id or v_old.uom <> p_uom then
      raise exception 'Исправить можно только запись той же позиции и того же подсчёта';
    end if;
    if exists (select 1 from public.inventory_count_entries where supersedes_entry_id = v_old.id) then
      raise exception 'Эта запись уже исправлена';
    end if;
  end if;
  insert into public.inventory_count_entries(count_id, round, location_id, product_id, batch_id, uom, quantity, pieces, note,
                                             supersedes_entry_id, counted_by)
  values (c.id, v_round, p_location_id, p_product_id, p_batch_id, p_uom, p_quantity, p_quantity * v_pieces,
          nullif(btrim(coalesce(p_note, '')), ''), p_supersedes_entry_id, auth.uid())
  returning id into v_id;
  return v_id;
exception
  when unique_violation then
    raise exception 'Эта запись уже исправлена';
end $$;
revoke all on function public.record_inventory_count(uuid, smallint, uuid, uuid, uuid, text, numeric, text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.record_inventory_count(uuid, smallint, uuid, uuid, uuid, text, numeric, text, uuid) to authenticated;

-- Active records (not corrected) of a round, summed per line key.
create or replace function private.inventory_count_totals(p_count_id uuid, p_round smallint)
returns table(location_id uuid, product_id uuid, batch_id uuid, uom text, quantity numeric, counters uuid[])
language sql stable security definer set search_path = '' as $$
  select e.location_id, e.product_id, e.batch_id, e.uom, sum(e.quantity), array_agg(distinct e.counted_by)
    from public.inventory_count_entries e
   where e.count_id = p_count_id and e.round = p_round
     and not exists (select 1 from public.inventory_count_entries x where x.supersedes_entry_id = e.id)
   group by e.location_id, e.product_id, e.batch_id, e.uom
$$;
revoke all on function private.inventory_count_totals(uuid, smallint) from public, anon, authenticated, service_role;

create or replace function private.inventory_count_kind(p_batch_id uuid, p_book numeric, p_final numeric)
returns text
language sql immutable set search_path = '' as $$
  select case when p_batch_id is null then 'unknown_batch'
              when p_final < p_book then 'shortage'
              when p_final > p_book then 'surplus'
              else 'match' end
$$;
revoke all on function private.inventory_count_kind(uuid, numeric, numeric) from public, anon, authenticated, service_role;

-- End of a round. From counting: the lines are built (book against count); lines above the tolerance go to a recount by
-- another employee, else to review. From recount: every line to recount must have its second count; then review.
create or replace function public.finish_inventory_count_round(p_count_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c public.inventory_counts;
  v_missing integer;
  v_recount integer;
begin
  perform private.require_count_permission('inventory.count.manage');
  select * into c from public.inventory_counts where id = p_count_id for update;
  if not found then
    raise exception 'Инвентаризация не найдена';
  end if;
  if c.status = 'counting' then
    insert into public.inventory_count_lines(count_id, location_id, product_id, batch_id, uom, balance_id, book_quantity,
                                             reserved_quantity, counted_quantity, kind)
    with book as (
      select s.location_id, s.product_id, s.batch_id, s.uom, s.balance_id, s.quantity_on_hand, s.quantity_reserved
        from public.inventory_count_snapshot s where s.count_id = c.id
    ), counted as (
      select * from private.inventory_count_totals(c.id, 1::smallint)
    ), keys as (
      select b.location_id, b.product_id, b.batch_id, b.uom from book b
      union
      select t.location_id, t.product_id, t.batch_id, t.uom from counted t
    )
    select c.id, k.location_id, k.product_id, k.batch_id, k.uom,
           coalesce(b.balance_id, (select x.id from public.inventory_balances x
                                    where k.batch_id is not null and x.batch_id = k.batch_id and x.warehouse_id = c.warehouse_id
                                      and x.warehouse_location_id is not distinct from k.location_id and x.uom = k.uom)),
           coalesce(b.quantity_on_hand, 0), coalesce(b.quantity_reserved, 0), coalesce(t.quantity, 0),
           private.inventory_count_kind(k.batch_id, coalesce(b.quantity_on_hand, 0), coalesce(t.quantity, 0))
      from keys k
      left join book b on b.location_id is not distinct from k.location_id and b.product_id = k.product_id
                      and b.batch_id is not distinct from k.batch_id and b.uom = k.uom
      left join counted t on t.location_id is not distinct from k.location_id and t.product_id = k.product_id
                         and t.batch_id is not distinct from k.batch_id and t.uom = k.uom;
    -- Found at a location where the book does not have it, while the book has it elsewhere in the count: "другое место".
    update public.inventory_count_lines l
       set other_location = true
     where l.count_id = c.id and l.kind = 'surplus' and l.book_quantity = 0
       and exists (select 1 from public.inventory_count_snapshot s
                    where s.count_id = c.id and s.batch_id = l.batch_id and s.location_id is distinct from l.location_id);
    update public.inventory_count_lines l
       set needs_recount = true
     where l.count_id = c.id
       and (l.kind = 'unknown_batch'
            or abs(l.counted_quantity - l.book_quantity) * coalesce(private.uom_pieces(l.product_id, l.uom), 1) > c.tolerance_pieces);
    select count(*) into v_recount from public.inventory_count_lines where count_id = c.id and needs_recount;
    update public.inventory_counts
       set status = case when v_recount > 0 then 'recount' else 'review' end,
           review_at = case when v_recount > 0 then null else clock_timestamp() end, updated_at = now()
     where id = c.id;
    return jsonb_build_object('status', case when v_recount > 0 then 'recount' else 'review' end, 'recount_lines', v_recount);
  elsif c.status = 'recount' then
    select count(*) into v_missing
      from public.inventory_count_lines l
     where l.count_id = c.id and l.needs_recount
       and not exists (select 1 from private.inventory_count_totals(c.id, 2::smallint) t
                        where t.location_id is not distinct from l.location_id and t.product_id = l.product_id
                          and t.batch_id is not distinct from l.batch_id and t.uom = l.uom);
    if v_missing > 0 then
      raise exception 'Не все позиции пересчитаны повторно: осталось %', v_missing;
    end if;
    update public.inventory_count_lines l
       set recount_quantity = t.quantity,
           kind = private.inventory_count_kind(l.batch_id, l.book_quantity, t.quantity)
      from private.inventory_count_totals(c.id, 2::smallint) t
     where l.count_id = c.id and l.needs_recount
       and t.location_id is not distinct from l.location_id and t.product_id = l.product_id
       and t.batch_id is not distinct from l.batch_id and t.uom = l.uom;
    update public.inventory_count_lines l set other_location = false
     where l.count_id = c.id and l.kind <> 'surplus';
    update public.inventory_counts set status = 'review', review_at = clock_timestamp(), updated_at = now() where id = c.id;
    return jsonb_build_object('status', 'review', 'recount_lines', 0);
  else
    raise exception 'Подсчёт уже завершён';
  end if;
end $$;
revoke all on function public.finish_inventory_count_round(uuid) from public, anon, authenticated, service_role;
grant execute on function public.finish_inventory_count_round(uuid) to authenticated;

-- What the people counting see: the scope, the records of the current round, the lines to recount. Never the book in a
-- blind count; in an open count, the book of the snapshot.
create or replace function public.inventory_count_sheet(p_count_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.inventory_counts;
begin
  if not private.can_see_counts() then
    raise exception 'Нет доступа к инвентаризации' using errcode = '42501';
  end if;
  select * into c from public.inventory_counts where id = p_count_id;
  if not found then
    raise exception 'Инвентаризация не найдена';
  end if;
  return jsonb_build_object(
    'id', c.id, 'number', c.count_number, 'status', c.status, 'kind', c.kind, 'blind', c.blind, 'note', c.note,
    'warehouse_id', c.warehouse_id, 'warehouse', (select coalesce(w.name ->> 'ru', w.code) from public.warehouses w where w.id = c.warehouse_id),
    'responsible', (select full_name from public.profiles where id = c.responsible_user_id),
    'created_at', c.created_at, 'started_at', c.started_at, 'review_at', c.review_at, 'posted_at', c.posted_at,
    'cancelled_at', c.cancelled_at, 'cancellation_reason', c.cancellation_reason, 'tolerance_pieces', c.tolerance_pieces::text,
    'adjustment_document_id', c.adjustment_document_id,
    'adjustment_document', (select document_number from public.inventory_operation_documents where id = c.adjustment_document_id),
    'round', case c.status when 'counting' then 1 when 'recount' then 2 end,
    'can_manage', (select private.has_permission('inventory.count.manage')),
    'can_record', (select private.has_permission('inventory.count.record')),
    'can_approve', (select private.has_permission('inventory.count.approve')),
    'scope', coalesce((select jsonb_agg(jsonb_build_object('type', s.scope_type, 'location_id', s.location_id, 'location', l.code,
                                                           'zone', l.zone, 'product_id', s.product_id, 'sku', p.internal_sku,
                                                           'product', coalesce(p.name ->> 'ru', p.internal_sku))
                                        order by s.scope_type, l.code, p.internal_sku)
                         from public.inventory_count_scope s
                         left join public.warehouse_locations l on l.id = s.location_id
                         left join public.products p on p.id = s.product_id
                        where s.count_id = c.id), '[]'::jsonb),
    'locations', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'code', l.code, 'zone', l.zone) order by l.code)
                             from public.warehouse_locations l
                            where l.warehouse_id = c.warehouse_id and l.status <> 'archived'
                              and (c.kind = 'full' or not exists (select 1 from public.inventory_count_scope s
                                                                    where s.count_id = c.id and s.scope_type in ('location', 'no_location'))
                                   or exists (select 1 from public.inventory_count_scope s
                                               where s.count_id = c.id and s.scope_type = 'location' and s.location_id = l.id))), '[]'::jsonb),
    'no_location', c.kind = 'full'
                   or not exists (select 1 from public.inventory_count_scope s where s.count_id = c.id and s.scope_type in ('location', 'no_location'))
                   or exists (select 1 from public.inventory_count_scope s where s.count_id = c.id and s.scope_type = 'no_location'),
    'entries', coalesce((select jsonb_agg(jsonb_build_object(
                           'id', e.id, 'round', e.round, 'location_id', e.location_id, 'location', l.code, 'product_id', e.product_id,
                           'sku', p.internal_sku, 'product', coalesce(p.name ->> 'ru', p.internal_sku), 'batch_id', e.batch_id,
                           'batch', b.batch_number, 'expiry_date', b.expiry_date, 'uom', e.uom, 'quantity', e.quantity::text, 'note', e.note,
                           'counted_by', pr.full_name, 'counted_at', e.counted_at, 'supersedes_entry_id', e.supersedes_entry_id,
                           'superseded', exists (select 1 from public.inventory_count_entries x where x.supersedes_entry_id = e.id))
                           order by e.counted_at desc, e.id)
                         from public.inventory_count_entries e
                         left join public.warehouse_locations l on l.id = e.location_id
                         join public.products p on p.id = e.product_id
                         left join public.inventory_batches b on b.id = e.batch_id
                         left join public.profiles pr on pr.id = e.counted_by
                        where e.count_id = c.id), '[]'::jsonb),
    'recount', case when c.status = 'recount' then coalesce((
                 select jsonb_agg(jsonb_build_object('location_id', l.location_id, 'location', wl.code, 'product_id', l.product_id,
                                                     'sku', p.internal_sku, 'product', coalesce(p.name ->> 'ru', p.internal_sku),
                                                     'batch_id', l.batch_id, 'batch', b.batch_number, 'uom', l.uom,
                                                     'done', exists (select 1 from private.inventory_count_totals(c.id, 2::smallint) t
                                                                      where t.location_id is not distinct from l.location_id
                                                                        and t.product_id = l.product_id and t.batch_id is not distinct from l.batch_id
                                                                        and t.uom = l.uom),
                                                     'first_counters', (select coalesce(jsonb_agg(distinct pr.full_name), '[]'::jsonb)
                                                                          from public.inventory_count_entries e
                                                                          join public.profiles pr on pr.id = e.counted_by
                                                                         where e.count_id = c.id and e.round = 1
                                                                           and e.location_id is not distinct from l.location_id
                                                                           and e.product_id = l.product_id
                                                                           and e.batch_id is not distinct from l.batch_id and e.uom = l.uom))
                                  order by wl.code, p.internal_sku, b.batch_number)
                   from public.inventory_count_lines l
                   left join public.warehouse_locations wl on wl.id = l.location_id
                   join public.products p on p.id = l.product_id
                   left join public.inventory_batches b on b.id = l.batch_id
                  where l.count_id = c.id and l.needs_recount), '[]'::jsonb) end,
    -- The book only in an open count (never in a blind one).
    'book', case when not c.blind and c.status in ('counting', 'recount') then coalesce((
              select jsonb_agg(jsonb_build_object('location_id', s.location_id, 'location', l.code, 'product_id', s.product_id,
                                                  'sku', p.internal_sku, 'product', coalesce(p.name ->> 'ru', p.internal_sku),
                                                  'batch_id', s.batch_id, 'batch', b.batch_number, 'expiry_date', b.expiry_date,
                                                  'uom', s.uom, 'quantity', s.quantity_on_hand::text)
                               order by l.code, p.internal_sku, b.batch_number)
                from public.inventory_count_snapshot s
                left join public.warehouse_locations l on l.id = s.location_id
                join public.products p on p.id = s.product_id
                join public.inventory_batches b on b.id = s.batch_id
               where s.count_id = c.id), '[]'::jsonb) end);
end $$;
revoke all on function public.inventory_count_sheet(uuid) from public, anon, authenticated, service_role;
grant execute on function public.inventory_count_sheet(uuid) to authenticated;

-- Products and batches the people counting may pick: of the scope (or any product for a full count), with the batches
-- the warehouse has had. No quantity.
create or replace function public.inventory_count_catalog(p_count_id uuid, p_query text default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c public.inventory_counts;
  v_query text := nullif(btrim(coalesce(p_query, '')), '');
begin
  if not private.can_see_counts() then
    raise exception 'Нет доступа к инвентаризации' using errcode = '42501';
  end if;
  select * into c from public.inventory_counts where id = p_count_id;
  if not found then
    raise exception 'Инвентаризация не найдена';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', p.id, 'sku', p.internal_sku, 'product', coalesce(p.name ->> 'ru', p.internal_sku),
             'uoms', (select coalesce(jsonb_agg(u.uom order by u.n), '[]'::jsonb)
                        from unnest(array['piece', 'box', 'layer', 'pallet']) with ordinality u(uom, n)
                       where private.uom_pieces(p.id, u.uom) is not null),
             'batches', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'batch', b.batch_number, 'expiry_date', b.expiry_date)
                                                   order by b.expiry_date nulls last, b.batch_number), '[]'::jsonb)
                           from public.inventory_batches b
                          where b.product_id = p.id
                            and exists (select 1 from public.inventory_balances x where x.batch_id = b.id and x.warehouse_id = c.warehouse_id)))
             order by p.internal_sku)
      from (select p.* from public.products p
             where (c.kind = 'full'
                    or not exists (select 1 from public.inventory_count_scope s where s.count_id = c.id and s.scope_type = 'product')
                    or exists (select 1 from public.inventory_count_scope s where s.count_id = c.id and s.scope_type = 'product' and s.product_id = p.id))
               and (v_query is null or p.internal_sku ilike '%' || v_query || '%' or coalesce(p.name ->> 'ru', '') ilike '%' || v_query || '%'
                    or exists (select 1 from public.product_identifiers pi where pi.product_id = p.id and pi.value = v_query))
             order by p.internal_sku
             limit 50) p), '[]'::jsonb);
end $$;
revoke all on function public.inventory_count_catalog(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.inventory_count_catalog(uuid, text) to authenticated;

-- Review -----------------------------------------------------------------------------------------------------------
-- Unit cost of a batch in tenge per unit of a line: the batch cost converted at today's official rate; null when the
-- batch has no cost, the product no packaging or there is no rate.
create or replace function private.inventory_count_unit_cost_kzt(p_batch_id uuid, p_uom text)
returns numeric
language sql stable security definer set search_path = '' as $$
  select case when b.unit_landed_cost is null or b.cost_currency_id is null or r.rate is null
                   or private.uom_pieces(b.product_id, p_uom) is null
                   or coalesce(private.uom_pieces(b.product_id, coalesce(b.cost_uom, 'piece')), 0) <= 0 then null
              else private.uom_pieces(b.product_id, p_uom) / private.uom_pieces(b.product_id, coalesce(b.cost_uom, 'piece'))
                   * b.unit_landed_cost * r.rate end
    from public.inventory_batches b
    left join lateral private.official_conversion(b.cost_currency_id, (select id from public.currencies where code = 'KZT'),
                                                  private.business_today()) r on true
   where b.id = p_batch_id
$$;
revoke all on function private.inventory_count_unit_cost_kzt(uuid, text) from public, anon, authenticated, service_role;

-- What posting would do: a decrease or an increase per line with a difference, after the decisions. Problems block it.
create or replace function private.inventory_count_plan(p_count_id uuid)
returns table(line_id uuid, balance_id uuid, batch_id uuid, location_id uuid, uom text, direction text, quantity numeric,
              reason_code text, problem text)
language sql stable security definer set search_path = '' as $$
  with l as (
    select x.*, coalesce(x.recount_quantity, x.counted_quantity) as final_quantity,
           coalesce(x.batch_id, x.assigned_batch_id) as target_batch
      from public.inventory_count_lines x
     where x.count_id = p_count_id and x.kind <> 'match'
  )
  select l.id,
         coalesce(l.balance_id, (select b.id from public.inventory_balances b join public.inventory_counts c on c.id = l.count_id
                                  where l.batch_id is null and b.batch_id = l.assigned_batch_id and b.warehouse_id = c.warehouse_id
                                    and b.warehouse_location_id is not distinct from l.location_id and b.uom = l.uom)),
         l.target_batch, l.location_id, l.uom,
         case when l.kind = 'shortage' then 'decrease' else 'increase' end,
         case when l.kind = 'unknown_batch' then l.final_quantity else abs(l.final_quantity - l.book_quantity) end,
         case when l.kind = 'shortage' then l.reason_code end,
         case
           when l.kind = 'shortage' and l.reason_code is null then 'reason'
           when l.kind = 'unknown_batch' and not l.ignored and l.assigned_batch_id is null then 'batch'
           -- The current reservations (they may change during the count): the adjustment never takes reserved stock.
           when l.kind = 'shortage' and l.book_quantity - l.final_quantity
                > l.book_quantity - coalesce((select b.quantity_reserved from public.inventory_balances b where b.id = l.balance_id), 0) then 'reserved'
         end
    from l
   where not (l.kind = 'unknown_batch' and (l.ignored or l.final_quantity = 0))
$$;
revoke all on function private.inventory_count_plan(uuid) from public, anon, authenticated, service_role;

-- The digest of a plan: what would be posted and the stock it starts from. A preview older than the data is refused.
create or replace function private.inventory_count_digest(p_count_id uuid)
returns text
language sql stable security definer set search_path = '' as $$
  select md5(coalesce((select jsonb_agg(jsonb_build_object('l', p.line_id, 'b', p.balance_id, 't', p.batch_id, 'd', p.direction,
                                                          'q', p.quantity, 'r', p.reason_code, 'p', p.problem,
                                                          'h', (select quantity_on_hand from public.inventory_balances where id = p.balance_id),
                                                          'v', (select quantity_reserved from public.inventory_balances where id = p.balance_id))
                                       order by p.line_id)
                        from private.inventory_count_plan(p_count_id) p)::text, '[]'))
$$;
revoke all on function private.inventory_count_digest(uuid) from public, anon, authenticated, service_role;

-- The book against the count, the decisions, the plan and its problems, sums by reason and location; money only with
-- prices.purchase.view. Not in a blind count before counting ends.
create or replace function public.inventory_count_review(p_count_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c public.inventory_counts;
  v_cost boolean := (select private.has_permission('prices.purchase.view'));
begin
  if not private.can_see_counts() then
    raise exception 'Нет доступа к инвентаризации' using errcode = '42501';
  end if;
  select * into c from public.inventory_counts where id = p_count_id;
  if not found then
    raise exception 'Инвентаризация не найдена';
  end if;
  if c.status in ('draft', 'counting', 'recount') or (c.status = 'cancelled' and c.review_at is null) then
    raise exception 'Расхождения появятся после завершения подсчёта';
  end if;
  if c.blind and not (select private.has_permission('inventory.count.approve')) then
    raise exception 'Учётный остаток слепого пересчёта видит только утверждающий' using errcode = '42501';
  end if;
  return (
    with lines as (
      select l.*, coalesce((select b.quantity_reserved from public.inventory_balances b where b.id = l.balance_id), 0) as reserved_now,
             coalesce(l.recount_quantity, l.counted_quantity) as final_quantity,
             coalesce(l.recount_quantity, l.counted_quantity) - l.book_quantity as difference,
             (coalesce(l.recount_quantity, l.counted_quantity) - l.book_quantity) * private.uom_pieces(l.product_id, l.uom) as difference_pieces,
             case when v_cost then private.inventory_count_unit_cost_kzt(coalesce(l.batch_id, l.assigned_batch_id), l.uom) end as unit_cost
        from public.inventory_count_lines l where l.count_id = c.id
    ), plan as (
      select * from private.inventory_count_plan(c.id)
    ), money as (
      select x.*, case when x.unit_cost is not null and x.kind <> 'unknown_batch' then round(x.difference * x.unit_cost, 2)
                       when x.unit_cost is not null and x.kind = 'unknown_batch' and not x.ignored then round(x.final_quantity * x.unit_cost, 2)
                  end as difference_kzt
        from lines x
    )
    select jsonb_build_object(
      'number', c.count_number, 'status', c.status, 'cost', v_cost,
      'can_approve', (select private.has_permission('inventory.count.approve')),
      'digest', case when c.status = 'review' then private.inventory_count_digest(c.id) end,
      'totals', jsonb_build_object(
         'lines', (select count(*) from lines), 'matches', (select count(*) from lines where kind = 'match'),
         'shortages', (select count(*) from lines where kind = 'shortage'), 'surpluses', (select count(*) from lines where kind = 'surplus'),
         'unknown', (select count(*) from lines where kind = 'unknown_batch'),
         'shortage_pieces', (select coalesce(sum(-difference_pieces), 0)::text from lines where kind = 'shortage'),
         'surplus_pieces', (select coalesce(sum(difference_pieces), 0)::text from lines where kind = 'surplus'),
         'shortage_kzt', case when v_cost then (select coalesce(sum(-difference_kzt), 0)::text from money where kind = 'shortage') end,
         'surplus_kzt', case when v_cost then (select coalesce(sum(difference_kzt), 0)::text from money where kind in ('surplus', 'unknown_batch')) end,
         'no_cost_lines', case when v_cost then (select count(*) from money where kind <> 'match' and difference_kzt is null
                                                                     and not (kind = 'unknown_batch' and ignored)) end,
         'problems', (select count(*) from plan where problem is not null)),
      'lines', coalesce((select jsonb_agg(jsonb_build_object(
          'id', m.id, 'location_id', m.location_id, 'location', wl.code, 'product_id', m.product_id, 'sku', p.internal_sku,
          'product', coalesce(p.name ->> 'ru', p.internal_sku), 'batch_id', m.batch_id, 'batch', b.batch_number, 'expiry_date', b.expiry_date,
          'uom', m.uom, 'book', m.book_quantity::text, 'reserved', m.reserved_now::text, 'counted', m.counted_quantity::text,
          'recount', m.recount_quantity::text, 'final', m.final_quantity::text, 'difference', m.difference::text,
          'difference_pieces', m.difference_pieces::text, 'kind', m.kind, 'other_location', m.other_location,
          'needs_recount', m.needs_recount, 'reason_code', m.reason_code, 'reason', r.name, 'pair_line_id', m.pair_line_id,
          'assigned_batch_id', m.assigned_batch_id, 'assigned_batch', ab.batch_number, 'ignored', m.ignored,
          'decided_by', dp.full_name, 'decided_at', m.decided_at,
          'difference_kzt', case when v_cost then m.difference_kzt::text end,
          'problem', (select pl.problem from plan pl where pl.line_id = m.id),
          'orders', case when m.balance_id is not null and m.final_quantity < m.reserved_now then (
             select coalesce(jsonb_agg(distinct jsonb_build_object('sale_id', s.id, 'sale_number', s.sale_number)), '[]'::jsonb)
               from public.inventory_reservations ir
               join public.sale_items si on si.id = ir.sale_item_id
               join public.sales s on s.id = si.sale_id
              where ir.inventory_balance_id = m.balance_id and ir.status = 'active') end,
          'batches', case when m.kind = 'unknown_batch' then (
             select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'batch', x.batch_number, 'expiry_date', x.expiry_date)
                                       order by x.expiry_date nulls last, x.batch_number), '[]'::jsonb)
               from public.inventory_batches x where x.product_id = m.product_id) end)
          order by (m.kind = 'match'), wl.code nulls first, p.internal_sku, b.batch_number)
          from money m
          left join public.warehouse_locations wl on wl.id = m.location_id
          join public.products p on p.id = m.product_id
          left join public.inventory_batches b on b.id = m.batch_id
          left join public.inventory_batches ab on ab.id = m.assigned_batch_id
          left join public.inventory_loss_reasons r on r.code = m.reason_code
          left join public.profiles dp on dp.id = m.decided_by), '[]'::jsonb),
      'by_reason', coalesce((select jsonb_agg(jsonb_build_object('reason_code', x.reason_code, 'reason', r.name, 'lines', x.n,
                                                                 'pieces', x.pieces::text, 'kzt', case when v_cost then x.kzt::text end)
                                              order by x.pieces desc)
                               from (select coalesce(reason_code, case kind when 'surplus' then 'surplus' when 'unknown_batch' then 'unknown_batch' end) as reason_code,
                                            count(*) as n, sum(abs(coalesce(difference_pieces, 0))) as pieces, sum(abs(difference_kzt)) as kzt
                                       from money where kind <> 'match' group by 1) x
                               left join public.inventory_loss_reasons r on r.code = x.reason_code), '[]'::jsonb),
      'by_location', coalesce((select jsonb_agg(jsonb_build_object('location_id', x.location_id, 'location', wl.code, 'lines', x.n,
                                                                   'shortage_pieces', x.shortage::text, 'surplus_pieces', x.surplus::text,
                                                                   'shortage_kzt', case when v_cost then x.shortage_kzt::text end,
                                                                   'surplus_kzt', case when v_cost then x.surplus_kzt::text end)
                                                order by wl.code nulls first)
                                 from (select location_id, count(*) filter (where kind <> 'match') as n,
                                              coalesce(sum(-difference_pieces) filter (where kind = 'shortage'), 0) as shortage,
                                              coalesce(sum(difference_pieces) filter (where kind = 'surplus'), 0) as surplus,
                                              sum(-difference_kzt) filter (where kind = 'shortage') as shortage_kzt,
                                              sum(difference_kzt) filter (where kind = 'surplus') as surplus_kzt
                                         from money group by location_id) x
                                 left join public.warehouse_locations wl on wl.id = x.location_id), '[]'::jsonb),
      'reasons', (select jsonb_agg(jsonb_build_object('code', code, 'name', name) order by sort_order, code)
                    from public.inventory_loss_reasons where is_active))
  );
end $$;
revoke all on function public.inventory_count_review(uuid) from public, anon, authenticated, service_role;
grant execute on function public.inventory_count_review(uuid) to authenticated;

-- A decision on a line in review: the reason of a shortage; for a batch not identified, the batch it belongs to or
-- "do not count it".
create or replace function public.set_inventory_count_decision(p_line_id uuid, p_reason_code text, p_assigned_batch_id uuid default null,
                                                               p_ignored boolean default false)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  l public.inventory_count_lines;
  c public.inventory_counts;
begin
  perform private.require_count_permission('inventory.count.approve');
  select * into l from public.inventory_count_lines where id = p_line_id for update;
  if not found then
    raise exception 'Строка инвентаризации не найдена';
  end if;
  select * into c from public.inventory_counts where id = l.count_id for update;
  if c.status <> 'review' then
    raise exception 'Решения принимаются на утверждении';
  end if;
  if l.kind = 'shortage' then
    if p_reason_code is null or not exists (select 1 from public.inventory_loss_reasons where code = p_reason_code and is_active) then
      raise exception 'Выберите причину недостачи';
    end if;
    update public.inventory_count_lines set reason_code = p_reason_code, decided_by = auth.uid(), decided_at = clock_timestamp() where id = l.id;
  elsif l.kind = 'unknown_batch' then
    if coalesce(p_ignored, false) then
      update public.inventory_count_lines set ignored = true, assigned_batch_id = null, decided_by = auth.uid(), decided_at = clock_timestamp()
       where id = l.id;
    else
      if p_assigned_batch_id is null or not exists (select 1 from public.inventory_batches where id = p_assigned_batch_id and product_id = l.product_id) then
        raise exception 'Выберите партию этого товара или «не учитывать»';
      end if;
      update public.inventory_count_lines set ignored = false, assigned_batch_id = p_assigned_batch_id, decided_by = auth.uid(),
                                              decided_at = clock_timestamp()
       where id = l.id;
    end if;
  else
    raise exception 'Для этой строки решение не нужно';
  end if;
end $$;
revoke all on function public.set_inventory_count_decision(uuid, text, uuid, boolean) from public, anon, authenticated, service_role;
grant execute on function public.set_inventory_count_decision(uuid, text, uuid, boolean) to authenticated;

-- Mis-sort: a shortage paired with a surplus (or a batch not identified) of the same count; the shortage then takes the
-- reason "пересорт" unless another one is chosen later. p_surplus_line_id null removes the pair.
create or replace function public.pair_inventory_count_lines(p_shortage_line_id uuid, p_surplus_line_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  s public.inventory_count_lines;
  o public.inventory_count_lines;
begin
  perform private.require_count_permission('inventory.count.approve');
  select * into s from public.inventory_count_lines where id = p_shortage_line_id for update;
  if not found or s.kind <> 'shortage' then
    raise exception 'Выберите строку недостачи';
  end if;
  if not exists (select 1 from public.inventory_counts where id = s.count_id and status = 'review') then
    raise exception 'Решения принимаются на утверждении';
  end if;
  update public.inventory_count_lines set pair_line_id = null where pair_line_id = s.id or id = s.pair_line_id;
  if p_surplus_line_id is null then
    update public.inventory_count_lines set pair_line_id = null, decided_by = auth.uid(), decided_at = clock_timestamp() where id = s.id;
    return;
  end if;
  select * into o from public.inventory_count_lines where id = p_surplus_line_id for update;
  if not found or o.count_id <> s.count_id or o.kind not in ('surplus', 'unknown_batch') then
    raise exception 'Пару составляет излишек того же пересчёта';
  end if;
  update public.inventory_count_lines set pair_line_id = null where pair_line_id = o.id or id = o.pair_line_id;
  update public.inventory_count_lines
     set pair_line_id = o.id, reason_code = coalesce(reason_code, case when o.product_id = s.product_id then 'accounting_error' else 'mis_sort' end),
         decided_by = auth.uid(), decided_at = clock_timestamp()
   where id = s.id;
  update public.inventory_count_lines set pair_line_id = s.id, decided_by = auth.uid(), decided_at = clock_timestamp() where id = o.id;
end $$;
revoke all on function public.pair_inventory_count_lines(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.pair_inventory_count_lines(uuid, uuid) to authenticated;

-- Posting: one adjustment document (202609273800) with a line per difference, posted by its own function. A preview older
-- than the data is refused; any problem (no reason, no batch decision, a decrease below the reservations) blocks it.
create or replace function public.post_inventory_count(p_count_id uuid, p_digest text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  c public.inventory_counts;
  p record;
  v_document uuid;
  v_balance uuid;
  v_problems integer;
begin
  perform private.require_count_permission('inventory.count.approve');
  select * into c from public.inventory_counts where id = p_count_id for update;
  if not found then
    raise exception 'Инвентаризация не найдена';
  end if;
  if c.status <> 'review' then
    raise exception 'Провести можно только инвентаризацию на утверждении';
  end if;
  -- The book the count started from is still the stock (the lock should guarantee it; checked anyway).
  perform 1 from public.inventory_balances b join public.inventory_count_snapshot s on s.balance_id = b.id
   where s.count_id = c.id for update of b;
  if exists (select 1 from public.inventory_count_snapshot s join public.inventory_balances b on b.id = s.balance_id
              where s.count_id = c.id and b.quantity_on_hand <> s.quantity_on_hand) then
    raise exception 'Остатки изменились после начала пересчёта: отмените его и начните заново';
  end if;
  if p_digest is null or p_digest <> private.inventory_count_digest(c.id) then
    raise exception 'Предпросмотр устарел: откройте разбор заново и проверьте строки';
  end if;
  select count(*) into v_problems from private.inventory_count_plan(c.id) where problem is not null;
  if v_problems > 0 then
    raise exception 'Есть нерешённые строки: %', v_problems;
  end if;
  perform set_config('nexus.inventory_count_posting', c.id::text, true);
  if exists (select 1 from private.inventory_count_plan(c.id)) then
    v_document := public.create_inventory_operation_document('adjustment', private.business_today(), c.warehouse_id, null, c.count_number,
                                                             'Инвентаризация ' || c.count_number, null);
    -- One document line per balance: a batch not identified and assigned to a batch already counted at that place adds up.
    for p in select pl.batch_id, pl.location_id, pl.uom, (array_agg(pl.balance_id) filter (where pl.balance_id is not null))[1] as balance_id,
                    sum(case when pl.direction = 'increase' then pl.quantity else -pl.quantity end) as net,
                    max(pl.reason_code) as reason_code
               from private.inventory_count_plan(c.id) pl
              group by pl.batch_id, pl.location_id, pl.uom
             having sum(case when pl.direction = 'increase' then pl.quantity else -pl.quantity end) <> 0
              order by 4 nulls last, pl.location_id nulls first, pl.batch_id loop
      v_balance := p.balance_id;
      if v_balance is null then
        -- Stock found where the book has no balance: an empty balance is opened, the adjustment puts the quantity on it.
        insert into public.inventory_balances(batch_id, warehouse_id, warehouse_location_id, uom, quantity_on_hand)
        values (p.batch_id, c.warehouse_id, p.location_id, p.uom, 0)
        on conflict do nothing;
        select id into v_balance from public.inventory_balances
         where batch_id = p.batch_id and warehouse_id = c.warehouse_id and warehouse_location_id is not distinct from p.location_id and uom = p.uom;
      end if;
      if p.net < 0 then
        perform public.add_inventory_loss_line(v_document, v_balance, -p.net, 'decrease', coalesce(p.reason_code, 'accounting_error'),
                                               'Инвентаризация ' || c.count_number);
      else
        perform public.add_inventory_operation_line(v_document, v_balance, null, p.net, 'increase', 'Инвентаризация ' || c.count_number);
      end if;
    end loop;
    perform public.post_inventory_operation_document(v_document);
  end if;
  perform set_config('nexus.inventory_count_posting', '', true);
  update public.inventory_counts
     set status = 'posted', posted_by = auth.uid(), posted_at = clock_timestamp(), adjustment_document_id = v_document, updated_at = now()
   where id = c.id;
  insert into public.audit_log(actor_user_id, action, entity_type, entity_id, after_data)
  values (auth.uid(), 'inventory_count_posted', 'inventory_counts', c.id::text, jsonb_build_object('adjustment_document_id', v_document));
  return v_document;
end $$;
revoke all on function public.post_inventory_count(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.post_inventory_count(uuid, text) to authenticated;

-- Cancel. Before posting: the lock is released, nothing changed in stock. A posted count: its adjustment document is
-- cancelled by its own reversal (which refuses when the stock no longer permits it).
create or replace function public.cancel_inventory_count(p_count_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  c public.inventory_counts;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into c from public.inventory_counts where id = p_count_id for update;
  if not found then
    raise exception 'Инвентаризация не найдена';
  end if;
  if c.status = 'cancelled' then
    raise exception 'Инвентаризация уже отменена';
  end if;
  perform private.require_count_permission(case when c.status = 'posted' then 'inventory.count.approve' else 'inventory.count.manage' end);
  if v_reason is null or length(v_reason) not between 3 and 500 then
    raise exception 'Укажите причину отмены (от 3 до 500 символов)';
  end if;
  if c.status = 'posted' and c.adjustment_document_id is not null then
    perform public.cancel_inventory_operation_document(c.adjustment_document_id, 'Отмена инвентаризации ' || c.count_number || ': ' || v_reason);
  end if;
  update public.inventory_counts
     set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = clock_timestamp(), cancellation_reason = v_reason, updated_at = now()
   where id = c.id;
  insert into public.audit_log(actor_user_id, action, entity_type, entity_id, before_data, metadata)
  values (auth.uid(), 'inventory_count_cancelled', 'inventory_counts', c.id::text, jsonb_build_object('status', c.status),
          jsonb_build_object('reason', v_reason));
end $$;
revoke all on function public.cancel_inventory_count(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.cancel_inventory_count(uuid, text) to authenticated;

create or replace function public.inventory_count_list(p_limit integer default 100)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.can_see_counts() then
    raise exception 'Нет доступа к инвентаризации' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'can_manage', (select private.has_permission('inventory.count.manage')),
    'can_settings', (select private.has_permission('inventory.count.settings')),
    'tolerance_pieces', (select tolerance_pieces::text from public.inventory_count_settings where id),
    'counts', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', c.id, 'number', c.count_number, 'status', c.status, 'kind', c.kind, 'blind', c.blind,
                 'warehouse', coalesce(w.name ->> 'ru', w.code), 'responsible', pr.full_name, 'created_at', c.created_at,
                 'started_at', c.started_at, 'posted_at', c.posted_at, 'cancelled_at', c.cancelled_at,
                 'entries', (select count(*) from public.inventory_count_entries e where e.count_id = c.id))
                 order by c.created_at desc)
               from (select * from public.inventory_counts order by created_at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) c
               join public.warehouses w on w.id = c.warehouse_id
               left join public.profiles pr on pr.id = c.responsible_user_id), '[]'::jsonb));
end $$;
revoke all on function public.inventory_count_list(integer) from public, anon, authenticated, service_role;
grant execute on function public.inventory_count_list(integer) to authenticated;

create or replace function public.set_inventory_count_tolerance(p_pieces numeric)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_count_permission('inventory.count.settings');
  if p_pieces is null or p_pieces < 0 or p_pieces > 100000 or round(p_pieces, 3) <> p_pieces then
    raise exception 'Укажите допуск в штуках от 0 до 100 000';
  end if;
  update public.inventory_count_settings set tolerance_pieces = p_pieces, updated_by = auth.uid(), updated_at = now() where id;
end $$;
revoke all on function public.set_inventory_count_tolerance(numeric) from public, anon, authenticated, service_role;
grant execute on function public.set_inventory_count_tolerance(numeric) to authenticated;

commit;
