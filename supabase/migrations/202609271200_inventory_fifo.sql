-- Phase 2B: batch traceability, warehouse balances and mandatory FIFO issues.

create table if not exists public.inventory_batches (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete restrict,
  source_shipment_item_id uuid references public.shipment_items(id) on delete set null,
  batch_number text not null check (length(trim(batch_number)) > 0),
  manufacture_date date,
  expiry_date date not null,
  received_at timestamptz not null default now(),
  status text not null default 'available' check (status in ('available','quarantine','blocked','depleted')),
  notes text,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (manufacture_date is null or manufacture_date <= expiry_date),
  unique(product_id, batch_number, expiry_date)
);

create table if not exists public.inventory_balances (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.inventory_batches(id) on delete restrict,
  warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  warehouse_location_id uuid references public.warehouse_locations(id) on delete restrict,
  uom text not null check (uom in ('piece','box','layer','pallet','truck')),
  quantity_on_hand numeric(14,3) not null default 0 check (quantity_on_hand >= 0),
  quantity_reserved numeric(14,3) not null default 0 check (quantity_reserved >= 0 and quantity_reserved <= quantity_on_hand),
  updated_at timestamptz not null default now()
);
create unique index if not exists inventory_balances_unique_location
  on public.inventory_balances(batch_id, warehouse_id, coalesce(warehouse_location_id,'00000000-0000-0000-0000-000000000000'::uuid), uom);

create table if not exists public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.inventory_batches(id) on delete restrict,
  movement_type text not null check (movement_type in ('receipt','transfer','issue','write_off','adjustment')),
  quantity numeric(14,3) not null check (quantity > 0),
  uom text not null check (uom in ('piece','box','layer','pallet','truck')),
  from_warehouse_id uuid references public.warehouses(id) on delete restrict,
  from_location_id uuid references public.warehouse_locations(id) on delete restrict,
  to_warehouse_id uuid references public.warehouses(id) on delete restrict,
  to_location_id uuid references public.warehouse_locations(id) on delete restrict,
  shipment_id uuid references public.shipments(id) on delete set null,
  shipment_item_id uuid references public.shipment_items(id) on delete set null,
  reference text,
  reason text,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (from_warehouse_id is not null or to_warehouse_id is not null)
);

create index if not exists inventory_batches_expiry_idx on public.inventory_batches(product_id, expiry_date);
create index if not exists inventory_balances_fifo_idx on public.inventory_balances(warehouse_id, batch_id) where quantity_on_hand > quantity_reserved;
create index if not exists inventory_movements_batch_created_idx on public.inventory_movements(batch_id, created_at desc);

create or replace view public.inventory_fifo_status with (security_invoker=true) as
select
  balance.id as balance_id,
  batch.id as batch_id,
  batch.batch_number,
  batch.manufacture_date,
  batch.expiry_date,
  batch.received_at,
  batch.status as batch_status,
  product.id as product_id,
  product.internal_sku,
  product.name as product_name,
  product.brand,
  warehouse.id as warehouse_id,
  warehouse.code as warehouse_code,
  warehouse.name as warehouse_name,
  location.id as location_id,
  location.code as location_code,
  balance.uom,
  balance.quantity_on_hand,
  balance.quantity_reserved,
  balance.quantity_on_hand - balance.quantity_reserved as quantity_available,
  batch.expiry_date - current_date as days_remaining,
  case
    when batch.manufacture_date is null then null
    else round(least(100, greatest(0,
      100 * (batch.expiry_date - current_date)::numeric /
      greatest(1, batch.expiry_date - batch.manufacture_date)
    )), 1)
  end as shelf_life_percent,
  case
    when batch.status in ('quarantine','blocked') then batch.status
    when batch.expiry_date < current_date then 'expired'
    when batch.expiry_date <= current_date + 30 then 'critical'
    when batch.expiry_date <= current_date + 90 then 'warning'
    else 'normal'
  end as shelf_life_state,
  case when batch.status='available' and batch.expiry_date>=current_date and balance.quantity_on_hand>balance.quantity_reserved then
    sum(case when batch.status='available' and batch.expiry_date>=current_date and balance.quantity_on_hand>balance.quantity_reserved then 1 else 0 end) over (
      partition by product.id, warehouse.id, balance.uom
      order by batch.expiry_date, batch.received_at, batch.id
    )
  end as fifo_rank
from public.inventory_balances balance
join public.inventory_batches batch on batch.id=balance.batch_id
join public.products product on product.id=batch.product_id
join public.warehouses warehouse on warehouse.id=balance.warehouse_id
left join public.warehouse_locations location on location.id=balance.warehouse_location_id
where balance.quantity_on_hand > 0;

insert into public.permissions(code,module,action,name,description) values
  ('inventory.view','inventory','view','Остатки: просмотр','Просмотр партий, сроков годности и складских остатков'),
  ('inventory.receive','inventory','receive','Остатки: приёмка','Регистрация партий при приёмке товара'),
  ('inventory.move','inventory','move','Остатки: движение','Списание и перемещение товара по FIFO'),
  ('inventory.write_off','inventory','write_off','Остатки: списание','Списание брака и просроченного товара')
on conflict (code) do update set name=excluded.name,description=excluded.description;

insert into public.role_permissions(role_id,permission_id,granted)
select role.id,permission.id,true
from public.app_roles role cross join public.permissions permission
where permission.module='inventory' and (
  role.code in ('administrator','director','executive_director','logistics_director','senior_logistics_manager')
  or (role.code='logistics_specialist' and permission.action in ('view','receive','move'))
  or (role.code in ('commercial_director','accountant') and permission.action='view')
)
on conflict (role_id,permission_id) do update set granted=excluded.granted;

alter table public.inventory_batches enable row level security;
alter table public.inventory_balances enable row level security;
alter table public.inventory_movements enable row level security;
revoke all on public.inventory_batches,public.inventory_balances,public.inventory_movements from anon,authenticated;
grant select on public.inventory_batches,public.inventory_balances,public.inventory_movements to authenticated;
grant select on public.inventory_fifo_status to authenticated;

drop policy if exists "employees view inventory batches" on public.inventory_batches;
create policy "employees view inventory batches" on public.inventory_batches for select to authenticated
  using ((select private.has_permission('inventory.view')));
drop policy if exists "employees view inventory balances" on public.inventory_balances;
create policy "employees view inventory balances" on public.inventory_balances for select to authenticated
  using ((select private.has_permission('inventory.view')));
drop policy if exists "employees view inventory movements" on public.inventory_movements;
create policy "employees view inventory movements" on public.inventory_movements for select to authenticated
  using ((select private.has_permission('inventory.view')));

create or replace function public.receive_inventory_batch(
  p_shipment_item_id uuid,
  p_warehouse_id uuid,
  p_location_id uuid,
  p_batch_number text,
  p_manufacture_date date,
  p_expiry_date date,
  p_quantity numeric,
  p_notes text default null
) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  v_item record;
  v_batch_id uuid;
  v_balance_id uuid;
begin
  if not (select private.has_permission('inventory.receive')) then
    raise exception 'Недостаточно прав для регистрации партии';
  end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Количество должно быть больше нуля'; end if;
  if nullif(trim(p_batch_number),'') is null then raise exception 'Укажите номер партии'; end if;
  if p_expiry_date is null then raise exception 'Укажите срок годности'; end if;
  if p_manufacture_date is not null and p_manufacture_date > p_expiry_date then raise exception 'Дата производства позже срока годности'; end if;

  select item.product_id,item.uom,item.shipment_id,shipment.destination_warehouse_id
  into v_item
  from public.shipment_items item
  join public.shipments shipment on shipment.id=item.shipment_id
  where item.id=p_shipment_item_id;
  if not found then raise exception 'Позиция поставки не найдена'; end if;
  if v_item.destination_warehouse_id <> p_warehouse_id then raise exception 'Выбранный склад не совпадает со складом поставки'; end if;
  if p_location_id is not null and not exists(
    select 1 from public.warehouse_locations where id=p_location_id and warehouse_id=p_warehouse_id and status='active'
  ) then raise exception 'Зона не относится к выбранному складу'; end if;

  insert into public.inventory_batches(product_id,source_shipment_item_id,batch_number,manufacture_date,expiry_date,notes)
  values(v_item.product_id,p_shipment_item_id,trim(p_batch_number),p_manufacture_date,p_expiry_date,nullif(trim(p_notes),''))
  on conflict(product_id,batch_number,expiry_date) do update set
    source_shipment_item_id=coalesce(public.inventory_batches.source_shipment_item_id,excluded.source_shipment_item_id),
    manufacture_date=coalesce(public.inventory_batches.manufacture_date,excluded.manufacture_date),
    updated_at=now()
  returning id into v_batch_id;

  select id into v_balance_id from public.inventory_balances
  where batch_id=v_batch_id and warehouse_id=p_warehouse_id
    and warehouse_location_id is not distinct from p_location_id and uom=v_item.uom
  for update;
  if v_balance_id is null then
    insert into public.inventory_balances(batch_id,warehouse_id,warehouse_location_id,uom,quantity_on_hand)
    values(v_batch_id,p_warehouse_id,p_location_id,v_item.uom,p_quantity);
  else
    update public.inventory_balances set quantity_on_hand=quantity_on_hand+p_quantity,updated_at=now() where id=v_balance_id;
  end if;

  insert into public.inventory_movements(batch_id,movement_type,quantity,uom,to_warehouse_id,to_location_id,shipment_id,shipment_item_id,reference,reason)
  values(v_batch_id,'receipt',p_quantity,v_item.uom,p_warehouse_id,p_location_id,v_item.shipment_id,p_shipment_item_id,'Приёмка поставки',nullif(trim(p_notes),''));
  return v_batch_id;
end $$;

create or replace function public.issue_inventory_fifo(
  p_product_id uuid,
  p_warehouse_id uuid,
  p_uom text,
  p_quantity numeric,
  p_reference text,
  p_reason text
) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  v_remaining numeric(14,3):=p_quantity;
  v_take numeric(14,3);
  v_allocations jsonb:='[]'::jsonb;
  item record;
begin
  if not (select private.has_permission('inventory.move')) then raise exception 'Недостаточно прав для списания товара'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Количество должно быть больше нуля'; end if;
  if nullif(trim(p_reason),'') is null then raise exception 'Укажите основание списания'; end if;
  if p_uom not in ('piece','box','layer','pallet','truck') then raise exception 'Некорректная единица измерения'; end if;

  for item in
    select balance.id,balance.batch_id,balance.warehouse_location_id,balance.quantity_on_hand-balance.quantity_reserved as available,
      batch.batch_number,batch.expiry_date
    from public.inventory_balances balance
    join public.inventory_batches batch on batch.id=balance.batch_id
    where batch.product_id=p_product_id and balance.warehouse_id=p_warehouse_id and balance.uom=p_uom
      and batch.status='available' and batch.expiry_date>=current_date
      and balance.quantity_on_hand>balance.quantity_reserved
    order by batch.expiry_date,batch.received_at,batch.id
    for update of balance
  loop
    exit when v_remaining<=0;
    v_take:=least(v_remaining,item.available);
    update public.inventory_balances set quantity_on_hand=quantity_on_hand-v_take,updated_at=now() where id=item.id;
    insert into public.inventory_movements(batch_id,movement_type,quantity,uom,from_warehouse_id,from_location_id,reference,reason)
    values(item.batch_id,'issue',v_take,p_uom,p_warehouse_id,item.warehouse_location_id,nullif(trim(p_reference),''),trim(p_reason));
    v_allocations:=v_allocations||jsonb_build_array(jsonb_build_object('batch_id',item.batch_id,'batch_number',item.batch_number,'expiry_date',item.expiry_date,'quantity',v_take));
    v_remaining:=v_remaining-v_take;
  end loop;
  if v_remaining>0 then raise exception 'Недостаточный доступный остаток: не хватает %',v_remaining; end if;

  update public.inventory_batches batch set status='depleted',updated_at=now()
  where batch.product_id=p_product_id and batch.status='available'
    and not exists(select 1 from public.inventory_balances balance where balance.batch_id=batch.id and balance.quantity_on_hand>0);
  return v_allocations;
end $$;

revoke all on function public.receive_inventory_batch(uuid,uuid,uuid,text,date,date,numeric,text) from public;
revoke all on function public.issue_inventory_fifo(uuid,uuid,text,numeric,text,text) from public;
grant execute on function public.receive_inventory_batch(uuid,uuid,uuid,text,date,date,numeric,text) to authenticated;
grant execute on function public.issue_inventory_fifo(uuid,uuid,text,numeric,text,text) to authenticated;

do $$ declare t text; begin
  foreach t in array array['inventory_batches','inventory_balances','inventory_movements'] loop
    execute format('drop trigger if exists audit_%I_changes on public.%I',t,t);
    execute format('create trigger audit_%I_changes after insert or update on public.%I for each row execute function private.write_access_audit()',t,t);
  end loop;
end $$;

comment on table public.inventory_batches is 'Traceable product batches with manufacture and expiry dates';
comment on table public.inventory_balances is 'Current warehouse quantity by batch and location; writes only through controlled RPC functions';
comment on table public.inventory_movements is 'Append-only stock movement ledger';
comment on function public.issue_inventory_fifo(uuid,uuid,text,numeric,text,text) is 'Atomically issues stock from the earliest non-expired batches first';
