-- Context remains shipment + existing shipment_transport, not an inferred route segment.
create table if not exists public.shipment_source_context_history (
 id uuid primary key default gen_random_uuid(),
 extraction_id uuid not null references public.shipment_source_extractions(id),
 old_transport_id uuid,
 new_transport_id uuid,
 reason text not null check(length(btrim(reason)) between 5 and 500),
 changed_by uuid not null references public.profiles(id),
 changed_at timestamptz not null default now()
);
create index if not exists source_context_extraction_idx on public.shipment_source_context_history(extraction_id);
create index if not exists source_context_actor_idx on public.shipment_source_context_history(changed_by);
alter table public.shipment_source_context_history enable row level security;
revoke all on public.shipment_source_context_history from public,anon,authenticated,service_role;
grant select on public.shipment_source_context_history to authenticated;
drop policy if exists source_context_history_read on public.shipment_source_context_history;
create policy source_context_history_read on public.shipment_source_context_history for select to authenticated using(
 private.has_permission('shipments.view') and private.has_permission('documents.view')
 and exists(select 1 from public.shipment_source_extractions e where e.id=extraction_id
 and private.can_view_generated_document(e.document_id))
);
-- Extracted fields must follow the document's existing financial visibility too.
drop policy if exists "shipment users view source extraction" on public.shipment_source_extractions;
create policy "shipment users view source extraction" on public.shipment_source_extractions for select to authenticated using(
 private.has_permission('shipments.view') and private.has_permission('documents.view')
 and private.can_view_generated_document(document_id)
);

create or replace function public.assign_source_extraction_transport(p_extraction_id uuid,p_transport_id uuid,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare e public.shipment_source_extractions%rowtype;
begin
 if not private.has_permission('source_documents.extract') then raise exception 'Нет права распознавать исходные документы' using errcode='42501'; end if;
 if not private.has_permission('shipments.view') or not private.has_permission('documents.view') then raise exception 'Нет доступа к поставке или документам' using errcode='42501'; end if;
 if p_reason is null or length(btrim(p_reason)) not between 5 and 500 then raise exception 'Укажите причину изменения контекста (5–500 символов)'; end if;
 select * into e from public.shipment_source_extractions where id=p_extraction_id;
 if not found then raise exception 'Результат распознавания не найден'; end if;
 -- Same lock order as review, OCR finish and version replacement: document -> version -> extraction.
 perform private.lock_shipment_source(e.shipment_id,e.document_id,e.document_version_id,e.shipment_transport_id,true);
 select * into e from public.shipment_source_extractions where id=p_extraction_id for update;
 if e.status in ('confirmed','superseded') then raise exception 'Подтверждённый или устаревший документ нельзя перепривязать: сначала отдельно проверьте подтверждение'; end if;
 if e.status='pending' then raise exception 'Дождитесь окончания распознавания перед изменением контекста'; end if;
 if p_transport_id is not null and not exists(select 1 from public.shipment_transports
  where id=p_transport_id and shipment_id=e.shipment_id and status<>'cancelled') then
  raise exception 'Автомобиль не относится к этой поставке или отменён';
 end if;
 perform private.lock_shipment_source(e.shipment_id,e.document_id,e.document_version_id,p_transport_id);
 if e.shipment_transport_id is not distinct from p_transport_id then return; end if;
 update public.shipment_source_extractions set shipment_transport_id=p_transport_id,updated_at=now() where id=e.id;
 insert into public.shipment_source_context_history(extraction_id,old_transport_id,new_transport_id,reason,changed_by)
 values(e.id,e.shipment_transport_id,p_transport_id,btrim(p_reason),auth.uid());
end $$;
-- Existing callers retain the same operation; they cannot bypass its current-document checks.
create or replace function public.assign_source_extraction_transport(p_extraction_id uuid,p_transport_id uuid)
returns void language sql security invoker set search_path='' as $$
 select public.assign_source_extraction_transport(p_extraction_id,p_transport_id,'Назначение через существующую операцию Nexus');
$$;
revoke all on function public.assign_source_extraction_transport(uuid,uuid,text),
 public.assign_source_extraction_transport(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.assign_source_extraction_transport(uuid,uuid,text),
 public.assign_source_extraction_transport(uuid,uuid) to authenticated;

-- Same eligibility as generation and review: a link to vehicle B cannot authorize evidence bound to A.
do $$declare definition text; old_fragment text; new_fragment text;begin
 definition:=replace(pg_get_functiondef('private.document_check_findings(uuid,date)'::regprocedure),chr(13),'');
 old_fragment:='and e.document_id in (select document_id from link_docs)';
 new_fragment:=$fragment$and e.document_id in (select document_id from link_docs)
      and exists(select 1 from public.document_links context_link where context_link.document_id=e.document_id
        and context_link.removed_at is null and (
          context_link.entity_type='shipment' and context_link.entity_id=e.shipment_id
          or context_link.entity_type='shipment_transport' and context_link.entity_id=e.shipment_transport_id))$fragment$;
 if position(new_fragment in definition)=0 then
  if position(old_fragment in definition)=0 then raise exception 'Document check changed: review context integration'; end if;
  execute replace(definition,old_fragment,new_fragment);
 end if;
end $$;
