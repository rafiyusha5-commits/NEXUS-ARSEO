-- Separate purchase/sale pallet tare per vehicle. No business rows or confirmed sources are rewritten.
alter table public.shipment_transports add column if not exists purchase_pallet_tare_kg numeric;
alter table public.shipment_transports add column if not exists sale_pallet_tare_kg numeric;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.shipment_transports'::regclass and conname='transport_pallet_tare_range') then
  alter table public.shipment_transports add constraint transport_pallet_tare_range check (
   (purchase_pallet_tare_kg is null or (purchase_pallet_tare_kg >= 20 and purchase_pallet_tare_kg <= 25 and purchase_pallet_tare_kg=round(purchase_pallet_tare_kg,2))) and
   (sale_pallet_tare_kg is null or (sale_pallet_tare_kg >= 20 and sale_pallet_tare_kg <= 25 and sale_pallet_tare_kg=round(sale_pallet_tare_kg,2))));
 end if;
end $$;
comment on column public.shipment_transports.purchase_pallet_tare_kg is 'Empty pallet kg for purchase/import, per vehicle, explicit 20–25. NULL means not confirmed.';
comment on column public.shipment_transports.sale_pallet_tare_kg is 'Empty pallet kg for sale/export, independent of purchase. Does not establish an actual sale or receipt.';

create or replace function public.update_shipment_transport(p_transport_id uuid,p_changes jsonb) returns void
language plpgsql security definer set search_path=''
as $$
declare
 t public.shipment_transports%rowtype;s public.shipments%rowtype;v_key text;v_value jsonb;
 v_allowed constant text[]:=array['planned_loading_date','planned_arrival_date','temperature_setpoint','notes','driver_name','driver_phone','driver_document','vehicle_plate','vehicle_make','trailer_plate','trailer_make','carrier_name','purchase_pallet_tare_kg','sale_pallet_tare_kg'];
 v_text text;v_plate text;v_carrier_name text;v_vehicle uuid;v_carrier uuid;v_loading date;v_arrival date;
begin
 if not private.can_write_shipments('update') then raise exception 'Недостаточно прав для изменения перевозки' using errcode='42501';end if;
 if jsonb_typeof(coalesce(p_changes,'{}'::jsonb))<>'object' or p_changes='{}'::jsonb then raise exception 'Укажите, что изменить';end if;
 select * into t from public.shipment_transports where id=p_transport_id for update;
 if not found then raise exception 'Автомобиль не найден';end if;
 select * into s from public.shipments where id=t.shipment_id for update;
 if s.is_locked or s.status in ('on_hold','cancelled','closed') then raise exception 'Поставка в статусе "%" недоступна для изменений',s.status;end if;
 if t.status='cancelled' then raise exception 'Отменённый автомобиль изменять нельзя';end if;
 for v_key,v_value in select key,value from jsonb_each(p_changes) loop
  if not(v_key=any(v_allowed)) then raise exception 'Недопустимое поле автомобиля: %',v_key;end if;
  if jsonb_typeof(v_value) not in('string','null') then raise exception 'Некорректное значение поля %',v_key;end if;
 end loop;
 v_loading:=case when p_changes?'planned_loading_date' then nullif(p_changes->>'planned_loading_date','')::date else t.planned_loading_date end;
 v_arrival:=case when p_changes?'planned_arrival_date' then nullif(p_changes->>'planned_arrival_date','')::date else t.planned_arrival_date end;
 if v_loading is not null and v_arrival is not null and v_arrival<v_loading then raise exception 'Плановое прибытие раньше плановой загрузки';end if;
 v_plate:=case when p_changes?'vehicle_plate' then private.clean_transport_text(p_changes->>'vehicle_plate',40,'Госномер автомобиля') else t.vehicle_plate end;
 v_carrier_name:=case when p_changes?'carrier_name' then private.clean_transport_text(p_changes->>'carrier_name',200,'Перевозчик') else t.carrier_name end;
 if v_plate is not null and exists(select 1 from public.shipment_transports o where o.shipment_id=t.shipment_id and o.id<>t.id and o.status<>'cancelled' and private.normalize_plate(o.vehicle_plate)=private.normalize_plate(v_plate)) then
  raise exception 'Автомобиль с госномером % уже есть в этой поставке',v_plate;
 end if;
 if p_changes?'vehicle_plate' or p_changes?'carrier_name' then
  select r.o_vehicle,r.o_carrier into v_vehicle,v_carrier from private.resolve_transport_links(v_plate,v_carrier_name) r;
 else v_vehicle:=t.vehicle_id;v_carrier:=t.carrier_id;end if;
 -- Weight-only retries do not create audit duplicates. NULL is allowed only explicitly; normal UI requires a weight.
 if p_changes - 'purchase_pallet_tare_kg' - 'sale_pallet_tare_kg' = '{}'::jsonb
 and (not p_changes ? 'purchase_pallet_tare_kg' or nullif(p_changes->>'purchase_pallet_tare_kg','')::numeric is not distinct from t.purchase_pallet_tare_kg)
 and (not p_changes ? 'sale_pallet_tare_kg' or nullif(p_changes->>'sale_pallet_tare_kg','')::numeric is not distinct from t.sale_pallet_tare_kg) then return; end if;
 update public.shipment_transports set
  purchase_pallet_tare_kg=case when p_changes?'purchase_pallet_tare_kg' then nullif(p_changes->>'purchase_pallet_tare_kg','')::numeric else purchase_pallet_tare_kg end,
  sale_pallet_tare_kg=case when p_changes?'sale_pallet_tare_kg' then nullif(p_changes->>'sale_pallet_tare_kg','')::numeric else sale_pallet_tare_kg end,
  planned_loading_date=v_loading,planned_arrival_date=v_arrival,
  temperature_setpoint=case when p_changes?'temperature_setpoint' then private.clean_transport_text(p_changes->>'temperature_setpoint',50,'Температурный режим') else temperature_setpoint end,
  notes=case when p_changes?'notes' then private.clean_transport_text(p_changes->>'notes',500,'Примечание') else notes end,
  driver_name=case when p_changes?'driver_name' then private.clean_transport_text(p_changes->>'driver_name',200,'Водитель') else driver_name end,
  driver_phone=case when p_changes?'driver_phone' then private.clean_transport_text(p_changes->>'driver_phone',60,'Телефон водителя') else driver_phone end,
  driver_document=case when p_changes?'driver_document' then private.clean_transport_text(p_changes->>'driver_document',250,'Документ водителя') else driver_document end,
  vehicle_plate=v_plate,
  vehicle_make=case when p_changes?'vehicle_make' then private.clean_transport_text(p_changes->>'vehicle_make',80,'Марка автомобиля') else vehicle_make end,
  trailer_plate=case when p_changes?'trailer_plate' then private.clean_transport_text(p_changes->>'trailer_plate',40,'Госномер прицепа') else trailer_plate end,
  trailer_make=case when p_changes?'trailer_make' then private.clean_transport_text(p_changes->>'trailer_make',80,'Марка прицепа') else trailer_make end,
  carrier_name=v_carrier_name,vehicle_id=v_vehicle,carrier_id=coalesce(v_carrier,case when p_changes?'carrier_name' or p_changes?'vehicle_plate' then null else carrier_id end),updated_at=now()
 where id=t.id;
end $$;

-- Full gross uses carton gross and empty pallets once; incomplete/fractional pallet data stays unknown.
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
           pl.units_per_parent as pl_f,
           case when sh.type='export' then tr.sale_pallet_tare_kg else tr.purchase_pallet_tare_kg end as tare
    from public.shipment_items i
    join public.shipments sh on sh.id=i.shipment_id
    left join public.shipment_transports tr on tr.id=i.shipment_transport_id and tr.shipment_id=i.shipment_id and tr.status<>'cancelled' 
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
           case when p.bx_g>0 and p.bx_f>0 and p.pl_f>0 and p.tare is not null
                     and p.pcs/p.pl_f=trunc(p.pcs/p.pl_f)
                then p.pcs/p.bx_f*p.bx_g + p.pcs/p.pl_f*p.tare end as gross,
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

create or replace function private.validate_customs_evidence(p jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare item jsonb; field jsonb; k text; n numeric; seen numeric[]:='{}'; total int; required_label text;
begin
 if jsonb_typeof(p)='object' and p->>'kind' in ('value_declaration','transit') then
  if jsonb_typeof(p->'fields') is distinct from 'array' then raise exception 'Нет реквизитов таможенного документа'; end if;
  if jsonb_array_length(p->'fields') not between 2 and 100 then raise exception 'Проверьте состав реквизитов таможенного документа'; end if;
  for field in select value from jsonb_array_elements(p->'fields') loop
   if jsonb_typeof(field) is distinct from 'object' or jsonb_typeof(field->'label') is distinct from 'string'
    or jsonb_typeof(field->'value') is distinct from 'string' or coalesce(length(btrim(field->>'label')),0) not between 1 and 200
    or coalesce(length(btrim(field->>'value')),0) not between 1 and 2000 then raise exception 'Некорректный реквизит таможенного документа'; end if;
  end loop;
  foreach required_label in array case when p->>'kind'='value_declaration'
    then array['Форма','Связанная декларация','Ссылка на счёт (гр. 4)','Курс пересчёта в форме']
    else array['Форма','Ссылка на CMR (гр. 44)','Ссылка на счёт (гр. 44)','Стоимость по счёту (гр. 22)'] end loop
   if not exists(select 1 from jsonb_array_elements(p->'fields') f where f->>'label'=required_label) then
    raise exception 'Не прочитано обязательное поле: %',required_label;
   end if;
  end loop;
  if p ? 'warnings' then
   if jsonb_typeof(p->'warnings') is distinct from 'array' then raise exception 'Некорректные предупреждения'; end if;
   if exists(select 1 from jsonb_array_elements(p->'warnings') w where jsonb_typeof(w)<>'string') then raise exception 'Некорректные предупреждения'; end if;
  end if;
  -- These records confirm only header evidence. Do not accept purported commodity rows without the DT validator.
  if p ? 'items' or p ? 'expectedCount' then raise exception 'Товарные строки подтверждаются через таможенную декларацию'; end if;
  return;
 end if;
 if jsonb_typeof(p) is distinct from 'object' or p->>'kind' is distinct from 'declaration'
 or jsonb_typeof(p->'fields') is distinct from 'array' or jsonb_typeof(p->'items') is distinct from 'array' then
  raise exception 'Нет реквизитов и товарных строк декларации';
 end if;
 total:=jsonb_array_length(p->'items');
 if total not between 1 and 2000 or jsonb_typeof(p->'expectedCount') is distinct from 'number'
 or (p->>'expectedCount')::numeric<>total or jsonb_array_length(p->'fields')=0 then
  raise exception 'Не все товарные строки декларации прочитаны';
 end if;
 for field in select value from jsonb_array_elements(p->'fields') loop
  if jsonb_typeof(field) is distinct from 'object'
  or jsonb_typeof(field->'label') is distinct from 'string' or nullif(btrim(field->>'label'),'') is null
  or jsonb_typeof(field->'value') is distinct from 'string' or nullif(btrim(field->>'value'),'') is null then
   raise exception 'Некорректный реквизит декларации';
  end if;
 end loop;
 if p ? 'warnings' then
  if jsonb_typeof(p->'warnings') is distinct from 'array' then raise exception 'Некорректные предупреждения декларации'; end if;
  if exists(select 1 from jsonb_array_elements(p->'warnings') w where jsonb_typeof(w)<>'string') then raise exception 'Некорректные предупреждения декларации'; end if;
 end if;
 for item in select value from jsonb_array_elements(p->'items') loop
  if jsonb_typeof(item) is distinct from 'object' then raise exception 'Некорректная товарная строка'; end if;
  foreach k in array array['sku','hsCode','unit','description'] loop
   if jsonb_typeof(item->k) is distinct from 'string' or nullif(btrim(item->>k),'') is null then
    raise exception 'В товарной строке не прочитано поле %',k;
   end if;
  end loop;
  if item->>'hsCode' !~ '^[0-9]{10}$' or regexp_replace(lower(btrim(item->>'unit')),'\.$','') not in
   ('шт','штук','штука','штуки','piece','pieces','pcs','pc','sztuka','szt','кг','kg','кор','короб','коробка','box','boxes','carton','cartons') then
   raise exception 'Проверьте десятизначный код ТН ВЭД и единицу товарной строки';
  end if;
  foreach k in array array['number','quantity','amount','grossKg','netKg','customsValue'] loop
   if jsonb_typeof(item->k) is distinct from 'number' then raise exception 'В товарной строке не прочитано число %',k; end if;
   if (item->>k)::numeric<0 then raise exception 'Отрицательное значение %',k; end if;
  end loop;
  n:=(item->>'number')::numeric;
  if n<>trunc(n) or n<1 or n>total or n=any(seen) then raise exception 'Номера товарных строк должны идти от 1 без повторов и пропусков'; end if;
  seen:=array_append(seen,n);
  if item ? 'warnings' then
   if jsonb_typeof(item->'warnings') is distinct from 'array' then raise exception 'Некорректные предупреждения строки'; end if;
   if exists(select 1 from jsonb_array_elements(item->'warnings') w where jsonb_typeof(w)<>'string') then raise exception 'Некорректные предупреждения строки'; end if;
  end if;
 end loop;
end $$;

create or replace function public.review_shipment_customs_evidence(
 p_shipment_id uuid, p_extraction_id uuid, p_document_version_id uuid,
 p_expected_record jsonb, p_review_note text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare e public.shipment_source_extractions%rowtype; v_record jsonb; v_note text:=btrim(p_review_note); v_item jsonb; v_key text;
begin
 if not (select private.has_permission('source_documents.review'))
 or not (select private.has_permission('shipments.view'))
 or not (select private.has_permission('documents.view')) then
  raise exception 'Недостаточно прав для сверки таможенного документа' using errcode='42501';
 end if;
 if v_note is null or length(v_note) not between 10 and 2000 then
  raise exception 'Опишите результат сверки и оставшиеся расхождения (10–2000 символов)';
 end if;
 select * into e from public.shipment_source_extractions where id=p_extraction_id and shipment_id=p_shipment_id;
 if not found then raise exception 'Результат распознавания не найден'; end if;
 perform private.lock_shipment_source(e.shipment_id,e.document_id,e.document_version_id,e.shipment_transport_id);
 select * into e from public.shipment_source_extractions where id=p_extraction_id and shipment_id=p_shipment_id for update;
 if not found then raise exception 'Результат распознавания не найден'; end if;
 perform private.lock_shipment_source(e.shipment_id,e.document_id,e.document_version_id,e.shipment_transport_id);
 if e.status not in ('extracted','needs_review','confirmed')
 or p_document_version_id is distinct from e.document_version_id then
  raise exception 'Версия или состояние документа изменились. Обновите страницу и повторите сверку';
 end if;
 v_record:=e.extracted_data->'customs_record';
 if v_record is null or v_record is distinct from p_expected_record then
  raise exception 'Результат распознавания изменился. Обновите страницу и повторите сверку';
 end if;
 perform private.validate_customs_evidence(v_record);
 -- Idempotent retries keep the original reviewer/time and do not produce duplicate audit entries.
 if e.status='confirmed' and e.confirmed_data->'customs_record'=v_record
 and e.confirmed_data->>'customs_review_note'=v_note then return e.id; end if;
 update public.shipment_source_extractions set
  status='confirmed', confirmed_data=confirmed_data || jsonb_build_object('customs_record',v_record,'customs_review_note',v_note),
  reviewed_by=(select auth.uid()),reviewed_at=now(),updated_at=now()
 where id=e.id;
 return e.id;
end $$;

create or replace function private.guard_customs_evidence_confirmation() returns trigger
language plpgsql set search_path='' as $$
begin
 if new.status='confirmed' and new.extracted_data#>>'{customs_record,kind}'in ('declaration','value_declaration','transit') then
  perform private.validate_customs_evidence(new.extracted_data->'customs_record');
  if new.confirmed_data->'customs_record' is distinct from new.extracted_data->'customs_record'
  or coalesce(length(btrim(new.confirmed_data->>'customs_review_note')),0) not between 10 and 2000 then
   raise exception 'Подтвердите таможенный документ через сверку с оригиналом';
  end if;
 end if;
 return new;
end $$;
revoke all on function private.validate_customs_evidence(jsonb),private.guard_customs_evidence_confirmation(),private.document_check_load(uuid) from public,anon,authenticated,service_role;
revoke all on function public.update_shipment_transport(uuid,jsonb),public.review_shipment_customs_evidence(uuid,uuid,uuid,jsonb,text) from public,anon,service_role;
grant execute on function public.update_shipment_transport(uuid,jsonb),public.review_shipment_customs_evidence(uuid,uuid,uuid,jsonb,text) to authenticated;
notify pgrst, 'reload schema';
