-- Acknowledges the exact parsed declaration, not a receipt, payment or correction of the order.
-- Existing extraction audit records the reviewer and the before/after evidence.
create or replace function public.review_shipment_customs_evidence(
 p_shipment_id uuid, p_extraction_id uuid, p_document_version_id uuid,
 p_expected_record jsonb, p_review_note text
) returns uuid
language plpgsql security definer set search_path='' as $$
declare e public.shipment_source_extractions%rowtype; v_record jsonb; v_note text:=btrim(p_review_note); v_item jsonb; v_key text;
begin
 if not (select private.has_permission('source_documents.review'))
 or not (select private.has_permission('shipments.view'))
 or not (select private.has_permission('documents.view')) then
  raise exception 'Недостаточно прав для сверки декларации' using errcode='42501';
 end if;
 if v_note is null or length(v_note) not between 10 and 2000 then
  raise exception 'Опишите результат сверки и оставшиеся расхождения (10–2000 символов)';
 end if;
 select * into e from public.shipment_source_extractions where id=p_extraction_id and shipment_id=p_shipment_id;
 if not found then raise exception 'Результат распознавания не найден'; end if;
 perform private.lock_shipment_source(e.shipment_id,e.document_id,e.document_version_id,e.shipment_transport_id);
 select * into e from public.shipment_source_extractions where id=p_extraction_id and shipment_id=p_shipment_id for update;
 if not found then raise exception 'Результат распознавания не найден'; end if;
 perform private.lock_shipment_source(e.shipment_id,e.document_id,e.document_version_id,e.shipment_transport_id);
 if e.status not in ('extracted','needs_review','confirmed')
 or p_document_version_id is distinct from e.document_version_id then
  raise exception 'Версия или состояние документа изменились. Обновите страницу и повторите сверку';
 end if;
 v_record:=e.extracted_data->'customs_record';
 if v_record is null or v_record is distinct from p_expected_record then
  raise exception 'Результат распознавания изменился. Обновите страницу и повторите сверку';
 end if;
 if jsonb_typeof(v_record) is distinct from 'object' or v_record->>'kind' is distinct from 'declaration'
 or jsonb_typeof(v_record->'fields') is distinct from 'array'
 or jsonb_typeof(v_record->'items') is distinct from 'array' then
  raise exception 'Нет распознанных реквизитов и товарных строк декларации';
 end if;
 if jsonb_array_length(v_record->'fields')=0 or jsonb_array_length(v_record->'items')=0
 or jsonb_typeof(v_record->'expectedCount') is distinct from 'number'
 or (v_record->>'expectedCount')::numeric<>jsonb_array_length(v_record->'items') then
  raise exception 'Не все товарные строки декларации прочитаны. Исправьте распознавание до подтверждения';
 end if;
 for v_item in select value from jsonb_array_elements(v_record->'items') loop
  foreach v_key in array array['sku','hsCode','unit','description'] loop
   if jsonb_typeof(v_item->v_key) is distinct from 'string' or nullif(btrim(v_item->>v_key),'') is null then
    raise exception 'В товарной строке не прочитано поле %. Исправьте распознавание',v_key;
   end if;
  end loop;
  foreach v_key in array array['number','quantity','amount','grossKg','netKg','customsValue'] loop
   if jsonb_typeof(v_item->v_key) is distinct from 'number' then
    raise exception 'В товарной строке не прочитано число %. Исправьте распознавание',v_key;
   end if;
   if (v_item->>v_key)::numeric<0 then raise exception 'Отрицательное значение %',v_key; end if;
  end loop;
 end loop;
 -- Idempotent retries keep the original reviewer/time and do not produce duplicate audit entries.
 if e.status='confirmed' and e.confirmed_data->'customs_record'=v_record
 and e.confirmed_data->>'customs_review_note'=v_note then return e.id; end if;
 update public.shipment_source_extractions set
  status='confirmed', confirmed_data=confirmed_data || jsonb_build_object('customs_record',v_record,'customs_review_note',v_note),
  reviewed_by=(select auth.uid()),reviewed_at=now(),updated_at=now()
 where id=e.id;
 return e.id;
end $$;
revoke all on function public.review_shipment_customs_evidence(uuid,uuid,uuid,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.review_shipment_customs_evidence(uuid,uuid,uuid,jsonb,text) to authenticated;
comment on function public.review_shipment_customs_evidence(uuid,uuid,uuid,jsonb,text) is
 'Review exact current declaration evidence; records reviewer/note, never changes goods, stock or finance.';

-- The legacy flat-field RPC must not bypass structured evidence review.
create or replace function private.guard_customs_evidence_confirmation() returns trigger
language plpgsql set search_path='' as $$
begin
 if new.status='confirmed' and new.extracted_data#>>'{customs_record,kind}'='declaration'
 and (new.confirmed_data->'customs_record' is distinct from new.extracted_data->'customs_record'
  or coalesce(length(btrim(new.confirmed_data->>'customs_review_note')),0) not between 10 and 2000) then
  raise exception 'Подтвердите декларацию через сверку реквизитов и товарных строк';
 end if;
 return new;
end $$;
revoke all on function private.guard_customs_evidence_confirmation() from public,anon,authenticated,service_role;
drop trigger if exists guard_customs_evidence_confirmation on public.shipment_source_extractions;
create trigger guard_customs_evidence_confirmation before insert or update on public.shipment_source_extractions
 for each row execute function private.guard_customs_evidence_confirmation();
