-- Complete ARSEO master-calculator snapshot, kept separately from the operational
-- product columns. Commercial values have stricter column/RPC access.

create table if not exists public.product_master_sources (
  source_key text primary key,
  title text not null,
  sheet_name text not null,
  schema_version integer not null default 1 check (schema_version > 0),
  header_rows integer not null default 5 check (header_rows between 1 and 20),
  header_fingerprint text not null,
  columns jsonb not null check (jsonb_typeof(columns) = 'array'),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

create table if not exists public.product_master_data (
  product_id uuid not null references public.products(id) on delete cascade,
  source_key text not null references public.product_master_sources(source_key) on delete restrict,
  source_row integer not null check (source_row >= 6),
  catalog_data jsonb not null default '{}'::jsonb check (jsonb_typeof(catalog_data) = 'object'),
  sales_data jsonb not null default '{}'::jsonb check (jsonb_typeof(sales_data) = 'object'),
  confidential_data jsonb not null default '{}'::jsonb check (jsonb_typeof(confidential_data) = 'object'),
  imported_at timestamptz not null default now(),
  imported_by uuid references public.profiles(id) on delete set null,
  primary key (product_id, source_key)
);
create index if not exists product_master_data_source_idx on public.product_master_data(source_key, source_row);

alter table public.product_master_sources enable row level security;
alter table public.product_master_data enable row level security;

drop policy if exists "employees view calculator schemas" on public.product_master_sources;
create policy "employees view calculator schemas" on public.product_master_sources for select to authenticated
using ((select private.is_employee()) and (select private.has_permission('products.view')));

drop policy if exists "employees view calculator product data" on public.product_master_data;
create policy "employees view calculator product data" on public.product_master_data for select to authenticated
using ((select private.is_employee()) and (select private.has_permission('products.view')));

revoke all on public.product_master_sources, public.product_master_data from public, anon, authenticated;
grant select (product_id,source_key,source_row,catalog_data,sales_data,imported_at,imported_by)
  on public.product_master_data to authenticated;

create or replace function private.validate_calculator_import(p_payload jsonb)
returns void language plpgsql stable security definer set search_path=''
as $$
declare v_source jsonb:=p_payload->'source';v_row jsonb;v_column jsonb;v_key text;v_seen text[]:='{}';
begin
 if p_payload->>'format'<>'nexus-calculator-import' or p_payload->>'version'<>'1' then
  raise exception 'Неверный формат импорта калькулятора';
 end if;
 if jsonb_typeof(p_payload->'reference')<>'object' or jsonb_typeof(v_source)<>'object' then
  raise exception 'В пакете отсутствуют reference или source';
 end if;
 if v_source->>'key'<>'arseo-master-calculator' or lower(v_source->>'sheet_name') not in ('расчеты','расчёты') then
  raise exception 'Ожидается лист «Расчёты» мастер-калькулятора';
 end if;
 if coalesce((v_source->>'header_rows')::integer,0)<>5 then raise exception 'Ожидаются пять строк заголовка';end if;
 if jsonb_typeof(v_source->'columns')<>'array' or jsonb_array_length(v_source->'columns')=0 then raise exception 'Не описаны колонки калькулятора';end if;
 if jsonb_typeof(v_source->'rows')<>'array' or jsonb_array_length(v_source->'rows')>1000 then raise exception 'Некорректное количество строк калькулятора';end if;
 for v_column in select value from jsonb_array_elements(v_source->'columns') loop
  v_key:=nullif(btrim(v_column->>'key'),'');
  if v_key is null or v_key=any(v_seen) then raise exception 'Пустой или повторяющийся ключ колонки: %',coalesce(v_key,'—');end if;
  if v_column->>'visibility' not in ('catalog','sales','confidential') then raise exception 'Некорректный доступ у колонки %',v_key;end if;
  v_seen:=array_append(v_seen,v_key);
 end loop;
 for v_row in select value from jsonb_array_elements(v_source->'rows') loop
  if nullif(btrim(v_row->>'internal_sku'),'') is null or coalesce((v_row->>'row')::integer,0)<6 then raise exception 'Строка источника без артикула или номера';end if;
  if jsonb_typeof(v_row->'catalog_data')<>'object' or jsonb_typeof(v_row->'sales_data')<>'object' or jsonb_typeof(v_row->'confidential_data')<>'object' then
   raise exception 'Данные товара % должны быть объектами',v_row->>'internal_sku';
  end if;
  if nullif(v_row->>'category','') is not null and length(btrim(v_row->>'category'))>100 then raise exception 'Слишком длинная категория у %',v_row->>'internal_sku';end if;
  if exists(select 1 from jsonb_object_keys(v_row->'catalog_data') as keys(key) where not exists(select 1 from jsonb_array_elements(v_source->'columns') as cols(value) where cols.value->>'key'=keys.key and cols.value->>'visibility'='catalog')) then raise exception 'Каталожное поле не соответствует схеме у %',v_row->>'internal_sku';end if;
  if exists(select 1 from jsonb_object_keys(v_row->'sales_data') as keys(key) where not exists(select 1 from jsonb_array_elements(v_source->'columns') as cols(value) where cols.value->>'key'=keys.key and cols.value->>'visibility'='sales')) then raise exception 'Поле продаж не соответствует схеме у %',v_row->>'internal_sku';end if;
  if exists(select 1 from jsonb_object_keys(v_row->'confidential_data') as keys(key) where not exists(select 1 from jsonb_array_elements(v_source->'columns') as cols(value) where cols.value->>'key'=keys.key and cols.value->>'visibility'='confidential')) then raise exception 'Закрытое поле не соответствует схеме у %',v_row->>'internal_sku';end if;
 end loop;
 if (select count(*) from jsonb_array_elements(v_source->'rows'))<>(select count(distinct value->>'internal_sku') from jsonb_array_elements(v_source->'rows')) then
  raise exception 'В калькуляторе повторяется артикул ARSEO';
 end if;
end $$;

create or replace function public.import_calculator_master_data(p_payload jsonb,p_dry_run boolean default true)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_report jsonb;v_source jsonb:=p_payload->'source';v_row jsonb;v_product_id uuid;v_count integer:=0;
begin
 if not ((select private.has_permission('products.create')) and (select private.has_permission('products.update'))) then
  raise exception 'Недостаточно прав для импорта справочника' using errcode='42501';
 end if;
 perform private.validate_calculator_import(p_payload);
 if exists(select 1 from public.product_master_sources s where s.source_key=v_source->>'key'
   and s.header_fingerprint is distinct from v_source->>'header_fingerprint') then
  raise exception 'Структура листа «Расчёты» изменилась. Сначала проверьте и утвердите новые названия блоков и полей' using errcode='NX409';
 end if;
 if exists(select 1 from jsonb_array_elements(v_source->'rows') as rows(value) where rows.value->'confidential_data'<>'{}'::jsonb)
    and not (select private.has_permission('prices.purchase.view')) then
  raise exception 'Нет доступа к закупочным ценам и расчётным данным' using errcode='42501';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('nexus.calculator_import',0));
 v_report:=public.import_reference_data(p_payload->'reference',p_dry_run);
 if coalesce(p_dry_run,true) then
  return v_report||jsonb_build_object('master_data',jsonb_build_object('rows',jsonb_array_length(v_source->'rows'),'applied',false));
 end if;
 insert into public.product_master_sources(source_key,title,sheet_name,schema_version,header_rows,header_fingerprint,columns,updated_at,updated_by)
 values(v_source->>'key',v_source->>'title',v_source->>'sheet_name',1,(v_source->>'header_rows')::integer,v_source->>'header_fingerprint',v_source->'columns',now(),auth.uid())
 on conflict(source_key) do update set title=excluded.title,sheet_name=excluded.sheet_name,schema_version=excluded.schema_version,
  header_rows=excluded.header_rows,header_fingerprint=excluded.header_fingerprint,columns=excluded.columns,updated_at=now(),updated_by=auth.uid();
 for v_row in select value from jsonb_array_elements(v_source->'rows') loop
  select id into v_product_id from public.products where internal_sku=v_row->>'internal_sku';
  if v_product_id is null then raise exception 'Товар % не найден после импорта',v_row->>'internal_sku';end if;
  if nullif(btrim(v_row->>'category'),'') is not null then
   update public.products set category=btrim(v_row->>'category'),updated_at=now() where id=v_product_id;
  end if;
  insert into public.product_master_data(product_id,source_key,source_row,catalog_data,sales_data,confidential_data,imported_at,imported_by)
  values(v_product_id,v_source->>'key',(v_row->>'row')::integer,v_row->'catalog_data',v_row->'sales_data',v_row->'confidential_data',now(),auth.uid())
  on conflict(product_id,source_key) do update set source_row=excluded.source_row,catalog_data=excluded.catalog_data,sales_data=excluded.sales_data,
   confidential_data=excluded.confidential_data,imported_at=now(),imported_by=auth.uid();
  v_count:=v_count+1;
 end loop;
 return v_report||jsonb_build_object('master_data',jsonb_build_object('rows',v_count,'applied',true));
end $$;

create or replace function public.my_product_master_sources(p_source_keys text[] default null)
returns table(source_key text,title text,sheet_name text,columns jsonb,updated_at timestamptz)
language plpgsql stable security definer set search_path=''
as $$declare v_prices boolean;begin
 if not ((select private.is_employee()) and (select private.has_permission('products.view'))) then
  raise exception 'Нет доступа к данным товаров' using errcode='42501';
 end if;
 v_prices:=(select private.has_permission('prices.purchase.view'));
 return query select s.source_key,s.title,s.sheet_name,
  case when v_prices then s.columns else coalesce((select jsonb_agg(c.value order by (c.value->>'position')::integer)
    from jsonb_array_elements(s.columns) as c(value) where c.value->>'visibility'<>'confidential'),'[]'::jsonb) end,
  s.updated_at from public.product_master_sources s where p_source_keys is null or s.source_key=any(p_source_keys);
end$$;

create or replace function public.my_product_master_confidential_data(p_product_ids uuid[] default null)
returns table(product_id uuid,source_key text,confidential_data jsonb,imported_at timestamptz)
language plpgsql stable security definer set search_path=''
as $$begin
 if not ((select private.is_employee()) and (select private.has_permission('products.view')) and (select private.has_permission('prices.purchase.view'))) then
  raise exception 'Нет доступа к закупочным ценам и расчётным данным' using errcode='42501';
 end if;
 return query select d.product_id,d.source_key,d.confidential_data,d.imported_at from public.product_master_data d
 where p_product_ids is null or d.product_id=any(p_product_ids);
end$$;

revoke all on function private.validate_calculator_import(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.import_calculator_master_data(jsonb,boolean) from public,anon,authenticated,service_role;
grant execute on function public.import_calculator_master_data(jsonb,boolean) to authenticated;
revoke all on function public.my_product_master_sources(text[]) from public,anon,authenticated,service_role;
grant execute on function public.my_product_master_sources(text[]) to authenticated;
revoke all on function public.my_product_master_confidential_data(uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.my_product_master_confidential_data(uuid[]) to authenticated;

comment on table public.product_master_sources is 'Exact 5-row header schema of ARSEO master sources; rows 1-2 are technical metadata';
comment on table public.product_master_data is 'Full per-product source snapshot split into catalogue, employee sales and purchase-confidential data';
comment on function public.import_calculator_master_data(jsonb,boolean) is 'Atomic dry-run/apply import of the ARSEO master calculator plus complete source fields';

