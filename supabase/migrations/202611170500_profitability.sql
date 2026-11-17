-- Block 3: profitability by shipment, by product and by customer, computed by the database.
-- Owner decisions of 2026-11-16/17 (damirator1-afk), defaults accepted:
--   * the report is in tenge at the official rate (exchange_rates.source = 'official') on the date of the operation,
--     with the rule of block 1 for days without a rate (the latest official rate up to 7 days before, its date shown);
--     no rate -> the line is marked "нет курса", never converted at 1 or at a bank rate; private.finance_rate (Н14)
--     is not used and not changed;
--   * revenue without VAT (Kazakhstan and export comparable), VAT at public.vat_rates; a column with VAT next to it;
--   * expenses attributed to a customer are a second step (not in this PR);
--   * access: reports.view and prices.purchase.view together, employees only (has_permission requires an employee).
-- Rules: only what was shipped (issue movements of orders); the cost of a line is its quantity of that very batch x
-- the cost of that batch (no averaging per product); approved cost is taken as approved and only converted to tenge
-- on the shipment date. Returns reduce revenue and cost of the period of the return and are separate lines.
-- Every line carries a quality mark; incomplete lines are shown, never counted as zero in the margin.
-- The per-piece margin is the formula of block 1Б (private.batch_margin); the test checks that both agree.
begin;

create index if not exists inventory_movements_issue_created_idx
  on public.inventory_movements(created_at) where movement_type = 'issue' and sale_item_id is not null;
create index if not exists customer_returns_received_idx on public.customer_returns(received_at) where status <> 'cancelled';

-- Whether the price of an order line contains VAT and of which country. From the line's price snapshot (block 1б);
-- for older lines from the customer's price type on the order date; otherwise by the customer's country
-- (Kazakhstan with VAT, export without: owner decision of 16.11.2026).
create or replace function private.sale_line_vat(p_sale_item_id uuid)
returns table(vat_included boolean, vat_country text, vat_source text)
language sql stable security definer set search_path = '' rows 1 as $$
  select coalesce((i.price_snapshot->>'vat_included')::boolean, (i.price_snapshot->'price_list_quote'->>'vat_included')::boolean,
                  t.vat_included, c.country = 'KZ'),
         coalesce(t.market, c.country),
         case when coalesce(i.price_snapshot->>'vat_included', i.price_snapshot->'price_list_quote'->>'vat_included') is not null then 'snapshot'
              when t.id is not null then 'price_type' else 'country' end
    from public.sale_items i join public.sales s on s.id = i.sale_id join public.counterparties c on c.id = s.customer_id
    left join lateral (select pt.* from public.customer_price_terms x join public.price_types pt on pt.id = x.price_type_id
                        where x.customer_id = s.customer_id and x.valid_from <= s.sale_date
                        order by x.valid_from desc, x.created_at desc, x.id desc limit 1) t on true
   where i.id = p_sale_item_id
$$;
revoke all on function private.sale_line_vat(uuid) from public, anon, authenticated, service_role;

-- One row per shipped batch of an order line (issue movement) and per returned batch, in the period.
create or replace function private.profit_lines(p_from date, p_to date)
returns table(
  line_id uuid, kind text, line_date date, sale_id uuid, sale_number text, customer_id uuid, product_id uuid,
  batch_id uuid, batch_number text, shipment_id uuid, pieces numeric,
  sale_currency_id uuid, revenue_gross numeric, vat_included boolean, vat_rate numeric, revenue_net numeric,
  cost_currency_id uuid, cost_amount numeric, cost_status text, old_rule boolean,
  revenue_rate numeric, revenue_rate_date date, cost_rate numeric, cost_rate_date date,
  revenue_net_kzt numeric, revenue_gross_kzt numeric, cost_kzt numeric, status text)
-- Function calls inflate the planner's row estimates; JIT compilation would then cost more than the whole report.
language plpgsql stable security definer set search_path = '' set jit = off as $$
declare v_kzt uuid := (select id from public.currencies where code = 'KZT');
begin
  return query
  with src as (
    select m.id, 'sale'::text as kind,
           coalesce(s.historical_shipment_date, (m.created_at at time zone 'Asia/Almaty')::date) as d,
           s.id as sale_id, s.sale_number, s.customer_id, i.id as item_id, i.product_id, m.batch_id,
           m.quantity as qty, m.uom as qty_uom, i.uom as sale_uom, r.sale_quantity as known_sale_quantity,
           i.unit_price, s.currency_id, 1 as sign
      from public.inventory_movements m
      join public.sale_items i on i.id = m.sale_item_id
      join public.sales s on s.id = i.sale_id
      left join public.inventory_reservations r on r.id = m.inventory_reservation_id
     where m.movement_type = 'issue'
       and ((s.historical_shipment_date is not null and s.historical_shipment_date between p_from and p_to)
            or (s.historical_shipment_date is null
                and m.created_at >= (p_from::timestamp at time zone 'Asia/Almaty')
                and m.created_at < ((p_to + 1)::timestamp at time zone 'Asia/Almaty')))
    union all
    select ri.id, 'return', (cr.received_at at time zone 'Asia/Almaty')::date,
           s.id, s.sale_number, s.customer_id, i.id, i.product_id, ri.batch_id,
           ri.quantity, ri.uom, i.uom, null::numeric,
           coalesce(ri.unit_price, i.unit_price), s.currency_id, -1
      from public.customer_return_items ri
      join public.customer_returns cr on cr.id = ri.return_id
      join public.sale_items i on i.id = ri.sale_item_id
      join public.sales s on s.id = i.sale_id
     where cr.status <> 'cancelled'
       and cr.received_at >= (p_from::timestamp at time zone 'Asia/Almaty')
       and cr.received_at < ((p_to + 1)::timestamp at time zone 'Asia/Almaty')
  ), packs as (
    -- Pieces per unit once per product and unit, only through explicit packaging.
    select q.product_id, q.uom, private.uom_pieces(q.product_id, q.uom) as pieces
      from (select distinct x.product_id, x.qty_uom as uom from src x union select distinct x.product_id, x.sale_uom from src x
            union select distinct b.product_id, coalesce(b.cost_uom, 'piece') from public.inventory_batches b where b.id in (select s2.batch_id from src s2)
            union select distinct b.product_id, si.uom from public.inventory_batches b join public.shipment_items si on si.id = b.source_shipment_item_id
                   where b.id in (select s2.batch_id from src s2)) q
  ), raw as (
    select x.id, x.kind, x.d, x.sale_id, x.sale_number, x.customer_id, x.item_id, x.product_id, x.batch_id,
           x.qty * pq.pieces as pieces,
           coalesce(x.known_sale_quantity, x.qty * pq.pieces / nullif(ps.pieces, 0)) as sale_quantity,
           x.unit_price, x.currency_id, x.sign
      from src x
      left join packs pq on pq.product_id = x.product_id and pq.uom = x.qty_uom
      left join packs ps on ps.product_id = x.product_id and ps.uom = x.sale_uom
  ), item_vat as (
    -- Once per order line and once per batch, not per movement.
    select q.item_id, v.vat_included, v.vat_country
      from (select distinct r.item_id from src r) q cross join lateral private.sale_line_vat(q.item_id) v
  ), batch_cost as (
    select b.id, b.batch_number, b.cost_basis, b.product_id, b.unit_landed_cost, b.cost_currency_id, b.cost_uom,
           si.shipment_id, si.uom as receipt_uom, pre.unit_landed_cost as pre_cost, pre.currency_id as pre_currency
      from (select distinct r.batch_id from src r) q
      join public.inventory_batches b on b.id = q.batch_id
      left join public.shipment_items si on si.id = b.source_shipment_item_id
      left join lateral (select ci.unit_landed_cost, ci.currency_id from public.cost_calculation_items ci
                           join public.cost_calculations cc on cc.id = ci.calculation_id
                          where ci.shipment_item_id = b.source_shipment_item_id and cc.status = 'draft'
                          order by cc.version_number desc limit 1) pre on b.unit_landed_cost is null
  ), lines as (
    select x.*, b.batch_number, b.cost_basis, b.shipment_id,
           v.vat_included, v.vat_country,
           -- Approved cost of the batch, else the latest draft calculation of its first receipt (preliminary).
           case when b.unit_landed_cost is not null then 'approved' when b.pre_cost is not null then 'preliminary' else 'none' end as cost_status,
           coalesce(b.cost_currency_id, b.pre_currency) as cost_currency_id,
           case when b.unit_landed_cost is not null
                then x.pieces / nullif(pc.pieces, 0) * b.unit_landed_cost
                else x.pieces / nullif(pr.pieces, 0) * b.pre_cost end as cost_amount
      from raw x
      join batch_cost b on b.id = x.batch_id
      join item_vat v on v.item_id = x.item_id
      left join packs pc on pc.product_id = x.product_id and pc.uom = coalesce(b.cost_uom, 'piece')
      left join packs pr on pr.product_id = x.product_id and pr.uom = b.receipt_uom
  ), rates as (
    select q.cur, q.d, c.rate, c.rate_date from (
      select distinct l.currency_id as cur, l.d from lines l where l.currency_id is not null
      union select distinct l.cost_currency_id, l.d from lines l where l.cost_currency_id is not null) q
    cross join lateral (select * from private.official_conversion(q.cur, v_kzt, q.d)) c
  ), vats as (
    select q.country, q.d, private.vat_rate_on(q.country, q.d) as rate
      from (select distinct l.vat_country as country, l.d from lines l where l.vat_included) q
  )
  select l.id, l.kind, l.d, l.sale_id, l.sale_number, l.customer_id, l.product_id, l.batch_id, l.batch_number, l.shipment_id,
         l.sign * l.pieces,
         l.currency_id, l.sign * l.sale_quantity * l.unit_price, l.vat_included, vt.rate,
         l.sign * l.sale_quantity * l.unit_price / (1 + coalesce(vt.rate, 0)),
         l.cost_currency_id, l.sign * l.cost_amount, l.cost_status, l.cost_basis = 'source_item',
         rr.rate, rr.rate_date, cr.rate, cr.rate_date,
         round(l.sign * l.sale_quantity * l.unit_price / (1 + coalesce(vt.rate, 0)) * rr.rate, 2),
         round(l.sign * l.sale_quantity * l.unit_price * rr.rate, 2),
         round(l.sign * l.cost_amount * cr.rate, 2),
         case when l.unit_price is null or l.currency_id is null then 'no_price'
              when l.pieces is null or l.sale_quantity is null then 'no_packaging'
              when l.cost_status = 'none' then 'no_cost'
              when l.cost_amount is null then 'no_packaging'
              when rr.rate is null or cr.rate is null then 'no_rate'
              when l.vat_included and vt.rate is null then 'no_vat_rate'
              when l.cost_status = 'preliminary' then 'preliminary'
              else 'approved' end
    from lines l
    left join rates rr on rr.cur = l.currency_id and rr.d = l.d
    left join rates cr on cr.cur = l.cost_currency_id and cr.d = l.d
    left join vats vt on l.vat_included and vt.country = l.vat_country and vt.d = l.d;
end $$;
revoke all on function private.profit_lines(date, date) from public, anon, authenticated, service_role;

create or replace function private.require_profitability() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (select private.has_permission('reports.view')) or not (select private.has_permission('prices.purchase.view')) then
    raise exception 'Нет доступа к отчёту о прибыльности' using errcode = '42501';
  end if;
end $$;
revoke all on function private.require_profitability() from public, anon, authenticated, service_role;

-- Report by shipment, product or customer. Revenue counts every line with a known revenue in tenge; profit and margin
-- only lines with complete data (approved cost, price, rates, VAT); the share of revenue with complete data is shown.
create or replace function public.profitability_report(p_group text, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = '' set jit = off as $$
begin
  perform private.require_profitability();
  if p_group is null or p_group not in ('shipment', 'product', 'customer') then raise exception 'Выберите разрез отчёта'; end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 3660 then raise exception 'Укажите период до 10 лет'; end if;
  return (
    with l as (select * from private.profit_lines(p_from, p_to)),
    g as (
      select case p_group when 'shipment' then l.shipment_id when 'product' then l.product_id else l.customer_id end as key, l.*
        from l
    ), agg as (
      select g.key,
             coalesce(sum(g.revenue_net_kzt) filter (where g.kind = 'sale'), 0) as sales_net,
             coalesce(sum(g.revenue_gross_kzt) filter (where g.kind = 'sale'), 0) as sales_gross,
             coalesce(sum(g.revenue_net_kzt) filter (where g.kind = 'return'), 0) as returns_net,
             coalesce(sum(g.cost_kzt) filter (where g.kind = 'return' and g.status = 'approved'), 0) as returns_cost,
             coalesce(sum(g.revenue_net_kzt), 0) as revenue_net,
             coalesce(sum(g.revenue_gross_kzt), 0) as revenue_gross,
             coalesce(sum(g.revenue_net_kzt) filter (where g.status = 'approved'), 0) as complete_revenue,
             coalesce(sum(g.cost_kzt) filter (where g.status = 'approved'), 0) as complete_cost,
             coalesce(sum(g.pieces) filter (where g.kind = 'sale'), 0) as sold_pieces,
             coalesce(sum(-g.pieces) filter (where g.kind = 'return'), 0) as returned_pieces,
             jsonb_object_agg_strict(g.status, g.n) as statuses,
             bool_or(g.old_rule) as old_rule
        from (select g.*, count(*) over (partition by g.key, g.status) as n from g) g
       group by g.key
    ), named as (
      select a.*,
             case p_group
               when 'shipment' then (select sh.shipment_number from public.shipments sh where sh.id = a.key)
               when 'product' then (select p.internal_sku || ' · ' || coalesce(p.name->>'ru', '') from public.products p where p.id = a.key)
               else (select coalesce(c.short_name, c.legal_name) from public.counterparties c where c.id = a.key) end as name,
             case when p_group = 'shipment' then (
               select coalesce(sum(bal.quantity_on_hand * private.uom_pieces(b.product_id, bal.uom)), 0)
                 from public.inventory_batches b join public.shipment_items si on si.id = b.source_shipment_item_id
                 join public.inventory_balances bal on bal.batch_id = b.id
                where si.shipment_id = a.key) end as unsold_pieces
        from agg a
    )
    select jsonb_build_object(
      'group', p_group, 'from', p_from, 'to', p_to, 'currency', 'KZT',
      'rows', coalesce(jsonb_agg(jsonb_build_object(
          'key', n.key, 'name', coalesce(n.name, case p_group when 'shipment' then 'Без поставки' else '—' end),
          'sales_net', n.sales_net::text, 'sales_gross', n.sales_gross::text,
          'returns_net', n.returns_net::text, 'returns_cost', n.returns_cost::text,
          'revenue_net', n.revenue_net::text, 'revenue_gross', n.revenue_gross::text,
          'complete_revenue', n.complete_revenue::text, 'cost', n.complete_cost::text,
          'profit', (n.complete_revenue - n.complete_cost)::text,
          'margin_pct', case when n.complete_revenue <> 0 then round((n.complete_revenue - n.complete_cost) / n.complete_revenue * 100, 2) end,
          'complete_share_pct', case when n.revenue_net <> 0 then round(n.complete_revenue / n.revenue_net * 100, 2) end,
          'sold_pieces', n.sold_pieces::text, 'returned_pieces', n.returned_pieces::text, 'unsold_pieces', n.unsold_pieces::text,
          'statuses', coalesce(n.statuses, '{}'::jsonb), 'old_rule', coalesce(n.old_rule, false))
          order by (n.complete_revenue - n.complete_cost) desc, n.name), '[]'::jsonb),
      'totals', (select jsonb_build_object(
          'sales_net', coalesce(sum(revenue_net_kzt) filter (where kind = 'sale'), 0)::text,
          'returns_net', coalesce(sum(revenue_net_kzt) filter (where kind = 'return'), 0)::text,
          'revenue_net', coalesce(sum(revenue_net_kzt), 0)::text, 'revenue_gross', coalesce(sum(revenue_gross_kzt), 0)::text,
          'complete_revenue', coalesce(sum(revenue_net_kzt) filter (where status = 'approved'), 0)::text,
          'cost', coalesce(sum(cost_kzt) filter (where status = 'approved'), 0)::text,
          'profit', (coalesce(sum(revenue_net_kzt) filter (where status = 'approved'), 0) - coalesce(sum(cost_kzt) filter (where status = 'approved'), 0))::text,
          'lines', count(*), 'incomplete_lines', count(*) filter (where status <> 'approved')) from l))
    from named n);
end $$;
revoke all on function public.profitability_report(text, date, date) from public, anon, authenticated, service_role;
grant execute on function public.profitability_report(text, date, date) to authenticated;

-- The lines themselves, for the export and for checking a figure.
create or replace function public.profitability_lines(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = '' set jit = off as $$
begin
  perform private.require_profitability();
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 3660 then raise exception 'Укажите период до 10 лет'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'kind', l.kind, 'date', l.line_date, 'sale_number', l.sale_number,
      'customer', (select coalesce(c.short_name, c.legal_name) from public.counterparties c where c.id = l.customer_id),
      'product', (select p.internal_sku from public.products p where p.id = l.product_id),
      'batch', l.batch_number, 'shipment', (select sh.shipment_number from public.shipments sh where sh.id = l.shipment_id),
      'pieces', l.pieces::text, 'sale_currency', (select code from public.currencies where id = l.sale_currency_id),
      'revenue_gross', round(l.revenue_gross, 2)::text, 'vat_included', l.vat_included, 'vat_rate', l.vat_rate::text,
      'revenue_net', round(l.revenue_net, 2)::text, 'revenue_rate', l.revenue_rate::text, 'revenue_rate_date', l.revenue_rate_date,
      'cost_currency', (select code from public.currencies where id = l.cost_currency_id), 'cost', round(l.cost_amount, 2)::text,
      'cost_status', l.cost_status, 'cost_rate', l.cost_rate::text, 'cost_rate_date', l.cost_rate_date,
      'revenue_net_kzt', l.revenue_net_kzt::text, 'revenue_gross_kzt', l.revenue_gross_kzt::text, 'cost_kzt', l.cost_kzt::text,
      'profit_kzt', case when l.status = 'approved' then (l.revenue_net_kzt - l.cost_kzt)::text end,
      'status', l.status, 'old_rule', l.old_rule)
      order by l.line_date, l.sale_number, l.kind, l.batch_number), '[]'::jsonb)
    from private.profit_lines(p_from, p_to) l);
end $$;
revoke all on function public.profitability_lines(date, date) from public, anon, authenticated, service_role;
grant execute on function public.profitability_lines(date, date) to authenticated;
commit;
