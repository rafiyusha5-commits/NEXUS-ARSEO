-- Explicit re-reading of the same source version. audit_log retains the whole previous result.
create or replace function public.revise_shipment_customs_evidence(
 p_shipment_id uuid,p_extraction_id uuid,p_document_version_id uuid,p_expected_updated_at timestamptz,
 p_request_id uuid,p_record jsonb,p_reason text
) returns uuid language plpgsql security definer set search_path='' as $$
declare e public.shipment_source_extractions%rowtype; revision jsonb;
begin
 if not private.has_permission('source_documents.extract') or not private.has_permission('source_documents.review')
 or not private.has_permission('shipments.view') or not private.has_permission('documents.view') then
  raise exception 'Недостаточно прав для новой редакции распознавания' using errcode='42501';
 end if;
 if p_request_id is null or p_reason is null or length(btrim(p_reason)) not between 10 and 2000 then
  raise exception 'Укажите причину новой редакции (10–2000 символов)';
 end if;
 -- Incomplete proposals can be saved for review, but cannot be confirmed by the strict validator.
 if jsonb_typeof(p_record) is distinct from 'object' or p_record->>'kind' is distinct from 'declaration'
 or jsonb_typeof(p_record->'fields') is distinct from 'array' or jsonb_typeof(p_record->'items') is distinct from 'array'
 or pg_column_size(p_record)>786432 then raise exception 'Нет распознанной декларации'; end if;
 select * into e from public.shipment_source_extractions where id=p_extraction_id and shipment_id=p_shipment_id;
 if not found then raise exception 'Результат распознавания не найден'; end if;
 perform private.lock_shipment_source(e.shipment_id,e.document_id,p_document_version_id,e.shipment_transport_id);
 select * into e from public.shipment_source_extractions where id=p_extraction_id and shipment_id=p_shipment_id for update;
 if not found then raise exception 'Результат распознавания не найден'; end if;
 perform private.lock_shipment_source(e.shipment_id,e.document_id,e.document_version_id,e.shipment_transport_id);
 if e.document_version_id is distinct from p_document_version_id or e.extraction_method<>'text_layer'
 or e.extracted_data#>>'{customs_record,kind}' is distinct from 'declaration'
 or e.status not in ('confirmed','needs_review','extracted') then raise exception 'Версия или состояние документа изменились'; end if;
 revision:=e.extracted_data->'customs_revision';
 if revision->>'request_id'=p_request_id::text then
  if e.extracted_data->'customs_record' is distinct from p_record or revision->>'reason' is distinct from btrim(p_reason) then
   raise exception 'Запрос новой редакции уже использован с другими данными';
  end if;
  return e.id;
 end if;
 if e.updated_at is distinct from p_expected_updated_at then raise exception 'Данные изменились. Обновите страницу перед новой редакцией'; end if;
 update public.shipment_source_extractions set
  extracted_data=extracted_data||jsonb_build_object('customs_record',p_record,'customs_revision',
   jsonb_build_object('request_id',p_request_id,'reason',btrim(p_reason),'created_at',clock_timestamp(),'created_by',auth.uid(),
    'previous_reviewed_at',e.reviewed_at,'previous_reviewed_by',e.reviewed_by,'previous_note',e.confirmed_data->>'customs_review_note')),
  confirmed_data=confirmed_data-'customs_record'-'customs_review_note',status='needs_review',
  reviewed_at=null,reviewed_by=null,error_message=null,updated_at=clock_timestamp()
 where id=e.id;
 return e.id;
end $$;
revoke all on function public.revise_shipment_customs_evidence(uuid,uuid,uuid,timestamptz,uuid,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.revise_shipment_customs_evidence(uuid,uuid,uuid,timestamptz,uuid,jsonb,text) to authenticated;
