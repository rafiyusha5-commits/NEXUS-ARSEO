-- Audit of 2026-11-18, finding Н3: a batch received by two shipments (the second receipt adds to the existing batch,
-- 202611010100) was reported entirely under its first shipment. Owner decision of 2026-11-21 (damirator1-afk): the
-- report by shipment shares such a batch between its shipments in proportion to the pieces each received - revenue,
-- cost, sold and unsold pieces. The batch cost is already the weighted average of its receipts (202611160100), so
-- every shipment carries the same margin of that batch. Reports by product and customer and the batch cost do not
-- change. The detailed lines name every shipment of such a batch with its share.
begin;

-- Pieces each shipment received into a batch, net of reversed receipts, as a share of the batch. No rows when the
-- batch has no receipt movements or a unit without packaging: the report then keeps the batch's source shipment.
create or replace function private.batch_shipment_shares(p_batch_id uuid)
returns table(shipment_id uuid, share numeric)
language sql stable security definer set search_path = '' as $$
  with r as (
    select si.shipment_id,
           sum(case when m.is_reversal then -m.quantity else m.quantity end * private.uom_pieces(b.product_id, m.uom)) as pieces,
           bool_or(private.uom_pieces(b.product_id, m.uom) is null) as unknown_unit
      from public.inventory_movements m
      join public.inventory_batches b on b.id = m.batch_id
      join public.shipment_items si on si.id = m.shipment_item_id
     where m.batch_id = p_batch_id and m.movement_type = 'receipt'
     group by si.shipment_id
  )
  select r.shipment_id, r.pieces / sum(r.pieces) over ()
    from r
   where not exists (select 1 from r x where x.unknown_unit) and r.pieces > 0
$$;
revoke all on function private.batch_shipment_shares(uuid) from public, anon, authenticated, service_role;

create or replace function public.profitability_report(p_group text, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = '' set jit = off as $$
begin
  perform private.require_profitability();
  if p_group is null or p_group not in ('shipment', 'product', 'customer') then raise exception 'Выберите разрез отчёта'; end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 3660 then raise exception 'Укажите период до 10 лет'; end if;
  return (
    with l as (select * from private.profit_lines(p_from, p_to)),
    -- By shipment, a batch received by several shipments is shared between them in proportion to the pieces each
    -- received (owner decision of 2026-11-21, audit Н3); a batch with one shipment keeps the whole line.
    shares as (
      select b.batch_id, s.shipment_id, s.share
        from (select distinct l.batch_id from l where p_group = 'shipment') b
        cross join lateral private.batch_shipment_shares(b.batch_id) s
    ),
    g as (
      select case p_group when 'shipment' then coalesce(s.shipment_id, l.shipment_id) when 'product' then l.product_id else l.customer_id end as key,
             l.kind, l.status, l.old_rule,
             -- A whole line stays exact; a shared one is rounded to tiyn and to thousandths of a piece.
             case when coalesce(s.share, 1) = 1 then l.revenue_net_kzt else round(l.revenue_net_kzt * s.share, 2) end as revenue_net_kzt,
             case when coalesce(s.share, 1) = 1 then l.revenue_gross_kzt else round(l.revenue_gross_kzt * s.share, 2) end as revenue_gross_kzt,
             case when coalesce(s.share, 1) = 1 then l.cost_kzt else round(l.cost_kzt * s.share, 2) end as cost_kzt,
             case when coalesce(s.share, 1) = 1 then l.pieces else round(l.pieces * s.share, 3) end as pieces
        from l left join shares s on s.batch_id = l.batch_id
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
               select coalesce(sum(case when coalesce(s.share, 1) = 1 then bal.quantity_on_hand * private.uom_pieces(b.product_id, bal.uom)
                                        else round(bal.quantity_on_hand * private.uom_pieces(b.product_id, bal.uom) * s.share, 3) end), 0)
                 from public.inventory_batches b
                 join public.inventory_balances bal on bal.batch_id = b.id
                 left join lateral (select x.shipment_id, x.share from private.batch_shipment_shares(b.id) x) s on true
                 left join public.shipment_items si on si.id = b.source_shipment_item_id
                where coalesce(s.shipment_id, si.shipment_id) = a.key) end as unsold_pieces
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
      'batch', l.batch_number,
      -- Several shipments of one batch: each with its share (audit Н3).
      'shipment', coalesce((select string_agg(sh.shipment_number || ' ' || round(x.share * 100, 1)::text || ' %', ', ' order by sh.shipment_number)
                              from private.batch_shipment_shares(l.batch_id) x join public.shipments sh on sh.id = x.shipment_id
                            having count(*) > 1),
                           (select sh.shipment_number from public.shipments sh where sh.id = l.shipment_id)),
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
