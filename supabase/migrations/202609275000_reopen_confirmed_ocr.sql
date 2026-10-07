-- A reviewer may withdraw an incorrect OCR confirmation and run the same source again.
-- The forced path only resets the extraction proposal/review metadata. It does not delete documents
-- or blindly roll back shipment fields, which may have been edited by another employee afterwards.

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

comment on function public.begin_shipment_source_ocr(uuid,uuid,uuid,text,text,text,text,integer,integer,boolean) is
 'Claims an idempotent OCR job; a reviewer may force re-recognition and withdraw an incorrect confirmation';
