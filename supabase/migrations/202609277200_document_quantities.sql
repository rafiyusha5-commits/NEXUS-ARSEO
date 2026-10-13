-- Confirmed and shipped quantities from source documents.
--
-- shipment_items.confirmed_quantity and shipped_quantity were never filled: nothing wrote them, so receiving,
-- the shipment report, costing and «Сверка» counted the ordered quantity everywhere. Now an employee takes the
-- quantities from a confirmed invoice, packing list or waybill: the shipment card proposes them from the
-- recognised invoice lines, the employee checks and corrects every value against the original and confirms.
--
--   * apply_shipment_document_quantities writes the quantities of the chosen field(s) for the items of the
--     shipment (or of the vehicle the document belongs to) and nothing else;
--   * every change is kept in shipment_item_quantity_confirmations: the previous and the new value, the
--     document and its version, who confirmed and when; re-confirming the same value adds nothing.

create table if not exists public.shipment_item_quantity_confirmations (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipments(id) on delete cascade,
  shipment_item_id uuid not null references public.shipment_items(id) on delete cascade,
  extraction_id uuid not null references public.shipment_source_extractions(id) on delete restrict,
  document_id uuid not null references public.documents(id) on delete restrict,
  document_version_id uuid not null references public.document_versions(id) on delete restrict,
  field text not null check (field in ('confirmed', 'shipped')),
  previous_quantity numeric(14,3),
  quantity numeric(14,3) not null check (quantity >= 0),
  confirmed_by uuid not null references public.profiles(id) on delete restrict,
  confirmed_at timestamptz not null default now()
);
create index if not exists shipment_item_quantity_confirmations_item_idx
  on public.shipment_item_quantity_confirmations(shipment_item_id, field, confirmed_at desc);
create index if not exists shipment_item_quantity_confirmations_shipment_idx
  on public.shipment_item_quantity_confirmations(shipment_id, confirmed_at desc);

alter table public.shipment_item_quantity_confirmations enable row level security;
revoke all on public.shipment_item_quantity_confirmations from anon, authenticated, service_role;
grant select on public.shipment_item_quantity_confirmations to authenticated;
drop policy if exists "shipment users view quantity confirmations" on public.shipment_item_quantity_confirmations;
create policy "shipment users view quantity confirmations" on public.shipment_item_quantity_confirmations
  for select to authenticated using ((select private.has_permission('shipments.view')));

comment on table public.shipment_item_quantity_confirmations is
  'History of confirmed and shipped quantities taken from source documents, with the employee who confirmed them';

-- p_targets: 'confirmed' (agreed by the supplier: invoice), 'shipped' (actually loaded: packing list, waybill)
-- or both. p_lines: [{"shipment_item_id": "...", "quantity": 240}, ...] in the unit of each shipment item.
create or replace function public.apply_shipment_document_quantities(p_extraction_id uuid, p_targets text[], p_lines jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e public.shipment_source_extractions%rowtype;
  s public.shipments%rowtype;
  v_line jsonb; v_item record; v_item_id uuid; v_quantity numeric; v_previous numeric;
  v_target text; v_seen uuid[] := '{}'; v_changed integer := 0; v_user uuid := (select auth.uid());
begin
  if not (select private.has_permission('source_documents.review')) or not (select private.can_write_shipments('update')) then
    raise exception 'Недостаточно прав для подтверждения количеств по документу' using errcode = '42501';
  end if;
  if not (select private.has_permission('documents.view')) then
    raise exception 'Нет доступа к документам поставки' using errcode = '42501';
  end if;
  if p_targets is null or cardinality(p_targets) = 0
     or exists (select 1 from unnest(p_targets) t where t is null or t not in ('confirmed', 'shipped')) then
    raise exception 'Укажите, какое количество заполнить: подтверждённое или отгруженное';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Укажите количество хотя бы для одной позиции';
  end if;
  if jsonb_array_length(p_lines) > 1000 then
    raise exception 'Слишком много позиций в одном подтверждении';
  end if;

  select * into e from public.shipment_source_extractions where id = p_extraction_id for update;
  if not found then raise exception 'Документ не найден'; end if;
  if e.status <> 'confirmed' then
    raise exception 'Сначала подтвердите распознанные данные документа';
  end if;
  if e.source_kind not in ('invoice', 'specification', 'waybill') then
    raise exception 'Количества берутся из инвойса, упаковочного листа или накладной';
  end if;

  select * into s from public.shipments where id = e.shipment_id for update;
  if s.is_locked or s.status in ('closed', 'cancelled', 'on_hold') then
    raise exception 'Поставка закрыта, отменена или приостановлена: количества изменить нельзя';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_line) <> 'object' then raise exception 'Некорректная строка количеств'; end if;
    begin
      v_item_id := (v_line ->> 'shipment_item_id')::uuid;
    exception when others then
      raise exception 'Некорректная позиция поставки';
    end;
    if v_item_id is null then raise exception 'Не указана позиция поставки'; end if;
    if v_item_id = any(v_seen) then raise exception 'Позиция указана дважды'; end if;
    v_seen := v_seen || v_item_id;
    if jsonb_typeof(v_line -> 'quantity') <> 'number' then
      raise exception 'Количество должно быть числом';
    end if;
    v_quantity := (v_line ->> 'quantity')::numeric;
    if v_quantity < 0 or v_quantity >= 100000000000 or v_quantity <> round(v_quantity, 3) then
      raise exception 'Количество должно быть неотрицательным числом не более чем с тремя знаками после запятой';
    end if;

    select i.id, i.shipment_transport_id, i.confirmed_quantity, i.shipped_quantity into v_item
    from public.shipment_items i where i.id = v_item_id and i.shipment_id = s.id for update;
    if not found then raise exception 'Позиция не относится к этой поставке'; end if;
    -- A document of one vehicle speaks only about the cargo of that vehicle.
    if e.shipment_transport_id is not null and v_item.shipment_transport_id is distinct from e.shipment_transport_id then
      raise exception 'Документ относится к другому автомобилю: позицию этого автомобиля подтвердить по нему нельзя';
    end if;

    foreach v_target in array p_targets loop
      v_previous := case v_target when 'confirmed' then v_item.confirmed_quantity else v_item.shipped_quantity end;
      continue when v_previous is not distinct from v_quantity;
      if v_target = 'confirmed' then
        update public.shipment_items set confirmed_quantity = v_quantity, updated_at = now() where id = v_item.id;
      else
        update public.shipment_items set shipped_quantity = v_quantity, updated_at = now() where id = v_item.id;
      end if;
      insert into public.shipment_item_quantity_confirmations(
        shipment_id, shipment_item_id, extraction_id, document_id, document_version_id, field, previous_quantity, quantity, confirmed_by)
      values (s.id, v_item.id, e.id, e.document_id, e.document_version_id, v_target, v_previous, v_quantity, v_user);
      v_changed := v_changed + 1;
    end loop;
  end loop;

  return jsonb_build_object('changed', v_changed, 'items', cardinality(v_seen));
end $$;

revoke all on function public.apply_shipment_document_quantities(uuid, text[], jsonb) from public, anon, service_role;
grant execute on function public.apply_shipment_document_quantities(uuid, text[], jsonb) to authenticated;

comment on function public.apply_shipment_document_quantities(uuid, text[], jsonb) is
  'Writes employee-checked confirmed or shipped quantities from a confirmed invoice, packing list or waybill, with history';
