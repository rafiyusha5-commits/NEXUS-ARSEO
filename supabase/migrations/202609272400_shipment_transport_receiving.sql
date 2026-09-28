-- Phase 4A: atomic receiving of one shipment vehicle into traceable batches and inventory.

alter table public.inventory_batches
  add column if not exists source_shipment_transport_id uuid
    references public.shipment_transports(id) on delete set null;

alter table public.inventory_movements
  add column if not exists shipment_transport_id uuid
    references public.shipment_transports(id) on delete set null;

create table if not exists public.shipment_transport_receipts (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipments(id) on delete restrict,
  shipment_transport_id uuid not null unique references public.shipment_transports(id) on delete restrict,
  warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  warehouse_location_id uuid references public.warehouse_locations(id) on delete restrict,
  performed_by_name text not null check (length(trim(performed_by_name)) > 0),
  notes text,
  received_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.shipment_transport_receipt_items (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.shipment_transport_receipts(id) on delete restrict,
  shipment_item_id uuid not null references public.shipment_items(id) on delete restrict,
  expected_quantity numeric(14,3) not null check (expected_quantity > 0),
  accepted_quantity numeric(14,3) not null check (accepted_quantity >= 0),
  damaged_quantity numeric(14,3) not null default 0 check (damaged_quantity >= 0),
  shortage_quantity numeric(14,3) not null default 0 check (shortage_quantity >= 0),
  overage_quantity numeric(14,3) not null default 0 check (overage_quantity >= 0),
  discrepancy_reason text,
  inventory_batch_id uuid references public.inventory_batches(id) on delete restrict,
  inventory_movement_id uuid references public.inventory_movements(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique(receipt_id, shipment_item_id),
  check (
    accepted_quantity + damaged_quantity = expected_quantity - shortage_quantity + overage_quantity
  ),
  check (
    (shortage_quantity = 0 and overage_quantity = 0 and damaged_quantity = 0)
    or nullif(trim(discrepancy_reason), '') is not null
  ),
  check (
    (accepted_quantity = 0 and inventory_batch_id is null and inventory_movement_id is null)
    or (accepted_quantity > 0 and inventory_batch_id is not null and inventory_movement_id is not null)
  )
);

create index if not exists shipment_transport_receipts_shipment_idx
  on public.shipment_transport_receipts(shipment_id, received_at desc);
create index if not exists shipment_transport_receipt_items_item_idx
  on public.shipment_transport_receipt_items(shipment_item_id);
create index if not exists inventory_batches_source_transport_idx
  on public.inventory_batches(source_shipment_transport_id)
  where source_shipment_transport_id is not null;
create index if not exists inventory_movements_shipment_transport_idx
  on public.inventory_movements(shipment_transport_id, created_at desc)
  where shipment_transport_id is not null;

alter table public.shipment_transport_receipts enable row level security;
alter table public.shipment_transport_receipt_items enable row level security;

revoke all on public.shipment_transport_receipts, public.shipment_transport_receipt_items
  from anon, authenticated;
grant select on public.shipment_transport_receipts, public.shipment_transport_receipt_items
  to authenticated;

drop policy if exists "employees view shipment transport receipts" on public.shipment_transport_receipts;
create policy "employees view shipment transport receipts"
on public.shipment_transport_receipts for select to authenticated
using (
  (select private.has_permission('shipments.view'))
  and (select private.has_permission('inventory.view'))
);

drop policy if exists "employees view shipment transport receipt items" on public.shipment_transport_receipt_items;
create policy "employees view shipment transport receipt items"
on public.shipment_transport_receipt_items for select to authenticated
using (
  (select private.has_permission('shipments.view'))
  and (select private.has_permission('inventory.view'))
);

create or replace function public.receive_shipment_transport(
  p_transport_id uuid,
  p_location_id uuid,
  p_lines jsonb,
  p_performed_by_name text,
  p_notes text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transport record;
  v_line record;
  v_item record;
  v_receipt_id uuid;
  v_batch_id uuid;
  v_balance_id uuid;
  v_movement_id uuid;
  v_actual numeric(14,3);
  v_shortage numeric(14,3);
  v_overage numeric(14,3);
  v_old_stage_status text;
  v_location_zone text;
  v_expected_count integer;
  v_line_count integer;
  v_stage record;
begin
  if not (select private.has_permission('shipments.view'))
     or not (select private.has_permission('inventory.receive')) then
    raise exception 'Недостаточно прав для приёмки автомобиля';
  end if;
  if p_transport_id is null then raise exception 'Автомобиль не выбран'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Добавьте позиции приёмки';
  end if;
  if nullif(trim(p_performed_by_name), '') is null then
    raise exception 'Укажите исполнителя приёмки';
  end if;

  select
    transport.id,
    transport.shipment_id,
    transport.sequence_no,
    transport.status,
    shipment.destination_warehouse_id as warehouse_id,
    shipment.status as shipment_status,
    shipment.is_locked
  into v_transport
  from public.shipment_transports transport
  join public.shipments shipment on shipment.id = transport.shipment_id
  where transport.id = p_transport_id
  for update of transport, shipment;

  if not found then raise exception 'Автомобиль поставки не найден'; end if;
  if v_transport.is_locked or v_transport.shipment_status in ('on_hold', 'cancelled', 'closed') then
    raise exception 'Поставка недоступна для приёмки';
  end if;
  if exists (
    select 1 from public.shipment_transport_receipts
    where shipment_transport_id = p_transport_id
  ) then
    raise exception 'Этот автомобиль уже принят';
  end if;
  if v_transport.status <> 'arrived' then
    raise exception 'Сначала отметьте автомобиль как прибывший';
  end if;

  if p_location_id is not null then
    select location.zone into v_location_zone
    from public.warehouse_locations location
    where location.id = p_location_id
      and location.warehouse_id = v_transport.warehouse_id
      and location.status = 'active';
    if not found then raise exception 'Зона не относится к складу поставки или недоступна'; end if;
  end if;

  select count(*) into v_expected_count
  from public.shipment_items item
  where item.shipment_transport_id = p_transport_id;
  if v_expected_count = 0 then raise exception 'В автомобиле нет распределённых товаров'; end if;

  select count(*), count(distinct parsed.item_id)
  into v_line_count, v_expected_count
  from jsonb_to_recordset(p_lines) as parsed(item_id uuid);
  if v_line_count <> v_expected_count then raise exception 'Одна позиция передана несколько раз'; end if;

  select count(*) into v_expected_count
  from public.shipment_items item
  where item.shipment_transport_id = p_transport_id;
  if v_line_count <> v_expected_count then
    raise exception 'Передайте результаты по всем позициям автомобиля';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_lines) as parsed(item_id uuid)
    left join public.shipment_items item
      on item.id = parsed.item_id and item.shipment_transport_id = p_transport_id
    where item.id is null
  ) then
    raise exception 'Позиция не относится к выбранному автомобилю';
  end if;

  insert into public.shipment_transport_receipts(
    shipment_id, shipment_transport_id, warehouse_id, warehouse_location_id,
    performed_by_name, notes
  ) values (
    v_transport.shipment_id, p_transport_id, v_transport.warehouse_id, p_location_id,
    trim(p_performed_by_name), nullif(trim(p_notes), '')
  ) returning id into v_receipt_id;

  for v_line in
    select *
    from jsonb_to_recordset(p_lines) as parsed(
      item_id uuid,
      accepted_quantity numeric,
      damaged_quantity numeric,
      batch_number text,
      manufacture_date date,
      expiry_date date,
      discrepancy_reason text
    )
  loop
    select
      item.id,
      item.product_id,
      item.uom,
      coalesce(item.shipped_quantity, item.confirmed_quantity, item.ordered_quantity) as expected_quantity
    into v_item
    from public.shipment_items item
    where item.id = v_line.item_id
      and item.shipment_transport_id = p_transport_id
    for update;

    if not found then raise exception 'Позиция автомобиля не найдена'; end if;
    if v_line.accepted_quantity is null or v_line.accepted_quantity < 0
       or coalesce(v_line.damaged_quantity, 0) < 0 then
      raise exception 'Фактическое и повреждённое количество не могут быть отрицательными';
    end if;

    v_actual := v_line.accepted_quantity + coalesce(v_line.damaged_quantity, 0);
    v_shortage := greatest(v_item.expected_quantity - v_actual, 0);
    v_overage := greatest(v_actual - v_item.expected_quantity, 0);

    if (v_shortage > 0 or v_overage > 0 or coalesce(v_line.damaged_quantity, 0) > 0)
       and nullif(trim(v_line.discrepancy_reason), '') is null then
      raise exception 'Укажите причину расхождения по позиции %', v_line.item_id;
    end if;

    v_batch_id := null;
    v_movement_id := null;
    if v_line.accepted_quantity > 0 then
      if nullif(trim(v_line.batch_number), '') is null then raise exception 'Укажите номер партии'; end if;
      if v_line.expiry_date is null then raise exception 'Укажите срок годности партии'; end if;
      if v_line.manufacture_date is not null and v_line.manufacture_date > v_line.expiry_date then
        raise exception 'Дата производства позже срока годности';
      end if;

      insert into public.inventory_batches(
        product_id, source_shipment_item_id, source_shipment_transport_id,
        batch_number, manufacture_date, expiry_date, notes
      ) values (
        v_item.product_id, v_item.id, p_transport_id,
        trim(v_line.batch_number), v_line.manufacture_date, v_line.expiry_date,
        nullif(trim(p_notes), '')
      )
      on conflict(product_id, batch_number, expiry_date) do update set
        source_shipment_item_id = coalesce(public.inventory_batches.source_shipment_item_id, excluded.source_shipment_item_id),
        source_shipment_transport_id = coalesce(public.inventory_batches.source_shipment_transport_id, excluded.source_shipment_transport_id),
        manufacture_date = coalesce(public.inventory_batches.manufacture_date, excluded.manufacture_date),
        updated_at = now()
      returning id into v_batch_id;

      insert into public.inventory_balances(
        batch_id, warehouse_id, warehouse_location_id, uom, quantity_on_hand
      ) values (
        v_batch_id, v_transport.warehouse_id, p_location_id, v_item.uom, v_line.accepted_quantity
      )
      on conflict do nothing
      returning id into v_balance_id;

      if v_balance_id is null then
        select balance.id into v_balance_id
        from public.inventory_balances balance
        where balance.batch_id = v_batch_id
          and balance.warehouse_id = v_transport.warehouse_id
          and balance.warehouse_location_id is not distinct from p_location_id
          and balance.uom = v_item.uom
        for update;
        update public.inventory_balances
        set quantity_on_hand = quantity_on_hand + v_line.accepted_quantity,
            updated_at = now()
        where id = v_balance_id;
      end if;

      insert into public.inventory_movements(
        batch_id, movement_type, quantity, uom,
        to_warehouse_id, to_location_id,
        shipment_id, shipment_item_id, shipment_transport_id,
        reference, reason, performed_by_name
      ) values (
        v_batch_id, 'receipt', v_line.accepted_quantity, v_item.uom,
        v_transport.warehouse_id, p_location_id,
        v_transport.shipment_id, v_item.id, p_transport_id,
        format('Приёмка автомобиля №%s', v_transport.sequence_no),
        nullif(trim(v_line.discrepancy_reason), ''), trim(p_performed_by_name)
      ) returning id into v_movement_id;
    end if;

    insert into public.shipment_transport_receipt_items(
      receipt_id, shipment_item_id, expected_quantity,
      accepted_quantity, damaged_quantity, shortage_quantity, overage_quantity,
      discrepancy_reason, inventory_batch_id, inventory_movement_id
    ) values (
      v_receipt_id, v_item.id, v_item.expected_quantity,
      v_line.accepted_quantity, coalesce(v_line.damaged_quantity, 0), v_shortage, v_overage,
      nullif(trim(v_line.discrepancy_reason), ''), v_batch_id, v_movement_id
    );

    update public.shipment_items
    set received_quantity = v_actual,
        discrepancy_reason = nullif(trim(v_line.discrepancy_reason), ''),
        discrepancy_accepted_by = case
          when v_shortage > 0 or v_overage > 0 or coalesce(v_line.damaged_quantity, 0) > 0
            then auth.uid()
          else null
        end,
        updated_at = now()
    where id = v_item.id;
  end loop;

  update public.shipment_transports
  set status = 'unloaded',
      actual_arrival_date = coalesce(actual_arrival_date, current_date),
      updated_at = now()
  where id = p_transport_id;

  for v_stage in
    select run.id, run.status
    from public.shipment_stage_runs run
    join public.shipment_stages stage on stage.id = run.stage_id
    where run.shipment_id = v_transport.shipment_id
      and run.shipment_transport_id = p_transport_id
      and (
        stage.code in ('warehouse_receiving', 'quantity_check', 'batch_registration')
        or (stage.code = 'putaway' and v_location_zone = 'storage')
      )
      and run.status <> 'completed'
    order by stage.sequence_order
    for update of run
  loop
    v_old_stage_status := v_stage.status;
    update public.shipment_stage_runs
    set status = 'completed',
        status_reason = null,
        performed_by_name = trim(p_performed_by_name),
        started_at = coalesce(started_at, now()),
        completed_at = now(),
        updated_at = now()
    where id = v_stage.id;

    insert into public.shipment_stage_history(
      stage_run_id, shipment_id, from_status, to_status,
      changed_by, performed_by_name, reason
    ) values (
      v_stage.id, v_transport.shipment_id, v_old_stage_status, 'completed',
      auth.uid(), trim(p_performed_by_name),
      format('Приёмка автомобиля №%s', v_transport.sequence_no)
    );
  end loop;

  update public.shipments shipment
  set leading_stage_id = (
        select run.stage_id
        from public.shipment_stage_runs run
        join public.shipment_stages stage on stage.id = run.stage_id
        where run.shipment_id = v_transport.shipment_id
          and run.is_required
          and run.status not in ('completed', 'skipped', 'not_applicable')
        order by stage.sequence_order
        limit 1
      ),
      status = coalesce((
        select stage.status_category
        from public.shipment_stage_runs run
        join public.shipment_stages stage on stage.id = run.stage_id
        where run.shipment_id = v_transport.shipment_id
          and run.is_required
          and run.status not in ('completed', 'skipped', 'not_applicable')
        order by stage.sequence_order
        limit 1
      ), 'closed'),
      updated_at = now()
  where shipment.id = v_transport.shipment_id
    and shipment.status not in ('on_hold', 'cancelled');

  return v_receipt_id;
end;
$$;

revoke all on function public.receive_shipment_transport(uuid,uuid,jsonb,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.receive_shipment_transport(uuid,uuid,jsonb,text,text)
  to authenticated;

drop trigger if exists audit_shipment_transport_receipts_changes
  on public.shipment_transport_receipts;
create trigger audit_shipment_transport_receipts_changes
after insert or update on public.shipment_transport_receipts
for each row execute function private.write_access_audit();

drop trigger if exists audit_shipment_transport_receipt_items_changes
  on public.shipment_transport_receipt_items;
create trigger audit_shipment_transport_receipt_items_changes
after insert or update on public.shipment_transport_receipt_items
for each row execute function private.write_access_audit();

comment on table public.shipment_transport_receipts is
  'Final, one-time warehouse receipt of one shipment vehicle';
comment on table public.shipment_transport_receipt_items is
  'Expected, accepted, damaged, short and excess quantities recorded during vehicle receipt';
comment on function public.receive_shipment_transport(uuid,uuid,jsonb,text,text) is
  'Atomically receives every item of an arrived vehicle, creates batches and stock movements, and completes receiving stages';
