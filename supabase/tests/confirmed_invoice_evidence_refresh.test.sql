-- Synthetic data only. Manual confirmation and business operations must survive enrichment.
\set ON_ERROR_STOP 1
begin;
\ir fixtures/source_integrity.sql
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',false);
update public.shipment_source_extractions set confirmed_data='{"invoice_number":"INV-1","incoterms":"MANUAL"}',
 extracted_data='{"invoice_number":"OLD-OCR","incoterms":"OLD"}',field_evidence='{"invoice_number":{"method":"old"}}'
 where id='eb601000-0000-4000-8000-000000000001';
create temp table evidence_before as select to_jsonb(e) as row from public.shipment_source_extractions e where id='eb601000-0000-4000-8000-000000000001';
create temp table items_before as select to_jsonb(i) as row from public.shipment_items i;
create function pg_temp.refresh_invoice(p_data jsonb default '{"commodity_invoice":{"number":"INV-1","currency":"EUR","total":20,"warnings":[],"items":[{"sku":"DQ-001","quantity":10,"amount":20}]},"invoice_number":"AUTOMATIC","incoterms":"AUTOMATIC"}')
returns uuid language sql as $$
 select public.upsert_shipment_source_extraction('eb300000-0000-4000-8000-000000000001','eb501000-0000-4000-8000-000000000001','eb511000-0000-4000-8000-000000000001','invoice','extracted',p_data,'{}','[]',null,'rules-new')
$$;
grant execute on function pg_temp.refresh_invoice(jsonb) to authenticated;
-- Extract without review is not enough to modify a confirmed invoice.
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000002',false);
set role authenticated; select pg_temp.refresh_invoice(); reset role;
do $$begin
 if (select row from evidence_before) is distinct from (select to_jsonb(e) from public.shipment_source_extractions e where id='eb601000-0000-4000-8000-000000000001') then raise exception 'No-review user changed confirmed source';end if;
end$$;
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',false);
set role authenticated;
select pg_temp.refresh_invoice('{"commodity_invoice":{"number":"WRONG","items":[{}]}}');
select pg_temp.refresh_invoice('{"commodity_invoice":{"number":"INV-1","items":[]}}');
select pg_temp.refresh_invoice('{"commodity_invoice":{"number":"INV-1","items":{}}}');
reset role;
do $$begin
 if (select row from evidence_before) is distinct from (select to_jsonb(e) from public.shipment_source_extractions e where id='eb601000-0000-4000-8000-000000000001') then raise exception 'Invalid evidence changed source';end if;
end$$;
set role authenticated; select pg_temp.refresh_invoice(); reset role;
do $$declare e jsonb; b jsonb;begin
 select to_jsonb(x) into e from public.shipment_source_extractions x where id='eb601000-0000-4000-8000-000000000001';
 select row into b from evidence_before;
 if e#>>'{extracted_data,commodity_invoice,number}' is distinct from 'INV-1' then raise exception 'Evidence not refreshed';end if;
 if (e-array['extracted_data','field_evidence','updated_at']) is distinct from (b-array['extracted_data','field_evidence','updated_at']) then raise exception 'Manual confirmation, binding or provenance changed';end if;
 if ((e->'extracted_data')-'commodity_invoice') is distinct from (b->'extracted_data') then raise exception 'Scalar evidence overwritten';end if;
 if ((e->'field_evidence')-'commodity_invoice') is distinct from (b->'field_evidence') then raise exception 'Scalar provenance overwritten';end if;
 if e#>>'{field_evidence,commodity_invoice,manual_confirmation_preserved}' is distinct from 'true' then raise exception 'Refresh provenance missing';end if;
 if exists((select row from items_before except select to_jsonb(i) from public.shipment_items i) union all (select to_jsonb(i) from public.shipment_items i except select row from items_before)) then raise exception 'Quantities changed';end if;
end$$;
create temp table after_refresh as select to_jsonb(e) as row from public.shipment_source_extractions e where id='eb601000-0000-4000-8000-000000000001';
set role authenticated; select pg_temp.refresh_invoice(); reset role;
do $$begin
 if (select row from after_refresh) is distinct from (select to_jsonb(e) from public.shipment_source_extractions e where id='eb601000-0000-4000-8000-000000000001') then raise exception 'Repeat changed source';end if;
end$$;
-- An unlinked or replaced source cannot be enriched, even with review permission.
update public.document_links set removed_at=now(),removed_by='eb000000-0000-4000-8000-000000000001' where document_id='eb501000-0000-4000-8000-000000000001';
set role authenticated;
do $$declare refused boolean:=false; begin
 begin perform pg_temp.refresh_invoice(); exception when others then refused:=true;end;
 if not refused then raise exception 'Unlinked source accepted';end if;
end$$;
reset role;
rollback;
