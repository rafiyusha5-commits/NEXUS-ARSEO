-- Phase 9C: source-document extraction and review for automatic shipment paperwork.

insert into public.permissions(code,module,action,name,description) values
 ('source_documents.extract','source_documents','extract','Исходные документы: распознавание','Извлечение данных поставки из загруженных документов'),
 ('source_documents.review','source_documents','review','Исходные документы: проверка','Подтверждение распознанных данных и разрешение исключений')
on conflict(code) do update set module=excluded.module,action=excluded.action,name=excluded.name,description=excluded.description;

insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true from public.app_roles r cross join public.permissions p
where p.code='source_documents.extract' and r.code in (
 'director','executive_director','commercial_director','logistics_director',
 'senior_logistics_manager','logistics_specialist','administrator'
)
on conflict(role_id,permission_id) do update set granted=true;

insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true from public.app_roles r cross join public.permissions p
where p.code='source_documents.review' and r.code in (
 'director','executive_director','logistics_director','senior_logistics_manager','administrator'
)
on conflict(role_id,permission_id) do update set granted=true;

insert into public.document_types(code,name_ru,name_en,name_kk,category,is_required_by_default,has_validity_period,sort_order) values
 ('transport_order','Договор-заявка на перевозку','Transport order','Тасымалдауға шарт-өтінім','contract',false,false,112),
 ('vehicle_document','Документ на автомобиль или прицеп','Vehicle document','Көлік құжаты','shipping',false,true,113),
 ('driver_document','Документ водителя','Driver document','Жүргізуші құжаты','shipping',false,true,114),
 ('shipment_workbook','Рабочая книга отгрузки','Shipment workbook','Жөнелту жұмыс кітабы','shipping',false,false,115)
on conflict(code) do nothing;

create table if not exists public.shipment_source_extractions(
 id uuid primary key default gen_random_uuid(),
 shipment_id uuid not null references public.shipments(id) on delete restrict,
 document_id uuid not null references public.documents(id) on delete restrict,
 document_version_id uuid not null references public.document_versions(id) on delete restrict,
 source_kind text not null check(source_kind in ('invoice','specification','contract','transport_order','vehicle_document','driver_document','waybill','other')),
 status text not null default 'pending' check(status in ('pending','extracted','needs_review','confirmed','failed','superseded')),
 extracted_data jsonb not null default '{}'::jsonb check(jsonb_typeof(extracted_data)='object'),
 field_evidence jsonb not null default '{}'::jsonb check(jsonb_typeof(field_evidence)='object'),
 conflicts jsonb not null default '[]'::jsonb check(jsonb_typeof(conflicts)='array'),
 confirmed_data jsonb not null default '{}'::jsonb check(jsonb_typeof(confirmed_data)='object'),
 error_message text check(error_message is null or length(error_message)<=2000),
 extractor_version text not null check(length(extractor_version) between 1 and 80),
 requested_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
 requested_at timestamptz not null default now(),
 reviewed_by uuid references public.profiles(id) on delete restrict,
 reviewed_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 constraint shipment_source_extractions_review_consistent check(
  (status='confirmed' and reviewed_by is not null and reviewed_at is not null)
  or (status<>'confirmed')
 ),
 constraint shipment_source_extractions_payload_limit check(
  pg_column_size(extracted_data)+pg_column_size(field_evidence)+pg_column_size(conflicts)+pg_column_size(confirmed_data)<=1048576
 )
);

create unique index if not exists shipment_source_extractions_version_unique
 on public.shipment_source_extractions(shipment_id,document_version_id);
create index if not exists shipment_source_extractions_shipment_idx
 on public.shipment_source_extractions(shipment_id,status,updated_at desc);

alter table public.shipment_source_extractions enable row level security;
revoke all on public.shipment_source_extractions from anon,authenticated,service_role;
grant select on public.shipment_source_extractions to authenticated;

drop policy if exists "shipment users view source extraction" on public.shipment_source_extractions;
create policy "shipment users view source extraction" on public.shipment_source_extractions for select to authenticated using(
 (select private.has_permission('shipments.view')) and (select private.has_permission('documents.view'))
);

create or replace function public.upsert_shipment_source_extraction(
 p_shipment_id uuid,p_document_id uuid,p_document_version_id uuid,p_source_kind text,p_status text,
 p_extracted_data jsonb default '{}'::jsonb,p_field_evidence jsonb default '{}'::jsonb,
 p_conflicts jsonb default '[]'::jsonb,p_error_message text default null,p_extractor_version text default 'rules-v1'
) returns uuid
language plpgsql security definer set search_path=''
as $$
declare v_id uuid;v_user uuid:=(select auth.uid());
begin
 if not (select private.has_permission('source_documents.extract')) then raise exception 'Нет права распознавать исходные документы';end if;
 if not (select private.has_permission('shipments.view')) or not (select private.has_permission('documents.view')) then raise exception 'Нет доступа к поставке или документам';end if;
 if p_source_kind not in ('invoice','specification','contract','transport_order','vehicle_document','driver_document','waybill','other') then raise exception 'Некорректный вид источника';end if;
 if p_status not in ('extracted','needs_review','confirmed','failed') then raise exception 'Некорректный статус распознавания';end if;
 if jsonb_typeof(coalesce(p_extracted_data,'{}'::jsonb))<>'object' or jsonb_typeof(coalesce(p_field_evidence,'{}'::jsonb))<>'object' or jsonb_typeof(coalesce(p_conflicts,'[]'::jsonb))<>'array' then raise exception 'Некорректные данные распознавания';end if;
 if pg_column_size(coalesce(p_extracted_data,'{}'::jsonb))+pg_column_size(coalesce(p_field_evidence,'{}'::jsonb))+pg_column_size(coalesce(p_conflicts,'[]'::jsonb))>786432 then raise exception 'Результат распознавания слишком велик';end if;
 if not exists(select 1 from public.document_versions v where v.id=p_document_version_id and v.document_id=p_document_id) then raise exception 'Версия документа не найдена';end if;
 if not exists(
  select 1 from public.document_links l where l.document_id=p_document_id and l.removed_at is null and(
   (l.entity_type='shipment' and l.entity_id=p_shipment_id) or
   (l.entity_type='shipment_transport' and exists(select 1 from public.shipment_transports t where t.id=l.entity_id and t.shipment_id=p_shipment_id))
  )
 ) then raise exception 'Документ не связан с этой поставкой';end if;

 update public.shipment_source_extractions set status='superseded',updated_at=now()
 where shipment_id=p_shipment_id and document_id=p_document_id and document_version_id<>p_document_version_id and status<>'superseded';

 insert into public.shipment_source_extractions(
  shipment_id,document_id,document_version_id,source_kind,status,extracted_data,field_evidence,conflicts,confirmed_data,
  error_message,extractor_version,requested_by,requested_at,reviewed_by,reviewed_at,updated_at
 ) values(
  p_shipment_id,p_document_id,p_document_version_id,p_source_kind,p_status,coalesce(p_extracted_data,'{}'::jsonb),
  coalesce(p_field_evidence,'{}'::jsonb),coalesce(p_conflicts,'[]'::jsonb),
  case when p_status='confirmed' then coalesce(p_extracted_data,'{}'::jsonb) else '{}'::jsonb end,
  nullif(btrim(p_error_message),''),left(p_extractor_version,80),v_user,now(),
  case when p_status='confirmed' then v_user else null end,case when p_status='confirmed' then now() else null end,now()
 ) on conflict(shipment_id,document_version_id) do update set
  source_kind=excluded.source_kind,status=excluded.status,extracted_data=excluded.extracted_data,
  field_evidence=excluded.field_evidence,conflicts=excluded.conflicts,confirmed_data=excluded.confirmed_data,
  error_message=excluded.error_message,extractor_version=excluded.extractor_version,requested_by=excluded.requested_by,
  requested_at=now(),reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at,updated_at=now()
 returning id into v_id;
 return v_id;
end $$;

create or replace function public.confirm_shipment_source_extraction(p_extraction_id uuid) returns uuid
language plpgsql security definer set search_path=''
as $$
declare v_id uuid;
begin
 if not (select private.has_permission('source_documents.review')) then raise exception 'Нет права подтверждать распознанные данные';end if;
 if not (select private.has_permission('shipments.view')) or not (select private.has_permission('documents.view')) then raise exception 'Нет доступа к поставке или документам';end if;
 update public.shipment_source_extractions set status='confirmed',confirmed_data=extracted_data,reviewed_by=(select auth.uid()),reviewed_at=now(),updated_at=now()
 where id=p_extraction_id and status in ('extracted','needs_review') returning id into v_id;
 if v_id is null then raise exception 'Результат распознавания не найден или уже закрыт';end if;
 return v_id;
end $$;

revoke all on function public.upsert_shipment_source_extraction(uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb,text,text) from public,anon,service_role;
grant execute on function public.upsert_shipment_source_extraction(uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb,text,text) to authenticated;
revoke all on function public.confirm_shipment_source_extraction(uuid) from public,anon,service_role;
grant execute on function public.confirm_shipment_source_extraction(uuid) to authenticated;

alter table public.document_generations drop constraint if exists document_generations_output_format_check;
alter table public.document_generations add constraint document_generations_output_format_check check(output_format in ('docx','xlsx'));

drop trigger if exists audit_shipment_source_extractions_changes on public.shipment_source_extractions;
create trigger audit_shipment_source_extractions_changes after insert or update on public.shipment_source_extractions
for each row execute function private.write_access_audit();

-- Extend Phase 9B registration to XLSX shipment workbooks while preserving the same provenance checks.
create or replace function public.register_generated_document(
 p_generation_id uuid,p_template_id uuid,p_template_version_id uuid,p_shipment_id uuid,
 p_document_id uuid,p_title text,p_storage_path text,p_original_filename text,
 p_document_number text default null,p_document_date date default current_date,
 p_language text default 'ru',p_checksum_sha256 text default null,p_contains_prices boolean default false,
 p_fields_snapshot jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path=''
as $$
declare v_template public.document_templates%rowtype;v_version public.document_template_versions%rowtype;v_shipment public.shipments%rowtype;v_format text;
begin
 if not (select private.has_permission('templates.generate')) then raise exception 'Недостаточно прав для формирования документа';end if;
 if not (select private.has_permission('documents.create')) then raise exception 'Недостаточно прав для регистрации документа';end if;
 if not (select private.has_permission('shipments.view')) then raise exception 'Нет доступа к поставке';end if;
 if p_contains_prices and not (select private.has_permission('templates.generate_prices')) then raise exception 'Нет права формировать документы с ценами';end if;
 if p_generation_id is null or p_document_id is null then raise exception 'Некорректный идентификатор операции';end if;
 if jsonb_typeof(coalesce(p_fields_snapshot,'{}'::jsonb))<>'object' then raise exception 'Некорректный снимок данных';end if;
 if pg_column_size(coalesce(p_fields_snapshot,'{}'::jsonb))>1048576 then raise exception 'Снимок данных превышает 1 МБ';end if;
 if not p_contains_prices and (coalesce(p_fields_snapshot->>'total_amount','')<>'' or exists(
  select 1 from jsonb_array_elements(coalesce(p_fields_snapshot->'items','[]'::jsonb)) item
  where coalesce(item->>'unit_price','')<>'' or coalesce(item->>'line_total','')<>'' or coalesce(item->>'currency_code','')<>''
 )) then raise exception 'Финансовые поля требуют отдельного права';end if;
 select * into v_template from public.document_templates where id=p_template_id;
 if not found or v_template.status<>'approved' or not v_template.is_active or v_template.archived_at is not null then raise exception 'Шаблон не утверждён или отключён';end if;
 select * into v_version from public.document_template_versions where id=p_template_version_id and template_id=p_template_id and is_current;
 if not found or v_version.mime_type not in ('application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') then raise exception 'Для формирования нужна текущая версия шаблона DOCX или XLSX';end if;
 v_format:=case when v_version.mime_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' then 'xlsx' else 'docx' end;
 select * into v_shipment from public.shipments where id=p_shipment_id;
 if not found then raise exception 'Поставка не найдена';end if;
 if v_template.counterparty_id is not null and ((v_template.flow_direction='input' and v_template.counterparty_id is distinct from v_shipment.supplier_id) or (v_template.flow_direction='output' and v_template.counterparty_id is distinct from v_shipment.customer_id)) then raise exception 'Шаблон предназначен для другого контрагента';end if;
 perform public.register_document(p_document_id,v_template.document_type_id,p_title,p_storage_path,p_original_filename,p_document_number,
  'Сформировано автоматически из шаблона «'||v_template.name||'», версия '||v_version.version_number,p_document_date,null,p_language,null,null,p_checksum_sha256,
  jsonb_build_array(jsonb_build_object('entity_type','shipment','entity_id',p_shipment_id,'link_role','primary')));
 insert into public.document_generations(id,template_id,template_version_id,shipment_id,document_id,output_format,contains_prices,fields_snapshot,generated_by)
 values(p_generation_id,p_template_id,p_template_version_id,p_shipment_id,p_document_id,v_format,p_contains_prices,p_fields_snapshot,auth.uid());
 return p_document_id;
end $$;

comment on table public.shipment_source_extractions is 'Version-bound extracted shipment data with evidence, conflicts and review state';
comment on function public.upsert_shipment_source_extraction(uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb,text,text) is 'Stores server-extracted data only for a document linked to the shipment';
