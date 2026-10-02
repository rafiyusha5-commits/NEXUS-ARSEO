-- Recovery for a partially applied 202609273900_product_supplier_catalog.sql.
--
-- Scope:
--   * creates only the missing product_suppliers catalogue and its dependent objects;
--   * backfills supplier links from existing products, supplier identifiers and shipments;
--   * restores the expected purchase-plan validation;
--   * verifies the already present sync_product_factory_supplier and
--     validate_import_factory functions/triggers without replacing them.
--
-- Safety:
--   * no source rows are deleted;
--   * no DROP statements are used;
--   * all changes run in one transaction;
--   * any failed preflight or postcondition aborts the whole transaction.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

select pg_advisory_xact_lock(hashtextextended('nexus-arseo:recover:product-supplier-catalog', 0));

-- The production audit found these two functions and triggers already present.
-- Abort instead of creating a second, conflicting implementation if that changes.
do $preflight$
declare
  v_sync_function oid := to_regprocedure('private.sync_product_factory_supplier()');
  v_import_function oid := to_regprocedure('private.validate_import_factory()');
begin
  if to_regclass('public.products') is null
     or to_regclass('public.counterparties') is null
     or to_regclass('public.product_identifiers') is null
     or to_regclass('public.shipments') is null
     or to_regclass('public.shipment_items') is null
     or to_regclass('public.purchase_plans') is null
     or to_regclass('public.purchase_plan_lines') is null then
    raise exception 'Recovery prerequisites are missing';
  end if;

  if v_sync_function is null then
    raise exception 'Expected private.sync_product_factory_supplier() is missing';
  end if;
  if position('public.product_suppliers' in lower(pg_get_functiondef(v_sync_function))) = 0 then
    raise exception 'private.sync_product_factory_supplier() has an unexpected definition';
  end if;
  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    join pg_namespace pn on pn.oid = p.pronamespace
    where not t.tgisinternal
      and n.nspname = 'public'
      and c.relname = 'products'
      and t.tgname = 'sync_product_factory_supplier'
      and pn.nspname = 'private'
      and p.proname = 'sync_product_factory_supplier'
  ) then
    raise exception 'Expected products.sync_product_factory_supplier trigger is missing or conflicting';
  end if;

  if v_import_function is null then
    raise exception 'Expected private.validate_import_factory() is missing';
  end if;
  if position('manufacturer' in lower(pg_get_functiondef(v_import_function))) = 0 then
    raise exception 'private.validate_import_factory() has an unexpected definition';
  end if;
  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    join pg_namespace pn on pn.oid = p.pronamespace
    where not t.tgisinternal
      and n.nspname = 'public'
      and c.relname = 'shipments'
      and t.tgname = 'validate_import_factory'
      and pn.nspname = 'private'
      and p.proname = 'validate_import_factory'
  ) then
    raise exception 'Expected shipments.validate_import_factory trigger is missing or conflicting';
  end if;
end
$preflight$;

create table if not exists public.product_suppliers (
  product_id uuid not null references public.products(id) on delete cascade,
  supplier_id uuid not null references public.counterparties(id) on delete restrict,
  is_primary boolean not null default false,
  status text not null default 'active' check (status in ('active', 'inactive')),
  notes text,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (product_id, supplier_id)
);

create index if not exists product_suppliers_supplier_idx
  on public.product_suppliers(supplier_id, product_id)
  where status = 'active';

create unique index if not exists product_suppliers_one_active
  on public.product_suppliers(product_id)
  where status = 'active';

-- Preserve the same relationship sources and conflict behaviour as migration 3900.
insert into public.product_suppliers(product_id, supplier_id, is_primary, status, notes)
select p.id,
       p.manufacturer_id,
       c.status = 'active',
       case when c.status = 'active' then 'active' else 'inactive' end,
       case
         when c.status = 'active' then 'Перенесено из производителя товара'
         else 'Перенесено из неактивного производителя товара'
       end
from public.products p
join public.counterparties c
  on c.id = p.manufacturer_id
 and c.roles @> array['manufacturer']
on conflict (product_id, supplier_id) do update
set status = excluded.status,
    is_primary = excluded.is_primary,
    updated_at = now();

insert into public.product_suppliers(product_id, supplier_id, is_primary, status, notes)
select distinct i.product_id, i.counterparty_id, false, 'inactive', 'Перенесено из артикула поставщика'
from public.product_identifiers i
join public.counterparties c
  on c.id = i.counterparty_id
 and c.roles && array['supplier', 'manufacturer']
where i.identifier_type = 'supplier_sku'
on conflict (product_id, supplier_id) do update
set updated_at = now();

insert into public.product_suppliers(product_id, supplier_id, is_primary, status, notes)
select distinct si.product_id, s.supplier_id, false, 'inactive', 'Перенесено из истории поставок'
from public.shipment_items si
join public.shipments s on s.id = si.shipment_id
join public.counterparties c
  on c.id = s.supplier_id
 and c.roles && array['supplier', 'manufacturer']
where s.type = 'import'
  and s.supplier_id is not null
on conflict (product_id, supplier_id) do update
set updated_at = now();

create or replace function private.validate_product_supplier()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not exists (select 1 from public.products where id = new.product_id) then
    raise exception 'Товар не найден';
  end if;
  if not exists (
    select 1
    from public.counterparties
    where id = new.supplier_id
      and roles && array['supplier', 'manufacturer']
  ) then
    raise exception 'Выбранная организация не является поставщиком';
  end if;
  if new.status = 'active' and not exists (
    select 1
    from public.counterparties
    where id = new.supplier_id
      and status = 'active'
      and roles @> array['manufacturer']
  ) then
    raise exception 'Активным поставщиком может быть только действующий завод-производитель';
  end if;
  if new.status = 'active' and not exists (
    select 1
    from public.products
    where id = new.product_id
      and manufacturer_id = new.supplier_id
  ) then
    raise exception 'Поставщик товара должен совпадать с его заводом-производителем';
  end if;
  if new.is_primary and new.status = 'active' then
    update public.product_suppliers
    set is_primary = false,
        updated_at = now()
    where product_id = new.product_id
      and supplier_id <> new.supplier_id
      and is_primary;
  end if;
  new.updated_at := now();
  return new;
end
$function$;

revoke all on function private.validate_product_supplier() from public, anon, authenticated, service_role;

do $trigger$
begin
  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where not t.tgisinternal
      and n.nspname = 'public'
      and c.relname = 'product_suppliers'
      and t.tgname = 'validate_product_supplier'
  ) then
    execute 'create trigger validate_product_supplier before insert or update on public.product_suppliers for each row execute function private.validate_product_supplier()';
  end if;
end
$trigger$;

create or replace function private.validate_supplier_identifier()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.identifier_type = 'supplier_sku' and not exists (
    select 1
    from public.product_suppliers ps
    where ps.product_id = new.product_id
      and ps.supplier_id = new.counterparty_id
      and ps.status = 'active'
  ) then
    raise exception 'Сначала привяжите поставщика к товару';
  end if;
  return new;
end
$function$;

revoke all on function private.validate_supplier_identifier() from public, anon, authenticated, service_role;

do $trigger$
begin
  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where not t.tgisinternal
      and n.nspname = 'public'
      and c.relname = 'product_identifiers'
      and t.tgname = 'validate_supplier_identifier'
  ) then
    execute 'create trigger validate_supplier_identifier before insert or update of product_id, identifier_type, counterparty_id on public.product_identifiers for each row execute function private.validate_supplier_identifier()';
  end if;
end
$trigger$;

create or replace function private.validate_shipment_item_supplier()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_type text;
  v_supplier uuid;
begin
  select type, supplier_id
  into v_type, v_supplier
  from public.shipments
  where id = new.shipment_id;

  if not found then
    raise exception 'Поставка не найдена';
  end if;
  if v_type = 'import' and not exists (
    select 1
    from public.product_suppliers ps
    where ps.product_id = new.product_id
      and ps.supplier_id = v_supplier
      and ps.status = 'active'
  ) then
    raise exception 'Этот товар не закреплён за выбранным поставщиком';
  end if;
  return new;
end
$function$;

revoke all on function private.validate_shipment_item_supplier() from public, anon, authenticated, service_role;

do $trigger$
begin
  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where not t.tgisinternal
      and n.nspname = 'public'
      and c.relname = 'shipment_items'
      and t.tgname = 'validate_shipment_item_supplier'
  ) then
    execute 'create trigger validate_shipment_item_supplier before insert or update of shipment_id, product_id on public.shipment_items for each row execute function private.validate_shipment_item_supplier()';
  end if;
end
$trigger$;

alter table public.product_suppliers enable row level security;
grant select, insert, update on public.product_suppliers to authenticated;

do $policy$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'product_suppliers'
      and policyname = 'employees view product suppliers'
  ) then
    execute $sql$
      create policy "employees view product suppliers"
      on public.product_suppliers
      for select to authenticated
      using ((select private.has_permission('products.view')) or (select private.has_permission('suppliers.view')))
    $sql$;
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'product_suppliers'
      and policyname = 'employees create product suppliers'
  ) then
    execute $sql$
      create policy "employees create product suppliers"
      on public.product_suppliers
      for insert to authenticated
      with check ((select private.has_permission('products.create')) or (select private.has_permission('products.update')))
    $sql$;
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'product_suppliers'
      and policyname = 'employees update product suppliers'
  ) then
    execute $sql$
      create policy "employees update product suppliers"
      on public.product_suppliers
      for update to authenticated
      using ((select private.has_permission('products.update')))
      with check ((select private.has_permission('products.update')))
    $sql$;
  end if;
end
$policy$;

do $trigger$
begin
  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where not t.tgisinternal
      and n.nspname = 'public'
      and c.relname = 'product_suppliers'
      and t.tgname = 'audit_product_suppliers_changes'
  ) then
    execute 'create trigger audit_product_suppliers_changes after insert or update on public.product_suppliers for each row execute function private.write_access_audit()';
  end if;
end
$trigger$;

-- Replace the stale Phase 8 implementation with the version expected by migration 3900.
create or replace function public.upsert_purchase_plan_line(
  p_plan_id uuid,
  p_product_id uuid,
  p_stock_on_hand numeric,
  p_stock_in_transit numeric,
  p_stock_reserved numeric,
  p_safety_stock numeric,
  p_expiring_before_sale numeric,
  p_suggested_quantity numeric,
  p_rounding_uom text,
  p_pack_multiple numeric,
  p_approved_quantity numeric,
  p_planned_order_date date default null,
  p_comment text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  p public.purchase_plans;
  v_demand numeric;
  v_id uuid;
begin
  if not private.has_permission('purchase_plans.update') then
    raise exception 'Нет права изменять план закупок';
  end if;
  p := private.lock_purchase_plan(p_plan_id);
  if p.status <> 'draft' then
    raise exception 'Изменять можно только черновик';
  end if;
  if not exists (
    select 1
    from public.products x
    join public.product_suppliers ps
      on ps.product_id = x.id
     and ps.supplier_id = p.supplier_id
     and ps.status = 'active'
    where x.id = p_product_id
      and x.status = 'active'
  ) then
    raise exception 'Товар не входит в ассортимент выбранного поставщика';
  end if;

  select coalesce(sum(final_quantity), 0)
  into v_demand
  from public.forecast_lines
  where forecast_id = p.forecast_id
    and product_id = p_product_id;

  p_stock_on_hand := coalesce(p_stock_on_hand, 0);
  p_stock_in_transit := coalesce(p_stock_in_transit, 0);
  p_stock_reserved := coalesce(p_stock_reserved, 0);
  p_safety_stock := coalesce(p_safety_stock, 0);
  p_expiring_before_sale := coalesce(p_expiring_before_sale, 0);

  if least(
    p_stock_on_hand,
    p_stock_in_transit,
    p_stock_reserved,
    p_safety_stock,
    p_expiring_before_sale,
    p_suggested_quantity
  ) < 0
     or p_stock_reserved > p_stock_on_hand
     or p_pack_multiple <= 0
     or p_approved_quantity <= 0
     or p_rounding_uom not in ('piece', 'box', 'layer', 'pallet', 'truck') then
    raise exception 'Проверьте количества и кратность';
  end if;
  if mod(p_approved_quantity, p_pack_multiple) <> 0 then
    raise exception 'Утверждаемое количество должно быть кратно упаковке';
  end if;

  select id
  into v_id
  from public.purchase_plan_lines
  where purchase_plan_id = p_plan_id
    and product_id = p_product_id
  for update;

  if found then
    update public.purchase_plan_lines
    set forecast_demand = v_demand,
        stock_on_hand = p_stock_on_hand,
        stock_in_transit = p_stock_in_transit,
        stock_reserved = p_stock_reserved,
        safety_stock = p_safety_stock,
        expiring_before_sale = p_expiring_before_sale,
        suggested_quantity = p_suggested_quantity,
        rounding_uom = p_rounding_uom,
        pack_multiple = p_pack_multiple,
        approved_quantity = p_approved_quantity,
        planned_order_date = p_planned_order_date,
        comment = nullif(btrim(p_comment), ''),
        updated_at = now()
    where id = v_id;
  else
    insert into public.purchase_plan_lines(
      purchase_plan_id,
      product_id,
      forecast_demand,
      stock_on_hand,
      stock_in_transit,
      stock_reserved,
      safety_stock,
      expiring_before_sale,
      suggested_quantity,
      rounding_uom,
      pack_multiple,
      approved_quantity,
      planned_order_date,
      comment
    ) values (
      p_plan_id,
      p_product_id,
      v_demand,
      p_stock_on_hand,
      p_stock_in_transit,
      p_stock_reserved,
      p_safety_stock,
      p_expiring_before_sale,
      p_suggested_quantity,
      p_rounding_uom,
      p_pack_multiple,
      p_approved_quantity,
      p_planned_order_date,
      nullif(btrim(p_comment), '')
    ) returning id into v_id;
  end if;
  return v_id;
end
$function$;

comment on table public.product_suppliers is
  'Explicit supplier assortment; inactive rows preserve history';

-- Transactional postconditions. Any failure rolls the entire recovery back.
do $verify$
declare
  v_upsert oid := to_regprocedure(
    'public.upsert_purchase_plan_line(uuid,uuid,numeric,numeric,numeric,numeric,numeric,numeric,text,numeric,numeric,date,text)'
  );
begin
  if to_regclass('public.product_suppliers') is null then
    raise exception 'product_suppliers was not created';
  end if;
  if to_regclass('public.product_suppliers_supplier_idx') is null
     or to_regclass('public.product_suppliers_one_active') is null then
    raise exception 'product_suppliers indexes are incomplete';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.product_suppliers'::regclass) then
    raise exception 'RLS is not enabled on product_suppliers';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public' and tablename = 'product_suppliers') <> 3 then
    raise exception 'product_suppliers policies are incomplete';
  end if;
  if to_regprocedure('private.validate_product_supplier()') is null
     or to_regprocedure('private.validate_supplier_identifier()') is null
     or to_regprocedure('private.validate_shipment_item_supplier()') is null then
    raise exception 'Supplier validation functions are incomplete';
  end if;
  if (
    select count(*)
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where not t.tgisinternal
      and n.nspname = 'public'
      and t.tgname in (
        'validate_product_supplier',
        'sync_product_factory_supplier',
        'validate_supplier_identifier',
        'validate_shipment_item_supplier',
        'validate_import_factory',
        'audit_product_suppliers_changes'
      )
  ) <> 6 then
    raise exception 'Product supplier trigger set is incomplete or duplicated';
  end if;
  if v_upsert is null
     or position('public.product_suppliers' in lower(pg_get_functiondef(v_upsert))) = 0 then
    raise exception 'upsert_purchase_plan_line was not updated';
  end if;
  if exists (
    select 1
    from public.product_suppliers ps
    join public.products p on p.id = ps.product_id
    join public.counterparties c on c.id = ps.supplier_id
    where ps.status = 'active'
      and (
        p.manufacturer_id is distinct from ps.supplier_id
        or c.status <> 'active'
        or not (c.roles @> array['manufacturer'])
      )
  ) then
    raise exception 'Invalid active product-supplier relationship detected';
  end if;
  if exists (
    select 1
    from public.products p
    join public.counterparties c
      on c.id = p.manufacturer_id
     and c.status = 'active'
     and c.roles @> array['manufacturer']
    where not exists (
      select 1
      from public.product_suppliers ps
      where ps.product_id = p.id
        and ps.supplier_id = p.manufacturer_id
        and ps.status = 'active'
    )
  ) then
    raise exception 'An active factory product is missing its active supplier link';
  end if;
end
$verify$;

commit;
