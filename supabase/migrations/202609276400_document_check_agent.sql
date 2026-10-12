-- Agent «Сверщик документов поставки» (document check).
--
-- Compares the documents of an active shipment with its card and with each other, by fixed rules only
-- (no language model, nothing is sent outside the database):
--   * vehicle and trailer plates in the documents against the vehicle cards;
--   * gross and net weight in the documents against the weight calculated from the items and the
--     product packaging (tolerance: the larger of 2 % and 50 kg), pallet count against the calculation;
--   * the supply contract number against the contract of the shipment, the invoice number against the
--     number registered for the invoice document;
--   * mandatory documents per shipment and per vehicle; missing ones become errors once customs starts;
--   * documents and the supply contract that have expired or expire before the planned arrival;
--   * recognition results that still wait for an employee (conflicts between documents, unread files).
--
-- The agent writes nothing into shipments, documents or extractions. Its only writes are its own check
-- state (which problems were already reported) and in-app notifications to administrators, directors
-- and logistics employees. Tasks are created only by an employee with the button in the shipment card.
--
-- Runs: after every recognition and confirmation (run_shipment_document_check, employee session) and
-- once a day for every active shipment (run_document_checks, service_role, for example pg_cron).

-- 1. Check state --------------------------------------------------------------------------------

create table if not exists public.shipment_document_checks (
  shipment_id uuid primary key references public.shipments(id) on delete cascade,
  status text not null check (status in ('ok', 'warning', 'error')),
  error_count integer not null default 0 check (error_count >= 0),
  warning_count integer not null default 0 check (warning_count >= 0),
  -- Keys of the problems already reported; a problem is reported once until it is fixed.
  notified_keys text[] not null default '{}',
  source text not null check (source in ('recognition', 'manual', 'daily')),
  checked_at timestamptz not null default now()
);

-- Internal state: read only through the functions below.
alter table public.shipment_document_checks enable row level security;
revoke all on public.shipment_document_checks from anon, authenticated, service_role;

comment on table public.shipment_document_checks is
  'Last run of the document check agent per shipment and the problems already reported; internal, no direct access';

-- 2. Rules ----------------------------------------------------------------------------------------

-- Who receives the agent's notifications: the Nexus administrator, the director and all logistics roles.
create or replace function private.document_check_recipient_roles()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['administrator', 'director', 'logistics_director', 'senior_logistics_manager', 'logistics_specialist']
$$;

-- Allowed weight difference: the larger of 2 % of the calculated weight and 50 kg.
create or replace function private.document_check_weight_tolerance(p_expected numeric)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select greatest(abs(p_expected) * 0.02, 50)
$$;

-- Numbers and plates are compared without spaces, dashes and case.
create or replace function private.document_check_key(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(upper(regexp_replace(coalesce(p_value, ''), '[^A-Za-zА-Яа-яЁё0-9]', '', 'g')), '')
$$;

create or replace function private.document_check_number(p_value text)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_value is null or btrim(p_value) = '' then
    return null;
  end if;
  return replace(regexp_replace(p_value, '[\s ]', '', 'g'), ',', '.')::numeric;
exception when others then
  return null;
end;
$$;

create or replace function private.document_check_finding(
  p_code text, p_severity text, p_message text,
  p_transport_id uuid default null, p_transport_no integer default null,
  p_document_id uuid default null, p_document_title text default null,
  p_field text default null, p_document_value text default null, p_card_value text default null)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'key', concat_ws(':', p_code, coalesce(p_transport_id::text, '-'), coalesce(p_document_id::text, '-'),
                     coalesce(p_field, '-'), coalesce(private.document_check_key(p_document_value), '-')),
    'code', p_code, 'severity', p_severity, 'message', p_message,
    'transport_id', p_transport_id, 'transport_no', p_transport_no,
    'document_id', p_document_id, 'document_title', p_document_title,
    'field', p_field, 'document_value', p_document_value, 'card_value', p_card_value))
$$;

-- Weight and pallets calculated from the items and the product packaging, the same way as the
-- «Загрузка» tab (src/lib/shipments/load-summary.ts): quantity = shipped, else confirmed, else ordered;
-- weight from the item's own unit, else from boxes, else from pieces. A total with any unknown line is
-- unknown: a partial sum would look like a mismatch. One row per vehicle and one total row.
create or replace function private.document_check_load(p_shipment_id uuid)
returns table (transport_id uuid, is_total boolean, item_count integer, gross_kg numeric, net_kg numeric, pallets numeric)
language sql
stable
security definer
set search_path = ''
as $$
  with lines as (
    select i.shipment_transport_id as transport_id, i.uom,
           coalesce(i.shipped_quantity, i.confirmed_quantity, i.ordered_quantity) as q,
           sel.units_per_parent as sel_f, sel.gross_weight_kg as sel_g, sel.net_weight_kg as sel_n,
           pc.gross_weight_kg as pc_g, pc.net_weight_kg as pc_n,
           bx.units_per_parent as bx_f, bx.gross_weight_kg as bx_g, bx.net_weight_kg as bx_n,
           pl.units_per_parent as pl_f
    from public.shipment_items i
    left join public.product_packaging sel on sel.product_id = i.product_id and sel.uom = i.uom
    left join public.product_packaging pc on pc.product_id = i.product_id and pc.uom = 'piece'
    left join public.product_packaging bx on bx.product_id = i.product_id and bx.uom = 'box'
    left join public.product_packaging pl on pl.product_id = i.product_id and pl.uom = 'pallet'
    where i.shipment_id = p_shipment_id
  ), pieces as (
    select l.*, case when l.uom = 'piece' then l.q else l.q * l.sel_f end as pcs
    from lines l
  ), calc as (
    select p.transport_id,
           case when p.sel_g > 0 then p.q * p.sel_g
                when p.bx_g > 0 and p.bx_f > 0 and p.pcs is not null then p.pcs / p.bx_f * p.bx_g
                when p.pc_g > 0 and p.pcs is not null then p.pcs * p.pc_g end as gross,
           case when p.sel_n > 0 then p.q * p.sel_n
                when p.bx_n > 0 and p.bx_f > 0 and p.pcs is not null then p.pcs / p.bx_f * p.bx_n
                when p.pc_n > 0 and p.pcs is not null then p.pcs * p.pc_n end as net,
           case when p.pl_f > 0 and p.pcs is not null then p.pcs / p.pl_f end as pallets
    from pieces p
  )
  select c.transport_id, grouping(c.transport_id) = 1, count(*)::integer,
         case when bool_and(c.gross is not null) then round(sum(c.gross), 3) end,
         case when bool_and(c.net is not null) then round(sum(c.net), 3) end,
         case when bool_and(c.pallets is not null) then round(sum(c.pallets), 3) end
  from calc c
  group by grouping sets ((c.transport_id), ())
$$;


-- Kilograms for messages: whole kilograms are enough for a tolerance of at least 50 kg.
create or replace function private.document_check_kg(p_value numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_value is null then null else round(p_value)::text || ' кг' end
$$;

-- All findings for one shipment on a given day, errors first. Closed and cancelled shipments have none.
create or replace function private.document_check_findings(p_shipment_id uuid, p_today date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with s as (
    select sh.id, sh.type, sh.status, sh.process_template_id, sh.route_id, sh.contract_id, sh.planned_arrival_date,
           sh.status in ('planning', 'in_production', 'preparing_transport', 'in_transit', 'customs', 'on_hold') as pre_arrival,
           sh.status in ('customs', 'receiving', 'sales') as shipment_at_customs
    from public.shipments sh
    where sh.id = p_shipment_id and sh.status not in ('closed', 'cancelled')
  ), tr as (
    select t.* from public.shipment_transports t join s on t.shipment_id = s.id where t.status <> 'cancelled'
  ), vehicles as (
    select count(*)::integer as n, case when count(*) = 1 then (array_agg(tr.id))[1] end as single_id from tr
  ), customs_runs as (
    -- Customs stages that have started, for the whole shipment (transport null) or for one vehicle.
    select run.shipment_transport_id
    from public.shipment_stage_runs run
    join public.shipment_stages st on st.id = run.stage_id
    join s on run.shipment_id = s.id
    where st.status_category = 'customs' and run.status in ('in_progress', 'completed')
  ), customs as (
    select s.shipment_at_customs
           or exists (select 1 from tr where tr.status in ('at_customs', 'arrived', 'unloaded'))
           or exists (select 1 from customs_runs) as started
    from s
  ), src as (
    select e.document_id, e.source_kind, e.status, e.shipment_transport_id as bound_id,
           coalesce(e.shipment_transport_id, (select single_id from vehicles)) as transport_id,
           d.title, d.document_number,
           case when e.status = 'confirmed' then e.confirmed_data else e.extracted_data end as data
    from public.shipment_source_extractions e
    join s on e.shipment_id = s.id
    join public.documents d on d.id = e.document_id and d.archived_at is null
    where e.status in ('extracted', 'needs_review', 'confirmed', 'failed')
  ), plates as (
    select src.*, p.field, p.label, nullif(btrim(src.data ->> p.field), '') as value
    from src
    cross join (values ('vehicle_plate', 'Госномер автомобиля'), ('trailer_plate', 'Госномер прицепа')) p(field, label)
    where src.status <> 'failed'
  ), weights as (
    select src.document_id, src.title, src.bound_id, w.field, w.label,
           private.document_check_number(src.data ->> w.field) as doc_value,
           l.item_count,
           case w.field when 'gross_weight_kg' then l.gross_kg when 'net_weight_kg' then l.net_kg else l.pallets end as expected
    from src
    cross join (values ('gross_weight_kg', 'Вес брутто'), ('net_weight_kg', 'Вес нетто'), ('pallet_count', 'Количество паллет')) w(field, label)
    -- A document bound to a vehicle is compared with that vehicle, any other with the whole shipment.
    left join lateral (
      select * from private.document_check_load(p_shipment_id) dl
      where (src.bound_id is not null and not dl.is_total and dl.transport_id = src.bound_id)
         or (src.bound_id is null and dl.is_total)
    ) l on true
    where src.status <> 'failed'
  ), req as (
    select r.document_type_id, r.applies_to, array_agg(r.stage_id) filter (where r.stage_id is not null) as stage_ids
    from public.document_requirements r
    join s on (r.shipment_type is null or r.shipment_type = s.type)
          and (r.process_template_id is null or r.process_template_id = s.process_template_id)
          and (r.route_id is null or r.route_id = s.route_id)
    where r.is_active and r.is_mandatory
    group by r.document_type_id, r.applies_to
  ), linked as (
    select d.id, d.document_type_id, d.title, d.valid_until, l.entity_type, l.entity_id
    from public.document_links l
    join public.documents d on d.id = l.document_id
    join s on (l.entity_type = 'shipment' and l.entity_id = s.id)
           or (l.entity_type = 'shipment_transport' and l.entity_id in (select tr.id from tr))
    where l.removed_at is null and d.archived_at is null and d.status <> 'rejected'
  ), findings as (
    -- Recognition still waiting for an employee.
    select private.document_check_finding('document_not_read', 'warning',
             'Документ не прочитан: данные из него не сверены', null, null, src.document_id, src.title) as f
    from src where src.status = 'failed'
    union all
    select private.document_check_finding('document_needs_review', 'warning',
             'Документы расходятся между собой: значения ждут проверки сотрудником', null, null, src.document_id, src.title)
    from src where src.status = 'needs_review'

    -- Plates of a known vehicle.
    union all
    select case when nullif(btrim(c.card), '') is null
             then private.document_check_finding('plate_missing_in_card', 'warning',
                    pl.label || ' указан в документе, но не заполнен в карточке автомобиля',
                    t.id, t.sequence_no, pl.document_id, pl.title, pl.field, pl.value, null)
             else private.document_check_finding('plate_mismatch', 'error',
                    pl.label || ' в документе не совпадает с карточкой автомобиля',
                    t.id, t.sequence_no, pl.document_id, pl.title, pl.field, pl.value, c.card) end
    from plates pl
    join tr t on t.id = pl.transport_id
    cross join lateral (select case pl.field when 'vehicle_plate' then t.vehicle_plate else t.trailer_plate end as card) c
    where pl.value is not null
      and (nullif(btrim(c.card), '') is null or private.document_check_key(c.card) is distinct from private.document_check_key(pl.value))

    -- Plates of a document not bound to a vehicle while there are several (or none).
    union all
    select case when v.n = 0
             then private.document_check_finding('vehicle_missing', 'warning',
                    pl.label || ' указан в документе, но в поставке нет автомобиля',
                    null, null, pl.document_id, pl.title, pl.field, pl.value, null)
             else private.document_check_finding('plate_unknown', 'error',
                    pl.label || ' из документа не найден ни у одного автомобиля поставки',
                    null, null, pl.document_id, pl.title, pl.field, pl.value, null) end
    from plates pl cross join vehicles v
    where pl.value is not null and pl.transport_id is null
      and not exists (select 1 from tr
                      where private.document_check_key(case pl.field when 'vehicle_plate' then tr.vehicle_plate else tr.trailer_plate end)
                            = private.document_check_key(pl.value))

    -- Weights and pallets against the calculation from items and packaging.
    union all
    select case
             when w.item_count is null and w.bound_id is not null
               then private.document_check_finding('cargo_not_allocated', 'warning',
                      w.label || ': на этот автомобиль не распределены товары, сверить нельзя',
                      t.id, t.sequence_no, w.document_id, w.title, w.field, w.doc_value::text, null)
             when w.expected is null
               then private.document_check_finding('load_not_calculated', 'warning',
                      w.label || ': сверить нельзя — в карточках товаров не хватает данных упаковки',
                      t.id, t.sequence_no, w.document_id, w.title, w.field, w.doc_value::text, null)
             when w.field = 'pallet_count'
               then private.document_check_finding('pallet_mismatch', 'warning',
                      'Количество паллет в документе не совпадает с расчётом по товарам',
                      t.id, t.sequence_no, w.document_id, w.title, w.field, w.doc_value::text,
                      'около ' || trim(trailing '.' from trim(trailing '0' from round(w.expected, 2)::text)))
             else private.document_check_finding('weight_mismatch', 'error',
                    w.label || ' в документе отличается от расчёта по товарам больше допуска',
                    t.id, t.sequence_no, w.document_id, w.title, w.field, private.document_check_kg(w.doc_value),
                    private.document_check_kg(w.expected) || ' ± ' || private.document_check_kg(private.document_check_weight_tolerance(w.expected)))
           end
    from weights w
    left join tr t on t.id = w.bound_id
    where w.doc_value is not null
      and (select count(*) from public.shipment_items i where i.shipment_id = p_shipment_id) > 0
      and (w.expected is null
           or (w.field = 'pallet_count' and (w.doc_value < floor(w.expected) or w.doc_value > ceil(w.expected)))
           or (w.field <> 'pallet_count' and abs(w.doc_value - w.expected) > private.document_check_weight_tolerance(w.expected)))

    -- Supply contract number.
    union all
    select private.document_check_finding('contract_number_mismatch', 'warning',
             'Номер договора в документе не совпадает с договором поставки в карточке',
             null, null, src.document_id, src.title, 'contract_number', src.data ->> 'contract_number', c.number)
    from src
    join s on true
    join public.contracts c on c.id = s.contract_id
    where src.status <> 'failed' and src.source_kind in ('invoice', 'specification', 'contract')
      and private.document_check_key(src.data ->> 'contract_number') is not null
      and private.document_check_key(src.data ->> 'contract_number') is distinct from private.document_check_key(c.number)

    -- Invoice number against the number registered for the same document.
    union all
    select private.document_check_finding('invoice_number_mismatch', 'warning',
             'Номер инвойса в тексте не совпадает с номером, под которым документ зарегистрирован',
             null, null, src.document_id, src.title, 'invoice_number', src.data ->> 'invoice_number', src.document_number)
    from src
    where src.status <> 'failed' and src.source_kind = 'invoice'
      and private.document_check_key(src.data ->> 'invoice_number') is not null
      and private.document_check_key(src.document_number) is not null
      and private.document_check_key(src.data ->> 'invoice_number') <> private.document_check_key(src.document_number)

    -- Mandatory documents of the shipment.
    union all
    select private.document_check_finding('document_missing',
             case when cu.started or exists (select 1 from public.shipment_stage_runs run
                                             where run.shipment_id = p_shipment_id and run.stage_id = any(rq.stage_ids)
                                               and run.status in ('in_progress', 'completed'))
                  then 'error' else 'warning' end,
             'Нет обязательного документа «' || dt.name_ru || '»' || case when cu.started then '' else ' — нужен до таможенного оформления' end,
             null, null, null, null, dt.code, dt.name_ru, null)
    from req rq
    join public.document_types dt on dt.id = rq.document_type_id
    cross join customs cu
    where rq.applies_to = 'shipment'
      and not exists (select 1 from linked where linked.document_type_id = rq.document_type_id)

    -- Mandatory documents of every vehicle. A shipment document counts when there is one vehicle.
    union all
    select private.document_check_finding('document_missing',
             case when tc.started then 'error' else 'warning' end,
             'Нет обязательного документа «' || dt.name_ru || '» для автомобиля №' || t.sequence_no
               || case when tc.started then '' else ' — нужен до таможенного оформления' end,
             t.id, t.sequence_no, null, null, dt.code, dt.name_ru, null)
    from req rq
    join public.document_types dt on dt.id = rq.document_type_id
    cross join tr t
    cross join s
    cross join vehicles v
    cross join lateral (
      select s.shipment_at_customs or t.status in ('at_customs', 'arrived', 'unloaded')
             or exists (select 1 from customs_runs cr where cr.shipment_transport_id is null or cr.shipment_transport_id = t.id)
             or exists (select 1 from public.shipment_stage_runs run
                        where run.shipment_id = p_shipment_id and run.stage_id = any(rq.stage_ids)
                          and (run.shipment_transport_id is null or run.shipment_transport_id = t.id)
                          and run.status in ('in_progress', 'completed')) as started
    ) tc
    where rq.applies_to = 'shipment_transport'
      and not exists (select 1 from linked
                      where linked.document_type_id = rq.document_type_id
                        and ((linked.entity_type = 'shipment_transport' and linked.entity_id = t.id)
                             or (linked.entity_type = 'shipment' and v.n = 1)))

    -- Documents that have expired or expire before the planned arrival (only until the cargo arrives).
    union all
    select private.document_check_finding(
             case when x.valid_until < p_today then 'document_expired' else 'document_expires_before_arrival' end, 'error',
             case when x.valid_until < p_today then 'Срок действия документа истёк'
                  else 'Срок действия документа закончится до планового прибытия' end,
             null, null, x.id, x.title, 'valid_until', x.valid_until::text, x.arrival::text)
    from (
      select ln.id, ln.title, ln.valid_until,
             max(case when ln.entity_type = 'shipment_transport' then coalesce(t.planned_arrival_date, s.planned_arrival_date)
                      else s.planned_arrival_date end) as arrival,
             bool_and(ln.entity_type = 'shipment_transport' and t.status in ('arrived', 'unloaded')) as all_arrived
      from linked ln
      cross join s
      left join tr t on ln.entity_type = 'shipment_transport' and t.id = ln.entity_id
      where ln.valid_until is not null
      group by ln.id, ln.title, ln.valid_until
    ) x
    cross join s
    where s.pre_arrival and not x.all_arrived
      and (x.valid_until < p_today or (x.arrival is not null and x.valid_until < x.arrival))

    -- The supply contract of the shipment.
    union all
    select private.document_check_finding(
             case when c.valid_to < p_today then 'contract_expired' else 'contract_expires_before_arrival' end, 'error',
             case when c.valid_to < p_today then 'Договор поставки истёк'
                  else 'Договор поставки закончится до планового прибытия' end,
             null, null, null, null, 'contract_valid_to', c.valid_to::text, s.planned_arrival_date::text)
    from s
    join public.contracts c on c.id = s.contract_id
    where s.pre_arrival and c.valid_to is not null
      and (c.valid_to < p_today or (s.planned_arrival_date is not null and c.valid_to < s.planned_arrival_date))
  ), unique_findings as (
    select distinct on (f ->> 'key') f from findings order by f ->> 'key'
  )
  select coalesce(jsonb_agg(f order by case f ->> 'severity' when 'error' then 0 else 1 end,
                                       (f ->> 'transport_no')::integer nulls first, f ->> 'code', f ->> 'key'), '[]'::jsonb)
  from unique_findings
$$;

-- 3. Run and notify -------------------------------------------------------------------------------

-- Checks one shipment, stores the result and notifies about problems not reported yet. A problem is
-- reported once; when it is fixed and appears again, it is reported again.
create or replace function private.refresh_document_check(p_shipment_id uuid, p_source text, p_today date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number text;
  v_findings jsonb;
  v_keys text[];
  v_previous text[];
  v_new text[];
  v_errors integer;
  v_warnings integer;
  v_status text;
  v_title text;
  v_body text;
  v_recipient uuid;
begin
  select shipment_number into v_number from public.shipments where id = p_shipment_id;
  if not found then
    return null;
  end if;
  v_findings := private.document_check_findings(p_shipment_id, p_today);
  select coalesce(array_agg(f ->> 'key' order by f ->> 'key'), '{}'),
         count(*) filter (where f ->> 'severity' = 'error'),
         count(*) filter (where f ->> 'severity' = 'warning')
    into v_keys, v_errors, v_warnings
  from jsonb_array_elements(v_findings) f;
  v_status := case when v_errors > 0 then 'error' when v_warnings > 0 then 'warning' else 'ok' end;

  -- One run per shipment at a time: the row lock orders concurrent runs.
  insert into public.shipment_document_checks (shipment_id, status, source)
  values (p_shipment_id, 'ok', p_source)
  on conflict (shipment_id) do nothing;
  select notified_keys into v_previous from public.shipment_document_checks where shipment_id = p_shipment_id for update;
  v_new := array(select unnest(v_keys) except select unnest(v_previous) order by 1);

  update public.shipment_document_checks
  set status = v_status, error_count = v_errors, warning_count = v_warnings, notified_keys = v_keys,
      source = p_source, checked_at = now()
  where shipment_id = p_shipment_id;

  if cardinality(v_new) > 0 then
    v_title := 'Проверка документов ' || v_number || ': '
      || case when v_errors > 0 then 'найдены ошибки' else 'есть замечания' end;
    -- Only the kind of problem goes into the text: plates, weights and document names stay in the card.
    select 'Ошибок: ' || v_errors || ', предупреждений: ' || v_warnings || '. Новое: '
           || string_agg(m, '; ' order by m) || case when count(*) < cardinality(v_new) then '; …' else '' end
      into v_body
    from (
      select distinct f ->> 'message' as m
      from jsonb_array_elements(v_findings) f
      where f ->> 'key' = any(v_new)
      limit 3
    ) messages;
    for v_recipient in
      select distinct ur.user_id
      from public.user_roles ur
      join public.app_roles r on r.id = ur.role_id
      where r.code = any(private.document_check_recipient_roles())
    loop
      -- user_has_permission() also requires an active employee.
      if private.user_has_permission(v_recipient, 'shipments.view') and private.user_has_permission(v_recipient, 'documents.view') then
        perform private.notify(v_recipient, 'discrepancy', v_title, v_body, 'shipment_document_check', p_shipment_id, p_shipment_id,
                               -- Repeats are prevented by notified_keys under the row lock; the key only keeps
                               -- one event from being stored twice for a recipient.
                               'document_check:' || p_shipment_id || ':' || md5(array_to_string(v_new, '|') || '@' || clock_timestamp()::text));
      end if;
    end loop;
  end if;
  return v_findings;
end;
$$;

create or replace function private.document_check_today()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone 'Asia/Qyzylorda')::date
$$;

-- Removes document names and ids of documents the employee may not open (generated documents with
-- prices), so the check never discloses more than the document register.
create or replace function private.document_check_visible(p_findings jsonb)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(
           case when f ? 'document_id' and not private.can_view_generated_document((f ->> 'document_id')::uuid)
                then f - 'document_id' - 'document_title' - 'document_value' - 'card_value'
                else f end
           order by n), '[]'::jsonb)
  from jsonb_array_elements(p_findings) with ordinality as e(f, n)
$$;

-- 4. Functions for the application ----------------------------------------------------------------

-- Current findings for the shipment card. Reads only; needs shipments.view and documents.view.
create or replace function public.shipment_document_check(p_shipment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_check public.shipment_document_checks%rowtype;
begin
  if not (select private.has_permission('shipments.view')) or not (select private.has_permission('documents.view')) then
    raise exception 'Нет доступа к поставке или документам' using errcode = '42501';
  end if;
  if not exists (select 1 from public.shipments where id = p_shipment_id) then
    raise exception 'Поставка не найдена';
  end if;
  select * into v_check from public.shipment_document_checks where shipment_id = p_shipment_id;
  return jsonb_build_object(
    'findings', private.document_check_visible(private.document_check_findings(p_shipment_id, private.document_check_today())),
    'last_run_at', v_check.checked_at,
    'last_run_source', v_check.source);
end;
$$;

-- Runs the check now and notifies about new problems: after recognition, confirmation or on request.
create or replace function public.run_shipment_document_check(p_shipment_id uuid, p_source text default 'recognition')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select private.has_permission('shipments.view')) or not (select private.has_permission('documents.view')) then
    raise exception 'Нет доступа к поставке или документам' using errcode = '42501';
  end if;
  if not exists (select 1 from public.shipments where id = p_shipment_id) then
    raise exception 'Поставка не найдена';
  end if;
  if p_source is null or p_source not in ('recognition', 'manual') then
    raise exception 'Недопустимый источник проверки';
  end if;
  return private.document_check_visible(private.refresh_document_check(p_shipment_id, p_source, private.document_check_today()));
end;
$$;

-- Daily run over every active shipment, for a scheduled job (pg_cron in the database or a server job
-- with the secret key). Returns the number of checked shipments.
create or replace function public.run_document_checks(p_today date default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := coalesce(p_today, private.document_check_today());
  v_shipment uuid;
  v_count integer := 0;
begin
  for v_shipment in
    select id from public.shipments where status not in ('closed', 'cancelled') order by created_at
  loop
    perform private.refresh_document_check(v_shipment, 'daily', v_today);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- 5. Privileges ------------------------------------------------------------------------------------

revoke all on function private.document_check_recipient_roles() from public, anon, authenticated, service_role;
revoke all on function private.document_check_weight_tolerance(numeric) from public, anon, authenticated, service_role;
revoke all on function private.document_check_key(text) from public, anon, authenticated, service_role;
revoke all on function private.document_check_number(text) from public, anon, authenticated, service_role;
revoke all on function private.document_check_finding(text, text, text, uuid, integer, uuid, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function private.document_check_load(uuid) from public, anon, authenticated, service_role;
revoke all on function private.document_check_kg(numeric) from public, anon, authenticated, service_role;
revoke all on function private.document_check_findings(uuid, date) from public, anon, authenticated, service_role;
revoke all on function private.refresh_document_check(uuid, text, date) from public, anon, authenticated, service_role;
revoke all on function private.document_check_today() from public, anon, authenticated, service_role;
revoke all on function private.document_check_visible(jsonb) from public, anon, authenticated, service_role;

revoke all on function public.shipment_document_check(uuid) from public, anon, service_role;
grant execute on function public.shipment_document_check(uuid) to authenticated;
revoke all on function public.run_shipment_document_check(uuid, text) from public, anon, service_role;
grant execute on function public.run_shipment_document_check(uuid, text) to authenticated;
revoke all on function public.run_document_checks(date) from public, anon, authenticated;
grant execute on function public.run_document_checks(date) to service_role;

comment on function public.shipment_document_check(uuid) is
  'Document check agent: current findings for one shipment (plates, weights, numbers, mandatory documents, expiry); read only';
comment on function public.run_shipment_document_check(uuid, text) is
  'Document check agent: checks one shipment now and notifies administrators, directors and logistics about new problems';
comment on function public.run_document_checks(date) is
  'Document check agent: daily run over all active shipments; service_role only (pg_cron or a server job)';
