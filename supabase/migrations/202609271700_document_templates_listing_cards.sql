-- Phase 3 (continued): document templates with file versions, and customer product
-- listing cards (ввод / вывод товара) with versions and items.
--
-- Idempotent: objects are created with "if not exists", "create or replace" or are
-- dropped before re-creation; seed rows never overwrite later administrator changes.
-- Does not modify earlier migrations. Details: docs/templates-listing-cards.md.
--
-- Security model:
--   * RLS on every new table; anon and service_role get no privileges on them;
--   * authenticated gets column-level INSERT/UPDATE only on user-editable columns:
--     created_by, uploaded_by, approved_by, decided_by, status, version numbers and
--     archive fields are set by triggers or SECURITY DEFINER functions only;
--   * status rules (allowed transitions, no editing outside "draft", no editing of an
--     approved card) are enforced by triggers, so they also hold for direct API calls;
--   * template files live in the existing private bucket nexus-documents under
--     templates/<template id>/<random>-<safe name>, downloadable only via signed URLs.

-- 1. Permissions ---------------------------------------------------------------------

insert into public.permissions (code, module, action, name, description) values
  ('templates.view', 'templates', 'view', 'Шаблоны: просмотр', 'Каталог шаблонов документов и карточки шаблонов'),
  ('templates.create', 'templates', 'create', 'Шаблоны: создание', 'Создание шаблона с первой версией файла'),
  ('templates.update', 'templates', 'update', 'Шаблоны: изменение', 'Изменение названия, назначения, языка и полей шаблона'),
  ('templates.upload', 'templates', 'upload', 'Шаблоны: загрузка версий', 'Загрузка новой версии файла шаблона'),
  ('templates.archive', 'templates', 'archive', 'Шаблоны: архивирование', 'Перенос шаблона в архив без удаления'),
  ('templates.approve', 'templates', 'approve', 'Шаблоны: утверждение', 'Утверждение текущей версии шаблона'),
  ('templates.change_status', 'templates', 'change_status', 'Шаблоны: включение', 'Включение и отключение шаблона'),
  ('templates.export', 'templates', 'export', 'Шаблоны: скачивание', 'Скачивание файла шаблона'),
  ('listing_cards.view', 'listing_cards', 'view', 'Карты ввода/вывода: просмотр', 'Просмотр карт ввода и вывода товаров'),
  ('listing_cards.create', 'listing_cards', 'create', 'Карты ввода/вывода: создание', 'Создание карты и её новых версий'),
  ('listing_cards.update', 'listing_cards', 'update', 'Карты ввода/вывода: изменение', 'Изменение черновика карты и его позиций'),
  ('listing_cards.archive', 'listing_cards', 'archive', 'Карты ввода/вывода: отмена', 'Отмена черновика или отправленной карты'),
  ('listing_cards.approve', 'listing_cards', 'approve', 'Карты ввода/вывода: решение клиента', 'Фиксация решения клиента по карте'),
  ('listing_cards.change_status', 'listing_cards', 'change_status', 'Карты ввода/вывода: отправка', 'Отправка карты клиенту')
on conflict (code) do update
  set name = excluded.name, description = excluded.description;

-- Grants follow docs/roles-permissions.md: section 12 (Шаблоны) for document templates
-- and section 3 (Клиенты) for listing cards. Only "Р" cells are granted; "ОР" cells are
-- opened per user with user_permission_overrides; "О" cells are not granted because
-- has_permission() does not enforce scope yet. "on conflict do nothing" keeps later
-- administrator changes when the migration is re-run.
insert into public.role_permissions (role_id, permission_id, granted)
select role.id, permission.id, true
from (values
  ('templates.view', array['director','executive_director','commercial_director','logistics_director','senior_logistics_manager','logistics_specialist','accountant','marketer','administrator']),
  ('templates.export', array['director','executive_director','commercial_director','logistics_director','senior_logistics_manager','accountant','marketer','administrator']),
  ('templates.create', array['director','administrator']),
  ('templates.update', array['director','administrator']),
  ('templates.upload', array['director','administrator']),
  ('templates.archive', array['director','administrator']),
  ('templates.approve', array['director','executive_director']),
  ('templates.change_status', array['director','administrator']),
  ('listing_cards.view', array['director','executive_director','commercial_director','logistics_director','senior_logistics_manager','logistics_specialist','accountant','marketer','administrator']),
  ('listing_cards.create', array['director','administrator']),
  ('listing_cards.update', array['director','administrator']),
  ('listing_cards.archive', array['director','administrator']),
  ('listing_cards.approve', array['director','executive_director','commercial_director']),
  ('listing_cards.change_status', array['director','executive_director','commercial_director','administrator'])
) as grants(code, role_codes)
join public.permissions permission on permission.code = grants.code
join public.app_roles role on role.code = any(grants.role_codes)
on conflict (role_id, permission_id) do nothing;

-- 2. Tables ------------------------------------------------------------------------------

create table if not exists public.document_templates (
  id uuid primary key default gen_random_uuid(),
  document_type_id uuid not null references public.document_types(id) on delete restrict,
  name text not null check (length(btrim(name)) between 1 and 200),
  language text not null check (language in ('ru', 'kk', 'en')),
  purpose text check (purpose is null or length(purpose) <= 1000),
  counterparty_id uuid references public.counterparties(id) on delete restrict,
  variables_schema jsonb not null default '{}'::jsonb check (jsonb_typeof(variables_schema) = 'object'),
  status text not null default 'draft' check (status in ('draft', 'approved', 'archived')),
  is_active boolean not null default true,
  current_version integer not null default 0 check (current_version >= 0),
  approved_by uuid references public.profiles(id) on delete restrict,
  approved_at timestamptz,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references public.profiles(id) on delete restrict,
  archive_reason text,
  constraint document_templates_approval_consistent check (
    status <> 'approved' or (approved_by is not null and approved_at is not null)
  ),
  constraint document_templates_archive_consistent check (
    (status = 'archived') = (archived_at is not null)
    and ((archived_at is null and archived_by is null and archive_reason is null)
      or (archived_at is not null and archived_by is not null and length(btrim(archive_reason)) > 0))
  ),
  constraint document_templates_archived_inactive check (status <> 'archived' or not is_active)
);

create table if not exists public.document_template_versions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.document_templates(id) on delete restrict,
  version_number integer not null check (version_number > 0),
  storage_bucket text not null default 'nexus-documents' check (storage_bucket = 'nexus-documents'),
  storage_path text not null unique,
  original_filename text not null check (length(btrim(original_filename)) between 1 and 255),
  mime_type text not null check (mime_type in (
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/png'
  )),
  file_size_bytes bigint not null check (file_size_bytes > 0 and file_size_bytes <= 4194304),
  checksum_sha256 text check (checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-f]{64}$'),
  comment text check (comment is null or length(comment) <= 1000),
  is_current boolean not null default true,
  uploaded_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  uploaded_at timestamptz not null default now(),
  constraint document_template_versions_number_unique unique (template_id, version_number),
  constraint document_template_versions_path_format check (
    storage_path ~ '^templates/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{32}-[A-Za-z0-9][A-Za-z0-9._-]{0,119}$'
    and split_part(storage_path, '/', 2) = template_id::text
  )
);

create sequence if not exists public.product_listing_card_number_seq;

create table if not exists public.product_listing_cards (
  id uuid primary key default gen_random_uuid(),
  card_number text not null,
  version integer not null default 1 check (version > 0),
  previous_version_id uuid references public.product_listing_cards(id) on delete restrict,
  root_card_id uuid references public.product_listing_cards(id) on delete restrict,
  card_type text not null check (card_type in ('input', 'output')),
  customer_id uuid not null references public.counterparties(id) on delete restrict,
  template_id uuid references public.document_templates(id) on delete restrict,
  document_id uuid references public.documents(id) on delete restrict,
  title text check (title is null or length(title) <= 200),
  effective_date date,
  notes text check (notes is null or length(notes) <= 2000),
  status text not null default 'draft' check (status in (
    'draft', 'submitted', 'approved_by_customer', 'rejected_by_customer', 'cancelled', 'superseded'
  )),
  submitted_at timestamptz,
  submitted_by uuid references public.profiles(id) on delete restrict,
  decided_at timestamptz,
  decided_by uuid references public.profiles(id) on delete restrict,
  decision_comment text check (decision_comment is null or length(decision_comment) <= 1000),
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles(id) on delete restrict,
  cancel_reason text check (cancel_reason is null or length(cancel_reason) <= 500),
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_listing_cards_number_version_unique unique (card_number, version),
  constraint product_listing_cards_version_chain check (
    (version = 1 and previous_version_id is null) or (version > 1 and previous_version_id is not null)
  ),
  constraint product_listing_cards_not_own_previous check (previous_version_id is null or previous_version_id <> id),
  constraint product_listing_cards_submitted_fields check (
    status in ('draft') or (submitted_at is not null and submitted_by is not null) or status = 'cancelled'
  ),
  constraint product_listing_cards_decision_fields check (
    status not in ('approved_by_customer', 'rejected_by_customer', 'superseded')
    or (decided_at is not null and decided_by is not null)
  ),
  constraint product_listing_cards_rejection_comment check (
    status <> 'rejected_by_customer' or length(btrim(coalesce(decision_comment, ''))) > 0
  ),
  constraint product_listing_cards_cancel_fields check (
    (status = 'cancelled') = (cancelled_at is not null and cancelled_by is not null and length(btrim(coalesce(cancel_reason, ''))) > 0)
  )
);

create table if not exists public.product_listing_card_items (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.product_listing_cards(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  required_quantity numeric(14, 3) not null check (required_quantity > 0),
  uom text not null default 'piece' check (uom in ('piece', 'box', 'layer', 'pallet')),
  customer_sku text check (customer_sku is null or length(btrim(customer_sku)) between 1 and 100),
  price numeric(14, 4) check (price is null or price >= 0),
  currency_id uuid references public.currencies(id) on delete restrict,
  comment text check (comment is null or length(comment) <= 1000),
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_listing_card_items_product_once unique (card_id, product_id),
  constraint product_listing_card_items_price_currency check (price is null or currency_id is not null)
);

-- 3. Indexes -----------------------------------------------------------------------------

create unique index if not exists document_templates_name_unique
  on public.document_templates (
    document_type_id, lower(name), language,
    coalesce(counterparty_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) where archived_at is null;
create index if not exists document_templates_type_idx on public.document_templates(document_type_id);
create index if not exists document_templates_counterparty_idx on public.document_templates(counterparty_id)
  where counterparty_id is not null;

create unique index if not exists document_template_versions_one_current
  on public.document_template_versions(template_id) where is_current;
create unique index if not exists document_template_versions_same_file_once
  on public.document_template_versions(template_id, checksum_sha256) where checksum_sha256 is not null;

create unique index if not exists product_listing_cards_one_open_version
  on public.product_listing_cards(root_card_id) where status in ('draft', 'submitted');
create unique index if not exists product_listing_cards_one_approved_version
  on public.product_listing_cards(root_card_id) where status = 'approved_by_customer';
create unique index if not exists product_listing_cards_single_successor
  on public.product_listing_cards(previous_version_id) where previous_version_id is not null;
create index if not exists product_listing_cards_customer_idx on public.product_listing_cards(customer_id);
create index if not exists product_listing_cards_status_idx on public.product_listing_cards(status);
create index if not exists product_listing_card_items_card_idx on public.product_listing_card_items(card_id);

-- 4. Helper functions ----------------------------------------------------------------------

-- Template not archived. SECURITY DEFINER: used in policies of users who may lack view.
create or replace function private.template_is_active(p_template_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.document_templates t
    where t.id = p_template_id and t.archived_at is null
  );
$$;

-- Template created by the current user in the current transaction (created_at = now()).
create or replace function private.is_own_new_template(p_template_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.document_templates t
    where t.id = p_template_id
      and t.created_by = (select auth.uid())
      and t.archived_at is null
      and t.created_at = now()
  );
$$;

create or replace function private.is_registered_template_file(p_bucket text, p_path text)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.document_template_versions v
    where v.storage_bucket = p_bucket and v.storage_path = p_path
  );
$$;

create or replace function private.listing_card_is_draft(p_card_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.product_listing_cards c
    where c.id = p_card_id and c.status = 'draft'
  );
$$;

revoke execute on function private.template_is_active(uuid) from public;
revoke execute on function private.is_own_new_template(uuid) from public;
revoke execute on function private.is_registered_template_file(text, text) from public;
revoke execute on function private.listing_card_is_draft(uuid) from public;
grant execute on function private.template_is_active(uuid) to authenticated;
grant execute on function private.is_own_new_template(uuid) to authenticated;
grant execute on function private.is_registered_template_file(text, text) to authenticated;
grant execute on function private.listing_card_is_draft(uuid) to authenticated;

-- 5. Template triggers ------------------------------------------------------------------------

create or replace function private.prepare_document_template_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (select 1 from public.document_types t where t.id = new.document_type_id and t.is_active) then
    raise exception 'Тип документа не найден или отключён';
  end if;
  if new.counterparty_id is not null
    and not exists (select 1 from public.counterparties c where c.id = new.counterparty_id) then
    raise exception 'Контрагент не найден или недоступен';
  end if;
  new.status := 'draft';
  new.is_active := true;
  new.current_version := 0;
  new.approved_by := null;
  new.approved_at := null;
  new.created_by := (select auth.uid());
  new.created_at := now();
  new.updated_at := now();
  new.archived_at := null;
  new.archived_by := null;
  new.archive_reason := null;
  return new;
end;
$$;

drop trigger if exists prepare_document_template_insert on public.document_templates;
create trigger prepare_document_template_insert
  before insert on public.document_templates
  for each row execute function private.prepare_document_template_insert();

-- Status graph and editing rules for templates; applies to every UPDATE.
create or replace function private.guard_document_template_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.id <> old.id or new.created_by <> old.created_by or new.created_at <> old.created_at then
    raise exception 'Системные поля шаблона изменять нельзя';
  end if;
  if old.status = 'archived' then
    raise exception 'Шаблон в архиве: изменения запрещены';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'draft' and new.status in ('approved', 'archived'))
    or (old.status = 'approved' and new.status in ('draft', 'archived'))
  ) then
    raise exception 'Недопустимый переход статуса шаблона: % → %', old.status, new.status;
  end if;
  if new.status = 'approved' and old.status = 'draft' and new.current_version = 0 then
    raise exception 'Нельзя утвердить шаблон без файла';
  end if;
  if new.document_type_id is distinct from old.document_type_id
    and not exists (select 1 from public.document_types t where t.id = new.document_type_id and t.is_active) then
    raise exception 'Тип документа не найден или отключён';
  end if;
  -- Changing what the template is (type, language, fields) requires a new approval.
  if old.status = 'approved' and new.status = 'approved' and (
    new.document_type_id is distinct from old.document_type_id
    or new.language is distinct from old.language
    or new.variables_schema is distinct from old.variables_schema
  ) then
    new.status := 'draft';
    new.approved_by := null;
    new.approved_at := null;
  end if;
  if new.status = 'draft' then
    new.approved_by := null;
    new.approved_at := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists guard_document_template_update on public.document_templates;
create trigger guard_document_template_update
  before update on public.document_templates
  for each row execute function private.guard_document_template_update();

create or replace function private.assert_template_has_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.document_template_versions v where v.template_id = new.id) then
    raise exception 'Шаблон должен быть создан вместе с файлом';
  end if;
  return null;
end;
$$;

drop trigger if exists document_templates_require_version on public.document_templates;
create constraint trigger document_templates_require_version
  after insert on public.document_templates
  deferrable initially deferred
  for each row execute function private.assert_template_has_version();

-- Prepares a template file version: rights, next number, size and MIME type from the
-- Storage object (never from the client), file owner, retires the previous version.
create or replace function private.prepare_template_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_template public.document_templates%rowtype;
  v_object record;
begin
  select * into v_template from public.document_templates t where t.id = new.template_id for update;
  if not found then
    raise exception 'Шаблон не найден';
  end if;
  if v_template.archived_at is not null then
    raise exception 'Шаблон в архиве: новые версии запрещены';
  end if;

  if v_template.current_version = 0 then
    if not (
      (select private.has_permission('templates.create'))
      and v_template.created_by = (select auth.uid())
    ) and not (select private.has_permission('templates.upload')) then
      raise exception 'Недостаточно прав для загрузки файла шаблона';
    end if;
  elsif not (select private.has_permission('templates.upload')) then
    raise exception 'Недостаточно прав для загрузки новой версии шаблона';
  end if;

  if new.storage_path is null
    or split_part(new.storage_path, '/', 1) <> 'templates'
    or split_part(new.storage_path, '/', 2) <> new.template_id::text then
    raise exception 'Недопустимый путь файла шаблона';
  end if;

  if to_regclass('storage.objects') is null then
    raise exception 'Supabase Storage недоступен: файл нельзя проверить';
  end if;
  execute 'select o.metadata, o.owner_id from storage.objects o where o.bucket_id = $1 and o.name = $2'
    into v_object using 'nexus-documents', new.storage_path;
  if v_object is null then
    raise exception 'Файл не найден в хранилище nexus-documents';
  end if;
  if v_object.owner_id is distinct from (select auth.uid())::text then
    raise exception 'Файл загружен другим пользователем';
  end if;

  new.storage_bucket := 'nexus-documents';
  new.mime_type := coalesce(v_object.metadata ->> 'mimetype', new.mime_type);
  new.file_size_bytes := coalesce(
    (v_object.metadata ->> 'size')::bigint,
    (v_object.metadata ->> 'contentLength')::bigint,
    new.file_size_bytes
  );
  new.version_number := v_template.current_version + 1;
  new.is_current := true;
  new.uploaded_by := (select auth.uid());
  new.uploaded_at := now();

  update public.document_template_versions set is_current = false
  where template_id = new.template_id and is_current;
  return new;
end;
$$;

drop trigger if exists prepare_template_version on public.document_template_versions;
create trigger prepare_template_version
  before insert on public.document_template_versions
  for each row execute function private.prepare_template_version();

-- A new file version makes the template a draft again: the new file must be approved.
create or replace function private.apply_template_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.document_templates
  set current_version = new.version_number,
      status = 'draft',
      approved_by = null,
      approved_at = null
  where id = new.template_id;
  return null;
end;
$$;

drop trigger if exists apply_template_version on public.document_template_versions;
create trigger apply_template_version
  after insert on public.document_template_versions
  for each row execute function private.apply_template_version();

-- 6. Listing card triggers ----------------------------------------------------------------------

-- Fills system fields of a new card. Direct inserts cannot set version fields (no column
-- privilege), so they always create version 1; create_listing_card_version() passes the
-- previous version and gets number, root and version copied from it.
create or replace function private.prepare_listing_card_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous public.product_listing_cards%rowtype;
begin
  if new.previous_version_id is null then
    new.version := 1;
    new.root_card_id := new.id;
    new.card_number := 'LC-' || to_char(now(), 'YYYY') || '-'
      || lpad(nextval('public.product_listing_card_number_seq')::text, 5, '0');
  else
    select * into v_previous from public.product_listing_cards where id = new.previous_version_id;
    if not found then
      raise exception 'Предыдущая версия карты не найдена';
    end if;
    new.version := v_previous.version + 1;
    new.root_card_id := v_previous.root_card_id;
    new.card_number := v_previous.card_number;
  end if;
  new.status := 'draft';
  new.submitted_at := null;
  new.submitted_by := null;
  new.decided_at := null;
  new.decided_by := null;
  new.decision_comment := null;
  new.cancelled_at := null;
  new.cancelled_by := null;
  new.cancel_reason := null;
  new.created_by := (select auth.uid());
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists prepare_listing_card_insert on public.product_listing_cards;
create trigger prepare_listing_card_insert
  before insert on public.product_listing_cards
  for each row execute function private.prepare_listing_card_insert();

-- Customer, template and document must be visible to the caller (SECURITY INVOKER: RLS applies).
create or replace function private.validate_listing_card_refs()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.customer_id is distinct from old.customer_id then
    if not exists (
      select 1 from public.counterparties c
      where c.id = new.customer_id and 'customer' = any(c.roles)
    ) then
      raise exception 'Клиент не найден, недоступен или не является клиентом';
    end if;
  end if;
  if new.template_id is not null and (tg_op = 'INSERT' or new.template_id is distinct from old.template_id) then
    if not exists (
      select 1 from public.document_templates t
      where t.id = new.template_id and t.status = 'approved' and t.is_active
    ) then
      raise exception 'Шаблон не найден, не утверждён или отключён';
    end if;
  end if;
  if new.document_id is not null and (tg_op = 'INSERT' or new.document_id is distinct from old.document_id) then
    if not exists (select 1 from public.documents d where d.id = new.document_id and d.archived_at is null) then
      raise exception 'Документ не найден, недоступен или находится в архиве';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists validate_listing_card_refs on public.product_listing_cards;
create trigger validate_listing_card_refs
  before insert or update of customer_id, template_id, document_id on public.product_listing_cards
  for each row execute function private.validate_listing_card_refs();

-- Status graph and "only a draft is editable" rule; applies to every UPDATE, including
-- updates made by SECURITY DEFINER functions.
create or replace function private.guard_listing_card_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_content_changed boolean;
begin
  if new.id <> old.id
    or new.card_number <> old.card_number
    or new.version <> old.version
    or new.previous_version_id is distinct from old.previous_version_id
    or new.root_card_id is distinct from old.root_card_id
    or new.created_by <> old.created_by
    or new.created_at <> old.created_at then
    raise exception 'Системные поля карты изменять нельзя';
  end if;

  v_content_changed :=
    new.card_type is distinct from old.card_type
    or new.customer_id is distinct from old.customer_id
    or new.template_id is distinct from old.template_id
    or new.document_id is distinct from old.document_id
    or new.title is distinct from old.title
    or new.effective_date is distinct from old.effective_date
    or new.notes is distinct from old.notes;

  if v_content_changed and old.status <> 'draft' then
    raise exception 'Карта в статусе «%» не редактируется. Создайте новую версию', old.status;
  end if;
  if v_content_changed and new.status is distinct from old.status then
    raise exception 'Нельзя одновременно менять содержание и статус карты';
  end if;

  if new.status is distinct from old.status and not (
    (old.status = 'draft' and new.status in ('submitted', 'cancelled'))
    or (old.status = 'submitted' and new.status in ('approved_by_customer', 'rejected_by_customer', 'cancelled'))
    or (old.status = 'approved_by_customer' and new.status = 'superseded')
  ) then
    raise exception 'Недопустимый переход статуса карты: % → %', old.status, new.status;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists guard_listing_card_update on public.product_listing_cards;
create trigger guard_listing_card_update
  before update on public.product_listing_cards
  for each row execute function private.guard_listing_card_update();

-- Items may be added, changed or removed only while the card is a draft.
create or replace function private.guard_listing_card_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_card_id uuid := case when tg_op = 'DELETE' then old.card_id else new.card_id end;
  v_status text;
begin
  select status into v_status from public.product_listing_cards where id = v_card_id;
  if v_status is null then
    raise exception 'Карта не найдена';
  end if;
  if v_status <> 'draft' then
    raise exception 'Позиции можно менять только в черновике карты. Создайте новую версию';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'UPDATE' and (new.card_id <> old.card_id or new.product_id <> old.product_id
      or new.created_by <> old.created_by or new.created_at <> old.created_at) then
    raise exception 'Карту, товар и автора позиции изменять нельзя';
  end if;
  if tg_op = 'INSERT' then
    new.created_by := (select auth.uid());
    new.created_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists guard_listing_card_item on public.product_listing_card_items;
create trigger guard_listing_card_item
  before insert or update or delete on public.product_listing_card_items
  for each row execute function private.guard_listing_card_item();

revoke execute on function private.prepare_document_template_insert() from public;
revoke execute on function private.guard_document_template_update() from public;
revoke execute on function private.assert_template_has_version() from public;
revoke execute on function private.prepare_template_version() from public;
revoke execute on function private.apply_template_version() from public;
revoke execute on function private.prepare_listing_card_insert() from public;
revoke execute on function private.validate_listing_card_refs() from public;
revoke execute on function private.guard_listing_card_update() from public;
revoke execute on function private.guard_listing_card_item() from public;

do $$
declare
  t text;
begin
  foreach t in array array['document_templates', 'document_template_versions',
                           'product_listing_cards', 'product_listing_card_items'] loop
    execute format('drop trigger if exists audit_%I_changes on public.%I', t, t);
    execute format(
      'create trigger audit_%I_changes after insert or update or delete on public.%I '
      'for each row execute function private.write_access_audit()', t, t);
  end loop;
end;
$$;

-- 7. RPC functions ------------------------------------------------------------------------------

-- Returns which of the requested permission codes the current user has (interface only;
-- every rule is still enforced by RLS and triggers).
create or replace function public.my_permissions(p_codes text[])
returns text[]
language sql
security invoker
set search_path = ''
stable
as $$
  select coalesce(array_agg(code order by code), '{}')
  from unnest(p_codes[1:100]) as code
  where (select private.has_permission(code));
$$;

-- Creates a template together with its first file version. SECURITY INVOKER.
create or replace function public.register_document_template(
  p_template_id uuid,
  p_document_type_id uuid,
  p_name text,
  p_language text,
  p_storage_path text,
  p_original_filename text,
  p_purpose text default null,
  p_counterparty_id uuid default null,
  p_variables_schema jsonb default '{}'::jsonb,
  p_checksum_sha256 text default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not (select private.has_permission('templates.create')) then
    raise exception 'Недостаточно прав для создания шаблона';
  end if;
  insert into public.document_templates (id, document_type_id, name, language, purpose, counterparty_id, variables_schema)
  values (p_template_id, p_document_type_id, btrim(p_name), p_language, nullif(btrim(p_purpose), ''),
          p_counterparty_id, coalesce(p_variables_schema, '{}'::jsonb));
  insert into public.document_template_versions (template_id, storage_path, original_filename, checksum_sha256)
  values (p_template_id, p_storage_path, p_original_filename, p_checksum_sha256);
  return p_template_id;
end;
$$;

create or replace function public.approve_document_template(p_template_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select private.has_permission('templates.approve')) then
    raise exception 'Недостаточно прав для утверждения шаблона';
  end if;
  update public.document_templates
  set status = 'approved', approved_by = (select auth.uid()), approved_at = now()
  where id = p_template_id and status = 'draft';
  if not found then
    raise exception 'Шаблон не найден или не является черновиком';
  end if;
end;
$$;

create or replace function public.set_document_template_active(p_template_id uuid, p_is_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select private.has_permission('templates.change_status')) then
    raise exception 'Недостаточно прав для включения или отключения шаблона';
  end if;
  update public.document_templates set is_active = coalesce(p_is_active, false)
  where id = p_template_id and archived_at is null;
  if not found then
    raise exception 'Шаблон не найден или находится в архиве';
  end if;
end;
$$;

create or replace function public.archive_document_template(p_template_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select private.has_permission('templates.archive')) then
    raise exception 'Недостаточно прав для архивирования шаблона';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Укажите причину архивирования';
  end if;
  update public.document_templates
  set status = 'archived', is_active = false,
      archived_at = now(), archived_by = (select auth.uid()), archive_reason = btrim(p_reason)
  where id = p_template_id and archived_at is null;
  if not found then
    raise exception 'Шаблон не найден или уже находится в архиве';
  end if;
end;
$$;

create or replace function public.submit_listing_card(p_card_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select private.has_permission('listing_cards.change_status')) then
    raise exception 'Недостаточно прав для отправки карты';
  end if;
  if not exists (select 1 from public.product_listing_card_items i where i.card_id = p_card_id) then
    raise exception 'В карте нет позиций';
  end if;
  update public.product_listing_cards
  set status = 'submitted', submitted_at = now(), submitted_by = (select auth.uid())
  where id = p_card_id and status = 'draft';
  if not found then
    raise exception 'Карта не найдена или не является черновиком';
  end if;
end;
$$;

create or replace function public.record_listing_card_decision(p_card_id uuid, p_decision text, p_comment text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_card public.product_listing_cards%rowtype;
begin
  if not (select private.has_permission('listing_cards.approve')) then
    raise exception 'Недостаточно прав для фиксации решения клиента';
  end if;
  if p_decision not in ('approved', 'rejected') then
    raise exception 'Решение должно быть approved или rejected';
  end if;
  if p_decision = 'rejected' and length(btrim(coalesce(p_comment, ''))) = 0 then
    raise exception 'Укажите причину отказа клиента';
  end if;

  select * into v_card from public.product_listing_cards where id = p_card_id for update;
  if not found or v_card.status <> 'submitted' then
    raise exception 'Карта не найдена или не отправлена клиенту';
  end if;

  if p_decision = 'approved' then
    update public.product_listing_cards
    set status = 'superseded'
    where root_card_id = v_card.root_card_id and status = 'approved_by_customer';
  end if;

  update public.product_listing_cards
  set status = case p_decision when 'approved' then 'approved_by_customer' else 'rejected_by_customer' end,
      decided_at = now(),
      decided_by = (select auth.uid()),
      decision_comment = nullif(btrim(p_comment), '')
  where id = p_card_id;
end;
$$;

create or replace function public.cancel_listing_card(p_card_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (select private.has_permission('listing_cards.archive')) then
    raise exception 'Недостаточно прав для отмены карты';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'Укажите причину отмены';
  end if;
  update public.product_listing_cards
  set status = 'cancelled', cancelled_at = now(), cancelled_by = (select auth.uid()), cancel_reason = btrim(p_reason)
  where id = p_card_id and status in ('draft', 'submitted');
  if not found then
    raise exception 'Отменить можно только черновик или отправленную карту';
  end if;
end;
$$;

-- Creates the next version as a draft copy (header and items) of the latest version.
-- Allowed for a card approved or rejected by the customer, or cancelled (otherwise a
-- cancelled latest version would block the chain); the source stays unchanged.
create or replace function public.create_listing_card_version(p_card_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source public.product_listing_cards%rowtype;
  v_new_id uuid;
begin
  if not ((select private.has_permission('listing_cards.create'))
          and (select private.has_permission('listing_cards.view'))) then
    raise exception 'Недостаточно прав для создания новой версии карты';
  end if;
  select * into v_source from public.product_listing_cards where id = p_card_id for update;
  if not found then
    raise exception 'Карта не найдена';
  end if;
  if v_source.status not in ('approved_by_customer', 'rejected_by_customer', 'cancelled') then
    raise exception 'Новую версию можно создать только из утверждённой, отклонённой клиентом или отменённой карты';
  end if;
  if exists (select 1 from public.product_listing_cards c where c.previous_version_id = p_card_id) then
    raise exception 'У этой версии уже есть следующая версия';
  end if;

  insert into public.product_listing_cards (
    previous_version_id, card_type, customer_id, template_id, title, effective_date, notes, card_number
  ) values (
    v_source.id, v_source.card_type, v_source.customer_id,
    (select t.id from public.document_templates t where t.id = v_source.template_id and t.status = 'approved' and t.is_active),
    v_source.title, v_source.effective_date, v_source.notes, v_source.card_number
  )
  returning id into v_new_id;

  insert into public.product_listing_card_items (card_id, product_id, required_quantity, uom, customer_sku, price, currency_id, comment)
  select v_new_id, i.product_id, i.required_quantity, i.uom, i.customer_sku, i.price, i.currency_id, i.comment
  from public.product_listing_card_items i
  where i.card_id = v_source.id;

  return v_new_id;
end;
$$;

revoke execute on function public.my_permissions(text[]) from public, anon;
revoke execute on function public.register_document_template(uuid, uuid, text, text, text, text, text, uuid, jsonb, text) from public, anon;
revoke execute on function public.approve_document_template(uuid) from public, anon;
revoke execute on function public.set_document_template_active(uuid, boolean) from public, anon;
revoke execute on function public.archive_document_template(uuid, text) from public, anon;
revoke execute on function public.submit_listing_card(uuid) from public, anon;
revoke execute on function public.record_listing_card_decision(uuid, text, text) from public, anon;
revoke execute on function public.cancel_listing_card(uuid, text) from public, anon;
revoke execute on function public.create_listing_card_version(uuid) from public, anon;
grant execute on function public.my_permissions(text[]) to authenticated;
grant execute on function public.register_document_template(uuid, uuid, text, text, text, text, text, uuid, jsonb, text) to authenticated;
grant execute on function public.approve_document_template(uuid) to authenticated;
grant execute on function public.set_document_template_active(uuid, boolean) to authenticated;
grant execute on function public.archive_document_template(uuid, text) to authenticated;
grant execute on function public.submit_listing_card(uuid) to authenticated;
grant execute on function public.record_listing_card_decision(uuid, text, text) to authenticated;
grant execute on function public.cancel_listing_card(uuid, text) to authenticated;
grant execute on function public.create_listing_card_version(uuid) to authenticated;

-- 8. Privileges ----------------------------------------------------------------------------------

alter table public.document_templates enable row level security;
alter table public.document_template_versions enable row level security;
alter table public.product_listing_cards enable row level security;
alter table public.product_listing_card_items enable row level security;

revoke all on public.document_templates, public.document_template_versions,
  public.product_listing_cards, public.product_listing_card_items from anon, authenticated, service_role;
revoke all on sequence public.product_listing_card_number_seq from public, anon, authenticated, service_role;

grant select on public.document_templates, public.document_template_versions,
  public.product_listing_cards, public.product_listing_card_items to authenticated;

grant insert (id, document_type_id, name, language, purpose, counterparty_id, variables_schema)
  on public.document_templates to authenticated;
grant update (document_type_id, name, language, purpose, counterparty_id, variables_schema)
  on public.document_templates to authenticated;

grant insert (template_id, storage_path, original_filename, checksum_sha256, comment)
  on public.document_template_versions to authenticated;

grant insert (id, card_type, customer_id, template_id, document_id, title, effective_date, notes)
  on public.product_listing_cards to authenticated;
grant update (card_type, customer_id, template_id, document_id, title, effective_date, notes)
  on public.product_listing_cards to authenticated;

grant insert (card_id, product_id, required_quantity, uom, customer_sku, price, currency_id, comment)
  on public.product_listing_card_items to authenticated;
grant update (required_quantity, uom, customer_sku, price, currency_id, comment)
  on public.product_listing_card_items to authenticated;
grant delete on public.product_listing_card_items to authenticated;

-- 9. RLS policies ----------------------------------------------------------------------------------

drop policy if exists "template viewers see templates" on public.document_templates;
create policy "template viewers see templates" on public.document_templates
  for select to authenticated
  using ((select private.has_permission('templates.view')));

drop policy if exists "template creators create templates" on public.document_templates;
create policy "template creators create templates" on public.document_templates
  for insert to authenticated
  with check ((select private.has_permission('templates.create')) and created_by = (select auth.uid()));

drop policy if exists "template editors update templates" on public.document_templates;
create policy "template editors update templates" on public.document_templates
  for update to authenticated
  using (archived_at is null and (select private.has_permission('templates.update')))
  with check (archived_at is null and (select private.has_permission('templates.update')));

drop policy if exists "template viewers see versions" on public.document_template_versions;
create policy "template viewers see versions" on public.document_template_versions
  for select to authenticated
  using ((select private.has_permission('templates.view')));

drop policy if exists "template uploaders add versions" on public.document_template_versions;
create policy "template uploaders add versions" on public.document_template_versions
  for insert to authenticated
  with check (
    uploaded_by = (select auth.uid())
    and (select private.template_is_active(template_id))
    and (
      (select private.has_permission('templates.upload'))
      or ((select private.has_permission('templates.create')) and (select private.is_own_new_template(template_id)))
    )
  );

drop policy if exists "card viewers see cards" on public.product_listing_cards;
create policy "card viewers see cards" on public.product_listing_cards
  for select to authenticated
  using ((select private.has_permission('listing_cards.view')));

drop policy if exists "card creators create cards" on public.product_listing_cards;
create policy "card creators create cards" on public.product_listing_cards
  for insert to authenticated
  with check ((select private.has_permission('listing_cards.create')) and created_by = (select auth.uid()));

drop policy if exists "card editors update drafts" on public.product_listing_cards;
create policy "card editors update drafts" on public.product_listing_cards
  for update to authenticated
  using (status = 'draft' and (select private.has_permission('listing_cards.update')))
  with check (status = 'draft' and (select private.has_permission('listing_cards.update')));

drop policy if exists "card viewers see items" on public.product_listing_card_items;
create policy "card viewers see items" on public.product_listing_card_items
  for select to authenticated
  using ((select private.has_permission('listing_cards.view')));

drop policy if exists "card editors add items" on public.product_listing_card_items;
create policy "card editors add items" on public.product_listing_card_items
  for insert to authenticated
  with check (
    (select private.has_permission('listing_cards.update'))
    and (select private.listing_card_is_draft(card_id))
    and created_by = (select auth.uid())
  );

drop policy if exists "card editors update items" on public.product_listing_card_items;
create policy "card editors update items" on public.product_listing_card_items
  for update to authenticated
  using ((select private.has_permission('listing_cards.update')) and (select private.listing_card_is_draft(card_id)))
  with check ((select private.has_permission('listing_cards.update')) and (select private.listing_card_is_draft(card_id)));

drop policy if exists "card editors remove items" on public.product_listing_card_items;
create policy "card editors remove items" on public.product_listing_card_items
  for delete to authenticated
  using ((select private.has_permission('listing_cards.update')) and (select private.listing_card_is_draft(card_id)));

-- 10. Storage policies for template files ---------------------------------------------------------
--
-- Template files share the private bucket nexus-documents (same size limit, MIME list and
-- privacy) under the separate prefix templates/. The two document policies from
-- 202609271001 are re-created limited to the documents/ prefix: before this migration
-- they matched every unregistered object, which would have let an uploader delete a
-- freshly registered template file.

do $$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'Supabase Storage schema not found: template file policies not created (docs/templates-listing-cards.md)';
    return;
  end if;

  execute 'drop policy if exists "nexus documents: read registered files" on storage.objects';
  execute $policy$
    create policy "nexus documents: read registered files" on storage.objects
      for select to authenticated
      using (
        bucket_id = 'nexus-documents'
        and name like 'documents/%'
        and (
          (
            (select private.has_permission('documents.view'))
            and (select private.is_registered_document_file(bucket_id, name))
          )
          or (
            owner_id = (select auth.uid())::text
            and not (select private.is_registered_document_file(bucket_id, name))
          )
        )
      )
  $policy$;

  execute 'drop policy if exists "nexus documents: remove own unregistered upload" on storage.objects';
  execute $policy$
    create policy "nexus documents: remove own unregistered upload" on storage.objects
      for delete to authenticated
      using (
        bucket_id = 'nexus-documents'
        and name like 'documents/%'
        and owner_id = (select auth.uid())::text
        and created_at > now() - interval '1 hour'
        and not (select private.is_registered_document_file(bucket_id, name))
      )
  $policy$;

  execute 'drop policy if exists "nexus templates: read registered files" on storage.objects';
  execute $policy$
    create policy "nexus templates: read registered files" on storage.objects
      for select to authenticated
      using (
        bucket_id = 'nexus-documents'
        and name like 'templates/%'
        and (
          (
            (select private.has_permission('templates.export'))
            and (select private.is_registered_template_file(bucket_id, name))
          )
          or (
            owner_id = (select auth.uid())::text
            and not (select private.is_registered_template_file(bucket_id, name))
          )
        )
      )
  $policy$;

  execute 'drop policy if exists "nexus templates: upload into template folder" on storage.objects';
  execute $policy$
    create policy "nexus templates: upload into template folder" on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'nexus-documents'
        and owner_id = (select auth.uid())::text
        and name ~ '^templates/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{32}-[A-Za-z0-9][A-Za-z0-9._-]{0,119}$'
        and (
          (select private.has_permission('templates.create'))
          or (select private.has_permission('templates.upload'))
        )
      )
  $policy$;

  execute 'drop policy if exists "nexus templates: remove own unregistered upload" on storage.objects';
  execute $policy$
    create policy "nexus templates: remove own unregistered upload" on storage.objects
      for delete to authenticated
      using (
        bucket_id = 'nexus-documents'
        and name like 'templates/%'
        and owner_id = (select auth.uid())::text
        and created_at > now() - interval '1 hour'
        and not (select private.is_registered_template_file(bucket_id, name))
      )
  $policy$;
end;
$$;

comment on table public.document_templates is 'Catalogue of document templates (type, language, purpose, status, active flag, current file version)';
comment on table public.document_template_versions is 'Append-only file versions of document templates stored in nexus-documents/templates/';
comment on table public.product_listing_cards is 'Customer product listing cards (input/output) with version chains; only drafts are editable';
comment on table public.product_listing_card_items is 'Products of a listing card with required quantity and customer-specific fields';
