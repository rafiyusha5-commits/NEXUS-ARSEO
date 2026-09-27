-- Distinguishes supplier input templates from buyer output templates and makes
-- listing cards work with either side of the ARSEO counterparty registry.

alter table public.document_templates
  add column if not exists flow_direction text;

-- Existing counterparty-specific templates are classified from the counterparty role.
-- Supplier/manufacturer wins when a counterparty has both roles; general templates keep
-- the safe input default and can be changed by an administrator before approval.
update public.document_templates t
set flow_direction = case
  when exists (
    select 1 from public.counterparties c
    where c.id = t.counterparty_id
      and c.roles && array['manufacturer', 'supplier']::text[]
  ) then 'input'
  when exists (
    select 1 from public.counterparties c
    where c.id = t.counterparty_id and 'customer' = any(c.roles)
  ) then 'output'
  else 'input'
end
where flow_direction is null;

alter table public.document_templates
  alter column flow_direction set default 'input',
  alter column flow_direction set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.document_templates'::regclass
      and conname = 'document_templates_flow_direction_check'
  ) then
    alter table public.document_templates
      add constraint document_templates_flow_direction_check
      check (flow_direction in ('input', 'output'));
  end if;
end;
$$;

drop index if exists public.document_templates_name_unique;
create unique index document_templates_name_unique
  on public.document_templates (
    lower(name), document_type_id, language, flow_direction,
    coalesce(counterparty_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) where archived_at is null;

-- The original module used customer-specific names even though cards represent both
-- incoming supplier data and outgoing buyer data. Rename without losing rows.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'product_listing_cards' and column_name = 'customer_id'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'product_listing_cards' and column_name = 'counterparty_id'
  ) then
    alter table public.product_listing_cards rename column customer_id to counterparty_id;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'product_listing_card_items' and column_name = 'customer_sku'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'product_listing_card_items' and column_name = 'counterparty_sku'
  ) then
    alter table public.product_listing_card_items rename column customer_sku to counterparty_sku;
  end if;
end;
$$;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'product_listing_cards_customer_id_fkey'
      and conrelid = 'public.product_listing_cards'::regclass)
    and not exists (select 1 from pg_constraint where conname = 'product_listing_cards_counterparty_id_fkey'
      and conrelid = 'public.product_listing_cards'::regclass) then
    alter table public.product_listing_cards
      rename constraint product_listing_cards_customer_id_fkey to product_listing_cards_counterparty_id_fkey;
  end if;
end;
$$;

alter index if exists public.product_listing_cards_customer_idx
  rename to product_listing_cards_counterparty_idx;

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
  if new.flow_direction not in ('input', 'output') then
    raise exception 'Выберите направление шаблона';
  end if;
  if new.counterparty_id is not null and not exists (
    select 1 from public.counterparties c
    where c.id = new.counterparty_id
      and c.status = 'active'
      and (
        (new.flow_direction = 'input' and c.roles && array['manufacturer', 'supplier']::text[])
        or (new.flow_direction = 'output' and 'customer' = any(c.roles))
      )
  ) then
    raise exception '%', case when new.flow_direction = 'input'
      then 'Контрагент не найден, отключён или не является поставщиком'
      else 'Контрагент не найден, отключён или не является покупателем' end;
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
  if new.flow_direction not in ('input', 'output') then
    raise exception 'Выберите направление шаблона';
  end if;
  if new.counterparty_id is not null and not exists (
    select 1 from public.counterparties c
    where c.id = new.counterparty_id
      and c.status = 'active'
      and (
        (new.flow_direction = 'input' and c.roles && array['manufacturer', 'supplier']::text[])
        or (new.flow_direction = 'output' and 'customer' = any(c.roles))
      )
  ) then
    raise exception '%', case when new.flow_direction = 'input'
      then 'Для входящего шаблона выберите поставщика'
      else 'Для исходящего шаблона выберите покупателя' end;
  end if;
  if old.status = 'approved' and new.status = 'approved' and (
    new.document_type_id is distinct from old.document_type_id
    or new.language is distinct from old.language
    or new.flow_direction is distinct from old.flow_direction
    or new.counterparty_id is distinct from old.counterparty_id
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

create or replace function private.validate_listing_card_refs()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'INSERT'
    or new.counterparty_id is distinct from old.counterparty_id
    or new.card_type is distinct from old.card_type then
    if not exists (
      select 1 from public.counterparties c
      where c.id = new.counterparty_id
        and c.status = 'active'
        and (
          (new.card_type = 'input' and c.roles && array['manufacturer', 'supplier']::text[])
          or (new.card_type = 'output' and 'customer' = any(c.roles))
        )
    ) then
      raise exception '%', case when new.card_type = 'input'
        then 'Для карты ввода выберите активного поставщика'
        else 'Для карты вывода выберите активного покупателя' end;
    end if;
  end if;
  if new.template_id is not null and (
    tg_op = 'INSERT'
    or new.template_id is distinct from old.template_id
    or new.counterparty_id is distinct from old.counterparty_id
    or new.card_type is distinct from old.card_type
  ) then
    if not exists (
      select 1 from public.document_templates t
      where t.id = new.template_id
        and t.status = 'approved'
        and t.is_active
        and t.flow_direction = new.card_type
        and (t.counterparty_id is null or t.counterparty_id = new.counterparty_id)
    ) then
      raise exception 'Шаблон не соответствует направлению или выбранному контрагенту';
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
  before insert or update of card_type, counterparty_id, template_id, document_id on public.product_listing_cards
  for each row execute function private.validate_listing_card_refs();

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
    or new.counterparty_id is distinct from old.counterparty_id
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

drop function if exists public.register_document_template(uuid, uuid, text, text, text, text, text, uuid, jsonb, text);
create or replace function public.register_document_template(
  p_template_id uuid,
  p_document_type_id uuid,
  p_name text,
  p_language text,
  p_flow_direction text,
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
  insert into public.document_templates (
    id, document_type_id, name, language, flow_direction, purpose, counterparty_id, variables_schema
  ) values (
    p_template_id, p_document_type_id, btrim(p_name), p_language, p_flow_direction,
    nullif(btrim(p_purpose), ''), p_counterparty_id, coalesce(p_variables_schema, '{}'::jsonb)
  );
  insert into public.document_template_versions (template_id, storage_path, original_filename, checksum_sha256)
  values (p_template_id, p_storage_path, p_original_filename, p_checksum_sha256);
  return p_template_id;
end;
$$;

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
  if not found then raise exception 'Карта не найдена'; end if;
  if v_source.status not in ('approved_by_customer', 'rejected_by_customer', 'cancelled') then
    raise exception 'Новую версию можно создать только из завершённой или отменённой карты';
  end if;
  if exists (select 1 from public.product_listing_cards c where c.previous_version_id = p_card_id) then
    raise exception 'У этой версии уже есть следующая версия';
  end if;
  insert into public.product_listing_cards (
    previous_version_id, card_type, counterparty_id, template_id, title, effective_date, notes, card_number
  ) values (
    v_source.id, v_source.card_type, v_source.counterparty_id,
    (select t.id from public.document_templates t
      where t.id = v_source.template_id and t.status = 'approved' and t.is_active
        and t.flow_direction = v_source.card_type
        and (t.counterparty_id is null or t.counterparty_id = v_source.counterparty_id)),
    v_source.title, v_source.effective_date, v_source.notes, v_source.card_number
  ) returning id into v_new_id;
  insert into public.product_listing_card_items (
    card_id, product_id, required_quantity, uom, counterparty_sku, price, currency_id, comment
  )
  select v_new_id, i.product_id, i.required_quantity, i.uom, i.counterparty_sku, i.price, i.currency_id, i.comment
  from public.product_listing_card_items i where i.card_id = v_source.id;
  return v_new_id;
end;
$$;

revoke execute on function public.register_document_template(uuid, uuid, text, text, text, text, text, text, uuid, jsonb, text) from public, anon, service_role;
grant execute on function public.register_document_template(uuid, uuid, text, text, text, text, text, text, uuid, jsonb, text) to authenticated;

grant insert (flow_direction) on public.document_templates to authenticated;
grant update (flow_direction) on public.document_templates to authenticated;

-- The grants survive column renames, but re-grant explicitly for readable fresh state.
grant insert (id, card_type, counterparty_id, template_id, document_id, title, effective_date, notes)
  on public.product_listing_cards to authenticated;
grant update (card_type, counterparty_id, template_id, document_id, title, effective_date, notes)
  on public.product_listing_cards to authenticated;
grant insert (card_id, product_id, required_quantity, uom, counterparty_sku, price, currency_id, comment)
  on public.product_listing_card_items to authenticated;
grant update (required_quantity, uom, counterparty_sku, price, currency_id, comment)
  on public.product_listing_card_items to authenticated;

-- Keep document Storage policies scoped after a legacy document migration is
-- re-applied. Template uploads live under templates/ and must not match them.
do $$
begin
  if to_regclass('storage.objects') is null then
    raise notice 'Supabase Storage schema not found: document file policies not refreshed';
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
end;
$$;

update public.permissions set
  name = 'Карты ввода/вывода: решение контрагента',
  description = 'Фиксация решения поставщика или покупателя по карте'
where code = 'listing_cards.approve';

comment on column public.document_templates.flow_direction is 'input: data/template from supplier; output: data/template for buyer';
comment on column public.product_listing_cards.counterparty_id is 'Supplier for input cards; buyer/customer for output cards';
comment on column public.product_listing_card_items.counterparty_sku is 'Counterparty-specific article: supplier SKU on input, buyer SKU on output';
