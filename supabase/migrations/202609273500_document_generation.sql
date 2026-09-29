-- Phase 9B: controlled generation of shipment documents from approved DOCX templates.

insert into public.permissions(code,module,action,name,description) values
 ('templates.generate','templates','generate','Шаблоны: формирование документов','Формирование документа поставки из утверждённого шаблона'),
 ('templates.generate_prices','templates','generate_prices','Шаблоны: документы с ценами','Подстановка закупочных цен и сумм в формируемые документы')
on conflict(code) do update set module=excluded.module,action=excluded.action,name=excluded.name,description=excluded.description;

insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true from public.app_roles r cross join public.permissions p
where p.code='templates.generate' and r.code in (
 'director','executive_director','commercial_director','logistics_director',
 'senior_logistics_manager','logistics_specialist','administrator'
)
on conflict(role_id,permission_id) do nothing;
insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true from public.app_roles r cross join public.permissions p
where p.code='templates.generate_prices' and r.code in ('director','executive_director','commercial_director','accountant','administrator')
on conflict(role_id,permission_id) do nothing;

create table if not exists public.document_generations (
 id uuid primary key default gen_random_uuid(),
 template_id uuid not null references public.document_templates(id) on delete restrict,
 template_version_id uuid not null references public.document_template_versions(id) on delete restrict,
 shipment_id uuid not null references public.shipments(id) on delete restrict,
 document_id uuid not null unique references public.documents(id) on delete restrict,
 output_format text not null check(output_format in ('docx')),
 contains_prices boolean not null default false,
 fields_snapshot jsonb not null check(jsonb_typeof(fields_snapshot)='object'),
 generated_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
 generated_at timestamptz not null default now()
);
alter table public.document_generations add column if not exists contains_prices boolean not null default false;
create index if not exists document_generations_template_idx on public.document_generations(template_id,generated_at desc);
create index if not exists document_generations_shipment_idx on public.document_generations(shipment_id,generated_at desc);

alter table public.document_generations enable row level security;
revoke all on public.document_generations from anon,authenticated,service_role;
grant select on public.document_generations to authenticated;
drop policy if exists "document users view generations" on public.document_generations;
create policy "document users view generations" on public.document_generations for select to authenticated using (
 (select private.has_permission('templates.view'))
 and (select private.has_permission('documents.view'))
 and (select private.has_permission('shipments.view'))
 and (not contains_prices or (select private.has_permission('templates.generate_prices')))
);

-- Generated documents containing prices follow the stronger financial permission in every
-- access path: registry rows, versions, links and the private Storage object itself.
create or replace function private.can_view_generated_document(p_document_id uuid) returns boolean
language sql security definer set search_path='' stable
as $$
 select not exists(select 1 from public.document_generations g where g.document_id=p_document_id)
   or exists(select 1 from public.document_generations g where g.document_id=p_document_id
             and (not g.contains_prices or (select private.has_permission('templates.generate_prices'))))
$$;
revoke all on function private.can_view_generated_document(uuid) from public,anon,service_role;
grant execute on function private.can_view_generated_document(uuid) to authenticated;

drop policy if exists "document viewers see documents" on public.documents;
create policy "document viewers see documents" on public.documents for select to authenticated using (
 (select private.has_permission('documents.view')) and (select private.can_view_generated_document(id))
);
drop policy if exists "document viewers see versions" on public.document_versions;
create policy "document viewers see versions" on public.document_versions for select to authenticated using (
 (select private.has_permission('documents.view')) and (select private.can_view_generated_document(document_id))
);
drop policy if exists "document viewers see links" on public.document_links;
create policy "document viewers see links" on public.document_links for select to authenticated using (
 (select private.has_permission('documents.view')) and (select private.can_view_generated_document(document_id))
);

create or replace function private.can_read_registered_document_file(p_bucket text,p_path text) returns boolean
language sql security definer set search_path='' stable
as $$
 select exists(select 1 from public.document_versions v
               where v.storage_bucket=p_bucket and v.storage_path=p_path
                 and (select private.can_view_generated_document(v.document_id)))
$$;
revoke all on function private.can_read_registered_document_file(text,text) from public,anon,service_role;
grant execute on function private.can_read_registered_document_file(text,text) to authenticated;

do $$ begin
 if to_regclass('storage.objects') is null then return; end if;
 execute 'drop policy if exists "nexus documents: read registered files" on storage.objects';
 execute $policy$
  create policy "nexus documents: read registered files" on storage.objects for select to authenticated using (
   bucket_id='nexus-documents' and name like 'documents/%' and (
    ((select private.has_permission('documents.view')) and (select private.can_read_registered_document_file(bucket_id,name)))
    or (owner_id=(select auth.uid())::text and not (select private.is_registered_document_file(bucket_id,name)))
   )
  )
 $policy$;
end $$;

create or replace function public.register_generated_document(
 p_generation_id uuid,p_template_id uuid,p_template_version_id uuid,p_shipment_id uuid,
 p_document_id uuid,p_title text,p_storage_path text,p_original_filename text,
 p_document_number text default null,p_document_date date default current_date,
 p_language text default 'ru',p_checksum_sha256 text default null,p_contains_prices boolean default false,
 p_fields_snapshot jsonb default '{}'::jsonb
) returns uuid
language plpgsql security definer set search_path=''
as $$
declare v_template public.document_templates%rowtype;v_version public.document_template_versions%rowtype;v_shipment public.shipments%rowtype;
begin
 if not (select private.has_permission('templates.generate')) then raise exception 'Недостаточно прав для формирования документа';end if;
 if not (select private.has_permission('documents.create')) then raise exception 'Недостаточно прав для регистрации документа';end if;
 if not (select private.has_permission('shipments.view')) then raise exception 'Нет доступа к поставке';end if;
 if p_contains_prices and not (select private.has_permission('templates.generate_prices')) then raise exception 'Нет права формировать документы с ценами';end if;
 if p_generation_id is null or p_document_id is null then raise exception 'Некорректный идентификатор операции';end if;
 if jsonb_typeof(coalesce(p_fields_snapshot,'{}'::jsonb))<>'object' then raise exception 'Некорректный снимок данных';end if;
 if pg_column_size(coalesce(p_fields_snapshot,'{}'::jsonb))>1048576 then raise exception 'Снимок данных превышает 1 МБ';end if;
 if not p_contains_prices and (
  coalesce(p_fields_snapshot->>'total_amount','')<>'' or exists(
   select 1 from jsonb_array_elements(coalesce(p_fields_snapshot->'items','[]'::jsonb)) item
   where coalesce(item->>'unit_price','')<>'' or coalesce(item->>'line_total','')<>'' or coalesce(item->>'currency_code','')<>''
  )
 ) then raise exception 'Финансовые поля требуют отдельного права';end if;

 select * into v_template from public.document_templates where id=p_template_id;
 if not found or v_template.status<>'approved' or not v_template.is_active or v_template.archived_at is not null then
  raise exception 'Шаблон не утверждён или отключён';
 end if;
 select * into v_version from public.document_template_versions where id=p_template_version_id and template_id=p_template_id and is_current;
 if not found or v_version.mime_type<>'application/vnd.openxmlformats-officedocument.wordprocessingml.document' then
  raise exception 'Для формирования нужна текущая версия шаблона DOCX';
 end if;
 select * into v_shipment from public.shipments where id=p_shipment_id;
 if not found then raise exception 'Поставка не найдена';end if;
 if v_template.counterparty_id is not null and (
  (v_template.flow_direction='input' and v_template.counterparty_id is distinct from v_shipment.supplier_id)
  or (v_template.flow_direction='output' and v_template.counterparty_id is distinct from v_shipment.customer_id)
 ) then raise exception 'Шаблон предназначен для другого контрагента';end if;

 perform public.register_document(
  p_document_id,v_template.document_type_id,p_title,p_storage_path,p_original_filename,
  p_document_number,'Сформировано автоматически из шаблона «'||v_template.name||'», версия '||v_version.version_number,
  p_document_date,null,p_language,null,null,p_checksum_sha256,
  jsonb_build_array(jsonb_build_object('entity_type','shipment','entity_id',p_shipment_id,'link_role','primary'))
 );
 insert into public.document_generations(id,template_id,template_version_id,shipment_id,document_id,output_format,contains_prices,fields_snapshot,generated_by)
 values(p_generation_id,p_template_id,p_template_version_id,p_shipment_id,p_document_id,'docx',p_contains_prices,p_fields_snapshot,auth.uid());
 return p_document_id;
end $$;

revoke all on function public.register_generated_document(uuid,uuid,uuid,uuid,uuid,text,text,text,text,date,text,text,boolean,jsonb) from public,anon,service_role;
grant execute on function public.register_generated_document(uuid,uuid,uuid,uuid,uuid,text,text,text,text,date,text,text,boolean,jsonb) to authenticated;

drop trigger if exists audit_document_generations_changes on public.document_generations;
create trigger audit_document_generations_changes after insert on public.document_generations
for each row execute function private.write_access_audit();

comment on table public.document_generations is 'Immutable provenance and input snapshots of documents generated from approved templates';
comment on function public.register_generated_document(uuid,uuid,uuid,uuid,uuid,text,text,text,text,date,text,text,boolean,jsonb) is 'Atomically registers a generated file, document, shipment link and immutable generation provenance';
