-- What prevents shipping a confirmed customer order, before anyone presses "Отгрузить".
--
-- fulfill_customer_order stops at the first problem it meets, so the employee learns about a blocked batch or a
-- missing guarantee letter only from a failed shipment, and about the next problem only after fixing the first.
-- customer_order_shipping_blockers lists every problem of the order at once, by the same rules as the shipment
-- (202609278100): the order is fully reserved; each reservation matches its product, warehouse and unit; the batch is
-- available and not expired on the business day; the shelf life on the later of today and the planned shipment date
-- reaches the required share or a valid guarantee letter covers this batch and quantity; the stock and the reserves
-- of the balance agree. It reads only; supabase/tests/order_shipping_blockers.test.sql checks it against the shipment.
begin;

create or replace function public.customer_order_shipping_blockers(p_sale_id uuid)
returns table(code text, message text, sale_item_id uuid, batch_id uuid)
language plpgsql security definer set search_path='' as $$
declare s public.sales; v_today date; v_line record; v_pct numeric;
begin
  -- The same visibility as the order itself (RLS of sales is sales.view).
  if not (select private.has_permission('sales.view')) then
    raise exception 'Нет доступа к заказам' using errcode='42501';
  end if;
  select * into s from public.sales where id=p_sale_id;
  if not found then raise exception 'Заказ не найден'; end if;
  if s.status<>'confirmed' then return; end if;
  v_today:=private.business_today();

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
    if v_line.expiry_date<v_today then
      return query select 'batch_expired'::text,
        format('%s, партия %s: просрочена (годна до %s)',v_line.internal_sku,v_line.batch_number,to_char(v_line.expiry_date,'DD.MM.YYYY')),
        v_line.sale_item_id,v_line.batch_id;
    end if;
    v_pct:=private.sale_shelf_life_pct(v_line.expiry_date,v_line.manufacture_date,v_line.shelf_life_days,greatest(v_today,s.planned_shipment_date));
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
revoke all on function public.customer_order_shipping_blockers(uuid) from public,anon,authenticated,service_role;
grant execute on function public.customer_order_shipping_blockers(uuid) to authenticated;

commit;
