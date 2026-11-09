-- Explicit additive schema review. Google is an immutable external source.
-- This migration changes no existing source snapshots or business data.
create table if not exists private.calculator_schema_approvals (
 id uuid primary key default gen_random_uuid(),
 source_key text not null,
 previous_schema jsonb not null,
 approved_schema jsonb not null,
 approved_by uuid not null,
 approved_at timestamptz not null default clock_timestamp()
);
alter table private.calculator_schema_approvals enable row level security;
revoke all on private.calculator_schema_approvals from public,anon,authenticated,service_role;

-- Positions, technical numbering and English formula captions can change without
-- changing meaning. Preserve the two legacy display-label aliases used by parser.ts.
create or replace function private.calculator_schema_identity(p_columns jsonb)
returns jsonb language sql immutable set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object(
  'key',c->>'key','block',c->>'block','visibility',c->>'visibility',
  'field_ru',case lower(btrim(c->>'field_ru'))
   when 'штук на паллете' then 'Количество коробов на паллете'
   when 'количество штук на паллете' then 'Количество коробов на паллете'
   when 'количество штук в фуре' then 'Количество паллет в машине'
   when 'количество штук в машине' then 'Количество паллет в машине'
   else c->>'field_ru' end
 ) order by c->>'key'),'[]'::jsonb)
 from jsonb_array_elements(p_columns) c;
$$;
revoke all on function private.calculator_schema_identity(jsonb) from public,anon,authenticated,service_role;

create or replace function public.review_calculator_schema(
 p_source jsonb,p_confirm boolean default false,p_expected_schema text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 v_old public.product_master_sources%rowtype;
 v_old_identity jsonb; v_new_identity jsonb; v_previous jsonb; v_next jsonb;
 v_added jsonb; v_removed jsonb; v_changed jsonb; v_token text; v_status text;
 v_safe boolean; v_column jsonb;
begin
 if not (private.is_employee() and private.has_permission('products.view') and private.has_permission('products.create')
  and private.has_permission('products.update') and private.has_permission('prices.purchase.view')) then
  raise exception 'Нет доступа к проверке структуры калькулятора' using errcode='42501';
 end if;
 if p_confirm is null or jsonb_typeof(p_source) is distinct from 'object'
  or jsonb_typeof(p_source->'columns') is distinct from 'array'
  or jsonb_typeof(p_source->'header_fingerprint') is distinct from 'string'
  or coalesce(length(p_source->>'header_fingerprint'),0) not between 1 and 100000 then
  raise exception 'Некорректная структура калькулятора' using errcode='22023';
 end if;
 if jsonb_array_length(p_source->'columns') not between 1 and 500 then
  raise exception 'Некорректное число столбцов калькулятора' using errcode='22023';
 end if;
 for v_column in select value from jsonb_array_elements(p_source->'columns') loop
  if jsonb_typeof(v_column) is distinct from 'object'
   or jsonb_typeof(v_column->'key') is distinct from 'string'
   or jsonb_typeof(v_column->'field_ru') is distinct from 'string'
   or coalesce(jsonb_typeof(v_column->'block'),'null') not in ('string','null')
   or jsonb_typeof(v_column->'position') is distinct from 'number'
   or coalesce(length(btrim(v_column->>'key')),0) not between 1 and 500
   or coalesce(length(btrim(v_column->>'field_ru')),0) not between 1 and 500
   or coalesce(v_column->>'visibility','') not in ('catalog','sales','confidential') then
   raise exception 'Некорректное описание столбца калькулятора' using errcode='22023';
  end if;
  if (v_column->>'position')::numeric not between 1 and 500
   or (v_column->>'position')::numeric<>trunc((v_column->>'position')::numeric) then
   raise exception 'Некорректная позиция столбца калькулятора' using errcode='22023';
  end if;
 end loop;
 perform private.validate_calculator_import(jsonb_build_object(
  'format','nexus-calculator-import','version',1,'reference','{}'::jsonb,
  'source',p_source||jsonb_build_object('rows','[]'::jsonb)));
 if p_source->>'key' is distinct from 'arseo-master-calculator'
  or lower(p_source->>'sheet_name') is null
  or lower(p_source->>'sheet_name') not in ('расчеты','расчёты') then
  raise exception 'Неверный источник калькулятора' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('nexus.calculator_import',0));
 -- An access revocation while waiting must also reject an idempotent retry.
 if not (private.is_employee() and private.has_permission('products.view') and private.has_permission('products.create')
  and private.has_permission('products.update') and private.has_permission('prices.purchase.view')) then
  raise exception 'Нет доступа к проверке структуры калькулятора' using errcode='42501';
 end if;
 select * into v_old from public.product_master_sources where source_key=p_source->>'key' for update;
 if not found then
  if p_confirm then raise exception 'Сначала выполните обычную проверку импорта' using errcode='NX409'; end if;
  return jsonb_build_object('status','unchanged','current_count',0,'incoming_count',jsonb_array_length(p_source->'columns'),
   'added','[]'::jsonb,'removed','[]'::jsonb,'changed','[]'::jsonb,'expected_schema',null);
 end if;
 v_old_identity:=private.calculator_schema_identity(v_old.columns);
 v_new_identity:=private.calculator_schema_identity(p_source->'columns');
 v_previous:=jsonb_build_object('header_fingerprint',v_old.header_fingerprint,'columns',v_old.columns);
 v_next:=jsonb_build_object('header_fingerprint',p_source->>'header_fingerprint','columns',p_source->'columns');
 v_token:=encode(sha256(convert_to(v_previous::text,'UTF8')),'hex');
 select coalesce(jsonb_agg(n),'[]') into v_added from jsonb_array_elements(v_new_identity) n
  where not exists(select 1 from jsonb_array_elements(v_old_identity) o where o->>'key'=n->>'key');
 select coalesce(jsonb_agg(o),'[]') into v_removed from jsonb_array_elements(v_old_identity) o
  where not exists(select 1 from jsonb_array_elements(v_new_identity) n where o->>'key'=n->>'key');
 select coalesce(jsonb_agg(jsonb_build_object('before',o,'after',n)),'[]') into v_changed
  from jsonb_array_elements(v_old_identity) o join jsonb_array_elements(v_new_identity) n on o->>'key'=n->>'key'
  where o is distinct from n;
 -- Only additional sales/margin columns in existing price blocks are supported
 -- by this approval flow. Changes to identities, removals and access need review.
 v_safe:=jsonb_array_length(v_added)>0 and v_removed='[]' and v_changed='[]';
 for v_column in select value from jsonb_array_elements(v_added) loop
  if coalesce(v_column->>'block','') not in ('УСТАНОВЛЕННЫЕ ЦЕНЫ','РАСЧЕТНЫЕ ЦЕНЫ')
   or not exists(select 1 from jsonb_array_elements(v_old_identity) o where o->>'block'=v_column->>'block')
   or v_column->>'key' not like 'source.%'
   or v_column->>'visibility' is distinct from (case
     when lower((v_column->>'key')||' '||(v_column->>'field_ru')) ~ 'маржа|себестоимость|закупочн|предыдущая.цена'
     then 'confidential' else 'sales' end) then v_safe:=false;
  end if;
 end loop;
 v_status:=case when v_old_identity=v_new_identity and v_old.header_fingerprint=p_source->>'header_fingerprint'
  then 'unchanged' when v_safe then 'approval_required' else 'blocked' end;
 if p_confirm and v_status<>'unchanged' then
  if p_expected_schema is distinct from v_token then
   raise exception 'Структура Nexus изменилась после проверки. Повторите чтение' using errcode='NX409';
  end if;
  if not v_safe then raise exception 'Изменение структуры требует отдельной проверки доступа и сопоставления' using errcode='NX409'; end if;
  insert into private.calculator_schema_approvals(source_key,previous_schema,approved_schema,approved_by)
   values(v_old.source_key,v_previous,v_next,auth.uid());
  update public.product_master_sources set columns=p_source->'columns',header_fingerprint=p_source->>'header_fingerprint',
   updated_at=clock_timestamp(),updated_by=auth.uid() where source_key=v_old.source_key;
  v_status:='approved';
 end if;
 return jsonb_build_object('status',v_status,'current_count',jsonb_array_length(v_old.columns),
  'incoming_count',jsonb_array_length(p_source->'columns'),'added',v_added,'removed',v_removed,'changed',v_changed,'expected_schema',v_token);
end $$;
revoke all on function public.review_calculator_schema(jsonb,boolean,text) from public,anon,authenticated,service_role;
grant execute on function public.review_calculator_schema(jsonb,boolean,text) to authenticated;

-- Preserve the import rules; serialize schema checks with approval and import.
create or replace function public.import_calculator_master_data(p_payload jsonb,p_dry_run boolean default true)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare
 v_report jsonb;
 v_source jsonb:=p_payload->'source';
 v_prepared jsonb;
 v_match jsonb;
 v_row jsonb;
 v_product_id uuid;
 v_count integer:=0;
 v_renamed integer:=0;
 v_price_settings private.calculator_purchase_settings%rowtype;
begin
 if not ((select private.has_permission('products.create')) and (select private.has_permission('products.update'))) then
  raise exception 'Недостаточно прав для импорта справочника' using errcode='42501';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('nexus.calculator_import',0));
 if not (private.has_permission('products.create') and private.has_permission('products.update')) then
  raise exception 'Недостаточно прав для импорта справочника' using errcode='42501';
 end if;
 perform private.validate_calculator_import(p_payload);
 if exists(select 1 from public.product_master_sources s where s.source_key=v_source->>'key'
   and (s.header_fingerprint is distinct from v_source->>'header_fingerprint'
    or private.calculator_schema_identity(s.columns) is distinct from private.calculator_schema_identity(v_source->'columns'))) then
  raise exception 'Структура листа «Расчёты» изменилась. Сначала проверьте и утвердите новые названия блоков и полей' using errcode='NX409';
 end if;
 if exists(select 1 from jsonb_array_elements(v_source->'rows') as rows(value) where rows.value->'confidential_data'<>'{}'::jsonb)
    and not (select private.has_permission('prices.purchase.view')) then
  raise exception 'Нет доступа к закупочным ценам и расчётным данным' using errcode='42501';
 end if;

 v_prepared:=private.prepare_calculator_reference(p_payload->'reference');
 v_report:=public.import_reference_data(v_prepared->'reference',p_dry_run);
 select * into v_price_settings from private.calculator_purchase_settings where source_key=v_source->>'key';
 if coalesce(p_dry_run,true) then
  if v_price_settings.source_key is not null then v_report:=v_report||jsonb_build_object('purchase_prices',private.calculator_purchase_projection(v_source,v_price_settings.currency_id,v_price_settings.price_uom,false));end if;
  return v_report||jsonb_build_object('master_data',jsonb_build_object(
    'rows',jsonb_array_length(v_source->'rows'),'applied',false,
    'matched_by_barcode',jsonb_array_length(v_prepared->'matches')));
 end if;

 -- The generic import has already validated every incoming identifier against this
 -- exact existing product. Renaming changes no UUID-based operational relationships.
 for v_match in select value from jsonb_array_elements(v_prepared->'matches') loop
  if exists(select 1 from public.products p
    where p.internal_sku=v_match->>'desired_sku' and p.id<>(v_match->>'product_id')::uuid) then
   raise exception 'Артикул % уже принадлежит другому товару',v_match->>'desired_sku' using errcode='NX409';
  end if;
  update public.products
  set internal_sku=v_match->>'desired_sku',updated_at=now()
  where id=(v_match->>'product_id')::uuid and internal_sku=v_match->>'current_sku';
  if found then v_renamed:=v_renamed+1; end if;
 end loop;

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
 if v_price_settings.source_key is not null then v_report:=v_report||jsonb_build_object('purchase_prices',private.calculator_purchase_projection(v_source,v_price_settings.currency_id,v_price_settings.price_uom,true));end if;
 return v_report||jsonb_build_object('master_data',jsonb_build_object(
   'rows',v_count,'applied',true,'matched_by_barcode',v_renamed));
end $$;


revoke all on function public.import_calculator_master_data(jsonb,boolean) from public,anon,authenticated,service_role;
grant execute on function public.import_calculator_master_data(jsonb,boolean) to authenticated;
