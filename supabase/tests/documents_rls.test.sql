-- RLS and integrity tests for the document management migration.
-- Run with scripts/test-db.sh (local PostgreSQL + supabase_stub.sql). Every statement
-- runs in its own transaction, as the role and user that the comment names.

\set ON_ERROR_STOP 1

create schema if not exists tests;
grant usage on schema tests to authenticated;

-- Runs p_sql and fails unless it raises an error whose message matches p_pattern.
create or replace function tests.expect_error(p_sql text, p_pattern text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'expected error "%" but statement succeeded: %', p_pattern, p_sql
    using errcode = 'P0099';
exception
  when sqlstate 'P0099' then raise;
  when others then
    if sqlerrm !~* p_pattern then
      raise exception 'expected error "%" but got "%" for: %', p_pattern, sqlerrm, p_sql
        using errcode = 'P0099';
    end if;
end;
$$;

-- Runs an UPDATE/DELETE and returns the number of affected rows.
create or replace function tests.affected(p_sql text) returns integer
language plpgsql as $$
declare
  v_count integer;
begin
  execute p_sql;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function tests.act_as(p_user uuid) returns void
language sql as $$ select set_config('request.jwt.claim.sub', p_user::text, false) $$;

grant execute on all functions in schema tests to authenticated;

-- Fixtures (as postgres) ---------------------------------------------------------------

insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-4000-8000-000000000001', 'admin@test.local', '{"full_name":"Администратор"}'),
  ('a0000000-0000-4000-8000-000000000002', 'director@test.local', '{"full_name":"Директор"}'),
  ('a0000000-0000-4000-8000-000000000003', 'specialist@test.local', '{"full_name":"Специалист"}'),
  ('a0000000-0000-4000-8000-000000000004', 'marketer@test.local', '{"full_name":"Маркетолог"}'),
  ('a0000000-0000-4000-8000-000000000005', 'creator@test.local', '{"full_name":"Только создание"}'),
  ('a0000000-0000-4000-8000-000000000006', 'client@test.local', '{"full_name":"Внешний клиент"}');

insert into public.user_roles (user_id, role_id)
select u.id::uuid, r.id
from (values
  ('a0000000-0000-4000-8000-000000000001', 'administrator'),
  ('a0000000-0000-4000-8000-000000000002', 'director'),
  ('a0000000-0000-4000-8000-000000000003', 'logistics_specialist'),
  ('a0000000-0000-4000-8000-000000000004', 'marketer'),
  ('a0000000-0000-4000-8000-000000000005', 'marketer')
) as u(id, role_code)
join public.app_roles r on r.code = u.role_code;

-- The "creator" may register documents but may neither view nor update them.
-- The external user gets documents.view personally: it must still see nothing.
insert into public.user_permission_overrides (user_id, permission_id, effect, reason, granted_by)
select u.id::uuid, p.id, 'allow', 'test', 'a0000000-0000-4000-8000-000000000001'
from (values
  ('a0000000-0000-4000-8000-000000000005', 'documents.create'),
  ('a0000000-0000-4000-8000-000000000006', 'documents.view')
) as u(id, code)
join public.permissions p on p.code = u.code;

insert into public.counterparties (id, roles, legal_name, country) values
  ('b0000000-0000-4000-8000-000000000001', array['manufacturer', 'supplier'], 'Test Supplier Oy', 'FI'),
  ('b0000000-0000-4000-8000-000000000002', array['customer'], 'ТОО Тестовый клиент', 'KZ');

update public.profiles set user_type = 'external', counterparty_id = 'b0000000-0000-4000-8000-000000000002'
where id = 'a0000000-0000-4000-8000-000000000006';

insert into public.shipments (
  id, shipment_number, type, supplier_id, route_id, process_template_id, currency_id,
  destination_warehouse_id, responsible_user_id, created_by
)
select 'c0000000-0000-4000-8000-000000000001', 'NAR-TEST-0001', 'import',
  'b0000000-0000-4000-8000-000000000001',
  (select id from public.routes where origin_country = 'FI' and destination_country = 'KZ'),
  (select id from public.process_templates where code = 'import_eu_kz'),
  (select id from public.currencies where code = 'EUR'),
  (select id from public.warehouses where code = 'AKT'),
  'a0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000003';

-- 1. Privileges: anon and service_role get nothing, nobody may delete ---------------

do $$
begin
  assert not has_table_privilege('anon', 'public.documents', 'select'), 'anon must not read documents';
  assert not has_table_privilege('anon', 'public.document_versions', 'select'), 'anon must not read versions';
  assert not has_table_privilege('service_role', 'public.documents', 'select'), 'service_role must not get extra privileges';
  assert not has_table_privilege('authenticated', 'public.documents', 'delete'), 'documents must not be deletable';
  assert not has_table_privilege('authenticated', 'public.document_versions', 'update'), 'versions must be immutable';
  assert not has_table_privilege('authenticated', 'public.document_versions', 'delete'), 'versions must not be deletable';
  assert not has_table_privilege('authenticated', 'public.document_links', 'delete'), 'links are soft-removed only';
  assert not has_column_privilege('authenticated', 'public.documents', 'storage_path', 'update'), 'storage_path must not be client-writable';
  assert not has_column_privilege('authenticated', 'public.documents', 'archived_at', 'update'), 'archive only through archive_document()';
  assert not has_column_privilege('authenticated', 'public.documents', 'uploaded_by', 'insert'), 'uploader cannot be spoofed';
  assert not has_column_privilege('authenticated', 'public.document_versions', 'version_number', 'insert'), 'version number is assigned by the database';
  assert not has_function_privilege('anon', 'public.register_document(uuid, uuid, text, text, text, text, text, date, date, text, uuid, numeric, text, jsonb)', 'execute'), 'anon must not register';
  assert not has_function_privilege('anon', 'public.archive_document(uuid, text)', 'execute'), 'anon must not archive';
  assert (select public from storage.buckets where id = 'nexus-documents') = false, 'bucket must be private';
  assert (select file_size_limit from storage.buckets where id = 'nexus-documents') = 4194304, 'bucket size limit';
end;
$$;

-- 2. Specialist uploads a file and registers a document linked to the shipment ---------

select tests.act_as('a0000000-0000-4000-8000-000000000003');
set role authenticated;

insert into storage.objects (bucket_id, name, owner_id, metadata) values
  ('nexus-documents', 'documents/d0000000-0000-4000-8000-000000000001/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-invoice.pdf',
   'a0000000-0000-4000-8000-000000000003', '{"size": 2048, "mimetype": "application/pdf"}');

select public.register_document(
  'd0000000-0000-4000-8000-000000000001',
  (select id from public.document_types where code = 'invoice'),
  'Инвойс поставщика',
  'documents/d0000000-0000-4000-8000-000000000001/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-invoice.pdf',
  'Инвойс №1.pdf',
  p_document_number => 'INV-1',
  p_document_date => '2026-09-01',
  p_language => 'ru',
  p_checksum_sha256 => repeat('a', 64),
  p_links => '[{"entity_type": "shipment", "entity_id": "c0000000-0000-4000-8000-000000000001", "link_role": "primary"}]'
);

do $$
declare
  v_doc public.documents%rowtype;
begin
  select * into v_doc from public.documents where id = 'd0000000-0000-4000-8000-000000000001';
  assert v_doc.current_version = 1, 'first version must be 1';
  assert v_doc.file_size_bytes = 2048, 'size must come from the Storage object';
  assert v_doc.mime_type = 'application/pdf', 'MIME type must come from the Storage object';
  assert v_doc.uploaded_by = 'a0000000-0000-4000-8000-000000000003', 'uploader recorded';
  assert v_doc.original_filename = 'Инвойс №1.pdf', 'original file name kept';
  assert (select count(*) from public.document_links where document_id = v_doc.id) = 1, 'shipment link created';
  assert (select count(*) from public.document_versions where document_id = v_doc.id and is_current) = 1, 'one current version';
end;
$$;

-- 3. The Storage path and the file cannot be chosen freely -------------------------------

-- Path of another document.
insert into storage.objects (bucket_id, name, owner_id, metadata) values
  ('nexus-documents', 'documents/d0000000-0000-4000-8000-000000000099/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-other.pdf',
   'a0000000-0000-4000-8000-000000000003', '{"size": 100, "mimetype": "application/pdf"}');
select tests.expect_error($$
  select public.register_document('d0000000-0000-4000-8000-000000000002',
    (select id from public.document_types where code = 'cmr'), 'CMR',
    'documents/d0000000-0000-4000-8000-000000000099/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-other.pdf', 'cmr.pdf')
$$, 'Недопустимый путь');

-- Path traversal and a path outside the documents folder.
select tests.expect_error($$
  select public.register_document('d0000000-0000-4000-8000-000000000002',
    (select id from public.document_types where code = 'cmr'), 'CMR',
    'documents/d0000000-0000-4000-8000-000000000002/../../secret.pdf', 'cmr.pdf')
$$, 'Файл не найден|path_format');

-- File that was never uploaded.
select tests.expect_error($$
  select public.register_document('d0000000-0000-4000-8000-000000000002',
    (select id from public.document_types where code = 'cmr'), 'CMR',
    'documents/d0000000-0000-4000-8000-000000000002/cccccccccccccccccccccccccccccccc-cmr.pdf', 'cmr.pdf')
$$, 'Файл не найден');

-- Upload outside the allowed path pattern is rejected by the Storage policy.
select tests.expect_error($$
  insert into storage.objects (bucket_id, name, owner_id, metadata) values
    ('nexus-documents', 'public/evil.pdf', 'a0000000-0000-4000-8000-000000000003', '{}')
$$, 'row-level security');
select tests.expect_error($$
  insert into storage.objects (bucket_id, name, owner_id, metadata) values
    ('nexus-documents', 'documents/d0000000-0000-4000-8000-000000000002/../x.pdf',
     'a0000000-0000-4000-8000-000000000003', '{}')
$$, 'row-level security');

-- A document without a file is rejected when the transaction commits.
do $$
begin
  begin
    insert into public.documents (id, document_type_id, title)
    values ('d0000000-0000-4000-8000-000000000009',
            (select id from public.document_types where code = 'other'), 'Без файла');
    set constraints all immediate;
    raise exception 'document without file was accepted' using errcode = 'P0099';
  exception
    when sqlstate 'P0099' then raise;
    when others then assert sqlerrm ~ 'вместе с файлом', sqlerrm;
  end;
end;
$$;

reset role;

-- A file uploaded by another user cannot be registered.
select tests.act_as('a0000000-0000-4000-8000-000000000002');
set role authenticated;
insert into storage.objects (bucket_id, name, owner_id, metadata) values
  ('nexus-documents', 'documents/d0000000-0000-4000-8000-000000000003/dddddddddddddddddddddddddddddddd-cmr.pdf',
   'a0000000-0000-4000-8000-000000000002', '{"size": 300, "mimetype": "application/pdf"}');
reset role;

select tests.act_as('a0000000-0000-4000-8000-000000000003');
set role authenticated;
select tests.expect_error($$
  select public.register_document('d0000000-0000-4000-8000-000000000003',
    (select id from public.document_types where code = 'cmr'), 'CMR',
    'documents/d0000000-0000-4000-8000-000000000003/dddddddddddddddddddddddddddddddd-cmr.pdf', 'cmr.pdf')
$$, 'другим пользователем');

-- 4. Metadata can be edited, file and archive columns cannot ------------------------------

do $$
begin
  assert tests.affected($q$update public.documents set title = 'Инвойс (исправлен)'
    where id = 'd0000000-0000-4000-8000-000000000001'$q$) = 1, 'specialist edits metadata';
end;
$$;
select tests.expect_error($$
  update public.documents set storage_path = 'documents/x' where id = 'd0000000-0000-4000-8000-000000000001'
$$, 'permission denied');
select tests.expect_error($$
  update public.documents set archived_at = now() where id = 'd0000000-0000-4000-8000-000000000001'
$$, 'permission denied');
-- Status changes only through the approval workflow (202609271600 revokes update (status)).
select tests.expect_error($$
  update public.documents set status = 'approved' where id = 'd0000000-0000-4000-8000-000000000001'
$$, 'permission denied');
select tests.expect_error($$
  update public.documents set status = 'lost' where id = 'd0000000-0000-4000-8000-000000000001'
$$, 'permission denied');

-- 5. New version ----------------------------------------------------------------------

insert into storage.objects (bucket_id, name, owner_id, metadata) values
  ('nexus-documents', 'documents/d0000000-0000-4000-8000-000000000001/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-invoice-v2.pdf',
   'a0000000-0000-4000-8000-000000000003', '{"size": 4096, "mimetype": "application/pdf"}');

select tests.expect_error($$
  insert into public.document_versions (document_id, version_number, storage_path, original_filename)
  values ('d0000000-0000-4000-8000-000000000001', 7,
    'documents/d0000000-0000-4000-8000-000000000001/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-invoice-v2.pdf', 'v2.pdf')
$$, 'permission denied');

insert into public.document_versions (document_id, storage_path, original_filename, checksum_sha256, comment)
values ('d0000000-0000-4000-8000-000000000001',
  'documents/d0000000-0000-4000-8000-000000000001/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-invoice-v2.pdf',
  'Инвойс v2.pdf', repeat('b', 64), 'Исправлена сумма');

do $$
begin
  assert (select current_version from public.documents where id = 'd0000000-0000-4000-8000-000000000001') = 2, 'document points to version 2';
  assert (select file_size_bytes from public.documents where id = 'd0000000-0000-4000-8000-000000000001') = 4096, 'document shows the new file';
  assert (select version_number from public.document_versions
          where document_id = 'd0000000-0000-4000-8000-000000000001' and is_current) = 2, 'version 2 is current';
  assert (select count(*) from public.document_versions
          where document_id = 'd0000000-0000-4000-8000-000000000001') = 2, 'history keeps version 1';
end;
$$;

-- The same file cannot be added twice to one document.
insert into storage.objects (bucket_id, name, owner_id, metadata) values
  ('nexus-documents', 'documents/d0000000-0000-4000-8000-000000000001/ffffffffffffffffffffffffffffffff-invoice-v3.pdf',
   'a0000000-0000-4000-8000-000000000003', '{"size": 4096, "mimetype": "application/pdf"}');
select tests.expect_error($$
  insert into public.document_versions (document_id, storage_path, original_filename, checksum_sha256)
  values ('d0000000-0000-4000-8000-000000000001',
    'documents/d0000000-0000-4000-8000-000000000001/ffffffffffffffffffffffffffffffff-invoice-v3.pdf',
    'v3.pdf', repeat('b', 64))
$$, 'document_versions_same_file_once');

-- Versions are immutable.
select tests.expect_error($$
  update public.document_versions set comment = 'x' where document_id = 'd0000000-0000-4000-8000-000000000001'
$$, 'permission denied');
select tests.expect_error($$
  delete from public.document_versions where document_id = 'd0000000-0000-4000-8000-000000000001'
$$, 'permission denied');

-- 6. Links: validation, duplicates, soft removal ------------------------------------------

select tests.expect_error($$
  insert into public.document_links (document_id, entity_type, entity_id)
  values ('d0000000-0000-4000-8000-000000000001', 'shipment', 'c0000000-0000-4000-8000-000000000099')
$$, 'не найден');
select tests.expect_error($$
  insert into public.document_links (document_id, entity_type, entity_id)
  values ('d0000000-0000-4000-8000-000000000001', 'batch', 'c0000000-0000-4000-8000-000000000001')
$$, 'entity_type_check|Недопустимый тип связанного объекта');
select tests.expect_error($$
  insert into public.document_links (document_id, entity_type, entity_id)
  values ('d0000000-0000-4000-8000-000000000001', 'customer_return', 'c0000000-0000-4000-8000-000000000001')
$$, 'не найден');  -- returns exist since 202609277500: an unknown return is simply not found
select tests.expect_error($$
  insert into public.document_links (document_id, entity_type, entity_id)
  values ('d0000000-0000-4000-8000-000000000001', 'supplier', 'b0000000-0000-4000-8000-000000000002')
$$, 'не найден');
select tests.expect_error($$
  insert into public.document_links (document_id, entity_type, entity_id)
  values ('d0000000-0000-4000-8000-000000000001', 'shipment', 'c0000000-0000-4000-8000-000000000001')
$$, 'document_links_active_unique');

insert into public.document_links (document_id, entity_type, entity_id, link_role)
values ('d0000000-0000-4000-8000-000000000001', 'customer', 'b0000000-0000-4000-8000-000000000002', 'related');

do $$
begin
  assert tests.affected($q$update public.document_links set removed_at = now(), removed_by = auth.uid()
    where document_id = 'd0000000-0000-4000-8000-000000000001' and entity_type = 'customer'$q$) = 1, 'link removed';
  assert tests.affected($q$update public.document_links set removed_at = null, removed_by = null
    where document_id = 'd0000000-0000-4000-8000-000000000001' and entity_type = 'customer'$q$) = 0, 'removed link cannot be restored';
end;
$$;

-- Nobody may physically delete documents or links.
select tests.expect_error($$ delete from public.documents $$, 'permission denied');
select tests.expect_error($$ delete from public.document_links $$, 'permission denied');

-- 7. Archiving -----------------------------------------------------------------------

select tests.expect_error($$
  select public.archive_document('d0000000-0000-4000-8000-000000000001', 'Дубликат')
$$, 'Недостаточно прав');
reset role;

select tests.act_as('a0000000-0000-4000-8000-000000000002');
set role authenticated;
select tests.expect_error($$
  select public.archive_document('d0000000-0000-4000-8000-000000000001', '  ')
$$, 'причину');
select public.archive_document('d0000000-0000-4000-8000-000000000001', 'Заменён новым документом');
select tests.expect_error($$
  select public.archive_document('d0000000-0000-4000-8000-000000000001', 'Повторно')
$$, 'уже находится в архиве');
select tests.expect_error($$ delete from public.documents $$, 'permission denied');
reset role;

select tests.act_as('a0000000-0000-4000-8000-000000000003');
set role authenticated;
do $$
begin
  assert (select archived_at is not null from public.documents
          where id = 'd0000000-0000-4000-8000-000000000001'), 'archived document still visible';
  assert tests.affected($q$update public.documents set title = 'После архива'
    where id = 'd0000000-0000-4000-8000-000000000001'$q$) = 0, 'archived document is read-only';
end;
$$;
insert into storage.objects (bucket_id, name, owner_id, metadata) values
  ('nexus-documents', 'documents/d0000000-0000-4000-8000-000000000001/12345678901234567890123456789012-late.pdf',
   'a0000000-0000-4000-8000-000000000003', '{"size": 10, "mimetype": "application/pdf"}');
select tests.expect_error($$
  insert into public.document_versions (document_id, storage_path, original_filename)
  values ('d0000000-0000-4000-8000-000000000001',
    'documents/d0000000-0000-4000-8000-000000000001/12345678901234567890123456789012-late.pdf', 'late.pdf')
$$, 'архив');
select tests.expect_error($$
  insert into public.document_links (document_id, entity_type, entity_id)
  values ('d0000000-0000-4000-8000-000000000001', 'warehouse', (select id from public.warehouses where code = 'AKT'))
$$, 'row-level security');

-- 8. Storage objects: registered files are readable only with documents.view, never deletable

do $$
begin
  assert (select count(*) from storage.objects
          where name like 'documents/d0000000-0000-4000-8000-000000000001/aaaa%') = 1, 'specialist sees registered file';
  assert tests.affected($q$delete from storage.objects
    where name like 'documents/d0000000-0000-4000-8000-000000000001/aaaa%'$q$) = 0, 'registered file cannot be deleted';
  assert tests.affected($q$delete from storage.objects
    where name like 'documents/d0000000-0000-4000-8000-000000000001/1234%'$q$) = 1, 'own unregistered upload can be cleaned up';
end;
$$;
reset role;

-- 9. User without documents.view sees nothing ---------------------------------------------

select tests.act_as('a0000000-0000-4000-8000-000000000004');
set role authenticated;
do $$
begin
  assert (select count(*) from public.documents) = 0, 'marketer must not see documents';
  assert (select count(*) from public.document_versions) = 0, 'marketer must not see versions';
  assert (select count(*) from public.document_links) = 0, 'marketer must not see links';
  assert (select count(*) from storage.objects where bucket_id = 'nexus-documents') = 0, 'marketer must not see files';
  assert (public.my_document_permissions() ->> 'view')::boolean = false, 'permission flags reflect the role';
end;
$$;
select tests.expect_error($$
  insert into storage.objects (bucket_id, name, owner_id, metadata) values
    ('nexus-documents', 'documents/d0000000-0000-4000-8000-000000000005/abababababababababababababababab-x.pdf',
     'a0000000-0000-4000-8000-000000000004', '{}')
$$, 'row-level security');
select tests.expect_error($$
  select public.register_document('d0000000-0000-4000-8000-000000000005',
    (select id from public.document_types where code = 'other'), 'X',
    'documents/d0000000-0000-4000-8000-000000000005/abababababababababababababababab-x.pdf', 'x.pdf')
$$, 'Недостаточно прав');
reset role;

-- 10. External user: a personal documents.view override does not open employee data ------

select tests.act_as('a0000000-0000-4000-8000-000000000006');
set role authenticated;
do $$
begin
  assert (select count(*) from public.documents) = 0, 'external user must not see documents';
  assert (select count(*) from public.document_types) = 0, 'external user must not see the type catalogue';
end;
$$;
reset role;

-- 11. documents.create without view/update: only its own new document, in one transaction

select tests.act_as('a0000000-0000-4000-8000-000000000005');
set role authenticated;
insert into storage.objects (bucket_id, name, owner_id, metadata) values
  ('nexus-documents', 'documents/d0000000-0000-4000-8000-000000000006/cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd-cert.png',
   'a0000000-0000-4000-8000-000000000005', '{"size": 500, "mimetype": "image/png"}');
select public.register_document('d0000000-0000-4000-8000-000000000006',
  (select id from public.document_types where code = 'certificate'), 'Сертификат',
  'documents/d0000000-0000-4000-8000-000000000006/cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd-cert.png', 'cert.png',
  p_valid_until => '2027-01-31',
  p_links => '[{"entity_type": "supplier", "entity_id": "b0000000-0000-4000-8000-000000000001"}]');
do $$
begin
  assert (select count(*) from public.documents) = 0, 'create does not imply view';
end;
$$;
insert into storage.objects (bucket_id, name, owner_id, metadata) values
  ('nexus-documents', 'documents/d0000000-0000-4000-8000-000000000006/efefefefefefefefefefefefefefefef-cert2.png',
   'a0000000-0000-4000-8000-000000000005', '{"size": 600, "mimetype": "image/png"}');
select tests.expect_error($$
  insert into public.document_versions (document_id, storage_path, original_filename)
  values ('d0000000-0000-4000-8000-000000000006',
    'documents/d0000000-0000-4000-8000-000000000006/efefefefefefefefefefefefefefefef-cert2.png', 'cert2.png')
$$, 'Недостаточно прав|row-level security');
select tests.expect_error($$
  insert into public.document_links (document_id, entity_type, entity_id)
  values ('d0000000-0000-4000-8000-000000000006', 'shipment', 'c0000000-0000-4000-8000-000000000001')
$$, 'row-level security');
reset role;

-- 12. Types and requirements are changed only with their own permissions ------------------

select tests.act_as('a0000000-0000-4000-8000-000000000003');
set role authenticated;
select tests.expect_error($$
  insert into public.document_types (code, name_ru, category) values ('test_type', 'Тест', 'other')
$$, 'row-level security');
select tests.expect_error($$
  insert into public.document_requirements (document_type_id)
  values ((select id from public.document_types where code = 'other'))
$$, 'row-level security');
reset role;

select tests.act_as('a0000000-0000-4000-8000-000000000001');
set role authenticated;
insert into public.document_types (code, name_ru, category) values ('test_type', 'Тест', 'other');
select tests.expect_error($$
  update public.document_types set code = 'renamed' where code = 'test_type'
$$, 'permission denied');
insert into public.document_requirements (document_type_id, shipment_type, is_mandatory)
values ((select id from public.document_types where code = 'test_type'), 'export', false);
do $$
begin
  assert (public.my_document_permissions() ->> 'manage_types')::boolean, 'administrator manages types';
end;
$$;
reset role;

-- 13. Audit trail and seeds ---------------------------------------------------------

do $$
begin
  assert (select count(*) from public.audit_log where entity_type = 'documents'
          and after_data ->> 'archived_at' is not null
          and actor_user_id = 'a0000000-0000-4000-8000-000000000002') >= 1, 'archiving is audited with the actor';
  assert (select count(*) from public.audit_log where entity_type = 'document_versions') >= 3, 'versions are audited';
  assert (select count(*) from public.audit_log where entity_type = 'document_links'
          and after_data ->> 'removed_at' is not null) = 1, 'link removal is audited';
  assert (select count(*) from public.document_types where code in (
    'invoice', 'specification', 'packing_list', 'cmr', 'ttn', 'snt', 'waybill', 'customs_document',
    'certificate', 'supplier_contract', 'customer_contract', 'guarantee_letter', 'return_document',
    'marking_document', 'other')) = 15, 'all document types seeded';
  assert (select count(*) from public.document_requirements
          where notes like 'Предварительно%') = 6, 'requirements seeded once despite re-run';
end;
$$;

\echo 'documents_rls: all checks passed'
