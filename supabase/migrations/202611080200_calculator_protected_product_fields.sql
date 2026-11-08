-- Existing catalogue shelf life and customs codes take priority over calculator snapshots.
-- The original source values remain in product_master_data; manual product editing remains available.
-- Production data repair is a separate owner-approved, audited operation, not a migration fixture.
create or replace function public.import_calculator_master_data(p_payload jsonb,p_dry_run boolean default true)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare
 v_report jsonb;
 v_existing public.products%rowtype;
 v_product jsonb;
 v_products jsonb:='[]';
 v_protected jsonb:='[]';
 v_life numeric;
 v_hs text;
 v_source jsonb:=p_payload->'source';
 v_prepared jsonb;
 v_match jsonb;
 v_row jsonb;
 v_product_id uuid;
 v_count integer:=0;
 v_renamed integer:=0;
 v_price_settings private.calculator_purchase_settings%rowtype;
begin
 if not ((select private.has_permission('products.view') and private.has_permission('products.create')) and (select private.has_permission('products.update'))) then
  raise exception 'Недостаточно прав для импорта справочника' using errcode='42501';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('nexus.calculator_import',0));
 if not (private.has_permission('products.view') and private.has_permission('products.create') and private.has_permission('products.update')) then
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

 -- Keep the same lock order as generic reference imports: reference, then rows.
 -- Lock before reading the current catalogue so a concurrent manual edit wins.
 perform pg_advisory_xact_lock(hashtextextended('nexus.reference_import',0));
 v_prepared:=private.prepare_calculator_reference(p_payload->'reference');
 perform p.id from public.products p
  where p.internal_sku in (select btrim(x->>'internal_sku') from jsonb_array_elements(v_prepared->'reference'->'products') x)
  order by p.id for update;
 if not (private.has_permission('products.view') and private.has_permission('products.create') and private.has_permission('products.update')) then
  raise exception 'Недостаточно прав для импорта справочника' using errcode='42501';
 end if;
 if exists(select 1 from jsonb_array_elements(v_source->'rows') x where x->'confidential_data'<>'{}'::jsonb)
  and not private.has_permission('prices.purchase.view') then
  raise exception 'Нет доступа к закупочным ценам и расчётным данным' using errcode='42501';
 end if;
 for v_product in select value from jsonb_array_elements(v_prepared->'reference'->'products') loop
  -- Validate even protected incoming values; protection must not hide malformed input.
  v_life:=private.ri_number(v_product,'shelf_life_days',0,36501,true,'Калькулятор');
  v_hs:=private.ri_text(v_product,'hs_code',10,'Калькулятор');
  if v_hs is not null and v_hs !~ '^[0-9]{4,10}$' then
   raise exception 'Калькулятор: ТН ВЭД должен содержать от 4 до 10 цифр';
  end if;
  select * into v_existing from public.products where internal_sku=btrim(v_product->>'internal_sku');
  if found then
   if v_existing.shelf_life_days is not null and v_life is not null and v_existing.shelf_life_days<>v_life then
    v_protected:=v_protected||jsonb_build_array(jsonb_build_object('sku',v_product->>'internal_sku','field','shelf_life_days','nexus_value',v_existing.shelf_life_days,'source_value',v_life));
    v_product:=jsonb_set(v_product,'{shelf_life_days}',to_jsonb(v_existing.shelf_life_days));
   end if;
   if nullif(btrim(v_existing.hs_code),'') is not null and v_hs is not null and v_existing.hs_code<>v_hs then
    v_protected:=v_protected||jsonb_build_array(jsonb_build_object('sku',v_product->>'internal_sku','field','hs_code','nexus_value',v_existing.hs_code,'source_value',v_hs));
    v_product:=jsonb_set(v_product,'{hs_code}',to_jsonb(v_existing.hs_code));
   end if;
  end if;
  v_products:=v_products||jsonb_build_array(v_product);
 end loop;
 v_prepared:=jsonb_set(v_prepared,'{reference,products}',v_products);
 v_report:=public.import_reference_data(v_prepared->'reference',p_dry_run)
  ||jsonb_build_object('protected_fields',v_protected);
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
 if jsonb_array_length(v_protected)>0 then
  insert into public.audit_log(actor_user_id,action,entity_type,entity_id,metadata)
   values(auth.uid(),'calculator_fields_preserved','product_master_sources',v_source->>'key',
    jsonb_build_object('fields',v_protected,'reason','Сохранены заполненные срок годности и ТН ВЭД карточек Nexus'));
 end if;
 return v_report||jsonb_build_object('master_data',jsonb_build_object(
   'rows',v_count,'applied',true,'matched_by_barcode',v_renamed));
end $$;


revoke all on function public.import_calculator_master_data(jsonb,boolean) from public,anon,authenticated,service_role;
grant execute on function public.import_calculator_master_data(jsonb,boolean) to authenticated;
