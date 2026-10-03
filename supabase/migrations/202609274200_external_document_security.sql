-- Restore the external document portal without exposing internal uploads, prices,
-- unrestricted metadata or superseded file versions.

do $$begin
 if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='documents' and column_name='external_shared_version_id') then
  alter table public.documents add column external_shared_version_id uuid references public.document_versions(id) on delete restrict;
  -- Existing shares predate the stricter classification and relation checks. Revoke
  -- them once; administrators may re-publish eligible current versions after review.
  update public.documents set visibility='internal',external_shared_version_id=null,updated_at=now()
  where visibility='shared_with_counterparty';
 end if;
end$$;

create index if not exists documents_external_shared_version_idx
 on public.documents(external_shared_version_id) where external_shared_version_id is not null;

-- External publication is an administrator-only action. Personal deny remains effective.
delete from public.role_permissions rp
using public.app_roles r,public.permissions p
where rp.role_id=r.id and rp.permission_id=p.id and p.code='documents.share_external' and r.code<>'administrator';
insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true from public.app_roles r cross join public.permissions p
where r.code='administrator' and p.code='documents.share_external'
on conflict(role_id,permission_id) do update set granted=true;

create or replace function private.document_matches_counterparty(p_document_id uuid,p_counterparty_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(
  select 1 from public.document_links l
  where l.document_id=p_document_id and l.removed_at is null and (
   (l.entity_type='customer' and l.entity_id=p_counterparty_id)
   or (l.entity_type='shipment' and exists(select 1 from public.shipments s where s.id=l.entity_id and s.customer_id=p_counterparty_id))
   or (l.entity_type='shipment_transport' and exists(select 1 from public.shipment_transports t join public.shipments s on s.id=t.shipment_id where t.id=l.entity_id and s.customer_id=p_counterparty_id))
   or (l.entity_type='contract' and exists(select 1 from public.contracts c where c.id=l.entity_id and c.counterparty_id=p_counterparty_id))
   or (l.entity_type='customer_return' and exists(select 1 from public.customer_returns r where r.id=l.entity_id and r.customer_id=p_counterparty_id))
  )
 ) or exists(
  select 1 from public.documents d where d.id=p_document_id and d.source='external_upload' and d.counterparty_id=p_counterparty_id
 );
$$;

-- Employee uploads/imports are internal. The only ARSEO-created files eligible for
-- publication are generated, explicitly price-free customer documents of safe types.
create or replace function private.document_is_external_safe(p_document_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(
  select 1 from public.documents d join public.document_types t on t.id=d.document_type_id
  where d.id=p_document_id and d.archived_at is null and d.amount is null and (
   d.source='external_upload'
   or (
    t.code in ('cmr','ttn','packing_list','snt','waybill','certificate','guarantee_letter')
    and exists(select 1 from public.document_generations g where g.document_id=d.id)
    and not exists(select 1 from public.document_generations g where g.document_id=d.id and g.contains_prices)
   )
  )
 );
$$;

create or replace function private.external_can_access_document(p_document_id uuid,p_action text)
returns boolean language sql stable security definer set search_path='' as $$
 select p_action in ('view','download')
  and private.external_has_permission('external_documents.'||p_action)
  and exists(
   select 1 from public.documents d join public.profiles profile on profile.id=(select auth.uid())
   where d.id=p_document_id and d.counterparty_id=profile.counterparty_id
    and d.visibility='shared_with_counterparty' and d.archived_at is null
    and d.external_shared_version_id is not null
    and private.document_is_external_safe(d.id)
    and private.document_matches_counterparty(d.id,profile.counterparty_id)
  );
$$;

create or replace function private.external_can_read_document_file(p_bucket text,p_path text)
returns boolean language sql stable security definer set search_path='' as $$
 select p_bucket='nexus-documents' and private.external_has_permission('external_documents.download')
  and exists(
   select 1 from public.document_versions v
   join public.documents d on d.id=v.document_id and d.external_shared_version_id=v.id
   where v.storage_bucket=p_bucket and v.storage_path=p_path
    and private.external_can_access_document(d.id,'download')
  );
$$;

create or replace function private.external_can_upload_document_file(p_path text)
returns boolean language sql stable security definer set search_path='' as $$
 select private.external_has_permission('external_documents.upload')
  and p_path~'^documents/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{32}-[A-Za-z0-9][A-Za-z0-9._-]{0,119}$'
  and not exists(select 1 from public.documents d where d.id=split_part(p_path,'/',2)::uuid)
  and (select count(*) from storage.objects o where o.bucket_id='nexus-documents'
       and o.owner_id=(select auth.uid())::text and not private.is_registered_document_file(o.bucket_id,o.name))<20;
$$;

revoke all on function private.document_matches_counterparty(uuid,uuid),private.document_is_external_safe(uuid),private.external_can_access_document(uuid,text),private.external_can_read_document_file(text,text),private.external_can_upload_document_file(text) from public,anon,authenticated,service_role;
grant execute on function private.document_matches_counterparty(uuid,uuid),private.document_is_external_safe(uuid),private.external_can_access_document(uuid,text),private.external_can_read_document_file(text,text),private.external_can_upload_document_file(text) to authenticated;

-- Base registry tables remain employee-only. The portal receives a deliberately small
-- projection through the RPCs below, so RLS cannot accidentally expose amount/currency.
drop policy if exists "document viewers see documents" on public.documents;
create policy "document viewers see documents" on public.documents for select to authenticated using(
 (select private.has_permission('documents.view'))
);
drop policy if exists "document viewers see versions" on public.document_versions;
create policy "document viewers see versions" on public.document_versions for select to authenticated using(
 (select private.has_permission('documents.view'))
);
drop policy if exists "document viewers see links" on public.document_links;
create policy "document viewers see links" on public.document_links for select to authenticated using(
 (select private.has_permission('documents.view'))
);

create or replace function private.can_read_registered_document_file(p_bucket text,p_path text) returns boolean
language sql security definer set search_path='' stable as $$
 select exists(select 1 from public.document_versions v where v.storage_bucket=p_bucket and v.storage_path=p_path)
$$;
revoke all on function private.can_read_registered_document_file(text,text) from public,anon,authenticated,service_role;
grant execute on function private.can_read_registered_document_file(text,text) to authenticated;

create or replace function public.my_external_documents()
returns table(id uuid,title text,document_number text,document_date date,created_at timestamptz,original_filename text,status text,type_name text)
language sql stable security definer set search_path='' as $$
 select d.id,d.title,d.document_number,d.document_date,d.created_at,v.original_filename,d.status,t.name_ru
 from public.documents d join public.document_types t on t.id=d.document_type_id
 join public.document_versions v on v.id=d.external_shared_version_id and v.document_id=d.id
 where private.external_can_access_document(d.id,'view') order by d.created_at desc;
$$;

create or replace function public.my_external_document(p_document_id uuid)
returns table(id uuid,title text,description text,document_number text,document_date date,status text,created_at timestamptz,type_name text,version_id uuid,version_number integer,original_filename text,file_size_bytes bigint,uploaded_at timestamptz)
language sql stable security definer set search_path='' as $$
 select d.id,d.title,d.description,d.document_number,d.document_date,d.status,d.created_at,t.name_ru,
  v.id,v.version_number,v.original_filename,v.file_size_bytes,v.uploaded_at
 from public.documents d join public.document_types t on t.id=d.document_type_id
 join public.document_versions v on v.id=d.external_shared_version_id and v.document_id=d.id
 where d.id=p_document_id and private.external_can_access_document(d.id,'view');
$$;

create or replace function public.my_external_document_file(p_document_id uuid,p_version_id uuid)
returns table(storage_path text,original_filename text)
language sql stable security definer set search_path='' as $$
 select v.storage_path,v.original_filename from public.document_versions v
 join public.documents d on d.id=v.document_id and d.external_shared_version_id=v.id
 where d.id=p_document_id and v.id=p_version_id and private.external_can_access_document(d.id,'download')
  and private.external_can_read_document_file(v.storage_bucket,v.storage_path);
$$;

create or replace function public.set_document_external_access(p_document_id uuid,p_counterparty_id uuid,p_shared boolean)
returns void language plpgsql security definer set search_path='' as $$
declare v_document public.documents%rowtype;v_version uuid;v_before jsonb;v_after jsonb;begin
 if not (select private.has_role('administrator')) or not (select private.has_permission('documents.share_external'))
   or not (select private.has_permission('documents.view')) then
  raise exception 'Только администратор с доступом к документу может изменять внешний доступ' using errcode='42501';
 end if;
 select * into v_document from public.documents where id=p_document_id and archived_at is null for update;
 if not found then raise exception 'Документ не найден или находится в архиве';end if;
 v_before:=jsonb_build_object('counterparty_id',v_document.counterparty_id,'visibility',v_document.visibility,'external_shared_version_id',v_document.external_shared_version_id);
 if p_shared then
  if not exists(select 1 from public.counterparties where id=p_counterparty_id and status='active' and 'customer'=any(roles)) then raise exception 'Активный клиент не найден';end if;
  if not private.document_is_external_safe(p_document_id) then raise exception 'Внутренний или ценовой документ нельзя открыть внешнему пользователю';end if;
  if not private.document_matches_counterparty(p_document_id,p_counterparty_id) then raise exception 'Документ не связан с выбранным клиентом';end if;
  select id into v_version from public.document_versions where document_id=p_document_id and is_current order by version_number desc limit 1;
  if v_version is null then raise exception 'У документа нет текущего файла';end if;
  update public.documents set counterparty_id=p_counterparty_id,visibility='shared_with_counterparty',external_shared_version_id=v_version,updated_at=now() where id=p_document_id;
 else
  update public.documents set visibility='internal',external_shared_version_id=null,updated_at=now() where id=p_document_id;
 end if;
 select jsonb_build_object('counterparty_id',counterparty_id,'visibility',visibility,'external_shared_version_id',external_shared_version_id) into v_after from public.documents where id=p_document_id;
 insert into public.audit_log(actor_user_id,action,entity_type,entity_id,before_data,after_data,metadata)
 values((select auth.uid()),'visibility_changed','documents',p_document_id::text,v_before,v_after,jsonb_build_object('source','ui'));
end$$;

-- Register an external upload and pin exactly its first version for that counterparty.
create or replace function public.register_external_document(p_document_id uuid,p_document_type_id uuid,p_title text,p_storage_path text,p_original_filename text,p_document_number text default null,p_description text default null,p_document_date date default null,p_language text default null,p_checksum_sha256 text default null)
returns uuid language plpgsql security definer set search_path='' as $$declare v_counterparty uuid;v_version uuid;begin
 if not private.external_has_permission('external_documents.upload') then raise exception 'Загрузка документов не разрешена';end if;
 select counterparty_id into v_counterparty from public.profiles where id=(select auth.uid());
 if not exists(select 1 from public.document_types where id=p_document_type_id and is_active) then raise exception 'Тип документа не найден';end if;
 if length(btrim(coalesce(p_title,''))) not between 1 and 300 or length(coalesce(p_description,''))>4000 or p_language is not null and p_language not in ('ru','kk','en','other') then raise exception 'Проверьте данные документа';end if;
 insert into public.documents(id,document_type_id,document_number,title,description,document_date,language,status,counterparty_id,visibility,source,uploaded_by)
 values(p_document_id,p_document_type_id,nullif(btrim(p_document_number),''),btrim(p_title),nullif(btrim(p_description),''),p_document_date,p_language,'uploaded',v_counterparty,'shared_with_counterparty','external_upload',(select auth.uid()));
 insert into public.document_versions(document_id,storage_path,original_filename,checksum_sha256)
 values(p_document_id,p_storage_path,left(p_original_filename,255),p_checksum_sha256) returning id into v_version;
 update public.documents set external_shared_version_id=v_version where id=p_document_id;
 insert into public.audit_log(actor_user_id,action,entity_type,entity_id,metadata) values((select auth.uid()),'upload','documents',p_document_id::text,jsonb_build_object('source','external_portal','counterparty_id',v_counterparty));
 return p_document_id;
end$$;

-- Any later employee version requires a fresh administrator publication decision.
create or replace function private.prepare_document_version()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_document public.documents%rowtype;v_object record;begin
 select * into v_document from public.documents d where d.id=new.document_id for update;
 if not found then raise exception 'Документ не найден';end if;
 if v_document.archived_at is not null then raise exception 'Документ в архиве: новые версии запрещены';end if;
 if v_document.current_version=0 then
  if not (((select private.has_permission('documents.create')) and v_document.uploaded_by=(select auth.uid()))
    or (select private.has_permission('documents.update'))
    or ((select private.external_has_permission('external_documents.upload')) and v_document.uploaded_by=(select auth.uid())
      and v_document.source='external_upload' and v_document.visibility='shared_with_counterparty'
      and v_document.counterparty_id=(select counterparty_id from public.profiles where id=(select auth.uid())))) then
   raise exception 'Недостаточно прав для загрузки файла документа';end if;
 elsif not (select private.has_permission('documents.update')) then raise exception 'Недостаточно прав для загрузки новой версии';end if;
 if new.storage_path is null or split_part(new.storage_path,'/',1)<>'documents' or split_part(new.storage_path,'/',2)<>new.document_id::text then raise exception 'Недопустимый путь файла';end if;
 if to_regclass('storage.objects') is null then raise exception 'Supabase Storage недоступен: файл нельзя проверить';end if;
 execute 'select o.metadata,o.owner_id from storage.objects o where o.bucket_id=$1 and o.name=$2' into v_object using 'nexus-documents',new.storage_path;
 if v_object is null then raise exception 'Файл не найден в хранилище nexus-documents';end if;
 if v_object.owner_id is distinct from (select auth.uid())::text then raise exception 'Файл загружен другим пользователем';end if;
 new.storage_bucket:='nexus-documents';new.mime_type:=coalesce(v_object.metadata->>'mimetype',new.mime_type);
 new.file_size_bytes:=coalesce((v_object.metadata->>'size')::bigint,(v_object.metadata->>'contentLength')::bigint,new.file_size_bytes);
 new.version_number:=v_document.current_version+1;new.is_current:=true;new.uploaded_by:=(select auth.uid());new.uploaded_at:=now();
 update public.document_versions set is_current=false where document_id=new.document_id and is_current;
 if v_document.current_version>0 then update public.documents set visibility='internal',external_shared_version_id=null,updated_at=now() where id=new.document_id;end if;
 return new;
end$$;

do $$begin
 if to_regclass('storage.objects') is null then return;end if;
 execute 'drop policy if exists "nexus documents: read registered files" on storage.objects';
 execute $policy$create policy "nexus documents: read registered files" on storage.objects for select to authenticated using(
  bucket_id='nexus-documents' and name like 'documents/%' and (
   ((select private.has_permission('documents.view')) and (select private.can_read_registered_document_file(bucket_id,name)))
   or (select private.external_can_read_document_file(bucket_id,name))
   or (owner_id=(select auth.uid())::text and not (select private.is_registered_document_file(bucket_id,name)))
  ))$policy$;
 execute 'drop policy if exists "nexus documents: upload into document folder" on storage.objects';
 execute $policy$create policy "nexus documents: upload into document folder" on storage.objects for insert to authenticated with check(
  bucket_id='nexus-documents' and owner_id=(select auth.uid())::text
  and name~'^documents/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{32}-[A-Za-z0-9][A-Za-z0-9._-]{0,119}$'
  and (((select private.has_permission('documents.create')) or (select private.has_permission('documents.update')))
       or (select private.external_can_upload_document_file(name)))
 )$policy$;
end$$;

do $$declare f text;begin foreach f in array array[
 'public.my_external_documents()','public.my_external_document(uuid)','public.my_external_document_file(uuid,uuid)',
 'public.set_document_external_access(uuid,uuid,boolean)','public.register_external_document(uuid,uuid,text,text,text,text,text,date,text,text)'
] loop execute format('revoke all on function %s from public,anon,authenticated,service_role',f);execute format('grant execute on function %s to authenticated',f);end loop;end$$;

comment on column public.documents.external_shared_version_id is 'Exactly one reviewed version exposed to the linked external counterparty; null means no external file access';
comment on function private.document_is_external_safe(uuid) is 'Allows client uploads and price-free generated customer documents; employee uploads/imports remain internal';
