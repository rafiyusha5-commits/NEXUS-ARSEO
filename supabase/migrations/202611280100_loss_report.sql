-- Block Г (2026-11-28): losses of goods and stock at risk by shelf life, in money.
-- Owner decisions of 2026-11-28 (damirator1-afk, defaults of the task accepted), see docs/losses.md:
--   * a write-off and a decreasing adjustment carry a reason from a directory: expired, damaged, shortage found by a
--     count, mis-sort, accounting error, other; a new document is not posted while a line has no reason;
--   * documents posted before this migration keep "причина не указана" (nothing is guessed from the free text); an
--     administrator may set the reason of such a line once, with a basis, recorded in the audit log;
--   * the total of losses is goods lost at the approved cost of the batch: write-off documents, decreasing
--     adjustments, returned goods written off by the return decision and direct write-off movements made before
--     documents existed; customer returns by expiry (refunded revenue) and markdowns of low shelf-life sales (revenue
--     not received) are reference columns and are never added to the total;
--   * amounts in tenge at the official rate on the date of the loss, as in the profitability report; no cost, no
--     packaging or no rate is a mark, never zero;
--   * quantities need reports.view and inventory.view; amounts also prices.purchase.view.
-- Stock and documents are changed only by the existing posting functions; this migration adds a check before posting.
begin;

-- Reasons -------------------------------------------------------------------------------------------------------
create table if not exists public.inventory_loss_reasons (
  code text primary key check (code ~ '^[a-z][a-z_]{1,39}$'),
  name text not null check (length(btrim(name)) between 2 and 120),
  sort_order integer not null default 100,
  is_active boolean not null default true
);
alter table public.inventory_loss_reasons enable row level security;
revoke all on public.inventory_loss_reasons from public, anon, authenticated, service_role;
grant select on public.inventory_loss_reasons to authenticated;
drop policy if exists "employees view loss reasons" on public.inventory_loss_reasons;
create policy "employees view loss reasons" on public.inventory_loss_reasons
  for select to authenticated using ((select private.is_employee()));

insert into public.inventory_loss_reasons(code, name, sort_order) values
  ('expired', 'Истёк срок годности', 10),
  ('damaged', 'Бой, брак, повреждение', 20),
  ('count_shortage', 'Недостача при пересчёте', 30),
  ('mis_sort', 'Пересорт', 40),
  ('accounting_error', 'Ошибка учёта', 50),
  ('other', 'Прочее', 90)
on conflict (code) do nothing;

alter table public.inventory_operation_lines
  add column if not exists loss_reason_code text references public.inventory_loss_reasons(code) on delete restrict,
  add column if not exists loss_reason_source text,
  add column if not exists loss_reason_set_by uuid references public.profiles(id) on delete restrict,
  add column if not exists loss_reason_set_at timestamptz;

do $$begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_operation_lines_loss_reason_check') then
    alter table public.inventory_operation_lines add constraint inventory_operation_lines_loss_reason_check check (
      (loss_reason_code is null) = (loss_reason_source is null)
      and (loss_reason_source is null or loss_reason_source in ('document', 'classified'))
      and (loss_reason_code is null or (loss_reason_set_by is not null and loss_reason_set_at is not null)));
  end if;
end $$;

create index if not exists inventory_operation_lines_loss_reason_idx on public.inventory_operation_lines(loss_reason_code);
create index if not exists inventory_operation_lines_loss_reason_set_by_idx on public.inventory_operation_lines(loss_reason_set_by);

-- Rights ----------------------------------------------------------------------------------------------------------
-- A module of its own: older migrations re-applied by the tests grant whole modules to roles.
insert into public.permissions(code, module, action, name, description)
values ('losses.reason_classify', 'losses', 'reason_classify', 'Потери: причина старых списаний',
        'Указать причину списания, проведённого без причины, с основанием; запись в журнале аудита')
on conflict (code) do nothing;

insert into public.role_permissions(role_id, permission_id, granted)
select r.id, p.id, true
  from public.app_roles r
  cross join public.permissions p
 where r.code = 'administrator'
   and p.code = 'losses.reason_classify'
on conflict (role_id, permission_id) do nothing;

-- A line needs a reason when it takes goods away: every write-off line and a decreasing adjustment.
create or replace function private.loss_reason_required(p_operation_type text, p_direction text)
returns boolean
language sql immutable set search_path = '' as $$
  select p_operation_type = 'write_off' or (p_operation_type = 'adjustment' and p_direction = 'decrease')
$$;
revoke all on function private.loss_reason_required(text, text) from public, anon, authenticated, service_role;

-- Posting checks the reasons whatever function posts: the status changes from draft to posted in this transaction.
create or replace function private.require_loss_reasons_on_post()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'posted' and old.status = 'draft' and exists (
       select 1
         from public.inventory_operation_lines l
        where l.document_id = new.id
          and l.loss_reason_code is null
          and private.loss_reason_required(new.operation_type, l.adjustment_direction)) then
    -- An authored rule message (P0001): the screen shows it as it is.
    raise exception 'Укажите причину списания в каждой строке: истёк срок, бой или брак, недостача, пересорт, ошибка учёта или прочее';
  end if;
  return new;
end $$;
revoke all on function private.require_loss_reasons_on_post() from public, anon, authenticated, service_role;

drop trigger if exists inventory_operation_documents_loss_reasons on public.inventory_operation_documents;
create trigger inventory_operation_documents_loss_reasons
  before update of status on public.inventory_operation_documents
  for each row execute function private.require_loss_reasons_on_post();

-- Setting a reason --------------------------------------------------------------------------------------------------
-- Draft: by whoever may change the document. Posted without a reason: once, with a basis, by losses.reason_classify;
-- the audit log keeps who, when and why. A reason once set on a posted line is never changed.
create or replace function public.set_inventory_loss_reason(p_line_id uuid, p_loss_reason_code text, p_basis text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_line public.inventory_operation_lines;
  v_document public.inventory_operation_documents;
  v_basis text := nullif(btrim(coalesce(p_basis, '')), '');
begin
  select * into v_line from public.inventory_operation_lines where id = p_line_id for update;
  if not found then
    raise exception 'Строка складского документа не найдена';
  end if;
  select * into v_document from public.inventory_operation_documents where id = v_line.document_id for update;
  if not private.loss_reason_required(v_document.operation_type, v_line.adjustment_direction) then
    raise exception 'Причина указывается только для списания и уменьшения остатка';
  end if;
  if p_loss_reason_code is null
     or not exists (select 1 from public.inventory_loss_reasons where code = p_loss_reason_code and is_active) then
    raise exception 'Выберите причину списания';
  end if;

  if v_document.status = 'draft' then
    perform private.require_inventory_operation_permission(v_document.operation_type);
    update public.inventory_operation_lines
       set loss_reason_code = p_loss_reason_code,
           loss_reason_source = 'document',
           loss_reason_set_by = auth.uid(),
           loss_reason_set_at = now()
     where id = v_line.id;
    return;
  end if;

  if v_document.status <> 'posted' then
    raise exception 'Документ отменён: причину не указать';
  end if;
  if not (select private.has_permission('losses.reason_classify'))
     or not (select private.has_permission('inventory.view')) then
    raise exception 'Нет права указывать причину проведённого списания' using errcode = '42501';
  end if;
  if v_line.loss_reason_code is not null then
    raise exception 'Причина уже указана, изменить её нельзя';
  end if;
  if v_basis is null or length(v_basis) not between 10 and 1000 then
    raise exception 'Укажите основание (от 10 до 1000 символов): акт, служебная записка, пояснение кладовщика';
  end if;
  update public.inventory_operation_lines
     set loss_reason_code = p_loss_reason_code,
         loss_reason_source = 'classified',
         loss_reason_set_by = auth.uid(),
         loss_reason_set_at = now()
   where id = v_line.id;
  insert into public.audit_log(actor_user_id, action, entity_type, entity_id, before_data, after_data, metadata)
  values (auth.uid(), 'inventory_loss_reason_classified', 'inventory_operation_lines', v_line.id::text,
          jsonb_build_object('loss_reason_code', null),
          jsonb_build_object('loss_reason_code', p_loss_reason_code),
          jsonb_build_object('document_id', v_document.id, 'document_number', v_document.document_number, 'basis', v_basis));
end $$;
revoke all on function public.set_inventory_loss_reason(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.set_inventory_loss_reason(uuid, text, text) to authenticated;

-- A line of a write-off or decreasing adjustment with its reason, in one transaction. add_inventory_operation_line
-- keeps its signature for the transfer and the assistant; it checks the document, the rights and the balance.
create or replace function public.add_inventory_loss_line(p_document_id uuid, p_source_balance_id uuid, p_quantity numeric,
                                                          p_adjustment_direction text, p_loss_reason_code text,
                                                          p_notes text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_type text;
  v_id uuid;
begin
  select operation_type into v_type from public.inventory_operation_documents where id = p_document_id;
  if v_type is null then
    raise exception 'Складской документ не найден';
  end if;
  if v_type = 'transfer' then
    raise exception 'Для перемещения причина списания не нужна';
  end if;
  v_id := public.add_inventory_operation_line(p_document_id, p_source_balance_id, null, p_quantity, p_adjustment_direction, p_notes);
  if private.loss_reason_required(v_type, p_adjustment_direction) then
    perform public.set_inventory_loss_reason(v_id, p_loss_reason_code, null);
  elsif p_loss_reason_code is not null then
    raise exception 'Причина указывается только для списания и уменьшения остатка';
  end if;
  return v_id;
end $$;
revoke all on function public.add_inventory_loss_line(uuid, uuid, numeric, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.add_inventory_loss_line(uuid, uuid, numeric, text, text, text) to authenticated;

-- Access ------------------------------------------------------------------------------------------------------------
create or replace function private.require_loss_view()
returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (select private.has_permission('reports.view')) or not (select private.has_permission('inventory.view')) then
    raise exception 'Нет доступа к отчёту о потерях' using errcode = '42501';
  end if;
end $$;
revoke all on function private.require_loss_view() from public, anon, authenticated, service_role;

-- Brand of a product for grouping: the directory brand, else the text of the card, else "Без бренда".
create or replace function private.loss_brand(p_product_id uuid)
returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select b.name from public.brands b where b.id = private.product_brand(p.id)),
                  nullif(btrim(p.brand), ''),
                  'Без бренда')
    from public.products p
   where p.id = p_product_id
$$;
revoke all on function private.loss_brand(uuid) from public, anon, authenticated, service_role;

-- Lines of losses ---------------------------------------------------------------------------------------------------
-- One row per lost piece of stock in the period:
--   document — a line of a posted write-off or decreasing adjustment (a cancelled document is not a loss);
--   return   — a returned item written off by the return decision (reason from the return: expiry, damage, other);
--   movement — a write-off movement without a document (direct write-offs before 202609278400), reason unknown.
-- Cost: quantity of that very batch x the approved cost of the batch, in tenge at the official rate of the day.
create or replace function private.loss_lines(p_from date, p_to date)
returns table(
  line_id uuid, source text, ref_id uuid, ref_number text, line_date date, reason_code text, warehouse_id uuid,
  product_id uuid, batch_id uuid, shipment_id uuid, uom text, quantity numeric, pieces numeric,
  cost_currency_id uuid, cost_amount numeric, rate numeric, rate_date date, cost_kzt numeric, status text)
language sql stable security definer set search_path = '' set jit = off as $$
  with src as (
    select l.id as line_id, 'document'::text as source, d.id as ref_id, d.document_number as ref_number,
           d.document_date as line_date, l.loss_reason_code as reason_code, d.from_warehouse_id as warehouse_id,
           l.batch_id, l.uom, l.quantity
      from public.inventory_operation_lines l
      join public.inventory_operation_documents d on d.id = l.document_id
     where d.status = 'posted'
       and d.document_date between p_from and p_to
       and private.loss_reason_required(d.operation_type, l.adjustment_direction)
    union all
    select ri.id, 'return', cr.id, cr.return_number, (ri.decided_at at time zone 'Asia/Almaty')::date,
           case ri.reason_code when 'expiry' then 'expired' when 'defect' then 'damaged' when 'damaged' then 'damaged' else 'other' end,
           cr.warehouse_id, ri.batch_id, ri.uom, ri.quantity
      from public.customer_return_items ri
      join public.customer_returns cr on cr.id = ri.return_id
     where ri.decision = 'write_off'
       and cr.status <> 'cancelled'
       and ri.decided_at >= (p_from::timestamp at time zone 'Asia/Almaty')
       and ri.decided_at < ((p_to + 1)::timestamp at time zone 'Asia/Almaty')
    union all
    select m.id, 'movement', null::uuid, m.reference, (m.created_at at time zone 'Asia/Almaty')::date, null::text,
           m.from_warehouse_id, m.batch_id, m.uom, m.quantity
      from public.inventory_movements m
     where m.movement_type = 'write_off'
       and m.inventory_operation_document_id is null
       and not m.is_reversal
       and m.created_at >= (p_from::timestamp at time zone 'Asia/Almaty')
       and m.created_at < ((p_to + 1)::timestamp at time zone 'Asia/Almaty')
  ), costed as (
    select s.*, b.product_id, si.shipment_id, b.unit_landed_cost, b.cost_currency_id,
           s.quantity * private.uom_pieces(b.product_id, s.uom) as pieces,
           private.uom_pieces(b.product_id, coalesce(b.cost_uom, 'piece')) as cost_pieces
      from src s
      join public.inventory_batches b on b.id = s.batch_id
      left join public.shipment_items si on si.id = b.source_shipment_item_id
  ), valued as (
    select c.*,
           case when c.unit_landed_cost is null or c.pieces is null or c.cost_pieces is null or c.cost_pieces <= 0 then null
                else c.pieces / c.cost_pieces * c.unit_landed_cost end as cost_amount
      from costed c
  ), rates as (
    select q.cur, q.d, r.rate, r.rate_date
      from (select distinct v.cost_currency_id as cur, v.line_date as d from valued v where v.cost_currency_id is not null) q
      cross join lateral private.official_conversion(q.cur, (select id from public.currencies where code = 'KZT'), q.d) r
  )
  select v.line_id, v.source, v.ref_id, v.ref_number, v.line_date, v.reason_code, v.warehouse_id, v.product_id, v.batch_id,
         v.shipment_id, v.uom, v.quantity, v.pieces, v.cost_currency_id, v.cost_amount, r.rate, r.rate_date,
         round(v.cost_amount * r.rate, 2),
         case when v.pieces is null then 'no_packaging'
              when v.unit_landed_cost is null or v.cost_currency_id is null then 'no_cost'
              when v.cost_amount is null then 'no_packaging'
              when r.rate is null then 'no_rate'
              else 'complete' end
    from valued v
    left join rates r on r.cur = v.cost_currency_id and r.d = v.line_date
$$;
revoke all on function private.loss_lines(date, date) from public, anon, authenticated, service_role;

-- Reference: customer returns by expiry in the period (revenue refunded), at the sale price without VAT, in tenge.
create or replace function private.loss_expiry_returns(p_from date, p_to date)
returns table(item_id uuid, line_date date, product_id uuid, batch_id uuid, shipment_id uuid, warehouse_id uuid,
              pieces numeric, amount_kzt numeric, status text)
language sql stable security definer set search_path = '' set jit = off as $$
  with src as (
    select ri.id, (cr.received_at at time zone 'Asia/Almaty')::date as d, i.id as sale_item_id, i.product_id,
           ri.batch_id, cr.warehouse_id, ri.quantity, ri.uom, i.uom as sale_uom,
           coalesce(ri.unit_price, i.unit_price) as unit_price, s.currency_id
      from public.customer_return_items ri
      join public.customer_returns cr on cr.id = ri.return_id
      join public.sale_items i on i.id = ri.sale_item_id
      join public.sales s on s.id = i.sale_id
     where ri.reason_code = 'expiry'
       and cr.status <> 'cancelled'
       and cr.received_at >= (p_from::timestamp at time zone 'Asia/Almaty')
       and cr.received_at < ((p_to + 1)::timestamp at time zone 'Asia/Almaty')
  ), q as (
    select x.*, x.quantity * private.uom_pieces(x.product_id, x.uom) as pieces,
           x.quantity * private.uom_pieces(x.product_id, x.uom) / nullif(private.uom_pieces(x.product_id, x.sale_uom), 0) as sale_qty,
           v.vat_included, v.vat_country
      from src x
      cross join lateral private.sale_line_vat(x.sale_item_id) v
  ), taxed as (
    select q.*, case when q.vat_included then private.vat_rate_on(q.vat_country, q.d) end as vat_rate from q
  ), rates as (
    select z.cur, z.d, r.rate
      from (select distinct t.currency_id as cur, t.d from taxed t where t.currency_id is not null) z
      cross join lateral private.official_conversion(z.cur, (select id from public.currencies where code = 'KZT'), z.d) r
  )
  select t.id, t.d, t.product_id, t.batch_id, si.shipment_id, t.warehouse_id, t.pieces,
         round(t.unit_price * t.sale_qty / (1 + coalesce(t.vat_rate, 0)) * r.rate, 2),
         case when t.unit_price is null or t.currency_id is null then 'no_price'
              when t.sale_qty is null then 'no_packaging'
              when t.vat_included and t.vat_rate is null then 'no_vat_rate'
              when r.rate is null then 'no_rate'
              else 'complete' end
    from taxed t
    join public.inventory_batches b on b.id = t.batch_id
    left join public.shipment_items si on si.id = b.source_shipment_item_id
    left join rates r on r.cur = t.currency_id and r.d = t.d
$$;
revoke all on function private.loss_expiry_returns(date, date) from public, anon, authenticated, service_role;

-- Reference: markdowns of low shelf-life sales shipped in the period: the price-list price saved on the order line
-- (block 1б) minus the program price, x shipped quantity, without VAT, in tenge. Revenue not received, not a cost.
create or replace function private.loss_markdowns(p_from date, p_to date)
returns table(movement_id uuid, line_date date, product_id uuid, batch_id uuid, shipment_id uuid, warehouse_id uuid,
              pieces numeric, markdown_kzt numeric, status text)
language sql stable security definer set search_path = '' set jit = off as $$
  with src as (
    select m.id, coalesce(s.historical_shipment_date, (m.created_at at time zone 'Asia/Almaty')::date) as d,
           i.id as sale_item_id, i.product_id, m.batch_id, m.from_warehouse_id, m.quantity, m.uom, i.uom as sale_uom,
           i.unit_price, s.currency_id,
           case when jsonb_typeof(i.price_snapshot -> 'price_list_quote' -> 'price') = 'number'
                then (i.price_snapshot -> 'price_list_quote' ->> 'price')::numeric end as list_price
      from public.inventory_movements m
      join public.sale_items i on i.id = m.sale_item_id
      join public.sales s on s.id = i.sale_id
      join public.commercial_program_lines pl on pl.id = i.commercial_program_line_id
      join public.commercial_programs p on p.id = pl.commercial_program_id and p.kind = 'low_shelf_life'
     where m.movement_type = 'issue'
       and ((s.historical_shipment_date is not null and s.historical_shipment_date between p_from and p_to)
            or (s.historical_shipment_date is null
                and m.created_at >= (p_from::timestamp at time zone 'Asia/Almaty')
                and m.created_at < ((p_to + 1)::timestamp at time zone 'Asia/Almaty')))
  ), q as (
    select x.*, x.quantity * private.uom_pieces(x.product_id, x.uom) as pieces,
           x.quantity * private.uom_pieces(x.product_id, x.uom) / nullif(private.uom_pieces(x.product_id, x.sale_uom), 0) as sale_qty,
           v.vat_included, v.vat_country
      from src x
      cross join lateral private.sale_line_vat(x.sale_item_id) v
  ), taxed as (
    select q.*, case when q.vat_included then private.vat_rate_on(q.vat_country, q.d) end as vat_rate from q
  ), rates as (
    select z.cur, z.d, r.rate
      from (select distinct t.currency_id as cur, t.d from taxed t where t.currency_id is not null) z
      cross join lateral private.official_conversion(z.cur, (select id from public.currencies where code = 'KZT'), z.d) r
  )
  select t.id, t.d, t.product_id, t.batch_id, si.shipment_id, t.from_warehouse_id, t.pieces,
         round((t.list_price - t.unit_price) * t.sale_qty / (1 + coalesce(t.vat_rate, 0)) * r.rate, 2),
         case when t.list_price is null then 'no_list_price'
              when t.unit_price is null or t.currency_id is null then 'no_price'
              when t.sale_qty is null then 'no_packaging'
              when t.vat_included and t.vat_rate is null then 'no_vat_rate'
              when r.rate is null then 'no_rate'
              else 'complete' end
    from taxed t
    join public.inventory_batches b on b.id = t.batch_id
    left join public.shipment_items si on si.id = b.source_shipment_item_id
    left join rates r on r.cur = t.currency_id and r.d = t.d
$$;
revoke all on function private.loss_markdowns(date, date) from public, anon, authenticated, service_role;

-- Cost of what was sold in the period (approved batch cost in tenge, as the profitability report counts it).
create or replace function private.loss_cost_of_sales(p_from date, p_to date)
returns table(line_date date, product_id uuid, shipment_id uuid, cost_kzt numeric)
language sql stable security definer set search_path = '' set jit = off as $$
  select l.line_date, l.product_id, l.shipment_id, l.cost_kzt
    from private.profit_lines(p_from, p_to) l
   where l.kind = 'sale' and l.cost_status = 'approved' and l.cost_kzt is not null
$$;
revoke all on function private.loss_cost_of_sales(date, date) from public, anon, authenticated, service_role;

-- Key and name of a group of the report.
create or replace function private.loss_group_key(p_group text, p_product_id uuid, p_warehouse_id uuid, p_shipment_id uuid,
                                                  p_reason_code text, p_date date)
returns text
language sql stable security definer set search_path = '' as $$
  select case p_group
           when 'product' then p_product_id::text
           when 'brand' then private.loss_brand(p_product_id)
           when 'warehouse' then p_warehouse_id::text
           when 'shipment' then p_shipment_id::text
           when 'reason' then coalesce(p_reason_code, 'unspecified')
           else to_char(p_date, 'YYYY-MM') end
$$;
revoke all on function private.loss_group_key(text, uuid, uuid, uuid, text, date) from public, anon, authenticated, service_role;

create or replace function private.loss_group_name(p_group text, p_key text)
returns text
language sql stable security definer set search_path = '' as $$
  select case p_group
           when 'product' then (select p.internal_sku || ' · ' || coalesce(p.name ->> 'ru', p.name ->> 'en', '')
                                  from public.products p where p.id::text = p_key)
           when 'brand' then p_key
           when 'warehouse' then (select w.code || ' · ' || coalesce(w.name ->> 'ru', w.name ->> 'en', '')
                                    from public.warehouses w where w.id::text = p_key)
           when 'shipment' then coalesce((select s.shipment_number from public.shipments s where s.id::text = p_key), 'Без поставки')
           when 'reason' then coalesce((select r.name from public.inventory_loss_reasons r where r.code = p_key), 'Причина не указана')
           else p_key end
$$;
revoke all on function private.loss_group_name(text, text) from public, anon, authenticated, service_role;

-- Report ------------------------------------------------------------------------------------------------------------
-- Losses of the period by product, brand, warehouse, shipment, reason or month. Amounts (and the share of the cost of
-- sales) only for prices.purchase.view: without it every amount is null, not hidden on the screen.
create or replace function public.loss_report(p_group text, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = '' set jit = off as $$
declare
  v_amounts boolean;
  v_result jsonb;
begin
  perform private.require_loss_view();
  if p_group is null or p_group not in ('product', 'brand', 'warehouse', 'shipment', 'reason', 'month') then
    raise exception 'Выберите разрез отчёта';
  end if;
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 3660 then
    raise exception 'Укажите период до 10 лет';
  end if;
  v_amounts := (select private.has_permission('prices.purchase.view'));

  with l as (
    select x.*, private.loss_group_key(p_group, x.product_id, x.warehouse_id, x.shipment_id, x.reason_code, x.line_date) as key
      from private.loss_lines(p_from, p_to) x
  ), rt as (
    select x.*, private.loss_group_key(p_group, x.product_id, x.warehouse_id, x.shipment_id, 'expired', x.line_date) as key
      from private.loss_expiry_returns(p_from, p_to) x
  ), md as (
    select x.*, private.loss_group_key(p_group, x.product_id, x.warehouse_id, x.shipment_id, 'expired', x.line_date) as key
      from private.loss_markdowns(p_from, p_to) x
  ), keys as (
    select key from l union select key from rt union select key from md
  ), la as (
    select l.key, count(*) as lines,
           count(*) filter (where l.status <> 'complete') as incomplete_lines,
           coalesce(sum(l.pieces), 0) as pieces,
           coalesce(sum(l.cost_kzt) filter (where l.status = 'complete'), 0) as cost_kzt,
           jsonb_object_agg_strict(l.status, l.n) as statuses
      from (select l.*, count(*) over (partition by l.key, l.status) as n from l) l
     group by l.key
  ), ra as (
    select rt.key, coalesce(sum(rt.pieces), 0) as pieces,
           coalesce(sum(rt.amount_kzt) filter (where rt.status = 'complete'), 0) as amount_kzt,
           count(*) filter (where rt.status <> 'complete') as incomplete
      from rt group by rt.key
  ), ma as (
    select md.key, coalesce(sum(md.markdown_kzt) filter (where md.status = 'complete'), 0) as markdown_kzt,
           count(*) filter (where md.status <> 'complete') as incomplete
      from md group by md.key
  ), rows as (
    select k.key, private.loss_group_name(p_group, k.key) as name,
           coalesce(la.lines, 0) as lines, coalesce(la.incomplete_lines, 0) as incomplete_lines,
           coalesce(la.pieces, 0) as pieces, coalesce(la.cost_kzt, 0) as cost_kzt, coalesce(la.statuses, '{}'::jsonb) as statuses,
           coalesce(ra.pieces, 0) as returns_pieces, coalesce(ra.amount_kzt, 0) as returns_kzt, coalesce(ra.incomplete, 0) as returns_incomplete,
           coalesce(ma.markdown_kzt, 0) as markdown_kzt, coalesce(ma.incomplete, 0) as markdown_incomplete
      from keys k
      left join la on la.key is not distinct from k.key
      left join ra on ra.key is not distinct from k.key
      left join ma on ma.key is not distinct from k.key
  ), sales as (
    select coalesce(sum(c.cost_kzt), 0) as cost_kzt from private.loss_cost_of_sales(p_from, p_to) c
  )
  select jsonb_build_object(
    'group', p_group, 'from', p_from, 'to', p_to, 'currency', 'KZT', 'amounts', v_amounts,
    'totals', jsonb_build_object(
      'lines', (select count(*) from l),
      'incomplete_lines', (select count(*) from l where l.status <> 'complete'),
      'pieces', (select coalesce(sum(l.pieces), 0) from l)::text,
      'cost_kzt', case when v_amounts then (select coalesce(sum(l.cost_kzt) filter (where l.status = 'complete'), 0) from l)::text end,
      'unspecified_lines', (select count(*) from l where l.reason_code is null),
      'unspecified_cost_kzt', case when v_amounts then (select coalesce(sum(l.cost_kzt) filter (where l.status = 'complete'), 0)
                                                           from l where l.reason_code is null)::text end,
      'cost_of_sales_kzt', case when v_amounts then (select s.cost_kzt from sales s)::text end,
      'share_pct', case when v_amounts and (select s.cost_kzt from sales s) > 0
                        then round((select coalesce(sum(l.cost_kzt) filter (where l.status = 'complete'), 0) from l)
                                   / (select s.cost_kzt from sales s) * 100, 2)::text end,
      'returns_pieces', (select coalesce(sum(rt.pieces), 0) from rt)::text,
      'returns_kzt', case when v_amounts then (select coalesce(sum(rt.amount_kzt) filter (where rt.status = 'complete'), 0) from rt)::text end,
      'markdown_kzt', case when v_amounts then (select coalesce(sum(md.markdown_kzt) filter (where md.status = 'complete'), 0) from md)::text end,
      'markdown_incomplete', (select count(*) from md where md.status <> 'complete')),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'key', r.key, 'name', r.name, 'lines', r.lines, 'incomplete_lines', r.incomplete_lines, 'statuses', r.statuses,
        'pieces', r.pieces::text, 'cost_kzt', case when v_amounts then r.cost_kzt::text end,
        'returns_pieces', r.returns_pieces::text, 'returns_kzt', case when v_amounts then r.returns_kzt::text end,
        'returns_incomplete', r.returns_incomplete,
        'markdown_kzt', case when v_amounts then r.markdown_kzt::text end, 'markdown_incomplete', r.markdown_incomplete)
        order by case when v_amounts then r.cost_kzt else r.pieces end desc, r.name, r.key) from rows r), '[]'::jsonb))
  into v_result;
  return v_result;
end $$;
revoke all on function public.loss_report(text, date, date) from public, anon, authenticated, service_role;
grant execute on function public.loss_report(text, date, date) to authenticated;

-- Lines of the period for the XLSX export: one row per lost line. Amounts only with prices.purchase.view.
create or replace function public.loss_report_lines(p_from date, p_to date)
returns table(
  line_date date, source text, ref_number text, reason text, warehouse text, sku text, product text, batch text,
  expiry_date date, shipment text, uom text, quantity numeric, pieces numeric, cost_currency text, cost numeric,
  rate numeric, cost_kzt numeric, status text)
language plpgsql stable security definer set search_path = '' set jit = off as $$
declare
  v_amounts boolean;
begin
  perform private.require_loss_view();
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 3660 then
    raise exception 'Укажите период до 10 лет';
  end if;
  v_amounts := (select private.has_permission('prices.purchase.view'));
  return query
    select l.line_date, l.source, l.ref_number,
           coalesce((select r.name from public.inventory_loss_reasons r where r.code = l.reason_code), 'Причина не указана'),
           w.code, p.internal_sku, coalesce(p.name ->> 'ru', p.name ->> 'en', ''), b.batch_number, b.expiry_date,
           s.shipment_number, l.uom, l.quantity, l.pieces,
           case when v_amounts then c.code::text end,
           case when v_amounts then round(l.cost_amount, 4) end,
           case when v_amounts then l.rate end,
           case when v_amounts then l.cost_kzt end,
           l.status
      from private.loss_lines(p_from, p_to) l
      join public.products p on p.id = l.product_id
      join public.inventory_batches b on b.id = l.batch_id
      left join public.warehouses w on w.id = l.warehouse_id
      left join public.shipments s on s.id = l.shipment_id
      left join public.currencies c on c.id = l.cost_currency_id
     order by l.line_date, l.ref_number, p.internal_sku, l.line_id;
end $$;
revoke all on function public.loss_report_lines(date, date) from public, anon, authenticated, service_role;
grant execute on function public.loss_report_lines(date, date) to authenticated;

-- Stock at risk now: balances whose batch expires within 90 days or has expired, at the approved cost in tenge at
-- today's official rate. Grouped by bucket (expired / up to 30 days / 31-90 days), warehouse, brand or supplier.
-- Plan of each balance: in a low shelf-life sale, reserved for orders (fully or partly) or none.
create or replace function public.loss_risk(p_group text default 'bucket')
returns jsonb
language plpgsql stable security definer set search_path = '' set jit = off as $$
declare
  v_today date := private.business_today();
  v_kzt uuid := (select id from public.currencies where code = 'KZT');
  v_amounts boolean;
  v_result jsonb;
begin
  perform private.require_loss_view();
  if p_group is null or p_group not in ('bucket', 'warehouse', 'brand', 'supplier') then
    raise exception 'Выберите разрез отчёта';
  end if;
  v_amounts := (select private.has_permission('prices.purchase.view'));

  with bal as (
    select bl.id, bl.batch_id, bl.warehouse_id, bl.warehouse_location_id, bl.uom, bl.quantity_on_hand, bl.quantity_reserved,
           b.product_id, b.batch_number, b.expiry_date, b.status as batch_status, b.unit_landed_cost, b.cost_currency_id, b.cost_uom,
           b.expiry_date - v_today as days_left,
           case when b.expiry_date < v_today then 'expired' when b.expiry_date <= v_today + 30 then 'critical' else 'warning' end as bucket,
           sh.supplier_id
      from public.inventory_balances bl
      join public.inventory_batches b on b.id = bl.batch_id
      left join public.shipment_items si on si.id = b.source_shipment_item_id
      left join public.shipments sh on sh.id = si.shipment_id
     where bl.quantity_on_hand > 0
       and b.expiry_date is not null
       and b.expiry_date <= v_today + 90
  ), valued as (
    select x.*,
           x.quantity_on_hand * private.uom_pieces(x.product_id, x.uom) as pieces,
           x.quantity_reserved * private.uom_pieces(x.product_id, x.uom) as reserved_pieces,
           private.uom_pieces(x.product_id, coalesce(x.cost_uom, 'piece')) as cost_pieces,
           exists (select 1 from public.commercial_program_lines pl
                     join public.commercial_programs p on p.id = pl.commercial_program_id
                    where pl.inventory_balance_id = x.id and p.kind = 'low_shelf_life' and p.status in ('approved', 'ordered')) as in_program
      from bal x
  ), rates as (
    select z.cur, r.rate
      from (select distinct v.cost_currency_id as cur from valued v where v.cost_currency_id is not null) z
      cross join lateral private.official_conversion(z.cur, v_kzt, v_today) r
  ), items as (
    select v.*,
           case when v.unit_landed_cost is null or v.pieces is null or v.cost_pieces is null or v.cost_pieces <= 0 or r.rate is null then null
                else round(v.pieces / v.cost_pieces * v.unit_landed_cost * r.rate, 2) end as cost_kzt,
           case when v.pieces is null then 'no_packaging'
                when v.unit_landed_cost is null or v.cost_currency_id is null then 'no_cost'
                when v.cost_pieces is null or v.cost_pieces <= 0 then 'no_packaging'
                when r.rate is null then 'no_rate'
                else 'complete' end as status,
           case when v.in_program then 'program'
                when v.quantity_reserved >= v.quantity_on_hand then 'reserved'
                when v.quantity_reserved > 0 then 'partly_reserved'
                else 'none' end as plan,
           case p_group
             when 'bucket' then case when v.days_left < 0 then 'expired' when v.days_left <= 30 then 'critical' else 'warning' end
             when 'warehouse' then v.warehouse_id::text
             when 'brand' then private.loss_brand(v.product_id)
             else v.supplier_id::text end as key
      from valued v
      left join rates r on r.cur = v.cost_currency_id
  ), groups as (
    select i.key, count(*) as balances, coalesce(sum(i.pieces), 0) as pieces,
           coalesce(sum(i.cost_kzt), 0) as cost_kzt,
           count(*) filter (where i.status <> 'complete') as incomplete,
           coalesce(sum(i.pieces) filter (where i.plan = 'none'), 0) as no_plan_pieces,
           coalesce(sum(i.cost_kzt) filter (where i.plan = 'none'), 0) as no_plan_cost_kzt,
           min(i.days_left) as min_days_left
      from items i group by i.key
  )
  select jsonb_build_object(
    'group', p_group, 'date', v_today, 'currency', 'KZT', 'amounts', v_amounts,
    'buckets', (select jsonb_object_agg(b.bucket, jsonb_build_object(
                  'balances', b.balances, 'pieces', b.pieces::text,
                  'cost_kzt', case when v_amounts then b.cost_kzt::text end, 'incomplete', b.incomplete))
                from (select i.bucket, count(*) as balances, coalesce(sum(i.pieces), 0) as pieces,
                             coalesce(sum(i.cost_kzt), 0) as cost_kzt, count(*) filter (where i.status <> 'complete') as incomplete
                        from items i group by i.bucket) b),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
               'key', g.key,
               'name', case p_group
                         when 'bucket' then case g.key when 'expired' then 'Срок истёк' when 'critical' then 'До 30 дней' else '31–90 дней' end
                         when 'warehouse' then (select w.code || ' · ' || coalesce(w.name ->> 'ru', w.name ->> 'en', '')
                                                  from public.warehouses w where w.id::text = g.key)
                         when 'brand' then g.key
                         else coalesce((select coalesce(c.short_name, c.legal_name) from public.counterparties c where c.id::text = g.key),
                                       'Поставщик не указан') end,
               'balances', g.balances, 'pieces', g.pieces::text, 'cost_kzt', case when v_amounts then g.cost_kzt::text end,
               'incomplete', g.incomplete, 'no_plan_pieces', g.no_plan_pieces::text,
               'no_plan_cost_kzt', case when v_amounts then g.no_plan_cost_kzt::text end, 'min_days_left', g.min_days_left)
               order by g.min_days_left, g.key) from groups g), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
               'balance_id', i.id, 'batch_id', i.batch_id, 'sku', p.internal_sku,
               'product', coalesce(p.name ->> 'ru', p.name ->> 'en', ''), 'brand', private.loss_brand(i.product_id),
               'batch', i.batch_number, 'expiry_date', i.expiry_date, 'days_left', i.days_left, 'bucket', i.bucket,
               'batch_status', i.batch_status, 'warehouse', w.code, 'location', loc.code, 'uom', i.uom,
               'quantity', i.quantity_on_hand::text, 'reserved', i.quantity_reserved::text, 'pieces', i.pieces::text,
               'plan', i.plan, 'cost_kzt', case when v_amounts then i.cost_kzt::text end, 'status', i.status)
               order by i.expiry_date, p.internal_sku, i.id)
             from (select * from items order by expiry_date, id limit 500) i
             join public.products p on p.id = i.product_id
             left join public.warehouses w on w.id = i.warehouse_id
             left join public.warehouse_locations loc on loc.id = i.warehouse_location_id), '[]'::jsonb),
    'items_total', (select count(*) from items))
  into v_result;
  return v_result;
end $$;
revoke all on function public.loss_risk(text) from public, anon, authenticated, service_role;
grant execute on function public.loss_risk(text) to authenticated;

-- Losses by month and reason over the last months, with the share of the cost of sales of each month.
create or replace function public.loss_trend(p_months integer default 12)
returns jsonb
language plpgsql stable security definer set search_path = '' set jit = off as $$
declare
  v_today date := private.business_today();
  v_from date;
  v_amounts boolean;
  v_result jsonb;
begin
  perform private.require_loss_view();
  if p_months is null or p_months not between 1 and 36 then
    raise exception 'Укажите от 1 до 36 месяцев';
  end if;
  v_amounts := (select private.has_permission('prices.purchase.view'));
  v_from := (date_trunc('month', v_today) - make_interval(months => p_months - 1))::date;

  with l as (select * from private.loss_lines(v_from, v_today)),
  s as (select to_char(c.line_date, 'YYYY-MM') as month, sum(c.cost_kzt) as cost_kzt
          from private.loss_cost_of_sales(v_from, v_today) c group by 1),
  months as (select to_char(m, 'YYYY-MM') as month
               from generate_series(v_from::timestamp, date_trunc('month', v_today), interval '1 month') m),
  agg as (
    select m.month,
           count(l.line_id) as lines,
           count(l.line_id) filter (where l.status <> 'complete') as incomplete_lines,
           coalesce(sum(l.pieces), 0) as pieces,
           coalesce(sum(l.cost_kzt) filter (where l.status = 'complete'), 0) as cost_kzt
      from months m
      left join l on to_char(l.line_date, 'YYYY-MM') = m.month
     group by m.month
  )
  select jsonb_build_object(
    'from', v_from, 'to', v_today, 'currency', 'KZT', 'amounts', v_amounts,
    'reasons', (select jsonb_agg(jsonb_build_object('code', r.code, 'name', r.name) order by r.sort_order)
                  from public.inventory_loss_reasons r),
    'months', (select jsonb_agg(jsonb_build_object(
                 'month', a.month, 'lines', a.lines, 'incomplete_lines', a.incomplete_lines, 'pieces', a.pieces::text,
                 'cost_kzt', case when v_amounts then a.cost_kzt::text end,
                 'cost_of_sales_kzt', case when v_amounts then coalesce(s.cost_kzt, 0)::text end,
                 'share_pct', case when v_amounts and coalesce(s.cost_kzt, 0) > 0 then round(a.cost_kzt / s.cost_kzt * 100, 2)::text end,
                 'by_reason', coalesce((select jsonb_object_agg(x.reason, case when v_amounts then x.cost_kzt::text else x.pieces::text end)
                                          from (select coalesce(l.reason_code, 'unspecified') as reason,
                                                       coalesce(sum(l.pieces), 0) as pieces,
                                                       coalesce(sum(l.cost_kzt) filter (where l.status = 'complete'), 0) as cost_kzt
                                                  from l where to_char(l.line_date, 'YYYY-MM') = a.month group by 1) x), '{}'::jsonb))
                 order by a.month)
               from agg a left join s on s.month = a.month))
  into v_result;
  return v_result;
end $$;
revoke all on function public.loss_trend(integer) from public, anon, authenticated, service_role;
grant execute on function public.loss_trend(integer) to authenticated;

-- Posted write-offs without a reason, for the administrator who sets it with a basis.
create or replace function public.unclassified_loss_lines(p_limit integer default 100)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (select private.has_permission('losses.reason_classify')) or not (select private.has_permission('inventory.view')) then
    raise exception 'Нет права указывать причину проведённого списания' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception 'Укажите от 1 до 500 строк';
  end if;
  return jsonb_build_object(
    'total', (select count(*) from public.inventory_operation_lines l
                join public.inventory_operation_documents d on d.id = l.document_id
               where d.status = 'posted' and l.loss_reason_code is null
                 and private.loss_reason_required(d.operation_type, l.adjustment_direction)),
    'lines', coalesce((select jsonb_agg(x.row order by x.document_date desc, x.document_number, x.created_at) from (
       select d.document_date, d.document_number, l.created_at, jsonb_build_object(
                'line_id', l.id, 'document_id', d.id, 'document_number', d.document_number, 'document_date', d.document_date,
                'operation_type', d.operation_type, 'document_reason', d.reason, 'notes', l.notes, 'warehouse', w.code,
                'sku', p.internal_sku, 'product', coalesce(p.name ->> 'ru', p.name ->> 'en', ''), 'batch', b.batch_number,
                'quantity', l.quantity::text, 'uom', l.uom) as row
         from public.inventory_operation_lines l
         join public.inventory_operation_documents d on d.id = l.document_id
         join public.inventory_batches b on b.id = l.batch_id
         join public.products p on p.id = b.product_id
         left join public.warehouses w on w.id = d.from_warehouse_id
        where d.status = 'posted' and l.loss_reason_code is null
          and private.loss_reason_required(d.operation_type, l.adjustment_direction)
        order by d.document_date desc, d.document_number, l.created_at
        limit p_limit) x), '[]'::jsonb));
end $$;
revoke all on function public.unclassified_loss_lines(integer) from public, anon, authenticated, service_role;
grant execute on function public.unclassified_loss_lines(integer) to authenticated;

commit;
