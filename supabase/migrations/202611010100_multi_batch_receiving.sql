-- Several independently traceable batches per shipment item; old single-batch calls remain valid.
-- Existing receipt records and their stock are not rewritten.
alter table public.shipment_transport_receipt_items
  add column if not exists batch_number text,
  add column if not exists manufacture_date date,
  add column if not exists expiry_date date;
do $$ declare c record; begin
  for c in select conname from pg_constraint
    where conrelid='public.shipment_transport_receipt_items'::regclass and contype='u'
      and pg_get_constraintdef(oid)='UNIQUE (receipt_id, shipment_item_id)'
  loop
    execute format('alter table public.shipment_transport_receipt_items drop constraint %I',c.conname);
  end loop;
end $$;
create unique index if not exists shipment_receipt_item_batch_unique
  on public.shipment_transport_receipt_items(receipt_id,shipment_item_id,batch_number,expiry_date) nulls not distinct;

create or replace function public.receive_shipment_transport(
  p_transport_id uuid,
  p_location_id uuid,
  p_lines jsonb,
  p_performed_by_name text,
  p_notes text default null
) returns uuid
language plpgsql
security definer
set search_path = ''
set timezone = 'Asia/Almaty'
as $$
declare
  v_transport record;
  v_line record;
  v_item record;
  v_receipt_id uuid;
  v_batch_id uuid;
  v_balance_id uuid;
  v_movement_id uuid;
  v_actual numeric(14,3);
  v_shortage numeric(14,3);
  v_overage numeric(14,3);
  v_old_stage_status text;
  v_location_zone text;
  v_expected_count integer;
  v_line_count integer;
  v_stage record;
begin
  if not (select private.has_permission('shipments.view'))
     or not (select private.has_permission('inventory.receive')) then
    raise exception 'Недостаточно прав для приёмки автомобиля';
  end if;
  if p_transport_id is null then raise exception 'Автомобиль не выбран'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Добавьте позиции приёмки';
  end if;
  if jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 2000 then
    raise exception 'Добавьте позиции приёмки';
  end if;
  if nullif(trim(p_performed_by_name), '') is null then
    raise exception 'Укажите исполнителя приёмки';
  end if;

  select
    transport.id,
    transport.shipment_id,
    transport.sequence_no,
    transport.status,
    shipment.destination_warehouse_id as warehouse_id,
    shipment.status as shipment_status,
    shipment.is_locked
  into v_transport
  from public.shipment_transports transport
  join public.shipments shipment on shipment.id = transport.shipment_id
  where transport.id = p_transport_id
  for update of transport, shipment;

  if not found then raise exception 'Автомобиль поставки не найден'; end if;
  if v_transport.is_locked or v_transport.shipment_status in ('on_hold', 'cancelled', 'closed') then
    raise exception 'Поставка недоступна для приёмки';
  end if;
  if exists (
    select 1 from public.shipment_transport_receipts
    where shipment_transport_id = p_transport_id
  ) then
    raise exception 'Этот автомобиль уже принят';
  end if;
  if v_transport.status <> 'arrived' then
    raise exception 'Сначала отметьте автомобиль как прибывший';
  end if;

  if p_location_id is not null then
    select location.zone into v_location_zone
    from public.warehouse_locations location
    where location.id = p_location_id
      and location.warehouse_id = v_transport.warehouse_id
      and location.status = 'active';
    if not found then raise exception 'Зона не относится к складу поставки или недоступна'; end if;
  end if;

  select count(*) into v_expected_count
  from public.shipment_items item
  where item.shipment_transport_id = p_transport_id;
  if v_expected_count = 0 then raise exception 'В автомобиле нет распределённых товаров'; end if;

  select count(*), count(distinct parsed.item_id)
  into v_line_count, v_expected_count
  from jsonb_to_recordset(p_lines) as parsed(item_id uuid);
  v_line_count := v_expected_count; -- All items once or with explicit batch allocations.

  select count(*) into v_expected_count
  from public.shipment_items item
  where item.shipment_transport_id = p_transport_id;
  if v_line_count <> v_expected_count then
    raise exception 'Передайте результаты по всем позициям автомобиля';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(p_lines) as parsed(item_id uuid)
    left join public.shipment_items item
      on item.id = parsed.item_id and item.shipment_transport_id = p_transport_id
    where item.id is null
  ) then
    raise exception 'Позиция не относится к выбранному автомобилю';
  end if;

  -- Validate the full partition before posting anything. Legacy single-batch callers need no expected_quantity.
  if exists (select 1 from jsonb_array_elements(p_lines) e where jsonb_typeof(e) <> 'object') then
    raise exception 'Некорректная строка приёмки';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_lines) x(item_id uuid,expected_quantity numeric,accepted_quantity numeric,damaged_quantity numeric)
    where x.accepted_quantity is null or not (x.accepted_quantity between 0 and 99999999999.999)
      or x.accepted_quantity <> trunc(x.accepted_quantity,3)
      or (x.damaged_quantity is not null and (not (x.damaged_quantity between 0 and 99999999999.999) or x.damaged_quantity <> trunc(x.damaged_quantity,3)))
      or (x.expected_quantity is not null and (not (x.expected_quantity > 0 and x.expected_quantity <= 99999999999.999) or x.expected_quantity <> trunc(x.expected_quantity,3)))
  ) then raise exception 'Количество должно быть конечным неотрицательным числом, не более трёх знаков после запятой'; end if;
  if exists (
    select 1 from jsonb_to_recordset(p_lines) x(item_id uuid,expected_quantity numeric)
    join public.shipment_items i on i.id=x.item_id
    group by i.id
    having (count(*)>1 and count(x.expected_quantity)<>count(*))
       or sum(coalesce(x.expected_quantity,coalesce(i.shipped_quantity,i.confirmed_quantity,i.ordered_quantity)))
            <> coalesce(i.shipped_quantity,i.confirmed_quantity,i.ordered_quantity)
  ) then raise exception 'Распределите всё отгруженное количество позиции по партиям без изменения общего количества'; end if;
  if exists (
    select 1 from jsonb_to_recordset(p_lines) x(item_id uuid,batch_number text,expiry_date date)
    group by x.item_id,nullif(btrim(x.batch_number),''),x.expiry_date having count(*)>1
  ) then raise exception 'Одна партия позиции передана несколько раз'; end if;
  if exists (
    select 1 from jsonb_to_recordset(p_lines) x(item_id uuid,batch_number text,expiry_date date)
    where (nullif(btrim(x.batch_number),'') is null or x.expiry_date is null)
      and (select count(*) from jsonb_to_recordset(p_lines) y(item_id uuid) where y.item_id=x.item_id)>1
  ) then raise exception 'Для каждой партии укажите номер и срок годности, в том числе при полной недостаче'; end if;

  insert into public.shipment_transport_receipts(
    shipment_id, shipment_transport_id, warehouse_id, warehouse_location_id,
    performed_by_name, notes
  ) values (
    v_transport.shipment_id, p_transport_id, v_transport.warehouse_id, p_location_id,
    trim(p_performed_by_name), nullif(trim(p_notes), '')
  ) returning id into v_receipt_id;

  for v_line in
    select *
    from jsonb_to_recordset(p_lines) as parsed(
      item_id uuid,
      expected_quantity numeric,
      accepted_quantity numeric,
      damaged_quantity numeric,
      batch_number text,
      manufacture_date date,
      expiry_date date,
      discrepancy_reason text
    )
  loop
    select
      item.id,
      item.product_id,
      item.uom,
      coalesce(item.shipped_quantity, item.confirmed_quantity, item.ordered_quantity) as expected_quantity
    into v_item
    from public.shipment_items item
    where item.id = v_line.item_id
      and item.shipment_transport_id = p_transport_id
    for update;

    if not found then raise exception 'Позиция автомобиля не найдена'; end if;
    if v_line.accepted_quantity is null or v_line.accepted_quantity < 0
       or coalesce(v_line.damaged_quantity, 0) < 0 then
      raise exception 'Фактическое и повреждённое количество не могут быть отрицательными';
    end if;

    v_item.expected_quantity := coalesce(v_line.expected_quantity,v_item.expected_quantity);
    v_actual := v_line.accepted_quantity + coalesce(v_line.damaged_quantity, 0);
    v_shortage := greatest(v_item.expected_quantity - v_actual, 0);
    v_overage := greatest(v_actual - v_item.expected_quantity, 0);

    if (v_shortage > 0 or v_overage > 0 or coalesce(v_line.damaged_quantity, 0) > 0)
       and nullif(trim(v_line.discrepancy_reason), '') is null then
      raise exception 'Укажите причину расхождения по позиции %', v_line.item_id;
    end if;

    v_batch_id := null;
    v_movement_id := null;
    if v_line.accepted_quantity > 0 then
      if nullif(trim(v_line.batch_number), '') is null then raise exception 'Укажите номер партии'; end if;
      if v_line.expiry_date is null then raise exception 'Укажите срок годности партии'; end if;
      if v_line.manufacture_date is not null and v_line.manufacture_date > v_line.expiry_date then
        raise exception 'Дата производства позже срока годности';
      end if;

      insert into public.inventory_batches(
        product_id, source_shipment_item_id, source_shipment_transport_id,
        batch_number, manufacture_date, expiry_date, notes
      ) values (
        v_item.product_id, v_item.id, p_transport_id,
        trim(v_line.batch_number), v_line.manufacture_date, v_line.expiry_date,
        nullif(trim(p_notes), '')
      )
      on conflict(product_id, batch_number, expiry_date) do update set
        source_shipment_item_id = coalesce(public.inventory_batches.source_shipment_item_id, excluded.source_shipment_item_id),
        source_shipment_transport_id = coalesce(public.inventory_batches.source_shipment_transport_id, excluded.source_shipment_transport_id),
        manufacture_date = coalesce(public.inventory_batches.manufacture_date, excluded.manufacture_date),
        updated_at = now()
      returning id into v_batch_id;

      insert into public.inventory_balances(
        batch_id, warehouse_id, warehouse_location_id, uom, quantity_on_hand
      ) values (
        v_batch_id, v_transport.warehouse_id, p_location_id, v_item.uom, v_line.accepted_quantity
      )
      on conflict do nothing
      returning id into v_balance_id;

      if v_balance_id is null then
        select balance.id into v_balance_id
        from public.inventory_balances balance
        where balance.batch_id = v_batch_id
          and balance.warehouse_id = v_transport.warehouse_id
          and balance.warehouse_location_id is not distinct from p_location_id
          and balance.uom = v_item.uom
        for update;
        update public.inventory_balances
        set quantity_on_hand = quantity_on_hand + v_line.accepted_quantity,
            updated_at = now()
        where id = v_balance_id;
      end if;

      insert into public.inventory_movements(
        batch_id, movement_type, quantity, uom,
        to_warehouse_id, to_location_id,
        shipment_id, shipment_item_id, shipment_transport_id,
        reference, reason, performed_by_name
      ) values (
        v_batch_id, 'receipt', v_line.accepted_quantity, v_item.uom,
        v_transport.warehouse_id, p_location_id,
        v_transport.shipment_id, v_item.id, p_transport_id,
        format('Приёмка автомобиля №%s', v_transport.sequence_no),
        nullif(trim(v_line.discrepancy_reason), ''), trim(p_performed_by_name)
      ) returning id into v_movement_id;
    end if;

    insert into public.shipment_transport_receipt_items(
      receipt_id, shipment_item_id, expected_quantity,
      accepted_quantity, damaged_quantity, shortage_quantity, overage_quantity,
      discrepancy_reason, inventory_batch_id, inventory_movement_id, batch_number, manufacture_date, expiry_date
    ) values (
      v_receipt_id, v_item.id, v_item.expected_quantity,
      v_line.accepted_quantity, coalesce(v_line.damaged_quantity, 0), v_shortage, v_overage,
      nullif(trim(v_line.discrepancy_reason), ''), v_batch_id, v_movement_id,
      nullif(btrim(v_line.batch_number),''), v_line.manufacture_date, v_line.expiry_date
    );

  end loop;

  -- One item total, even when its stock is spread over multiple expiry dates.
  update public.shipment_items i
  set received_quantity=x.actual, discrepancy_reason=x.reason,
      discrepancy_accepted_by=case when x.discrepancy then auth.uid() else null end,
      updated_at=now()
  from (
    select ri.shipment_item_id, sum(ri.accepted_quantity+ri.damaged_quantity) actual,
      string_agg(distinct ri.discrepancy_reason,'; ') filter(where ri.discrepancy_reason is not null) reason,
      bool_or(ri.shortage_quantity>0 or ri.overage_quantity>0 or ri.damaged_quantity>0) discrepancy
    from public.shipment_transport_receipt_items ri where ri.receipt_id=v_receipt_id group by ri.shipment_item_id
  ) x where i.id=x.shipment_item_id;

  update public.shipment_transports
  set status = 'unloaded',
      actual_arrival_date = coalesce(actual_arrival_date, current_date),
      updated_at = now()
  where id = p_transport_id;

  for v_stage in
    select run.id, run.status
    from public.shipment_stage_runs run
    join public.shipment_stages stage on stage.id = run.stage_id
    where run.shipment_id = v_transport.shipment_id
      and run.shipment_transport_id = p_transport_id
      and (
        stage.code in ('warehouse_receiving', 'quantity_check', 'batch_registration')
        or (stage.code = 'putaway' and v_location_zone = 'storage')
      )
      and run.status <> 'completed'
    order by stage.sequence_order
    for update of run
  loop
    v_old_stage_status := v_stage.status;
    update public.shipment_stage_runs
    set status = 'completed',
        status_reason = null,
        performed_by_name = trim(p_performed_by_name),
        started_at = coalesce(started_at, now()),
        completed_at = now(),
        updated_at = now()
    where id = v_stage.id;

    insert into public.shipment_stage_history(
      stage_run_id, shipment_id, from_status, to_status,
      changed_by, performed_by_name, reason
    ) values (
      v_stage.id, v_transport.shipment_id, v_old_stage_status, 'completed',
      auth.uid(), trim(p_performed_by_name),
      format('Приёмка автомобиля №%s', v_transport.sequence_no)
    );
  end loop;

  update public.shipments shipment
  set leading_stage_id = (
        select run.stage_id
        from public.shipment_stage_runs run
        join public.shipment_stages stage on stage.id = run.stage_id
        where run.shipment_id = v_transport.shipment_id
          and run.is_required
          and run.status not in ('completed', 'skipped', 'not_applicable')
        order by stage.sequence_order
        limit 1
      ),
      status = coalesce((
        select stage.status_category
        from public.shipment_stage_runs run
        join public.shipment_stages stage on stage.id = run.stage_id
        where run.shipment_id = v_transport.shipment_id
          and run.is_required
          and run.status not in ('completed', 'skipped', 'not_applicable')
        order by stage.sequence_order
        limit 1
      ), 'closed'),
      updated_at = now()
  where shipment.id = v_transport.shipment_id
    and shipment.status not in ('on_hold', 'cancelled');

  return v_receipt_id;
end;
$$;

revoke all on function public.receive_shipment_transport(uuid,uuid,jsonb,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.receive_shipment_transport(uuid,uuid,jsonb,text,text)
  to authenticated;


create or replace function public.shipment_quantity_provenance(p_shipment_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('inventoryVisible',private.has_permission('inventory.view'),
 'auditVisible',private.has_permission('audit.view'),'items',coalesce(jsonb_agg(jsonb_build_object(
  'id',i.id,'sku',p.internal_sku,'name',p.name,'uom',i.uom,'transport',t.sequence_no,
  'ordered',i.ordered_quantity,'confirmed',i.confirmed_quantity,'shipped',i.shipped_quantity,
  'received',case when private.has_permission('inventory.view') then i.received_quantity end,
  'history',coalesce((select jsonb_agg(jsonb_build_object(
    'id',h.id,'field',h.field,'previous',h.previous_quantity,'quantity',h.quantity,
    'latest',not exists(select 1 from public.shipment_item_quantity_confirmations newer
      where newer.shipment_item_id=h.shipment_item_id and newer.field=h.field
      and newer.id<>h.id and newer.confirmed_at>=h.confirmed_at),
    'at',h.confirmed_at,'actor',actor.full_name,'documentId',d.id,'document',d.title,
    'version',v.version_number,'currentVersion',v.is_current and v.version_number=d.current_version,
    'reviewed',e.status='confirmed' and e.reviewed_at is not null
   ) order by h.confirmed_at,h.id)
   from public.shipment_item_quantity_confirmations h
   join public.documents d on d.id=h.document_id and d.archived_at is null and d.status<>'rejected'
   join public.document_versions v on v.id=h.document_version_id and v.document_id=d.id
   join public.shipment_source_extractions e on e.id=h.extraction_id and e.document_id=d.id
    and e.document_version_id=v.id and e.shipment_id=i.shipment_id
   left join public.profiles actor on actor.id=h.confirmed_by
   where h.shipment_id=i.shipment_id and h.shipment_item_id=i.id
    and private.can_view_generated_document(d.id)
    and (e.shipment_transport_id is null or e.shipment_transport_id=i.shipment_transport_id)
    and exists(select 1 from public.document_links l where l.document_id=d.id and l.removed_at is null
     and (l.entity_type='shipment' and l.entity_id=i.shipment_id
      or l.entity_type='shipment_transport' and l.entity_id=e.shipment_transport_id))),'[]'::jsonb),
  'demandHistory',coalesce((select jsonb_agg(jsonb_build_object(
    'id',a.id::text,'action',a.action,'previous',a.before_data->'ordered_quantity',
    'quantity',a.after_data->'ordered_quantity','uom',a.after_data->>'uom',
    'previousUom',a.before_data->>'uom','at',a.created_at,'actor',actor.full_name
   ) order by a.created_at,a.id)
   from public.audit_log a left join public.profiles actor on actor.id=a.actor_user_id
   where a.entity_type='shipment_items' and a.entity_id=i.id::text and a.metadata->>'source'='database'
    and a.action in ('insert','update') and (a.action='insert'
     or a.before_data->'ordered_quantity' is distinct from a.after_data->'ordered_quantity'
     or a.before_data->'uom' is distinct from a.after_data->'uom')),'[]'::jsonb),
  'receipts',coalesce((select jsonb_agg(jsonb_build_object(
    'id',r.id,'at',r.received_at,'actor',actor.full_name,'performedBy',r.performed_by_name,
    'expected',ri.expected_quantity,'accepted',ri.accepted_quantity,'damaged',ri.damaged_quantity,
    'shortage',ri.shortage_quantity,'overage',ri.overage_quantity,'reason',ri.discrepancy_reason
   ) order by r.received_at,r.id)
   from (select receipt_id,shipment_item_id,sum(expected_quantity) expected_quantity,
     sum(accepted_quantity) accepted_quantity,sum(damaged_quantity) damaged_quantity,
     sum(shortage_quantity) shortage_quantity,sum(overage_quantity) overage_quantity,
     string_agg(distinct discrepancy_reason,'; ') discrepancy_reason
    from public.shipment_transport_receipt_items group by receipt_id,shipment_item_id) ri
   join public.shipment_transport_receipts r on r.id=ri.receipt_id and r.shipment_id=i.shipment_id
   left join public.profiles actor on actor.id=r.received_by where ri.shipment_item_id=i.id),'[]'::jsonb)
 ) order by t.sequence_no nulls last,i.created_at,i.id),'[]'::jsonb))
 from public.shipment_items i join public.shipments s on s.id=i.shipment_id
 left join public.products p on p.id=i.product_id
 left join public.shipment_transports t on t.id=i.shipment_transport_id
 where i.shipment_id=p_shipment_id and private.has_permission('shipments.view');
$$;
revoke all on function public.shipment_quantity_provenance(uuid) from public,anon,authenticated,service_role;
grant execute on function public.shipment_quantity_provenance(uuid) to authenticated;

-- Direct arrival does not establish an unknown loading date.
create or replace function public.change_shipment_transport_status(p_transport_id uuid, p_status text)
returns void language plpgsql security definer set search_path='' as $$
declare v_locked boolean; v_status text; v_received boolean;
begin
  if not private.can_write_shipments('change_status') then
    raise exception 'Недостаточно прав для изменения перевозки';
  end if;
  if p_status not in ('planned','loading','in_transit','at_customs','arrived','unloaded','cancelled') then
    raise exception 'Некорректный статус перевозки';
  end if;
  select shipment.is_locked, transport.status into v_locked, v_status
  from public.shipment_transports transport
  join public.shipments shipment on shipment.id = transport.shipment_id
  where transport.id = p_transport_id for update of transport, shipment;
  if not found then raise exception 'Перевозка не найдена'; end if;
  if v_locked then raise exception 'Закрытая поставка недоступна для изменений'; end if;
  v_received := exists(select 1 from public.shipment_transport_receipts where shipment_transport_id=p_transport_id);
  if p_status <> 'unloaded' and v_received then
    raise exception 'Автомобиль уже принят на склад: отмена и возврат статуса запрещены';
  end if;
  if p_status = 'unloaded' and not v_received and v_status <> 'unloaded' then
    raise exception 'Статус «Разгружен» ставит приёмка: переведите автомобиль в «Прибыл» и примите товар';
  end if;
  update public.shipment_transports set
    status = p_status,
    actual_loading_date = case when p_status in ('loading','in_transit','at_customs','unloaded') then coalesce(actual_loading_date,private.business_today()) else actual_loading_date end,
    actual_arrival_date = case when p_status in ('arrived','unloaded') then coalesce(actual_arrival_date,private.business_today()) else actual_arrival_date end,
    updated_at = now()
  where id = p_transport_id;
end $$;

revoke all on function public.change_shipment_transport_status(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.change_shipment_transport_status(uuid,text) to authenticated;
