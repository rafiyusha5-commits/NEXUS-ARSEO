-- A confirmed order that can no longer ship tells its people; its planned shipment date can be moved.
-- Follow-up of 202609278900 (what prevents shipping) on the recovery model of 202609278100.
--
-- Notifications. The order's creator and the employee who confirmed it (with sales.view) get an "order_blocked"
-- notification naming the problem:
--   at once, when a batch reserved by a confirmed order is blocked or put in quarantine (trigger on the batch);
--   when the notifications are refreshed (the notifications page, the order list), for what time brings: a reserved
--   batch expired, or its shelf life fell below the required share without a valid guarantee letter.
-- Each problem is notified once (dedupe key); a batch blocked again after being released is notified again.
--
-- Rescheduling. reschedule_customer_order moves the planned shipment date of an order not shipped or cancelled, with
-- a reason kept in sale_shipment_date_changes. A confirmed order moves only if it can still ship on the new date by
-- the rules of the shipment (batches last until then, shelf life or a valid letter on that date); otherwise the
-- problems are named and the order goes back to preparation as before. Reservations and letters are not changed.
begin;

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'deadline', 'overdue', 'approval_request', 'approval_decision', 'status_change', 'discrepancy',
  'low_shelf_life', 'document_uploaded', 'sync_error', 'system',
  'task_assigned', 'task_reassigned', 'stage_blocked', 'order_blocked'));

-- ---------- one set of rules for the list, the notifications and rescheduling ----------
create or replace function private.customer_order_blockers(p_sale_id uuid, p_on_date date default null)
returns table(code text, message text, sale_item_id uuid, batch_id uuid)
language plpgsql security definer set search_path='' as $$
declare s public.sales; v_today date; v_ship date; v_expiry_day date; v_line record; v_pct numeric;
begin
  select * into s from public.sales where id=p_sale_id;
  if not found then raise exception 'Заказ не найден'; end if;
  if s.status<>'confirmed' then return; end if;
  v_today:=private.business_today();
  -- A new planned date (rescheduling) is checked as confirmation checks it: the batch has to last until then.
  v_ship:=greatest(v_today,coalesce(p_on_date,s.planned_shipment_date));
  v_expiry_day:=case when p_on_date is null then v_today else v_ship end;

  if not exists(select 1 from public.sale_items where sale_id=s.id) then
    return query select 'no_items'::text,'В заказе нет товаров'::text,null::uuid,null::uuid;
  end if;
  return query
    select 'not_reserved'::text,
      format('%s: зарезервировано %s из %s',p.internal_sku,
        trim(to_char(coalesce(sum(r.sale_quantity) filter (where r.status='active'),0),'FM999999999990.###')),
        trim(to_char(i.quantity,'FM999999999990.###'))),
      i.id,null::uuid
    from public.sale_items i join public.products p on p.id=i.product_id
    left join public.inventory_reservations r on r.sale_item_id=i.id
    where i.sale_id=s.id
    group by i.id,i.quantity,p.internal_sku
    having i.quantity<>coalesce(sum(r.sale_quantity) filter (where r.status='active'),0)
        or bool_or(r.status='fulfilled');

  for v_line in
    select distinct on (r.sale_item_id,r.batch_id)
      r.sale_item_id,r.batch_id,i.required_shelf_life_pct,p.internal_sku,x.batch_number,x.status batch_status,x.status_reason,
      x.expiry_date,x.manufacture_date,p.shelf_life_days,
      bool_or(r.batch_id<>b.batch_id or i.product_id<>x.product_id or b.warehouse_id<>s.warehouse_id or r.uom<>b.uom)
        over (partition by r.sale_item_id,r.batch_id) mismatch,
      sum(r.sale_quantity) over (partition by r.sale_item_id,r.batch_id) batch_sale_quantity,
      min(r.remaining_shelf_life_pct) over (partition by r.sale_item_id,r.batch_id) batch_shelf_life_pct
    from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
    join public.inventory_balances b on b.id=r.inventory_balance_id join public.inventory_batches x on x.id=r.batch_id
    join public.products p on p.id=i.product_id
    where i.sale_id=s.id and r.status='active'
    order by r.sale_item_id,r.batch_id
  loop
    if v_line.mismatch then
      return query select 'reservation_mismatch'::text,
        format('%s, партия %s: резерв не соответствует товару, складу или единице остатка',v_line.internal_sku,v_line.batch_number),
        v_line.sale_item_id,v_line.batch_id;
    end if;
    if v_line.batch_status<>'available' then
      return query select 'batch_unavailable'::text,
        format('%s, партия %s: %s%s',v_line.internal_sku,v_line.batch_number,
          case v_line.batch_status when 'blocked' then 'заблокирована' when 'quarantine' then 'в карантине'
            when 'depleted' then 'израсходована' else v_line.batch_status end,
          coalesce(' — '||nullif(trim(v_line.status_reason),''),'')),
        v_line.sale_item_id,v_line.batch_id;
    end if;
    if v_line.expiry_date<v_expiry_day then
      return query select 'batch_expired'::text,
        format(case when v_line.expiry_date<v_today then '%s, партия %s: просрочена (годна до %s)' else '%s, партия %s: истечёт до отгрузки (годна до %s)' end,v_line.internal_sku,v_line.batch_number,to_char(v_line.expiry_date,'DD.MM.YYYY')),
        v_line.sale_item_id,v_line.batch_id;
    end if;
    -- A batch on hold or expired has to be replaced anyway; its shelf life adds nothing to say.
    if v_line.batch_status<>'available' or v_line.expiry_date<v_expiry_day then continue; end if;
    v_pct:=private.sale_shelf_life_pct(v_line.expiry_date,v_line.manufacture_date,v_line.shelf_life_days,v_ship);
    if v_line.required_shelf_life_pct is not null and v_pct<v_line.required_shelf_life_pct and not exists(
      select 1 from public.guarantee_letters g join public.guarantee_letter_items gi on gi.guarantee_letter_id=g.id
      where g.sale_id=s.id and g.status in ('approved','sent','accepted') and gi.sale_item_id=v_line.sale_item_id
        and gi.batch_id=v_line.batch_id and gi.quantity=v_line.batch_sale_quantity and gi.required_shelf_life_pct=v_line.required_shelf_life_pct
        and gi.remaining_shelf_life_pct=v_line.batch_shelf_life_pct and v_pct>=gi.remaining_shelf_life_pct
    ) then
      return query select 'shelf_life_letter'::text,
        format('%s, партия %s: остаточный срок %s%% ниже требуемых %s%% — нужно действующее гарантийное письмо на эту партию и количество',
          v_line.internal_sku,v_line.batch_number,trim(to_char(v_pct,'FM990.##')),trim(to_char(v_line.required_shelf_life_pct,'FM990.##'))),
        v_line.sale_item_id,v_line.batch_id;
    end if;
  end loop;

  return query
    select distinct 'stock_mismatch'::text,
      format('Партия %s: остаток или резервы на складе не сходятся с резервами заказов',x.batch_number),
      null::uuid,b.batch_id
    from public.inventory_balances b join public.inventory_batches x on x.id=b.batch_id
    where b.id in (select r.inventory_balance_id from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
                   where i.sale_id=s.id and r.status='active')
      and (b.quantity_reserved<>(select coalesce(sum(q.quantity),0) from public.inventory_reservations q
                                 where q.inventory_balance_id=b.id and q.status='active')
        or b.quantity_on_hand<(select coalesce(sum(q.quantity),0) from public.inventory_reservations q join public.sale_items qi on qi.id=q.sale_item_id
                               where q.inventory_balance_id=b.id and q.status='active' and qi.sale_id=s.id));
end $$;
revoke all on function private.customer_order_blockers(uuid,date) from public,anon,authenticated,service_role;

create or replace function public.customer_order_shipping_blockers(p_sale_id uuid)
returns table(code text, message text, sale_item_id uuid, batch_id uuid)
language plpgsql security definer set search_path='' as $$
begin
  -- The same visibility as the order itself (RLS of sales is sales.view).
  if not (select private.has_permission('sales.view')) then
    raise exception 'Нет доступа к заказам' using errcode='42501';
  end if;
  return query select * from private.customer_order_blockers(p_sale_id);
end $$;
revoke all on function public.customer_order_shipping_blockers(uuid) from public,anon,authenticated,service_role;
grant execute on function public.customer_order_shipping_blockers(uuid) to authenticated;

-- ---------- notifications ----------
-- Notify the people of a confirmed order about its current problems with the given codes (and batch, if any).
create or replace function private.notify_order_blockers(p_sale_id uuid, p_codes text[], p_batch_id uuid default null, p_event text default '')
returns integer language plpgsql security definer set search_path='' as $$
declare s public.sales; v_blocker record; v_user uuid; v_count integer:=0;
begin
  select * into s from public.sales where id=p_sale_id;
  if not found or s.status<>'confirmed' then return 0; end if;
  for v_blocker in select * from private.customer_order_blockers(p_sale_id) b
    where b.code=any(p_codes) and (p_batch_id is null or b.batch_id=p_batch_id) loop
    for v_user in select distinct u from unnest(array[s.created_by,s.confirmed_by]) u
      where u is not null and private.user_has_permission(u,'sales.view') loop
      if private.notify(v_user,'order_blocked','Заказ '||s.sale_number||' нельзя отгрузить',
        v_blocker.message||'. Верните заказ к подготовке и замените резерв или оформите гарантийное письмо.',
        'sale',s.id,null,
        'order_blocked:'||s.id||':'||v_blocker.code||':'||coalesce(v_blocker.batch_id,v_blocker.sale_item_id,s.id)||p_event) then
        v_count:=v_count+1;
      end if;
    end loop;
  end loop;
  return v_count;
end $$;
revoke all on function private.notify_order_blockers(uuid,text[],uuid,text) from public,anon,authenticated,service_role;

-- At once: a batch reserved by confirmed orders is blocked or put in quarantine.
create or replace function private.notify_orders_on_batch_hold()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_sale uuid;
begin
  for v_sale in select distinct i.sale_id from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
    join public.sales s on s.id=i.sale_id
    where r.batch_id=new.id and r.status='active' and s.status='confirmed' loop
    perform private.notify_order_blockers(v_sale,array['batch_unavailable'],new.id,
      ':'||new.status||':'||extract(epoch from coalesce(new.status_changed_at,now()))::bigint);
  end loop;
  return null;
end $$;
revoke all on function private.notify_orders_on_batch_hold() from public,anon,authenticated,service_role;
drop trigger if exists notify_orders_on_batch_hold on public.inventory_batches;
create trigger notify_orders_on_batch_hold after update of status on public.inventory_batches
  for each row when (old.status='available' and new.status in ('blocked','quarantine'))
  execute function private.notify_orders_on_batch_hold();

-- What time brings: expired batches and shelf life below the required share, for the orders of one employee
-- (or of everybody when p_user is null).
create or replace function private.generate_order_blocker_notifications(p_user uuid)
returns integer language plpgsql security definer set search_path='' as $$
declare v_sale uuid; v_count integer:=0;
begin
  for v_sale in select s.id from public.sales s
    where s.status='confirmed' and (p_user is null or p_user in (s.created_by,s.confirmed_by)) order by s.id loop
    v_count:=v_count+private.notify_order_blockers(v_sale,array['batch_expired','shelf_life_letter']);
  end loop;
  return v_count;
end $$;
revoke all on function private.generate_order_blocker_notifications(uuid) from public,anon,authenticated,service_role;

create or replace function public.refresh_my_order_notifications()
returns integer language plpgsql security definer set search_path='' as $$
begin
  if not (select private.has_permission('sales.view')) then
    raise exception 'Нет доступа к заказам' using errcode='42501';
  end if;
  return private.generate_order_blocker_notifications((select auth.uid()));
end $$;
revoke all on function public.refresh_my_order_notifications() from public,anon,authenticated,service_role;
grant execute on function public.refresh_my_order_notifications() to authenticated;

-- ---------- rescheduling ----------
create table if not exists public.sale_shipment_date_changes(
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  previous_date date not null,
  new_date date not null,
  reason text not null check (length(trim(reason))>0),
  changed_by uuid references public.profiles(id) on delete set null default auth.uid(),
  changed_at timestamptz not null default now()
);
create index if not exists sale_shipment_date_changes_sale_idx on public.sale_shipment_date_changes(sale_id,changed_at desc);
create index if not exists sale_shipment_date_changes_changed_by_idx on public.sale_shipment_date_changes(changed_by) where changed_by is not null;
alter table public.sale_shipment_date_changes enable row level security;
revoke all on public.sale_shipment_date_changes from public,anon,authenticated,service_role;
grant select on public.sale_shipment_date_changes to authenticated;
drop policy if exists "employees view shipment date changes" on public.sale_shipment_date_changes;
create policy "employees view shipment date changes" on public.sale_shipment_date_changes
  for select to authenticated using ((select private.has_permission('sales.view')));

create or replace function public.reschedule_customer_order(p_sale_id uuid, p_date date, p_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare s public.sales; v_reason text:=nullif(trim(p_reason),''); v_problems text;
begin
  if auth.uid() is null or not private.has_permission('sales.view') or not private.has_permission('sales.manage') then
    raise exception 'Недостаточно прав для переноса отгрузки' using errcode='42501';
  end if;
  if v_reason is null then raise exception 'Укажите причину переноса отгрузки'; end if;
  if p_date is null then raise exception 'Укажите новую дату отгрузки'; end if;
  -- The same lock as shipping and recovery: the order cannot ship or change while it is being moved.
  select * into s from public.sales where id=p_sale_id for update;
  if not found then raise exception 'Заказ не найден'; end if;
  if s.status not in ('draft','reserved','confirmed') then
    raise exception 'Перенести можно только неотгруженный и неотменённый заказ';
  end if;
  if p_date<private.business_today() then raise exception 'Новая дата отгрузки не может быть в прошлом'; end if;
  if p_date<s.sale_date then raise exception 'Дата отгрузки не может быть раньше даты заказа'; end if;
  if p_date=s.planned_shipment_date then raise exception 'Дата отгрузки не изменилась'; end if;
  if s.status='confirmed' then
    perform 1 from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
      where i.sale_id=s.id order by r.id for update of r;
    select string_agg(b.message,'; ' order by b.message) into v_problems from private.customer_order_blockers(s.id,p_date) b;
    if v_problems is not null then
      raise exception 'С новой датой заказ нельзя отгрузить: %. Верните заказ к подготовке или выберите другую дату',v_problems;
    end if;
  end if;
  update public.sales set planned_shipment_date=p_date,updated_at=now() where id=s.id;
  insert into public.sale_shipment_date_changes(sale_id,previous_date,new_date,reason) values(s.id,s.planned_shipment_date,p_date,v_reason);
  return s.id;
end $$;
revoke all on function public.reschedule_customer_order(uuid,date,text) from public,anon,authenticated,service_role;
grant execute on function public.reschedule_customer_order(uuid,date,text) to authenticated;

commit;
