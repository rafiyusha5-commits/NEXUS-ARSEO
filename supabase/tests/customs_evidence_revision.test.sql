\set ON_ERROR_STOP 1
begin;
\ir fixtures/source_integrity.sql
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',false);
update public.shipment_source_extractions set source_kind='other',status='needs_review',extraction_method='text_layer',
 extracted_data='{"customs_record":{"kind":"declaration","fields":[{"label":"Номер","value":"TEST"}],"expectedCount":1,"items":[{"number":1,"sku":"DQ-001","quantity":10,"unit":"piece","hsCode":"1806310000","description":"Goods","amount":100,"grossKg":10,"netKg":9,"customsValue":1000}],"warnings":[]}}',
 confirmed_data='{"invoice_number":"MANUAL-KEEP"}',reviewed_by=null,reviewed_at=null
 where id='eb603000-0000-4000-8000-000000000001';
create function pg_temp.revise(p_updated timestamptz,p_request uuid,p_record jsonb,p_reason text default 'Повторное чтение после исправления разбора') returns uuid language sql as $$
 select public.revise_shipment_customs_evidence('eb300000-0000-4000-8000-000000000001','eb603000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000001',p_updated,p_request,p_record,p_reason)
$$;
grant execute on function pg_temp.revise(timestamptz,uuid,jsonb,text) to authenticated;
do $$ declare old_record jsonb; new_record jsonb; stamp timestamptz; denied boolean; perm text; e public.shipment_source_extractions%rowtype; begin
 select * into e from public.shipment_source_extractions where id='eb603000-0000-4000-8000-000000000001';
 old_record:=e.extracted_data->'customs_record';
 perform public.review_shipment_customs_evidence(e.shipment_id,e.id,e.document_version_id,old_record,'Ручная сверка первой редакции');
 select * into e from public.shipment_source_extractions where id=e.id;
 stamp:=e.updated_at; new_record:=jsonb_set(old_record,'{items,0,quantity}','11');
 foreach perm in array array['source_documents.extract','source_documents.review','shipments.view','documents.view'] loop
  insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
   select 'eb000000-0000-4000-8000-000000000001',id,'deny','Revision test','eb000000-0000-4000-8000-000000000001' from public.permissions where code=perm;
  denied:=false;
  begin perform pg_temp.revise(stamp,'b9900000-0000-4000-8000-000000000001',new_record); exception when insufficient_privilege then denied:=true; end;
  assert denied,'personal deny ignored: '||perm;
  delete from public.user_permission_overrides where user_id='eb000000-0000-4000-8000-000000000001' and permission_id=(select id from public.permissions where code=perm);
 end loop;
 denied:=false;
 begin perform pg_temp.revise(stamp-interval '1 second','b9900000-0000-4000-8000-000000000001',new_record); exception when others then denied:=true; end;
 assert denied,'stale page accepted';
 perform pg_temp.revise(stamp,'b9900000-0000-4000-8000-000000000001',new_record);
 select * into e from public.shipment_source_extractions where id=e.id;
 assert e.status='needs_review' and e.reviewed_at is null and e.confirmed_data->>'invoice_number'='MANUAL-KEEP','revision lost manual fields or remained confirmed';
 assert not(e.confirmed_data ? 'customs_record') and e.extracted_data->'customs_record'=new_record,'new record not awaiting confirmation';
 assert exists(select 1 from public.audit_log where entity_type='shipment_source_extractions' and entity_id=e.id::text
  and before_data#>>'{confirmed_data,customs_review_note}'='Ручная сверка первой редакции'
  and after_data#>>'{extracted_data,customs_revision,reason}'='Повторное чтение после исправления разбора'),'audit lost previous review';
 perform public.review_shipment_customs_evidence(e.shipment_id,e.id,e.document_version_id,new_record,'Новая редакция проверена по оригиналу');
 perform pg_temp.revise(stamp,'b9900000-0000-4000-8000-000000000001',new_record);
 assert (select status='confirmed' from public.shipment_source_extractions where id=e.id),'retry reset later confirmation';
 denied:=false;
 begin perform pg_temp.revise(stamp,'b9900000-0000-4000-8000-000000000001',old_record); exception when others then denied:=true; end;
 assert denied,'same request with changed data accepted';
 update public.document_links set removed_at=now(),removed_by='eb000000-0000-4000-8000-000000000001' where document_id=e.document_id;
 denied:=false;
 begin perform pg_temp.revise(stamp,'b9900000-0000-4000-8000-000000000001',new_record); exception when others then denied:=true; end;
 assert denied,'detached document retry accepted';
end $$;
rollback;
