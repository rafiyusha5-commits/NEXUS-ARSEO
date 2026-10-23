-- Returns from customers.
--
-- A return is made against a shipped customer order: which batches, how much, why. Nobody can return more of a
-- batch than was shipped to the customer on that order line. Returned goods stay in quarantine — outside the
-- sellable stock, so they cannot be reserved or sold — until an employee decides for each line:
--   * restock            — back into stock as a «customer_return» movement (rights: inventory.receive);
--   * write_off          — written off, with a reason (inventory.write_off);
--   * return_to_supplier — sent back to the supplier, with a reason (inventory.write_off).
-- Each line keeps the order price, so the return reduces what the customer owes.

insert into public.permissions(code,module,action,name,description) values
  ('sales.returns','sales','returns','Клиентские заказы: возвраты','Оформление возвратов от покупателей по отгруженным заказам')
on conflict (code) do update set name=excluded.name,description=excluded.description;

insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true from public.app_roles r cross join public.permissions p
where p.code='sales.returns' and r.code in ('administrator','director','executive_director','commercial_director','logistics_director','senior_logistics_manager')
on conflict (role_id,permission_id) do nothing;

alter table public.inventory_movements drop constraint if exists inventory_movements_movement_type_check;
alter table public.inventory_movements add constraint inventory_movements_movement_type_check
  check (movement_type in ('receipt','transfer','issue','write_off','adjustment','customer_return'));

create sequence if not exists public.customer_return_number_seq;
revoke all on sequence public.customer_return_number_seq from public, anon, authenticated;

create table if not exists public.customer_returns (
  id uuid primary key default gen_random_uuid(),
  return_number text not null unique,
  sale_id uuid not null references public.sales(id) on delete restrict,
  customer_id uuid not null references public.counterparties(id) on delete restrict,
  warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  status text not null default 'quarantine' check (status in ('quarantine', 'closed', 'cancelled')),
  reason text check (reason is null or length(reason) <= 500),
  received_at timestamptz not null default now(),
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  cancelled_by uuid references public.profiles(id) on delete restrict,
  cancelled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.customer_return_items (
  id uuid primary key default gen_random_uuid(),
  return_id uuid not null references public.customer_returns(id) on delete restrict,
  sale_item_id uuid not null references public.sale_items(id) on delete restrict,
  batch_id uuid not null references public.inventory_batches(id) on delete restrict,
  quantity numeric(14,3) not null check (quantity > 0),
  uom text not null check (uom in ('piece','box','layer','pallet','truck')),
  reason_code text not null check (reason_code in ('defect','damaged','expiry','wrong_item','refused','other')),
  unit_price numeric(14,4) check (unit_price is null or unit_price >= 0),
  decision text check (decision in ('restock','write_off','return_to_supplier')),
  decision_note text check (decision_note is null or length(decision_note) <= 500),
  decided_by uuid references public.profiles(id) on delete restrict,
  decided_at timestamptz,
  warehouse_location_id uuid references public.warehouse_locations(id) on delete restrict,
  inventory_movement_id uuid references public.inventory_movements(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (return_id, sale_item_id, batch_id),
  check ((decision is null) = (decided_by is null and decided_at is null)),
  check (decision is distinct from 'restock' or inventory_movement_id is not null),
  check (decision is null or decision = 'restock' or nullif(btrim(decision_note), '') is not null)
);
create index if not exists customer_returns_sale_idx on public.customer_returns(sale_id);
create index if not exists customer_returns_status_idx on public.customer_returns(status, received_at desc);
create index if not exists customer_return_items_batch_idx on public.customer_return_items(batch_id);

alter table public.customer_returns enable row level security;
alter table public.customer_return_items enable row level security;
revoke all on public.customer_returns, public.customer_return_items from anon, authenticated, service_role;
grant select on public.customer_returns, public.customer_return_items to authenticated;
drop policy if exists "sales users view returns" on public.customer_returns;
create policy "sales users view returns" on public.customer_returns for select to authenticated using ((select private.has_permission('sales.view')));
drop policy if exists "sales users view return items" on public.customer_return_items;
create policy "sales users view return items" on public.customer_return_items for select to authenticated using ((select private.has_permission('sales.view')));

do $$ declare t text; begin
  foreach t in array array['customer_returns','customer_return_items'] loop
    execute format('drop trigger if exists audit_%I_changes on public.%I',t,t);
    execute format('create trigger audit_%I_changes after insert or update on public.%I for each row execute function private.write_access_audit()',t,t);
  end loop;
end $$;

comment on table public.customer_returns is 'Returns from customers against shipped orders; goods stay in quarantine until a decision';
comment on table public.customer_return_items is 'Returned batches of an order line with the decision: restock, write off or return to the supplier';

-- Pieces in one unit of a product (product_packaging.units_per_parent = pieces in one unit of the level).
-- The same definition as in the unit conversion migration; whichever is applied last, the function is identical.
create or replace function private.uom_pieces(p_product_id uuid, p_uom text)
returns numeric language sql stable security definer set search_path = '' as $$
  select case when p_uom = 'piece' then 1::numeric
              else (select pp.units_per_parent from public.product_packaging pp
                    where pp.product_id = p_product_id and pp.uom = p_uom) end
$$;

-- What can still be returned per order line and batch, in the unit of the order line: shipped (fulfilled
-- reservations, converted from the unit of the stock they were taken from) minus returned in active returns.
create or replace function private.customer_return_room(p_sale_id uuid)
returns table (sale_item_id uuid, batch_id uuid, shipped numeric, returned numeric)
language sql stable security definer set search_path = '' as $$
  with shipped as (
    select i.id as sale_item_id, r.batch_id,
           sum(case when b.uom = i.uom then r.quantity
                    else round(r.quantity * private.uom_pieces(i.product_id, b.uom) / nullif(private.uom_pieces(i.product_id, i.uom), 0), 3) end) as quantity
    from public.sale_items i
    join public.inventory_reservations r on r.sale_item_id = i.id and r.status = 'fulfilled'
    join public.inventory_balances b on b.id = r.inventory_balance_id
    where i.sale_id = p_sale_id
    group by i.id, r.batch_id
  ), returned as (
    select ri.sale_item_id, ri.batch_id, sum(ri.quantity) as quantity
    from public.customer_return_items ri join public.customer_returns cr on cr.id = ri.return_id
    where cr.sale_id = p_sale_id and cr.status <> 'cancelled'
    group by ri.sale_item_id, ri.batch_id
  )
  select s.sale_item_id, s.batch_id, coalesce(s.quantity, 0), coalesce(rt.quantity, 0)
  from shipped s left join returned rt on rt.sale_item_id = s.sale_item_id and rt.batch_id = s.batch_id
$$;

-- Lines of a shipped order that can be returned, for the return form.
create or replace function public.customer_return_options(p_sale_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not (select private.has_permission('sales.view')) then
    raise exception 'Нет доступа к клиентским заказам' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'sale_item_id', room.sale_item_id, 'batch_id', room.batch_id, 'batch_number', b.batch_number, 'expiry_date', b.expiry_date,
      'internal_sku', p.internal_sku, 'product_name', coalesce(p.name ->> 'ru', p.name ->> 'en', p.internal_sku), 'uom', i.uom,
      'shipped', room.shipped, 'returned', room.returned, 'available', greatest(room.shipped - room.returned, 0))
      order by p.internal_sku, b.expiry_date)
    from private.customer_return_room(p_sale_id) room
    join public.sale_items i on i.id = room.sale_item_id
    join public.products p on p.id = i.product_id
    join public.inventory_batches b on b.id = room.batch_id), '[]'::jsonb);
end $$;

create or replace function public.create_customer_return(p_sale_id uuid, p_lines jsonb, p_reason text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  s public.sales%rowtype; v_id uuid; v_number text; v_line jsonb; v_item record; v_item_id uuid; v_batch uuid; v_quantity numeric;
  v_room record; v_reason_code text; v_seen text[] := '{}'; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not (select private.has_permission('sales.returns')) or not (select private.has_permission('sales.view')) then
    raise exception 'Недостаточно прав для оформления возврата' using errcode = '42501';
  end if;
  if v_reason is not null and length(v_reason) > 500 then raise exception 'Причина не должна быть длиннее 500 символов'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Укажите хотя бы одну возвращаемую позицию';
  end if;
  select * into s from public.sales where id = p_sale_id for update;
  if not found then raise exception 'Заказ не найден'; end if;
  if s.status <> 'shipped' then raise exception 'Возврат оформляется только по отгруженному заказу'; end if;

  v_number := format('RT-%s-%s', extract(year from current_date)::int, lpad(nextval('public.customer_return_number_seq')::text, 6, '0'));
  insert into public.customer_returns(return_number, sale_id, customer_id, warehouse_id, reason)
  values (v_number, s.id, s.customer_id, s.warehouse_id, v_reason) returning id into v_id;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    begin
      v_batch := (v_line ->> 'batch_id')::uuid;
      v_item_id := (v_line ->> 'sale_item_id')::uuid;
    exception when others then raise exception 'Некорректная позиция возврата'; end;
    select i.id, i.uom, i.unit_price into v_item from public.sale_items i where i.id = v_item_id and i.sale_id = s.id;
    if not found or v_batch is null then raise exception 'Позиция не относится к этому заказу'; end if;
    if (v_item.id || ':' || v_batch) = any(v_seen) then raise exception 'Позиция и партия указаны дважды'; end if;
    v_seen := v_seen || (v_item.id || ':' || v_batch);
    if jsonb_typeof(v_line -> 'quantity') <> 'number' then raise exception 'Количество должно быть числом'; end if;
    v_quantity := (v_line ->> 'quantity')::numeric;
    if v_quantity <= 0 or v_quantity <> round(v_quantity, 3) then
      raise exception 'Количество должно быть больше нуля, не более трёх знаков после запятой';
    end if;
    v_reason_code := coalesce(v_line ->> 'reason_code', 'other');
    if v_reason_code not in ('defect','damaged','expiry','wrong_item','refused','other') then raise exception 'Некорректная причина возврата'; end if;
    select * into v_room from private.customer_return_room(s.id) r where r.sale_item_id = v_item.id and r.batch_id = v_batch;
    if not found then raise exception 'Эта партия не отгружалась по позиции заказа'; end if;
    if v_quantity > v_room.shipped - v_room.returned then
      raise exception 'Нельзя вернуть больше отгруженного: доступно к возврату %', trim_scale(greatest(v_room.shipped - v_room.returned, 0));
    end if;
    insert into public.customer_return_items(return_id, sale_item_id, batch_id, quantity, uom, reason_code, unit_price)
    values (v_id, v_item.id, v_batch, v_quantity, v_item.uom, v_reason_code, v_item.unit_price);
  end loop;
  return v_id;
end $$;

create or replace function public.decide_customer_return_item(p_item_id uuid, p_decision text, p_location_id uuid default null, p_note text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  ri public.customer_return_items%rowtype; cr public.customer_returns%rowtype; v_movement uuid;
  v_note text := nullif(btrim(coalesce(p_note, '')), ''); v_batch_status text;
begin
  if p_decision not in ('restock','write_off','return_to_supplier') then raise exception 'Некорректное решение по возврату'; end if;
  if not (select private.has_permission('sales.view')) or not (select private.has_permission(case p_decision when 'restock' then 'inventory.receive' else 'inventory.write_off' end)) then
    raise exception 'Недостаточно прав для этого решения по возврату' using errcode = '42501';
  end if;
  if v_note is not null and length(v_note) > 500 then raise exception 'Комментарий не должен быть длиннее 500 символов'; end if;
  if p_decision <> 'restock' and v_note is null then raise exception 'Укажите причину списания или возврата поставщику'; end if;
  select * into ri from public.customer_return_items where id = p_item_id for update;
  if not found then raise exception 'Позиция возврата не найдена'; end if;
  select * into cr from public.customer_returns where id = ri.return_id for update;
  if cr.status = 'cancelled' then raise exception 'Возврат отменён'; end if;
  if ri.decision is not null then raise exception 'По этой позиции решение уже принято'; end if;

  if p_decision = 'restock' then
    if p_location_id is not null and not exists (select 1 from public.warehouse_locations l where l.id = p_location_id and l.warehouse_id = cr.warehouse_id and l.status = 'active') then
      raise exception 'Зона не относится к складу возврата или недоступна';
    end if;
    select status into v_batch_status from public.inventory_batches where id = ri.batch_id for update;
    insert into public.inventory_movements(batch_id, movement_type, quantity, uom, to_warehouse_id, to_location_id, reference, reason)
    values (ri.batch_id, 'customer_return', ri.quantity, ri.uom, cr.warehouse_id, p_location_id, cr.return_number,
            coalesce('Возврат от клиента: ' || v_note, 'Возврат от клиента'))
    returning id into v_movement;
    insert into public.inventory_balances(batch_id, warehouse_id, warehouse_location_id, uom, quantity_on_hand)
    values (ri.batch_id, cr.warehouse_id, p_location_id, ri.uom, ri.quantity)
    on conflict (batch_id, warehouse_id, coalesce(warehouse_location_id, '00000000-0000-0000-0000-000000000000'::uuid), uom)
    do update set quantity_on_hand = public.inventory_balances.quantity_on_hand + excluded.quantity_on_hand, updated_at = now();
    -- A batch fully shipped earlier is in stock again; a quarantined or blocked batch keeps its status.
    if v_batch_status = 'depleted' then
      update public.inventory_batches set status = 'available', updated_at = now() where id = ri.batch_id;
    end if;
  end if;

  update public.customer_return_items
  set decision = p_decision, decision_note = v_note, decided_by = (select auth.uid()), decided_at = now(),
      warehouse_location_id = case when p_decision = 'restock' then p_location_id end, inventory_movement_id = v_movement
  where id = ri.id;
  update public.customer_returns set status = 'closed', updated_at = now()
  where id = cr.id and not exists (select 1 from public.customer_return_items x where x.return_id = cr.id and x.decision is null);
end $$;

create or replace function public.cancel_customer_return(p_return_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare cr public.customer_returns%rowtype; v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not (select private.has_permission('sales.returns')) or not (select private.has_permission('sales.view')) then
    raise exception 'Недостаточно прав для отмены возврата' using errcode = '42501';
  end if;
  if v_reason is null then raise exception 'Укажите причину отмены'; end if;
  if length(v_reason) > 500 then raise exception 'Причина не должна быть длиннее 500 символов'; end if;
  select * into cr from public.customer_returns where id = p_return_id for update;
  if not found then raise exception 'Возврат не найден'; end if;
  if cr.status = 'cancelled' then raise exception 'Возврат уже отменён'; end if;
  if exists (select 1 from public.customer_return_items where return_id = cr.id and decision is not null) then
    raise exception 'По возврату уже приняты решения: отменить его нельзя';
  end if;
  update public.customer_returns set status = 'cancelled', cancelled_by = (select auth.uid()), cancelled_at = now(),
    cancellation_reason = v_reason, updated_at = now() where id = cr.id;
end $$;

do $$ declare f text; begin
  foreach f in array array['private.uom_pieces(uuid,text)','private.customer_return_room(uuid)'] loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role', f);
  end loop;
end $$;
revoke all on function public.customer_return_options(uuid) from public, anon, service_role;
revoke all on function public.create_customer_return(uuid, jsonb, text) from public, anon, service_role;
revoke all on function public.decide_customer_return_item(uuid, text, uuid, text) from public, anon, service_role;
revoke all on function public.cancel_customer_return(uuid, text) from public, anon, service_role;
grant execute on function public.customer_return_options(uuid), public.create_customer_return(uuid, jsonb, text),
  public.decide_customer_return_item(uuid, text, uuid, text), public.cancel_customer_return(uuid, text) to authenticated;
