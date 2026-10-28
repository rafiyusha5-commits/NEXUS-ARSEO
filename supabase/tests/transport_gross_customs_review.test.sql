-- Synthetic, isolated, rolled back. No receiving or financial operations.
\set ON_ERROR_STOP 1
begin;
\ir fixtures/source_integrity.sql
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',false);
create function pg_temp.reject_call(q text, expected text default null) returns void language plpgsql as $$
declare rejected boolean:=false; before_state jsonb; after_state jsonb;
begin
 select jsonb_agg(to_jsonb(t) order by id) into before_state from public.shipment_transports t;
 begin execute q; exception when others then
  if expected is not null and sqlstate<>expected then raise exception 'Wrong denial %',sqlstate; end if;
  rejected:=true;
 end;
 assert rejected, 'Invalid operation accepted';
 select jsonb_agg(to_jsonb(t) order by id) into after_state from public.shipment_transports t;
 assert before_state is not distinct from after_state, 'Failed operation changed vehicle';
end $$;
grant execute on function pg_temp.reject_call(text,text) to authenticated;
set role authenticated;
select public.update_shipment_transport('eb310000-0000-4000-8000-000000000001','{"purchase_pallet_tare_kg":"22"}');
select public.update_shipment_transport('eb310000-0000-4000-8000-000000000001','{"sale_pallet_tare_kg":"25"}');
select pg_temp.reject_call($q$select public.update_shipment_transport('eb310000-0000-4000-8000-000000000001','{"sale_pallet_tare_kg":"19"}')$q$,'23514');
select pg_temp.reject_call($q$select public.update_shipment_transport('eb310000-0000-4000-8000-000000000001','{"sale_pallet_tare_kg":"25.01"}')$q$,'23514');
select pg_temp.reject_call($q$select public.update_shipment_transport('eb310000-0000-4000-8000-000000000001','{"sale_pallet_tare_kg":"22.555"}')$q$,'23514');
reset role;
do $$begin
 assert (select purchase_pallet_tare_kg=22 and sale_pallet_tare_kg=25 from public.shipment_transports where id='eb310000-0000-4000-8000-000000000001');
 assert (select purchase_pallet_tare_kg is null and sale_pallet_tare_kg is null from public.shipment_transports where id='eb310000-0000-4000-8000-000000000002');
end $$;
-- Both view and update are mandatory; denied operations leave all vehicle fields unchanged.
do $$declare v_code text; begin
 foreach v_code in array array['shipments.view','shipments.update'] loop
  insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
  select 'eb000000-0000-4000-8000-000000000001',id,'deny','tare denial test','eb000000-0000-4000-8000-000000000001' from public.permissions where permissions.code=v_code;
  perform pg_temp.reject_call($q$select public.update_shipment_transport('eb310000-0000-4000-8000-000000000001','{"purchase_pallet_tare_kg":"20"}')$q$,'42501');
  delete from public.user_permission_overrides where user_id='eb000000-0000-4000-8000-000000000001' and permission_id=(select id from public.permissions where permissions.code=v_code);
 end loop;
end $$;
insert into public.product_packaging(product_id,uom,units_per_parent,gross_weight_kg,net_weight_kg) values
 ('eb200000-0000-4000-8000-000000000001','piece',1,0.102,0.1),
 ('eb200000-0000-4000-8000-000000000001','box',10,1.2,1),
 ('eb200000-0000-4000-8000-000000000001','pallet',1000,999,100);
do $$declare g numeric; begin
 select gross_kg into g from private.document_check_load('eb300000-0000-4000-8000-000000000001') where transport_id='eb310000-0000-4000-8000-000000000001' and not is_total;
 assert g=145,'Export uses cartons + sale tare, not piece gross or master pallet gross';
 assert (select gross_kg is null from private.document_check_load('eb300000-0000-4000-8000-000000000001') where is_total),'Incomplete total must be unknown';
end $$;
-- Change type only in the isolated fixture to exercise the same helper on import.
set session_replication_role=replica;
update public.shipments set type='import',supplier_id='eb100000-0000-4000-8000-000000000002' where id='eb300000-0000-4000-8000-000000000001';
set session_replication_role=origin;
do $$begin
 assert (select gross_kg=142 from private.document_check_load('eb300000-0000-4000-8000-000000000001') where transport_id='eb310000-0000-4000-8000-000000000001' and not is_total),'Import uses independent 22 kg';
end $$;
-- DTS and transit: exact/current reviewed evidence only, unchanged manual fields, idempotent retries.
create temp table protected_before as select
 (select jsonb_agg(to_jsonb(i) order by id) from public.shipment_items i) items,
 (select count(*) from public.inventory_movements) movements,
 (select count(*) from public.expenses) expenses;
do $$declare record jsonb; k text; first_state jsonb; err boolean; permission text; begin
 foreach k in array array['value_declaration','transit'] loop
  record:=jsonb_build_object('kind',k,'warnings',jsonb_build_array('Требуется сверка с оригиналом'),'fields',case when k='value_declaration' then
   '[{"label":"Форма","value":"ДТС-1"},{"label":"Связанная декларация","value":"TEST/000001"},{"label":"Ссылка на счёт (гр. 4)","value":"TEST-INV"},{"label":"Курс пересчёта в форме","value":"EUR / 500"}]'::jsonb else
   '[{"label":"Форма","value":"Транзитная декларация"},{"label":"Ссылка на CMR (гр. 44)","value":"TEST-CMR"},{"label":"Ссылка на счёт (гр. 44)","value":"TEST-INV"},{"label":"Стоимость по счёту (гр. 22)","value":"100 EUR"}]'::jsonb end);
  update public.shipment_source_extractions set source_kind='other',status='needs_review',extracted_data=jsonb_build_object('customs_record',record),confirmed_data='{"invoice_number":"KEEP"}',reviewed_at=null,reviewed_by=null where id='eb603000-0000-4000-8000-000000000001';
  foreach permission in array array['source_documents.review','shipments.view','documents.view'] loop
   insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
   select 'eb000000-0000-4000-8000-000000000001',id,'deny','customs test','eb000000-0000-4000-8000-000000000001' from public.permissions where code=permission;
   err:=false;
   begin perform public.review_shipment_customs_evidence('eb300000-0000-4000-8000-000000000001','eb603000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000001',record,'Реквизиты сверены; ограничения сохранены'); exception when insufficient_privilege then err:=true; end;
   assert err,'Personal deny bypassed';
   delete from public.user_permission_overrides where user_id='eb000000-0000-4000-8000-000000000001' and permission_id=(select id from public.permissions where code=permission);
  end loop;
  -- Legacy flat confirmation cannot bypass structured review.
  err:=false;
  begin perform public.review_shipment_source_extraction('eb603000-0000-4000-8000-000000000001','{"invoice_number":"BYPASS"}',false); exception when others then err:=true; end;
  assert err,'Legacy path bypassed structured review';
  err:=false;
  begin perform private.validate_customs_evidence(jsonb_set(record,'{fields}','[]')); exception when others then err:=true; end;
  assert err,'Empty document accepted';
  err:=false;
  begin perform public.review_shipment_customs_evidence('eb300000-0000-4000-8000-000000000001','eb603000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000002',record,'Реквизиты сверены; ограничения сохранены'); exception when others then err:=true; end;
  assert err,'Stale version accepted';
  perform public.review_shipment_customs_evidence('eb300000-0000-4000-8000-000000000001','eb603000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000001',record,'Реквизиты сверены; ограничения сохранены');
  select to_jsonb(e) into first_state from public.shipment_source_extractions e where id='eb603000-0000-4000-8000-000000000001';
  assert first_state->>'status'='confirmed' and first_state#>>'{confirmed_data,invoice_number}'='KEEP' and first_state->>'reviewed_by'='eb000000-0000-4000-8000-000000000001';
  perform public.review_shipment_customs_evidence('eb300000-0000-4000-8000-000000000001','eb603000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000001',record,'Реквизиты сверены; ограничения сохранены');
  assert first_state=(select to_jsonb(e) from public.shipment_source_extractions e where id='eb603000-0000-4000-8000-000000000001'),'Retry changed review';
 end loop;
 assert (select items from protected_before) is not distinct from (select jsonb_agg(to_jsonb(i) order by id) from public.shipment_items i),'Review changed quantities';
 assert (select movements from protected_before)=(select count(*) from public.inventory_movements),'Review changed stock';
 assert (select expenses from protected_before)=(select count(*) from public.expenses),'Review changed finance';
end $$;
rollback;
