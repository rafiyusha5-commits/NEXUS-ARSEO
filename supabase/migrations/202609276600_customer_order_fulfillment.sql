-- Full-order fulfillment only. No new role grants and no service_role business access.
alter table public.sales
  add column if not exists shipped_at timestamptz,
  add column if not exists shipped_by uuid references public.profiles(id) on delete restrict;
alter table public.inventory_movements
  add column if not exists sale_id uuid references public.sales(id) on delete restrict,
  add column if not exists sale_item_id uuid references public.sale_items(id) on delete restrict,
  add column if not exists inventory_reservation_id uuid references public.inventory_reservations(id) on delete restrict;
create unique index if not exists inventory_movements_one_issue_per_reservation
  on public.inventory_movements(inventory_reservation_id) where inventory_reservation_id is not null;
create index if not exists inventory_movements_sale_idx on public.inventory_movements(sale_id) where sale_id is not null;

create or replace function public.fulfill_customer_order(p_sale_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare s public.sales; v_line record; v_balance record; v_today date; v_pct numeric;
begin
  -- An intersection of existing permissions; personal deny remains authoritative.
  if auth.uid() is null or not private.has_permission('sales.manage') or not private.has_permission('inventory.move') then
    raise exception 'Недостаточно прав для отгрузки заказа' using errcode='42501';
  end if;
  select * into s from public.sales where id=p_sale_id for update;
  if not found then raise exception 'Заказ не найден'; end if;
  -- Serializes both duplicate requests and cancellation against the whole order.
  if s.status='shipped' and s.shipped_at is not null then return s.id; end if;
  if s.status<>'confirmed' then raise exception 'Отгрузить можно только подтверждённый заказ'; end if;
  perform 1 from public.sale_items where sale_id=s.id order by id for update;
  perform 1 from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
    where i.sale_id=s.id order by r.id for update of r;
  if not exists(select 1 from public.sale_items where sale_id=s.id) or exists(
    select 1 from public.sale_items i where i.sale_id=s.id and i.quantity<>(
      select coalesce(sum(r.quantity),0) from public.inventory_reservations r where r.sale_item_id=i.id and r.status='active')
  ) or exists(select 1 from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
    where i.sale_id=s.id and r.status='fulfilled') then
    raise exception 'Заказ должен быть полностью зарезервирован';
  end if;
  -- Stable order for multiple fulfillment requests sharing balances. Balance before batch
  -- matches inventory issue operations; PostgreSQL aborts any other detected lock cycle safely.
  perform 1 from public.inventory_balances b where b.id in (
    select r.inventory_balance_id from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
    where i.sale_id=s.id and r.status='active') order by b.id for update;
  perform 1 from public.inventory_batches b where b.id in (
    select r.batch_id from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
    where i.sale_id=s.id and r.status='active') order by b.id for update;
  perform 1 from public.guarantee_letters where sale_id=s.id order by id for update;
  -- Never accept a caller-supplied date to bypass expiry. Read the clock after lock waits.
  v_today:=(clock_timestamp() at time zone 'UTC')::date;
  for v_balance in select b.* from public.inventory_balances b where b.id in (
    select r.inventory_balance_id from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
    where i.sale_id=s.id and r.status='active') loop
    if v_balance.quantity_reserved<>(select coalesce(sum(quantity),0) from public.inventory_reservations
      where inventory_balance_id=v_balance.id and status='active') then
      raise exception 'Остаток и действующие резервы не согласованы';
    end if;
  end loop;
  for v_line in
    select r.*,i.product_id,i.uom,i.required_shelf_life_pct,b.batch_id as balance_batch_id,
      b.warehouse_id,b.warehouse_location_id,b.uom as balance_uom,x.product_id as batch_product_id,
      x.status as batch_status,x.expiry_date,x.manufacture_date,p.shelf_life_days
    from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
    join public.inventory_balances b on b.id=r.inventory_balance_id join public.inventory_batches x on x.id=r.batch_id
    join public.products p on p.id=i.product_id where i.sale_id=s.id and r.status='active' order by r.id
  loop
    if v_line.batch_id<>v_line.balance_batch_id or v_line.product_id<>v_line.batch_product_id or v_line.warehouse_id<>s.warehouse_id or v_line.uom<>v_line.balance_uom then
      raise exception 'Резерв не соответствует товару, складу или единице заказа';
    end if;
    if v_line.batch_status<>'available' or v_line.expiry_date<v_today then
      raise exception 'Партия заблокирована, в карантине или просрочена';
    end if;
    v_pct:=private.sale_shelf_life_pct(v_line.expiry_date,v_line.manufacture_date,v_line.shelf_life_days,greatest(v_today,s.planned_shipment_date));
    if v_line.required_shelf_life_pct is not null and v_pct<v_line.required_shelf_life_pct and not exists(
      select 1 from public.guarantee_letters g join public.guarantee_letter_items gi on gi.guarantee_letter_id=g.id
      where g.sale_id=s.id and g.status in ('approved','sent','accepted') and gi.sale_item_id=v_line.sale_item_id
        and gi.batch_id=v_line.batch_id and gi.quantity=v_line.quantity and gi.required_shelf_life_pct=v_line.required_shelf_life_pct
        and gi.remaining_shelf_life_pct=v_line.remaining_shelf_life_pct and v_pct>=gi.remaining_shelf_life_pct
    ) then raise exception 'ОСГ требует действующего гарантийного письма на текущие партии и срок'; end if;
    update public.inventory_balances set quantity_on_hand=quantity_on_hand-v_line.quantity,
      quantity_reserved=quantity_reserved-v_line.quantity,updated_at=now()
      where id=v_line.inventory_balance_id and quantity_on_hand>=v_line.quantity and quantity_reserved>=v_line.quantity;
    if not found then raise exception 'Недостаточный остаток или резерв для отгрузки'; end if;
    insert into public.inventory_movements(batch_id,movement_type,quantity,uom,from_warehouse_id,from_location_id,
      reference,reason,sale_id,sale_item_id,inventory_reservation_id)
    values(v_line.batch_id,'issue',v_line.quantity,v_line.uom,v_line.warehouse_id,v_line.warehouse_location_id,
      s.sale_number,'Отгрузка подтверждённого заказа',s.id,v_line.sale_item_id,v_line.id);
    update public.inventory_reservations set status='fulfilled',updated_at=now() where id=v_line.id;
  end loop;
  update public.inventory_batches x set status='depleted',updated_at=now()
    where x.id in (select r.batch_id from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id where i.sale_id=s.id)
      and x.status='available' and not exists(select 1 from public.inventory_balances b where b.batch_id=x.id and b.quantity_on_hand>0);
  update public.sales set status='shipped',shipped_at=clock_timestamp(),shipped_by=auth.uid(),updated_at=now() where id=s.id;
  return s.id;
end $$;
revoke all on function public.fulfill_customer_order(uuid) from public,anon,authenticated,service_role;
grant execute on function public.fulfill_customer_order(uuid) to authenticated;
comment on function public.fulfill_customer_order(uuid) is 'Atomic full-order issue of exact reserved batches; replay returns sale id without new movements; sales.manage AND inventory.move required';
