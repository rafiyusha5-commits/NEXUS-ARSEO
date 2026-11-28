-- Block В, part 2 (2026-11-28): warehouse operations from a phone. Owner decisions of 2026-11-28 (damirator1-afk,
-- defaults of the task accepted), see docs/mobile-warehouse.md:
--   * moving between locations of one warehouse goes through the warehouse transfer document, as between warehouses:
--     the document now accepts the same warehouse when the destination location differs (posting, reversal, the stock
--     checks and the lock of counted locations are those of the document);
--   * picking an order: the scanned batch must be the reserved one — the database checks it; another batch only through
--     the existing replacement of reservations (sales.override_fefo); shipping a picked order calls the existing
--     fulfillment;
--   * receiving uses the existing receive_shipment_transport, counting the functions of 202611280300: nothing new here.
begin;

-- Transfer documents within one warehouse ------------------------------------------------------------------------
alter table public.inventory_operation_documents drop constraint if exists inventory_operation_documents_check;
alter table public.inventory_operation_documents add constraint inventory_operation_documents_check check (
  (operation_type = 'transfer' and to_warehouse_id is not null)
  or (operation_type in ('write_off', 'adjustment') and to_warehouse_id is null));

-- 202609273800 with the destination warehouse allowed to be the source one (a move between its locations); the document
-- date in Kazakhstan time as set by 202609278300.
create or replace function public.create_inventory_operation_document(
  p_operation_type text,
  p_document_date date,
  p_from_warehouse_id uuid,
  p_to_warehouse_id uuid default null,
  p_reference text default null,
  p_reason text default null,
  p_performed_by_name text default null
) returns uuid language plpgsql security definer set search_path='' set timezone to 'Asia/Almaty' as $$
declare
  v_id uuid;
  v_prefix text;
  v_number text;
begin
  perform private.require_inventory_operation_permission(p_operation_type);
  if not exists(select 1 from public.warehouses where id=p_from_warehouse_id and status='active') then
    raise exception 'Склад-отправитель недоступен';
  end if;
  if p_operation_type='transfer' then
    if p_to_warehouse_id is null or not exists(select 1 from public.warehouses where id=p_to_warehouse_id and status='active') then
      raise exception 'Выберите активный склад назначения';
    end if;
  elsif p_to_warehouse_id is not null then
    raise exception 'Склад назначения указывается только для перемещения';
  end if;
  if p_operation_type='write_off' and nullif(trim(p_reason),'') is null then
    raise exception 'Укажите причину списания';
  end if;
  v_prefix:=case p_operation_type when 'transfer' then 'ПРМ' when 'write_off' then 'СПС' else 'КОР' end;
  v_number:=v_prefix||'-'||to_char(coalesce(p_document_date,current_date),'YYYYMMDD')||'-'||lpad(nextval('public.inventory_operation_document_no_seq')::text,6,'0');
  insert into public.inventory_operation_documents(
    document_number,operation_type,document_date,from_warehouse_id,to_warehouse_id,reference,reason,performed_by_name,created_by
  ) values(
    v_number,p_operation_type,coalesce(p_document_date,current_date),p_from_warehouse_id,p_to_warehouse_id,
    nullif(trim(p_reference),''),nullif(trim(p_reason),''),nullif(trim(p_performed_by_name),''),auth.uid()
  ) returning id into v_id;
  return v_id;
end $$;

-- 202609278400 with one more rule: within one warehouse a transfer line needs a destination location other than its own.
create or replace function public.add_inventory_operation_line(
  p_document_id uuid,p_source_balance_id uuid,p_to_location_id uuid,p_quantity numeric,
  p_adjustment_direction text default null,p_notes text default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare
  v_document record;
  v_balance record;
  v_id uuid;
begin
  select * into v_document from public.inventory_operation_documents where id=p_document_id for update;
  if not found then raise exception 'Складской документ не найден'; end if;
  perform private.require_inventory_operation_permission(v_document.operation_type);
  if v_document.status<>'draft' then raise exception 'Строки можно менять только в черновике'; end if;
  if p_quantity is null or p_quantity<=0 then raise exception 'Количество должно быть больше нуля'; end if;
  select balance.*,batch.status as batch_status into v_balance
  from public.inventory_balances balance join public.inventory_batches batch on batch.id=balance.batch_id
  where balance.id=p_source_balance_id;
  if not found or v_balance.warehouse_id<>v_document.from_warehouse_id then raise exception 'Остаток не относится к складу документа'; end if;
  if v_document.operation_type='transfer' and v_balance.batch_status<>'available' then raise exception 'Партия недоступна для операции'; end if;
  -- A batch in quarantine or blocked is written off as it is; only a depleted one has nothing to write off.
  if v_document.operation_type='write_off' and v_balance.batch_status not in ('available','quarantine','blocked') then
    raise exception 'Партия недоступна для операции';
  end if;
  if v_document.operation_type='transfer' then
    if p_to_location_id is not null and not exists(
      select 1 from public.warehouse_locations where id=p_to_location_id and warehouse_id=v_document.to_warehouse_id and status='active'
    ) then raise exception 'Зона не относится к складу назначения'; end if;
    if v_document.to_warehouse_id=v_document.from_warehouse_id
       and (p_to_location_id is null or p_to_location_id is not distinct from v_balance.warehouse_location_id) then
      raise exception 'Для перемещения внутри склада выберите другое место';
    end if;
    if p_adjustment_direction is not null then raise exception 'Направление корректировки здесь не используется'; end if;
  elsif p_to_location_id is not null then
    raise exception 'Зона назначения используется только при перемещении';
  elsif v_document.operation_type='adjustment' and p_adjustment_direction not in ('increase','decrease') then
    raise exception 'Выберите направление корректировки';
  elsif v_document.operation_type<>'adjustment' and p_adjustment_direction is not null then
    raise exception 'Направление корректировки здесь не используется';
  end if;
  insert into public.inventory_operation_lines(
    document_id,source_balance_id,batch_id,from_location_id,to_location_id,uom,quantity,adjustment_direction,notes
  ) values(
    p_document_id,p_source_balance_id,v_balance.batch_id,v_balance.warehouse_location_id,p_to_location_id,v_balance.uom,p_quantity,p_adjustment_direction,nullif(trim(p_notes),'')
  ) returning id into v_id;
  return v_id;
end $$;

-- A move from a phone: one transfer document of one line, posted at once. Every check is that of the document.
create or replace function public.move_between_locations(p_balance_id uuid, p_to_location_id uuid, p_quantity numeric, p_note text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  b public.inventory_balances;
  v_document uuid;
begin
  select * into b from public.inventory_balances where id = p_balance_id;
  if not found then
    raise exception 'Остаток не найден';
  end if;
  if not exists (select 1 from public.warehouse_locations where id = p_to_location_id) then
    raise exception 'Место назначения не найдено';
  end if;
  if not exists (select 1 from public.warehouse_locations where id = p_to_location_id and warehouse_id = b.warehouse_id) then
    raise exception 'Место назначения на другом складе: перемещайте между складами документом перемещения';
  end if;
  v_document := public.create_inventory_operation_document('transfer', private.business_today(), b.warehouse_id, b.warehouse_id, null,
                                                           coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Перемещение с телефона'), null);
  perform public.add_inventory_operation_line(v_document, b.id, p_to_location_id, p_quantity, null, p_note);
  perform public.post_inventory_operation_document(v_document);
  return v_document;
end $$;
revoke all on function public.move_between_locations(uuid, uuid, numeric, text) from public, anon, authenticated, service_role;
grant execute on function public.move_between_locations(uuid, uuid, numeric, text) to authenticated;

-- Picking ----------------------------------------------------------------------------------------------------------
-- What was taken from the shelf for a reservation: the batch and place scanned, by whom and when. Append only.
create table if not exists public.sale_picks (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.inventory_reservations(id) on delete restrict,
  sale_id uuid not null references public.sales(id) on delete restrict,
  batch_id uuid not null references public.inventory_batches(id) on delete restrict,
  location_id uuid references public.warehouse_locations(id) on delete restrict,
  quantity numeric(14, 3) not null check (quantity > 0),
  picked_by uuid not null references public.profiles(id) on delete restrict,
  picked_at timestamptz not null default clock_timestamp()
);
create index if not exists sale_picks_reservation_idx on public.sale_picks(reservation_id);
create index if not exists sale_picks_sale_idx on public.sale_picks(sale_id);
create index if not exists sale_picks_batch_idx on public.sale_picks(batch_id);
create index if not exists sale_picks_location_idx on public.sale_picks(location_id);
create index if not exists sale_picks_picked_by_idx on public.sale_picks(picked_by);
alter table public.sale_picks enable row level security;
revoke all on public.sale_picks from public, anon, authenticated, service_role;

create or replace function private.guard_sale_picks() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'Отбор не меняется задним числом' using errcode = '42501';
end $$;
revoke all on function private.guard_sale_picks() from public, anon, authenticated, service_role;
drop trigger if exists sale_picks_immutable on public.sale_picks;
create trigger sale_picks_immutable before update or delete on public.sale_picks for each row execute function private.guard_sale_picks();

create or replace function private.require_picking() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not ((select private.has_permission('inventory.move')) and (select private.has_permission('sales.view'))) then
    raise exception 'Нет права отбирать заказы' using errcode = '42501';
  end if;
end $$;
revoke all on function private.require_picking() from public, anon, authenticated, service_role;

-- The pick list of a confirmed order: each active reservation with its batch, place, expiry and how much is picked.
create or replace function public.order_pick_list(p_sale_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.sales;
begin
  perform private.require_picking();
  select * into s from public.sales where id = p_sale_id;
  if not found then
    raise exception 'Заказ не найден';
  end if;
  return jsonb_build_object('sale_id', s.id, 'sale_number', s.sale_number, 'status', s.status,
    'customer', (select coalesce(short_name, legal_name) from public.counterparties where id = s.customer_id),
    'can_replace', (select private.has_permission('sales.override_fefo')),
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
               'reservation_id', r.id, 'sku', p.internal_sku, 'product', coalesce(p.name ->> 'ru', p.internal_sku), 'product_id', p.id,
               'batch_id', r.batch_id, 'batch', b.batch_number, 'expiry_date', b.expiry_date, 'location_id', bl.warehouse_location_id,
               'location', wl.code, 'uom', r.uom, 'quantity', r.quantity::text,
               'picked', coalesce((select sum(x.quantity) from public.sale_picks x where x.reservation_id = r.id), 0)::text)
               order by wl.code nulls last, p.internal_sku, b.batch_number)
             from public.inventory_reservations r
             join public.sale_items i on i.id = r.sale_item_id
             join public.products p on p.id = i.product_id
             join public.inventory_batches b on b.id = r.batch_id
             join public.inventory_balances bl on bl.id = r.inventory_balance_id
             left join public.warehouse_locations wl on wl.id = bl.warehouse_location_id
            where i.sale_id = s.id and r.status = 'active'), '[]'::jsonb));
end $$;
revoke all on function public.order_pick_list(uuid) from public, anon, authenticated, service_role;
grant execute on function public.order_pick_list(uuid) to authenticated;

-- A pick: the scanned batch must be the reserved one, from its place; never more than reserved. Another batch is
-- refused here — it is a replacement of the reservation (sales.override_fefo), done by the existing replacement.
create or replace function public.confirm_pick(p_reservation_id uuid, p_batch_id uuid, p_location_id uuid, p_quantity numeric)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  r public.inventory_reservations;
  v_sale public.sales;
  v_balance public.inventory_balances;
  v_picked numeric;
  v_id uuid;
begin
  perform private.require_picking();
  select * into r from public.inventory_reservations where id = p_reservation_id for update;
  if not found or r.status <> 'active' then
    raise exception 'Резерв не найден или уже не действует';
  end if;
  select s.* into v_sale from public.sales s join public.sale_items i on i.sale_id = s.id where i.id = r.sale_item_id;
  if v_sale.status <> 'confirmed' then
    raise exception 'Отбирать можно только подтверждённый заказ';
  end if;
  select * into v_balance from public.inventory_balances where id = r.inventory_balance_id;
  if p_batch_id is distinct from r.batch_id then
    raise exception 'Эта партия не из резерва заказа: возьмите партию %, место %',
      (select batch_number from public.inventory_batches where id = r.batch_id),
      coalesce((select code from public.warehouse_locations where id = v_balance.warehouse_location_id), 'без зоны');
  end if;
  if p_location_id is distinct from v_balance.warehouse_location_id then
    raise exception 'Партия зарезервирована на месте %', coalesce((select code from public.warehouse_locations where id = v_balance.warehouse_location_id), 'без зоны');
  end if;
  select coalesce(sum(quantity), 0) into v_picked from public.sale_picks where reservation_id = r.id;
  if p_quantity is null or p_quantity <= 0 or round(p_quantity, 3) <> p_quantity or v_picked + p_quantity > r.quantity then
    raise exception 'Отобрать можно не больше резерва: осталось %', trim_scale(r.quantity - v_picked);
  end if;
  insert into public.sale_picks(reservation_id, sale_id, batch_id, location_id, quantity, picked_by)
  values (r.id, v_sale.id, p_batch_id, p_location_id, p_quantity, auth.uid())
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.confirm_pick(uuid, uuid, uuid, numeric) from public, anon, authenticated, service_role;
grant execute on function public.confirm_pick(uuid, uuid, uuid, numeric) to authenticated;

-- Shipping a picked order: every active reservation fully picked, then the existing fulfillment (its rights and checks).
create or replace function public.ship_picked_order(p_sale_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_missing integer;
begin
  perform private.require_picking();
  perform 1 from public.sales where id = p_sale_id for update;
  if not found then
    raise exception 'Заказ не найден';
  end if;
  select count(*) into v_missing
    from public.inventory_reservations r
    join public.sale_items i on i.id = r.sale_item_id
   where i.sale_id = p_sale_id and r.status = 'active'
     and coalesce((select sum(x.quantity) from public.sale_picks x where x.reservation_id = r.id), 0) < r.quantity;
  if v_missing > 0 then
    raise exception 'Не всё отобрано: строк осталось %', v_missing;
  end if;
  return public.fulfill_customer_order(p_sale_id);
end $$;
revoke all on function public.ship_picked_order(uuid) from public, anon, authenticated, service_role;
grant execute on function public.ship_picked_order(uuid) to authenticated;

commit;
