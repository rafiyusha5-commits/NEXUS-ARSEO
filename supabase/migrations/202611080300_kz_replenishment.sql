-- Planning metadata only: no inventory, shipment, finance or confirmation updates.
create or replace function private.can_replenish() returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and private.has_permission('purchase_plans.detail')
 and private.has_permission('products.view') and private.has_permission('inventory.view')
 and private.has_permission('sales.view') and private.has_permission('shipments.view')
 and private.has_permission('customers.view')
 and private.has_permission('suppliers.view') and private.has_permission('warehouses.view')
$$;
revoke all on function private.can_replenish() from public,anon,authenticated,service_role;

create table if not exists public.replenishment_profiles (
 id uuid primary key default gen_random_uuid(), supplier_id uuid not null references public.counterparties(id),
 name text not null check(length(btrim(name)) between 2 and 120), settings jsonb not null,
 reason text not null check(length(btrim(reason)) between 3 and 1000),
 created_by uuid not null references public.profiles(id), created_at timestamptz not null default clock_timestamp()
);
create index if not exists replenishment_profiles_supplier_idx on public.replenishment_profiles(supplier_id);
create index if not exists replenishment_profiles_actor_idx on public.replenishment_profiles(created_by);
create table if not exists public.replenishment_purposes (
 id uuid primary key default gen_random_uuid(), profile_id uuid not null references public.replenishment_profiles(id),
 source_key text not null, source_signature text not null, kz_quantity numeric not null check(kz_quantity>=0),
 export_quantity numeric not null check(export_quantity>=0), city text check(city in ('astana','almaty')),
 export_sale_id uuid references public.sales(id), reason text not null check(length(btrim(reason)) between 3 and 1000),
 expiry date, manufactured date, arrival date,
 created_by uuid not null references public.profiles(id), created_at timestamptz not null default clock_timestamp()
);
create index if not exists replenishment_purposes_source_idx on public.replenishment_purposes(profile_id,source_key,created_at desc);
alter table public.replenishment_purposes add column if not exists expiry date, add column if not exists manufactured date, add column if not exists arrival date;
create index if not exists replenishment_purposes_actor_idx on public.replenishment_purposes(created_by);
create index if not exists replenishment_purposes_sale_idx on public.replenishment_purposes(export_sale_id);
create table if not exists public.replenishment_runs (
 id uuid primary key, profile_id uuid not null references public.replenishment_profiles(id),
 snapshot jsonb not null, fingerprint text not null, algorithm text not null check(algorithm='kz-daily-fefo-v1'),
 created_by uuid not null references public.profiles(id), created_at timestamptz not null default clock_timestamp()
);
create index if not exists replenishment_runs_profile_idx on public.replenishment_runs(profile_id,created_at desc);
create index if not exists replenishment_runs_actor_idx on public.replenishment_runs(created_by);
create unique index if not exists replenishment_runs_same_input_idx on public.replenishment_runs(profile_id,fingerprint,algorithm);
create table if not exists public.replenishment_decisions (
 id uuid primary key default gen_random_uuid(), run_id uuid not null references public.replenishment_runs(id),
 kind text not null check(kind in ('forecast','purchase')), payload jsonb not null,
 forecast_id uuid references public.forecasts(id), purchase_plan_id uuid references public.purchase_plans(id),
 reason text not null check(length(btrim(reason)) between 3 and 1000),
 created_by uuid not null references public.profiles(id), created_at timestamptz not null default clock_timestamp(),
 unique(run_id,kind)
);
create index if not exists replenishment_decisions_forecast_idx on public.replenishment_decisions(forecast_id);
create index if not exists replenishment_decisions_plan_idx on public.replenishment_decisions(purchase_plan_id);
create index if not exists replenishment_decisions_actor_idx on public.replenishment_decisions(created_by);

alter table public.replenishment_profiles enable row level security;
alter table public.replenishment_purposes enable row level security;
alter table public.replenishment_runs enable row level security;
alter table public.replenishment_decisions enable row level security;
revoke all on public.replenishment_profiles,public.replenishment_purposes,public.replenishment_runs,public.replenishment_decisions from public,anon,authenticated,service_role;
-- Reading through RPC also checks current underlying permissions; no direct write path.

create or replace function public.replenishment_create_profile(p_supplier_id uuid,p_name text,p_settings jsonb,p_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare result uuid; k text; x jsonb; a uuid; b uuid; c uuid;
begin
 if not private.can_replenish() or not private.has_permission('purchase_plans.create') then raise exception 'Недостаточно прав для автозаказа' using errcode='42501';end if;
 if jsonb_typeof(p_settings)<>'object' or p_settings is null or length(p_settings::text)>100000 then raise exception 'Некорректные настройки';end if;
 if (p_settings - array['aktobe','astana','almaty','productionDays','transitDays','cityDays','reviewDays','transferDays','historyDays','serviceZ','historyConfirmed','overrides'])<>'{}'::jsonb then raise exception 'Неизвестные настройки';end if;
 foreach k in array array['productionDays','transitDays','cityDays','reviewDays','transferDays','historyDays'] loop
  if coalesce(p_settings->>k,'') !~ '^\d{1,3}$' or (p_settings->>k)::int not between 0 and 365 then raise exception 'Проверьте срок %',k;end if;
 end loop;
 if (p_settings->>'historyDays')::int not between 7 and 365 or (p_settings->>'reviewDays')::int<1
 or (p_settings->>'productionDays')::int+(p_settings->>'transitDays')::int+(p_settings->>'cityDays')::int+(p_settings->>'reviewDays')::int not between 1 and 366 then raise exception 'Проверьте горизонт';end if;
 if coalesce(jsonb_typeof(p_settings->'serviceZ'),'')<>'number' or (p_settings->>'serviceZ')::numeric not between 0 and 3
 or coalesce(jsonb_typeof(p_settings->'historyConfirmed'),'')<>'boolean'
 or coalesce(jsonb_typeof(p_settings->'overrides'),'')<>'array' or jsonb_array_length(p_settings->'overrides')>1000 then raise exception 'Проверьте настройки спроса';end if;
 a:=(p_settings->>'aktobe')::uuid;b:=(p_settings->>'astana')::uuid;c:=(p_settings->>'almaty')::uuid;
 if a is null or b is null or c is null or a=b or b=c or a=c or (select count(*) from public.warehouses where id in(a,b,c) and status='active')<>3 then raise exception 'Выберите три разных действующих склада';end if;
 if not exists(select 1 from public.counterparties where id=p_supplier_id and status='active' and roles&&array['manufacturer','supplier']) then raise exception 'Выберите поставщика';end if;
 for x in select value from jsonb_array_elements(p_settings->'overrides') loop
  if jsonb_typeof(x)<>'object' or x-array['productId','city','daily','reason']<>'{}'::jsonb
  or coalesce(x->>'city','') not in('astana','almaty') or coalesce(jsonb_typeof(x->'daily'),'')<>'number'
  or (x->>'daily')::numeric not between 0 and 1000000 or coalesce(length(btrim(x->>'reason')),0) not between 3 and 1000
  or not exists(select 1 from public.products p join public.product_suppliers ps on ps.product_id=p.id and ps.supplier_id=p_supplier_id and ps.status='active' where p.id=(x->>'productId')::uuid and p.status='active') then raise exception 'Проверьте ручной спрос';end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(p_settings->'overrides') item group by item->>'productId',item->>'city' having count(*)>1) then raise exception 'Повтор ручного спроса';end if;
 insert into public.replenishment_profiles(supplier_id,name,settings,reason,created_by) values(p_supplier_id,btrim(p_name),p_settings,btrim(p_reason),auth.uid()) returning id into result;
 return result;
end$$;

-- Authoritative sources. Availability is in pieces and excludes physical reservations once.
create or replace function private.replenishment_sources(p_profile public.replenishment_profiles)
returns jsonb language sql stable security definer set search_path='' as $$
 with products as (select p.* from public.products p where p.status='active' and exists(select 1 from public.product_suppliers ps where ps.product_id=p.id and ps.supplier_id=p_profile.supplier_id and ps.status='active')),
 stock as (
  select 'balance:'||b.id as id,p.id as product_id,b.warehouse_id,ib.batch_number as batch,
   (b.quantity_on_hand-b.quantity_reserved)*coalesce(private.uom_pieces(p.id,b.uom),1) as quantity,
   ib.expiry_date as expiry,ib.manufacture_date as manufactured,private.business_today() as available_on,'stock'::text as kind,
   ib.status='available' as usable,private.uom_pieces(p.id,b.uom) is not null as converted, greatest(1,coalesce(private.uom_pieces(p.id,b.uom),1)) as step,
   md5(row_to_json(b)::text||row_to_json(ib)::text||coalesce(private.uom_pieces(p.id,b.uom)::text,'')) as signature
  from public.inventory_balances b join public.inventory_batches ib on ib.id=b.batch_id join products p on p.id=ib.product_id
  where b.quantity_on_hand>b.quantity_reserved and b.warehouse_id in ((p_profile.settings->>'aktobe')::uuid,(p_profile.settings->>'astana')::uuid,(p_profile.settings->>'almaty')::uuid)
 ), inbound as (
  select 'item:'||i.id,p.id,s.destination_warehouse_id,s.shipment_number,
   greatest(0,coalesce(i.shipped_quantity,i.confirmed_quantity,0)-coalesce(i.received_quantity,0))*coalesce(private.uom_pieces(p.id,i.uom),1),
   null::date,null::date,coalesce(t.planned_arrival_date,s.planned_arrival_date)+(p_profile.settings->>'cityDays')::int,'inbound',
   coalesce(t.planned_arrival_date,s.planned_arrival_date)>=private.business_today(),private.uom_pieces(p.id,i.uom) is not null, greatest(1,coalesce(private.uom_pieces(p.id,i.uom),1)),
   md5(row_to_json(i)::text||row_to_json(s)::text||coalesce(row_to_json(t)::text,'')||coalesce(private.uom_pieces(p.id,i.uom)::text,''))
  from public.shipment_items i join public.shipments s on s.id=i.shipment_id join products p on p.id=i.product_id
  left join public.shipment_transports t on t.id=i.shipment_transport_id
  where s.type='import' and s.status not in('cancelled','closed','on_hold') and coalesce(t.status,'planned') not in('cancelled','unloaded')
   and i.received_quantity is null and coalesce(i.shipped_quantity,i.confirmed_quantity,0)>0
 ) select coalesce(jsonb_agg(jsonb_build_object('id',id,'productId',product_id,'warehouseId',warehouse_id,'batch',batch,'quantity',quantity,
 'expiry',expiry,'manufactured',manufactured,'availableOn',coalesce(available_on,private.business_today()),'kind',kind,'usable',coalesce(usable,false),
 'conversionKnown',converted,'step',step,'signature',signature) order by id),'[]') from (select * from stock union all select * from inbound) q
$$;
revoke all on function private.replenishment_sources(public.replenishment_profiles) from public,anon,authenticated,service_role;

create or replace function public.replenishment_set_purpose(p_profile_id uuid,p_source_key text,p_signature text,p_kz numeric,p_export numeric,p_city text,p_export_sale_id uuid,p_reason text,p_expiry date default null,p_manufactured date default null,p_arrival date default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare profile public.replenishment_profiles; source jsonb; result uuid;
begin
 if not private.can_replenish() or not private.has_permission('purchase_plans.update') then raise exception 'Недостаточно прав для назначения товара' using errcode='42501';end if;
 select * into strict profile from public.replenishment_profiles where id=p_profile_id for update;
 if not private.can_replenish() or not private.has_permission('purchase_plans.update') then raise exception 'Недостаточно прав после ожидания' using errcode='42501';end if;
 select x into source from jsonb_array_elements(private.replenishment_sources(profile)) x where x->>'id'=p_source_key;
 if source is null or source->>'signature' is distinct from p_signature then raise exception 'Остаток или поставка изменились. Обновите данные';end if;
 if p_kz is null or p_export is null or p_kz<0 or p_export<0 or p_kz+p_export>(source->>'quantity')::numeric then raise exception 'Назначение превышает свободное количество';end if;
 if p_export>0 and not exists(select 1 from public.sales s join public.counterparties c on c.id=s.customer_id where s.id=p_export_sale_id and s.status not in('cancelled','shipped') and c.country<>'KZ') then raise exception 'Укажите действующий экспортный заказ';end if;
 if p_city is not null and p_city not in('astana','almaty') then raise exception 'Проверьте город';end if;
 if source->>'kind'='inbound' and p_kz>0 and p_city is null then raise exception 'Для ожидаемого прихода укажите город Казахстана';end if;
 if p_manufactured is not null and (p_expiry is null or p_manufactured>=p_expiry) then raise exception 'Проверьте даты партии';end if;
 if source->>'kind'='stock' and (p_expiry is not null or p_manufactured is not null or p_arrival is not null) then raise exception 'Даты складской партии берутся только из складского учёта';end if;
 if p_arrival is not null and p_arrival<private.business_today() then raise exception 'Приход в прошлом нельзя считать ожидаемым';end if;
 -- Identical retries do not multiply history. A changed reason is a new explicit decision.
 select id into result from public.replenishment_purposes where profile_id=p_profile_id and source_key=p_source_key
 and id=(select recent.id from public.replenishment_purposes recent where recent.profile_id=p_profile_id and recent.source_key=p_source_key order by recent.created_at desc,recent.id desc limit 1)
 and source_signature=p_signature and kz_quantity=p_kz and export_quantity=p_export and city is not distinct from p_city
 and export_sale_id is not distinct from p_export_sale_id and expiry is not distinct from p_expiry and manufactured is not distinct from p_manufactured and arrival is not distinct from p_arrival and reason=btrim(p_reason) order by created_at desc limit 1;
 if result is not null then return result;end if;
 insert into public.replenishment_purposes(profile_id,source_key,source_signature,kz_quantity,export_quantity,city,export_sale_id,reason,created_by,expiry,manufactured,arrival)
 values(p_profile_id,p_source_key,p_signature,p_kz,p_export,p_city,p_export_sale_id,btrim(p_reason),auth.uid(),p_expiry,p_manufactured,p_arrival) returning id into result;
 return result;
end$$;

create or replace function private.replenishment_snapshot(p_profile public.replenishment_profiles)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; products jsonb; sales jsonb; supplies jsonb; commitments jsonb; source jsonb; purpose public.replenishment_purposes;
 today date:=private.business_today(); start_date date; qty numeric; warnings jsonb:='[]';
begin
 start_date:=today-(p_profile.settings->>'historyDays')::int;
 if (select count(*) from public.products p where p.status='active' and exists(select 1 from public.product_suppliers ps where ps.product_id=p.id and ps.supplier_id=p_profile.supplier_id and ps.status='active'))>500 then raise exception 'Разделите ассортимент: максимум 500 товаров в расчёте';end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'sku',p.internal_sku,'name',p.name->>'ru','shelfDays',p.shelf_life_days,
 'multiple',private.uom_pieces(p.id,'box'),'minimum',0) order by p.id),'[]') into products
 from public.products p where p.status='active' and exists(select 1 from public.product_suppliers ps where ps.product_id=p.id and ps.supplier_id=p_profile.supplier_id and ps.status='active');
 select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'productId',i.product_id,'city',case when s.warehouse_id=(p_profile.settings->>'astana')::uuid then 'astana' else 'almaty' end,
 'customerId',s.customer_id,'date',private.business_date(s.shipped_at),'quantity',i.quantity*private.uom_pieces(i.product_id,i.uom),
 'requiredPct',req.required_pct) order by i.id),'[]') into sales
 from public.sale_items i join public.sales s on s.id=i.sale_id join public.counterparties c on c.id=s.customer_id
 cross join lateral private.shelf_life_requirement(s.customer_id,i.product_id,today) req
 where s.status='shipped' and c.country='KZ' and private.business_date(s.shipped_at) between start_date and today-1
 and s.warehouse_id in ((p_profile.settings->>'astana')::uuid,(p_profile.settings->>'almaty')::uuid)
 and exists(select 1 from jsonb_array_elements(products) p where p->>'id'=i.product_id::text);
 if exists(select 1 from jsonb_array_elements(sales) x where x->'quantity'='null'::jsonb) then raise exception 'Для истории продаж не задан пересчёт упаковки';end if;
 if jsonb_array_length(sales)>50000 then raise exception 'Слишком большая история: уменьшите период';end if;
 select coalesce(jsonb_agg(jsonb_build_object('productId',i.product_id,'city',case when s.warehouse_id=(p_profile.settings->>'astana')::uuid then 'astana' else 'almaty' end,
 'quantity',i.quantity*private.uom_pieces(i.product_id,i.uom),'requiredPct',req.required_pct,'reserved',coalesce((select sum(r.quantity*private.uom_pieces(i.product_id,b.uom)) from public.inventory_reservations r join public.inventory_balances b on b.id=r.inventory_balance_id where r.sale_item_id=i.id and r.status='active'),0)) order by i.id),'[]') into commitments
 from public.sale_items i join public.sales s on s.id=i.sale_id join public.counterparties c on c.id=s.customer_id
 cross join lateral private.shelf_life_requirement(s.customer_id,i.product_id,coalesce(s.planned_shipment_date,today)) req
 where s.status in('confirmed','reserved') and c.country='KZ' and s.warehouse_id in ((p_profile.settings->>'astana')::uuid,(p_profile.settings->>'almaty')::uuid)
 and coalesce(s.planned_shipment_date,today)<today+(p_profile.settings->>'productionDays')::int+(p_profile.settings->>'transitDays')::int+(p_profile.settings->>'cityDays')::int+(p_profile.settings->>'reviewDays')::int
 and exists(select 1 from jsonb_array_elements(products) p where p->>'id'=i.product_id::text);
 supplies:='[]';
 for source in select value from jsonb_array_elements(private.replenishment_sources(p_profile)) loop
  select * into purpose from public.replenishment_purposes where profile_id=p_profile.id and source_key=source->>'id' order by created_at desc,id desc limit 1;
  qty:=(source->>'quantity')::numeric;
  if purpose.source_signature is not distinct from source->>'signature' and purpose.kz_quantity+purpose.export_quantity<=qty
   and (purpose.export_quantity=0 or exists(select 1 from public.sales es where es.id=purpose.export_sale_id and es.status not in('cancelled','shipped'))) then
   if source->>'kind'='inbound' then source:=source||jsonb_build_object('expiry',purpose.expiry,'manufactured',purpose.manufactured,'availableOn',coalesce(purpose.arrival,(source->>'availableOn')::date),'usable',case when purpose.arrival is not null then purpose.arrival>=today else (source->>'usable')::boolean end);end if;
   if purpose.kz_quantity>0 then supplies:=supplies||jsonb_build_array((source-'signature')||jsonb_build_object('id',(source->>'id')||':kz','quantity',purpose.kz_quantity,'purpose','kz','city',purpose.city));end if;
   if purpose.export_quantity>0 then supplies:=supplies||jsonb_build_array((source-'signature')||jsonb_build_object('id',(source->>'id')||':export','quantity',purpose.export_quantity,'purpose','export','city',null));end if;
   qty:=qty-purpose.kz_quantity-purpose.export_quantity;
  end if;
  if qty>0 then supplies:=supplies||jsonb_build_array((source-'signature')||jsonb_build_object('id',(source->>'id')||':unknown','quantity',qty,'purpose','unknown','city',null));end if;
 end loop;
 if exists(select 1 from jsonb_array_elements(supplies) x where x->>'kind'='inbound' and x->>'purpose'<>'export' and (x->>'usable'='false' or x->'expiry'='null'::jsonb)) then warnings:=warnings||'"Есть ожидаемый приход без надёжной даты или срока годности; перед закупкой уточните его, чтобы избежать лишнего заказа"'::jsonb;end if;
 if exists(select 1 from public.shipment_items i join public.shipments s on s.id=i.shipment_id where s.type='import' and s.status not in('closed','cancelled','on_hold') and s.supplier_id=p_profile.supplier_id and i.received_quantity is null and coalesce(i.confirmed_quantity,i.shipped_quantity,0)=0) then
  warnings:=warnings||'"Есть уже заказанный товар без подтверждения поставщика: уточните незавершённые закупки перед новым заказом"'::jsonb;
 end if;
 result:=jsonb_build_object('asOf',today,'historyStart',start_date,'historyEnd',today-1,'settings',p_profile.settings,'products',products,'sales',sales,'supplies',supplies,'commitments',commitments,'warnings',warnings);
 return result;
end$$;
revoke all on function private.replenishment_snapshot(public.replenishment_profiles) from public,anon,authenticated,service_role;

create or replace function public.replenishment_workspace(p_profile_id uuid default null,p_run_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare profile public.replenishment_profiles; run public.replenishment_runs; snapshot jsonb;
begin
 if not private.can_replenish() then raise exception 'Для автозаказа нужны права на планы закупок, товары, склад, продажи, клиентов и поставки' using errcode='42501';end if;
 if p_run_id is not null then select * into strict run from public.replenishment_runs where id=p_run_id;p_profile_id:=run.profile_id;end if;
 if p_profile_id is not null then
  select * into strict profile from public.replenishment_profiles where id=p_profile_id;
  snapshot:=private.replenishment_snapshot(profile);
 end if;
 return jsonb_build_object(
 'profiles',(select coalesce(jsonb_agg(to_jsonb(p) order by p.created_at desc),'[]') from public.replenishment_profiles p),
 'warehouses',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name->>'ru') order by name->>'ru'),'[]') from public.warehouses where status='active'),
 'suppliers',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',legal_name) order by legal_name),'[]') from public.counterparties where status='active' and roles&&array['supplier','manufacturer']),
 'profile',to_jsonb(profile),'snapshot',case when p_run_id is null then snapshot else run.snapshot end,
 'fresh',p_run_id is null or run.fingerprint=md5(snapshot::text),
 'sources',case when p_profile_id is not null then private.replenishment_sources(profile) else '[]'::jsonb end,
 'purposes',(select coalesce(jsonb_agg(to_jsonb(p) order by created_at desc),'[]') from public.replenishment_purposes p where profile_id=p_profile_id),
 'runs',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'created_at',created_at,'algorithm',algorithm) order by created_at desc),'[]') from public.replenishment_runs where profile_id=p_profile_id),
 'decisions',(select coalesce(jsonb_agg(to_jsonb(d) order by created_at),'[]') from public.replenishment_decisions d where run_id=p_run_id)
 );
end$$;

create or replace function public.replenishment_capture(p_profile_id uuid,p_request_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare profile public.replenishment_profiles; v_snapshot jsonb; old public.replenishment_runs;
begin
 if not private.can_replenish() or not private.has_permission('purchase_plans.create') then raise exception 'Недостаточно прав для расчёта' using errcode='42501';end if;
 if p_request_id is null then raise exception 'Не указан ключ операции';end if;
 select * into strict profile from public.replenishment_profiles where id=p_profile_id for update;
 if not private.can_replenish() or not private.has_permission('purchase_plans.create') then raise exception 'Недостаточно прав после ожидания' using errcode='42501';end if;
 select * into old from public.replenishment_runs where id=p_request_id;
 if found then
  if old.profile_id<>p_profile_id or old.created_by<>auth.uid() then raise exception 'Ключ операции уже использован';end if;
  return old.id;
 end if;
 v_snapshot:=private.replenishment_snapshot(profile);
 select * into old from public.replenishment_runs where profile_id=p_profile_id and fingerprint=md5(v_snapshot::text) and algorithm='kz-daily-fefo-v1';
 if found then return old.id;end if;
 insert into public.replenishment_runs(id,profile_id,snapshot,fingerprint,algorithm,created_by) values(p_request_id,p_profile_id,v_snapshot,md5(v_snapshot::text),'kz-daily-fefo-v1',auth.uid());
 return p_request_id;
end$$;

-- Explicit proposal -> existing draft -> existing commercial/logistics/director approval.
-- Payload is an employee proposal, never a privileged or already-approved model result.
create or replace function public.replenishment_prepare_draft(p_run_id uuid,p_kind text,p_lines jsonb,p_reason text,p_forecast_id uuid default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare run public.replenishment_runs; profile public.replenishment_profiles; prior public.replenishment_decisions; x jsonb; p jsonb;
 result uuid; finish date; wh uuid; horizon int; snapshot jsonb; period date; first_day date; period_qty numeric; remaining_qty numeric;
begin
 if not private.can_replenish() or not private.has_permission('purchase_plans.create') then raise exception 'Недостаточно прав' using errcode='42501';end if;
 select * into strict run from public.replenishment_runs where id=p_run_id for update;
 select * into strict profile from public.replenishment_profiles where id=run.profile_id for update;
 if not private.can_replenish() or not private.has_permission('purchase_plans.create') then raise exception 'Недостаточно прав после ожидания' using errcode='42501';end if;
 if p_kind is null or p_kind not in('forecast','purchase') or jsonb_typeof(p_lines)<>'array' or p_lines is null or jsonb_array_length(p_lines) not between 1 and 1000 or coalesce(length(btrim(p_reason)),0) not between 3 and 1000 then raise exception 'Проверьте предложение и причину';end if;
 if p_kind='forecast' and not(private.has_permission('forecasts.create') and private.has_permission('forecasts.update'))
 or p_kind='purchase' and not(private.has_permission('purchase_plans.update') and private.has_permission('forecasts.detail')) then raise exception 'Недостаточно прав' using errcode='42501';end if;
 select * into prior from public.replenishment_decisions where run_id=p_run_id and kind=p_kind;
 if found then
  if prior.payload is distinct from p_lines or prior.reason is distinct from btrim(p_reason) or (p_kind='purchase' and prior.forecast_id is distinct from p_forecast_id) then raise exception 'Повтор содержит другое решение';end if;
  return case when p_kind='forecast' then prior.forecast_id else prior.purchase_plan_id end;
 end if;
 snapshot:=private.replenishment_snapshot(profile);
 if md5(snapshot::text)<>run.fingerprint then raise exception 'Исходные данные изменились. Сохраните новый расчёт';end if;
 if jsonb_array_length(snapshot->'warnings')>0 or exists(select 1 from jsonb_array_elements(snapshot->'supplies') s where s->>'purpose'='unknown' or s->>'conversionKnown'='false') then raise exception 'Сначала уточните назначение товара, ожидаемые приходы и упаковку';end if;
 horizon:=(profile.settings->>'productionDays')::int+(profile.settings->>'transitDays')::int+(profile.settings->>'cityDays')::int+(profile.settings->>'reviewDays')::int;
 finish:=(run.snapshot->>'asOf')::date+horizon-1;
 if exists(select 1 from jsonb_array_elements(p_lines) item group by item->>'productId',case when p_kind='forecast' then item->>'city' else '' end having count(*)>1) then raise exception 'Повтор позиции';end if;
 for x in select value from jsonb_array_elements(p_lines) loop
  select q into p from jsonb_array_elements(run.snapshot->'products') q where q->>'id'=x->>'productId';
  if p is null or jsonb_typeof(x)<>'object' or x-array['productId','city','quantity','stock','inbound','safety']<>'{}'::jsonb or coalesce(jsonb_typeof(x->'quantity'),'')<>'number' or (x->>'quantity')::numeric not between 0.001 and 100000000 then raise exception 'Проверьте товар и количество';end if;
  if exists(select 1 from jsonb_each(x) v where v.key in('stock','inbound','safety') and (jsonb_typeof(v.value)<>'number' or (v.value::text)::numeric not between 0 and 100000000)) then raise exception 'Проверьте расчётные количества';end if;
  if p_kind='forecast' and coalesce(x->>'city','') not in('astana','almaty') then raise exception 'Укажите город';end if;
  if p_kind='purchase' and (p->>'multiple' is null or (p->>'multiple')::numeric<=0 or mod((x->>'quantity')::numeric,(p->>'multiple')::numeric)<>0) then raise exception 'Количество должно быть кратно коробу';end if;
 end loop;
 if p_kind='forecast' then
  first_day:=(run.snapshot->>'asOf')::date;
  result:=public.create_forecast('Автозаказ KZ '||left(run.id::text,8),'base',date_trunc('month',first_day)::date,finish,'month','manual');
  for x in select value from jsonb_array_elements(p_lines) loop
   wh:=(profile.settings->>(x->>'city'))::uuid;
   remaining_qty:=(x->>'quantity')::numeric;
   for period in select generate_series(date_trunc('month',first_day),date_trunc('month',finish),interval '1 month')::date loop
    period_qty:=case when period=date_trunc('month',finish)::date then remaining_qty else round((x->>'quantity')::numeric*(least(finish,(period+interval '1 month')::date-1)-greatest(period,first_day)+1)/horizon,3) end;
    remaining_qty:=remaining_qty-period_qty;
    if period_qty>0 then perform public.upsert_forecast_line(result,(x->>'productId')::uuid,null,wh,period,period_qty,0,'Автозаказ '||run.id||'; только дни '||greatest(period,first_day)||'—'||least(finish,(period+interval '1 month')::date-1)||'. '||btrim(p_reason));end if;
   end loop;
  end loop;
  update public.forecasts set method_params=jsonb_build_object('replenishment_run',run.id,'algorithm',run.algorithm),input_snapshot_at=run.created_at where id=result;
 else
  if not exists(select 1 from public.replenishment_decisions d where d.run_id=run.id and d.kind='forecast' and d.forecast_id=p_forecast_id) then raise exception 'Выберите прогноз, подготовленный из этого расчёта';end if;
  -- Profiles are independent versions; serialize proposals for the same supplier across them.
  perform pg_advisory_xact_lock(hashtextextended('kz-replenishment:'||profile.supplier_id::text,0));
  if not private.can_replenish() or not private.has_permission('purchase_plans.create') or not private.has_permission('purchase_plans.update') or not private.has_permission('forecasts.detail') then raise exception 'Недостаточно прав после ожидания' using errcode='42501';end if;
  if exists(select 1 from public.purchase_plans pp join public.purchase_plan_lines pl on pl.purchase_plan_id=pp.id
    where pp.supplier_id=profile.supplier_id and pp.status in('draft','in_review','approved') and exists(select 1 from jsonb_array_elements(p_lines) item where item->>'productId'=pl.product_id::text)) then
   raise exception 'По этим товарам уже есть незавершённый план закупки. Проверьте существующий план';end if;
  if not exists(select 1 from public.forecasts f where f.id=p_forecast_id and f.status='approved' and f.horizon_start<=(run.snapshot->>'asOf')::date and f.horizon_end>=finish) then raise exception 'Нужен утверждённый прогноз на весь горизонт';end if;
  if exists(select 1 from public.forecast_lines fl where fl.forecast_id=p_forecast_id and (fl.warehouse_id is null or fl.warehouse_id not in((profile.settings->>'astana')::uuid,(profile.settings->>'almaty')::uuid) or (fl.customer_id is not null and not exists(select 1 from public.counterparties c where c.id=fl.customer_id and c.country='KZ')))) then raise exception 'Прогноз должен относиться только к Астане и Алматы и рынку Казахстана';end if;
  if exists(
   with expected as (select (item->>'productId')::uuid product_id,(profile.settings->>(item->>'city'))::uuid warehouse_id,(item->>'quantity')::numeric qty
    from public.replenishment_decisions d cross join lateral jsonb_array_elements(d.payload) item where d.run_id=run.id and d.kind='forecast'),
   actual as (select product_id,warehouse_id,sum(final_quantity) qty from public.forecast_lines where forecast_id=p_forecast_id group by product_id,warehouse_id)
   select 1 from expected e full join actual a using(product_id,warehouse_id) where e.qty is distinct from a.qty
  ) then raise exception 'Прогноз изменён при согласовании. Новый расчёт должен учитывать утверждённые количества';end if;
  result:=public.create_purchase_plan('Автозаказ KZ '||left(run.id::text,8),p_forecast_id,profile.supplier_id);
  for x in select value from jsonb_array_elements(p_lines) loop
   select q into p from jsonb_array_elements(run.snapshot->'products') q where q->>'id'=x->>'productId';
   if not exists(select 1 from public.forecast_lines fl where fl.forecast_id=p_forecast_id and fl.product_id=(x->>'productId')::uuid) then raise exception 'В прогнозе отсутствует товар';end if;
   perform public.upsert_purchase_plan_line(result,(x->>'productId')::uuid,coalesce((x->>'stock')::numeric,0),coalesce((x->>'inbound')::numeric,0),0,coalesce((x->>'safety')::numeric,0),0,(x->>'quantity')::numeric,'box',(p->>'multiple')::numeric,(x->>'quantity')::numeric,(run.snapshot->>'asOf')::date,'Предложение, не утверждение. В складских полях — используемый свободный запас KZ. Расчёт '||run.id||'. '||btrim(p_reason));
  end loop;
 end if;
 insert into public.replenishment_decisions(run_id,kind,payload,forecast_id,purchase_plan_id,reason,created_by)
 values(run.id,p_kind,p_lines,case when p_kind='forecast' then result else p_forecast_id end,case when p_kind='purchase' then result else null end,btrim(p_reason),auth.uid());
 return result;
end$$;

revoke all on function public.replenishment_create_profile(uuid,text,jsonb,text),public.replenishment_set_purpose(uuid,text,text,numeric,numeric,text,uuid,text,date,date,date),public.replenishment_workspace(uuid,uuid),public.replenishment_capture(uuid,uuid),public.replenishment_prepare_draft(uuid,text,jsonb,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.replenishment_create_profile(uuid,text,jsonb,text),public.replenishment_set_purpose(uuid,text,text,numeric,numeric,text,uuid,text,date,date,date),public.replenishment_workspace(uuid,uuid),public.replenishment_capture(uuid,uuid),public.replenishment_prepare_draft(uuid,text,jsonb,text,uuid) to authenticated;
