-- Synthetic data only, rolled back. Review must never be a shortcut to stock or financial operations.
\set ON_ERROR_STOP 1
begin;
\ir fixtures/source_integrity.sql
update public.shipment_source_extractions set source_kind='other',status='needs_review',
 extracted_data='{"customs_record":{"kind":"declaration","fields":[{"label":"Номер декларации","value":"TEST/260101/0000001"}],"expectedCount":1,"items":[{"number":1,"sku":"DQ-001","quantity":999,"unit":"piece","hsCode":"1806310000","description":"Synthetic goods","amount":100,"grossKg":10,"netKg":9,"customsValue":1000}],"warnings":[]}}',
 confirmed_data='{"invoice_number":"KEEP"}',reviewed_by=null,reviewed_at=null
 where id='eb603000-0000-4000-8000-000000000001';
create function pg_temp.review_customs(p_record jsonb default null,p_note text default 'Оригинал проверен; расхождение с заказом сохранено') returns uuid language sql as $$
 select public.review_shipment_customs_evidence('eb300000-0000-4000-8000-000000000001','eb603000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000001',
 coalesce(p_record,(select extracted_data->'customs_record' from public.shipment_source_extractions where id='eb603000-0000-4000-8000-000000000001')),p_note);
$$;
create function pg_temp.reject_customs(p_sql text,p_code text default null) returns void language plpgsql as $$
declare before_state jsonb; after_state jsonb; rejected boolean:=false;
begin
 select jsonb_agg(to_jsonb(e) order by id) into before_state from public.shipment_source_extractions e;
 begin execute p_sql; exception when others then
  if p_code is not null and sqlstate<>p_code then raise exception 'Wrong SQLSTATE: %',sqlstate; end if;
  rejected:=true;
 end;
 if not rejected then raise exception 'Invalid review accepted: %',p_sql; end if;
 select jsonb_agg(to_jsonb(e) order by id) into after_state from public.shipment_source_extractions e;
 if before_state is distinct from after_state then raise exception 'Rejected review wrote data'; end if;
end $$;
grant execute on function pg_temp.review_customs(jsonb,text),pg_temp.reject_customs(text,text) to authenticated;
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',false);
-- Personal deny for each mandatory permission is authoritative.
do $$declare permission text; begin
 foreach permission in array array['source_documents.review','shipments.view','documents.view'] loop
  insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
  select 'eb000000-0000-4000-8000-000000000001',id,'deny','Review test','eb000000-0000-4000-8000-000000000001' from public.permissions where code=permission;
  perform pg_temp.reject_customs('select pg_temp.review_customs()', '42501');
  delete from public.user_permission_overrides where user_id='eb000000-0000-4000-8000-000000000001' and permission_id=(select id from public.permissions where code=permission);
 end loop;
end $$;
set role authenticated;
select pg_temp.reject_customs($sql$select pg_temp.review_customs('{}')$sql$);
select pg_temp.reject_customs($sql$select public.review_shipment_source_extraction('eb603000-0000-4000-8000-000000000001','{"invoice_number":"BYPASS"}',false)$sql$);
select pg_temp.reject_customs($sql$select pg_temp.review_customs(null,'')$sql$);
select pg_temp.reject_customs($sql$select pg_temp.review_customs(null,repeat('x',2001))$sql$);
select pg_temp.reject_customs($sql$select public.review_shipment_customs_evidence('eb300000-0000-4000-8000-000000000002','eb603000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000001','{}','Оригинал проверен')$sql$);
select pg_temp.reject_customs($sql$select public.review_shipment_customs_evidence('eb300000-0000-4000-8000-000000000001','eb603000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000002',(select extracted_data->'customs_record' from public.shipment_source_extractions where id='eb603000-0000-4000-8000-000000000001'),'Оригинал проверен')$sql$);
reset role;
-- Unlinked, rejected, archived, non-current and pending sources cannot be acknowledged.
do $$declare mutation text; begin
 foreach mutation in array array[
  $q$update public.document_links set removed_at=now(),removed_by='eb000000-0000-4000-8000-000000000001' where document_id='eb503000-0000-4000-8000-000000000001'$q$,
  $q$update public.documents set status='rejected' where id='eb503000-0000-4000-8000-000000000001'$q$,
  $q$update public.documents set archived_at=now(),archived_by='eb000000-0000-4000-8000-000000000001',archive_reason='Test archive' where id='eb503000-0000-4000-8000-000000000001'$q$,
  $q$update public.document_versions set is_current=false where id='eb513000-0000-4000-8000-000000000001'$q$,
  $q$update public.documents set current_version=2 where id='eb503000-0000-4000-8000-000000000001'$q$,
  $q$update public.shipment_source_extractions set status='pending' where id='eb603000-0000-4000-8000-000000000001'$q$,
  $q$update public.shipment_source_extractions set extracted_data=jsonb_set(extracted_data,'{customs_record,expectedCount}','2') where id='eb603000-0000-4000-8000-000000000001'$q$,
  $q$update public.shipment_source_extractions set extracted_data=jsonb_set(extracted_data,'{customs_record,items,0,quantity}','null') where id='eb603000-0000-4000-8000-000000000001'$q$,
  $q$update public.shipment_source_extractions set extracted_data=jsonb_set(extracted_data,'{customs_record,items}','[]') where id='eb603000-0000-4000-8000-000000000001'$q$,
  $q$update public.shipment_source_extractions set extracted_data=jsonb_set(extracted_data,'{customs_record,kind}','"assessment"') where id='eb603000-0000-4000-8000-000000000001'$q$
 ] loop
  begin
   execute mutation;
   perform pg_temp.reject_customs('select pg_temp.review_customs()');
   raise exception using errcode='ZX001',message='undo mutation';
  exception when sqlstate 'ZX001' then null; end;
 end loop;
end $$;
create temporary table before_review as select
 (select jsonb_agg(to_jsonb(i) order by id) from public.shipment_items i) items,
 (select jsonb_agg(to_jsonb(s) order by id) from public.shipments s) shipments,
 (select count(*) from public.inventory_movements) movements;
create temporary table review_business_snapshot as select
 (select jsonb_agg(to_jsonb(b) order by id) from public.inventory_balances b) balances,
 (select jsonb_agg(to_jsonb(r) order by id) from public.inventory_reservations r) reservations,
 (select jsonb_agg(to_jsonb(e) order by id) from public.expenses e) expenses,
 (select jsonb_agg(to_jsonb(c) order by id) from public.cost_calculations c) costs;
set role authenticated;
select pg_temp.review_customs();
reset role;
do $$declare e public.shipment_source_extractions%rowtype; begin
 select * into e from public.shipment_source_extractions where id='eb603000-0000-4000-8000-000000000001';
 if e.status<>'confirmed' or e.reviewed_by<>'eb000000-0000-4000-8000-000000000001' or e.reviewed_at is null
 or e.confirmed_data->'customs_record' is distinct from e.extracted_data->'customs_record'
 or e.confirmed_data->>'invoice_number'<>'KEEP' or e.confirmed_data->>'customs_review_note' is null then raise exception 'Review missing or old confirmation lost'; end if;
 if (select items from before_review) is distinct from (select jsonb_agg(to_jsonb(i) order by id) from public.shipment_items i)
 or (select shipments from before_review) is distinct from (select jsonb_agg(to_jsonb(s) order by id) from public.shipments s)
 or (select movements from before_review)<>(select count(*) from public.inventory_movements) then raise exception 'Review wrote business data'; end if;
end $$;
create temporary table confirmed_review as select * from public.shipment_source_extractions where id='eb603000-0000-4000-8000-000000000001';
create temporary table review_audit_snapshot as select count(*) as entries from public.audit_log
 where entity_type='shipment_source_extractions' and entity_id='eb603000-0000-4000-8000-000000000001';
set role authenticated;
select pg_temp.review_customs();
select public.upsert_shipment_source_extraction('eb300000-0000-4000-8000-000000000001','eb503000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000001','other','needs_review','{"customs_record":{"kind":"declaration"}}');
reset role;
do $$begin
 if (select to_jsonb(e) from public.shipment_source_extractions e where id='eb603000-0000-4000-8000-000000000001')
 is distinct from (select to_jsonb(e) from confirmed_review e) then raise exception 'Retry/recognition overwrote manual review'; end if;
 if has_function_privilege('anon','public.review_shipment_customs_evidence(uuid,uuid,uuid,jsonb,text)','EXECUTE')
 or has_function_privilege('service_role','public.review_shipment_customs_evidence(uuid,uuid,uuid,jsonb,text)','EXECUTE') then raise exception 'Unexpected RPC grant'; end if;
end $$;
-- Replay adds no audit event; changing the review note retains the previous evidence in the audit.
do $$begin
 assert (select entries from review_audit_snapshot)=(select count(*) from public.audit_log
  where entity_type='shipment_source_extractions' and entity_id='eb603000-0000-4000-8000-000000000001'),'duplicate review audit';
 assert exists(select 1 from public.audit_log where entity_type='shipment_source_extractions'
  and entity_id='eb603000-0000-4000-8000-000000000001' and actor_user_id='eb000000-0000-4000-8000-000000000001'
  and after_data->>'status'='confirmed' and after_data->>'reviewed_at' is not null),'review audit missing author/time';
end $$;
set role authenticated;
select pg_temp.review_customs(null,'Повторная ручная проверка: отличие от заказа сохраняется');
reset role;
do $$begin
 assert exists(select 1 from public.audit_log where entity_type='shipment_source_extractions'
  and entity_id='eb603000-0000-4000-8000-000000000001'
  and before_data#>>'{confirmed_data,customs_review_note}'='Оригинал проверен; расхождение с заказом сохранено'
  and after_data#>>'{confirmed_data,customs_review_note}'='Повторная ручная проверка: отличие от заказа сохраняется'),'note history lost';
 assert (select balances from review_business_snapshot) is not distinct from (select jsonb_agg(to_jsonb(b) order by id) from public.inventory_balances b),'balances changed';
 assert (select reservations from review_business_snapshot) is not distinct from (select jsonb_agg(to_jsonb(r) order by id) from public.inventory_reservations r),'reservations changed';
 assert (select expenses from review_business_snapshot) is not distinct from (select jsonb_agg(to_jsonb(e) order by id) from public.expenses e),'expenses changed';
 assert (select costs from review_business_snapshot) is not distinct from (select jsonb_agg(to_jsonb(c) order by id) from public.cost_calculations c),'costs changed';
end $$;
rollback;
