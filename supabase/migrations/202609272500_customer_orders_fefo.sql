-- Phase 4A: customer orders, FEFO reservations and shelf-life guarantees.

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  sale_number text not null unique,
  customer_id uuid not null references public.counterparties(id) on delete restrict,
  contract_id uuid references public.contracts(id) on delete set null,
  warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  sale_date date not null default current_date,
  planned_shipment_date date not null,
  currency_id uuid references public.currencies(id) on delete restrict,
  status text not null default 'draft' check (status in ('draft','reserved','confirmed','shipped','cancelled')),
  notes text,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  confirmed_by uuid references public.profiles(id) on delete restrict,
  confirmed_at timestamptz,
  cancelled_by uuid references public.profiles(id) on delete restrict,
  cancelled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (planned_shipment_date >= sale_date)
);

create table if not exists public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  quantity numeric(14,3) not null check (quantity > 0),
  uom text not null check (uom in ('piece','box','layer','pallet','truck')),
  unit_price numeric(14,4) check (unit_price is null or unit_price >= 0),
  required_shelf_life_pct numeric(5,2) check (required_shelf_life_pct is null or required_shelf_life_pct between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(sale_id, product_id, uom)
);

create table if not exists public.inventory_reservations (
  id uuid primary key default gen_random_uuid(),
  sale_item_id uuid not null references public.sale_items(id) on delete restrict,
  inventory_balance_id uuid not null references public.inventory_balances(id) on delete restrict,
  batch_id uuid not null references public.inventory_batches(id) on delete restrict,
  quantity numeric(14,3) not null check (quantity > 0),
  remaining_shelf_life_pct numeric(5,2) not null check (remaining_shelf_life_pct between 0 and 100),
  status text not null default 'active' check (status in ('active','fulfilled','cancelled')),
  is_fefo_override boolean not null default false,
  override_reason text,
  override_approved_by uuid references public.profiles(id) on delete restrict,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not is_fefo_override or (nullif(trim(override_reason),'') is not null and override_approved_by is not null))
);
create unique index if not exists inventory_reservations_active_balance_item
  on public.inventory_reservations(sale_item_id,inventory_balance_id) where status='active';

create table if not exists public.guarantee_letters (
  id uuid primary key default gen_random_uuid(),
  letter_number text not null unique,
  customer_id uuid not null references public.counterparties(id) on delete restrict,
  sale_id uuid not null references public.sales(id) on delete restrict,
  reason text not null default 'low_shelf_life' check (reason in ('low_shelf_life','other')),
  status text not null default 'draft' check (status in ('draft','approved','sent','accepted','rejected','cancelled')),
  notes text,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  approved_by uuid references public.profiles(id) on delete restrict,
  approved_at timestamptz,
  sent_at timestamptz,
  customer_decision_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(sale_id, reason)
);

create table if not exists public.guarantee_letter_items (
  id uuid primary key default gen_random_uuid(),
  guarantee_letter_id uuid not null references public.guarantee_letters(id) on delete restrict,
  sale_item_id uuid not null references public.sale_items(id) on delete restrict,
  batch_id uuid not null references public.inventory_batches(id) on delete restrict,
  quantity numeric(14,3) not null check (quantity > 0),
  remaining_shelf_life_pct numeric(5,2) not null,
  required_shelf_life_pct numeric(5,2) not null,
  unique(guarantee_letter_id,sale_item_id,batch_id)
);

create index if not exists sales_customer_date_idx on public.sales(customer_id,planned_shipment_date desc);
create index if not exists reservations_item_status_idx on public.inventory_reservations(sale_item_id,status);
create index if not exists guarantees_sale_status_idx on public.guarantee_letters(sale_id,status);

insert into public.permissions(code,module,action,name,description) values
  ('sales.view','sales','view','Клиентские заказы: просмотр','Просмотр заказов, строк и резервов'),
  ('sales.manage','sales','manage','Клиентские заказы: управление','Создание и изменение клиентских заказов'),
  ('sales.reserve','sales','reserve','Клиентские заказы: резерв','Резервирование остатков по FEFO'),
  ('sales.override_fefo','sales','override_fefo','Клиентские заказы: отклонение от FEFO','Ручной выбор партии с обязательной причиной'),
  ('guarantee_letters.manage','guarantee_letters','manage','Гарантийные письма: управление','Создание и изменение гарантийных писем')
on conflict (code) do update set name=excluded.name,description=excluded.description;

insert into public.role_permissions(role_id,permission_id,granted)
select role.id,permission.id,true from public.app_roles role cross join public.permissions permission
where permission.module in ('sales','guarantee_letters') and (
  role.code in ('administrator','director','executive_director','commercial_director')
  or (role.code in ('logistics_director','senior_logistics_manager') and permission.code in ('sales.view','sales.reserve','guarantee_letters.manage'))
  or (role.code in ('logistics_specialist','accountant') and permission.code='sales.view')
)
on conflict (role_id,permission_id) do update set granted=excluded.granted;

alter table public.sales enable row level security;
alter table public.sale_items enable row level security;
alter table public.inventory_reservations enable row level security;
alter table public.guarantee_letters enable row level security;
alter table public.guarantee_letter_items enable row level security;

revoke all on public.sales,public.sale_items,public.inventory_reservations,public.guarantee_letters,public.guarantee_letter_items from anon,authenticated;
grant select on public.sales,public.sale_items,public.inventory_reservations,public.guarantee_letters,public.guarantee_letter_items to authenticated;

drop policy if exists "employees view sales" on public.sales;
create policy "employees view sales" on public.sales for select to authenticated using ((select private.has_permission('sales.view')));
drop policy if exists "employees view sale items" on public.sale_items;
create policy "employees view sale items" on public.sale_items for select to authenticated using ((select private.has_permission('sales.view')));
drop policy if exists "employees view reservations" on public.inventory_reservations;
create policy "employees view reservations" on public.inventory_reservations for select to authenticated using ((select private.has_permission('sales.view')));
drop policy if exists "employees view guarantees" on public.guarantee_letters;
create policy "employees view guarantees" on public.guarantee_letters for select to authenticated using ((select private.has_permission('sales.view')));
drop policy if exists "employees view guarantee items" on public.guarantee_letter_items;
create policy "employees view guarantee items" on public.guarantee_letter_items for select to authenticated using ((select private.has_permission('sales.view')));

create or replace function private.sale_shelf_life_pct(p_expiry date,p_manufacture date,p_shelf_days integer,p_on_date date)
returns numeric language sql immutable set search_path='' as $$
  select round(least(100,greatest(0,100 * (p_expiry-p_on_date)::numeric /
    greatest(1,case when p_manufacture is not null then p_expiry-p_manufacture else coalesce(p_shelf_days,1) end))),2)
$$;

create sequence if not exists public.sale_number_seq;
create sequence if not exists public.guarantee_letter_number_seq;
revoke all on sequence public.sale_number_seq,public.guarantee_letter_number_seq from public,anon,authenticated;

create or replace function public.create_customer_order(p_customer_id uuid,p_contract_id uuid,p_warehouse_id uuid,p_planned_shipment_date date,p_currency_id uuid,p_notes text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_number text;
begin
  if not (select private.has_permission('sales.manage')) then raise exception 'Нет права создавать клиентские заказы'; end if;
  if p_planned_shipment_date is null or p_planned_shipment_date<current_date then raise exception 'Дата отгрузки не может быть в прошлом'; end if;
  if not exists(select 1 from public.counterparties where id=p_customer_id and 'customer'=any(roles) and status='active') then raise exception 'Активный клиент не найден'; end if;
  if not exists(select 1 from public.warehouses where id=p_warehouse_id and status='active' and not is_virtual) then raise exception 'Активный склад не найден'; end if;
  if p_contract_id is not null and not exists(select 1 from public.contracts where id=p_contract_id and counterparty_id=p_customer_id and status='active') then raise exception 'Контракт не относится к клиенту или не активен'; end if;
  v_number:=format('SO-%s-%s',extract(year from current_date)::int,lpad(nextval('public.sale_number_seq')::text,6,'0'));
  insert into public.sales(sale_number,customer_id,contract_id,warehouse_id,planned_shipment_date,currency_id,notes)
  values(v_number,p_customer_id,p_contract_id,p_warehouse_id,p_planned_shipment_date,p_currency_id,nullif(trim(p_notes),'')) returning id into v_id;
  return v_id;
end $$;

create or replace function public.add_customer_order_item(p_sale_id uuid,p_product_id uuid,p_quantity numeric,p_uom text,p_unit_price numeric,p_required_shelf_life_pct numeric)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_customer uuid; v_required numeric;
begin
  if not (select private.has_permission('sales.manage')) then raise exception 'Нет права изменять клиентские заказы'; end if;
  select customer_id into v_customer from public.sales where id=p_sale_id and status='draft' for update;
  if not found then raise exception 'Изменять позиции можно только в черновике заказа'; end if;
  if p_quantity is null or p_quantity<=0 then raise exception 'Количество должно быть больше нуля'; end if;
  if p_uom not in ('piece','box','layer','pallet','truck') then raise exception 'Некорректная единица измерения'; end if;
  select coalesce(p_required_shelf_life_pct,min_remaining_shelf_life_pct) into v_required from public.counterparties where id=v_customer;
  if v_required is not null and (v_required<0 or v_required>100) then raise exception 'Требование ОСГ должно быть от 0 до 100 процентов'; end if;
  insert into public.sale_items(sale_id,product_id,quantity,uom,unit_price,required_shelf_life_pct)
  values(p_sale_id,p_product_id,p_quantity,p_uom,p_unit_price,v_required) returning id into v_id;
  return v_id;
end $$;

create or replace function private.release_sale_item_reservations(p_item_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare r record;
begin
  for r in select id,inventory_balance_id,quantity from public.inventory_reservations where sale_item_id=p_item_id and status='active' for update loop
    update public.inventory_balances set quantity_reserved=quantity_reserved-r.quantity,updated_at=now() where id=r.inventory_balance_id;
    update public.inventory_reservations set status='cancelled',updated_at=now() where id=r.id;
  end loop;
end $$;

create or replace function public.reserve_customer_order_item_fefo(p_sale_item_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_item record; v_remaining numeric; v_take numeric; v_pct numeric; v_result jsonb='[]'::jsonb; b record;
begin
  if not (select private.has_permission('sales.reserve')) then raise exception 'Нет права резервировать товар'; end if;
  select i.*,s.warehouse_id,s.planned_shipment_date,s.status as sale_status,p.shelf_life_days into v_item
  from public.sale_items i join public.sales s on s.id=i.sale_id join public.products p on p.id=i.product_id
  where i.id=p_sale_item_id for update of i,s;
  if not found or v_item.sale_status not in ('draft','reserved') then raise exception 'Заказ недоступен для резервирования'; end if;
  if exists(select 1 from public.guarantee_letters where sale_id=v_item.sale_id and status in ('approved','sent','accepted')) then
    raise exception 'Нельзя менять партии после утверждения гарантийного письма';
  end if;
  delete from public.guarantee_letter_items where guarantee_letter_id in
    (select id from public.guarantee_letters where sale_id=v_item.sale_id and status='draft');
  perform private.release_sale_item_reservations(p_sale_item_id);
  v_remaining:=v_item.quantity;
  for b in
    select balance.*,batch.batch_number,batch.expiry_date,batch.manufacture_date
    from public.inventory_balances balance join public.inventory_batches batch on batch.id=balance.batch_id
    where batch.product_id=v_item.product_id and balance.warehouse_id=v_item.warehouse_id and balance.uom=v_item.uom
      and batch.status='available' and batch.expiry_date>=v_item.planned_shipment_date
      and balance.quantity_on_hand>balance.quantity_reserved
    order by batch.expiry_date,batch.received_at,batch.id for update of balance
  loop
    exit when v_remaining<=0;
    v_take:=least(v_remaining,b.quantity_on_hand-b.quantity_reserved);
    v_pct:=private.sale_shelf_life_pct(b.expiry_date,b.manufacture_date,v_item.shelf_life_days,v_item.planned_shipment_date);
    update public.inventory_balances set quantity_reserved=quantity_reserved+v_take,updated_at=now() where id=b.id;
    insert into public.inventory_reservations(sale_item_id,inventory_balance_id,batch_id,quantity,remaining_shelf_life_pct)
    values(p_sale_item_id,b.id,b.batch_id,v_take,v_pct);
    v_result:=v_result||jsonb_build_array(jsonb_build_object('batch_id',b.batch_id,'batch_number',b.batch_number,'quantity',v_take,'remaining_shelf_life_pct',v_pct));
    v_remaining:=v_remaining-v_take;
  end loop;
  if v_remaining>0 then raise exception 'Недостаточный доступный остаток: не хватает %',v_remaining; end if;
  update public.sales s set status=case when not exists(
    select 1 from public.sale_items i where i.sale_id=s.id and i.quantity<>(select coalesce(sum(r.quantity),0) from public.inventory_reservations r where r.sale_item_id=i.id and r.status='active')
  ) then 'reserved' else 'draft' end,updated_at=now() where id=v_item.sale_id;
  return v_result;
end $$;

create or replace function public.reserve_customer_order_item_override(p_sale_item_id uuid,p_inventory_balance_id uuid,p_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_item record; v_balance record; v_pct numeric; v_id uuid;
begin
  if not (select private.has_permission('sales.override_fefo')) then raise exception 'Нет права отклоняться от FEFO'; end if;
  if nullif(trim(p_reason),'') is null then raise exception 'Укажите причину отклонения от FEFO'; end if;
  select i.*,s.warehouse_id,s.planned_shipment_date,s.status as sale_status,p.shelf_life_days into v_item
  from public.sale_items i join public.sales s on s.id=i.sale_id join public.products p on p.id=i.product_id where i.id=p_sale_item_id for update of i,s;
  if not found or v_item.sale_status not in ('draft','reserved') then raise exception 'Заказ недоступен для резервирования'; end if;
  if exists(select 1 from public.guarantee_letters where sale_id=v_item.sale_id and status in ('approved','sent','accepted')) then
    raise exception 'Нельзя менять партии после утверждения гарантийного письма';
  end if;
  select balance.*,batch.product_id,batch.expiry_date,batch.manufacture_date,batch.status as batch_status into v_balance
  from public.inventory_balances balance join public.inventory_batches batch on batch.id=balance.batch_id where balance.id=p_inventory_balance_id for update of balance;
  if not found or v_balance.product_id<>v_item.product_id or v_balance.warehouse_id<>v_item.warehouse_id or v_balance.uom<>v_item.uom then raise exception 'Остаток не соответствует позиции заказа'; end if;
  if v_balance.batch_status<>'available' or v_balance.expiry_date<v_item.planned_shipment_date then raise exception 'Партию нельзя резервировать на дату отгрузки'; end if;
  delete from public.guarantee_letter_items where guarantee_letter_id in
    (select id from public.guarantee_letters where sale_id=v_item.sale_id and status='draft');
  perform private.release_sale_item_reservations(p_sale_item_id);
  if v_balance.quantity_on_hand-v_balance.quantity_reserved<v_item.quantity then raise exception 'В выбранной партии недостаточно доступного остатка'; end if;
  v_pct:=private.sale_shelf_life_pct(v_balance.expiry_date,v_balance.manufacture_date,v_item.shelf_life_days,v_item.planned_shipment_date);
  update public.inventory_balances set quantity_reserved=quantity_reserved+v_item.quantity,updated_at=now() where id=v_balance.id;
  insert into public.inventory_reservations(sale_item_id,inventory_balance_id,batch_id,quantity,remaining_shelf_life_pct,is_fefo_override,override_reason,override_approved_by)
  values(p_sale_item_id,v_balance.id,v_balance.batch_id,v_item.quantity,v_pct,true,trim(p_reason),auth.uid()) returning id into v_id;
  update public.sales set status='reserved',updated_at=now() where id=v_item.sale_id and not exists(
    select 1 from public.sale_items i where i.sale_id=v_item.sale_id and i.id<>p_sale_item_id and i.quantity<>(select coalesce(sum(r.quantity),0) from public.inventory_reservations r where r.sale_item_id=i.id and r.status='active'));
  return v_id;
end $$;

create or replace function public.create_sale_guarantee_letter(p_sale_id uuid,p_notes text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_sale record; v_id uuid; v_number text;
begin
  if not (select private.has_permission('guarantee_letters.manage')) then raise exception 'Нет права создавать гарантийные письма'; end if;
  select * into v_sale from public.sales where id=p_sale_id and status in ('reserved','draft') for update;
  if not found then raise exception 'Заказ недоступен для гарантийного письма'; end if;
  if exists(select 1 from public.guarantee_letters where sale_id=p_sale_id and reason='low_shelf_life' and status<>'draft') then
    raise exception 'Уже существует зафиксированное гарантийное письмо для этого заказа';
  end if;
  if not exists(select 1 from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id where i.sale_id=p_sale_id and r.status='active' and i.required_shelf_life_pct is not null and r.remaining_shelf_life_pct<i.required_shelf_life_pct) then raise exception 'В заказе нет партий с ОСГ ниже требования клиента'; end if;
  v_number:=format('GL-%s-%s',extract(year from current_date)::int,lpad(nextval('public.guarantee_letter_number_seq')::text,6,'0'));
  insert into public.guarantee_letters(letter_number,customer_id,sale_id,notes) values(v_number,v_sale.customer_id,p_sale_id,nullif(trim(p_notes),''))
  on conflict(sale_id,reason) do update set notes=excluded.notes,updated_at=now() returning id into v_id;
  delete from public.guarantee_letter_items where guarantee_letter_id=v_id;
  insert into public.guarantee_letter_items(guarantee_letter_id,sale_item_id,batch_id,quantity,remaining_shelf_life_pct,required_shelf_life_pct)
  select v_id,i.id,r.batch_id,r.quantity,r.remaining_shelf_life_pct,i.required_shelf_life_pct
  from public.sale_items i join public.inventory_reservations r on r.sale_item_id=i.id and r.status='active'
  where i.sale_id=p_sale_id and i.required_shelf_life_pct is not null and r.remaining_shelf_life_pct<i.required_shelf_life_pct;
  return v_id;
end $$;

create or replace function public.change_sale_guarantee_status(p_letter_id uuid,p_status text)
returns void language plpgsql security definer set search_path='' as $$
declare v_old text;
begin
  if not (select private.has_permission('guarantee_letters.manage')) then raise exception 'Нет права изменять гарантийные письма'; end if;
  select status into v_old from public.guarantee_letters where id=p_letter_id for update;
  if not found then raise exception 'Гарантийное письмо не найдено'; end if;
  if (v_old='draft' and p_status<>'approved') or (v_old='approved' and p_status not in ('sent','cancelled')) or (v_old='sent' and p_status not in ('accepted','rejected')) then raise exception 'Недопустимый переход статуса гарантийного письма'; end if;
  update public.guarantee_letters set status=p_status,
    approved_by=case when p_status='approved' then auth.uid() else approved_by end,
    approved_at=case when p_status='approved' then now() else approved_at end,
    sent_at=case when p_status='sent' then now() else sent_at end,
    customer_decision_at=case when p_status in ('accepted','rejected') then now() else customer_decision_at end,updated_at=now()
  where id=p_letter_id;
end $$;

create or replace function public.confirm_customer_order(p_sale_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not (select private.has_permission('sales.manage')) then raise exception 'Нет права подтверждать клиентские заказы'; end if;
  perform 1 from public.sales where id=p_sale_id and status='reserved' for update;
  if not found then raise exception 'Полностью зарезервируйте заказ перед подтверждением'; end if;
  if exists(
    select 1 from public.sale_items i join public.inventory_reservations r on r.sale_item_id=i.id and r.status='active'
    where i.sale_id=p_sale_id and i.required_shelf_life_pct is not null and r.remaining_shelf_life_pct<i.required_shelf_life_pct
      and not exists(
        select 1 from public.guarantee_letters g join public.guarantee_letter_items gi on gi.guarantee_letter_id=g.id
        where g.sale_id=p_sale_id and g.status in ('approved','sent','accepted') and gi.sale_item_id=i.id
          and gi.batch_id=r.batch_id and gi.quantity=r.quantity
          and gi.remaining_shelf_life_pct=r.remaining_shelf_life_pct and gi.required_shelf_life_pct=i.required_shelf_life_pct
      )
  ) then raise exception 'ОСГ ниже требования клиента: требуется утверждённое гарантийное письмо на текущие партии'; end if;
  update public.sales set status='confirmed',confirmed_by=auth.uid(),confirmed_at=now(),updated_at=now() where id=p_sale_id;
end $$;

create or replace function public.cancel_customer_order(p_sale_id uuid,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare i record;
begin
  if not (select private.has_permission('sales.manage')) then raise exception 'Нет права отменять клиентские заказы'; end if;
  if nullif(trim(p_reason),'') is null then raise exception 'Укажите причину отмены'; end if;
  perform 1 from public.sales where id=p_sale_id and status in ('draft','reserved','confirmed') for update;
  if not found then raise exception 'Заказ нельзя отменить'; end if;
  for i in select id from public.sale_items where sale_id=p_sale_id loop perform private.release_sale_item_reservations(i.id); end loop;
  update public.sales set status='cancelled',cancelled_by=auth.uid(),cancelled_at=now(),cancellation_reason=trim(p_reason),updated_at=now() where id=p_sale_id;
end $$;

do $$ declare f text; begin
  foreach f in array array[
    'public.create_customer_order(uuid,uuid,uuid,date,uuid,text)','public.add_customer_order_item(uuid,uuid,numeric,text,numeric,numeric)',
    'public.reserve_customer_order_item_fefo(uuid)','public.reserve_customer_order_item_override(uuid,uuid,text)',
    'public.create_sale_guarantee_letter(uuid,text)','public.change_sale_guarantee_status(uuid,text)',
    'public.confirm_customer_order(uuid)','public.cancel_customer_order(uuid,text)',
    'private.sale_shelf_life_pct(date,date,integer,date)','private.release_sale_item_reservations(uuid)'
  ] loop execute format('revoke all on function %s from public,anon,authenticated,service_role',f); end loop;
end $$;
grant execute on function public.create_customer_order(uuid,uuid,uuid,date,uuid,text),public.add_customer_order_item(uuid,uuid,numeric,text,numeric,numeric),public.reserve_customer_order_item_fefo(uuid),public.reserve_customer_order_item_override(uuid,uuid,text),public.create_sale_guarantee_letter(uuid,text),public.change_sale_guarantee_status(uuid,text),public.confirm_customer_order(uuid),public.cancel_customer_order(uuid,text) to authenticated;

do $$ declare t text; begin
  foreach t in array array['sales','sale_items','inventory_reservations','guarantee_letters','guarantee_letter_items'] loop
    execute format('drop trigger if exists audit_%I_changes on public.%I',t,t);
    execute format('create trigger audit_%I_changes after insert or update on public.%I for each row execute function private.write_access_audit()',t,t);
  end loop;
end $$;

comment on table public.sales is 'Customer orders with FEFO reservations and shelf-life control';
comment on table public.inventory_reservations is 'Batch-level stock reservations; cancellation restores available stock';
comment on table public.guarantee_letters is 'Customer guarantees for stock below the required remaining shelf life';
