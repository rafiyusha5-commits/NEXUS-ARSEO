-- Audit 2026-10-13, finding Н5 (docs/audit-2026-10-13.md). A confirmed customer order whose reserved batch was
-- blocked or expired, or whose remaining shelf life fell because the shipment was delayed, could be neither
-- re-reserved nor covered by a guarantee letter: cancelling it was the only way out.
-- Decision: the order stays confirmed. Its batches can be replaced and its shipment date moved, each with a
-- recorded reason; a guarantee letter that no longer matches the reservations is superseded (kept as history)
-- and a new one can be issued. Confirmation checks the batches, and blocking a batch warns the open orders.

-- 1. Guarantee letters: one current letter per order and reason; superseded, cancelled and rejected ones stay.
alter table public.guarantee_letters drop constraint if exists guarantee_letters_status_check;
alter table public.guarantee_letters add constraint guarantee_letters_status_check
 check(status in ('draft','approved','sent','accepted','rejected','cancelled','superseded'));
alter table public.guarantee_letters
 add column if not exists superseded_at timestamptz,
 add column if not exists superseded_reason text;
alter table public.guarantee_letters drop constraint if exists guarantee_letters_superseded_check;
alter table public.guarantee_letters add constraint guarantee_letters_superseded_check check(
 (status='superseded')=(superseded_at is not null)
 and (superseded_at is null or btrim(coalesce(superseded_reason,''))<>''));
alter table public.guarantee_letters drop constraint if exists guarantee_letters_sale_id_reason_key;
create unique index if not exists guarantee_letters_current_key on public.guarantee_letters(sale_id,reason)
 where status in ('draft','approved','sent','accepted');
comment on column public.guarantee_letters.superseded_reason is 'Why the letter stopped matching the order (batch replaced, shipment moved)';

-- 2. Order revisions: what was changed in an order after reservation, by whom and why.
create table if not exists public.sale_revisions(
 id uuid primary key default gen_random_uuid(),
 sale_id uuid not null references public.sales(id) on delete restrict,
 sale_item_id uuid references public.sale_items(id) on delete restrict,
 action text not null check(action in ('rereserve','reschedule')),
 reason text not null check(btrim(reason)<>'' and length(reason)<=500),
 details jsonb not null default '{}'::jsonb,
 created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
 created_at timestamptz not null default now()
);
create index if not exists sale_revisions_sale_idx on public.sale_revisions(sale_id,created_at desc);
create index if not exists sale_revisions_item_idx on public.sale_revisions(sale_item_id);
create index if not exists sale_revisions_created_by_idx on public.sale_revisions(created_by);
alter table public.sale_revisions enable row level security;
revoke all on public.sale_revisions from anon,authenticated;
grant select on public.sale_revisions to authenticated;
drop policy if exists "employees view sale revisions" on public.sale_revisions;
create policy "employees view sale revisions" on public.sale_revisions for select to authenticated
 using((select private.has_permission('sales.view')));
comment on table public.sale_revisions is 'Batch replacements and shipment date changes of customer orders, with reasons';

-- 3. Reservation cores without status checks: the callers lock the order, check the rules and set its status.
-- Batches must be usable on the shipment date, and never on a date that has already passed.
create or replace function private.reserve_sale_item_fefo(p_sale_item_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_item record; b record; v_on date;
  v_remaining numeric; v_item_pieces numeric; v_balance_pieces numeric;
  v_want numeric; v_take numeric; v_cover numeric; v_pct numeric;
  v_result jsonb := '[]'::jsonb; v_missing text[] := '{}'; v_inexact boolean := false; v_message text;
begin
  select i.*,s.warehouse_id,s.planned_shipment_date,p.shelf_life_days into v_item
  from public.sale_items i join public.sales s on s.id=i.sale_id join public.products p on p.id=i.product_id
  where i.id=p_sale_item_id;
  v_on := greatest(v_item.planned_shipment_date, current_date);
  perform private.release_sale_item_reservations(p_sale_item_id);
  v_remaining := v_item.quantity;
  for b in
    select balance.*,batch.batch_number,batch.expiry_date,batch.manufacture_date
    from public.inventory_balances balance join public.inventory_batches batch on batch.id=balance.batch_id
    where batch.product_id=v_item.product_id and balance.warehouse_id=v_item.warehouse_id
      and batch.status='available' and batch.expiry_date>=v_on
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
    v_pct:=private.sale_shelf_life_pct(b.expiry_date,b.manufacture_date,v_item.shelf_life_days,v_on);
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
  return v_result;
end $$;

create or replace function private.reserve_sale_item_balance(p_sale_item_id uuid,p_inventory_balance_id uuid,p_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_item record; v_balance record; v_on date; v_pct numeric; v_id uuid; v_take numeric;
begin
  select i.*,s.warehouse_id,s.planned_shipment_date,p.shelf_life_days into v_item
  from public.sale_items i join public.sales s on s.id=i.sale_id join public.products p on p.id=i.product_id where i.id=p_sale_item_id;
  v_on := greatest(v_item.planned_shipment_date, current_date);
  select balance.*,batch.product_id,batch.expiry_date,batch.manufacture_date,batch.status as batch_status into v_balance
  from public.inventory_balances balance join public.inventory_batches batch on batch.id=balance.batch_id where balance.id=p_inventory_balance_id for update of balance;
  if not found or v_balance.product_id<>v_item.product_id or v_balance.warehouse_id<>v_item.warehouse_id then raise exception 'Остаток не соответствует позиции заказа'; end if;
  if v_balance.batch_status<>'available' or v_balance.expiry_date<v_on then raise exception 'Партию нельзя резервировать на дату отгрузки'; end if;
  v_take := private.convert_uom(v_item.product_id, v_item.quantity, v_item.uom, v_balance.uom);
  if v_take is null then
    if private.uom_pieces(v_item.product_id, v_item.uom) is null or private.uom_pieces(v_item.product_id, v_balance.uom) is null then
      raise exception 'Для пересчёта % в % не задана упаковка товара — укажите количество штук в карточке товара',
        private.uom_label(v_item.uom), private.uom_label(v_balance.uom);
    end if;
    raise exception 'Количество заказа (% %) не пересчитывается в единицы остатка (%) без остатка',
      trim_scale(v_item.quantity), private.uom_label(v_item.uom), private.uom_label(v_balance.uom);
  end if;
  perform private.release_sale_item_reservations(p_sale_item_id);
  select quantity_on_hand, quantity_reserved into v_balance.quantity_on_hand, v_balance.quantity_reserved
  from public.inventory_balances where id = v_balance.id;
  if v_balance.quantity_on_hand-v_balance.quantity_reserved<v_take then raise exception 'В выбранной партии недостаточно доступного остатка'; end if;
  v_pct:=private.sale_shelf_life_pct(v_balance.expiry_date,v_balance.manufacture_date,v_item.shelf_life_days,v_on);
  update public.inventory_balances set quantity_reserved=quantity_reserved+v_take,updated_at=now() where id=v_balance.id;
  insert into public.inventory_reservations(sale_item_id,inventory_balance_id,batch_id,quantity,uom,sale_quantity,remaining_shelf_life_pct,is_fefo_override,override_reason,override_approved_by)
  values(p_sale_item_id,v_balance.id,v_balance.batch_id,v_take,v_balance.uom,v_item.quantity,v_pct,true,trim(p_reason),auth.uid()) returning id into v_id;
  return v_id;
end $$;

-- Draft letters are rebuilt from the reservations. A fixed letter (approved, sent, accepted) that no longer covers
-- exactly the reservations below the client's shelf-life requirement is superseded; one that still does stays.
create or replace function private.sync_sale_guarantee_letters(p_sale_id uuid,p_reason text)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_letter record; v_stale boolean; v_superseded boolean := false;
begin
  delete from public.guarantee_letter_items where guarantee_letter_id in
    (select id from public.guarantee_letters where sale_id=p_sale_id and status='draft');
  for v_letter in select id from public.guarantee_letters where sale_id=p_sale_id and status in ('approved','sent','accepted') order by id for update loop
    with low as (
      select i.id as sale_item_id, r.batch_id, sum(r.sale_quantity) as quantity,
             min(r.remaining_shelf_life_pct) as remaining_shelf_life_pct, i.required_shelf_life_pct
      from public.sale_items i join public.inventory_reservations r on r.sale_item_id=i.id and r.status='active'
      where i.sale_id=p_sale_id and i.required_shelf_life_pct is not null and r.remaining_shelf_life_pct<i.required_shelf_life_pct
      group by i.id, r.batch_id, i.required_shelf_life_pct
    ), letter as (
      select sale_item_id, batch_id, quantity, remaining_shelf_life_pct, required_shelf_life_pct
      from public.guarantee_letter_items where guarantee_letter_id=v_letter.id
    )
    select exists(select * from low except select * from letter) or exists(select * from letter except select * from low) into v_stale;
    if v_stale then
      update public.guarantee_letters set status='superseded',superseded_at=now(),superseded_reason=p_reason,updated_at=now() where id=v_letter.id;
      v_superseded := true;
    end if;
  end loop;
  return v_superseded;
end $$;

create or replace function private.sale_reservation_summary(p_sale_item_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('batch_id',r.batch_id,'batch_number',b.batch_number,'quantity',r.quantity,'uom',r.uom,
    'sale_quantity',r.sale_quantity,'remaining_shelf_life_pct',r.remaining_shelf_life_pct) order by b.expiry_date,b.batch_number),'[]'::jsonb)
  from public.inventory_reservations r join public.inventory_batches b on b.id=r.batch_id
  where r.sale_item_id=p_sale_item_id and r.status='active'
$$;

do $$declare f text;begin foreach f in array array[
 'private.reserve_sale_item_fefo(uuid)','private.reserve_sale_item_balance(uuid,uuid,text)',
 'private.sync_sale_guarantee_letters(uuid,text)','private.sale_reservation_summary(uuid)'] loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);end loop;end $$;

-- 4. The ordinary reservation of a draft or reserved order: unchanged rules on top of the cores.
create or replace function public.reserve_customer_order_item_fefo(p_sale_item_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_item record; v_result jsonb;
begin
  if not (select private.has_permission('sales.reserve')) then raise exception 'Нет права резервировать товар'; end if;
  select i.sale_id,s.status as sale_status into v_item
  from public.sale_items i join public.sales s on s.id=i.sale_id where i.id=p_sale_item_id for update of i,s;
  if not found or v_item.sale_status not in ('draft','reserved') then raise exception 'Заказ недоступен для резервирования'; end if;
  if exists(select 1 from public.guarantee_letters where sale_id=v_item.sale_id and status in ('approved','sent','accepted')) then
    raise exception 'Нельзя менять партии после утверждения гарантийного письма: замените партию через «Перерезервировать» с указанием причины';
  end if;
  delete from public.guarantee_letter_items where guarantee_letter_id in
    (select id from public.guarantee_letters where sale_id=v_item.sale_id and status='draft');
  v_result := private.reserve_sale_item_fefo(p_sale_item_id);
  update public.sales s set status=case when not exists(
    select 1 from public.sale_items i where i.sale_id=s.id and i.quantity<>(select coalesce(sum(r.sale_quantity),0) from public.inventory_reservations r where r.sale_item_id=i.id and r.status='active')
  ) then 'reserved' else 'draft' end,updated_at=now() where id=v_item.sale_id;
  return v_result;
end $$;

create or replace function public.reserve_customer_order_item_override(p_sale_item_id uuid, p_inventory_balance_id uuid, p_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_item record; v_id uuid;
begin
  if not (select private.has_permission('sales.override_fefo')) then raise exception 'Нет права отклоняться от FEFO'; end if;
  if nullif(trim(p_reason),'') is null then raise exception 'Укажите причину отклонения от FEFO'; end if;
  select i.sale_id,s.status as sale_status into v_item
  from public.sale_items i join public.sales s on s.id=i.sale_id where i.id=p_sale_item_id for update of i,s;
  if not found or v_item.sale_status not in ('draft','reserved') then raise exception 'Заказ недоступен для резервирования'; end if;
  if exists(select 1 from public.guarantee_letters where sale_id=v_item.sale_id and status in ('approved','sent','accepted')) then
    raise exception 'Нельзя менять партии после утверждения гарантийного письма: замените партию через «Перерезервировать» с указанием причины';
  end if;
  delete from public.guarantee_letter_items where guarantee_letter_id in
    (select id from public.guarantee_letters where sale_id=v_item.sale_id and status='draft');
  v_id := private.reserve_sale_item_balance(p_sale_item_id, p_inventory_balance_id, p_reason);
  update public.sales set status='reserved',updated_at=now() where id=v_item.sale_id and not exists(
    select 1 from public.sale_items i where i.sale_id=v_item.sale_id and i.id<>p_sale_item_id and i.quantity<>(select coalesce(sum(r.sale_quantity),0) from public.inventory_reservations r where r.sale_item_id=i.id and r.status='active'));
  return v_id;
end $$;

-- 5. Replace the batches of one line, also in a confirmed order or after a letter was fixed. The whole quantity
-- must be covered again, otherwise nothing changes. A confirmed order stays confirmed.
create or replace function public.rereserve_customer_order_item(p_sale_item_id uuid,p_inventory_balance_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_item record; v_reason text:=nullif(btrim(coalesce(p_reason,'')),''); v_before jsonb; v_after jsonb; v_superseded boolean;
begin
  if not (select private.has_permission('sales.reserve')) then raise exception 'Нет права резервировать товар' using errcode='42501'; end if;
  select i.sale_id,s.status as sale_status into v_item
  from public.sale_items i join public.sales s on s.id=i.sale_id where i.id=p_sale_item_id for update of i,s;
  if not found or v_item.sale_status not in ('draft','reserved','confirmed') then raise exception 'Заказ недоступен для перерезервирования'; end if;
  if v_item.sale_status='confirmed' and not (select private.has_permission('sales.manage')) then
    raise exception 'Партии подтверждённого заказа меняет сотрудник с правом управления заказами' using errcode='42501';
  end if;
  if p_inventory_balance_id is not null and not (select private.has_permission('sales.override_fefo')) then
    raise exception 'Нет права отклоняться от FEFO' using errcode='42501';
  end if;
  if v_reason is null then raise exception 'Укажите причину перерезервирования'; end if;
  if length(v_reason)>500 then raise exception 'Причина длиннее 500 символов'; end if;
  v_before := private.sale_reservation_summary(p_sale_item_id);
  if p_inventory_balance_id is null then
    perform private.reserve_sale_item_fefo(p_sale_item_id);
  else
    perform private.reserve_sale_item_balance(p_sale_item_id, p_inventory_balance_id, v_reason);
  end if;
  v_after := private.sale_reservation_summary(p_sale_item_id);
  v_superseded := private.sync_sale_guarantee_letters(v_item.sale_id, 'Партии заменены: '||v_reason);
  if v_item.sale_status='confirmed' then
    update public.sales set updated_at=now() where id=v_item.sale_id;
  else
    update public.sales s set status=case when not exists(
      select 1 from public.sale_items i where i.sale_id=s.id and i.quantity<>(select coalesce(sum(r.sale_quantity),0) from public.inventory_reservations r where r.sale_item_id=i.id and r.status='active')
    ) then 'reserved' else 'draft' end,updated_at=now() where id=v_item.sale_id;
  end if;
  insert into public.sale_revisions(sale_id,sale_item_id,action,reason,details)
  values(v_item.sale_id,p_sale_item_id,'rereserve',v_reason,jsonb_build_object('before',v_before,'after',v_after,
    'fefo',p_inventory_balance_id is null,'letter_superseded',v_superseded));
  return jsonb_build_object('reservations',v_after,'letter_superseded',v_superseded);
end $$;

-- 6. Move the shipment date: the remaining shelf life of every reservation is recalculated for the new date.
create or replace function public.reschedule_customer_order(p_sale_id uuid,p_planned_shipment_date date,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s record; v_reason text:=nullif(btrim(coalesce(p_reason,'')),''); v_unfit text; v_superseded boolean;
begin
  if not (select private.has_permission('sales.manage')) then raise exception 'Нет права переносить отгрузку заказа' using errcode='42501'; end if;
  if v_reason is null then raise exception 'Укажите причину переноса отгрузки'; end if;
  if length(v_reason)>500 then raise exception 'Причина длиннее 500 символов'; end if;
  select * into s from public.sales where id=p_sale_id for update;
  if not found or s.status not in ('draft','reserved','confirmed') then raise exception 'Заказ недоступен для переноса отгрузки'; end if;
  if p_planned_shipment_date is null or p_planned_shipment_date<current_date or p_planned_shipment_date<s.sale_date then
    raise exception 'Новая дата отгрузки должна быть не раньше сегодняшнего дня и даты заказа';
  end if;
  if p_planned_shipment_date=s.planned_shipment_date then raise exception 'Дата отгрузки не изменилась'; end if;
  update public.sales set planned_shipment_date=p_planned_shipment_date,updated_at=now() where id=s.id;
  update public.inventory_reservations r
     set remaining_shelf_life_pct=private.sale_shelf_life_pct(b.expiry_date,b.manufacture_date,p.shelf_life_days,p_planned_shipment_date),updated_at=now()
    from public.sale_items i, public.inventory_batches b, public.products p
   where r.sale_item_id=i.id and i.sale_id=s.id and r.status='active' and b.id=r.batch_id and p.id=i.product_id;
  select string_agg(distinct b.batch_number,', ' order by b.batch_number) into v_unfit
  from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id join public.inventory_batches b on b.id=r.batch_id
  where i.sale_id=s.id and r.status='active' and (b.status<>'available' or b.expiry_date<p_planned_shipment_date);
  v_superseded := private.sync_sale_guarantee_letters(s.id, 'Отгрузка перенесена: '||v_reason);
  insert into public.sale_revisions(sale_id,action,reason,details)
  values(s.id,'reschedule',v_reason,jsonb_build_object('from',s.planned_shipment_date,'to',p_planned_shipment_date,
    'unfit_batches',v_unfit,'letter_superseded',v_superseded));
  return jsonb_build_object('unfit_batches',v_unfit,'letter_superseded',v_superseded);
end $$;

-- 7. Confirmation refuses batches that cannot be shipped on the shipment date.
create or replace function public.confirm_customer_order(p_sale_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_planned date; v_unfit text;
begin
  if not (select private.has_permission('sales.manage')) then raise exception 'Нет права подтверждать клиентские заказы'; end if;
  select planned_shipment_date into v_planned from public.sales where id=p_sale_id and status='reserved' for update;
  if not found then raise exception 'Полностью зарезервируйте заказ перед подтверждением'; end if;
  select string_agg(distinct b.batch_number,', ' order by b.batch_number) into v_unfit
  from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id join public.inventory_batches b on b.id=r.batch_id
  where i.sale_id=p_sale_id and r.status='active' and (b.status<>'available' or b.expiry_date<greatest(v_planned,current_date));
  if v_unfit is not null then
    raise exception 'Партии % заблокированы, в карантине или просрочены к дате отгрузки: перерезервируйте позиции', v_unfit;
  end if;
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

-- 8. A guarantee letter also for a confirmed order; a new one only when no current letter is fixed.
create or replace function public.create_sale_guarantee_letter(p_sale_id uuid, p_notes text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_sale record; v_current record; v_id uuid; v_number text;
begin
  if not (select private.has_permission('guarantee_letters.manage')) then raise exception 'Нет права создавать гарантийные письма'; end if;
  select * into v_sale from public.sales where id=p_sale_id and status in ('draft','reserved','confirmed') for update;
  if not found then raise exception 'Заказ недоступен для гарантийного письма'; end if;
  select id,status,letter_number into v_current from public.guarantee_letters
  where sale_id=p_sale_id and reason='low_shelf_life' and status in ('draft','approved','sent','accepted') for update;
  if found and v_current.status<>'draft' then
    raise exception 'У заказа уже есть действующее гарантийное письмо %: при замене партий или переносе отгрузки оно заменяется новым', v_current.letter_number;
  end if;
  if not exists(select 1 from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id where i.sale_id=p_sale_id and r.status='active' and i.required_shelf_life_pct is not null and r.remaining_shelf_life_pct<i.required_shelf_life_pct) then raise exception 'В заказе нет партий с ОСГ ниже требования клиента'; end if;
  if v_current.id is null then
    v_number:=format('GL-%s-%s',extract(year from current_date)::int,lpad(nextval('public.guarantee_letter_number_seq')::text,6,'0'));
    insert into public.guarantee_letters(letter_number,customer_id,sale_id,notes) values(v_number,v_sale.customer_id,p_sale_id,nullif(trim(p_notes),''))
    returning id into v_id;
  else
    v_id := v_current.id;
    update public.guarantee_letters set notes=nullif(trim(p_notes),''),updated_at=now() where id=v_id;
  end if;
  delete from public.guarantee_letter_items where guarantee_letter_id=v_id;
  insert into public.guarantee_letter_items(guarantee_letter_id,sale_item_id,batch_id,quantity,remaining_shelf_life_pct,required_shelf_life_pct)
  select v_id,i.id,r.batch_id,sum(r.sale_quantity),min(r.remaining_shelf_life_pct),i.required_shelf_life_pct
  from public.sale_items i join public.inventory_reservations r on r.sale_item_id=i.id and r.status='active'
  where i.sale_id=p_sale_id and i.required_shelf_life_pct is not null and r.remaining_shelf_life_pct<i.required_shelf_life_pct
  group by i.id,r.batch_id,i.required_shelf_life_pct;
  return v_id;
end $$;

-- 9. Accepted, rejected, cancelled and superseded letters are final: before, any status could follow them.
create or replace function public.change_sale_guarantee_status(p_letter_id uuid, p_status text)
returns void language plpgsql security definer set search_path='' as $$
declare v_old text;
begin
  if not (select private.has_permission('guarantee_letters.manage')) then raise exception 'Нет права изменять гарантийные письма'; end if;
  select status into v_old from public.guarantee_letters where id=p_letter_id for update;
  if not found then raise exception 'Гарантийное письмо не найдено'; end if;
  if v_old not in ('draft','approved','sent') or (v_old='draft' and p_status<>'approved') or (v_old='approved' and p_status not in ('sent','cancelled')) or (v_old='sent' and p_status not in ('accepted','rejected')) then raise exception 'Недопустимый переход статуса гарантийного письма'; end if;
  update public.guarantee_letters set status=p_status,
    approved_by=case when p_status='approved' then auth.uid() else approved_by end,
    approved_at=case when p_status='approved' then now() else approved_at end,
    sent_at=case when p_status='sent' then now() else sent_at end,
    customer_decision_at=case when p_status in ('accepted','rejected') then now() else customer_decision_at end,updated_at=now()
  where id=p_letter_id;
end $$;

-- 10. Blocking a batch warns whoever created or confirmed an open order reserved on it.
create or replace function public.set_inventory_batch_status(p_batch_id uuid, p_status text, p_reason text default null)
returns void language plpgsql security definer set search_path='' as $$
declare
  v_has_stock boolean; v_batch_number text; o record; v_recipient uuid;
begin
  if not (select private.has_permission('inventory.control')) then
    raise exception 'Недостаточно прав для управления состоянием партии';
  end if;
  if p_status not in ('available','quarantine','blocked') then
    raise exception 'Некорректное состояние партии';
  end if;
  if p_status in ('quarantine','blocked') and nullif(trim(p_reason),'') is null then
    raise exception 'Укажите причину блокировки или карантина';
  end if;

  select batch_number into v_batch_number from public.inventory_batches where id=p_batch_id for update;
  if not found then raise exception 'Партия не найдена'; end if;
  select exists(
    select 1 from public.inventory_balances
    where batch_id=p_batch_id and quantity_on_hand>0
  ) into v_has_stock;
  if p_status='available' and not v_has_stock then
    raise exception 'Нельзя разблокировать партию без остатка';
  end if;

  update public.inventory_batches set
    status=p_status,
    status_reason=case when p_status='available' then null else trim(p_reason) end,
    status_changed_by=auth.uid(),
    status_changed_at=now(),
    updated_at=now()
  where id=p_batch_id;

  if p_status in ('quarantine','blocked') then
    for o in
      select distinct s.id,s.sale_number,s.created_by,s.confirmed_by
      from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id join public.sales s on s.id=i.sale_id
      where r.batch_id=p_batch_id and r.status='active' and s.status in ('draft','reserved','confirmed')
    loop
      foreach v_recipient in array array_remove(array[o.created_by, case when o.confirmed_by is distinct from o.created_by then o.confirmed_by end], null) loop
        if private.user_has_permission(v_recipient,'sales.view') then
          perform private.notify(v_recipient,'status_change',
            format('Партия %s %s: заказ %s', v_batch_number, case p_status when 'blocked' then 'заблокирована' else 'в карантине' end, o.sale_number),
            format('Резерв заказа на этой партии отгрузить нельзя. Откройте заказ и перерезервируйте позицию. Причина: %s', trim(p_reason)),
            'sale', o.id, null, format('batch-status:%s:%s:%s', p_batch_id, o.id, extract(epoch from now())));
        end if;
      end loop;
    end loop;
  end if;
end $$;

do $$declare f text;begin foreach f in array array[
 'public.reserve_customer_order_item_fefo(uuid)','public.reserve_customer_order_item_override(uuid,uuid,text)',
 'public.rereserve_customer_order_item(uuid,uuid,text)','public.reschedule_customer_order(uuid,date,text)',
 'public.confirm_customer_order(uuid)','public.create_sale_guarantee_letter(uuid,text)','public.change_sale_guarantee_status(uuid,text)',
 'public.set_inventory_batch_status(uuid,text,text)'] loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);execute format('grant execute on function %s to authenticated',f);end loop;end $$;
