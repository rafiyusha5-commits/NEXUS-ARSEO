-- Regrade by expiry (2026-11-28, decision of the owner damirator1-afk): part of a batch found after the receipt to carry
-- another expiry than recorded (a supplier mixed up expiries against the packing list) is moved to the batch of the
-- same product and number with the right expiry. A posted operation with a number and a reason, two adjustment
-- movements (out of the wrong batch, into the right one, same warehouse, place and unit), the audit log, a reversal.
-- Only free stock moves (a reservation is replaced first); a place under an inventory count stays locked (the count
-- lock of 202611280300 applies to the balances). A new batch takes the cost, origin and state of the source one: a
-- blocked part stays blocked until someone checks it. Adjustments outside documents are not losses (202611280100).
begin;

create sequence if not exists public.expiry_regrade_no_seq;
revoke all on sequence public.expiry_regrade_no_seq from public, anon, authenticated, service_role;

create table if not exists public.expiry_regrades (
  id uuid primary key default gen_random_uuid(),
  regrade_number text not null unique,
  product_id uuid not null references public.products(id) on delete restrict,
  warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  location_id uuid references public.warehouse_locations(id) on delete restrict,
  uom text not null check (uom in ('piece', 'box', 'layer', 'pallet', 'truck')),
  from_batch_id uuid not null references public.inventory_batches(id) on delete restrict,
  to_batch_id uuid not null references public.inventory_batches(id) on delete restrict,
  from_balance_id uuid not null references public.inventory_balances(id) on delete restrict,
  to_balance_id uuid not null references public.inventory_balances(id) on delete restrict,
  quantity numeric(14, 3) not null check (quantity > 0),
  reason text not null check (btrim(reason) <> '' and length(reason) <= 500),
  new_batch boolean not null,
  status text not null default 'posted' check (status in ('posted', 'cancelled')),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  cancelled_by uuid references public.profiles(id) on delete restrict,
  cancelled_at timestamptz,
  cancel_reason text check (cancel_reason is null or length(cancel_reason) <= 500),
  check (from_batch_id <> to_batch_id),
  check ((status = 'cancelled') = (cancelled_at is not null and cancel_reason is not null))
);
create index if not exists expiry_regrades_product_idx on public.expiry_regrades(product_id);
create index if not exists expiry_regrades_warehouse_idx on public.expiry_regrades(warehouse_id);
create index if not exists expiry_regrades_location_idx on public.expiry_regrades(location_id);
create index if not exists expiry_regrades_from_batch_idx on public.expiry_regrades(from_batch_id);
create index if not exists expiry_regrades_to_batch_idx on public.expiry_regrades(to_batch_id);
create index if not exists expiry_regrades_from_balance_idx on public.expiry_regrades(from_balance_id);
create index if not exists expiry_regrades_to_balance_idx on public.expiry_regrades(to_balance_id);
create index if not exists expiry_regrades_created_by_idx on public.expiry_regrades(created_by);
create index if not exists expiry_regrades_cancelled_by_idx on public.expiry_regrades(cancelled_by);
alter table public.expiry_regrades enable row level security;
revoke all on public.expiry_regrades from public, anon, authenticated, service_role;

alter table public.inventory_movements add column if not exists expiry_regrade_id uuid references public.expiry_regrades(id) on delete restrict;
create index if not exists inventory_movements_expiry_regrade_idx on public.inventory_movements(expiry_regrade_id) where expiry_regrade_id is not null;

create or replace function private.require_expiry_regrade() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not ((select private.has_permission('inventory.control')) and (select private.has_permission('inventory.view'))) then
    raise exception 'Нет права исправлять срок партии: нужно «Остатки: контроль»' using errcode = '42501';
  end if;
end $$;
revoke all on function private.require_expiry_regrade() from public, anon, authenticated, service_role;

-- Moving p_quantity of a balance to the batch of the same product and number with the expiry p_expiry_date.
create or replace function public.regrade_batch_expiry(p_balance_id uuid, p_quantity numeric, p_expiry_date date, p_reason text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_balance public.inventory_balances;
  v_source public.inventory_batches;
  v_target uuid;
  v_new boolean := false;
  v_target_balance uuid;
  v_number text;
  v_id uuid := gen_random_uuid();
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform private.require_expiry_regrade();
  select * into v_balance from public.inventory_balances where id = p_balance_id for update;
  if not found then
    raise exception 'Остаток не найден';
  end if;
  select * into v_source from public.inventory_batches where id = v_balance.batch_id for update;
  if v_source.status = 'depleted' then
    raise exception 'Партия израсходована';
  end if;
  if p_expiry_date is null then
    raise exception 'Укажите правильный срок годности';
  end if;
  if p_expiry_date = v_source.expiry_date then
    raise exception 'Срок совпадает с текущим сроком партии';
  end if;
  if v_source.manufacture_date is not null and p_expiry_date < v_source.manufacture_date then
    raise exception 'Срок годности раньше даты производства партии';
  end if;
  if v_reason = '' or length(v_reason) > 500 then
    raise exception 'Укажите причину: что и где обнаружено';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity <> round(p_quantity, 3) then
    raise exception 'Количество — положительное число, не более трёх знаков после запятой';
  end if;
  if p_quantity > v_balance.quantity_on_hand - v_balance.quantity_reserved then
    raise exception 'Перенести можно только свободный остаток: свободно %. Зарезервированное сначала снимите или замените в заказе',
      trim_scale(v_balance.quantity_on_hand - v_balance.quantity_reserved);
  end if;

  -- The batch with the right expiry: the existing one, or a new one with the origin, cost and state of the source.
  select id into v_target from public.inventory_batches
   where product_id = v_source.product_id and batch_number = v_source.batch_number and expiry_date = p_expiry_date
   for update;
  if v_target is null then
    insert into public.inventory_batches(product_id, source_shipment_item_id, source_shipment_transport_id, batch_number, manufacture_date,
                                         expiry_date, received_at, status, status_reason, status_changed_by, status_changed_at, notes,
                                         created_by, unit_landed_cost, cost_currency_id, cost_calculation_id, cost_uom, cost_basis)
    values (v_source.product_id, v_source.source_shipment_item_id, v_source.source_shipment_transport_id, v_source.batch_number,
            v_source.manufacture_date, p_expiry_date, v_source.received_at,
            case when v_source.status = 'depleted' then 'available' else v_source.status end,
            v_source.status_reason, v_source.status_changed_by, v_source.status_changed_at,
            format('Пересорт по сроку из партии до %s', to_char(v_source.expiry_date, 'DD.MM.YYYY')),
            auth.uid(), v_source.unit_landed_cost, v_source.cost_currency_id, v_source.cost_calculation_id, v_source.cost_uom, v_source.cost_basis)
    returning id into v_target;
    v_new := true;
  end if;

  update public.inventory_balances set quantity_on_hand = quantity_on_hand - p_quantity, updated_at = now() where id = v_balance.id;
  select id into v_target_balance from public.inventory_balances
   where batch_id = v_target and warehouse_id = v_balance.warehouse_id
     and warehouse_location_id is not distinct from v_balance.warehouse_location_id and uom = v_balance.uom
   for update;
  if v_target_balance is null then
    insert into public.inventory_balances(batch_id, warehouse_id, warehouse_location_id, uom, quantity_on_hand)
    values (v_target, v_balance.warehouse_id, v_balance.warehouse_location_id, v_balance.uom, p_quantity)
    returning id into v_target_balance;
  else
    update public.inventory_balances set quantity_on_hand = quantity_on_hand + p_quantity, updated_at = now() where id = v_target_balance;
  end if;

  v_number := 'ПСР-' || lpad(nextval('public.expiry_regrade_no_seq')::text, 6, '0');
  insert into public.expiry_regrades(id, regrade_number, product_id, warehouse_id, location_id, uom, from_batch_id, to_batch_id, from_balance_id,
                                     to_balance_id, quantity, reason, new_batch, created_by)
  values (v_id, v_number, v_source.product_id, v_balance.warehouse_id, v_balance.warehouse_location_id, v_balance.uom, v_source.id, v_target,
          v_balance.id, v_target_balance, p_quantity, v_reason, v_new, auth.uid());
  insert into public.inventory_movements(batch_id, movement_type, quantity, uom, from_warehouse_id, from_location_id, reference, reason, expiry_regrade_id)
  values (v_source.id, 'adjustment', p_quantity, v_balance.uom, v_balance.warehouse_id, v_balance.warehouse_location_id, v_number,
          format('Пересорт по сроку: в партию до %s. %s', to_char(p_expiry_date, 'DD.MM.YYYY'), v_reason), v_id);
  insert into public.inventory_movements(batch_id, movement_type, quantity, uom, to_warehouse_id, to_location_id, reference, reason, expiry_regrade_id)
  values (v_target, 'adjustment', p_quantity, v_balance.uom, v_balance.warehouse_id, v_balance.warehouse_location_id, v_number,
          format('Пересорт по сроку: из партии до %s. %s', to_char(v_source.expiry_date, 'DD.MM.YYYY'), v_reason), v_id);
  insert into public.audit_log(actor_user_id, action, entity_type, entity_id, before_data, after_data, metadata)
  values (auth.uid(), 'expiry_regrade', 'inventory_batches', v_source.id::text,
          jsonb_build_object('batch_id', v_source.id, 'expiry_date', v_source.expiry_date),
          jsonb_build_object('batch_id', v_target, 'expiry_date', p_expiry_date, 'new_batch', v_new),
          jsonb_build_object('regrade', v_number, 'quantity', p_quantity, 'uom', v_balance.uom, 'reason', v_reason));
  return v_id;
end $$;
revoke all on function public.regrade_batch_expiry(uuid, numeric, date, text) from public, anon, authenticated, service_role;
grant execute on function public.regrade_batch_expiry(uuid, numeric, date, text) to authenticated;

-- The reversal: the quantity goes back while it is still free in the batch it was moved to.
create or replace function public.cancel_expiry_regrade(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  r public.expiry_regrades;
  v_free numeric;
begin
  perform private.require_expiry_regrade();
  select * into r from public.expiry_regrades where id = p_id for update;
  if not found then
    raise exception 'Пересорт не найден';
  end if;
  if r.status <> 'posted' then
    raise exception 'Пересорт уже отменён';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null or length(btrim(p_reason)) > 500 then
    raise exception 'Укажите причину отмены';
  end if;
  perform 1 from public.inventory_balances where id in (r.from_balance_id, r.to_balance_id) order by id for update;
  select quantity_on_hand - quantity_reserved into v_free from public.inventory_balances where id = r.to_balance_id;
  if v_free < r.quantity then
    raise exception 'Нельзя отменить: из партии с исправленным сроком уже израсходовано или зарезервировано, свободно %', trim_scale(v_free);
  end if;
  update public.inventory_balances set quantity_on_hand = quantity_on_hand - r.quantity, updated_at = now() where id = r.to_balance_id;
  update public.inventory_balances set quantity_on_hand = quantity_on_hand + r.quantity, updated_at = now() where id = r.from_balance_id;
  update public.inventory_batches set status = 'available', updated_at = now() where id = r.from_batch_id and status = 'depleted';
  insert into public.inventory_movements(batch_id, movement_type, quantity, uom, from_warehouse_id, from_location_id, reference, reason, expiry_regrade_id, is_reversal)
  values (r.to_batch_id, 'adjustment', r.quantity, r.uom, r.warehouse_id, r.location_id, 'Сторно ' || r.regrade_number, btrim(p_reason), r.id, true);
  insert into public.inventory_movements(batch_id, movement_type, quantity, uom, to_warehouse_id, to_location_id, reference, reason, expiry_regrade_id, is_reversal)
  values (r.from_batch_id, 'adjustment', r.quantity, r.uom, r.warehouse_id, r.location_id, 'Сторно ' || r.regrade_number, btrim(p_reason), r.id, true);
  update public.expiry_regrades set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = clock_timestamp(), cancel_reason = btrim(p_reason)
   where id = r.id;
  insert into public.audit_log(actor_user_id, action, entity_type, entity_id, metadata)
  values (auth.uid(), 'expiry_regrade_cancelled', 'inventory_batches', r.from_batch_id::text,
          jsonb_build_object('regrade', r.regrade_number, 'quantity', r.quantity, 'reason', btrim(p_reason)));
end $$;
revoke all on function public.cancel_expiry_regrade(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.cancel_expiry_regrade(uuid, text) to authenticated;

-- The regrades of a batch (from it or into it), newest first, for the batch page.
create or replace function public.batch_expiry_regrades(p_batch_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (select private.has_permission('inventory.view')) then
    raise exception 'Нет доступа к остаткам' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'can_regrade', (select private.has_permission('inventory.control')),
    'regrades', coalesce((select jsonb_agg(jsonb_build_object(
                  'id', r.id, 'number', r.regrade_number, 'status', r.status, 'quantity', r.quantity::text, 'uom', r.uom,
                  'from_batch_id', r.from_batch_id, 'from_expiry', fb.expiry_date, 'to_batch_id', r.to_batch_id, 'to_expiry', tb.expiry_date,
                  'new_batch', r.new_batch, 'warehouse', coalesce(w.name ->> 'ru', w.code), 'location', wl.code, 'reason', r.reason,
                  'created_by', (select full_name from public.profiles where id = r.created_by), 'created_at', r.created_at,
                  'cancelled_at', r.cancelled_at, 'cancel_reason', r.cancel_reason,
                  'direction', case when r.from_batch_id = p_batch_id then 'out' else 'in' end)
                  order by r.created_at desc)
             from public.expiry_regrades r
             join public.inventory_batches fb on fb.id = r.from_batch_id
             join public.inventory_batches tb on tb.id = r.to_batch_id
             join public.warehouses w on w.id = r.warehouse_id
             left join public.warehouse_locations wl on wl.id = r.location_id
            where p_batch_id in (r.from_batch_id, r.to_batch_id)), '[]'::jsonb));
end $$;
revoke all on function public.batch_expiry_regrades(uuid) from public, anon, authenticated, service_role;
grant execute on function public.batch_expiry_regrades(uuid) to authenticated;

commit;
