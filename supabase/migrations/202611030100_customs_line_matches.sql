-- Explicit links, not invented OCR. Append-only revisions preserve every decision.
create table if not exists public.shipment_customs_matches (
 id uuid primary key default gen_random_uuid(),
 extraction_id uuid not null references public.shipment_source_extractions(id),
 invoice_extraction_id uuid not null references public.shipment_source_extractions(id),
 packing_extraction_id uuid not null references public.shipment_source_extractions(id),
 source_snapshot jsonb not null,
 lines jsonb not null check(jsonb_typeof(lines)='array'),
 reason text not null check(length(btrim(reason)) between 10 and 2000),
 created_by uuid not null references public.profiles(id),
 created_at timestamptz not null default clock_timestamp()
);
create index if not exists customs_matches_extraction on public.shipment_customs_matches(extraction_id,created_at desc,id desc);
create index if not exists customs_matches_invoice on public.shipment_customs_matches(invoice_extraction_id);
create index if not exists customs_matches_packing on public.shipment_customs_matches(packing_extraction_id);
create index if not exists customs_matches_author on public.shipment_customs_matches(created_by);
alter table public.shipment_customs_matches enable row level security;
revoke all on public.shipment_customs_matches from public,anon,authenticated,service_role;
grant select on public.shipment_customs_matches to authenticated;
drop policy if exists customs_matches_read on public.shipment_customs_matches;
create policy customs_matches_read on public.shipment_customs_matches for select to authenticated using (
 (select private.has_permission('products.view')) and
 exists(select 1 from public.shipment_source_extractions e where e.id=extraction_id) and
 exists(select 1 from public.shipment_source_extractions e where e.id=invoice_extraction_id) and
 exists(select 1 from public.shipment_source_extractions e where e.id=packing_extraction_id)
);

create or replace function private.customs_match_snapshot(e public.shipment_source_extractions)
returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',e.id,'version',e.document_version_id,'transport',e.shipment_transport_id,'data',e.extracted_data,'confirmed',e.confirmed_data-array['customs_record','customs_review_note','customs_mapping_id'])
$$;

-- Called only under source/document locks by the saving/confirmation RPCs.
-- The temporary projection is for validation/comparison; it is NEVER written into OCR.
create or replace function private.customs_match_record(
 p_extraction uuid,p_invoice uuid,p_packing uuid,p_snapshot jsonb,p_lines jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.shipment_source_extractions%rowtype; i public.shipment_source_extractions%rowtype;
 k public.shipment_source_extractions%rowtype; r jsonb; li jsonb; pi jsonb; x jsonb; product public.products%rowtype;
 doc_items jsonb; inv_items jsonb; pack_items jsonb; result_items jsonb:='[]'; n integer; a integer; b integer;
 seen integer[]:='{}'; inv_seen integer[]:='{}'; pack_seen integer[]:='{}'; products uuid[]:='{}'; count_items integer;
begin
 if not private.has_permission('source_documents.review') or not private.has_permission('shipments.view') or not private.has_permission('documents.view') or not private.has_permission('products.view') then
  raise exception 'Недостаточно прав для сопоставления' using errcode='42501'; end if;
 select * into e from public.shipment_source_extractions where id=p_extraction;
 select * into i from public.shipment_source_extractions where id=p_invoice;
 select * into k from public.shipment_source_extractions where id=p_packing;
 if e.id is null or i.id is null or k.id is null or e.id=i.id or e.id=k.id or i.id=k.id
 or e.shipment_id<>i.shipment_id or e.shipment_id<>k.shipment_id
 or e.shipment_transport_id is distinct from i.shipment_transport_id or e.shipment_transport_id is distinct from k.shipment_transport_id
 or e.status not in ('extracted','needs_review','confirmed') or i.status<>'confirmed' or k.status<>'confirmed'
 or i.reviewed_at is null or k.reviewed_at is null or i.source_kind<>'invoice' or k.source_kind<>'specification' then
  raise exception 'Нужны актуальные ДТ, подтверждённые инвойс и упаковочный лист одной поставки и автомобиля'; end if;
 perform private.lock_shipment_source(e.shipment_id,e.document_id,e.document_version_id,e.shipment_transport_id);
 perform private.lock_shipment_source(i.shipment_id,i.document_id,i.document_version_id,i.shipment_transport_id);
 perform private.lock_shipment_source(k.shipment_id,k.document_id,k.document_version_id,k.shipment_transport_id);
 if p_snapshot is distinct from jsonb_build_array(private.customs_match_snapshot(e),private.customs_match_snapshot(i),private.customs_match_snapshot(k)) then
  raise exception 'Документ или область сверки изменились. Сопоставьте заново' using errcode='40001'; end if;
 r:=e.extracted_data->'customs_record';
 if r->>'kind' is distinct from 'declaration' or r->'invoiceNumbers' is distinct from jsonb_build_array(i.extracted_data#>>'{commodity_invoice,number}')
 or nullif(i.extracted_data#>>'{commodity_invoice,number}','') is null then raise exception 'Инвойс не соответствует ссылке в ДТ'; end if;
 doc_items:=r->'items'; inv_items:=i.extracted_data#>'{commodity_invoice,items}';
 if k.extracted_data#>>'{supplier_lots,kind}'='packing' then
  if k.extracted_data->>'invoice_number' is distinct from i.extracted_data#>>'{commodity_invoice,number}' then raise exception 'Упаковочный лист относится к другому инвойсу'; end if;
  pack_items:=k.extracted_data#>'{supplier_lots,items}';
 else
  if not coalesce(r->'packingNumbers' ? (k.extracted_data#>>'{packing_evidence,number}'),false) then raise exception 'Упаковочный лист не соответствует ссылке в ДТ'; end if;
  pack_items:=k.extracted_data#>'{packing_evidence,items}';
 end if;
 if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_typeof(doc_items) is distinct from 'array'
 or jsonb_typeof(inv_items) is distinct from 'array' or jsonb_typeof(pack_items) is distinct from 'array' then raise exception 'Товарные строки не прочитаны'; end if;
 count_items:=jsonb_array_length(doc_items);
 if count_items not between 1 and 2000 or jsonb_array_length(p_lines)<>count_items
 or jsonb_array_length(inv_items)<>count_items or jsonb_array_length(pack_items)<>count_items then
  raise exception 'Нужно сопоставить каждую строку один раз; объединённые строки требуют отдельной проверки'; end if;
 for x in select value from jsonb_array_elements(p_lines) loop
  if jsonb_typeof(x) is distinct from 'object' or x-array['line','invoice_line','packing_line','product_id','sku']<>'{}'
  or not (x ?& array['line','invoice_line','packing_line','product_id','sku'])
  or jsonb_typeof(x->'product_id') is distinct from 'string' or jsonb_typeof(x->'sku') is distinct from 'string' then raise exception 'Некорректное сопоставление'; end if;
  foreach li in array array[x->'line',x->'invoice_line',x->'packing_line'] loop
   if jsonb_typeof(li) is distinct from 'number' or li::numeric<>trunc(li::numeric) or li::numeric not between 1 and count_items then raise exception 'Некорректный номер строки'; end if;
  end loop;
  n:=(x->>'line')::integer; a:=(x->>'invoice_line')::integer; b:=(x->>'packing_line')::integer;
  if n=any(seen) or a=any(inv_seen) or b=any(pack_seen) or (x->>'product_id')::uuid=any(products) then raise exception 'Повтор строки или товара в сопоставлении'; end if;
  seen:=array_append(seen,n); inv_seen:=array_append(inv_seen,a); pack_seen:=array_append(pack_seen,b); products:=array_append(products,(x->>'product_id')::uuid);
  select * into product from public.products where id=(x->>'product_id')::uuid for share;
  if product.id is null or product.archived_at is not null or nullif(product.internal_sku,'') is null or product.internal_sku is distinct from x->>'sku'
  or not exists(select 1 from public.shipment_items si where si.shipment_id=e.shipment_id and si.product_id=product.id
    and (e.shipment_transport_id is null or si.shipment_transport_id=e.shipment_transport_id)) then raise exception 'Товар недоступен в выбранной области поставки'; end if;
  li:=doc_items->(n-1); pi:=inv_items->(a-1);
  if li->'number' is distinct from to_jsonb(n) or pi->'number' is distinct from to_jsonb(a) then raise exception 'Порядок строк документа изменён'; end if;
  if (nullif(li->>'sku','') is not null and li->>'sku'<>product.internal_sku)
   or (nullif(pi->>'sku','') is not null and pi->>'sku'<>product.internal_sku)
   or (nullif(pack_items->(b-1)->>'sku','') is not null and pack_items->(b-1)->>'sku'<>product.internal_sku) then
   raise exception 'Нельзя заменить артикул, прочитанный в оригинале'; end if;
  result_items:=result_items || jsonb_build_array(jsonb_set(li,'{sku}',to_jsonb(product.internal_sku)));
 end loop;
 select jsonb_agg(value order by (value->>'number')::integer) into result_items from jsonb_array_elements(result_items);
 r:=jsonb_set(r,'{items}',result_items);
 perform private.validate_customs_evidence(r);
 return r;
end $$;

-- All writers lock documents before extraction rows, in the same deterministic order.
create or replace function private.lock_customs_match_sources(ids uuid[]) returns void
language plpgsql security definer set search_path='' as $$
declare e public.shipment_source_extractions%rowtype;
begin
 for e in select * from public.shipment_source_extractions where id=any(ids) order by document_id,id loop
  perform private.lock_shipment_source(e.shipment_id,e.document_id,e.document_version_id,e.shipment_transport_id);
 end loop;
 perform 1 from public.shipment_source_extractions where id=any(ids) order by id for update;
end $$;

create or replace function public.save_shipment_customs_match(
 p_extraction_id uuid,p_invoice_id uuid,p_packing_id uuid,p_snapshot jsonb,p_lines jsonb,p_reason text,p_expected_id uuid
) returns uuid language plpgsql security definer set search_path='' as $$
declare prev public.shipment_customs_matches%rowtype; result uuid;
begin
 if not private.has_permission('source_documents.review') or not private.has_permission('products.view') or not private.has_permission('shipments.view') or not private.has_permission('documents.view') then raise exception 'Недостаточно прав' using errcode='42501'; end if;
 if coalesce(length(btrim(p_reason)),0) not between 10 and 2000 then raise exception 'Укажите основание сопоставления (10–2000 символов)'; end if;
 perform private.lock_customs_match_sources(array[p_extraction_id,p_invoice_id,p_packing_id]);
 perform private.customs_match_record(p_extraction_id,p_invoice_id,p_packing_id,p_snapshot,p_lines);
 select * into prev from public.shipment_customs_matches where extraction_id=p_extraction_id order by created_at desc,id desc limit 1;
 if prev.id is not null and prev.invoice_extraction_id=p_invoice_id and prev.packing_extraction_id=p_packing_id
 and prev.source_snapshot=p_snapshot and prev.lines=p_lines and prev.reason=btrim(p_reason) then return prev.id; end if;
 if prev.id is distinct from p_expected_id then raise exception 'Сопоставление изменено другим сотрудником. Обновите страницу' using errcode='40001'; end if;
 insert into public.shipment_customs_matches(extraction_id,invoice_extraction_id,packing_extraction_id,source_snapshot,lines,reason,created_by)
 values(p_extraction_id,p_invoice_id,p_packing_id,p_snapshot,p_lines,btrim(p_reason),auth.uid()) returning id into result;
 return result;
end $$;

create or replace function public.review_mapped_shipment_customs(
 p_extraction_id uuid,p_mapping_id uuid,p_expected_record jsonb,p_review_note text
) returns uuid language plpgsql security definer set search_path='' as $$
declare m public.shipment_customs_matches%rowtype; e public.shipment_source_extractions%rowtype;
begin
 if not private.has_permission('source_documents.review') or not private.has_permission('products.view') or not private.has_permission('shipments.view') or not private.has_permission('documents.view') then raise exception 'Недостаточно прав' using errcode='42501'; end if;
 if coalesce(length(btrim(p_review_note)),0) not between 10 and 2000 then raise exception 'Опишите результат сверки (10–2000 символов)'; end if;
 select * into m from public.shipment_customs_matches where id=p_mapping_id and extraction_id=p_extraction_id;
 if not found then raise exception 'Сопоставление недоступно'; end if;
 perform private.lock_customs_match_sources(array[m.extraction_id,m.invoice_extraction_id,m.packing_extraction_id]);
 if m.id is distinct from (select id from public.shipment_customs_matches where extraction_id=p_extraction_id order by created_at desc,id desc limit 1) then raise exception 'Сопоставление устарело'; end if;
 perform private.customs_match_record(m.extraction_id,m.invoice_extraction_id,m.packing_extraction_id,m.source_snapshot,m.lines);
 select * into e from public.shipment_source_extractions where id=p_extraction_id;
 if e.extracted_data->'customs_record' is distinct from p_expected_record then raise exception 'Результат чтения изменился'; end if;
 if e.status='confirmed' and e.confirmed_data->'customs_record'=p_expected_record
 and e.confirmed_data->>'customs_mapping_id'=m.id::text and e.confirmed_data->>'customs_review_note'=btrim(p_review_note) then return e.id; end if;
 update public.shipment_source_extractions set status='confirmed',
  confirmed_data=confirmed_data||jsonb_build_object('customs_record',p_expected_record,'customs_review_note',btrim(p_review_note),'customs_mapping_id',m.id),
  reviewed_by=auth.uid(),reviewed_at=now(),updated_at=now() where id=e.id;
 return e.id;
end $$;

create or replace function private.guard_customs_evidence_confirmation() returns trigger
language plpgsql set search_path='' as $$
declare m public.shipment_customs_matches%rowtype;
begin
 if new.status='confirmed' and new.extracted_data#>>'{customs_record,kind}' in ('declaration','value_declaration','transit') then
  -- An unchanged historical confirmation survives unrelated edits; no new claim is made.
  if tg_op='UPDATE' and old.status='confirmed' and new.extracted_data=old.extracted_data
   and new.confirmed_data=old.confirmed_data and new.document_version_id=old.document_version_id
   and new.shipment_transport_id is not distinct from old.shipment_transport_id then return new; end if;
  if new.extracted_data#>>'{customs_record,kind}'='declaration' and new.confirmed_data ? 'customs_mapping_id' then
   select * into m from public.shipment_customs_matches where extraction_id=new.id order by created_at desc,id desc limit 1;
   if m.id is null or new.confirmed_data->>'customs_mapping_id' is distinct from m.id::text
    or m.source_snapshot->0->'data' is distinct from new.extracted_data
    or m.source_snapshot->0->>'version' is distinct from new.document_version_id::text
    or m.source_snapshot->0->>'transport' is distinct from new.shipment_transport_id::text then raise exception 'Сопоставление изменилось. Повторите сверку'; end if;
   perform private.customs_match_record(m.extraction_id,m.invoice_extraction_id,m.packing_extraction_id,m.source_snapshot,m.lines);
  else perform private.validate_customs_evidence(new.extracted_data->'customs_record'); end if;
  if new.confirmed_data->'customs_record' is distinct from new.extracted_data->'customs_record'
   or coalesce(length(btrim(new.confirmed_data->>'customs_review_note')),0) not between 10 and 2000 then raise exception 'Подтвердите таможенный документ через сверку с оригиналом'; end if;
 end if;
 return new;
end $$;
revoke all on function private.customs_match_snapshot(public.shipment_source_extractions),private.customs_match_record(uuid,uuid,uuid,jsonb,jsonb),private.lock_customs_match_sources(uuid[]) from public,anon,authenticated,service_role;
revoke all on function public.save_shipment_customs_match(uuid,uuid,uuid,jsonb,jsonb,text,uuid),public.review_mapped_shipment_customs(uuid,uuid,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.save_shipment_customs_match(uuid,uuid,uuid,jsonb,jsonb,text,uuid),public.review_mapped_shipment_customs(uuid,uuid,jsonb,text) to authenticated;
notify pgrst,'reload schema';
