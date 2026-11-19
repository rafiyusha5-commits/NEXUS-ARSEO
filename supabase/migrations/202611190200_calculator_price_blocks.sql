-- Calculated and established prices of the master calculator (audit 2026-11-18, P6). Owner decisions of 2026-11-19
-- (damirator1-afk), see docs/calculator-master-import.md:
--   * the parser looked for the start of «УСТАНОВЛЕННЫЕ ЦЕНЫ» at the first «ЦП в КЗ сеть с НДС, тенге», which stands
--     inside «РАСЧЕТНЫЕ ЦЕНЫ». Since the first import the calculated columns carried the block and keys of the
--     established prices, and the established ones the same keys with ".2". The parser now searches each block after
--     the previous one (src/lib/calculator-import/parser.ts);
--   * calculated prices (block «РАСЧЕТНЫЕ ЦЕНЫ» without margin and cost) get their own access level "calculated":
--     stored in product_master_data.calculated_data and shown with the new right pricing.calculated.view. The right is
--     given to every role that sees products, as before; an administrator can take it from a role on «Роли»;
--   * the stored description of the calculator, the loaded product data and the price types are renamed once to what
--     the corrected parser produces, together with the header fingerprint, so the next synchronisation continues
--     without a structure review. The Google sheet is not touched: Nexus only reads it.
-- Idempotent: on a description that is already correct the renaming changes nothing.
begin;

-- Right ------------------------------------------------------------------------------------------------------
insert into public.permissions(code, module, action, name, description)
values ('pricing.calculated.view', 'pricing', 'calculated_view', 'Расчётные цены калькулятора: просмотр',
        'Цены блока «Расчётные цены» мастер-калькулятора в карточке товара')
on conflict (code) do nothing;

-- As before the change: whoever sees products sees calculated prices. Given once, at the first application.
insert into public.role_permissions(role_id, permission_id, granted)
select rp.role_id, p.id, true
  from public.role_permissions rp
  join public.permissions v on v.id = rp.permission_id and v.code = 'products.view' and rp.granted
  cross join public.permissions p
 where p.code = 'pricing.calculated.view'
   and not exists (select 1 from public.role_permissions x where x.permission_id = p.id)
on conflict (role_id, permission_id) do nothing;

-- Storage ----------------------------------------------------------------------------------------------------
-- Not in the column grant of product_master_data: read only through my_product_master_calculated_data.
alter table public.product_master_data
  add column if not exists calculated_data jsonb not null default '{}'::jsonb check (jsonb_typeof(calculated_data) = 'object');

create or replace function public.my_product_master_calculated_data(p_product_ids uuid[] default null)
returns table(product_id uuid, source_key text, calculated_data jsonb, imported_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not ((select private.is_employee()) and (select private.has_permission('products.view'))
          and (select private.has_permission('pricing.calculated.view'))) then
    raise exception 'Нет доступа к расчётным ценам калькулятора' using errcode = '42501';
  end if;
  return query select d.product_id, d.source_key, d.calculated_data, d.imported_at from public.product_master_data d
   where p_product_ids is null or d.product_id = any(p_product_ids);
end $$;
revoke all on function public.my_product_master_calculated_data(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.my_product_master_calculated_data(uuid[]) to authenticated;

-- Import accepts the fourth bucket ---------------------------------------------------------------------------
create or replace function private.validate_calculator_import(p_payload jsonb)
returns void language plpgsql stable security definer set search_path=''
as $$
declare v_source jsonb:=p_payload->'source';v_row jsonb;v_column jsonb;v_key text;v_seen text[]:='{}';v_bucket text;
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
  if v_column->>'visibility' not in ('catalog','sales','confidential','calculated') then raise exception 'Некорректный доступ у колонки %',v_key;end if;
  v_seen:=array_append(v_seen,v_key);
 end loop;
 for v_row in select value from jsonb_array_elements(v_source->'rows') loop
  if nullif(btrim(v_row->>'internal_sku'),'') is null or coalesce((v_row->>'row')::integer,0)<6 then raise exception 'Строка источника без артикула или номера';end if;
  if jsonb_typeof(v_row->'catalog_data')<>'object' or jsonb_typeof(v_row->'sales_data')<>'object' or jsonb_typeof(v_row->'confidential_data')<>'object'
     or jsonb_typeof(coalesce(v_row->'calculated_data','{}'::jsonb))<>'object' then
   raise exception 'Данные товара % должны быть объектами',v_row->>'internal_sku';
  end if;
  if nullif(v_row->>'category','') is not null and length(btrim(v_row->>'category'))>100 then raise exception 'Слишком длинная категория у %',v_row->>'internal_sku';end if;
  foreach v_bucket in array array['catalog','sales','confidential','calculated'] loop
   if exists(select 1 from jsonb_object_keys(coalesce(v_row->(v_bucket||'_data'),'{}'::jsonb)) as keys(key)
     where not exists(select 1 from jsonb_array_elements(v_source->'columns') as cols(value) where cols.value->>'key'=keys.key and cols.value->>'visibility'=v_bucket)) then
    raise exception '%',case v_bucket when 'catalog' then 'Каталожное поле' when 'sales' then 'Поле продаж' when 'confidential' then 'Закрытое поле'
      else 'Расчётная цена' end||' не соответствует схеме у '||(v_row->>'internal_sku');
   end if;
  end loop;
 end loop;
 if (select count(*) from jsonb_array_elements(v_source->'rows'))<>(select count(distinct value->>'internal_sku') from jsonb_array_elements(v_source->'rows')) then
  raise exception 'В калькуляторе повторяется артикул ARSEO';
 end if;
end $$;
revoke all on function private.validate_calculator_import(jsonb) from public,anon,authenticated,service_role;

-- The import (202611080200) and the structure review (202611080100) learn the new bucket. Their texts are long and
-- otherwise unchanged, so only the affected fragments are replaced, with a check that each is found once.
do $$
declare f text; d text; v_pair text[];
begin
  f := 'public.import_calculator_master_data(jsonb,boolean)';
  d := pg_get_functiondef(f::regprocedure);
  if position('calculated_data' in d) = 0 then
    foreach v_pair slice 1 in array array[
      array['(product_id,source_key,source_row,catalog_data,sales_data,confidential_data,imported_at,imported_by)',
            '(product_id,source_key,source_row,catalog_data,sales_data,confidential_data,calculated_data,imported_at,imported_by)'],
      array['v_row->''confidential_data'',now(),auth.uid())',
            'v_row->''confidential_data'',coalesce(v_row->''calculated_data'',''{}''::jsonb),now(),auth.uid())'],
      array['confidential_data=excluded.confidential_data,imported_at=now()',
            'confidential_data=excluded.confidential_data,calculated_data=excluded.calculated_data,imported_at=now()']] loop
      if (length(d) - length(replace(d, v_pair[1], ''))) / length(v_pair[1]) <> 1 then
        raise exception 'Unknown calculator import definition: %', v_pair[1];
      end if;
      d := replace(d, v_pair[1], v_pair[2]);
    end loop;
    execute d;
  end if;

  f := 'public.review_calculator_schema(jsonb,boolean,text)';
  d := pg_get_functiondef(f::regprocedure);
  if position('''calculated''' in d) = 0 then
    foreach v_pair slice 1 in array array[
      array['not in (''catalog'',''sales'',''confidential'') then',
            'not in (''catalog'',''sales'',''confidential'',''calculated'') then'],
      array['then ''confidential'' else ''sales'' end)',
            'then ''confidential'' when v_column->>''block''=''РАСЧЕТНЫЕ ЦЕНЫ'' then ''calculated'' else ''sales'' end)']] loop
      if (length(d) - length(replace(d, v_pair[1], ''))) / length(v_pair[1]) <> 1 then
        raise exception 'Unknown calculator schema review definition: %', v_pair[1];
      end if;
      d := replace(d, v_pair[1], v_pair[2]);
    end loop;
    execute d;
  end if;
end $$;

-- The corrected description of the two price blocks ----------------------------------------------------------
-- What the corrected parser produces from the same header: the calculated block ends at its last field
-- «EXW Almaty/Aktobe, KAZAKHSTAN БЕЗ НДС EUR»; everything after it in the two price blocks is established. Keys keep
-- the field part and get the block of their own; a repeated field in one block gets ".2", ".3" in column order.
create or replace function private.calculator_corrected_columns(p_columns jsonb)
returns table(old_key text, new_key text, old_visibility text, new_visibility text, columns jsonb)
language sql immutable set search_path = '' as $$
  with c as (
    select value as col, (value->>'position')::integer as pos from jsonb_array_elements(p_columns)
  ), bounds as (
    select min(pos) filter (where col->>'block' in ('РАСЧЕТНЫЕ ЦЕНЫ', 'УСТАНОВЛЕННЫЕ ЦЕНЫ')
      and regexp_replace(lower(btrim(col->>'field_ru')), '\s+', ' ', 'g') = 'exw almaty/aktobe, kazakhstan без ндс eur') as calc_end
    from c
  ), placed as (
    select c.col, c.pos,
           case when c.col->>'block' in ('РАСЧЕТНЫЕ ЦЕНЫ', 'УСТАНОВЛЕННЫЕ ЦЕНЫ') and b.calc_end is not null
                then case when c.pos <= b.calc_end then 'РАСЧЕТНЫЕ ЦЕНЫ' else 'УСТАНОВЛЕННЫЕ ЦЕНЫ' end end as block
      from c cross join bounds b
  ), based as (
    select col, pos, block,
           case when block is not null then
             'source.' || case block when 'РАСЧЕТНЫЕ ЦЕНЫ' then 'расчетные_цены' else 'установленные_цены' end || '.' ||
             regexp_replace(regexp_replace(col->>'key', '^source\.(расчетные_цены|установленные_цены)\.', ''), '\.[0-9]+$', '')
           end as base
      from placed
  ), keyed as (
    select col, pos, block,
           case when block is null then col->>'key'
                else base || case when row_number() over (partition by base order by pos) > 1
                                  then '.' || row_number() over (partition by base order by pos) else '' end end as key,
           case when block is null then col->>'visibility'
                when block = 'РАСЧЕТНЫЕ ЦЕНЫ' then case when lower(col->>'field_ru') ~ 'маржа|себестоимость' then 'confidential' else 'calculated' end
                else case when lower(col->>'field_ru') ~ 'маржа' then 'confidential' else 'sales' end end as visibility
      from based
  )
  select k.col->>'key', k.key, k.col->>'visibility', k.visibility,
         (select jsonb_agg(case when x.block is null then x.col
                                else x.col || jsonb_build_object('block', x.block, 'key', x.key, 'visibility', x.visibility) end
                           order by x.pos) from keyed x)
    from keyed k
$$;
revoke all on function private.calculator_corrected_columns(jsonb) from public, anon, authenticated, service_role;

-- The header fingerprint of src/lib/calculator-import/parser.ts: sorted "key|block|field|visibility" lines, with the
-- two legacy labels of STABLE_SCHEMA_LABELS.
create or replace function private.calculator_header_fingerprint(p_columns jsonb)
returns text language sql immutable set search_path = '' as $$
  select string_agg(line, E'\n' order by line collate "C") from (
    select concat_ws('|', c->>'key', coalesce(c->>'block', ''),
             case lower(btrim(c->>'field_ru'))
               when 'штук на паллете' then 'Количество коробов на паллете'
               when 'количество штук на паллете' then 'Количество коробов на паллете'
               when 'количество штук в фуре' then 'Количество паллет в машине'
               when 'количество штук в машине' then 'Количество паллет в машине'
               else c->>'field_ru' end,
             c->>'visibility') as line
      from jsonb_array_elements(p_columns) c) lines
$$;
revoke all on function private.calculator_header_fingerprint(jsonb) from public, anon, authenticated, service_role;

-- Renames the stored description, the loaded product data and the price types once. Returns the number of sources
-- changed; 0 when the description is already correct.
create or replace function private.fix_calculator_price_blocks()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  s public.product_master_sources;
  v_columns jsonb;
  v_map jsonb;
  v_changed integer := 0;
begin
  for s in select * from public.product_master_sources where source_key = 'arseo-master-calculator' for update loop
    select (array_agg(columns))[1], jsonb_object_agg(old_key, jsonb_build_object('key', new_key, 'visibility', new_visibility, 'old_visibility', old_visibility))
      into v_columns, v_map
      from private.calculator_corrected_columns(s.columns);
    if v_columns is null or v_columns = s.columns then continue; end if;

    -- Loaded product data: every value moves to its corrected key and access level.
    update public.product_master_data d
       set sales_data = coalesce(x.sales, '{}'::jsonb), confidential_data = coalesce(x.confidential, '{}'::jsonb),
           calculated_data = coalesce(x.calculated, '{}'::jsonb)
      from (
        select d2.product_id, d2.source_key,
               jsonb_object_agg(e.new_key, e.value) filter (where e.bucket = 'sales') as sales,
               jsonb_object_agg(e.new_key, e.value) filter (where e.bucket = 'confidential') as confidential,
               jsonb_object_agg(e.new_key, e.value) filter (where e.bucket = 'calculated') as calculated
          from public.product_master_data d2
          cross join lateral (
            select coalesce(v_map->kv.key->>'key', kv.key) as new_key, kv.value,
                   coalesce(v_map->kv.key->>'visibility', kv.bucket) as bucket
              from (select key, value, 'sales' as bucket from jsonb_each(d2.sales_data)
                    union all select key, value, 'confidential' from jsonb_each(d2.confidential_data)
                    union all select key, value, 'calculated' from jsonb_each(d2.calculated_data)) kv
          ) e
         where d2.source_key = s.source_key
         group by d2.product_id, d2.source_key
      ) x
     where d.product_id = x.product_id and d.source_key = x.source_key;

    -- Price types read the established prices by key and position.
    update public.price_types t
       set source_column_key = v_map->t.source_column_key->>'key'
      from jsonb_array_elements(s.columns) c
     where c->>'key' = t.source_column_key and (c->>'position')::integer = t.source_position
       and v_map ? t.source_column_key and v_map->t.source_column_key->>'key' is distinct from t.source_column_key;

    update public.product_master_sources
       set columns = v_columns, header_fingerprint = private.calculator_header_fingerprint(v_columns), updated_at = now()
     where source_key = s.source_key;
    v_changed := v_changed + 1;
  end loop;
  -- No calculator loaded yet (a new installation): the price types of 202611170100 still carry the ".2" keys that
  -- the corrected parser no longer produces.
  if not exists (select 1 from public.product_master_sources where source_key = 'arseo-master-calculator') then
    update public.price_types
       set source_column_key = regexp_replace(source_column_key, '\.2$', '')
     where source_column_key ~ '^source\.установленные_цены\..+\.2$';
  end if;
  return v_changed;
end $$;
revoke all on function private.fix_calculator_price_blocks() from public, anon, authenticated, service_role;

select private.fix_calculator_price_blocks();

commit;
