-- Phase 9G: OCR for scanned and photographed source documents.
--
-- The review principle is unchanged: upload -> recognition -> classification -> employee review ->
-- confirmation -> application to the shipment. OCR only ever produces proposals:
--   * it can write 'extracted' / 'needs_review' / 'failed' rows, never 'confirmed';
--   * it never touches shipments or transports (that stays in review_shipment_source_extraction);
--   * sending a document to an OCR provider needs its own permission, source_documents.ocr.
-- Re-running is idempotent: the same document bytes + provider + provider version reuse the stored
-- result, a running job holds a lease, and failed jobs stop after a bounded number of attempts.

insert into public.permissions(code,module,action,name,description) values
 ('source_documents.ocr','source_documents','ocr','Исходные документы: OCR','Передача сканов и фотографий документов поставки провайдеру распознавания текста')
on conflict(code) do update set module=excluded.module,action=excluded.action,name=excluded.name,description=excluded.description;

insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true from public.app_roles r cross join public.permissions p
where p.code='source_documents.ocr' and r.code in (
 'director','executive_director','commercial_director','logistics_director',
 'senior_logistics_manager','logistics_specialist','administrator'
)
on conflict(role_id,permission_id) do update set granted=true;

alter table public.shipment_source_extractions
 add column if not exists extraction_method text not null default 'text_layer',
 add column if not exists ocr_provider text,
 add column if not exists ocr_provider_version text,
 add column if not exists source_sha256 text,
 add column if not exists attempt_count integer not null default 0,
 add column if not exists ocr_page_count integer,
 add column if not exists ocr_confidence numeric(4,3),
 add column if not exists processing_started_at timestamptz,
 add column if not exists processing_finished_at timestamptz,
 add column if not exists processing_ms integer;

alter table public.shipment_source_extractions drop constraint if exists shipment_source_extractions_method_check;
alter table public.shipment_source_extractions add constraint shipment_source_extractions_method_check check(
 extraction_method in ('text_layer','ocr')
 and (extraction_method='ocr' or (ocr_provider is null and ocr_provider_version is null))
 and (ocr_provider is null or length(ocr_provider) between 1 and 40)
 and (ocr_provider_version is null or length(ocr_provider_version) between 1 and 80)
 and (source_sha256 is null or source_sha256 ~ '^[0-9a-f]{64}$')
 and attempt_count between 0 and 100
 and (ocr_page_count is null or ocr_page_count between 0 and 100)
 and (ocr_confidence is null or ocr_confidence between 0 and 1)
 and (processing_ms is null or processing_ms>=0)
);

-- Text-layer recognition: same behaviour as before, minus two holes that matter once OCR exists.
-- A caller can no longer write a 'confirmed' row directly (confirmation is review_shipment_source_extraction),
-- and re-running recognition on a version that an employee already confirmed leaves it untouched.
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

-- Claims one OCR job. Returns {action: run|reuse|busy|exhausted, extraction_id, attempt}.
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

 update public.shipment_source_extractions set status='superseded',updated_at=now()
 where shipment_id=p_shipment_id and document_id=p_document_id and document_version_id<>p_document_version_id and status<>'superseded';

 select * into e from public.shipment_source_extractions where shipment_id=p_shipment_id and document_version_id=p_document_version_id for update;
 if found then
  v_same:=e.extraction_method='ocr' and e.source_sha256=p_source_sha256 and e.ocr_provider=p_provider and e.ocr_provider_version=p_provider_version;
  if e.status='confirmed' then return jsonb_build_object('action','reuse','extraction_id',e.id,'status',e.status);end if;
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

-- Stores the outcome of the job started by begin_shipment_source_ocr. Only the user who holds the
-- lease can finish it, and only while the row is still pending; 'confirmed' is not a possible result.
create or replace function public.finish_shipment_source_ocr(
 p_extraction_id uuid,p_status text,p_extracted_data jsonb default '{}'::jsonb,p_field_evidence jsonb default '{}'::jsonb,
 p_conflicts jsonb default '[]'::jsonb,p_error_message text default null,p_extractor_version text default 'ocr-v1',
 p_page_count integer default null,p_processing_ms integer default null,p_confidence numeric default null,p_source_kind text default null
) returns uuid
language plpgsql security definer set search_path=''
as $$
declare v_id uuid;v_user uuid:=(select auth.uid());
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

revoke all on function public.upsert_shipment_source_extraction(uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb,text,text) from public,anon,service_role;
grant execute on function public.upsert_shipment_source_extraction(uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb,text,text) to authenticated;
revoke all on function public.begin_shipment_source_ocr(uuid,uuid,uuid,text,text,text,text,integer,integer,boolean) from public,anon,service_role;
grant execute on function public.begin_shipment_source_ocr(uuid,uuid,uuid,text,text,text,text,integer,integer,boolean) to authenticated;
revoke all on function public.finish_shipment_source_ocr(uuid,text,jsonb,jsonb,jsonb,text,text,integer,integer,numeric,text) from public,anon,service_role;
grant execute on function public.finish_shipment_source_ocr(uuid,text,jsonb,jsonb,jsonb,text,text,integer,integer,numeric,text) to authenticated;

comment on function public.begin_shipment_source_ocr(uuid,uuid,uuid,text,text,text,text,integer,integer,boolean) is
 'Claims an idempotent OCR job (reuse, busy lease, bounded attempts) after permission, link and checksum checks';
comment on function public.finish_shipment_source_ocr(uuid,text,jsonb,jsonb,jsonb,text,text,integer,integer,numeric,text) is
 'Stores an OCR proposal for employee review; never confirms and never changes the shipment';
