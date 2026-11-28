-- Batch labels printed before the goods arrive (2026-11-28, request of the owner damirator1-afk): the batches of a
-- shipment item are entered from the supplier's packing list (by hand or from the recognized document), their labels are
-- printed in advance, and the receipt binds each label to the batch actually received — only when the batch number of
-- the same item matches and, when the packing list gives one, the expiry too. A label that does not match stays unbound
-- and says so when scanned; nothing is guessed. See docs/mobile-warehouse.md.
begin;

-- Batches expected by the packing list. Never deleted: a mistake is cancelled (its label may already be printed).
create table if not exists public.expected_batches (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid references public.shipments(id) on delete set null,
  shipment_item_id uuid references public.shipment_items(id) on delete set null,
  product_id uuid not null references public.products(id) on delete restrict,
  batch_number text not null check (btrim(batch_number) <> '' and length(batch_number) <= 60),
  manufacture_date date,
  expiry_date date,
  quantity numeric(14, 3) check (quantity is null or quantity > 0),
  packages integer check (packages is null or packages between 1 and 100),
  source text not null check (source in ('manual', 'packing_list')),
  source_note text check (source_note is null or length(source_note) <= 300),
  status text not null default 'expected' check (status in ('expected', 'received', 'mismatch', 'not_received', 'cancelled')),
  batch_id uuid references public.inventory_batches(id) on delete restrict,
  receipt_item_id uuid references public.shipment_transport_receipt_items(id) on delete restrict,
  result_note text check (result_note is null or length(result_note) <= 300),
  resolved_at timestamptz,
  cancel_reason text check (cancel_reason is null or length(cancel_reason) <= 300),
  cancelled_by uuid references public.profiles(id) on delete restrict,
  cancelled_at timestamptz,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  -- Who confirmed at the receipt that the expiries filled in from the packing list were compared with the boxes.
  expiry_checked_by uuid references public.profiles(id) on delete restrict,
  expiry_checked_at timestamptz,
  check (manufacture_date is null or expiry_date is null or manufacture_date <= expiry_date),
  check ((status = 'received') = (batch_id is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null and cancel_reason is not null))
);
create unique index if not exists expected_batches_item_batch_unique on public.expected_batches(shipment_item_id, upper(btrim(batch_number)))
  where status <> 'cancelled' and shipment_item_id is not null;
create index if not exists expected_batches_shipment_idx on public.expected_batches(shipment_id);
create index if not exists expected_batches_product_idx on public.expected_batches(product_id);
create index if not exists expected_batches_batch_idx on public.expected_batches(batch_id);
create index if not exists expected_batches_receipt_item_idx on public.expected_batches(receipt_item_id);
create index if not exists expected_batches_created_by_idx on public.expected_batches(created_by);
create index if not exists expected_batches_cancelled_by_idx on public.expected_batches(cancelled_by);
create index if not exists expected_batches_expiry_checked_by_idx on public.expected_batches(expiry_checked_by);
alter table public.expected_batches enable row level security;
revoke all on public.expected_batches from public, anon, authenticated, service_role;

-- A label of an expected batch: the third kind of Nexus label. The code never changes; once the batch is received the
-- label is that batch's label.
alter table public.scan_labels add column if not exists expected_batch_id uuid references public.expected_batches(id) on delete restrict;
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.scan_labels'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ 'target_type'
              and conname <> 'scan_labels_target_kind'
  loop
    execute format('alter table public.scan_labels drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.scan_labels drop constraint if exists scan_labels_target_kind;
alter table public.scan_labels add constraint scan_labels_target_kind check (
  (target_type = 'location' and location_id is not null and batch_id is null and expected_batch_id is null)
  or (target_type = 'batch' and batch_id is not null and location_id is null and expected_batch_id is null)
  or (target_type = 'expected_batch' and expected_batch_id is not null and location_id is null and batch_id is null));
create unique index if not exists scan_labels_expected_unique on public.scan_labels(expected_batch_id) where expected_batch_id is not null;

-- Who prepares expected batches: the warehouse that receives or the logistics that edits shipments.
create or replace function private.can_manage_expected_batches() returns boolean
language sql stable security definer set search_path = '' as $$
  select (select private.has_permission('inventory.receive')) or (select private.can_write_shipments('update'))
$$;
revoke all on function private.can_manage_expected_batches() from public, anon, authenticated, service_role;

-- The state shown to people: a batch still expected after its truck was received did not come (or was received under
-- another number); one whose shipment item was removed is void.
create or replace function private.expected_batch_state(p_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
           when e.status <> 'expected' then e.status
           when e.shipment_item_id is null then 'removed'
           when exists (select 1 from public.shipment_items i join public.shipment_transport_receipts r on r.shipment_transport_id = i.shipment_transport_id
                         where i.id = e.shipment_item_id) then 'missing'
           else 'expected' end
    from public.expected_batches e where e.id = p_id
$$;
revoke all on function private.expected_batch_state(uuid) from public, anon, authenticated, service_role;

-- Binding at the receipt: every received line of an item (with its batch number) closes the expected batches of that
-- item with the same number. Bound only when the batch was really received and the expiry agrees with the packing list.
-- The order of the lines does not matter: a line that matches binds the label even after a line of the same number
-- with another expiry (a batch that came with two expiries, mixed up with the packing list); a line that does not
-- match marks only a batch still expected.
create or replace function private.bind_expected_batches() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if nullif(btrim(coalesce(new.batch_number, '')), '') is null then
    return new;
  end if;
  if new.inventory_batch_id is not null then
    update public.expected_batches e
       set status = 'received', batch_id = new.inventory_batch_id, receipt_item_id = new.id, result_note = null, resolved_at = clock_timestamp()
     where e.shipment_item_id = new.shipment_item_id and e.status in ('expected', 'mismatch', 'not_received')
       and upper(btrim(e.batch_number)) = upper(btrim(new.batch_number))
       and (e.expiry_date is null or e.expiry_date = new.expiry_date);
  end if;
  update public.expected_batches e
     set status = case when new.inventory_batch_id is null then 'not_received' else 'mismatch' end,
         receipt_item_id = new.id,
         result_note = case when new.inventory_batch_id is null then 'Партия не принята: принятое количество 0'
                            else format('Срок по упаковочному листу %s, при приёмке %s: наклейка не привязана',
                                        to_char(e.expiry_date, 'DD.MM.YYYY'), coalesce(to_char(new.expiry_date, 'DD.MM.YYYY'), 'не указан')) end,
         resolved_at = clock_timestamp()
   where e.shipment_item_id = new.shipment_item_id and e.status = 'expected'
     and upper(btrim(e.batch_number)) = upper(btrim(new.batch_number));
  return new;
end $$;
revoke all on function private.bind_expected_batches() from public, anon, authenticated, service_role;
drop trigger if exists shipment_receipt_items_bind_expected on public.shipment_transport_receipt_items;
create trigger shipment_receipt_items_bind_expected after insert on public.shipment_transport_receipt_items
  for each row execute function private.bind_expected_batches();

-- A truck whose items have batches of the packing list is received only with the confirmation that the expiries were
-- compared with the markings on the boxes (owner decision of 2026-11-28: the dates of the list are not taken unseen).
-- The confirmation is given through receive_shipment_transport_checked for this very truck; any other way of receiving
-- it is refused.
create or replace function private.guard_receipt_expiry_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.expected_batches e join public.shipment_items i on i.id = e.shipment_item_id
              where i.shipment_transport_id = new.shipment_transport_id and e.status = 'expected')
     and current_setting('nexus.receipt_expiry_checked', true) is distinct from new.shipment_transport_id::text then
    raise exception 'Отметьте, что сроки сверены с маркировкой на коробках: партии подставлены из упаковочного листа';
  end if;
  return new;
end $$;
revoke all on function private.guard_receipt_expiry_check() from public, anon, authenticated, service_role;
drop trigger if exists shipment_receipts_expiry_check on public.shipment_transport_receipts;
create trigger shipment_receipts_expiry_check before insert on public.shipment_transport_receipts
  for each row execute function private.guard_receipt_expiry_check();

-- The receipt of a truck with the confirmation: the existing receive_shipment_transport (its rights and checks), the
-- confirmation recorded on the batches of the packing list of the truck.
create or replace function public.receive_shipment_transport_checked(p_transport_id uuid, p_location_id uuid, p_lines jsonb,
                                                                     p_performed_by_name text, p_notes text, p_expiry_checked boolean)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_receipt uuid;
begin
  if coalesce(p_expiry_checked, false) then
    perform set_config('nexus.receipt_expiry_checked', p_transport_id::text, true);
  end if;
  v_receipt := public.receive_shipment_transport(p_transport_id, p_location_id, p_lines, p_performed_by_name, p_notes);
  perform set_config('nexus.receipt_expiry_checked', '', true);
  if coalesce(p_expiry_checked, false) then
    update public.expected_batches e set expiry_checked_by = auth.uid(), expiry_checked_at = clock_timestamp()
      from public.shipment_items i
     where i.id = e.shipment_item_id and i.shipment_transport_id = p_transport_id and e.status <> 'cancelled' and e.expiry_checked_by is null;
  end if;
  return v_receipt;
end $$;
revoke all on function public.receive_shipment_transport_checked(uuid, uuid, jsonb, text, text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.receive_shipment_transport_checked(uuid, uuid, jsonb, text, text, boolean) to authenticated;

-- The expected batches of a shipment by its items, with the labels and what the receipt did with each.
create or replace function public.shipment_expected_batches(p_shipment_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.shipments;
begin
  if not (select private.has_permission('shipments.view')) then
    raise exception 'Нет доступа к поставкам' using errcode = '42501';
  end if;
  select * into s from public.shipments where id = p_shipment_id;
  if not found then
    raise exception 'Поставка не найдена';
  end if;
  return jsonb_build_object('shipment_id', s.id, 'shipment_number', s.shipment_number, 'status', s.status,
    'can_manage', (select private.can_manage_expected_batches()) and s.status not in ('closed', 'cancelled'),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
               'item_id', i.id, 'product_id', p.id, 'sku', p.internal_sku, 'product', coalesce(p.name ->> 'ru', p.internal_sku), 'uom', i.uom,
               'quantity', coalesce(i.shipped_quantity, i.confirmed_quantity, i.ordered_quantity)::text,
               'transport_id', t.id, 'transport_no', t.sequence_no, 'transport_status', t.status,
               'received', exists (select 1 from public.shipment_transport_receipts r where r.shipment_transport_id = t.id),
               'batches', coalesce((select jsonb_agg(jsonb_build_object(
                            'id', e.id, 'batch', e.batch_number, 'expiry_date', e.expiry_date, 'manufacture_date', e.manufacture_date,
                            'quantity', e.quantity::text, 'packages', e.packages, 'source', e.source, 'source_note', e.source_note,
                            'state', private.expected_batch_state(e.id), 'note', coalesce(e.result_note, e.cancel_reason), 'batch_id', e.batch_id,
                            -- The same number received with other expiries: those boxes have no label of the list.
                            'other_expiries', coalesce((select jsonb_agg(distinct ri.expiry_date)
                                                          from public.shipment_transport_receipt_items ri
                                                         where ri.shipment_item_id = e.shipment_item_id and ri.inventory_batch_id is not null
                                                           and upper(btrim(ri.batch_number)) = upper(btrim(e.batch_number))
                                                           and ri.inventory_batch_id is distinct from e.batch_id), '[]'::jsonb),
                            'label_code', (select l.code from public.scan_labels l where l.expected_batch_id = e.id),
                            'expiry_checked_by', (select full_name from public.profiles where id = e.expiry_checked_by), 'expiry_checked_at', e.expiry_checked_at,
                            'printed', exists (select 1 from public.scan_labels l join public.scan_label_prints x on x.label_id = l.id
                                                where l.expected_batch_id = e.id))
                            order by e.status = 'cancelled', e.expiry_date nulls last, e.batch_number)
                          from public.expected_batches e where e.shipment_item_id = i.id), '[]'::jsonb))
               order by t.sequence_no nulls last, p.internal_sku)
             from public.shipment_items i
             join public.products p on p.id = i.product_id
             left join public.shipment_transports t on t.id = i.shipment_transport_id
            where i.shipment_id = s.id), '[]'::jsonb),
    'orphans', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'batch', e.batch_number, 'sku', p.internal_sku,
                                  'label_code', (select l.code from public.scan_labels l where l.expected_batch_id = e.id)) order by e.created_at)
                           from public.expected_batches e join public.products p on p.id = e.product_id
                          where e.shipment_id = s.id and e.shipment_item_id is null), '[]'::jsonb));
end $$;
revoke all on function public.shipment_expected_batches(uuid) from public, anon, authenticated, service_role;
grant execute on function public.shipment_expected_batches(uuid) to authenticated;

-- A batch of the packing list for a shipment item, before its truck is received.
create or replace function public.add_expected_batch(p_shipment_item_id uuid, p_batch_number text, p_expiry_date date, p_manufacture_date date,
                                                     p_quantity numeric, p_packages integer, p_source text, p_source_note text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  i public.shipment_items;
  s public.shipments;
  v_batch text := btrim(coalesce(p_batch_number, ''));
  v_id uuid;
begin
  if not (select private.has_permission('shipments.view')) or not (select private.can_manage_expected_batches()) then
    raise exception 'Нет права готовить партии поставки' using errcode = '42501';
  end if;
  select * into i from public.shipment_items where id = p_shipment_item_id for update;
  if not found then
    raise exception 'Позиция поставки не найдена';
  end if;
  select * into s from public.shipments where id = i.shipment_id;
  if s.status in ('closed', 'cancelled') then
    raise exception 'Поставка закрыта или отменена';
  end if;
  if exists (select 1 from public.shipment_transport_receipts r where r.shipment_transport_id = i.shipment_transport_id) then
    raise exception 'Машина с этой позицией уже принята: партии вносятся при приёмке';
  end if;
  if v_batch = '' or length(v_batch) > 60 then
    raise exception 'Укажите номер партии до 60 знаков';
  end if;
  if p_manufacture_date is not null and p_expiry_date is not null and p_manufacture_date > p_expiry_date then
    raise exception 'Дата производства позже срока годности';
  end if;
  if p_quantity is not null and (p_quantity <= 0 or p_quantity <> round(p_quantity, 3)) then
    raise exception 'Количество — положительное число, не более трёх знаков после запятой';
  end if;
  if p_packages is not null and p_packages not between 1 and 100 then
    raise exception 'Наклеек на партию — от 1 до 100';
  end if;
  if p_source is null or p_source not in ('manual', 'packing_list') then
    raise exception 'Укажите источник: вручную или упаковочный лист';
  end if;
  if exists (select 1 from public.expected_batches e where e.shipment_item_id = i.id and e.status <> 'cancelled'
              and upper(btrim(e.batch_number)) = upper(v_batch)) then
    raise exception 'Партия % уже есть у этой позиции', v_batch;
  end if;
  insert into public.expected_batches(shipment_id, shipment_item_id, product_id, batch_number, manufacture_date, expiry_date, quantity, packages,
                                      source, source_note, created_by)
  values (i.shipment_id, i.id, i.product_id, v_batch, p_manufacture_date, p_expiry_date, p_quantity, p_packages, p_source,
          nullif(btrim(coalesce(p_source_note, '')), ''), auth.uid())
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.add_expected_batch(uuid, text, date, date, numeric, integer, text, text) from public, anon, authenticated, service_role;
grant execute on function public.add_expected_batch(uuid, text, date, date, numeric, integer, text, text) to authenticated;

-- A batch entered by mistake is cancelled with a reason; its printed label then says it is void.
create or replace function public.cancel_expected_batch(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare e public.expected_batches;
begin
  if not (select private.has_permission('shipments.view')) or not (select private.can_manage_expected_batches()) then
    raise exception 'Нет права готовить партии поставки' using errcode = '42501';
  end if;
  select * into e from public.expected_batches where id = p_id for update;
  if not found then
    raise exception 'Партия по листу не найдена';
  end if;
  if e.status <> 'expected' then
    raise exception 'Отменить можно только ожидаемую партию';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null or length(btrim(p_reason)) > 300 then
    raise exception 'Укажите причину отмены';
  end if;
  update public.expected_batches set status = 'cancelled', cancel_reason = btrim(p_reason), cancelled_by = auth.uid(), cancelled_at = clock_timestamp()
   where id = e.id;
end $$;
revoke all on function public.cancel_expected_batch(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.cancel_expected_batch(uuid, text) to authenticated;

-- 202611280500 with the third kind of label. A batch received under a label printed in advance keeps that label: asking
-- for the batch's label returns it instead of making a second code.
create or replace function public.ensure_scan_labels(p_target_type text, p_ids uuid[])
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if p_target_type is null or p_target_type not in ('location', 'batch', 'expected_batch') then
    raise exception 'Выберите места или партии';
  end if;
  if p_target_type = 'expected_batch' then
    if not ((select private.has_permission('shipments.view')) and (select private.can_manage_expected_batches())) then
      raise exception 'Нет права печатать этикетки партий поставки' using errcode = '42501';
    end if;
  elsif not ((select private.has_permission('inventory.move')) or (select private.has_permission('inventory.receive'))
             or (select private.has_permission('inventory.control'))
             or (p_target_type = 'location' and (select private.has_permission('warehouses.update')))) then
    raise exception 'Нет права печатать этикетки склада' using errcode = '42501';
  end if;
  if p_ids is null or cardinality(p_ids) = 0 or cardinality(p_ids) > 500 then
    raise exception 'Выберите от 1 до 500 этикеток';
  end if;
  foreach v_id in array p_ids loop
    if p_target_type = 'location' then
      if not exists (select 1 from public.warehouse_locations where id = v_id) then
        raise exception 'Место не найдено';
      end if;
      insert into public.scan_labels(code, target_type, location_id, created_by)
      values (private.new_scan_code(), 'location', v_id, auth.uid()) on conflict do nothing;
    elsif p_target_type = 'batch' then
      if not exists (select 1 from public.inventory_batches where id = v_id) then
        raise exception 'Партия не найдена';
      end if;
      if not exists (select 1 from public.scan_labels l join public.expected_batches e on e.id = l.expected_batch_id where e.batch_id = v_id) then
        insert into public.scan_labels(code, target_type, batch_id, created_by)
        values (private.new_scan_code(), 'batch', v_id, auth.uid()) on conflict do nothing;
      end if;
    else
      if not exists (select 1 from public.expected_batches where id = v_id and status <> 'cancelled') then
        raise exception 'Партия по листу не найдена или отменена';
      end if;
      insert into public.scan_labels(code, target_type, expected_batch_id, created_by)
      values (private.new_scan_code(), 'expected_batch', v_id, auth.uid()) on conflict do nothing;
    end if;
  end loop;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'label_id', l.id, 'code', l.code, 'target_type', l.target_type, 'location_id', l.location_id,
             'batch_id', coalesce(l.batch_id, e.batch_id), 'expected_batch_id', l.expected_batch_id,
             'title', case when l.target_type = 'location' then wl.code else p.internal_sku || ' · ' || coalesce(b.batch_number, e.batch_number) end,
             'subtitle', case when l.target_type = 'location' then coalesce(w.name ->> 'ru', w.code) || ' · ' || wl.zone
                              else coalesce(p.name ->> 'ru', p.internal_sku)
                                   || coalesce(' · до ' || to_char(coalesce(b.expiry_date, e.expiry_date), 'DD.MM.YYYY'), '') end,
             'printed', exists (select 1 from public.scan_label_prints x where x.label_id = l.id))
             order by x.n)
      from (select u.id, min(u.n) as n from unnest(p_ids) with ordinality u(id, n) group by u.id) x
      cross join lateral (
        select s.* from public.scan_labels s left join public.expected_batches se on se.id = s.expected_batch_id
         where (p_target_type = 'location' and s.location_id = x.id)
            or (p_target_type = 'batch' and (s.batch_id = x.id or se.batch_id = x.id))
            or (p_target_type = 'expected_batch' and s.expected_batch_id = x.id)
         order by (s.target_type = p_target_type) desc, s.created_at
         limit 1) l
      left join public.expected_batches e on e.id = l.expected_batch_id
      left join public.inventory_batches b on b.id = coalesce(l.batch_id, e.batch_id)
      left join public.products p on p.id = coalesce(b.product_id, e.product_id)
      left join public.warehouse_locations wl on wl.id = l.location_id
      left join public.warehouses w on w.id = wl.warehouse_id), '[]'::jsonb);
end $$;
revoke all on function public.ensure_scan_labels(text, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.ensure_scan_labels(text, uuid[]) to authenticated;

-- 202611280500: a print of labels of expected batches is recorded by whoever may prepare them.
create or replace function public.record_label_print(p_label_ids uuid[], p_format text, p_copies integer)
returns integer
language plpgsql security definer set search_path = '' as $$
declare v_rows integer;
begin
  if not ((select private.has_permission('inventory.move')) or (select private.has_permission('inventory.receive'))
          or (select private.has_permission('inventory.control')) or (select private.has_permission('warehouses.update'))
          or ((select private.has_permission('shipments.view')) and (select private.can_manage_expected_batches()) and p_label_ids is not null
              and not exists (select 1 from unnest(p_label_ids) x(id) join public.scan_labels l on l.id = x.id where l.target_type <> 'expected_batch'))) then
    raise exception 'Нет права печатать этикетки склада' using errcode = '42501';
  end if;
  if p_format is null or p_format not in ('a4', 'thermal') then
    raise exception 'Выберите формат: лист A4 или термопринтер';
  end if;
  if p_copies is null or p_copies not between 1 and 100 then
    raise exception 'Укажите от 1 до 100 копий';
  end if;
  if p_label_ids is null or cardinality(p_label_ids) = 0 or exists (select 1 from unnest(p_label_ids) x(id)
                                                                      where not exists (select 1 from public.scan_labels l where l.id = x.id)) then
    raise exception 'Этикетка не найдена';
  end if;
  insert into public.scan_label_prints(label_id, print_format, copies, is_reprint, printed_by)
  select x.id, p_format, p_copies, exists (select 1 from public.scan_label_prints p where p.label_id = x.id), auth.uid()
    from (select distinct unnest(p_label_ids) as id) x;
  get diagnostics v_rows = row_count;
  return v_rows;
end $$;
revoke all on function public.record_label_print(uuid[], text, integer) from public, anon, authenticated, service_role;
grant execute on function public.record_label_print(uuid[], text, integer) to authenticated;

-- 202611280500 with the labels printed in advance: once received, the label is its batch's; before, it says what is
-- expected, and after a receipt that did not match, why it is not bound.
create or replace function public.scan_lookup(p_code text, p_batch_number text default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_code text := upper(btrim(coalesce(p_code, '')));
  l public.scan_labels;
  e public.expected_batches;
  v_batch uuid;
  v_products jsonb;
begin
  perform private.require_scan_view();
  if v_code = '' or length(v_code) > 200 then
    raise exception 'Пустой или слишком длинный код';
  end if;
  select * into l from public.scan_labels where code = v_code;
  if found and l.target_type = 'location' then
    return jsonb_build_object('kind', 'location', 'code', l.code,
      'location', (select jsonb_build_object('id', wl.id, 'code', wl.code, 'zone', wl.zone, 'status', wl.status, 'warehouse_id', w.id,
                                             'warehouse', coalesce(w.name ->> 'ru', w.code))
                     from public.warehouse_locations wl join public.warehouses w on w.id = wl.warehouse_id where wl.id = l.location_id),
      'stock', private.scan_stock(null, null, l.location_id));
  end if;
  if found and l.target_type = 'expected_batch' then
    select * into e from public.expected_batches where id = l.expected_batch_id;
    if e.batch_id is null then
      return jsonb_build_object('kind', 'expected', 'code', l.code,
        'expected', (select jsonb_build_object('id', e.id, 'state', private.expected_batch_state(e.id), 'batch', e.batch_number,
                                               'expiry_date', e.expiry_date, 'quantity', e.quantity::text, 'note', coalesce(e.result_note, e.cancel_reason),
                                               'product_id', p.id, 'sku', p.internal_sku, 'product', coalesce(p.name ->> 'ru', p.internal_sku),
                                               'shipment', case when (select private.has_permission('shipments.view')) then s.shipment_number end,
                                               'transport_no', t.sequence_no)
                       from public.products p
                       left join public.shipments s on s.id = e.shipment_id
                       left join public.shipment_items i on i.id = e.shipment_item_id
                       left join public.shipment_transports t on t.id = i.shipment_transport_id
                      where p.id = e.product_id));
    end if;
    v_batch := e.batch_id;
  elsif found then
    v_batch := l.batch_id;
  end if;
  if v_batch is not null then
    return jsonb_build_object('kind', 'batch', 'code', l.code,
      'batch', (select jsonb_build_object('id', b.id, 'batch', b.batch_number, 'expiry_date', b.expiry_date, 'status', b.status,
                                          'product_id', p.id, 'sku', p.internal_sku, 'product', coalesce(p.name ->> 'ru', p.internal_sku),
                                          -- The same number with other expiries in stock: the box is compared with the label.
                                          'other_expiries', coalesce((select jsonb_agg(o.expiry_date order by o.expiry_date)
                                                                        from public.inventory_batches o
                                                                       where o.product_id = b.product_id and o.id <> b.id
                                                                         and upper(btrim(o.batch_number)) = upper(btrim(b.batch_number))
                                                                         and exists (select 1 from public.inventory_balances x where x.batch_id = o.id and x.quantity_on_hand > 0)),
                                                                     '[]'::jsonb))
                  from public.inventory_batches b join public.products p on p.id = b.product_id where b.id = v_batch),
      'stock', private.scan_stock(null, v_batch, null));
  end if;
  select jsonb_agg(jsonb_build_object(
           'product_id', p.id, 'sku', p.internal_sku, 'product', coalesce(p.name ->> 'ru', p.internal_sku),
           'identifier_type', i.identifier_type, 'uom', coalesce(i.packaging_uom, case i.identifier_type when 'box_barcode' then 'box' else 'piece' end),
           'pieces', private.uom_pieces(p.id, coalesce(i.packaging_uom, case i.identifier_type when 'box_barcode' then 'box' else 'piece' end)),
           -- With a GS1 batch: the stock of that batch only; a batch Nexus does not know has no stock here.
           'stock', case when p_batch_number is null then private.scan_stock(p.id, null, null)
                         else coalesce((select private.scan_stock(p.id, b.id, null) from public.inventory_batches b
                                         where b.product_id = p.id and upper(btrim(b.batch_number)) = upper(btrim(p_batch_number)) limit 1),
                                       '[]'::jsonb) end,
           'batch_found', case when p_batch_number is null then null
                               else exists (select 1 from public.inventory_batches b where b.product_id = p.id
                                             and upper(btrim(b.batch_number)) = upper(btrim(p_batch_number))) end)
           order by p.internal_sku)
    into v_products
    from public.product_identifiers i
    join public.products p on p.id = i.product_id
   where i.identifier_type in ('gtin', 'unit_barcode', 'box_barcode')
     and private.barcode_key(i.value) = private.barcode_key(v_code);
  if v_products is not null then
    return jsonb_build_object('kind', 'product', 'code', v_code, 'products', v_products);
  end if;
  return jsonb_build_object('kind', 'unknown', 'code', v_code, 'can_bind', (select private.has_permission('products.update')));
end $$;
revoke all on function public.scan_lookup(text, text) from public, anon, authenticated, service_role;
grant execute on function public.scan_lookup(text, text) to authenticated;

commit;
