-- Integration fixes for PRs 14–20. No business rows are changed.
-- Preserve shipped quantities, validate document evidence, refresh proposal actions, and retain dated balances.
create or replace function private.customer_return_room(p_sale_id uuid)
returns table (sale_item_id uuid, batch_id uuid, shipped numeric, returned numeric)
language sql stable security definer set search_path = '' as $$
  with shipped as (
    select i.id as sale_item_id, r.batch_id,
           sum(r.sale_quantity) as quantity
    from public.sale_items i
    join public.inventory_reservations r on r.sale_item_id = i.id and r.status = 'fulfilled'
    join public.inventory_balances b on b.id = r.inventory_balance_id
    where i.sale_id = p_sale_id
    group by i.id, r.batch_id
  ), returned as (
    select ri.sale_item_id, ri.batch_id, sum(ri.quantity) as quantity
    from public.customer_return_items ri join public.customer_returns cr on cr.id = ri.return_id
    where cr.sale_id = p_sale_id and cr.status <> 'cancelled'
    group by ri.sale_item_id, ri.batch_id
  )
  select s.sale_item_id, s.batch_id, coalesce(s.quantity, 0), coalesce(rt.quantity, 0)
  from shipped s left join returned rt on rt.sale_item_id = s.sale_item_id and rt.batch_id = s.batch_id
$$;

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

  -- Lock the source rows while applying values: neither a replaced version nor a removed link is evidence.
  if not private.can_view_generated_document(e.document_id) then
    raise exception 'Нет доступа к документу' using errcode = '42501';
  end if;
  perform 1 from public.documents d
  join public.document_versions v on v.document_id=d.id and v.id=e.document_version_id
  join public.document_links l on l.document_id=d.id
  where d.id=e.document_id and d.archived_at is null and d.status <> 'rejected'
    and v.is_current and v.version_number=d.current_version and l.removed_at is null
    and ((l.entity_type='shipment' and l.entity_id=e.shipment_id)
      or (l.entity_type='shipment_transport' and l.entity_id=e.shipment_transport_id
        and exists(select 1 from public.shipment_transports t where t.id=l.entity_id
          and t.shipment_id=e.shipment_id and t.status <> 'cancelled')))
  for share of d,v,l;
  if not found then
    raise exception 'Документ отвязан, отклонён, архивирован или заменён новой версией. Подтвердите актуальный документ';
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

create or replace function public.accept_logist_proposal(p_proposal_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.logist_proposals%rowtype;
  v_user uuid := (select auth.uid());
  v_today date := (now() at time zone 'Asia/Almaty')::date;
  v_assignee uuid;
  v_result jsonb;
  v_action jsonb;
begin
  if not (select private.has_permission('shipments.view')) or not (select private.has_permission('documents.view')) then
    raise exception 'Нет доступа к поставкам или документам' using errcode = '42501';
  end if;
  select * into p from public.logist_proposals where id = p_proposal_id for update;
  if not found then raise exception 'Предложение не найдено'; end if;
  if p.status <> 'pending' then raise exception 'Предложение уже рассмотрено'; end if;
  if not (select private.has_permission(private.logist_kind_permission(p.kind))) then
    raise exception 'Недостаточно прав, чтобы принять это предложение' using errcode = '42501';
  end if;
  perform 1 from public.shipments where id = p.shipment_id for update;
  -- The situation may have changed since the proposal was made.
  select c.action into v_action from private.logist_candidates(p.shipment_id, v_today) c
  where c.dedupe_key = p.dedupe_key;
  if not found
     or exists (select 1 from public.shipments sh where sh.id = p.shipment_id and (sh.is_locked or sh.status in ('closed', 'cancelled', 'on_hold'))) then
    update public.logist_proposals set status = 'obsolete' where id = p.id;
    return jsonb_build_object('status', 'obsolete');
  end if;

  if p.kind = 'complete_stage' then
    perform public.change_shipment_stage_status((v_action ->> 'stage_run_id')::uuid, 'completed', null, null);
    v_result := jsonb_build_object('stage_run_id', v_action ->> 'stage_run_id');
  elsif p.kind = 'bind_document_vehicle' then
    perform public.assign_source_extraction_transport((v_action ->> 'extraction_id')::uuid, (v_action ->> 'transport_id')::uuid);
    v_result := jsonb_build_object('extraction_id', v_action ->> 'extraction_id', 'transport_id', v_action ->> 'transport_id');
  elsif p.kind = 'follow_up_task' then
    -- Only a manager assigns tasks to others; anyone else who accepts takes the task.
    v_assignee := nullif(v_action ->> 'assignee_user_id', '')::uuid;
    if v_assignee is null or (v_assignee <> v_user and not (select private.has_permission('tasks.manage')))
       or not private.is_active_employee(v_assignee) then
      v_assignee := v_user;
    end if;
    v_result := jsonb_build_object('task_id', public.create_task(
      v_action ->> 'task_title', v_assignee, private.business_task_due(v_today + 1), 'high',
      v_action ->> 'task_description', p.shipment_id, nullif(v_action ->> 'stage_run_id', '')::uuid),
      'assignee_user_id', v_assignee);
  end if;

  update public.logist_proposals set action = v_action, status = 'accepted', decided_by = v_user, decided_at = now(), result = v_result where id = p.id;
  -- Accepting may open the next step (the following stage).
  perform private.logist_refresh(p.shipment_id);
  return jsonb_build_object('status', 'accepted', 'result', v_result);
end $$;

create or replace function private.customer_ledger_at(p_customer_id uuid, p_as_of date)
returns table (entry_date date, due_date date, kind text, ref_id uuid, ref_number text, currency_id uuid, amount numeric, description text)
language sql stable security definer set search_path = '' as $$
  with recursive snapshots as (
    select ob.*, 0 as revision_distance from public.customer_opening_balances ob
    where ob.customer_id=p_customer_id and ob.superseded_at is null
    union all
    select old.*, newer.revision_distance+1 from public.customer_opening_balances old
    join snapshots newer on old.superseded_by=newer.id
  ), opening as (
    -- Keep the existing import semantics: a new import replaces the prior balance.
    -- For a date before that import's accounting date, follow its preserved predecessor chain.
    select distinct on (currency_id) * from snapshots where as_of<=p_as_of
    order by currency_id, revision_distance
  ), deferral as (
    select coalesce((select t.default_deferral_days from public.customer_credit_terms t where t.customer_id = p_customer_id), 0) as days
  ), shipped as (
    select s.id, s.sale_number, coalesce((s.shipped_at at time zone 'Asia/Almaty')::date, s.planned_shipment_date) as ship_date
    from public.sales s where s.customer_id = p_customer_id and s.status = 'shipped'
  ), entries as (
    select o.as_of as entry_date, coalesce(o.due_date, o.as_of + (select days from deferral)) as due_date, 'opening'::text as kind,
           o.id as ref_id, o.contract_number as ref_number, o.currency_id, o.amount,
           'Сальдо по данным 1С на ' || to_char(o.as_of, 'DD.MM.YYYY') as description
    from opening o
    union all
    select sh.ship_date, sh.ship_date + private.sale_deferral_days(sh.id, sh.ship_date), 'shipment', sh.id, sh.sale_number,
           private.sale_currency(sh.id), a.amount,
           'Отгрузка по заказу ' || sh.sale_number || case when a.unpriced_lines > 0 then ' (строк без цены: ' || a.unpriced_lines || ')' else '' end
    from shipped sh cross join lateral private.sale_amount(sh.id) a
    union all
    select (cr.received_at at time zone 'Asia/Almaty')::date, (cr.received_at at time zone 'Asia/Almaty')::date, 'return', cr.id,
           cr.return_number, private.sale_currency(cr.sale_id), -round(sum(ri.quantity * ri.unit_price), 2),
           'Возврат ' || cr.return_number || ' по заказу ' || s.sale_number
    from public.customer_returns cr
    join public.sales s on s.id = cr.sale_id
    join public.customer_return_items ri on ri.return_id = cr.id and ri.unit_price is not null
    where cr.customer_id = p_customer_id and cr.status <> 'cancelled'
    group by cr.id, cr.received_at, cr.return_number, cr.sale_id, s.sale_number
    union all
    select l.doc_date, l.doc_date, 'payment', l.id, l.doc_number, l.currency_id, -l.amount,
           'Оплата' || coalesce(' п/п №' || l.doc_number, '') || coalesce(' · ' || left(l.purpose, 120), '')
    from public.bank_statement_lines l where l.customer_id = p_customer_id and l.status = 'matched'
    union all
    select a.entry_date, a.entry_date, 'adjustment', a.id, null, a.currency_id, a.amount, 'Корректировка: ' || a.reason
    from public.customer_balance_adjustments a where a.customer_id = p_customer_id
  )
  select e.entry_date, e.due_date, e.kind, e.ref_id, e.ref_number, e.currency_id, e.amount, e.description
  from entries e
  left join opening o on o.currency_id = e.currency_id
  where (e.amount <> 0 or e.kind = 'shipment') and (e.kind = 'opening' or o.as_of is null or e.entry_date > o.as_of)
$$;
revoke all on function private.customer_ledger_at(uuid,date) from public, anon, authenticated, service_role;

create or replace function private.customer_ledger(p_customer_id uuid)
returns table (entry_date date, due_date date, kind text, ref_id uuid, ref_number text, currency_id uuid, amount numeric, description text)
language sql stable security definer set search_path = '' as $$
  select * from private.customer_ledger_at(p_customer_id, private.receivables_today())
$$;

create or replace function public.record_reconciliation_act(p_customer_id uuid, p_currency text, p_as_of date, p_act_balance numeric, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_currency uuid := private.currency_by_code(p_currency); v_nexus numeric; v_id uuid; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not (select private.has_permission('receivables.manage')) then
    raise exception 'Нет права вести дебиторскую задолженность' using errcode = '42501';
  end if;
  if not exists (select 1 from public.counterparties where id = p_customer_id and 'customer' = any(roles)) then
    raise exception 'Покупатель не найден';
  end if;
  if p_as_of is null or p_as_of > private.receivables_today() then raise exception 'Дата акта не может быть в будущем'; end if;
  if p_act_balance is null then raise exception 'Укажите сальдо по акту'; end if;
  if v_note is not null and length(v_note) > 500 then raise exception 'Комментарий не должен быть длиннее 500 символов'; end if;
  select coalesce(sum(amount), 0) into v_nexus from private.customer_ledger_at(p_customer_id, p_as_of) where currency_id = v_currency and entry_date <= p_as_of;
  insert into public.customer_reconciliation_acts(customer_id, currency_id, as_of, act_balance, nexus_balance, note)
  values (p_customer_id, v_currency, p_as_of, round(p_act_balance, 2), v_nexus, v_note) returning id into v_id;
  return jsonb_build_object('id', v_id, 'nexus_balance', v_nexus, 'difference', round(p_act_balance, 2) - v_nexus);
end $$;
