-- Phase 8: isolated external client document portal.

alter table public.documents
  add column if not exists counterparty_id uuid references public.counterparties(id) on delete restrict,
  add column if not exists visibility text not null default 'internal',
  add column if not exists source text not null default 'manual_upload';

do $$ begin
  if not exists(select 1 from pg_constraint where conname='documents_visibility_check') then
    alter table public.documents add constraint documents_visibility_check check(visibility in ('internal','shared_with_counterparty'));
  end if;
  if not exists(select 1 from pg_constraint where conname='documents_source_check') then
    alter table public.documents add constraint documents_source_check check(source in ('manual_upload','external_upload','google_drive_import','generated'));
  end if;
  if not exists(select 1 from pg_constraint where conname='documents_shared_counterparty_check') then
    alter table public.documents add constraint documents_shared_counterparty_check check(visibility='internal' or counterparty_id is not null);
  end if;
  if not exists(select 1 from pg_constraint where conname='profiles_external_counterparty_check') then
    alter table public.profiles add constraint profiles_external_counterparty_check check(user_type='employee' or counterparty_id is not null);
  end if;
end $$;

create index if not exists documents_external_portal_idx on public.documents(counterparty_id,created_at desc)
  where visibility='shared_with_counterparty' and archived_at is null;

insert into public.permissions(code,module,action,name,description) values
 ('documents.share_external','documents','share_external','Документы: доступ клиентов','Открытие и закрытие документа для конкретного клиента'),
 ('external_documents.view','external_documents','view','Кабинет клиента: просмотр','Просмотр открытых документов своего контрагента'),
 ('external_documents.download','external_documents','download','Кабинет клиента: скачивание','Скачивание открытых документов своего контрагента'),
 ('external_documents.upload','external_documents','upload','Кабинет клиента: загрузка','Загрузка документов от имени своего контрагента')
on conflict(code) do update set module=excluded.module,action=excluded.action,name=excluded.name,description=excluded.description;

insert into public.app_roles(code,name,description,is_system,is_enabled,audience) values
 ('external_client','Клиент','Представитель клиента с доступом только к явно открытым документам',true,true,'external')
on conflict(code) do update set name=excluded.name,description=excluded.description,is_system=true,is_enabled=true,audience='external';

insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true from public.app_roles r cross join public.permissions p
where p.code='documents.share_external' and r.code in ('director','executive_director','commercial_director','logistics_director','senior_logistics_manager','administrator')
on conflict(role_id,permission_id) do update set granted=true;

create or replace function private.is_external_client()
returns boolean language sql stable security definer set search_path='' as $$
 select exists(
  select 1 from public.profiles profile
  join public.counterparties counterparty on counterparty.id=profile.counterparty_id
  where profile.id=(select auth.uid()) and profile.is_active and profile.user_type='external'
    and counterparty.status='active' and 'customer'=any(counterparty.roles)
    and exists(select 1 from public.user_roles ur join public.app_roles role on role.id=ur.role_id
      where ur.user_id=profile.id and role.code='external_client' and role.audience='external' and role.is_enabled
        and (ur.expires_at is null or ur.expires_at>now()))
 );
$$;

create or replace function private.external_has_permission(p_code text)
returns boolean language sql stable security definer set search_path='' as $$
 select (select private.is_external_client())
   and not exists(select 1 from public.user_permission_overrides o join public.permissions p on p.id=o.permission_id
     where o.user_id=(select auth.uid()) and p.code=p_code and o.effect='deny' and o.revoked_at is null
       and (o.expires_at is null or o.expires_at>now()))
   and exists(select 1 from public.user_permission_overrides o join public.permissions p on p.id=o.permission_id
     where o.user_id=(select auth.uid()) and p.code=p_code and o.effect='allow' and o.revoked_at is null
       and (o.expires_at is null or o.expires_at>now()));
$$;

create or replace function private.external_can_access_document(p_document_id uuid,p_action text)
returns boolean language sql stable security definer set search_path='' as $$
 select p_action in ('view','download')
   and private.external_has_permission('external_documents.'||p_action)
   and exists(select 1 from public.documents d join public.profiles profile on profile.id=(select auth.uid())
     where d.id=p_document_id and d.counterparty_id=profile.counterparty_id
       and d.visibility='shared_with_counterparty' and d.archived_at is null);
$$;

create or replace function private.external_can_read_document_file(p_bucket text,p_path text)
returns boolean language sql stable security definer set search_path='' as $$
 select p_bucket='nexus-documents' and private.external_has_permission('external_documents.download')
   and exists(select 1 from public.document_versions version
     join public.documents document on document.id=version.document_id
     join public.profiles profile on profile.id=(select auth.uid())
     where version.storage_bucket=p_bucket and version.storage_path=p_path
       and document.counterparty_id=profile.counterparty_id
       and document.visibility='shared_with_counterparty' and document.archived_at is null);
$$;

revoke all on function private.is_external_client(),private.external_has_permission(text),private.external_can_access_document(uuid,text),private.external_can_read_document_file(text,text) from public,anon,authenticated,service_role;
grant execute on function private.is_external_client(),private.external_has_permission(text),private.external_can_access_document(uuid,text),private.external_can_read_document_file(text,text) to authenticated;

-- External accounts must not enumerate the internal access model.
drop policy if exists "authenticated users view permissions" on public.permissions;
drop policy if exists "employees view permissions" on public.permissions;
create policy "employees view permissions" on public.permissions for select to authenticated using ((select private.is_employee()));
drop policy if exists "authenticated users view role permissions" on public.role_permissions;
drop policy if exists "employees view role permissions" on public.role_permissions;
create policy "employees view role permissions" on public.role_permissions for select to authenticated using ((select private.is_employee()));

drop policy if exists "employees view document types" on public.document_types;
drop policy if exists "employees or portal users view document types" on public.document_types;
create policy "employees or portal users view document types" on public.document_types for select to authenticated
using ((select private.is_employee()) or (is_active and ((select private.external_has_permission('external_documents.view')) or (select private.external_has_permission('external_documents.upload')))));

drop policy if exists "document viewers see documents" on public.documents;
create policy "document viewers see documents" on public.documents for select to authenticated using (
 (select private.has_permission('documents.view')) or (select private.external_can_access_document(id,'view'))
);
drop policy if exists "document viewers see versions" on public.document_versions;
create policy "document viewers see versions" on public.document_versions for select to authenticated using (
 (select private.has_permission('documents.view')) or (select private.external_can_access_document(document_id,'view'))
);

-- Keep the existing version integrity trigger and admit only the first version of an
-- external document created by the dedicated RPC.
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
 update public.document_versions set is_current=false where document_id=new.document_id and is_current;return new;
end$$;
revoke all on function private.prepare_document_version() from public,anon,authenticated,service_role;

create or replace function public.my_external_document_permissions()
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'view',private.external_has_permission('external_documents.view'),
  'download',private.external_has_permission('external_documents.download'),
  'upload',private.external_has_permission('external_documents.upload'));
$$;

create or replace function public.my_document_permissions()
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'view',private.has_permission('documents.view'),
  'create',private.has_permission('documents.create'),
  'update',private.has_permission('documents.update'),
  'approve',private.has_permission('documents.approve'),
  'archive',private.has_permission('documents.archive'),
  'manage_types',private.has_permission('documents.manage_types'),
  'manage_requirements',private.has_permission('documents.manage_requirements'),
  'share_external',private.has_permission('documents.share_external'));
$$;

create or replace function public.update_my_external_profile(p_locale text,p_phone text)
returns void language plpgsql security definer set search_path='' as $$begin
 if not private.is_external_client() then raise exception 'Нет доступа к кабинету клиента';end if;
 if p_locale not in ('ru','kk','en') or length(coalesce(p_phone,''))>50 then raise exception 'Проверьте язык и телефон';end if;
 update public.profiles set locale=p_locale,phone=nullif(btrim(p_phone),''),updated_at=now() where id=(select auth.uid());
end$$;

create or replace function public.register_external_document(p_document_id uuid,p_document_type_id uuid,p_title text,p_storage_path text,p_original_filename text,p_document_number text default null,p_description text default null,p_document_date date default null,p_language text default null,p_checksum_sha256 text default null)
returns uuid language plpgsql security definer set search_path='' as $$declare v_counterparty uuid;begin
 if not private.external_has_permission('external_documents.upload') then raise exception 'Загрузка документов не разрешена';end if;
 select counterparty_id into v_counterparty from public.profiles where id=(select auth.uid());
 if not exists(select 1 from public.document_types where id=p_document_type_id and is_active) then raise exception 'Тип документа не найден';end if;
 if length(btrim(coalesce(p_title,''))) not between 1 and 300 or length(coalesce(p_description,''))>4000 or p_language is not null and p_language not in ('ru','kk','en','other') then raise exception 'Проверьте данные документа';end if;
 insert into public.documents(id,document_type_id,document_number,title,description,document_date,language,status,counterparty_id,visibility,source,uploaded_by)
 values(p_document_id,p_document_type_id,nullif(btrim(p_document_number),''),btrim(p_title),nullif(btrim(p_description),''),p_document_date,p_language,'uploaded',v_counterparty,'shared_with_counterparty','external_upload',(select auth.uid()));
 insert into public.document_versions(document_id,storage_path,original_filename,checksum_sha256) values(p_document_id,p_storage_path,left(p_original_filename,255),p_checksum_sha256);
 insert into public.audit_log(actor_user_id,action,entity_type,entity_id,metadata) values((select auth.uid()),'upload','documents',p_document_id::text,jsonb_build_object('source','external_portal','counterparty_id',v_counterparty));
 return p_document_id;
end$$;

create or replace function public.record_external_document_access(p_document_id uuid,p_action text)
returns void language plpgsql security definer set search_path='' as $$begin
 if p_action not in ('view','download') or not private.external_can_access_document(p_document_id,p_action) then raise exception 'Документ недоступен';end if;
 insert into public.audit_log(actor_user_id,action,entity_type,entity_id,metadata) values((select auth.uid()),p_action,'documents',p_document_id::text,jsonb_build_object('source','external_portal'));
end$$;

create or replace function public.set_document_external_access(p_document_id uuid,p_counterparty_id uuid,p_shared boolean)
returns void language plpgsql security definer set search_path='' as $$declare v_before jsonb;v_after jsonb;begin
 if not private.has_permission('documents.share_external') then raise exception 'Нет права открывать документы клиентам';end if;
 if p_shared and not exists(select 1 from public.counterparties where id=p_counterparty_id and status='active' and 'customer'=any(roles)) then raise exception 'Активный клиент не найден';end if;
 select jsonb_build_object('counterparty_id',counterparty_id,'visibility',visibility) into v_before from public.documents where id=p_document_id and archived_at is null for update;
 if not found then raise exception 'Документ не найден или находится в архиве';end if;
 update public.documents set counterparty_id=case when p_shared then p_counterparty_id else null end,visibility=case when p_shared then 'shared_with_counterparty' else 'internal' end,updated_at=now() where id=p_document_id;
 select jsonb_build_object('counterparty_id',counterparty_id,'visibility',visibility) into v_after from public.documents where id=p_document_id;
 insert into public.audit_log(actor_user_id,action,entity_type,entity_id,before_data,after_data,metadata) values((select auth.uid()),'visibility_changed','documents',p_document_id::text,v_before,v_after,jsonb_build_object('source','ui'));
end$$;

create or replace function private.set_external_access_flag(p_user uuid,p_code text,p_enabled boolean,p_actor uuid)
returns void language plpgsql security definer set search_path='' as $$declare v_permission uuid;begin
 select id into v_permission from public.permissions where code=p_code;if not found then raise exception 'Право % не найдено',p_code;end if;
 if p_enabled then
  update public.user_permission_overrides set effect='allow',scope=array['own_counterparty','shared_only'],reason='Доступ к кабинету клиента',granted_by=p_actor,granted_at=now(),expires_at=null,revoked_at=null,revoked_by=null,updated_at=now() where user_id=p_user and permission_id=v_permission and revoked_at is null;
  if not found then insert into public.user_permission_overrides(user_id,permission_id,effect,scope,reason,granted_by) values(p_user,v_permission,'allow',array['own_counterparty','shared_only'],'Доступ к кабинету клиента',p_actor);end if;
 else update public.user_permission_overrides set revoked_at=now(),revoked_by=p_actor,updated_at=now() where user_id=p_user and permission_id=v_permission and revoked_at is null;end if;
end$$;
revoke all on function private.set_external_access_flag(uuid,text,boolean,uuid) from public,anon,authenticated,service_role;

create or replace function public.configure_external_client(p_user_id uuid,p_counterparty_id uuid,p_full_name text,p_phone text,p_locale text,p_view boolean,p_download boolean,p_upload boolean)
returns void language plpgsql security definer set search_path='' as $$declare v_actor uuid:=(select auth.uid());v_role uuid;begin
 if not private.has_permission('roles.manage') or p_user_id=v_actor then raise exception 'Нет права настраивать внешний доступ';end if;
 if p_download and not p_view then raise exception 'Скачивание требует права просмотра';end if;
 if p_locale not in ('ru','kk','en') or length(btrim(coalesce(p_full_name,'')))<2 or length(coalesce(p_phone,''))>50 then raise exception 'Проверьте профиль клиента';end if;
 if not exists(select 1 from public.counterparties where id=p_counterparty_id and status='active' and 'customer'=any(roles)) then raise exception 'Активный клиент не найден';end if;
 select id into v_role from public.app_roles where code='external_client' and is_enabled;
 update public.profiles set user_type='external',counterparty_id=p_counterparty_id,full_name=btrim(p_full_name),phone=nullif(btrim(p_phone),''),locale=p_locale,job_title='Представитель клиента',updated_at=now() where id=p_user_id;
 if not found then raise exception 'Профиль пользователя не найден';end if;
 delete from public.user_roles where user_id=p_user_id;
 insert into public.user_roles(user_id,role_id,assigned_by) values(p_user_id,v_role,v_actor);
 perform private.set_external_access_flag(p_user_id,'external_documents.view',p_view,v_actor);
 perform private.set_external_access_flag(p_user_id,'external_documents.download',p_download,v_actor);
 perform private.set_external_access_flag(p_user_id,'external_documents.upload',p_upload,v_actor);
end$$;

create or replace function public.set_external_client_access(p_user_id uuid,p_view boolean,p_download boolean,p_upload boolean)
returns void language plpgsql security definer set search_path='' as $$declare v_actor uuid:=(select auth.uid());begin
 if not private.has_permission('roles.manage') or p_user_id=v_actor then raise exception 'Нет права изменять внешний доступ';end if;
 if p_download and not p_view then raise exception 'Скачивание требует права просмотра';end if;
 if not exists(select 1 from public.profiles where id=p_user_id and user_type='external') then raise exception 'Внешний пользователь не найден';end if;
 perform private.set_external_access_flag(p_user_id,'external_documents.view',p_view,v_actor);
 perform private.set_external_access_flag(p_user_id,'external_documents.download',p_download,v_actor);
 perform private.set_external_access_flag(p_user_id,'external_documents.upload',p_upload,v_actor);
end$$;

do $$declare f text;begin foreach f in array array[
 'public.my_external_document_permissions()','public.update_my_external_profile(text,text)','public.register_external_document(uuid,uuid,text,text,text,text,text,date,text,text)','public.record_external_document_access(uuid,text)','public.set_document_external_access(uuid,uuid,boolean)','public.configure_external_client(uuid,uuid,text,text,text,boolean,boolean,boolean)','public.set_external_client_access(uuid,boolean,boolean,boolean)'
] loop execute format('revoke all on function %s from public,anon,authenticated,service_role',f);execute format('grant execute on function %s to authenticated',f);end loop;end$$;

do $$begin
 if to_regclass('storage.objects') is null then raise notice 'Supabase Storage schema not found: external portal policies not refreshed';return;end if;
 execute 'drop policy if exists "nexus documents: read registered files" on storage.objects';
 execute $policy$ create policy "nexus documents: read registered files" on storage.objects for select to authenticated using(
  bucket_id='nexus-documents' and name like 'documents/%' and (
   ((select private.has_permission('documents.view')) and (select private.is_registered_document_file(bucket_id,name)))
   or (select private.external_can_read_document_file(bucket_id,name))
   or (owner_id=(select auth.uid())::text and not (select private.is_registered_document_file(bucket_id,name)))
  )) $policy$;
 execute 'drop policy if exists "nexus documents: upload into document folder" on storage.objects';
 execute $policy$ create policy "nexus documents: upload into document folder" on storage.objects for insert to authenticated with check(
  bucket_id='nexus-documents' and owner_id=(select auth.uid())::text
  and name~'^documents/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{32}-[A-Za-z0-9][A-Za-z0-9._-]{0,119}$'
  and ((select private.has_permission('documents.create')) or (select private.has_permission('documents.update')) or (select private.external_has_permission('external_documents.upload')))
 ) $policy$;
end$$;

comment on column public.documents.counterparty_id is 'Customer that may access the document in the external portal.';
comment on column public.documents.visibility is 'internal or explicitly shared_with_counterparty.';
