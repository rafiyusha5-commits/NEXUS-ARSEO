-- Recovery keeps the order, reservations and historical guarantee letters.
-- No stock is issued and no external message is sent by recovery.
create or replace function private.business_date(p_at timestamptz)
returns date language sql immutable set search_path='' as $$
 select (p_at at time zone 'Asia/Almaty')::date
$$;
create or replace function private.business_today()
returns date language sql volatile set search_path='' as $$
 select private.business_date(clock_timestamp())
$$;
revoke all on function private.business_date(timestamptz),private.business_today() from public,anon,authenticated,service_role;

create table if not exists public.sale_preparation_returns (
 id uuid primary key default gen_random_uuid(),
 sale_id uuid not null references public.sales(id) on delete restrict,
 reason text not null check(length(btrim(reason)) between 1 and 500),
 previous_confirmed_at timestamptz,
 previous_confirmed_by uuid references public.profiles(id) on delete restrict,
 created_by uuid not null references public.profiles(id) on delete restrict,
 created_at timestamptz not null default now()
);
create index if not exists sale_preparation_returns_sale_idx on public.sale_preparation_returns(sale_id,created_at desc);
alter table public.sale_preparation_returns enable row level security;
revoke all on public.sale_preparation_returns from public,anon,authenticated,service_role;
grant select on public.sale_preparation_returns to authenticated;
drop policy if exists "employees view preparation returns" on public.sale_preparation_returns;
create policy "employees view preparation returns" on public.sale_preparation_returns for select to authenticated
using ((select private.has_permission('sales.view')));

-- One current letter per reason; cancelled/rejected versions remain immutable history.
alter table public.guarantee_letters drop constraint if exists guarantee_letters_sale_id_reason_key;
create unique index if not exists guarantee_letters_current_reason_idx on public.guarantee_letters(sale_id,reason)
 where status not in ('cancelled','rejected');

create or replace function private.refresh_sale_shelf_life(p_sale_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 -- Callers first lock the order, so reservation replacement and fulfillment cannot race this refresh.
 perform 1 from public.inventory_batches b where b.id in (
  select r.batch_id from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
  where i.sale_id=p_sale_id and r.status='active') order by b.id for share;
 if exists(select 1 from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
  join public.sales s on s.id=i.sale_id join public.inventory_batches b on b.id=r.batch_id
  where i.sale_id=p_sale_id and r.status='active'
   and (b.status<>'available' or b.expiry_date<greatest(s.planned_shipment_date,private.business_today()))) then
  raise exception 'Партия заблокирована, в карантине или просрочена: замените резерв';
 end if;
 update public.inventory_reservations r set remaining_shelf_life_pct=private.sale_shelf_life_pct(
  b.expiry_date,b.manufacture_date,p.shelf_life_days,greatest(s.planned_shipment_date,private.business_today()))
 from public.sale_items i join public.sales s on s.id=i.sale_id join public.products p on p.id=i.product_id,
 public.inventory_batches b
 where r.sale_item_id=i.id and r.batch_id=b.id and i.sale_id=p_sale_id and r.status='active';
end $$;
revoke all on function private.refresh_sale_shelf_life(uuid) from public,anon,authenticated,service_role;

create or replace function public.return_customer_order_to_preparation(p_sale_id uuid,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare s public.sales; v_reason text:=nullif(btrim(coalesce(p_reason,'')),'');
begin
 if not ((select private.has_permission('sales.view')) and (select private.has_permission('sales.manage'))
  and (select private.has_permission('sales.reserve'))) then
  raise exception 'Нет права возвращать заказ к подготовке' using errcode='42501';
 end if;
 if v_reason is null or length(v_reason)>500 then raise exception 'Укажите причину от 1 до 500 символов';end if;
 select * into s from public.sales where id=p_sale_id for update;
 if not found or s.status<>'confirmed' then raise exception 'Вернуть к подготовке можно только подтверждённый неотгруженный заказ';end if;
 if exists(select 1 from public.inventory_movements where sale_id=s.id and movement_type='issue') then
  raise exception 'По заказу уже есть отгрузка: возврат к подготовке запрещён';end if;
 if exists(select 1 from public.guarantee_letters where sale_id=s.id and status not in ('cancelled','rejected'))
  and not (select private.has_permission('guarantee_letters.manage')) then
  raise exception 'Для замены действующих гарантийных писем нужны права управления ими' using errcode='42501';end if;
 insert into public.sale_preparation_returns(sale_id,reason,previous_confirmed_at,previous_confirmed_by,created_by)
 values(s.id,v_reason,s.confirmed_at,s.confirmed_by,auth.uid());
 update public.guarantee_letters set status='cancelled',updated_at=now()
 where sale_id=s.id and status not in ('cancelled','rejected');
 -- Keep quantities, prices, reservations and the order number. Confirmation is required again.
 update public.sales set status='reserved',updated_at=now() where id=s.id;
end $$;
revoke all on function public.return_customer_order_to_preparation(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.return_customer_order_to_preparation(uuid,text) to authenticated;


create or replace function public.reserve_customer_order_item_fefo(p_sale_item_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_item record; b record;
  v_remaining numeric; v_item_pieces numeric; v_balance_pieces numeric;
  v_want numeric; v_take numeric; v_cover numeric; v_pct numeric;
  v_result jsonb := '[]'::jsonb; v_missing text[] := '{}'; v_inexact boolean := false; v_message text;
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
  v_remaining := v_item.quantity;
  for b in
    select balance.*,batch.batch_number,batch.expiry_date,batch.manufacture_date
    from public.inventory_balances balance join public.inventory_batches batch on batch.id=balance.batch_id
    where batch.product_id=v_item.product_id and balance.warehouse_id=v_item.warehouse_id
      and batch.status='available' and batch.expiry_date>=greatest(v_item.planned_shipment_date,private.business_today())
      and balance.quantity_on_hand>balance.quantity_reserved
    order by batch.expiry_date,batch.received_at,batch.id,(balance.uom=v_item.uom) desc,balance.id for update of balance
  loop
    exit when v_remaining<=0;
    if b.uom = v_item.uom then
      v_item_pieces := 1; v_balance_pieces := 1;
    else
      v_item_pieces := private.uom_pieces(v_item.product_id, v_item.uom);
      v_balance_pieces := private.uom_pieces(v_item.product_id, b.uom);
      if v_item_pieces is null or v_balance_pieces is null then
        v_missing := v_missing || array(select private.uom_label(u) from unnest(array[v_item.uom, b.uom]) u
                                        where private.uom_pieces(v_item.product_id, u) is null);
        continue;
      end if;
    end if;
    -- Everything in pieces: the products of two scale-3 numbers are exact.
    v_want := least(v_remaining * v_item_pieces, (b.quantity_on_hand - b.quantity_reserved) * v_balance_pieces);
    v_take := v_want / v_balance_pieces;
    v_cover := v_want / v_item_pieces;
    if v_take <> round(v_take, 3) or v_cover <> round(v_cover, 3) then
      v_inexact := true;
      -- Not exact: whole units of the order (4 boxes of 12 from a pallet of 50 is 0.96 pallet) ...
      v_cover := floor(v_want / v_item_pieces);
      v_take := v_cover * v_item_pieces / v_balance_pieces;
      if v_cover <= 0 or v_take <> round(v_take, 3) then
        -- ... or whole units of the balance (2 boxes of 12 for 25 pieces).
        v_take := floor(v_want / v_balance_pieces);
        v_cover := v_take * v_balance_pieces / v_item_pieces;
        if v_take <= 0 or v_cover <> round(v_cover, 3) then
          continue;
        end if;
      end if;
    end if;
    v_take := round(v_take, 3); v_cover := round(v_cover, 3);
    v_pct:=private.sale_shelf_life_pct(b.expiry_date,b.manufacture_date,v_item.shelf_life_days,greatest(v_item.planned_shipment_date,private.business_today()));
    update public.inventory_balances set quantity_reserved=quantity_reserved+v_take,updated_at=now() where id=b.id;
    insert into public.inventory_reservations(sale_item_id,inventory_balance_id,batch_id,quantity,uom,sale_quantity,remaining_shelf_life_pct)
    values(p_sale_item_id,b.id,b.batch_id,v_take,b.uom,v_cover,v_pct);
    v_result:=v_result||jsonb_build_array(jsonb_build_object('batch_id',b.batch_id,'batch_number',b.batch_number,
      'quantity',v_take,'uom',b.uom,'sale_quantity',v_cover,'remaining_shelf_life_pct',v_pct));
    v_remaining:=v_remaining-v_cover;
  end loop;
  if v_remaining>0 then
    v_message := format('Недостаточный доступный остаток: не хватает %s %s', trim_scale(v_remaining), private.uom_label(v_item.uom));
    if cardinality(v_missing) > 0 then
      v_message := v_message || format('; для пересчёта остатка не задана упаковка товара: %s — укажите количество штук в карточке товара',
        (select string_agg(distinct m, ', ') from unnest(v_missing) m));
    end if;
    if v_inexact then
      v_message := v_message || '; часть остатка учтена в упаковке, которая не делится на заказанное количество без остатка';
    end if;
    raise exception '%', v_message;
  end if;
  update public.sales s set status=case when not exists(
    select 1 from public.sale_items i where i.sale_id=s.id and i.quantity<>(select coalesce(sum(r.sale_quantity),0) from public.inventory_reservations r where r.sale_item_id=i.id and r.status='active')
  ) then 'reserved' else 'draft' end,updated_at=now() where id=v_item.sale_id;
  return v_result;
end $$;

create or replace function public.reserve_customer_order_item_override(p_sale_item_id uuid,p_inventory_balance_id uuid,p_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_item record; v_balance record; v_pct numeric; v_id uuid; v_take numeric;
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
  if not found or v_balance.product_id<>v_item.product_id or v_balance.warehouse_id<>v_item.warehouse_id then raise exception 'Остаток не соответствует позиции заказа'; end if;
  if v_balance.batch_status<>'available' or v_balance.expiry_date<greatest(v_item.planned_shipment_date,private.business_today()) then raise exception 'Партию нельзя резервировать на дату отгрузки'; end if;
  v_take := private.convert_uom(v_item.product_id, v_item.quantity, v_item.uom, v_balance.uom);
  if v_take is null then
    if private.uom_pieces(v_item.product_id, v_item.uom) is null or private.uom_pieces(v_item.product_id, v_balance.uom) is null then
      raise exception 'Для пересчёта % в % не задана упаковка товара — укажите количество штук в карточке товара',
        private.uom_label(v_item.uom), private.uom_label(v_balance.uom);
    end if;
    raise exception 'Количество заказа (% %) не пересчитывается в единицы остатка (%) без остатка',
      trim_scale(v_item.quantity), private.uom_label(v_item.uom), private.uom_label(v_balance.uom);
  end if;
  delete from public.guarantee_letter_items where guarantee_letter_id in
    (select id from public.guarantee_letters where sale_id=v_item.sale_id and status='draft');
  perform private.release_sale_item_reservations(p_sale_item_id);
  select quantity_on_hand, quantity_reserved into v_balance.quantity_on_hand, v_balance.quantity_reserved
  from public.inventory_balances where id = v_balance.id;
  if v_balance.quantity_on_hand-v_balance.quantity_reserved<v_take then raise exception 'В выбранной партии недостаточно доступного остатка'; end if;
  v_pct:=private.sale_shelf_life_pct(v_balance.expiry_date,v_balance.manufacture_date,v_item.shelf_life_days,greatest(v_item.planned_shipment_date,private.business_today()));
  update public.inventory_balances set quantity_reserved=quantity_reserved+v_take,updated_at=now() where id=v_balance.id;
  insert into public.inventory_reservations(sale_item_id,inventory_balance_id,batch_id,quantity,uom,sale_quantity,remaining_shelf_life_pct,is_fefo_override,override_reason,override_approved_by)
  values(p_sale_item_id,v_balance.id,v_balance.batch_id,v_take,v_balance.uom,v_item.quantity,v_pct,true,trim(p_reason),auth.uid()) returning id into v_id;
  update public.sales set status='reserved',updated_at=now() where id=v_item.sale_id and not exists(
    select 1 from public.sale_items i where i.sale_id=v_item.sale_id and i.id<>p_sale_item_id and i.quantity<>(select coalesce(sum(r.sale_quantity),0) from public.inventory_reservations r where r.sale_item_id=i.id and r.status='active'));
  return v_id;
end $$;

create or replace function public.create_sale_guarantee_letter(p_sale_id uuid,p_notes text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_sale record; v_id uuid; v_number text;
begin
  if not (select private.has_permission('guarantee_letters.manage')) then raise exception 'Нет права создавать гарантийные письма'; end if;
  select * into v_sale from public.sales where id=p_sale_id and status in ('reserved','draft') for update;
  if not found then raise exception 'Заказ недоступен для гарантийного письма'; end if;
  if exists(select 1 from public.guarantee_letters where sale_id=p_sale_id and reason='low_shelf_life' and status not in ('draft','cancelled','rejected')) then
    raise exception 'Уже существует зафиксированное гарантийное письмо для этого заказа';
  end if;
  perform private.refresh_sale_shelf_life(p_sale_id);
  if not exists(select 1 from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id where i.sale_id=p_sale_id and r.status='active' and i.required_shelf_life_pct is not null and r.remaining_shelf_life_pct<i.required_shelf_life_pct) then raise exception 'В заказе нет партий с ОСГ ниже требования клиента'; end if;
  v_number:=format('GL-%s-%s',extract(year from private.business_today())::int,lpad(nextval('public.guarantee_letter_number_seq')::text,6,'0'));
  insert into public.guarantee_letters(letter_number,customer_id,sale_id,notes) values(v_number,v_sale.customer_id,p_sale_id,nullif(trim(p_notes),''))
  on conflict(sale_id,reason) where status not in ('cancelled','rejected') do update set notes=excluded.notes,updated_at=now() returning id into v_id;
  delete from public.guarantee_letter_items where guarantee_letter_id=v_id;
  insert into public.guarantee_letter_items(guarantee_letter_id,sale_item_id,batch_id,quantity,remaining_shelf_life_pct,required_shelf_life_pct)
  select v_id,i.id,r.batch_id,sum(r.sale_quantity),min(r.remaining_shelf_life_pct),i.required_shelf_life_pct
  from public.sale_items i join public.inventory_reservations r on r.sale_item_id=i.id and r.status='active'
  where i.sale_id=p_sale_id and i.required_shelf_life_pct is not null and r.remaining_shelf_life_pct<i.required_shelf_life_pct
  group by i.id,r.batch_id,i.required_shelf_life_pct;
  return v_id;
end $$;

create or replace function public.confirm_customer_order(p_sale_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if not (select private.has_permission('sales.manage')) then raise exception 'Нет права подтверждать клиентские заказы'; end if;
  perform 1 from public.sales where id=p_sale_id and status='reserved' for update;
  if not found then raise exception 'Полностью зарезервируйте заказ перед подтверждением'; end if;
  perform private.refresh_sale_shelf_life(p_sale_id);
  if exists(
    select 1 from (
      select i.id as sale_item_id, r.batch_id, i.required_shelf_life_pct,
             sum(r.sale_quantity) as quantity, min(r.remaining_shelf_life_pct) as remaining_shelf_life_pct
      from public.sale_items i join public.inventory_reservations r on r.sale_item_id=i.id and r.status='active'
      where i.sale_id=p_sale_id and i.required_shelf_life_pct is not null and r.remaining_shelf_life_pct<i.required_shelf_life_pct
      group by i.id, r.batch_id, i.required_shelf_life_pct
    ) low
    where not exists(
      select 1 from public.guarantee_letters g join public.guarantee_letter_items gi on gi.guarantee_letter_id=g.id
      where g.sale_id=p_sale_id and g.status in ('approved','sent','accepted') and gi.sale_item_id=low.sale_item_id
        and gi.batch_id=low.batch_id and gi.quantity=low.quantity
        and gi.remaining_shelf_life_pct=low.remaining_shelf_life_pct and gi.required_shelf_life_pct=low.required_shelf_life_pct
    )
  ) then raise exception 'ОСГ ниже требования клиента: требуется утверждённое гарантийное письмо на текущие партии'; end if;
  update public.sales set status='confirmed',confirmed_by=auth.uid(),confirmed_at=now(),updated_at=now() where id=p_sale_id;
end $$;

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
      select coalesce(sum(r.sale_quantity),0) from public.inventory_reservations r where r.sale_item_id=i.id and r.status='active')
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
  v_today:=private.business_today();
  for v_balance in select b.* from public.inventory_balances b where b.id in (
    select r.inventory_balance_id from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
    where i.sale_id=s.id and r.status='active') loop
    if v_balance.quantity_reserved<>(select coalesce(sum(quantity),0) from public.inventory_reservations
      where inventory_balance_id=v_balance.id and status='active') then
      raise exception 'Остаток и действующие резервы не согласованы';
    end if;
  end loop;
  for v_line in
    select r.id, r.sale_item_id, r.batch_id, r.inventory_balance_id, r.quantity, r.uom as reservation_uom,
      i.product_id, i.required_shelf_life_pct, b.batch_id as balance_batch_id, b.warehouse_id, b.warehouse_location_id,
      b.uom as balance_uom, x.product_id as batch_product_id, x.status as batch_status, x.expiry_date, x.manufacture_date,
      p.shelf_life_days,
      -- The part of the order line from this batch, in the unit of the order, and its lowest shelf life:
      -- the same figures a guarantee letter records.
      sum(r.sale_quantity) over (partition by r.sale_item_id, r.batch_id) as batch_sale_quantity,
      min(r.remaining_shelf_life_pct) over (partition by r.sale_item_id, r.batch_id) as batch_shelf_life_pct
    from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
    join public.inventory_balances b on b.id=r.inventory_balance_id join public.inventory_batches x on x.id=r.batch_id
    join public.products p on p.id=i.product_id where i.sale_id=s.id and r.status='active' order by r.id
  loop
    if v_line.batch_id<>v_line.balance_batch_id or v_line.product_id<>v_line.batch_product_id or v_line.warehouse_id<>s.warehouse_id
       or v_line.reservation_uom<>v_line.balance_uom then
      raise exception 'Резерв не соответствует товару, складу или единице остатка';
    end if;
    if v_line.batch_status<>'available' or v_line.expiry_date<v_today then
      raise exception 'Партия заблокирована, в карантине или просрочена';
    end if;
    v_pct:=private.sale_shelf_life_pct(v_line.expiry_date,v_line.manufacture_date,v_line.shelf_life_days,greatest(v_today,s.planned_shipment_date));
    if v_line.required_shelf_life_pct is not null and v_pct<v_line.required_shelf_life_pct and not exists(
      select 1 from public.guarantee_letters g join public.guarantee_letter_items gi on gi.guarantee_letter_id=g.id
      where g.sale_id=s.id and g.status in ('approved','sent','accepted') and gi.sale_item_id=v_line.sale_item_id
        and gi.batch_id=v_line.batch_id and gi.quantity=v_line.batch_sale_quantity and gi.required_shelf_life_pct=v_line.required_shelf_life_pct
        and gi.remaining_shelf_life_pct=v_line.batch_shelf_life_pct and v_pct>=gi.remaining_shelf_life_pct
    ) then raise exception 'ОСГ требует действующего гарантийного письма на текущие партии и срок'; end if;
    update public.inventory_balances set quantity_on_hand=quantity_on_hand-v_line.quantity,
      quantity_reserved=quantity_reserved-v_line.quantity,updated_at=now()
      where id=v_line.inventory_balance_id and quantity_on_hand>=v_line.quantity and quantity_reserved>=v_line.quantity;
    if not found then raise exception 'Недостаточный остаток или резерв для отгрузки'; end if;
    insert into public.inventory_movements(batch_id,movement_type,quantity,uom,from_warehouse_id,from_location_id,
      reference,reason,sale_id,sale_item_id,inventory_reservation_id)
    values(v_line.batch_id,'issue',v_line.quantity,v_line.reservation_uom,v_line.warehouse_id,v_line.warehouse_location_id,
      s.sale_number,'Отгрузка подтверждённого заказа',s.id,v_line.sale_item_id,v_line.id);
    update public.inventory_reservations set status='fulfilled',updated_at=now() where id=v_line.id;
  end loop;
  update public.inventory_batches x set status='depleted',updated_at=now()
    where x.id in (select r.batch_id from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id where i.sale_id=s.id)
      and x.status='available' and not exists(select 1 from public.inventory_balances b where b.batch_id=x.id and b.quantity_on_hand>0);
  update public.sales set status='shipped',shipped_at=clock_timestamp(),shipped_by=auth.uid(),updated_at=now() where id=s.id;
  return s.id;
end $$;

create or replace function public.create_customer_order(p_customer_id uuid,p_contract_id uuid,p_warehouse_id uuid,p_planned_shipment_date date,p_currency_id uuid,p_notes text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_number text;
begin
  if not (select private.has_permission('sales.manage')) then raise exception 'Нет права создавать клиентские заказы'; end if;
  if p_planned_shipment_date is null or p_planned_shipment_date<private.business_today() then raise exception 'Дата отгрузки не может быть в прошлом'; end if;
  if not exists(select 1 from public.counterparties where id=p_customer_id and 'customer'=any(roles) and status='active') then raise exception 'Активный клиент не найден'; end if;
  if not exists(select 1 from public.warehouses where id=p_warehouse_id and status='active' and not is_virtual) then raise exception 'Активный склад не найден'; end if;
  if p_contract_id is not null and not exists(select 1 from public.contracts where id=p_contract_id and counterparty_id=p_customer_id and status='active') then raise exception 'Контракт не относится к клиенту или не активен'; end if;
  v_number:=format('SO-%s-%s',extract(year from private.business_today())::int,lpad(nextval('public.sale_number_seq')::text,6,'0'));
  insert into public.sales(sale_number,customer_id,contract_id,warehouse_id,planned_shipment_date,currency_id,notes)
  values(v_number,p_customer_id,p_contract_id,p_warehouse_id,p_planned_shipment_date,p_currency_id,nullif(trim(p_notes),'')) returning id into v_id;
  return v_id;
end $$;

CREATE OR REPLACE FUNCTION public.change_shipment_transport_status(p_transport_id uuid, p_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_locked boolean;
begin
  if not private.can_write_shipments('change_status') then
    raise exception 'Недостаточно прав для изменения перевозки';
  end if;
  if p_status not in ('planned','loading','in_transit','at_customs','arrived','unloaded','cancelled') then
    raise exception 'Некорректный статус перевозки';
  end if;
  select shipment.is_locked into v_locked
  from public.shipment_transports transport
  join public.shipments shipment on shipment.id = transport.shipment_id
  where transport.id = p_transport_id for update of transport, shipment;
  if not found then raise exception 'Перевозка не найдена'; end if;
  if v_locked then raise exception 'Закрытая поставка недоступна для изменений'; end if;
  if p_status <> 'unloaded' and exists(select 1 from public.shipment_transport_receipts where shipment_transport_id=p_transport_id) then
    raise exception 'Автомобиль уже принят на склад: отмена и возврат статуса запрещены';
  end if;
  update public.shipment_transports set
    status = p_status,
    actual_loading_date = case when p_status in ('loading','in_transit','at_customs','arrived','unloaded') then coalesce(actual_loading_date,private.business_today()) else actual_loading_date end,
    actual_arrival_date = case when p_status in ('arrived','unloaded') then coalesce(actual_arrival_date,private.business_today()) else actual_arrival_date end,
    updated_at = now()
  where id = p_transport_id;
end $function$;

create or replace function public.change_sale_guarantee_status(p_letter_id uuid,p_status text)
returns void language plpgsql security definer set search_path='' as $$
declare v_old text; v_sale_id uuid;
begin
  if not (select private.has_permission('guarantee_letters.manage')) then raise exception 'Нет права изменять гарантийные письма'; end if;
  select sale_id into v_sale_id from public.guarantee_letters where id=p_letter_id;
  perform 1 from public.sales where id=v_sale_id for update;
  select status into v_old from public.guarantee_letters where id=p_letter_id for update;
  if not found then raise exception 'Гарантийное письмо не найдено'; end if;
  if v_old in ('cancelled','rejected','accepted') then raise exception 'Гарантийное письмо завершено';end if;
  if (v_old='draft' and p_status<>'approved') or (v_old='approved' and p_status not in ('sent','cancelled')) or (v_old='sent' and p_status not in ('accepted','rejected')) then raise exception 'Недопустимый переход статуса гарантийного письма'; end if;
  update public.guarantee_letters set status=p_status,
    approved_by=case when p_status='approved' then auth.uid() else approved_by end,
    approved_at=case when p_status='approved' then now() else approved_at end,
    sent_at=case when p_status='sent' then now() else sent_at end,
    customer_decision_at=case when p_status in ('accepted','rejected') then now() else customer_decision_at end,updated_at=now()
  where id=p_letter_id;
end $$;
