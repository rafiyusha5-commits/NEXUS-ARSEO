-- RLS, status and version tests for document templates and product listing cards
-- (migration 202609271600). Run with scripts/test-db.sh. Every statement runs in its own
-- transaction as the role and user that the comment names.

\set ON_ERROR_STOP 1

create schema if not exists tests;
grant usage on schema tests to authenticated;

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
  ('e0000000-0000-4000-8000-000000000001', 'tl-director@test.local', '{"full_name":"Директор"}'),
  ('e0000000-0000-4000-8000-000000000002', 'tl-admin@test.local', '{"full_name":"Администратор"}'),
  ('e0000000-0000-4000-8000-000000000003', 'tl-commercial@test.local', '{"full_name":"Коммерческий директор"}'),
  ('e0000000-0000-4000-8000-000000000004', 'tl-specialist@test.local', '{"full_name":"Специалист"}'),
  ('e0000000-0000-4000-8000-000000000005', 'tl-executive@test.local', '{"full_name":"Исполнительный директор"}');

insert into public.user_roles (user_id, role_id)
select u.id::uuid, r.id
from (values
  ('e0000000-0000-4000-8000-000000000001', 'director'),
  ('e0000000-0000-4000-8000-000000000002', 'administrator'),
  ('e0000000-0000-4000-8000-000000000003', 'commercial_director'),
  ('e0000000-0000-4000-8000-000000000004', 'logistics_specialist'),
  ('e0000000-0000-4000-8000-000000000005', 'executive_director')
) as u(id, role_code)
join public.app_roles r on r.code = u.role_code;

insert into public.counterparties (id, roles, legal_name, country) values
  ('f0000000-0000-4000-8000-000000000001', array['customer'], 'ТОО Сеть магазинов', 'KZ'),
  ('f0000000-0000-4000-8000-000000000002', array['manufacturer', 'supplier'], 'Candy Oy', 'FI');

insert into public.products (id, internal_sku, name, manufacturer_id, status) values
  ('f1000000-0000-4000-8000-000000000001', 'TL-001', '{"ru":"Конфеты 200 г"}', 'f0000000-0000-4000-8000-000000000002', 'active'),
  ('f1000000-0000-4000-8000-000000000002', 'TL-002', '{"ru":"Шоколад 100 г"}', 'f0000000-0000-4000-8000-000000000002', 'active');

-- 1. Grants follow the roles matrix; no privileges for anon or service_role ------------

do $$
declare
  v_has boolean;
begin
  assert not has_table_privilege('anon', 'public.document_templates', 'select'), 'anon must not read templates';
  assert not has_table_privilege('service_role', 'public.product_listing_cards', 'select'), 'service_role gets no extra privileges';
  assert not has_table_privilege('authenticated', 'public.document_templates', 'delete'), 'templates are archived, not deleted';
  assert not has_table_privilege('authenticated', 'public.document_template_versions', 'update'), 'template versions are immutable';
  assert not has_table_privilege('authenticated', 'public.product_listing_cards', 'delete'), 'cards are cancelled, not deleted';
  foreach v_has in array array[
    has_column_privilege('authenticated', 'public.document_templates', 'status', 'update'),
    has_column_privilege('authenticated', 'public.document_templates', 'approved_by', 'update'),
    has_column_privilege('authenticated', 'public.document_templates', 'created_by', 'insert'),
    has_column_privilege('authenticated', 'public.document_template_versions', 'uploaded_by', 'insert'),
    has_column_privilege('authenticated', 'public.document_template_versions', 'version_number', 'insert'),
    has_column_privilege('authenticated', 'public.product_listing_cards', 'status', 'update'),
    has_column_privilege('authenticated', 'public.product_listing_cards', 'decided_by', 'update'),
    has_column_privilege('authenticated', 'public.product_listing_cards', 'version', 'insert'),
    has_column_privilege('authenticated', 'public.product_listing_cards', 'previous_version_id', 'insert'),
    has_column_privilege('authenticated', 'public.product_listing_cards', 'created_by', 'insert'),
    has_column_privilege('authenticated', 'public.product_listing_card_items', 'created_by', 'insert'),
    has_column_privilege('authenticated', 'public.product_listing_card_items', 'card_id', 'update')
  ] loop
    assert not v_has, 'system columns must not be writable by users';
  end loop;
  assert not has_sequence_privilege('authenticated', 'public.product_listing_card_number_seq', 'usage'), 'card numbers are assigned by the database';
end;
$$;

-- Permission flags per role (docs/roles-permissions.md sections 3 and 12).
select tests.act_as('e0000000-0000-4000-8000-000000000004');
set role authenticated;
do $$
begin
  assert public.my_permissions(array['templates.view', 'templates.export', 'templates.create', 'listing_cards.view', 'listing_cards.create'])
    = array['listing_cards.view', 'templates.view'], 'logistics specialist only views';
end;
$$;
reset role;
select tests.act_as('e0000000-0000-4000-8000-000000000003');
set role authenticated;
do $$
begin
  assert public.my_permissions(array['listing_cards.create', 'listing_cards.approve', 'listing_cards.change_status', 'templates.approve'])
    = array['listing_cards.approve', 'listing_cards.change_status'], 'commercial director decides but does not create';
end;
$$;
reset role;

-- 2. Templates: create with file, versions, approval ------------------------------------

select tests.act_as('e0000000-0000-4000-8000-000000000002');
set role authenticated;
insert into storage.objects (bucket_id, name, owner_id, metadata) values
  ('nexus-documents', 'templates/a1000000-0000-4000-8000-000000000001/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-karta-vvoda.docx',
   'e0000000-0000-4000-8000-000000000002',
   '{"size": 12000, "mimetype": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}');
select public.register_document_template(
  'a1000000-0000-4000-8000-000000000001',
  (select id from public.document_types where code = 'other'),
  'Карта ввода сети',
  'ru',
  'templates/a1000000-0000-4000-8000-000000000001/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-karta-vvoda.docx',
  'Карта ввода.docx',
  p_purpose => 'Форма клиента для ввода товаров',
  p_counterparty_id => 'f0000000-0000-4000-8000-000000000001',
  p_variables_schema => '{"fields": [{"key": "product_name", "label": "Наименование"}]}'
);

do $$
declare
  v_template public.document_templates%rowtype;
begin
  select * into v_template from public.document_templates where id = 'a1000000-0000-4000-8000-000000000001';
  assert v_template.status = 'draft', 'new template is a draft';
  assert v_template.current_version = 1, 'first version';
  assert v_template.created_by = 'e0000000-0000-4000-8000-000000000002', 'author set by the database';
  assert (select file_size_bytes from public.document_template_versions
          where template_id = v_template.id and is_current) = 12000, 'size taken from Storage';
end;
$$;

-- A template without a file is rejected at commit.
do $$
begin
  begin
    insert into public.document_templates (id, document_type_id, name, language)
    values ('a1000000-0000-4000-8000-000000000009', (select id from public.document_types where code = 'other'), 'Без файла', 'ru');
    set constraints all immediate;
    raise exception 'template without file was accepted' using errcode = 'P0099';
  exception
    when sqlstate 'P0099' then raise;
    when others then assert sqlerrm ~ 'вместе с файлом', sqlerrm;
  end;
end;
$$;

-- Users cannot set status or approver themselves.
select tests.expect_error($$
  update public.document_templates set status = 'approved' where id = 'a1000000-0000-4000-8000-000000000001'
$$, 'permission denied');
select tests.expect_error($$
  update public.document_templates set approved_by = auth.uid() where id = 'a1000000-0000-4000-8000-000000000001'
$$, 'permission denied');
-- Administrator may not approve templates (matrix: Адм — З).
select tests.expect_error($$
  select public.approve_document_template('a1000000-0000-4000-8000-000000000001')
$$, 'Недостаточно прав');
-- Template files are stored only under templates/<template id>/.
select tests.expect_error($$
  insert into storage.objects (bucket_id, name, owner_id, metadata) values
    ('nexus-documents', 'templates/../documents/x.docx', 'e0000000-0000-4000-8000-000000000002', '{}')
$$, 'row-level security');
reset role;

select tests.act_as('e0000000-0000-4000-8000-000000000005');
set role authenticated;
select public.approve_document_template('a1000000-0000-4000-8000-000000000001');
do $$
begin
  assert (select status = 'approved' and approved_by = 'e0000000-0000-4000-8000-000000000005'
          from public.document_templates where id = 'a1000000-0000-4000-8000-000000000001'), 'executive director approves';
end;
$$;
select tests.expect_error($$
  select public.approve_document_template('a1000000-0000-4000-8000-000000000001')
$$, 'не является черновиком');
reset role;

-- Renaming keeps the approval; changing the fields resets it.
select tests.act_as('e0000000-0000-4000-8000-000000000002');
set role authenticated;
update public.document_templates set name = 'Карта ввода сети (2026)' where id = 'a1000000-0000-4000-8000-000000000001';
do $$
begin
  assert (select status from public.document_templates where id = 'a1000000-0000-4000-8000-000000000001') = 'approved', 'rename keeps approval';
end;
$$;
update public.document_templates set variables_schema = '{"fields": []}' where id = 'a1000000-0000-4000-8000-000000000001';
do $$
begin
  assert (select status = 'draft' and approved_by is null
          from public.document_templates where id = 'a1000000-0000-4000-8000-000000000001'), 'field change resets approval';
end;
$$;
reset role;

select tests.act_as('e0000000-0000-4000-8000-000000000001');
set role authenticated;
select public.approve_document_template('a1000000-0000-4000-8000-000000000001');
reset role;

-- A new file version keeps the history and requires a new approval.
select tests.act_as('e0000000-0000-4000-8000-000000000002');
set role authenticated;
insert into storage.objects (bucket_id, name, owner_id, metadata) values
  ('nexus-documents', 'templates/a1000000-0000-4000-8000-000000000001/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-karta-v2.docx',
   'e0000000-0000-4000-8000-000000000002',
   '{"size": 13000, "mimetype": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}');
insert into public.document_template_versions (template_id, storage_path, original_filename, comment)
values ('a1000000-0000-4000-8000-000000000001',
  'templates/a1000000-0000-4000-8000-000000000001/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-karta-v2.docx',
  'Карта ввода v2.docx', 'Новые поля сети');
do $$
begin
  assert (select current_version = 2 and status = 'draft' and approved_by is null
          from public.document_templates where id = 'a1000000-0000-4000-8000-000000000001'), 'new file resets approval';
  assert (select count(*) from public.document_template_versions
          where template_id = 'a1000000-0000-4000-8000-000000000001') = 2, 'history kept';
  assert (select version_number from public.document_template_versions
          where template_id = 'a1000000-0000-4000-8000-000000000001' and is_current) = 2, 'version 2 is current';
end;
$$;
select tests.expect_error($$
  delete from public.document_template_versions where template_id = 'a1000000-0000-4000-8000-000000000001'
$$, 'permission denied');
-- A registered template file cannot be deleted from Storage, even by its uploader.
do $$
begin
  assert tests.affected($q$delete from storage.objects
    where name like 'templates/a1000000-0000-4000-8000-000000000001/%'$q$) = 0, 'registered template files are kept';
end;
$$;
reset role;

-- The logistics specialist sees the catalogue but cannot download or change templates.
select tests.act_as('e0000000-0000-4000-8000-000000000004');
set role authenticated;
do $$
begin
  assert (select count(*) from public.document_templates where id = 'a1000000-0000-4000-8000-000000000001') = 1, 'catalogue visible';
  assert (select count(*) from storage.objects where name like 'templates/%') = 0, 'template files not downloadable without templates.export';
  assert tests.affected($q$update public.document_templates set name = 'X'
    where id = 'a1000000-0000-4000-8000-000000000001'$q$) = 0, 'no templates.update';
end;
$$;
select tests.expect_error($$
  select public.archive_document_template('a1000000-0000-4000-8000-000000000001', 'Не нужен')
$$, 'Недостаточно прав');
reset role;

select tests.act_as('e0000000-0000-4000-8000-000000000003');
set role authenticated;
do $$
begin
  assert (select count(*) from storage.objects where name like 'templates/a1000000-0000-4000-8000-000000000001/%') = 2,
    'users with templates.export can read registered template files';
end;
$$;
reset role;

-- 3. Listing cards: create, items, status graph ------------------------------------------

select tests.act_as('e0000000-0000-4000-8000-000000000003');
set role authenticated;
-- The commercial director has no listing_cards.create ("ОР" in the matrix).
select tests.expect_error($$
  insert into public.product_listing_cards (card_type, customer_id) values ('input', 'f0000000-0000-4000-8000-000000000001')
$$, 'row-level security');
reset role;

select tests.act_as('e0000000-0000-4000-8000-000000000002');
set role authenticated;
select tests.expect_error($$
  insert into public.product_listing_cards (card_type, customer_id) values ('input', 'f0000000-0000-4000-8000-000000000002')
$$, 'не является клиентом');
select tests.expect_error($$
  insert into public.product_listing_cards (card_type, customer_id, status)
  values ('input', 'f0000000-0000-4000-8000-000000000001', 'approved_by_customer')
$$, 'permission denied');
-- Only an approved, active template can be attached (template 1 is a draft after v2).
select tests.expect_error($$
  insert into public.product_listing_cards (card_type, customer_id, template_id)
  values ('input', 'f0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001')
$$, 'не утверждён');
insert into public.product_listing_cards (id, card_type, customer_id, template_id, title, effective_date)
values ('c1000000-0000-4000-8000-000000000001', 'input', 'f0000000-0000-4000-8000-000000000001', null,
        'Ввод новинок осень', '2026-10-15');
do $$
declare
  v_card public.product_listing_cards%rowtype;
begin
  select * into v_card from public.product_listing_cards where id = 'c1000000-0000-4000-8000-000000000001';
  assert v_card.version = 1 and v_card.status = 'draft', 'new card is version 1 draft';
  assert v_card.root_card_id = v_card.id, 'root of version 1 is itself';
  assert v_card.card_number ~ '^LC-\d{4}-\d{5}$', 'card number assigned by the database';
  assert v_card.created_by = 'e0000000-0000-4000-8000-000000000002', 'author set by the database';
end;
$$;

select tests.expect_error($$
  select public.submit_listing_card('c1000000-0000-4000-8000-000000000001')
$$, 'нет позиций');

insert into public.product_listing_card_items (card_id, product_id, required_quantity, uom, customer_sku, price, currency_id)
values ('c1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 120, 'box', 'SKU-777', 1500,
        (select id from public.currencies where code = 'KZT'));
insert into public.product_listing_card_items (card_id, product_id, required_quantity)
values ('c1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002', 48);
select tests.expect_error($$
  insert into public.product_listing_card_items (card_id, product_id, required_quantity)
  values ('c1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 1)
$$, 'product_once');
select tests.expect_error($$
  insert into public.product_listing_card_items (card_id, product_id, required_quantity)
  values ('c1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 0)
$$, 'required_quantity_check|product_once');
select tests.expect_error($$
  update public.product_listing_card_items set price = 10, currency_id = null
  where card_id = 'c1000000-0000-4000-8000-000000000001' and customer_sku is null
$$, 'price_currency');

select public.submit_listing_card('c1000000-0000-4000-8000-000000000001');

-- A submitted card and its items are read-only, even for editors.
do $$
begin
  assert tests.affected($q$update public.product_listing_cards set notes = 'после отправки'
    where id = 'c1000000-0000-4000-8000-000000000001'$q$) = 0, 'submitted card is not editable';
  assert tests.affected($q$delete from public.product_listing_card_items
    where card_id = 'c1000000-0000-4000-8000-000000000001'$q$) = 0, 'submitted items cannot be removed';
end;
$$;
select tests.expect_error($$
  insert into public.product_listing_card_items (card_id, product_id, required_quantity)
  values ('c1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000001', 5)
$$, 'row-level security|черновике');
-- Administrator cannot record the customer's decision (matrix: Адм — З).
select tests.expect_error($$
  select public.record_listing_card_decision('c1000000-0000-4000-8000-000000000001', 'approved')
$$, 'Недостаточно прав');
reset role;

select tests.act_as('e0000000-0000-4000-8000-000000000003');
set role authenticated;
select tests.expect_error($$
  select public.record_listing_card_decision('c1000000-0000-4000-8000-000000000001', 'rejected', '  ')
$$, 'причину отказа');
select public.record_listing_card_decision('c1000000-0000-4000-8000-000000000001', 'approved', 'Клиент подписал');
reset role;

-- 4. An approved card is immutable, even for the database owner --------------------------

do $$
begin
  assert (select status = 'approved_by_customer' and decided_by = 'e0000000-0000-4000-8000-000000000003'
          from public.product_listing_cards where id = 'c1000000-0000-4000-8000-000000000001'), 'decision recorded';
  begin
    update public.product_listing_cards set notes = 'правка утверждённой'
    where id = 'c1000000-0000-4000-8000-000000000001';
    raise exception 'approved card was changed' using errcode = 'P0099';
  exception
    when sqlstate 'P0099' then raise;
    when others then assert sqlerrm ~ 'не редактируется', sqlerrm;
  end;
  begin
    update public.product_listing_card_items set required_quantity = 1
    where card_id = 'c1000000-0000-4000-8000-000000000001';
    raise exception 'approved card item was changed' using errcode = 'P0099';
  exception
    when sqlstate 'P0099' then raise;
    when others then assert sqlerrm ~ 'черновике', sqlerrm;
  end;
  begin
    update public.product_listing_cards set status = 'draft'
    where id = 'c1000000-0000-4000-8000-000000000001';
    raise exception 'approved card returned to draft' using errcode = 'P0099';
  exception
    when sqlstate 'P0099' then raise;
    when others then assert sqlerrm ~ 'Недопустимый переход', sqlerrm;
  end;
end;
$$;

-- 5. New version: copy, link to the previous one, supersede on approval -------------------

select tests.act_as('e0000000-0000-4000-8000-000000000002');
set role authenticated;
select public.create_listing_card_version('c1000000-0000-4000-8000-000000000001');
select tests.expect_error($$
  select public.create_listing_card_version('c1000000-0000-4000-8000-000000000001')
$$, 'уже есть следующая версия');
do $$
declare
  v_new public.product_listing_cards%rowtype;
begin
  select * into v_new from public.product_listing_cards where previous_version_id = 'c1000000-0000-4000-8000-000000000001';
  assert v_new.version = 2 and v_new.status = 'draft', 'version 2 is a draft';
  assert v_new.card_number = (select card_number from public.product_listing_cards where id = 'c1000000-0000-4000-8000-000000000001'), 'number kept';
  assert v_new.root_card_id = 'c1000000-0000-4000-8000-000000000001', 'same chain';
  assert (select count(*) from public.product_listing_card_items where card_id = v_new.id) = 2, 'items copied';
  assert tests.affected(format($q$update public.product_listing_card_items set required_quantity = 150
    where card_id = %L and required_quantity = 120$q$, v_new.id)) = 1, 'draft version is editable';
  perform public.submit_listing_card(v_new.id);
end;
$$;
reset role;

select tests.act_as('e0000000-0000-4000-8000-000000000003');
set role authenticated;
select public.record_listing_card_decision(
  (select id from public.product_listing_cards where previous_version_id = 'c1000000-0000-4000-8000-000000000001'),
  'approved', null);
reset role;

do $$
begin
  assert (select status from public.product_listing_cards where id = 'c1000000-0000-4000-8000-000000000001') = 'superseded',
    'previous approved version is superseded';
  assert (select count(*) from public.product_listing_cards
          where root_card_id = 'c1000000-0000-4000-8000-000000000001' and status = 'approved_by_customer') = 1,
    'exactly one approved version per chain';
  assert (select required_quantity from public.product_listing_card_items
          where card_id = 'c1000000-0000-4000-8000-000000000001' and uom = 'box') = 120,
    'previous version items unchanged';
end;
$$;

-- 6. Cancel, visibility, deletion ---------------------------------------------------------

select tests.act_as('e0000000-0000-4000-8000-000000000002');
set role authenticated;
insert into public.product_listing_cards (id, card_type, customer_id)
values ('c1000000-0000-4000-8000-000000000002', 'output', 'f0000000-0000-4000-8000-000000000001');
select tests.expect_error($$
  select public.cancel_listing_card('c1000000-0000-4000-8000-000000000002', '')
$$, 'причину');
select public.cancel_listing_card('c1000000-0000-4000-8000-000000000002', 'Клиент отказался от вывода');
select tests.expect_error($$
  select public.cancel_listing_card('c1000000-0000-4000-8000-000000000002', 'Повторно')
$$, 'только черновик');
select tests.expect_error($$ delete from public.product_listing_cards $$, 'permission denied');
select tests.expect_error($$ delete from public.document_templates $$, 'permission denied');
reset role;

-- The logistics specialist sees cards but changes nothing.
select tests.act_as('e0000000-0000-4000-8000-000000000004');
set role authenticated;
do $$
begin
  assert (select count(*) from public.product_listing_cards where root_card_id = 'c1000000-0000-4000-8000-000000000001') = 2,
    'cards visible with listing_cards.view';
end;
$$;
select tests.expect_error($$
  select public.create_listing_card_version((select id from public.product_listing_cards
    where root_card_id = 'c1000000-0000-4000-8000-000000000001' and status = 'approved_by_customer'))
$$, 'Недостаточно прав');
reset role;

-- 7. Document storage policies are limited to documents/ -----------------------------------

do $$
begin
  assert exists (
    select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'nexus documents: remove own unregistered upload'
      and qual like '%documents/%'
  ), 'document delete policy is scoped to documents/';
  assert (select count(*) from public.audit_log where entity_type = 'product_listing_cards'
          and after_data ->> 'status' = 'approved_by_customer') >= 2, 'decisions are audited';
  assert (select count(*) from public.audit_log where entity_type = 'document_templates'
          and after_data ->> 'status' = 'approved') >= 2, 'template approvals are audited';
end;
$$;

\echo 'templates_listing_cards: all checks passed'
