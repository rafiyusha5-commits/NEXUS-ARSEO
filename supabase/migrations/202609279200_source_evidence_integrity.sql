-- Current source identity is locked before any extraction row: same order as document version updates.
create or replace function private.lock_shipment_source(p_shipment uuid,p_document uuid,p_version uuid,p_transport uuid default null,p_any_vehicle boolean default false)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not private.can_view_generated_document(p_document) then
  raise exception 'Нет доступа к документу' using errcode='42501';
 end if;
 perform 1 from public.documents d where d.id=p_document and d.archived_at is null and d.status<>'rejected' for update;
 if not found then raise exception 'Документ отвязан, отклонён, архивирован или заменён новой версией'; end if;
 perform 1 from public.document_versions v join public.documents d on d.id=v.document_id
 where v.id=p_version and d.id=p_document and v.is_current and v.version_number=d.current_version for share of v;
 if not found then raise exception 'Документ заменён новой версией'; end if;
 if p_transport is not null then
  perform 1 from public.shipment_transports where id=p_transport and shipment_id=p_shipment and status<>'cancelled' for share;
  if not found then raise exception 'Автомобиль источника отменён или относится к другой поставке'; end if;
 end if;
 if p_any_vehicle then
  perform 1 from public.shipment_transports t where t.shipment_id=p_shipment and t.status<>'cancelled'
   and exists(select 1 from public.document_links l where l.document_id=p_document and l.removed_at is null and l.entity_type='shipment_transport' and l.entity_id=t.id)
   order by t.id for share of t;
 end if;
 perform 1 from public.document_links l where l.document_id=p_document and l.removed_at is null
 and ((l.entity_type='shipment' and l.entity_id=p_shipment) or
 (l.entity_type='shipment_transport' and (p_any_vehicle or l.entity_id=p_transport)
 and exists(select 1 from public.shipment_transports t where t.id=l.entity_id and t.shipment_id=p_shipment and t.status<>'cancelled')))
 for share of l;
 if not found then raise exception 'Документ отвязан от поставки или автомобиля'; end if;
end $$;
revoke all on function private.lock_shipment_source(uuid,uuid,uuid,uuid,boolean) from public,anon,authenticated,service_role;


create or replace function public.upsert_shipment_source_extraction(
 p_shipment_id uuid,p_document_id uuid,p_document_version_id uuid,p_source_kind text,p_status text,
 p_extracted_data jsonb default '{}'::jsonb,p_field_evidence jsonb default '{}'::jsonb,
 p_conflicts jsonb default '[]'::jsonb,p_error_message text default null,p_extractor_version text default 'rules-v1'
) returns uuid
language plpgsql security definer set search_path=''
as $$
declare v_id uuid;v_user uuid:=(select auth.uid());v_existing public.shipment_source_extractions%rowtype;
begin
 if not (select private.has_permission('source_documents.extract')) then raise exception 'Нет права распознавать исходные документы';end if;
 if not (select private.has_permission('shipments.view')) or not (select private.has_permission('documents.view')) then raise exception 'Нет доступа к поставке или документам';end if;
 if p_source_kind not in ('invoice','specification','contract','transport_order','vehicle_document','driver_document','waybill','other') then raise exception 'Некорректный вид источника';end if;
 if p_status not in ('extracted','needs_review','failed') then raise exception 'Некорректный статус распознавания';end if;
 if jsonb_typeof(coalesce(p_extracted_data,'{}'::jsonb))<>'object' or jsonb_typeof(coalesce(p_field_evidence,'{}'::jsonb))<>'object' or jsonb_typeof(coalesce(p_conflicts,'[]'::jsonb))<>'array' then raise exception 'Некорректные данные распознавания';end if;
 if pg_column_size(coalesce(p_extracted_data,'{}'::jsonb))+pg_column_size(coalesce(p_field_evidence,'{}'::jsonb))+pg_column_size(coalesce(p_conflicts,'[]'::jsonb))>786432 then raise exception 'Результат распознавания слишком велик';end if;
 if not exists(select 1 from public.document_versions v where v.id=p_document_version_id and v.document_id=p_document_id) then raise exception 'Версия документа не найдена';end if;
 if not exists(
  select 1 from public.document_links l where l.document_id=p_document_id and l.removed_at is null and(
   (l.entity_type='shipment' and l.entity_id=p_shipment_id) or
   (l.entity_type='shipment_transport' and exists(select 1 from public.shipment_transports t where t.id=l.entity_id and t.shipment_id=p_shipment_id))
  )
 ) then raise exception 'Документ не связан с этой поставкой';end if;

 perform private.lock_shipment_source(p_shipment_id,p_document_id,p_document_version_id,null,true);
 update public.shipment_source_extractions set status='superseded',updated_at=now()
 where shipment_id=p_shipment_id and document_id=p_document_id and document_version_id<>p_document_version_id and status<>'superseded';

 select * into v_existing from public.shipment_source_extractions where shipment_id=p_shipment_id and document_version_id=p_document_version_id for update;
 if found and v_existing.status='confirmed' then return v_existing.id;end if;
 if found and v_existing.status='pending' and v_existing.processing_started_at>now()-interval '5 minutes' then return v_existing.id;end if;

 insert into public.shipment_source_extractions(
  shipment_id,document_id,document_version_id,source_kind,status,extracted_data,field_evidence,conflicts,confirmed_data,
  error_message,extractor_version,requested_by,requested_at,updated_at,extraction_method
 ) values(
  p_shipment_id,p_document_id,p_document_version_id,p_source_kind,p_status,coalesce(p_extracted_data,'{}'::jsonb),
  coalesce(p_field_evidence,'{}'::jsonb),coalesce(p_conflicts,'[]'::jsonb),'{}'::jsonb,
  nullif(btrim(p_error_message),''),left(p_extractor_version,80),v_user,now(),now(),'text_layer'
 ) on conflict(shipment_id,document_version_id) do update set
  source_kind=excluded.source_kind,status=excluded.status,extracted_data=excluded.extracted_data,
  field_evidence=excluded.field_evidence,conflicts=excluded.conflicts,confirmed_data='{}'::jsonb,
  error_message=excluded.error_message,extractor_version=excluded.extractor_version,requested_by=excluded.requested_by,
  requested_at=now(),reviewed_by=null,reviewed_at=null,updated_at=now(),
  extraction_method='text_layer',ocr_provider=null,ocr_provider_version=null,source_sha256=null,attempt_count=0,
  ocr_page_count=null,ocr_confidence=null,processing_started_at=null,processing_finished_at=null,processing_ms=null
 returning id into v_id;
 return v_id;
end $$;

create or replace function public.begin_shipment_source_ocr(
 p_shipment_id uuid,p_document_id uuid,p_document_version_id uuid,p_source_kind text,p_source_sha256 text,
 p_provider text,p_provider_version text,p_max_attempts integer default 3,p_lease_seconds integer default 300,p_force boolean default false
) returns jsonb
language plpgsql security definer set search_path=''
as $$
declare v_user uuid:=(select auth.uid());e public.shipment_source_extractions%rowtype;v_same boolean;v_attempt integer;v_id uuid;
begin
 if not (select private.has_permission('source_documents.extract')) then raise exception 'Нет права распознавать исходные документы' using errcode='42501';end if;
 if not (select private.has_permission('source_documents.ocr')) then raise exception 'Нет права передавать документы на OCR' using errcode='42501';end if;
 if not (select private.has_permission('shipments.view')) or not (select private.has_permission('documents.view')) then raise exception 'Нет доступа к поставке или документам' using errcode='42501';end if;
 if p_force and not (select private.has_permission('source_documents.review')) then raise exception 'Повторную обработку вне лимита запускает проверяющий' using errcode='42501';end if;
 if p_source_kind not in ('invoice','specification','contract','transport_order','vehicle_document','driver_document','waybill','other') then raise exception 'Некорректный вид источника';end if;
 if coalesce(p_source_sha256,'')!~'^[0-9a-f]{64}$' then raise exception 'Некорректная контрольная сумма файла';end if;
 if length(coalesce(p_provider,'')) not between 1 and 40 or length(coalesce(p_provider_version,'')) not between 1 and 80 then raise exception 'Некорректный провайдер OCR';end if;
 if p_max_attempts not between 1 and 10 or p_lease_seconds not between 30 and 3600 then raise exception 'Некорректные ограничения обработки';end if;
 if not exists(select 1 from public.document_versions v where v.id=p_document_version_id and v.document_id=p_document_id) then raise exception 'Версия документа не найдена';end if;
 if not exists(
  select 1 from public.document_links l where l.document_id=p_document_id and l.removed_at is null and(
   (l.entity_type='shipment' and l.entity_id=p_shipment_id) or
   (l.entity_type='shipment_transport' and exists(select 1 from public.shipment_transports t where t.id=l.entity_id and t.shipment_id=p_shipment_id))
  )
 ) then raise exception 'Документ не связан с этой поставкой';end if;

 perform private.lock_shipment_source(p_shipment_id,p_document_id,p_document_version_id,null,true);
 update public.shipment_source_extractions set status='superseded',updated_at=now()
 where shipment_id=p_shipment_id and document_id=p_document_id and document_version_id<>p_document_version_id and status<>'superseded';

 select * into e from public.shipment_source_extractions where shipment_id=p_shipment_id and document_version_id=p_document_version_id for update;
 if found then
  v_same:=e.extraction_method='ocr' and e.source_sha256=p_source_sha256 and e.ocr_provider=p_provider and e.ocr_provider_version=p_provider_version;
  if e.status='confirmed' and not p_force then return jsonb_build_object('action','reuse','extraction_id',e.id,'status',e.status);end if;
  if e.status='pending' and e.processing_started_at>now()-make_interval(secs=>p_lease_seconds) then
   return jsonb_build_object('action','busy','extraction_id',e.id,'status',e.status);
  end if;
  if v_same and e.status in ('extracted','needs_review') and not p_force then
   return jsonb_build_object('action','reuse','extraction_id',e.id,'status',e.status);
  end if;
  if v_same and e.status='failed' and e.attempt_count>=p_max_attempts and not p_force then
   return jsonb_build_object('action','exhausted','extraction_id',e.id,'status',e.status,'attempt',e.attempt_count);
  end if;
  v_attempt:=case when v_same and not p_force then e.attempt_count+1 else 1 end;
  update public.shipment_source_extractions set
   status='pending',extraction_method='ocr',ocr_provider=p_provider,ocr_provider_version=p_provider_version,source_sha256=p_source_sha256,
   source_kind=p_source_kind,attempt_count=v_attempt,processing_started_at=now(),processing_finished_at=null,processing_ms=null,
   ocr_page_count=null,ocr_confidence=null,error_message=null,extracted_data='{}'::jsonb,field_evidence='{}'::jsonb,conflicts='[]'::jsonb,confirmed_data='{}'::jsonb,
   extractor_version='ocr-pending',requested_by=v_user,requested_at=now(),reviewed_by=null,reviewed_at=null,updated_at=now()
  where id=e.id returning id into v_id;
 else
  v_attempt:=1;
  insert into public.shipment_source_extractions(
   shipment_id,document_id,document_version_id,source_kind,status,extractor_version,requested_by,requested_at,updated_at,
   extraction_method,ocr_provider,ocr_provider_version,source_sha256,attempt_count,processing_started_at
  ) values(
   p_shipment_id,p_document_id,p_document_version_id,p_source_kind,'pending','ocr-pending',v_user,now(),now(),
   'ocr',p_provider,p_provider_version,p_source_sha256,1,now()
  ) returning id into v_id;
 end if;
 return jsonb_build_object('action','run','extraction_id',v_id,'status','pending','attempt',v_attempt);
end $$;

create or replace function public.finish_shipment_source_ocr(
 p_extraction_id uuid,p_status text,p_extracted_data jsonb default '{}'::jsonb,p_field_evidence jsonb default '{}'::jsonb,
 p_conflicts jsonb default '[]'::jsonb,p_error_message text default null,p_extractor_version text default 'ocr-v1',
 p_page_count integer default null,p_processing_ms integer default null,p_confidence numeric default null,p_source_kind text default null
) returns uuid
language plpgsql security definer set search_path=''
as $$
declare e public.shipment_source_extractions%rowtype;v_id uuid;v_user uuid:=(select auth.uid());
begin
 if not (select private.has_permission('source_documents.extract')) then raise exception 'Нет права распознавать исходные документы' using errcode='42501';end if;
 if not (select private.has_permission('source_documents.ocr')) then raise exception 'Нет права передавать документы на OCR' using errcode='42501';end if;
 if not (select private.has_permission('shipments.view')) or not (select private.has_permission('documents.view')) then raise exception 'Нет доступа к поставке или документам' using errcode='42501';end if;
 if p_status not in ('extracted','needs_review','failed') then raise exception 'Некорректный статус распознавания';end if;
 if jsonb_typeof(coalesce(p_extracted_data,'{}'::jsonb))<>'object' or jsonb_typeof(coalesce(p_field_evidence,'{}'::jsonb))<>'object' or jsonb_typeof(coalesce(p_conflicts,'[]'::jsonb))<>'array' then raise exception 'Некорректные данные распознавания';end if;
 if pg_column_size(coalesce(p_extracted_data,'{}'::jsonb))+pg_column_size(coalesce(p_field_evidence,'{}'::jsonb))+pg_column_size(coalesce(p_conflicts,'[]'::jsonb))>786432 then raise exception 'Результат распознавания слишком велик';end if;
 if p_confidence is not null and p_confidence not between 0 and 1 then raise exception 'Некорректная уверенность распознавания';end if;
 if p_source_kind is not null and p_source_kind not in ('invoice','specification','contract','transport_order','vehicle_document','driver_document','waybill','other') then raise exception 'Некорректный вид источника';end if;
 if p_page_count is not null and p_page_count not between 0 and 100 then raise exception 'Некорректное число страниц';end if;
 if p_processing_ms is not null and p_processing_ms<0 then raise exception 'Некорректное время обработки';end if;
 select * into e from public.shipment_source_extractions where id=p_extraction_id and status='pending' and requested_by=v_user;
 if not found then raise exception 'Распознавание не найдено, уже завершено или запущено другим пользователем';end if;
 perform private.lock_shipment_source(e.shipment_id,e.document_id,e.document_version_id,e.shipment_transport_id,true);
 update public.shipment_source_extractions set
  status=p_status,extracted_data=coalesce(p_extracted_data,'{}'::jsonb),field_evidence=coalesce(p_field_evidence,'{}'::jsonb),
  conflicts=coalesce(p_conflicts,'[]'::jsonb),error_message=nullif(left(btrim(coalesce(p_error_message,'')),2000),''),
  extractor_version=left(p_extractor_version,80),ocr_page_count=p_page_count,ocr_confidence=p_confidence,
  processing_finished_at=now(),processing_ms=p_processing_ms,source_kind=coalesce(p_source_kind,source_kind),updated_at=now()
 where id=p_extraction_id and status='pending' and extraction_method='ocr' and requested_by=v_user
 returning id into v_id;
 if v_id is null then raise exception 'Распознавание не найдено, уже завершено или запущено другим пользователем';end if;
 return v_id;
end $$;

create or replace function public.review_shipment_source_extraction(
 p_extraction_id uuid,p_confirmed_data jsonb,p_apply_to_shipment boolean default true
) returns uuid
language plpgsql security definer set search_path=''
as $$
declare
 e public.shipment_source_extractions%rowtype;s public.shipments%rowtype;t public.shipment_transports%rowtype;
 v_data jsonb:='{}'::jsonb;v_key text;v_value jsonb;v_text text;v_number numeric;v_vehicle uuid;v_carrier uuid;
 v_allowed constant text[]:=array['order_number','invoice_number','contract_number','cmr_number','ttn_number','packing_list_number','waybill_number','esf_number','driver_name','driver_document','driver_phone','vehicle_plate','vehicle_make','trailer_plate','trailer_make','carrier_name','loading_address','unloading_address','seals','temperature_setpoint','pallet_count','gross_weight_kg','net_weight_kg','incoterms','order_date','shipping_date','invoice_date','contract_date',
  'loading_city','loading_country','unloading_country','goods_category','payment_terms','supplier_address','seller_correspondence_address','seller_phone','customer_address','customer_kpp','bank_details','sender_signatory'];
begin
 if not (select private.has_permission('source_documents.review')) then raise exception 'Нет права подтверждать распознанные данные' using errcode='42501';end if;
 if not (select private.has_permission('shipments.view')) or not (select private.has_permission('documents.view')) then raise exception 'Нет доступа к поставке или документам' using errcode='42501';end if;
 select * into e from public.shipment_source_extractions where id=p_extraction_id and status in('extracted','needs_review','confirmed');
 if not found then raise exception 'Результат распознавания не найден или закрыт';end if;
 perform private.lock_shipment_source(e.shipment_id,e.document_id,e.document_version_id,e.shipment_transport_id);
 select * into e from public.shipment_source_extractions where id=p_extraction_id and status in('extracted','needs_review','confirmed') for update;
 if not found then raise exception 'Результат распознавания не найден или закрыт';end if;
 perform private.lock_shipment_source(e.shipment_id,e.document_id,e.document_version_id,e.shipment_transport_id);
 if jsonb_typeof(coalesce(p_confirmed_data,'{}'::jsonb))<>'object' then raise exception 'Подтверждённые данные должны быть объектом';end if;

 for v_key,v_value in select key,value from jsonb_each(coalesce(p_confirmed_data,e.extracted_data)) loop
  if v_key='invoice_items' then continue;end if; -- structured invoice lines are read from the confirmed extraction itself
  if not(v_key=any(v_allowed)) then raise exception 'Недопустимое поле распознавания: %',v_key;end if;
  if jsonb_typeof(v_value) not in('string','number') then raise exception 'Некорректное значение поля %',v_key;end if;
  v_text:=btrim(v_value#>>'{}');
  if v_text='' then continue;end if;
  if length(v_text)>(case when v_key in('loading_address','unloading_address','supplier_address','seller_correspondence_address','customer_address','bank_details') then 500 else 200 end) then raise exception 'Значение поля % слишком длинное',v_key;end if;
  if v_key in('pallet_count','gross_weight_kg','net_weight_kg') then
   begin v_number:=replace(replace(v_text,' ',''),',','.')::numeric;exception when others then raise exception 'Поле % должно быть числом',v_key;end;
   if v_number<0 then raise exception 'Поле % не может быть отрицательным',v_key;end if;
   v_data:=v_data||jsonb_build_object(v_key,v_number);
  elsif v_key in('order_date','shipping_date','invoice_date','contract_date') then
   if v_text!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'Поле % должно быть датой ГГГГ-ММ-ДД',v_key;end if;
   perform v_text::date;v_data:=v_data||jsonb_build_object(v_key,v_text);
  else v_data:=v_data||jsonb_build_object(v_key,v_text);end if;
 end loop;
 if v_data='{}'::jsonb then raise exception 'Укажите хотя бы одно подтверждённое поле';end if;

 select * into s from public.shipments where id=e.shipment_id for update;
 if not found then raise exception 'Поставка не найдена';end if;
 if p_apply_to_shipment then
  if not private.can_write_shipments('update') then raise exception 'Недостаточно прав для заполнения поставки' using errcode='42501';end if;
  if s.is_locked or s.status in('closed','cancelled') then raise exception 'Закрытую или заблокированную поставку нельзя изменить';end if;
  if v_data?'incoterms' then update public.shipments set incoterms=v_data->>'incoterms',updated_at=now() where id=s.id;end if;
  -- The vehicle this document belongs to: the one assigned to the extraction. A shipment with a single active
  -- vehicle needs no assignment. With several vehicles and no assignment nothing can be written safely, so the
  -- employee is asked to choose one instead of the data silently landing on the wrong vehicle.
  if e.shipment_transport_id is not null then
   select * into t from public.shipment_transports where id=e.shipment_transport_id and shipment_id=s.id and status<>'cancelled' for update;
  elsif (select count(*) from public.shipment_transports where shipment_id=s.id and status<>'cancelled')=1 then
   select * into t from public.shipment_transports where shipment_id=s.id and status<>'cancelled' for update;
  elsif (v_data ?| array['driver_name','driver_phone','driver_document','vehicle_plate','vehicle_make','trailer_plate','trailer_make','carrier_name','temperature_setpoint'])
    and exists(select 1 from public.shipment_transports where shipment_id=s.id and status<>'cancelled') then
   raise exception 'В поставке несколько автомобилей: укажите, к какому из них относится документ';
  end if;
  if t.id is not null then
   if v_data?'vehicle_plate' and exists(select 1 from public.shipment_transports o where o.shipment_id=s.id and o.id<>t.id and o.status<>'cancelled' and private.normalize_plate(o.vehicle_plate)=private.normalize_plate(v_data->>'vehicle_plate')) then
    raise exception 'Госномер % уже указан у другого автомобиля поставки',v_data->>'vehicle_plate';
   end if;
   if v_data?'vehicle_plate' or v_data?'carrier_name' then
    select r.o_vehicle,r.o_carrier into v_vehicle,v_carrier from private.resolve_transport_links(v_data->>'vehicle_plate',v_data->>'carrier_name') r;
   end if;
   update public.shipment_transports set
    driver_name=case when v_data?'driver_name' then private.clean_transport_text(v_data->>'driver_name',200,'Водитель') else driver_name end,
    driver_phone=case when v_data?'driver_phone' then private.clean_transport_text(v_data->>'driver_phone',60,'Телефон водителя') else driver_phone end,
    driver_document=case when v_data?'driver_document' then private.clean_transport_text(v_data->>'driver_document',250,'Документ водителя') else driver_document end,
    temperature_setpoint=case when v_data?'temperature_setpoint' then private.clean_transport_text(v_data->>'temperature_setpoint',50,'Температурный режим') else temperature_setpoint end,
    vehicle_plate=case when v_data?'vehicle_plate' then private.clean_transport_text(v_data->>'vehicle_plate',40,'Госномер автомобиля') else vehicle_plate end,
    vehicle_make=case when v_data?'vehicle_make' then private.clean_transport_text(v_data->>'vehicle_make',80,'Марка автомобиля') else vehicle_make end,
    trailer_plate=case when v_data?'trailer_plate' then private.clean_transport_text(v_data->>'trailer_plate',40,'Госномер прицепа') else trailer_plate end,
    trailer_make=case when v_data?'trailer_make' then private.clean_transport_text(v_data->>'trailer_make',80,'Марка прицепа') else trailer_make end,
    carrier_name=case when v_data?'carrier_name' then private.clean_transport_text(v_data->>'carrier_name',200,'Перевозчик') else carrier_name end,
    vehicle_id=coalesce(v_vehicle,vehicle_id),carrier_id=coalesce(v_carrier,carrier_id),updated_at=now()
   where id=t.id;
  end if;
 end if;
 update public.shipment_source_extractions set status='confirmed',confirmed_data=v_data,reviewed_by=(select auth.uid()),reviewed_at=now(),updated_at=now() where id=e.id;
 return e.id;
end $$;

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

  select * into e from public.shipment_source_extractions where id = p_extraction_id;
  if not found then raise exception 'Документ не найден';end if;
  perform private.lock_shipment_source(e.shipment_id,e.document_id,e.document_version_id,e.shipment_transport_id);
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
  ), link_docs as (
    -- Documents with an active link to this shipment or one of its vehicles.
    select distinct l.document_id
    from public.document_links l
    join s on (l.entity_type = 'shipment' and l.entity_id = s.id)
           or (l.entity_type = 'shipment_transport' and l.entity_id in (select tr.id from tr))
    where l.removed_at is null
  ), src as (
    -- Recognition results of the current version of a linked document only: an unlinked document or a
    -- replaced file is not checked with old values.
    select e.document_id, e.source_kind, e.status, e.shipment_transport_id as bound_id,
           coalesce(e.shipment_transport_id, (select single_id from vehicles)) as transport_id,
           d.title, d.document_number,
           case when e.status = 'confirmed' then e.confirmed_data else e.extracted_data end as data
    from public.shipment_source_extractions e
    join s on e.shipment_id = s.id
    join public.documents d on d.id = e.document_id and d.archived_at is null and d.status <> 'rejected'
    join public.document_versions v on v.id = e.document_version_id and v.document_id = e.document_id and v.is_current and v.version_number = d.current_version
    where (e.shipment_transport_id is null or e.shipment_transport_id in (select id from tr)) and e.status in ('extracted', 'needs_review', 'confirmed', 'failed')
      and e.document_id in (select document_id from link_docs)
  ), unread_versions as (
    -- Linked documents recognised before whose current version has no finished recognition yet.
    select d.id, d.title
    from public.documents d
    join public.document_versions v on v.document_id = d.id and v.is_current and v.version_number = d.current_version
    where d.archived_at is null and d.status <> 'rejected' and d.id in (select document_id from link_docs)
      and exists (select 1 from public.shipment_source_extractions e where e.shipment_id = p_shipment_id and e.document_id = d.id)
      and not exists (select 1 from public.shipment_source_extractions e
                      where e.shipment_id = p_shipment_id and e.document_id = d.id and e.document_version_id = v.id
                        and e.status in ('extracted', 'needs_review', 'confirmed', 'failed'))
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
    select private.document_check_finding('document_version_not_read', 'warning',
             'Загружена новая версия документа, она ещё не распознана: данные из неё не сверены', null, null, u.id, u.title)
    from unread_versions u
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

notify pgrst,'reload schema';
