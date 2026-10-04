-- Reconcile legacy prefixed product codes with the canonical ARSEO article from the
-- master calculator. Global barcodes remain the identity proof; ambiguous matches
-- are deliberately left to the reference importer as conflicts.

create or replace function private.prepare_calculator_reference(p_reference jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_product jsonb;
  v_prepared_products jsonb := '[]'::jsonb;
  v_matches jsonb := '[]'::jsonb;
  v_incoming_sku text;
  v_existing_sku text;
  v_candidate_ids uuid[];
  v_candidate_id uuid;
begin
  for v_product in
    select value from jsonb_array_elements(coalesce(p_reference -> 'products', '[]'::jsonb))
  loop
    v_incoming_sku := nullif(btrim(v_product ->> 'internal_sku'), '');
    v_candidate_ids := null;
    v_candidate_id := null;
    v_existing_sku := null;

    if v_incoming_sku is not null
       and not exists (select 1 from public.products p where p.internal_sku = v_incoming_sku) then
      select array_agg(distinct pi.product_id order by pi.product_id)
      into v_candidate_ids
      from jsonb_array_elements(
        case when jsonb_typeof(v_product -> 'identifiers') = 'array'
          then v_product -> 'identifiers' else '[]'::jsonb end
      ) incoming
      join public.product_identifiers pi
        on pi.identifier_type in ('gtin', 'unit_barcode', 'box_barcode')
       and private.barcode_key(pi.value) = private.barcode_key(incoming ->> 'value')
      where incoming ->> 'type' in ('gtin', 'unit_barcode', 'box_barcode')
        and nullif(btrim(incoming ->> 'value'), '') is not null;

      if cardinality(v_candidate_ids) = 1 then
        v_candidate_id := v_candidate_ids[1];
        select p.internal_sku into v_existing_sku
        from public.products p
        where p.id = v_candidate_id and p.status <> 'archived';
      end if;
    end if;

    if v_existing_sku is not null then
      v_prepared_products := v_prepared_products || jsonb_build_array(
        jsonb_set(v_product, '{internal_sku}', to_jsonb(v_existing_sku), false)
      );
      v_matches := v_matches || jsonb_build_array(jsonb_build_object(
        'product_id', v_candidate_id,
        'current_sku', v_existing_sku,
        'desired_sku', v_incoming_sku
      ));
    else
      v_prepared_products := v_prepared_products || jsonb_build_array(v_product);
    end if;
  end loop;

  return jsonb_build_object(
    'reference', jsonb_set(p_reference, '{products}', v_prepared_products, true),
    'matches', v_matches
  );
end;
$$;

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

 v_prepared:=private.prepare_calculator_reference(p_payload->'reference');
 v_report:=public.import_reference_data(v_prepared->'reference',p_dry_run);
 if coalesce(p_dry_run,true) then
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
 return v_report||jsonb_build_object('master_data',jsonb_build_object(
   'rows',v_count,'applied',true,'matched_by_barcode',v_renamed));
end $$;

revoke all on function private.prepare_calculator_reference(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.import_calculator_master_data(jsonb,boolean) from public,anon,authenticated,service_role;
grant execute on function public.import_calculator_master_data(jsonb,boolean) to authenticated;

comment on function private.prepare_calculator_reference(jsonb) is
  'Matches calculator rows to one existing product by globally unique barcodes without accepting ambiguous ownership';
comment on function public.import_calculator_master_data(jsonb,boolean) is
  'Atomic calculator import; reconciles one barcode owner to the canonical ARSEO article while preserving product UUIDs';
