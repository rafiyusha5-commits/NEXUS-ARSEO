-- Client order drafts from the distribution of a shipment (2026-11-22, phase 2 of the Drive order folder). The
-- employee reviews the «Продажа в …» columns of the distribution sheet and creates one draft order per customer:
-- product and quantity from the sheet, the price from the price list (as in the order form with an empty price),
-- the shipment's destination warehouse. A customer gets one order per shipment; the link is kept here so a second
-- press shows the existing order instead of a duplicate. All orders of one press are created in one transaction.
begin;

create table if not exists public.shipment_distribution_orders (
  shipment_id uuid not null references public.shipments(id) on delete restrict,
  customer_id uuid not null references public.counterparties(id) on delete restrict,
  sale_id uuid not null references public.sales(id) on delete restrict,
  source_file_id text not null check (source_file_id ~ '^[A-Za-z0-9_-]{10,120}$'),
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  primary key (shipment_id, customer_id)
);
create index if not exists shipment_distribution_orders_customer_id_idx on public.shipment_distribution_orders(customer_id);
create index if not exists shipment_distribution_orders_sale_id_idx on public.shipment_distribution_orders(sale_id);
create index if not exists shipment_distribution_orders_created_by_idx on public.shipment_distribution_orders(created_by);
alter table public.shipment_distribution_orders enable row level security;
revoke all on public.shipment_distribution_orders from public, anon, authenticated, service_role;
grant select on public.shipment_distribution_orders to authenticated;
drop policy if exists "employees view distribution orders" on public.shipment_distribution_orders;
create policy "employees view distribution orders" on public.shipment_distribution_orders for select to authenticated
  using ((select private.is_employee()) and (select private.has_permission('shipments.view')) and (select private.has_permission('sales.view')));

-- p_orders: [{customer_id, currency_id, planned_shipment_date, items: [{product_id, quantity}]}]
create or replace function public.create_distribution_orders(p_shipment_id uuid, p_source_file_id text, p_orders jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_shipment public.shipments%rowtype; v_order jsonb; v_item jsonb; v_sale uuid; v_customer uuid; v_result jsonb := '[]'; v_lines integer := 0;
begin
  if not ((select private.is_employee()) and (select private.has_permission('shipments.view')) and (select private.has_permission('sales.manage'))) then
    raise exception 'Нет права создавать клиентские заказы' using errcode = '42501';
  end if;
  if coalesce(p_source_file_id, '') !~ '^[A-Za-z0-9_-]{10,120}$' then raise exception 'Некорректный источник распределения' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_orders) is distinct from 'array' or jsonb_array_length(p_orders) not between 1 and 50 then raise exception 'Выберите заказы для создания' using errcode = 'P0001'; end if;
  select * into v_shipment from public.shipments where id = p_shipment_id for update;
  if not found then raise exception 'Поставка недоступна' using errcode = 'P0001'; end if;
  for v_order in select * from jsonb_array_elements(p_orders) loop
    v_customer := (v_order->>'customer_id')::uuid;
    if exists (select 1 from public.shipment_distribution_orders where shipment_id = p_shipment_id and customer_id = v_customer) then
      raise exception 'Заказ этого клиента по поставке уже создан. Обновите страницу' using errcode = 'P0001';
    end if;
    if jsonb_typeof(v_order->'items') is distinct from 'array' or jsonb_array_length(v_order->'items') not between 1 and 500 then
      raise exception 'В заказе нет строк' using errcode = 'P0001';
    end if;
    v_sale := public.create_customer_order(v_customer, null, v_shipment.destination_warehouse_id, (v_order->>'planned_shipment_date')::date,
      (v_order->>'currency_id')::uuid, format('Из распределения поставки %s', v_shipment.shipment_number));
    for v_item in select * from jsonb_array_elements(v_order->'items') loop
      perform public.add_customer_order_item(v_sale, (v_item->>'product_id')::uuid, (v_item->>'quantity')::numeric, 'piece', null, null, null);
      v_lines := v_lines + 1;
    end loop;
    insert into public.shipment_distribution_orders(shipment_id, customer_id, sale_id, source_file_id) values (p_shipment_id, v_customer, v_sale, p_source_file_id);
    v_result := v_result || jsonb_build_object('customer_id', v_customer, 'sale_id', v_sale);
  end loop;
  return jsonb_build_object('orders', v_result, 'lines', v_lines);
end $$;
revoke all on function public.create_distribution_orders(uuid, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.create_distribution_orders(uuid, text, jsonb) to authenticated;

commit;
