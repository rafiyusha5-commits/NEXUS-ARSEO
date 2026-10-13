-- Unit conversion for customer orders.
--
-- A shipment from the purchase plan is received in pieces, while customers order boxes or pallets.
-- Reservation looked only for stock kept in exactly the ordered unit, so an order of boxes found nothing
-- on a warehouse full of the same goods in pieces. Now the order and the stock are compared in pieces
-- through the product packaging: product_packaging.units_per_parent is the number of pieces in one unit
-- of that level (this is how the calculator import, the product card and the load summary fill and read it).
--
--   * private.uom_pieces / private.convert_uom — pieces in one unit and the exact conversion between two
--     units of a product; shipping to the customer uses the same functions;
--   * a reservation keeps quantity in the unit of the stock it holds (uom) and the part of the order it
--     covers in the unit of the order (sale_quantity); completeness of the order counts sale_quantity;
--   * a balance gives only an amount that is exact to the thousandth in both units: the needed amount,
--     or else whole units of the order, or else whole units of the balance; never an inexact remainder;
--   * missing packaging stops the reservation with a message that names the unit to fill in.

alter table public.inventory_reservations
  add column if not exists uom text check (uom in ('piece','box','layer','pallet','truck')),
  add column if not exists sale_quantity numeric(14,3) check (sale_quantity > 0);

-- Before this migration a reservation was always in the unit of the order.
update public.inventory_reservations r
set uom = b.uom, sale_quantity = coalesce(r.sale_quantity, r.quantity)
from public.inventory_balances b
where b.id = r.inventory_balance_id and (r.uom is null or r.sale_quantity is null);

alter table public.inventory_reservations alter column uom set not null, alter column sale_quantity set not null;

comment on column public.inventory_reservations.quantity is 'Reserved amount in the unit of the stock balance (uom)';
comment on column public.inventory_reservations.uom is 'Unit of the stock balance the reservation holds';
comment on column public.inventory_reservations.sale_quantity is 'Part of the order line covered, in the unit of the order line';

create or replace function private.uom_label(p_uom text)
returns text language sql immutable set search_path = '' as $$
  select case p_uom when 'piece' then 'шт.' when 'box' then 'кор.' when 'layer' then 'слой'
                    when 'pallet' then 'пал.' when 'truck' then 'фура' else p_uom end
$$;

-- Pieces in one unit of the product; null when the packaging level is not set.
create or replace function private.uom_pieces(p_product_id uuid, p_uom text)
returns numeric language sql stable security definer set search_path = '' as $$
  select case when p_uom = 'piece' then 1::numeric
              else (select pp.units_per_parent from public.product_packaging pp
                    where pp.product_id = p_product_id and pp.uom = p_uom) end
$$;

-- Exact conversion of a quantity between two units of a product, to the thousandth.
-- Null when a packaging level is missing or the result is not exact (12 pieces are 1 box of 12,
-- 5 pieces are not a whole number of thousandths of that box).
create or replace function private.convert_uom(p_product_id uuid, p_quantity numeric, p_from text, p_to text)
returns numeric language plpgsql stable security definer set search_path = '' as $$
declare v_from numeric; v_to numeric; v_result numeric;
begin
  if p_quantity is null then return null; end if;
  if p_from = p_to then return p_quantity; end if;
  v_from := private.uom_pieces(p_product_id, p_from);
  v_to := private.uom_pieces(p_product_id, p_to);
  if v_from is null or v_to is null then return null; end if;
  v_result := p_quantity * v_from / v_to;
  if v_result <> round(v_result, 3) then return null; end if;
  return round(v_result, 3);
end $$;

-- One invariant for every writer (reservation RPCs, shipping to the customer): the unit is the unit of the
-- balance and sale_quantity is exactly quantity converted to the unit of the order. A writer that knows
-- only the stock amount gets sale_quantity filled in; changing quantity alone recalculates it.
create or replace function private.inventory_reservation_units()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_balance_uom text; v_item record; v_expected numeric;
begin
  select uom into v_balance_uom from public.inventory_balances where id = new.inventory_balance_id;
  if new.uom is null then new.uom := v_balance_uom; end if;
  if new.uom is distinct from v_balance_uom then
    raise exception 'Единица резерва должна совпадать с единицей остатка';
  end if;
  if tg_op = 'UPDATE' and new.quantity is distinct from old.quantity and new.sale_quantity is not distinct from old.sale_quantity then
    new.sale_quantity := null;
  end if;
  select product_id, uom into v_item from public.sale_items where id = new.sale_item_id;
  v_expected := private.convert_uom(v_item.product_id, new.quantity, new.uom, v_item.uom);
  if v_expected is null then
    raise exception 'Количество резерва (% %) не пересчитывается в единицы заказа (%) без остатка',
      trim_scale(new.quantity), private.uom_label(new.uom), private.uom_label(v_item.uom);
  end if;
  if new.sale_quantity is null then
    new.sale_quantity := v_expected;
  elsif new.sale_quantity <> v_expected then
    raise exception 'Количество резерва в единицах заказа (%) не соответствует упаковке товара (%)',
      trim_scale(new.sale_quantity), trim_scale(v_expected);
  end if;
  return new;
end $$;

drop trigger if exists inventory_reservation_units on public.inventory_reservations;
create trigger inventory_reservation_units
before insert or update of quantity, uom, sale_quantity, inventory_balance_id on public.inventory_reservations
for each row execute function private.inventory_reservation_units();

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
      and batch.status='available' and batch.expiry_date>=v_item.planned_shipment_date
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
    v_pct:=private.sale_shelf_life_pct(b.expiry_date,b.manufacture_date,v_item.shelf_life_days,v_item.planned_shipment_date);
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
  if v_balance.batch_status<>'available' or v_balance.expiry_date<v_item.planned_shipment_date then raise exception 'Партию нельзя резервировать на дату отгрузки'; end if;
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
  v_pct:=private.sale_shelf_life_pct(v_balance.expiry_date,v_balance.manufacture_date,v_item.shelf_life_days,v_item.planned_shipment_date);
  update public.inventory_balances set quantity_reserved=quantity_reserved+v_take,updated_at=now() where id=v_balance.id;
  insert into public.inventory_reservations(sale_item_id,inventory_balance_id,batch_id,quantity,uom,sale_quantity,remaining_shelf_life_pct,is_fefo_override,override_reason,override_approved_by)
  values(p_sale_item_id,v_balance.id,v_balance.batch_id,v_take,v_balance.uom,v_item.quantity,v_pct,true,trim(p_reason),auth.uid()) returning id into v_id;
  update public.sales set status='reserved',updated_at=now() where id=v_item.sale_id and not exists(
    select 1 from public.sale_items i where i.sale_id=v_item.sale_id and i.id<>p_sale_item_id and i.quantity<>(select coalesce(sum(r.sale_quantity),0) from public.inventory_reservations r where r.sale_item_id=i.id and r.status='active'));
  return v_id;
end $$;

-- The letter speaks to the customer in the unit of the order; one row per order line and batch, even when
-- the batch is reserved from several balances (locations or units).
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

do $$ declare f text; begin
  foreach f in array array[
    'public.reserve_customer_order_item_fefo(uuid)','public.reserve_customer_order_item_override(uuid,uuid,text)',
    'public.create_sale_guarantee_letter(uuid,text)','public.confirm_customer_order(uuid)',
    'private.uom_label(text)','private.uom_pieces(uuid,text)','private.convert_uom(uuid,numeric,text,text)',
    'private.inventory_reservation_units()'
  ] loop execute format('revoke all on function %s from public,anon,authenticated,service_role',f); end loop;
end $$;
grant execute on function public.reserve_customer_order_item_fefo(uuid),public.reserve_customer_order_item_override(uuid,uuid,text),
  public.create_sale_guarantee_letter(uuid,text),public.confirm_customer_order(uuid) to authenticated;

comment on function private.convert_uom(uuid,numeric,text,text) is
  'Exact conversion between two units of a product through its packaging (pieces per unit); null when not exact or packaging is missing';
