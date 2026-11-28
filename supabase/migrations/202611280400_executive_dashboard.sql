-- Block Д (2026-11-28): the executive dashboard — one screen of tiles built from the reports that already exist.
-- Owner decisions of 2026-11-28 (damirator1-afk, defaults of the task accepted), see docs/executive-dashboard.md:
--   * the dashboard is for the administrator and the director roles (dashboard.executive.view); each tile appears only
--     with the rights to its data, otherwise it is not there at all — not on the screen, not in the answer (Д1);
--   * for those roles the dashboard is the start page (Д2, in the application);
--   * amounts per currency, with a tenge equivalent at today's official rate marked as an estimate (Д3);
--   * the current month against the previous one, any past month can be chosen (Д4).
-- Every figure comes from the function of the source report: profitability_report, customer_receivables,
-- payables_summary, cash_calendar (202611280200), loss_risk and loss_report (202611280100), operational_summary. The
-- tile function only picks and sums what those return. It runs with the rights of the employee (security invoker), so
-- tasks, notifications, orders and shipments are read through the same policies as on their screens. A tile whose source
-- fails says so ("status": "error") and never shows a zero; the other tiles are not affected.
begin;

insert into public.permissions(code, module, action, name, description)
values ('dashboard.executive.view', 'dashboard', 'executive_view', 'Дашборд руководителя',
        'Главный экран руководителя: плитки из отчётов, каждая — только при правах на её данные')
on conflict (code) do nothing;
insert into public.role_permissions(role_id, permission_id, granted)
select r.id, p.id, true
  from public.app_roles r
  join public.permissions p on p.code = 'dashboard.executive.view'
 where r.code in ('administrator', 'director', 'executive_director', 'commercial_director', 'logistics_director')
on conflict (role_id, permission_id) do nothing;

-- Official rate of a currency to tenge today (the last one within 7 days, as everywhere else), for estimates.
create or replace function public.dashboard_rate_kzt(p_currency_id uuid)
returns numeric
language sql stable security definer set search_path = '' as $$
  select r.rate
    from private.official_conversion(p_currency_id, (select id from public.currencies where code = 'KZT'), private.business_today()) r
$$;
revoke all on function public.dashboard_rate_kzt(uuid) from public, anon, authenticated, service_role;
grant execute on function public.dashboard_rate_kzt(uuid) to authenticated;

-- Payments due in the next p_days by the payment calendar (202611280200): the same items (private.cash_items: the rest of
-- confirmed expenses on the planned payment date, else the due date), without the customer side the calendar also
-- builds. Goods only with prices.purchase.view, as in the calendar.
create or replace function public.cash_payables_due(p_days integer)
returns jsonb
language plpgsql stable security definer set search_path = '' set jit = off as $$
declare
  v_today date := private.business_today();
  v_goods boolean := (select private.has_permission('prices.purchase.view'));
begin
  perform private.require_cash_view();
  if p_days is null or p_days not between 1 and 31 then
    raise exception 'Укажите от 1 до 31 дня';
  end if;
  return jsonb_build_object('from', v_today, 'to', v_today + p_days - 1, 'goods', v_goods,
    'currencies', coalesce((select jsonb_agg(jsonb_build_object('currency', c.code, 'amount', x.amount::text, 'items', x.n) order by c.code)
                              from (select i.currency_id, sum(i.amount) as amount, count(*) as n
                                      from private.cash_items(false, v_goods) i
                                     where i.kind = 'payable' and i.item_date between v_today and v_today + p_days - 1
                                     group by i.currency_id) x
                              join public.currencies c on c.id = x.currency_id), '[]'::jsonb));
end $$;
revoke all on function public.cash_payables_due(integer) from public, anon, authenticated, service_role;
grant execute on function public.cash_payables_due(integer) to authenticated;

-- One tile for the current employee; null when the employee has no rights to its data. p_month: any day of the month
-- (null: this month).
create or replace function public.executive_dashboard_tile(p_tile text, p_month date default null)
returns jsonb
language plpgsql stable security invoker set search_path = '' set jit = off as $$
declare
  v_today date := (now() at time zone 'Asia/Almaty')::date;
  v_month date := date_trunc('month', coalesce(p_month, (now() at time zone 'Asia/Almaty')::date))::date;
  v_month_end date;
  v_prev date;
  v_prev_end date;
  v jsonb;
  w jsonb;
  x jsonb;
  v_result jsonb;
begin
  if not (select private.has_permission('dashboard.executive.view')) then
    raise exception 'Нет доступа к дашборду руководителя' using errcode = '42501';
  end if;
  if p_tile is null or p_tile not in ('revenue', 'receivables', 'payables', 'cash', 'shelf_life', 'shipments', 'decisions') then
    raise exception 'Неизвестная плитка дашборда';
  end if;
  if v_month > v_today or v_month < v_today - 3660 then
    raise exception 'Выберите месяц не позже текущего';
  end if;
  v_month_end := (v_month + interval '1 month')::date - 1;
  v_prev := (v_month - interval '1 month')::date;
  v_prev_end := v_month - 1;

  -- No rights to the data: no tile.
  if (p_tile = 'revenue' and not ((select private.has_permission('reports.view')) and (select private.has_permission('prices.purchase.view'))))
     or (p_tile = 'receivables' and not (select private.has_permission('receivables.view')))
     or (p_tile in ('payables', 'cash') and not (select private.has_permission('finance.view')))
     or (p_tile = 'shelf_life' and not ((select private.has_permission('reports.view')) and (select private.has_permission('inventory.view'))))
     or (p_tile = 'shipments' and not ((select private.has_permission('reports.view')) and (select private.has_permission('shipments.view')))) then
    return null;
  end if;

  begin
    if p_tile = 'revenue' then
      -- The totals of the profitability report; margin and share by its own formulas (profit / revenue with full data).
      v := public.profitability_report('customer', v_month, v_month_end) -> 'totals';
      w := public.profitability_report('customer', v_prev, v_prev_end) -> 'totals';
      v_result := jsonb_build_object(
        'revenue_net', v ->> 'revenue_net', 'profit', v ->> 'profit', 'complete_revenue', v ->> 'complete_revenue',
        'margin_pct', case when (v ->> 'complete_revenue')::numeric <> 0
                           then round((v ->> 'profit')::numeric / (v ->> 'complete_revenue')::numeric * 100, 2)::text end,
        'complete_share_pct', case when (v ->> 'revenue_net')::numeric <> 0
                                   then round((v ->> 'complete_revenue')::numeric / (v ->> 'revenue_net')::numeric * 100, 2)::text end,
        'lines', (v ->> 'lines')::integer, 'incomplete_lines', (v ->> 'incomplete_lines')::integer,
        'previous', jsonb_build_object(
          'revenue_net', w ->> 'revenue_net', 'profit', w ->> 'profit',
          'margin_pct', case when (w ->> 'complete_revenue')::numeric <> 0
                             then round((w ->> 'profit')::numeric / (w ->> 'complete_revenue')::numeric * 100, 2)::text end),
        'incomplete', (v ->> 'incomplete_lines')::integer > 0,
        'link', format('/analytics/profitability?group=customer&from=%s&to=%s', v_month, v_month_end));

    elsif p_tile = 'receivables' then
      -- Overdue customer debts of the receivables register, per currency, and the five largest debtors (by the tenge
      -- estimate).
      v := public.customer_receivables();
      with a as (
        select c ->> 'customer_id' as customer_id, c ->> 'customer' as customer, g ->> 'currency' as currency,
               (g ->> 'overdue')::numeric as overdue, (g ->> 'max_days_overdue')::integer as days
          from jsonb_array_elements(v) c
          cross join jsonb_array_elements(c -> 'aging') g
         where (g ->> 'overdue')::numeric > 0
      ), r as (
        select a.currency, public.dashboard_rate_kzt((select id from public.currencies where code = a.currency)) as rate
          from (select distinct currency from a) a
      ), t as (
        select a.customer_id, a.customer, sum(a.overdue * r.rate) as kzt, max(a.days) as days,
               jsonb_agg(jsonb_build_object('currency', a.currency, 'overdue', a.overdue::text) order by a.currency) as amounts
          from a join r on r.currency = a.currency
         group by a.customer_id, a.customer
      )
      select jsonb_build_object(
        'currencies', coalesce((select jsonb_agg(jsonb_build_object('currency', s.currency, 'overdue', s.overdue::text,
                                                                     'kzt', case when r.rate is not null then round(s.overdue * r.rate, 2)::text end)
                                                  order by case when s.currency = 'KZT' then 0 else 1 end, s.currency)
                                  from (select currency, sum(overdue) as overdue from a group by currency) s
                                  join r on r.currency = s.currency), '[]'::jsonb),
        'overdue_kzt', (select round(sum(a.overdue * r.rate), 2)::text from a join r on r.currency = a.currency),
        'customers', (select count(distinct customer_id) from a),
        'top', coalesce((select jsonb_agg(jsonb_build_object('customer_id', x.customer_id, 'customer', x.customer, 'kzt', round(x.kzt, 2)::text,
                                                             'days', x.days, 'amounts', x.amounts) order by x.kzt desc nulls last, x.customer)
                           from (select * from t order by t.kzt desc nulls last, t.customer limit 5) x), '[]'::jsonb),
        'incomplete', exists (select 1 from r where r.rate is null),
        'link', '/finance/receivables')
        into v_result;

    elsif p_tile = 'payables' then
      -- Overdue of the payables register; due in the next 14 days by the payment calendar (planned date, else due date),
      -- its payments side only.
      v := public.payables_summary();
      w := public.cash_payables_due(14);
      with o as (
        select s ->> 'currency' as currency, sum((s ->> 'overdue_amount')::numeric) as overdue, sum((s ->> 'rest')::numeric) as rest
          from jsonb_array_elements(v) s group by 1
      ), d as (
        select c ->> 'currency' as currency, (c ->> 'amount')::numeric as due from jsonb_array_elements(w -> 'currencies') c
      ), k as (
        select coalesce(o.currency, d.currency) as currency, coalesce(o.overdue, 0) as overdue, coalesce(d.due, 0) as due, coalesce(o.rest, 0) as rest
          from o full join d on d.currency = o.currency
      ), r as (
        select k.*, public.dashboard_rate_kzt((select id from public.currencies where code = k.currency)) as rate
          from k where k.overdue <> 0 or k.due <> 0 or k.rest <> 0
      )
      select jsonb_build_object(
        'currencies', coalesce((select jsonb_agg(jsonb_build_object('currency', r.currency, 'overdue', r.overdue::text, 'due_14', r.due::text,
                                                                     'rest', r.rest::text,
                                                                     'overdue_kzt', case when r.rate is not null then round(r.overdue * r.rate, 2)::text end,
                                                                     'due_14_kzt', case when r.rate is not null then round(r.due * r.rate, 2)::text end)
                                                  order by case when r.currency = 'KZT' then 0 else 1 end, r.currency)
                                  from r), '[]'::jsonb),
        'overdue_kzt', (select round(sum(r.overdue * r.rate), 2)::text from r),
        'due_14_kzt', (select round(sum(r.due * r.rate), 2)::text from r),
        'goods', (w ->> 'goods')::boolean,
        'incomplete', not (w ->> 'goods')::boolean or exists (select 1 from r where r.rate is null),
        'link', '/finance/payables')
        into v_result;

    elsif p_tile = 'cash' then
      -- The nearest cash gap of the payment calendar (13 weeks), per currency.
      w := public.cash_calendar('week', 13);
      select jsonb_build_object(
        'currencies', coalesce((select jsonb_agg(jsonb_build_object('currency', c ->> 'currency', 'first_gap', c ->> 'first_gap',
                                                                     'first_gap_with_plan', c ->> 'first_gap_with_plan',
                                                                     'opening', c -> 'opening' ->> 'amount',
                                                                     'balance_known', c -> 'opening' ->> 'amount' is not null)
                                                  order by ord)
                                  from jsonb_array_elements(w -> 'currencies') with ordinality e(c, ord)), '[]'::jsonb),
        'nearest', (select jsonb_build_object('currency', c ->> 'currency', 'date', c ->> 'first_gap',
                                              'week', date_trunc('week', (c ->> 'first_gap')::date)::date)
                      from jsonb_array_elements(w -> 'currencies') c
                     where c ->> 'first_gap' is not null
                     order by (c ->> 'first_gap')::date, c ->> 'currency' limit 1),
        'receivables', (w ->> 'receivables')::boolean, 'goods', (w ->> 'goods')::boolean,
        'incomplete', not (w ->> 'receivables')::boolean or not (w ->> 'goods')::boolean
                      or exists (select 1 from jsonb_array_elements(w -> 'currencies') c where c -> 'opening' ->> 'amount' is null),
        'link', '/finance/cash')
        into v_result;

    elsif p_tile = 'shelf_life' then
      -- Stock at risk by shelf life (at cost) and the losses of the month against the previous one.
      v := public.loss_risk('bucket') -> 'buckets';
      w := public.loss_report('reason', v_month, v_month_end) -> 'totals';
      x := public.loss_report('reason', v_prev, v_prev_end) -> 'totals';
      v_result := jsonb_build_object(
        'risk', jsonb_build_object(
          'expired_kzt', v -> 'expired' ->> 'cost_kzt', 'critical_kzt', v -> 'critical' ->> 'cost_kzt', 'warning_kzt', v -> 'warning' ->> 'cost_kzt',
          'expired_pieces', coalesce(v -> 'expired' ->> 'pieces', '0'), 'critical_pieces', coalesce(v -> 'critical' ->> 'pieces', '0'),
          'warning_pieces', coalesce(v -> 'warning' ->> 'pieces', '0'),
          -- Expired and up to 30 days: the headline of the tile.
          'urgent_kzt', case when (select private.has_permission('prices.purchase.view'))
                             then (coalesce((v -> 'expired' ->> 'cost_kzt')::numeric, 0) + coalesce((v -> 'critical' ->> 'cost_kzt')::numeric, 0))::text end,
          'urgent_pieces', (coalesce((v -> 'expired' ->> 'pieces')::numeric, 0) + coalesce((v -> 'critical' ->> 'pieces')::numeric, 0))::text,
          'incomplete', coalesce((v -> 'expired' ->> 'incomplete')::integer, 0) + coalesce((v -> 'critical' ->> 'incomplete')::integer, 0)
                        + coalesce((v -> 'warning' ->> 'incomplete')::integer, 0)),
        'losses', jsonb_build_object('cost_kzt', w ->> 'cost_kzt', 'pieces', w ->> 'pieces', 'lines', (w ->> 'lines')::integer,
                                     'incomplete_lines', (w ->> 'incomplete_lines')::integer),
        'previous', jsonb_build_object('cost_kzt', x ->> 'cost_kzt', 'pieces', x ->> 'pieces'),
        'amounts', (select private.has_permission('prices.purchase.view')),
        'incomplete', (w ->> 'incomplete_lines')::integer > 0
                      or coalesce((v -> 'expired' ->> 'incomplete')::integer, 0) + coalesce((v -> 'critical' ->> 'incomplete')::integer, 0)
                         + coalesce((v -> 'warning' ->> 'incomplete')::integer, 0) > 0,
        'link', format('/analytics/losses?from=%s&to=%s', v_month, v_month_end));

    elsif p_tile = 'shipments' then
      -- Operational analytics (shipments, late stages) and the vehicles on the road of open shipments.
      v := public.operational_summary();
      v_result := jsonb_build_object(
        'active', (v -> 'shipments' ->> 'active')::integer, 'late', (v -> 'shipments' ->> 'late')::integer,
        'in_transit', coalesce((v -> 'shipments' -> 'by_status' ->> 'in_transit')::integer, 0)
                      + coalesce((v -> 'shipments' -> 'by_status' ->> 'customs')::integer, 0),
        'vehicles_on_road', (select count(*) from public.shipment_transports t join public.shipments s on s.id = t.shipment_id
                              where t.status in ('in_transit', 'at_customs') and s.status not in ('closed', 'cancelled')),
        'stages_late', (v -> 'stages' ->> 'late')::integer, 'stages_blocked', (v -> 'stages' ->> 'blocked')::integer,
        'incomplete', false,
        'link', '/analytics');

    else
      -- What waits for a decision of this employee: unread approvals, price reviews and blocked orders, overdue tasks,
      -- open orders with a line without a price (with access to orders).
      v_result := jsonb_build_object(
        'approvals', (select count(*) from public.notifications n where n.recipient_user_id = auth.uid() and not n.is_read and n.type = 'approval_request'),
        'price_reviews', (select count(*) from public.notifications n where n.recipient_user_id = auth.uid() and not n.is_read and n.type = 'price_review'),
        'blocked_orders', (select count(*) from public.notifications n where n.recipient_user_id = auth.uid() and not n.is_read and n.type = 'order_blocked'),
        'tasks_overdue', case when (select private.has_permission('tasks.view')) then
                            (select count(*) from public.tasks t where t.status not in ('done', 'cancelled') and t.due_at < now()) end,
        'unpriced_orders', case when (select private.has_permission('sales.view')) then
                              (select count(distinct s.id) from public.sales s join public.sale_items i on i.sale_id = s.id
                                where s.status in ('draft', 'reserved', 'confirmed') and i.unit_price is null) end,
        'incomplete', false,
        'link', '/notifications');
      v_result := v_result || jsonb_build_object('total', (v_result ->> 'approvals')::integer + (v_result ->> 'price_reviews')::integer
                                                          + (v_result ->> 'blocked_orders')::integer + coalesce((v_result ->> 'tasks_overdue')::integer, 0)
                                                          + coalesce((v_result ->> 'unpriced_orders')::integer, 0));
    end if;
  exception
    when others then
      return jsonb_build_object('tile', p_tile, 'status', 'error', 'month', v_month);
  end;
  return v_result || jsonb_build_object('tile', p_tile, 'status', 'ok', 'month', v_month, 'previous_month', v_prev);
end $$;
revoke all on function public.executive_dashboard_tile(text, date) from public, anon, authenticated, service_role;
grant execute on function public.executive_dashboard_tile(text, date) to authenticated;

-- All tiles of the employee in one answer (the assistant, an export): the same tile function, tiles without rights left out.
create or replace function public.executive_dashboard(p_month date default null)
returns jsonb
language plpgsql stable security invoker set search_path = '' set jit = off as $$
declare
  v_tiles jsonb := '[]'::jsonb;
  v_tile jsonb;
  k text;
begin
  if not (select private.has_permission('dashboard.executive.view')) then
    raise exception 'Нет доступа к дашборду руководителя' using errcode = '42501';
  end if;
  foreach k in array array['revenue', 'receivables', 'payables', 'cash', 'shelf_life', 'shipments', 'decisions'] loop
    v_tile := public.executive_dashboard_tile(k, p_month);
    if v_tile is not null then
      v_tiles := v_tiles || jsonb_build_array(v_tile);
    end if;
  end loop;
  return jsonb_build_object('month', date_trunc('month', coalesce(p_month, (now() at time zone 'Asia/Almaty')::date))::date, 'tiles', v_tiles);
end $$;
revoke all on function public.executive_dashboard(date) from public, anon, authenticated, service_role;
grant execute on function public.executive_dashboard(date) to authenticated;

commit;
