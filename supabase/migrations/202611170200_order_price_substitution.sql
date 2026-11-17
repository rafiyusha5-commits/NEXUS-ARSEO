-- Block 1b: the price of a customer order line comes from the price list (202611170100).
-- Owner decisions of 2026-11-16/17 (damirator1-afk), see docs/sales-price-list.md:
--   * a line without an explicit price gets the customer's price on the order date in the order currency, with a
--     snapshot of how it was obtained (price type, brand, percent, VAT flag, rate, rate date, path);
--   * no price can be found: the line is added without a price and the reason is kept (warning, not a refusal);
--   * a manual price needs a reason; who and when is kept on the line and shown in the order history;
--   * the assistant takes prices only from the price list (it no longer passes a price);
--   * an approved commercial program keeps its target price, but only for the agreed quantity of that product:
--     the line keeps the program line and the agreed quantity and cannot exceed it; more units go to a separate
--     line at the price-list price. A program line without a target price is priced from the price list.
-- Existing lines keep their prices; price_source stays null for them ("before the price list").
begin;

alter table public.sale_items
  add column if not exists price_source text,
  add column if not exists price_snapshot jsonb,
  add column if not exists price_reason text,
  add column if not exists price_set_by uuid references public.profiles(id) on delete restrict,
  add column if not exists commercial_program_line_id uuid references public.commercial_program_lines(id) on delete restrict,
  add column if not exists program_quantity numeric(14, 3);

do $$begin
  if not exists (select 1 from pg_constraint where conname = 'sale_items_price_source_check') then
    alter table public.sale_items add constraint sale_items_price_source_check
      check (price_source is null or price_source in ('price_list', 'fixed', 'manual', 'commercial_program', 'none'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sale_items_manual_price_reason_check') then
    alter table public.sale_items add constraint sale_items_manual_price_reason_check
      check (price_source is distinct from 'manual'
             or (unit_price is not null and price_set_by is not null and length(btrim(coalesce(price_reason, ''))) between 3 and 1000));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sale_items_program_quantity_check') then
    alter table public.sale_items add constraint sale_items_program_quantity_check
      check (commercial_program_line_id is null or (program_quantity is not null and quantity <= program_quantity));
  end if;
end $$;

-- A program line and an ordinary line of the same product and unit may now share an order (the units above the
-- agreed quantity). Ordinary lines stay unique per product and unit; each program line appears once per order.
alter table public.sale_items drop constraint if exists sale_items_sale_id_product_id_uom_key;
create unique index if not exists sale_items_ordinary_line_key
  on public.sale_items(sale_id, product_id, uom) where commercial_program_line_id is null;
create unique index if not exists sale_items_program_line_key
  on public.sale_items(sale_id, commercial_program_line_id) where commercial_program_line_id is not null;
create index if not exists sale_items_price_set_by_idx on public.sale_items(price_set_by);
create index if not exists sale_items_program_line_idx on public.sale_items(commercial_program_line_id);

-- The single place that adds a line. p_program_line is null for ordinary lines.
create or replace function private.add_sale_item(p_sale_id uuid, p_product_id uuid, p_quantity numeric, p_uom text,
                                                 p_manual_price numeric, p_required_shelf_life_pct numeric,
                                                 p_price_reason text, p_program_line_id uuid)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_sale public.sales;
  v_line public.commercial_program_lines;
  v_program public.commercial_programs;
  v_required numeric;
  v_quote jsonb;
  v_price numeric;
  v_source text;
  v_snapshot jsonb;
  v_reason text;
  v_set_by uuid;
  v_id uuid;
begin
  if not (select private.has_permission('sales.manage')) then raise exception 'Нет права изменять клиентские заказы'; end if;
  select * into v_sale from public.sales where id = p_sale_id and status = 'draft' for update;
  if not found then raise exception 'Изменять позиции можно только в черновике заказа'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Количество должно быть больше нуля'; end if;
  if p_uom is null or p_uom not in ('piece','box','layer','pallet','truck') then raise exception 'Некорректная единица измерения'; end if;
  select coalesce(p_required_shelf_life_pct, min_remaining_shelf_life_pct) into v_required from public.counterparties where id = v_sale.customer_id;
  if v_required is not null and (v_required < 0 or v_required > 100) then raise exception 'Требование ОСГ должно быть от 0 до 100 процентов'; end if;

  -- What the price list gives on the order date, in the order currency. Also kept next to a manual price.
  if v_sale.currency_id is null then
    v_quote := jsonb_build_object('price', null, 'reason', 'order_currency_missing', 'date', v_sale.sale_date);
  else
    v_quote := private.resolve_customer_price(v_sale.customer_id, p_product_id, p_uom, v_sale.sale_date, v_sale.currency_id);
  end if;

  if p_program_line_id is not null then
    select * into v_line from public.commercial_program_lines where id = p_program_line_id;
    select * into v_program from public.commercial_programs where id = v_line.commercial_program_id;
    if v_line.id is null or v_line.product_id <> p_product_id or v_line.uom <> p_uom or v_program.customer_id <> v_sale.customer_id then
      raise exception 'Строка программы не относится к этому товару или клиенту';
    end if;
    if p_quantity > v_line.planned_quantity then
      raise exception 'Цена программы действует только на согласованное количество: %', v_line.planned_quantity;
    end if;
    if v_line.target_unit_price is not null then
      if v_line.currency_id is distinct from v_sale.currency_id then raise exception 'Валюта цены строки не совпадает с валютой заказа'; end if;
      v_price := v_line.target_unit_price;
      v_source := 'commercial_program';
      v_snapshot := jsonb_build_object('program_id', v_program.id, 'program', v_program.name, 'version', v_program.version,
        'kind', v_program.kind, 'program_line_id', v_line.id, 'agreed_quantity', v_line.planned_quantity,
        'target_unit_price', v_line.target_unit_price, 'currency', (select code from public.currencies where id = v_line.currency_id),
        'price_list_quote', v_quote);
    end if;
  elsif p_manual_price is not null then
    if p_manual_price < 0 then raise exception 'Цена не может быть отрицательной'; end if;
    v_reason := nullif(btrim(coalesce(p_price_reason, '')), '');
    if v_reason is null or length(v_reason) not between 3 and 1000 then
      raise exception 'Укажите причину ручной цены';
    end if;
    v_price := p_manual_price;
    v_source := 'manual';
    v_set_by := auth.uid();
    v_snapshot := jsonb_build_object('price_list_quote', v_quote);
  end if;

  if v_source is null then
    v_price := (v_quote->>'price')::numeric;
    v_source := coalesce(v_quote->>'source', 'none');
    v_snapshot := v_quote;
  end if;

  insert into public.sale_items(sale_id, product_id, quantity, uom, unit_price, required_shelf_life_pct,
                                price_source, price_snapshot, price_reason, price_set_by, commercial_program_line_id, program_quantity)
  values (p_sale_id, p_product_id, p_quantity, p_uom, v_price, v_required,
          v_source, v_snapshot, v_reason, v_set_by, v_line.id, v_line.planned_quantity)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function private.add_sale_item(uuid, uuid, numeric, text, numeric, numeric, text, uuid) from public, anon, authenticated, service_role;

-- Public entry: no price -> from the price list; an explicit price -> manual, with a reason.
drop function if exists public.add_customer_order_item(uuid, uuid, numeric, text, numeric, numeric);
create or replace function public.add_customer_order_item(p_sale_id uuid, p_product_id uuid, p_quantity numeric, p_uom text,
                                                          p_unit_price numeric, p_required_shelf_life_pct numeric,
                                                          p_price_reason text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  return private.add_sale_item(p_sale_id, p_product_id, p_quantity, p_uom, p_unit_price, p_required_shelf_life_pct, p_price_reason, null);
end $$;
revoke all on function public.add_customer_order_item(uuid, uuid, numeric, text, numeric, numeric, text) from public, anon, authenticated, service_role;
grant execute on function public.add_customer_order_item(uuid, uuid, numeric, text, numeric, numeric, text) to authenticated;

-- Commercial programs: the line keeps the program line and the agreed quantity (202609273200 otherwise unchanged).
create or replace function public.create_sale_from_commercial_program(p_program_id uuid,p_warehouse_id uuid,p_planned_shipment_date date,p_currency_id uuid,p_contract_id uuid default null) returns uuid language plpgsql security definer set search_path='' as $$declare p public.commercial_programs;l record;v_sale uuid;v_item uuid;begin
 if not private.has_permission('commercial_programs.order') or not private.has_permission('sales.manage') then raise exception 'Нет права создавать заказ из программы';end if;p:=private.lock_commercial_program(p_program_id);if p.status<>'approved' or p.kind='promotion' or p.customer_id is null then raise exception 'Заказ создаётся из утверждённого спецзаказа или распродажи ОСГ';end if;if p.sale_id is not null then raise exception 'Заказ по этой программе уже создан';end if;
 if exists(select 1 from public.commercial_program_lines where commercial_program_id=p.id and target_unit_price is not null and currency_id<>p_currency_id) then raise exception 'Валюта цены строки не совпадает с валютой заказа';end if;
 v_sale:=public.create_customer_order(p.customer_id,p_contract_id,p_warehouse_id,p_planned_shipment_date,p_currency_id,'Коммерческая программа: '||p.name||' · v'||p.version);
 for l in select * from public.commercial_program_lines where commercial_program_id=p.id order by id loop
  v_item:=private.add_sale_item(v_sale,l.product_id,l.planned_quantity,l.uom,null,l.required_shelf_life_pct,null,l.id);
 end loop;
 if p.kind='low_shelf_life' then
  if not private.has_permission('sales.override_fefo') then raise exception 'Нет права резервировать выбранные партии';end if;
  for l in select pl.*,si.id as sale_item_id from public.commercial_program_lines pl join public.sale_items si on si.sale_id=v_sale and si.commercial_program_line_id=pl.id where pl.commercial_program_id=p.id order by pl.id loop
   perform public.reserve_customer_order_item_override(l.sale_item_id,l.inventory_balance_id,'Утверждённая распродажа низкого ОСГ: '||p.name);
  end loop;
 end if;
 update public.commercial_programs set status='ordered',sale_id=v_sale,updated_at=now() where id=p.id;return v_sale;
end$$;
revoke all on function public.create_sale_from_commercial_program(uuid,uuid,date,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.create_sale_from_commercial_program(uuid,uuid,date,uuid,uuid) to authenticated;

-- Assistant draft: items are product, quantity and unit only; the price is what the price list gives on the
-- business day in the chosen currency (the order date of the draft it creates). A line without a price is shown
-- with its reason and created without a price, as in the order form. The preview is the stamp: a price change
-- between review and confirmation makes the operation stale.
create or replace function private.assistant_draft_preview(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare customer uuid; contract uuid; warehouse uuid; currency uuid; planned date;
 c public.counterparties; ct public.contracts; w public.warehouses; cu public.currencies;
 item jsonb; p public.products; q numeric; quote jsonb; price numeric; total numeric:=0; unpriced integer:=0; items jsonb:='[]'; stamp jsonb;
begin
 perform private.require_assistant_draft_access();
 if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'ASSISTANT_OPERATION_DRAFT_INVALID';end if;
 if (select count(*) from jsonb_object_keys(p_payload))<>6 or
  not p_payload ?& array['customer_id','contract_id','warehouse_id','currency_id','planned_shipment_date','items'] or
  jsonb_typeof(p_payload->'items') is distinct from 'array' then raise exception 'ASSISTANT_OPERATION_DRAFT_INVALID';end if;
 if jsonb_array_length(p_payload->'items') not between 1 and 25 then raise exception 'ASSISTANT_OPERATION_DRAFT_INVALID';end if;
 begin
  customer:=(p_payload->>'customer_id')::uuid;contract:=(p_payload->>'contract_id')::uuid;
  warehouse:=(p_payload->>'warehouse_id')::uuid;currency:=(p_payload->>'currency_id')::uuid;
  planned:=(p_payload->>'planned_shipment_date')::date;
 exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then raise exception 'ASSISTANT_OPERATION_DRAFT_INVALID';end;
 if customer is null or warehouse is null or currency is null or planned is null or planned<private.business_today()
  or p_payload->>'planned_shipment_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'ASSISTANT_OPERATION_DRAFT_INVALID';end if;
 if not private.can_access_counterparty_record('view',customer) then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 select * into c from public.counterparties where id=customer and status='active' and 'customer'=any(roles);
 if not found then raise exception 'ASSISTANT_OPERATION_DRAFT_SOURCE';end if;
 if contract is not null then
  select * into ct from public.contracts where id=contract and counterparty_id=customer and status='active';
  if not found then raise exception 'ASSISTANT_OPERATION_DRAFT_SOURCE';end if;
 end if;
 select * into w from public.warehouses where id=warehouse and status='active' and not is_virtual;
 if not found then raise exception 'ASSISTANT_OPERATION_DRAFT_SOURCE';end if;
 select * into cu from public.currencies where id=currency and is_active;
 if not found then raise exception 'ASSISTANT_OPERATION_DRAFT_SOURCE';end if;
 stamp:=jsonb_build_object('customer',to_jsonb(c),'contract',to_jsonb(ct),'warehouse',to_jsonb(w),'currency',to_jsonb(cu),'products','[]'::jsonb);
 for item in select value from jsonb_array_elements(p_payload->'items') loop
  if jsonb_typeof(item) is distinct from 'object' then raise exception 'ASSISTANT_OPERATION_DRAFT_INVALID';end if;
  if (select count(*) from jsonb_object_keys(item))<>3 or not item ?& array['product_id','quantity','uom']
   or jsonb_typeof(item->'quantity') is distinct from 'string'
   or item->>'quantity' !~ '^(0|[1-9][0-9]{0,8})(\.[0-9]{1,3})?$'
   or coalesce(item->>'uom','') not in ('piece','box','layer','pallet','truck') then raise exception 'ASSISTANT_OPERATION_DRAFT_INVALID';end if;
  begin
   select * into p from public.products where id=(item->>'product_id')::uuid and status='active';
  exception when invalid_text_representation then raise exception 'ASSISTANT_OPERATION_DRAFT_INVALID';end;
  if not found then raise exception 'ASSISTANT_OPERATION_DRAFT_SOURCE';end if;
  q:=(item->>'quantity')::numeric;
  if q<=0 or exists(select 1 from jsonb_array_elements(items) a where a->>'product_id'=p.id::text and a->>'uom'=item->>'uom') then
   raise exception 'ASSISTANT_OPERATION_DRAFT_INVALID';end if;
  quote:=private.resolve_customer_price(customer,p.id,item->>'uom',private.business_today(),currency);
  price:=(quote->>'price')::numeric;
  if price is null then unpriced:=unpriced+1;else total:=total+q*price;end if;
  items:=items||jsonb_build_array(jsonb_build_object('id',p.id::text||':'||(item->>'uom'),'product_id',p.id,
   'product',p.internal_sku||' · '||coalesce(p.name->>'ru',p.name->>'en',''),'quantity',q::text,'uom',item->>'uom',
   'unit_price',price::text,'line_amount',(q*price)::text,'required_shelf_life_pct',c.min_remaining_shelf_life_pct,
   'price_source',quote->>'source','price_reason',quote->>'reason','price_note',quote->>'note',
   'price_type',quote->>'price_type_name','brand',quote->>'brand','percent',quote->>'percent',
   'vat_included',(quote->>'vat_included')::boolean,'rate',quote->>'rate','rate_date',quote->>'rate_date','rate_path',quote->>'rate_path'));
  stamp:=jsonb_set(stamp,'{products}',(stamp->'products')||jsonb_build_array(to_jsonb(p)));
 end loop;
 -- Same rounding as private.sale_amount; checked against that function after creation in the same transaction.
 return jsonb_build_object('customer',coalesce(c.short_name,c.legal_name),'contract',ct.number,
  'contract_currency',(select code from public.currencies where id=ct.currency_id),
  'contract_valid_from',ct.valid_from,'contract_valid_to',ct.valid_to,
  'warehouse',w.code||' · '||coalesce(w.name->>'ru',w.name->>'en',''),
  'currency',cu.code,'planned_date',planned,'document_date',private.business_today(),'items',items,'lines','[]'::jsonb,
  'total',round(total,2)::text,'unpriced_lines',unpriced,'state_stamp',encode(sha256(convert_to(stamp::text,'UTF8')),'hex'));
end $$;
revoke all on function private.assistant_draft_preview(jsonb) from public,anon,authenticated,service_role;

-- The handler of 202610230300 (renamed by 202610230400, deadline guard of 202610250100 kept): lines are added
-- without a price, so the price list prices them; each line must match the reviewed price.
create or replace function private.confirm_assistant_prior_operation(p_request_id uuid,p_review_token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r private.assistant_operations; v jsonb; sale uuid; item jsonb; created_item uuid; created_price numeric;
begin
 select * into r from private.assistant_operations where id=p_request_id and created_by=auth.uid() for update;
 if not found or p_review_token is null or r.review_token<>p_review_token then raise exception 'ASSISTANT_OPERATION_DENIED' using errcode='42501';end if;
 perform private.require_assistant_kind_access(r.kind);
 if r.kind<>'customer_order_create' then return private.confirm_assistant_stock_operation(p_request_id,p_review_token);end if;
 if r.result_sale_id is not null then return jsonb_build_object('id',r.id,'kind',r.kind,'status','completed','result_id',r.result_sale_id);end if;
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 -- Shared locks freeze reviewed reference rows; no stock writes or locks. Prices are rechecked per line below.
 perform 1 from public.products where id in(select (a->>'product_id')::uuid from jsonb_array_elements(r.payload->'items') a) order by id for share;
 perform 1 from public.counterparties where id=(r.payload->>'customer_id')::uuid for share;
 perform 1 from public.contracts where id=(r.payload->>'contract_id')::uuid for share;
 perform 1 from public.warehouses where id=(r.payload->>'warehouse_id')::uuid for share;
 perform 1 from public.currencies where id in((r.payload->>'currency_id')::uuid,
  (select currency_id from public.contracts where id=(r.payload->>'contract_id')::uuid)) order by id for share;
 perform private.require_assistant_draft_access();
 v:=private.assistant_draft_preview(r.payload);
 if v<>r.preview then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 -- Recheck the deadline after all input locks and preview validation.
 if r.expires_at<clock_timestamp() then raise exception 'ASSISTANT_OPERATION_EXPIRED';end if;
 sale:=public.create_customer_order((r.payload->>'customer_id')::uuid,(r.payload->>'contract_id')::uuid,
  (r.payload->>'warehouse_id')::uuid,(r.payload->>'planned_shipment_date')::date,(r.payload->>'currency_id')::uuid,null);
 for item in select value from jsonb_array_elements(v->'items') loop
  created_item:=public.add_customer_order_item(sale,(item->>'product_id')::uuid,(item->>'quantity')::numeric,item->>'uom',null,null);
  select unit_price into created_price from public.sale_items where id=created_item;
  if created_price is distinct from (item->>'unit_price')::numeric then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 end loop;
 if (select amount from private.sale_amount(sale)) is distinct from (v->>'total')::numeric then raise exception 'ASSISTANT_OPERATION_STALE';end if;
 update private.assistant_operations set confirmed_at=clock_timestamp(),result_sale_id=sale where id=r.id;
 return jsonb_build_object('id',r.id,'kind',r.kind,'status','completed','result_id',sale);
end $$;
revoke all on function private.confirm_assistant_prior_operation(uuid,uuid) from public,anon,authenticated,service_role;

comment on column public.sale_items.price_source is
  'price_list / fixed (customer fixed price) / manual (with reason) / commercial_program / none (no price, reason in price_snapshot); null = added before the price list';
commit;
