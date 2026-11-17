-- Block 1Б: margin of every batch in stock at the price-list price and at the customer's price, the customer's
-- margin threshold and the "Проверьте цену" notification. Owner decisions of 2026-11-16/17 (damirator1-afk):
--   * the price is kept, the exchange-rate difference is taken in the margin, visible per batch;
--   * one formula for the price list (block 1Б) and the profitability report (block 3): private.batch_margin;
--   * margin = (net price - cost) / net price; markup = (net price - cost) / cost; a price with VAT is taken without
--     VAT at the rate of public.vat_rates; units only through explicit packaging; currencies only through the
--     official rate (private.official_conversion, as in block 1); a missing piece gives a reason, never zero;
--   * a batch whose cost is by the old first-receipt rule (cost_basis = 'source_item', finding Н6) is marked;
--   * only a lower threshold, per customer only, set by hand with history; no threshold = no check; 0 is a value;
--   * only batches with an approved cost are checked; the price never changes by itself.
-- Cost and margin are returned only to employees with prices.purchase.view (and inventory.view): the functions
-- refuse everybody else, so nothing reaches them in a page or a response.
-- The check runs after the cost is written (trigger after the batch update made by the approval), in its own
-- subtransaction: a failing check is logged as a warning and never rolls back the approval. approve_shipment_cost
-- and the cost rules of 202611160100 are not changed.
begin;

-- Rights -----------------------------------------------------------------------------------------------------
insert into public.permissions(code, module, action, name, description)
values ('pricing.margin_threshold.manage', 'pricing', 'margin_threshold_manage', 'Порог маржи клиента: изменение',
        'Нижний порог маржи по клиенту; требуется и право просмотра закупочных цен')
on conflict (code) do nothing;
insert into public.role_permissions(role_id, permission_id, granted)
select r.id, p.id, true from public.app_roles r cross join public.permissions p
 where r.code = 'administrator' and p.code = 'pricing.margin_threshold.manage'
on conflict (role_id, permission_id) do nothing;

-- Thresholds: append-only; the latest row is the current value, null removes the threshold ---------------------
create table if not exists public.customer_margin_thresholds (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.counterparties(id),
  threshold_pct numeric(6, 2) check (threshold_pct is null or threshold_pct between -100 and 100),
  reason text not null check (length(btrim(reason)) between 3 and 1000),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists customer_margin_thresholds_lookup_idx on public.customer_margin_thresholds(customer_id, created_at desc);
create index if not exists customer_margin_thresholds_created_by_idx on public.customer_margin_thresholds(created_by);
alter table public.customer_margin_thresholds enable row level security;
revoke all on public.customer_margin_thresholds from public, anon, authenticated, service_role;
drop trigger if exists customer_margin_thresholds_immutable on public.customer_margin_thresholds;
create trigger customer_margin_thresholds_immutable before update or delete on public.customer_margin_thresholds
  for each row execute function private.guard_price_history();

create or replace function private.customer_margin_threshold(p_customer_id uuid)
returns public.customer_margin_thresholds
language sql stable security definer set search_path = '' as $$
  select * from public.customer_margin_thresholds where customer_id = p_customer_id
   order by created_at desc, id desc limit 1
$$;
revoke all on function private.customer_margin_threshold(uuid) from public, anon, authenticated, service_role;

-- Access ---------------------------------------------------------------------------------------------------------
create or replace function private.require_margin_view() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_price_list_view();
  if not (select private.has_permission('prices.purchase.view')) or not (select private.has_permission('inventory.view')) then
    raise exception 'Нет доступа к себестоимости и марже' using errcode = '42501';
  end if;
end $$;
revoke all on function private.require_margin_view() from public, anon, authenticated, service_role;

-- The one formula ------------------------------------------------------------------------------------------------
-- Margin of one batch at a price. p_price is per p_price_uom in p_price_currency_id; p_vat_included says whether
-- it contains VAT of p_vat_country. Amounts in the result are per piece, in the price currency, without VAT.
create or replace function private.batch_margin(p_batch_id uuid, p_price numeric, p_price_currency_id uuid,
                                                p_price_uom text, p_vat_included boolean, p_vat_country text, p_date date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  b public.inventory_batches;
  v_cost_pieces numeric;
  v_price_pieces numeric;
  v_rate record;
  v_vat numeric;
  v_net numeric;
  v_cost numeric;
  v_result jsonb;
begin
  select * into b from public.inventory_batches where id = p_batch_id;
  v_result := jsonb_build_object('cost_basis', b.cost_basis, 'vat_included', p_vat_included);
  if b.id is null or b.unit_landed_cost is null or b.cost_currency_id is null then
    return v_result || jsonb_build_object('margin_pct', null, 'reason', 'no_cost');
  end if;
  if p_price is null or p_price <= 0 or p_price_currency_id is null then
    return v_result || jsonb_build_object('margin_pct', null, 'reason', 'no_price');
  end if;
  v_cost_pieces := private.uom_pieces(b.product_id, coalesce(b.cost_uom, 'piece'));
  v_price_pieces := private.uom_pieces(b.product_id, coalesce(p_price_uom, 'piece'));
  if v_cost_pieces is null or v_price_pieces is null or v_cost_pieces <= 0 or v_price_pieces <= 0 then
    return v_result || jsonb_build_object('margin_pct', null, 'reason', 'no_packaging');
  end if;
  select * into v_rate from private.official_conversion(b.cost_currency_id, p_price_currency_id, p_date);
  if v_rate.rate is null then
    return v_result || jsonb_build_object('margin_pct', null, 'reason', 'no_rate');
  end if;
  if p_vat_included then
    v_vat := private.vat_rate_on(p_vat_country, p_date);
    if v_vat is null then
      return v_result || jsonb_build_object('margin_pct', null, 'reason', 'no_vat_rate');
    end if;
  end if;
  v_net := p_price / v_price_pieces / (1 + coalesce(v_vat, 0));
  v_cost := b.unit_landed_cost / v_cost_pieces * v_rate.rate;
  return v_result || jsonb_build_object(
    'net_price', round(v_net, 4), 'cost', round(v_cost, 4),
    'margin_pct', round((v_net - v_cost) / v_net * 100, 2),
    'markup_pct', case when v_cost > 0 then round((v_net - v_cost) / v_cost * 100, 2) end,
    'vat_rate', v_vat, 'rate', v_rate.rate, 'rate_date', v_rate.rate_date, 'rate_path', v_rate.path, 'reason', null);
end $$;
revoke all on function private.batch_margin(uuid, numeric, uuid, text, boolean, text, date) from public, anon, authenticated, service_role;

-- The customer's price for the batch's product (per piece, contract currency) and the margin at it.
create or replace function private.customer_batch_margin(p_customer_id uuid, p_batch_id uuid, p_date date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_product uuid;
  v_quote jsonb;
begin
  select product_id into v_product from public.inventory_batches where id = p_batch_id;
  v_quote := private.resolve_customer_price(p_customer_id, v_product, 'piece', p_date, null);
  if v_quote->>'price' is null then
    return jsonb_build_object('margin_pct', null, 'reason', coalesce(v_quote->>'reason', 'no_price'), 'quote', v_quote);
  end if;
  return private.batch_margin(p_batch_id, (v_quote->>'price')::numeric,
           (select id from public.currencies where code = v_quote->>'contract_currency'), 'piece',
           (v_quote->>'vat_included')::boolean,
           (select t.market from public.price_types t where t.code = v_quote->>'price_type'), p_date)
         || jsonb_build_object('quote', v_quote);
end $$;
revoke all on function private.customer_batch_margin(uuid, uuid, date) from public, anon, authenticated, service_role;

-- Batches in stock in shipping order (nearest expiry first), with what is free to sell by unit.
create or replace function private.margin_batches(p_product_id uuid)
returns table(batch_id uuid, product_id uuid, batch_number text, expiry_date date, available jsonb)
language sql stable security definer set search_path = '' as $$
  select x.id, x.product_id, x.batch_number, x.expiry_date,
         jsonb_agg(jsonb_build_object('uom', s.uom, 'quantity', s.free::text) order by s.uom)
    from public.inventory_batches x
    join (select bal.batch_id, bal.uom, sum(bal.quantity_on_hand - bal.quantity_reserved) as free
            from public.inventory_balances bal group by bal.batch_id, bal.uom) s on s.batch_id = x.id and s.free > 0
   where x.status = 'available' and (p_product_id is null or x.product_id = p_product_id)
   group by x.id, x.product_id, x.batch_number, x.expiry_date, x.received_at
   order by x.expiry_date, x.received_at, x.id
$$;
revoke all on function private.margin_batches(uuid) from public, anon, authenticated, service_role;

-- Price list: margin of each batch at each price type, without the customer's percent (reference, no threshold).
create or replace function public.price_list_batch_margins(p_product_id uuid, p_date date default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_date date := coalesce(p_date, private.business_today());
begin
  perform private.require_margin_view();
  return jsonb_build_object('date', v_date, 'batches', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'batch_id', m.batch_id, 'batch_number', m.batch_number, 'expiry_date', m.expiry_date, 'available', m.available,
             'cost_basis', b.cost_basis, 'unit_cost', b.unit_landed_cost::text, 'cost_uom', b.cost_uom,
             'cost_currency', (select code from public.currencies where id = b.cost_currency_id),
             'margins', (select coalesce(jsonb_object_agg(t.code,
                   jsonb_build_object('price', e.price::text, 'currency', c.code)
                   || private.batch_margin(m.batch_id, e.price, t.currency_id, 'piece', t.vat_included, t.market, v_date)), '{}'::jsonb)
                 from public.price_types t join public.currencies c on c.id = t.currency_id
                 cross join lateral (select * from private.price_on(t.id, m.product_id, v_date)) e
                where t.is_active and e.id is not null))
           ), '[]'::jsonb)
      from private.margin_batches(p_product_id) m join public.inventory_batches b on b.id = m.batch_id));
end $$;
revoke all on function public.price_list_batch_margins(uuid, date) from public, anon, authenticated, service_role;
grant execute on function public.price_list_batch_margins(uuid, date) to authenticated;

-- Customer card: threshold with history and the customer's margin of every batch in stock, below the threshold marked.
create or replace function public.customer_margin_overview(p_customer_id uuid, p_date date default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_date date := coalesce(p_date, private.business_today());
  v_threshold public.customer_margin_thresholds;
begin
  perform private.require_customer_terms(p_customer_id, false);
  perform private.require_margin_view();
  v_threshold := private.customer_margin_threshold(p_customer_id);
  return jsonb_build_object(
    'date', v_date,
    'can_manage', private.has_permission('pricing.margin_threshold.manage'),
    'threshold', v_threshold.threshold_pct::text,
    'history', (select coalesce(jsonb_agg(jsonb_build_object('threshold', h.threshold_pct::text,
                  'previous', h.previous::text, 'reason', h.reason, 'created_at', h.created_at, 'author', p.full_name)
                  order by h.created_at desc, h.id desc), '[]'::jsonb)
                from (select x.*, lag(x.threshold_pct) over (order by x.created_at, x.id) as previous
                        from public.customer_margin_thresholds x where x.customer_id = p_customer_id) h
                left join public.profiles p on p.id = h.created_by),
    'rows', (select coalesce(jsonb_agg(jsonb_build_object(
               'product_id', pr.id, 'sku', pr.internal_sku, 'product', coalesce(pr.name->>'ru', pr.internal_sku),
               'batch_id', m.batch_id, 'batch_number', m.batch_number, 'expiry_date', m.expiry_date, 'available', m.available,
               'price', r.margin->'quote'->>'price', 'currency', r.margin->'quote'->>'contract_currency',
               'price_source', r.margin->'quote'->>'source',
               'margin_pct', r.margin->>'margin_pct', 'markup_pct', r.margin->>'markup_pct', 'reason', r.margin->>'reason',
               'cost_basis', r.margin->>'cost_basis',
               'below', v_threshold.threshold_pct is not null and (r.margin->>'margin_pct')::numeric < v_threshold.threshold_pct)
               order by pr.internal_sku, m.expiry_date, m.batch_number), '[]'::jsonb)
             from private.margin_batches(null) m join public.products pr on pr.id = m.product_id
             cross join lateral (select private.customer_batch_margin(p_customer_id, m.batch_id, v_date) as margin) r));
end $$;
revoke all on function public.customer_margin_overview(uuid, date) from public, anon, authenticated, service_role;
grant execute on function public.customer_margin_overview(uuid, date) to authenticated;

create or replace function public.set_customer_margin_threshold(p_customer_id uuid, p_threshold_pct numeric, p_reason text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not (select private.has_permission('pricing.margin_threshold.manage')) or not (select private.has_permission('prices.purchase.view')) then
    raise exception 'Нет права изменять порог маржи' using errcode = '42501';
  end if;
  perform private.require_customer_terms(p_customer_id, false);
  if p_threshold_pct is not null and (p_threshold_pct < -100 or p_threshold_pct > 100) then
    raise exception 'Порог маржи должен быть от -100 до 100 процентов';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 3 and 1000 then
    raise exception 'Укажите причину изменения порога';
  end if;
  insert into public.customer_margin_thresholds(customer_id, threshold_pct, reason, created_by)
  values (p_customer_id, round(p_threshold_pct, 2), btrim(p_reason), auth.uid()) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.set_customer_margin_threshold(uuid, numeric, text) from public, anon, authenticated, service_role;
grant execute on function public.set_customer_margin_threshold(uuid, numeric, text) to authenticated;

-- "Проверьте цену" -----------------------------------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'deadline', 'overdue', 'approval_request', 'approval_decision', 'status_change', 'discrepancy',
  'low_shelf_life', 'document_uploaded', 'sync_error', 'system',
  'task_assigned', 'task_reassigned', 'stage_blocked', 'order_blocked', 'price_review'));

-- One notification per batch to everybody who can change the price list and sees purchase prices. The dedupe key
-- is the batch and what the result depends on (its cost; for each customer below: threshold, price-list entry or
-- fixed price, percent, price type): the same state is never notified twice, a change is. No amounts in the text.
create or replace function private.price_review_alerts(p_batch_ids uuid[])
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_date date := private.business_today();
  m record;
  c record;
  v_margin jsonb;
  v_below jsonb;
  v_key text;
  v_sent integer := 0;
  u record;
begin
  if not exists (select 1 from public.customer_margin_thresholds) then
    return 0;
  end if;
  for m in
    select x.batch_id, x.batch_number, b.unit_landed_cost, b.cost_uom, b.cost_currency_id, b.cost_calculation_id,
           p.id as product_id, p.internal_sku, coalesce(p.name->>'ru', p.internal_sku) as product_name
      from private.margin_batches(null) x join public.inventory_batches b on b.id = x.batch_id
      join public.products p on p.id = x.product_id
     where b.unit_landed_cost is not null and (p_batch_ids is null or x.batch_id = any(p_batch_ids))
  loop
    v_below := '[]'::jsonb;
    for c in
      select t.customer_id, t.id as threshold_id, t.threshold_pct
        from (select distinct on (customer_id) * from public.customer_margin_thresholds
               order by customer_id, created_at desc, id desc) t
        join public.counterparties cp on cp.id = t.customer_id and 'customer' = any(cp.roles) and cp.status = 'active'
       where t.threshold_pct is not null
       order by t.customer_id
    loop
      v_margin := private.customer_batch_margin(c.customer_id, m.batch_id, v_date);
      if v_margin->>'margin_pct' is not null and (v_margin->>'margin_pct')::numeric < c.threshold_pct then
        v_below := v_below || jsonb_build_array(jsonb_build_object('customer', c.customer_id, 'threshold', c.threshold_id,
          'entry', v_margin->'quote'->>'price_list_entry_id', 'fixed', v_margin->'quote'->>'fixed_price_id',
          'percent', v_margin->'quote'->>'percent', 'type', v_margin->'quote'->>'price_type'));
      end if;
    end loop;
    if jsonb_array_length(v_below) = 0 then
      continue;
    end if;
    v_key := 'price_review:' || m.batch_id || ':' || md5(jsonb_build_object('cost', m.unit_landed_cost, 'uom', m.cost_uom,
               'currency', m.cost_currency_id, 'calculation', m.cost_calculation_id, 'below', v_below)::text);
    for u in
      select pr.id from public.profiles pr
       where private.user_has_permission(pr.id, 'pricing.list.manage') and private.user_has_permission(pr.id, 'prices.purchase.view')
       order by pr.id
    loop
      if private.notify(u.id, 'price_review', 'Проверьте цену: ' || m.internal_sku,
           format('%s, партия %s: маржа ниже порога у клиентов: %s. Цена сама не меняется — решение в прайсе.',
                  m.product_name, m.batch_number, jsonb_array_length(v_below)),
           'price_review', m.product_id, null, v_key) then
        v_sent := v_sent + 1;
      end if;
    end loop;
  end loop;
  return v_sent;
end $$;
revoke all on function private.price_review_alerts(uuid[]) from public, anon, authenticated, service_role;

-- A failing check must never undo what triggered it (cost approval, a price, a condition): own subtransaction.
create or replace function private.safe_price_review(p_batch_ids uuid[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform private.price_review_alerts(p_batch_ids);
  exception when others then
    raise warning 'price review check skipped: %', sqlerrm;
  end;
end $$;
revoke all on function private.safe_price_review(uuid[]) from public, anon, authenticated, service_role;

create or replace function private.price_review_after_cost() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.safe_price_review(array[new.id]);
  return null;
end $$;
revoke all on function private.price_review_after_cost() from public, anon, authenticated, service_role;
drop trigger if exists price_review_after_cost on public.inventory_batches;
create trigger price_review_after_cost
  after update of unit_landed_cost, cost_uom, cost_currency_id, cost_calculation_id on public.inventory_batches
  for each row when (new.unit_landed_cost is not null and (
    old.unit_landed_cost is distinct from new.unit_landed_cost or old.cost_uom is distinct from new.cost_uom
    or old.cost_currency_id is distinct from new.cost_currency_id or old.cost_calculation_id is distinct from new.cost_calculation_id))
  execute function private.price_review_after_cost();

-- A new price: batches of the products concerned. New customer conditions or thresholds: all batches.
create or replace function private.price_review_after_price() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.safe_price_review(array(select b.id from public.inventory_batches b where b.product_id in (select product_id from new_rows)));
  return null;
end $$;
create or replace function private.price_review_after_condition() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.safe_price_review(null);
  return null;
end $$;
revoke all on function private.price_review_after_price(), private.price_review_after_condition() from public, anon, authenticated, service_role;
drop trigger if exists price_review_after_price on public.price_list_entries;
create trigger price_review_after_price after insert on public.price_list_entries
  referencing new table as new_rows for each statement execute function private.price_review_after_price();
drop trigger if exists price_review_after_fixed_price on public.customer_fixed_prices;
create trigger price_review_after_fixed_price after insert on public.customer_fixed_prices
  referencing new table as new_rows for each statement execute function private.price_review_after_price();
drop trigger if exists price_review_after_terms on public.customer_price_terms;
create trigger price_review_after_terms after insert on public.customer_price_terms
  for each statement execute function private.price_review_after_condition();
drop trigger if exists price_review_after_markup on public.customer_brand_markups;
create trigger price_review_after_markup after insert on public.customer_brand_markups
  for each statement execute function private.price_review_after_condition();
drop trigger if exists price_review_after_threshold on public.customer_margin_thresholds;
create trigger price_review_after_threshold after insert on public.customer_margin_thresholds
  for each statement execute function private.price_review_after_condition();
commit;
