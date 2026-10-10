-- Explicit purchase-price mapping for saved calculator snapshots. Google Sheets stays read-only.
create table if not exists private.calculator_purchase_settings (
 source_key text primary key references public.product_master_sources(source_key) on delete cascade,
 currency_id uuid not null references public.currencies(id),
 price_uom text not null check (price_uom='piece'),
 updated_by uuid not null references public.profiles(id),updated_at timestamptz not null default now()
);
create table if not exists private.calculator_purchase_links (
 product_id uuid primary key references public.products(id) on delete cascade,
 source_key text not null references public.product_master_sources(source_key),
 price numeric(14,4) not null,currency_id uuid not null references public.currencies(id),
 price_uom text not null,source_row integer not null,updated_at timestamptz not null default now()
);
revoke all on private.calculator_purchase_settings,private.calculator_purchase_links from public,anon,authenticated,service_role;

create or replace function private.calculator_purchase_projection(p_source jsonb,p_currency_id uuid,p_uom text,p_apply boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_key text;v_keys integer;v_row jsonb;v_product public.products%rowtype;v_link private.calculator_purchase_links%rowtype;
 v_currency_key text;v_currency_keys integer;v_row_currency uuid;v_currency_raw text;v_currency_code text;
 v_raw text;v_price numeric;v_action text;v_items jsonb:='[]';v_updates integer:=0;v_unchanged integer:=0;v_skipped integer:=0;
begin
 if not exists(select 1 from public.currencies where id=p_currency_id and is_active) then raise exception 'Валюта не найдена или неактивна' using errcode='22023';end if;
 if p_uom is distinct from 'piece' then raise exception 'Цена калькулятора должна быть подтверждена за штуку' using errcode='22023';end if;
 select count(*),min(c->>'key') into v_keys,v_key from jsonb_array_elements(p_source->'columns') c
 where c->>'visibility'='confidential' and c->>'block'='Информация о закупе' and c->>'field_ru'='Цена за единицу';
 if v_keys<>1 then raise exception 'В калькуляторе не определена единственная закупочная цена за единицу' using errcode='22023';end if;
 select count(*),min(c->>'key') into v_currency_keys,v_currency_key from jsonb_array_elements(p_source->'columns') c where c->>'block'='Информация о закупе' and c->>'field_ru'='Валюта закупа';
 if v_currency_keys>1 then raise exception 'В калькуляторе неоднозначно задана валюта закупа' using errcode='22023';end if;
 for v_row in select value from jsonb_array_elements(p_source->'rows') order by value->>'internal_sku' loop
  select * into v_product from public.products where internal_sku=v_row->>'internal_sku' for update;
  v_currency_raw:=nullif(upper(btrim((coalesce(v_row->'catalog_data','{}')||coalesce(v_row->'sales_data','{}')||coalesce(v_row->'confidential_data','{}'))->>v_currency_key)),'');
  v_row_currency:=p_currency_id;
  if v_currency_raw is not null then
   select id into v_row_currency from public.currencies where code=case v_currency_raw when 'ЕВРО' then 'EUR' when '€' then 'EUR' else v_currency_raw end and is_active;
  end if;
  select code into v_currency_code from public.currencies where id=v_row_currency;
  v_raw:=nullif(regexp_replace(btrim(v_row->'confidential_data'->>v_key),'[[:space:]]','','g'),'');v_price:=null;
  if v_row_currency is null then v_action:='invalid_currency';
  elsif v_raw is null then v_action:='missing_price';
  elsif replace(v_raw,',','.') !~ '^[0-9]+([.][0-9]+)?$' or length(v_raw)>30 then v_action:='invalid_price';
  else
   v_price:=round(replace(v_raw,',','.')::numeric,4);
   if v_price>9999999999.9999 then v_action:='invalid_price';
   elsif v_product.id is null then v_action:='new_product';
   elsif v_product.status='archived' or v_product.archived_at is not null then v_action:='archived';
   elsif v_product.base_uom is distinct from p_uom then v_action:='unit_mismatch';
   else
    select * into v_link from private.calculator_purchase_links where product_id=v_product.id;
    if v_product.base_purchase_price is not null and not
      (v_product.base_purchase_price is not distinct from v_price and v_product.default_currency_id is not distinct from v_row_currency) and not
      (v_link.product_id is not null and v_link.source_key=p_source->>'key' and
       v_product.base_purchase_price is not distinct from v_link.price and v_product.default_currency_id is not distinct from v_link.currency_id and v_product.base_uom is not distinct from v_link.price_uom)
    then v_action:='manual_conflict';
    elsif v_product.base_purchase_price is not distinct from v_price and v_product.default_currency_id is not distinct from v_row_currency
    then v_action:='unchanged';
    else v_action:='update';end if;
   end if;
  end if;
  if v_action='update' then v_updates:=v_updates+1;elsif v_action='unchanged' then v_unchanged:=v_unchanged+1;else v_skipped:=v_skipped+1;end if;
  v_items:=v_items||jsonb_build_array(jsonb_build_object('sku',v_row->>'internal_sku','action',v_action,'price',v_price,
    'currency',v_currency_code,'old_price',v_product.base_purchase_price,'old_currency_id',v_product.default_currency_id,'source_row',v_row->'row'));
  if p_apply and v_action in ('update','unchanged') then
   if v_action='update' then update public.products set base_purchase_price=v_price,default_currency_id=v_row_currency,updated_at=now() where id=v_product.id;end if;
   insert into private.calculator_purchase_links(product_id,source_key,price,currency_id,price_uom,source_row)
   values(v_product.id,p_source->>'key',v_price,v_row_currency,p_uom,(v_row->>'row')::integer)
   on conflict(product_id) do update set source_key=excluded.source_key,price=excluded.price,currency_id=excluded.currency_id,
     price_uom=excluded.price_uom,source_row=excluded.source_row,updated_at=now();
  end if;
 end loop;
 return jsonb_build_object('applied',p_apply,'summary',jsonb_build_object('update',v_updates,'unchanged',v_unchanged,'skipped',v_skipped),'items',v_items);
end $$;
revoke all on function private.calculator_purchase_projection(jsonb,uuid,text,boolean) from public,anon,authenticated,service_role;

create or replace function public.sync_calculator_purchase_prices(p_currency_code text,p_dry_run boolean default true,p_expected_hash text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_currency uuid;v_source jsonb;v_plan jsonb;v_hash text;v_apply boolean:=not coalesce(p_dry_run,true);
begin
 if not ((select private.has_permission('products.update')) and (select private.has_permission('prices.purchase.view'))) then
  raise exception 'Нет прав на изменение товаров и закупочные цены' using errcode='42501';end if;
 if p_currency_code is null or p_currency_code !~ '^[A-Z]{3}$' then raise exception 'Подтвердите валюту закупочной цены' using errcode='22023';end if;
 select id into v_currency from public.currencies where code=p_currency_code and is_active;
 if v_currency is null then raise exception 'Валюта не найдена или неактивна' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('nexus.calculator_import',0));
 select jsonb_build_object('key',s.source_key,'columns',s.columns,'rows',coalesce((select jsonb_agg(jsonb_build_object(
  'internal_sku',p.internal_sku,'row',d.source_row,'catalog_data',d.catalog_data,'sales_data',d.sales_data,'confidential_data',d.confidential_data) order by p.internal_sku)
  from public.product_master_data d join public.products p on p.id=d.product_id where d.source_key=s.source_key),'[]'))
 into v_source from public.product_master_sources s where s.source_key='arseo-master-calculator';
 if v_source is null then raise exception 'Сначала импортируйте снимок мастер-калькулятора' using errcode='22023';end if;
 v_plan:=private.calculator_purchase_projection(v_source,v_currency,'piece',false);
 v_hash:=encode(sha256(convert_to(jsonb_build_object('source',v_source,'currency',v_currency,'plan',v_plan)::text,'UTF8')),'hex');
 if v_apply then
  if p_expected_hash is distinct from v_hash then raise exception 'Данные изменились или не проверены. Повторите предпросмотр цен' using errcode='NX409';end if;
  insert into private.calculator_purchase_settings(source_key,currency_id,price_uom,updated_by)
  values('arseo-master-calculator',v_currency,'piece',auth.uid())
  on conflict(source_key) do update set currency_id=excluded.currency_id,price_uom=excluded.price_uom,updated_by=excluded.updated_by,updated_at=now();
  v_plan:=private.calculator_purchase_projection(v_source,v_currency,'piece',true);
  insert into public.audit_log(actor_user_id,action,entity_type,entity_id,metadata)
  values(auth.uid(),'calculator_purchase_sync','product_master_sources','arseo-master-calculator',
   jsonb_build_object('currency',p_currency_code,'price_uom','piece','summary',v_plan->'summary'));
 end if;
 return v_plan||jsonb_build_object('snapshot',v_hash,'currency',p_currency_code,'price_uom','piece');
end $$;
revoke all on function public.sync_calculator_purchase_prices(text,boolean,text) from public,anon,authenticated,service_role;
grant execute on function public.sync_calculator_purchase_prices(text,boolean,text) to authenticated;
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

