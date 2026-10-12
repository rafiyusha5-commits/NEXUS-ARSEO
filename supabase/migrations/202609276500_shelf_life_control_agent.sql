-- Agent «Контроль ОСГ» (remaining shelf life control).
--
-- For every available batch with free stock the agent finds, per customer, the last day on which the
-- batch still meets that customer's minimum remaining shelf life (ОСГ), and lists the batches where
-- that day falls within the horizon (30 days by default) or has already passed. Fixed rules only:
-- no language model, nothing leaves the database.
--
-- Customers of a product: those with a not cancelled order of the product in the last 365 days and
-- those with an active contract term for the product. The requirement is taken from, in this order:
--   1. an active contract term «min_remaining_shelf_life_pct» for this product;
--   2. an active general term of the customer's contract;
--   3. the customer card (counterparties.min_remaining_shelf_life_pct);
--   4. 70 % — marked «по умолчанию».
-- A product without customers is checked against the default 70 %.
--
-- The agent writes nothing into batches, balances, orders or reservations. Its only writes are the
-- daily in-app summary to every employee who may see the stock; nothing is sent outside Nexus.

-- 1. Rules ----------------------------------------------------------------------------------------

create or replace function private.shelf_life_default_pct()
returns numeric
language sql
immutable
set search_path = ''
as $$
  select 70::numeric
$$;

-- The last day a batch still meets p_required_pct by the sales rule itself: private.sale_shelf_life_pct
-- (shelf life from the manufacture date, otherwise the product's shelf life in days; the percentage is
-- rounded to two digits). The exact day is near expiry - required * shelf life / 100; the days around it
-- are checked with the sales function, so rounding can never make the two disagree. Never after the
-- expiry date, as reservations do not take expired batches. Null when the shelf life is unknown.
create or replace function private.shelf_life_last_ok_day(
  p_expiry date, p_manufacture date, p_shelf_days integer, p_required_pct numeric)
returns date
language sql
immutable
set search_path = ''
as $$
  select case
    when p_expiry is null or p_required_pct is null or (p_manufacture is null and p_shelf_days is null) then null
    else (
      select least(max(a.approx + g.k), p_expiry)
      from (select p_expiry - ceil(p_required_pct * greatest(1, coalesce(p_expiry - p_manufacture, p_shelf_days)) / 100.0)::integer as approx) a
      cross join generate_series(-2, 2) as g(k)
      where private.sale_shelf_life_pct(p_expiry, p_manufacture, p_shelf_days, a.approx + g.k) >= p_required_pct)
  end
$$;

-- Requirement of one customer for one product on a day, with where it comes from.
create or replace function private.shelf_life_requirement(p_customer uuid, p_product uuid, p_today date,
  out required_pct numeric, out source text)
language sql
stable
security definer
set search_path = ''
as $$
  with terms as (
    select t.product_id, t.value_numeric
    from public.contract_terms t
    join public.contracts c on c.id = t.contract_id
    where c.counterparty_id = p_customer and c.status = 'active' and c.archived_at is null
      and t.term_type = 'min_remaining_shelf_life_pct' and t.value_numeric between 0 and 100
      and (t.product_id is null or t.product_id = p_product)
      and (c.valid_from is null or c.valid_from <= p_today) and (c.valid_to is null or c.valid_to >= p_today)
      and (t.valid_from is null or t.valid_from <= p_today) and (t.valid_to is null or t.valid_to >= p_today)
  )
  select coalesce((select max(value_numeric) from terms where product_id = p_product),
                  (select max(value_numeric) from terms where product_id is null),
                  cp.min_remaining_shelf_life_pct,
                  private.shelf_life_default_pct()),
         case when exists (select 1 from terms where product_id = p_product) then 'contract_product'
              when exists (select 1 from terms where product_id is null) then 'contract'
              when cp.min_remaining_shelf_life_pct is not null then 'client'
              else 'default' end
  from public.counterparties cp
  where cp.id = p_customer
$$;

-- Batches at risk within p_horizon days, newest problems first. The risk is always calculated with the
-- real requirements of all customers. With p_mask_hidden the customers the signed-in employee may not see
-- are shown only as one anonymous group per batch (how many, the earliest deadline, the worst state):
-- no names, ids, percentages or sources. The daily summary passes false and counts the same risk.
-- Dropped first: an earlier draft named the last parameter differently.
drop function if exists private.shelf_life_risks(date, integer, boolean);
create or replace function private.shelf_life_risks(p_today date, p_horizon integer, p_mask_hidden boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with free as (
    select bal.batch_id, bal.uom, sum(bal.quantity_on_hand - bal.quantity_reserved) as quantity
    from public.inventory_balances bal
    where bal.quantity_on_hand > bal.quantity_reserved
    group by bal.batch_id, bal.uom
  ), batches as (
    select b.id, b.batch_number, b.product_id, b.expiry_date, b.manufacture_date, p.shelf_life_days,
           p.internal_sku, coalesce(p.name ->> 'ru', p.name ->> 'en', p.internal_sku) as product_name,
           (b.manufacture_date is not null or p.shelf_life_days is not null) as known,
           -- Unknown shelf life: no percentage at all rather than an invented one.
           case when b.manufacture_date is not null or p.shelf_life_days is not null
                then private.sale_shelf_life_pct(b.expiry_date, b.manufacture_date, p.shelf_life_days, p_today) end as remaining_pct,
           (select jsonb_agg(jsonb_build_object('uom', f.uom, 'quantity', f.quantity) order by f.uom) from free f where f.batch_id = b.id) as quantities,
           (select string_agg(distinct w.code, ', ' order by w.code)
              from public.inventory_balances bal join public.warehouses w on w.id = bal.warehouse_id
              where bal.batch_id = b.id and bal.quantity_on_hand > bal.quantity_reserved) as warehouses
    from public.inventory_batches b
    join public.products p on p.id = b.product_id
    where b.status = 'available' and exists (select 1 from free f where f.batch_id = b.id)
  ), customers as (
    select s.customer_id, si.product_id
    from public.sales s join public.sale_items si on si.sale_id = s.id
    where s.status <> 'cancelled' and s.sale_date >= p_today - 365
    union
    select c.counterparty_id, t.product_id
    from public.contract_terms t join public.contracts c on c.id = t.contract_id
    where t.term_type = 'min_remaining_shelf_life_pct' and t.product_id is not null and c.status = 'active' and c.archived_at is null
  ), product_customers as (
    select cu.customer_id, cu.product_id, coalesce(cp.short_name, cp.legal_name) as customer_name,
           not p_mask_hidden or (select private.can_access_counterparty_record('view', cu.customer_id)) as visible
    from customers cu
    join public.counterparties cp on cp.id = cu.customer_id and cp.status = 'active'
  ), per_customer as (
    select b.id as batch_id, pc.customer_id, pc.customer_name, pc.visible, r.required_pct, r.source,
           private.shelf_life_last_ok_day(b.expiry_date, b.manufacture_date, b.shelf_life_days, r.required_pct) as last_ok
    from batches b
    join product_customers pc on pc.product_id = b.product_id
    cross join lateral private.shelf_life_requirement(pc.customer_id, b.product_id, p_today) r
    where b.known
    union all
    -- Products without any customer: the default requirement for any customer.
    select b.id, null, null, true, private.shelf_life_default_pct(), 'default',
           private.shelf_life_last_ok_day(b.expiry_date, b.manufacture_date, b.shelf_life_days, private.shelf_life_default_pct())
    from batches b
    where b.known and not exists (select 1 from product_customers pc where pc.product_id = b.product_id)
  ), rated as (
    select pc.*,
           case when pc.last_ok < p_today then 'below' when pc.last_ok < p_today + p_horizon then 'soon' else 'ok' end as state
    from per_customer pc
  ), entries as (
    select r.batch_id, r.state, r.last_ok, r.customer_name as sort_name,
           jsonb_strip_nulls(jsonb_build_object(
             'customer_id', r.customer_id, 'customer_name', r.customer_name,
             'required_pct', r.required_pct, 'source', r.source, 'last_ok_day', r.last_ok, 'state', r.state,
             -- Below the requirement but not expired: a guarantee letter may still allow the sale.
             'guarantee_letter', r.state = 'below' and b.expiry_date >= p_today)) as entry
    from rated r join batches b on b.id = r.batch_id
    where r.visible
    union all
    select r.batch_id,
           case when bool_or(r.state = 'below') then 'below' when bool_or(r.state = 'soon') then 'soon' else 'ok' end,
           min(r.last_ok), null,
           jsonb_build_object(
             'hidden_count', count(*), 'last_ok_day', min(r.last_ok),
             'state', case when bool_or(r.state = 'below') then 'below' when bool_or(r.state = 'soon') then 'soon' else 'ok' end,
             'guarantee_letter', bool_or(r.state = 'below' and b.expiry_date >= p_today))
    from rated r join batches b on b.id = r.batch_id
    where not r.visible
    group by r.batch_id
  ), at_risk as (
    -- Expired batches with free stock are listed even when their shelf life cannot be calculated.
    select b.*, min(r.last_ok) as first_deadline,
           case when b.expiry_date < p_today then 'expired'
                when bool_or(r.state = 'below') then 'below'
                else 'soon' end as state,
           coalesce((select jsonb_agg(e.entry order by case e.state when 'soon' then 0 when 'ok' then 1 else 2 end, e.last_ok, e.sort_name nulls last)
                     from entries e where e.batch_id = b.id), '[]'::jsonb) as customers
    from batches b
    left join rated r on r.batch_id = b.id
    group by b.id, b.batch_number, b.product_id, b.expiry_date, b.manufacture_date, b.shelf_life_days,
             b.internal_sku, b.product_name, b.known, b.remaining_pct, b.quantities, b.warehouses
    having b.expiry_date < p_today or min(r.last_ok) < p_today + p_horizon
  )
  select jsonb_build_object(
    'today', p_today,
    'horizon_days', p_horizon,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'batch_id', a.id, 'batch_number', a.batch_number, 'product_id', a.product_id,
               'internal_sku', a.internal_sku, 'product_name', a.product_name,
               'expiry_date', a.expiry_date, 'manufacture_date', a.manufacture_date,
               'remaining_pct', a.remaining_pct, 'quantities', a.quantities, 'warehouses', a.warehouses,
               'state', a.state, 'first_deadline', a.first_deadline, 'customers', a.customers)
             order by case a.state when 'expired' then 0 when 'below' then 1 else 2 end, a.first_deadline, a.expiry_date, a.internal_sku)
      from at_risk a), '[]'::jsonb),
    -- Batches whose shelf life cannot be calculated (no manufacture date and no shelf life of the product)
    -- and that are not expired: expired ones are already listed above.
    'unknown_count', (select count(*) from batches b where not b.known and b.expiry_date >= p_today))
$$;

-- 2. Functions for the application ----------------------------------------------------------------

create or replace function private.shelf_life_today()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone 'Asia/Qyzylorda')::date
$$;

-- The «Сроки годности под риском» screen. Reads only; needs inventory.view and products.view.
create or replace function public.shelf_life_risks(p_horizon_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (select private.has_permission('inventory.view')) or not (select private.has_permission('products.view')) then
    raise exception 'Нет доступа к остаткам' using errcode = '42501';
  end if;
  if p_horizon_days is null or p_horizon_days not between 1 and 365 then
    raise exception 'Горизонт прогноза — от 1 до 365 дней';
  end if;
  return private.shelf_life_risks(private.shelf_life_today(), p_horizon_days, true);
end;
$$;

-- Daily summary for a scheduled job (pg_cron in the database or a server job with the secret key).
-- One notification per employee and day, only when there is something at risk. Returns the number of
-- notifications created.
create or replace function public.run_shelf_life_control(p_today date default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := coalesce(p_today, private.shelf_life_today());
  v_risks jsonb := private.shelf_life_risks(v_today, 30, false);
  v_total integer;
  v_below integer;
  v_expired integer;
  v_body text;
  v_user uuid;
  v_count integer := 0;
begin
  select count(*), count(*) filter (where i ->> 'state' = 'below'), count(*) filter (where i ->> 'state' = 'expired')
    into v_total, v_below, v_expired
  from jsonb_array_elements(v_risks -> 'items') i;
  if v_total = 0 then
    return 0;
  end if;
  -- Counts only: product and customer names stay on the screen, behind its access rules.
  v_body := concat_ws(' ',
    'Партий, у которых в ближайшие 30 дней ОСГ опустится ниже требований клиентов: ' || (v_total - v_below - v_expired) || '.',
    case when v_below > 0 then 'Уже ниже требований: ' || v_below || '.' end,
    case when v_expired > 0 then 'Срок годности истёк: ' || v_expired || '.' end,
    'Откройте «Сроки годности под риском», чтобы увидеть, каким клиентам отгружать в первую очередь.');
  for v_user in select p.id from public.profiles p where p.is_active order by p.id loop
    -- user_has_permission() also requires an active employee.
    if private.user_has_permission(v_user, 'inventory.view') and private.user_has_permission(v_user, 'products.view') then
      if private.notify(v_user, 'low_shelf_life', 'Контроль ОСГ: партий под риском — ' || v_total, v_body,
                        'shelf_life_control', null, null, 'shelf_life_daily:' || v_today) then
        v_count := v_count + 1;
      end if;
    end if;
  end loop;
  return v_count;
end;
$$;

-- 3. Privileges ------------------------------------------------------------------------------------

revoke all on function private.shelf_life_default_pct() from public, anon, authenticated, service_role;
revoke all on function private.shelf_life_last_ok_day(date, date, integer, numeric) from public, anon, authenticated, service_role;
revoke all on function private.shelf_life_requirement(uuid, uuid, date) from public, anon, authenticated, service_role;
revoke all on function private.shelf_life_risks(date, integer, boolean) from public, anon, authenticated, service_role;
revoke all on function private.shelf_life_today() from public, anon, authenticated, service_role;

revoke all on function public.shelf_life_risks(integer) from public, anon, service_role;
grant execute on function public.shelf_life_risks(integer) to authenticated;
revoke all on function public.run_shelf_life_control(date) from public, anon, authenticated;
grant execute on function public.run_shelf_life_control(date) to service_role;

comment on function public.shelf_life_risks(integer) is
  'Agent «Контроль ОСГ»: batches whose remaining shelf life falls below customer requirements within the horizon; read only';
comment on function public.run_shelf_life_control(date) is
  'Agent «Контроль ОСГ»: daily in-app summary to employees with inventory.view; service_role only (pg_cron or a server job)';
