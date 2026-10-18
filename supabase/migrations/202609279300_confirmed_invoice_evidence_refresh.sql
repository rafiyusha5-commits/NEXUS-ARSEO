-- Refresh supplemental invoice lines while preserving human confirmation. No grants change.
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
 if found and v_existing.status='confirmed' then
  -- Supplemental machine evidence only. Never reset/reconfirm manual fields, reviewer,
  -- transport binding, quantity history or previously extracted scalar requisites.
  -- The current version and active links were locked above. Review permission is mandatory.
  if (select private.has_permission('source_documents.review'))
   and v_existing.source_kind='invoice' and p_source_kind='invoice'
   and v_existing.extraction_method='text_layer' and p_status in ('extracted','needs_review')
   and nullif(btrim(p_error_message),'') is null
   and jsonb_typeof(p_extracted_data->'commodity_invoice')='object'
   and jsonb_typeof(p_extracted_data#>'{commodity_invoice,items}')='array'
   and coalesce(p_extracted_data#>>'{commodity_invoice,number}','')<>''
   and p_extracted_data#>>'{commodity_invoice,number}'=v_existing.confirmed_data->>'invoice_number'
  then
   if jsonb_array_length(p_extracted_data#>'{commodity_invoice,items}')>0
    and v_existing.extracted_data->'commodity_invoice' is distinct from p_extracted_data->'commodity_invoice'
   then
    update public.shipment_source_extractions set
     extracted_data=jsonb_set(extracted_data,'{commodity_invoice}',p_extracted_data->'commodity_invoice'),
     field_evidence=jsonb_set(field_evidence,'{commodity_invoice}',jsonb_build_object(
      'method','text_layer','extractor_version',left(p_extractor_version,80),
      'refreshed_at',now(),'refreshed_by',v_user,'manual_confirmation_preserved',true)),
     updated_at=now()
    where id=v_existing.id;
   end if;
  end if;
  return v_existing.id;
 end if;
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

