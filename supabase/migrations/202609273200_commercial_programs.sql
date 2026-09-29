-- Phase 7D: promotions, special orders and low-shelf-life clearance programs.

insert into public.permissions(code,module,action,name,description) values
 ('commercial_programs.view','commercial_programs','view','Промо: просмотр','Просмотр версий и статусов коммерческих программ'),
 ('commercial_programs.detail','commercial_programs','detail','Промо: детализация','Просмотр товаров, партий и коммерческих условий'),
 ('commercial_programs.create','commercial_programs','create','Промо: создание','Создание промо, спецзаказа или распродажи ОСГ'),
 ('commercial_programs.update','commercial_programs','update','Промо: изменение','Изменение строк черновика'),
 ('commercial_programs.review','commercial_programs','review','Промо: коммерческая проверка','Коммерческая проверка программы'),
 ('commercial_programs.approve','commercial_programs','approve','Промо: утверждение','Итоговое утверждение программы'),
 ('commercial_programs.apply','commercial_programs','apply','Промо: применить к прогнозу','Перенос промо-прироста в черновик прогноза'),
 ('commercial_programs.order','commercial_programs','order','Промо: создать заказ','Создание клиентского заказа из программы'),
 ('commercial_programs.archive','commercial_programs','archive','Промо: архивирование','Архивирование версии программы')
on conflict(code) do update set module=excluded.module,action=excluded.action,name=excluded.name,description=excluded.description;

insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true from public.app_roles r cross join public.permissions p where
 (p.code='commercial_programs.view' and r.code in ('director','executive_director','commercial_director','logistics_director','senior_logistics_manager','logistics_specialist','accountant','marketer','administrator')) or
 (p.code='commercial_programs.detail' and r.code in ('director','executive_director','commercial_director','logistics_director','senior_logistics_manager','logistics_specialist','accountant','marketer')) or
 (p.code in ('commercial_programs.create','commercial_programs.update','commercial_programs.apply') and r.code in ('director','executive_director','commercial_director','marketer')) or
 (p.code='commercial_programs.review' and r.code in ('director','executive_director','commercial_director')) or
 (p.code in ('commercial_programs.approve','commercial_programs.archive') and r.code in ('director','executive_director')) or
 (p.code='commercial_programs.order' and r.code in ('director','executive_director','commercial_director'))
on conflict(role_id,permission_id) do update set granted=true;

create table if not exists public.commercial_programs(
 id uuid primary key default gen_random_uuid(),name text not null check(length(btrim(name)) between 2 and 160),
 kind text not null check(kind in ('promotion','special_order','low_shelf_life')),
 customer_id uuid references public.counterparties(id) on delete restrict,
 version integer not null check(version>0),based_on_id uuid references public.commercial_programs(id) on delete restrict,
 starts_on date not null,ends_on date not null,
 status text not null default 'draft' check(status in ('draft','in_review','approved','ordered','superseded','archived')),
 commercial_reviewed_by uuid references public.profiles(id) on delete restrict,commercial_reviewed_at timestamptz,review_comment text,
 approved_by uuid references public.profiles(id) on delete restrict,approved_at timestamptz,
 sale_id uuid references public.sales(id) on delete restrict,
 created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check(ends_on>=starts_on),check(kind='promotion' or customer_id is not null)
);
create unique index if not exists commercial_programs_version_unique on public.commercial_programs(lower(name),kind,coalesce(customer_id,'00000000-0000-0000-0000-000000000000'::uuid),version);
create unique index if not exists commercial_programs_one_approved_scope on public.commercial_programs(lower(name),kind,coalesce(customer_id,'00000000-0000-0000-0000-000000000000'::uuid)) where status='approved';
create index if not exists commercial_programs_status_dates_idx on public.commercial_programs(status,starts_on,ends_on);

create table if not exists public.commercial_program_lines(
 id uuid primary key default gen_random_uuid(),commercial_program_id uuid not null references public.commercial_programs(id) on delete restrict,
 product_id uuid not null references public.products(id) on delete restrict,
 inventory_balance_id uuid references public.inventory_balances(id) on delete restrict,
 planned_quantity numeric(14,3) not null check(planned_quantity>0),
 promo_uplift_quantity numeric(14,3) not null default 0 check(promo_uplift_quantity>=0),
 uom text not null default 'piece' check(uom in ('piece','box','layer','pallet','truck')),
 discount_pct numeric(5,2) check(discount_pct is null or discount_pct between 0 and 100),
 target_unit_price numeric(14,4) check(target_unit_price is null or target_unit_price>=0),
 currency_id uuid references public.currencies(id) on delete restrict,
 remaining_shelf_life_pct numeric(5,2) check(remaining_shelf_life_pct is null or remaining_shelf_life_pct between 0 and 100),
 required_shelf_life_pct numeric(5,2) check(required_shelf_life_pct is null or required_shelf_life_pct between 0 and 100),
 forecast_line_id uuid references public.forecast_lines(id) on delete restrict,comment text,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check((target_unit_price is null)=(currency_id is null))
);
drop index if exists public.commercial_program_lines_scope_unique;
create unique index commercial_program_lines_scope_unique on public.commercial_program_lines(commercial_program_id,product_id,uom);
create index if not exists commercial_program_lines_program_idx on public.commercial_program_lines(commercial_program_id);

alter table public.commercial_programs enable row level security;alter table public.commercial_program_lines enable row level security;
revoke all on public.commercial_programs,public.commercial_program_lines from public,anon,authenticated,service_role;
grant select on public.commercial_programs,public.commercial_program_lines to authenticated;
drop policy if exists "commercial program headers visible" on public.commercial_programs;
create policy "commercial program headers visible" on public.commercial_programs for select to authenticated using ((select private.has_permission('commercial_programs.view')));
drop policy if exists "commercial program lines visible" on public.commercial_program_lines;
create policy "commercial program lines visible" on public.commercial_program_lines for select to authenticated using ((select private.has_permission('commercial_programs.detail')) and exists(select 1 from public.commercial_programs p where p.id=commercial_program_id));

create or replace function private.lock_commercial_program(p_id uuid) returns public.commercial_programs language plpgsql security definer set search_path='' as $$declare p public.commercial_programs;begin select * into p from public.commercial_programs where id=p_id for update;if not found then raise exception 'Коммерческая программа не найдена';end if;return p;end$$;
revoke all on function private.lock_commercial_program(uuid) from public,anon,authenticated,service_role;

create or replace function public.create_commercial_program(p_name text,p_kind text,p_customer_id uuid,p_starts_on date,p_ends_on date) returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;v_version integer;begin
 if not private.has_permission('commercial_programs.create') then raise exception 'Нет права создавать коммерческие программы';end if;
 if p_kind not in ('promotion','special_order','low_shelf_life') or p_starts_on is null or p_ends_on<p_starts_on or length(btrim(p_name)) not between 2 and 160 then raise exception 'Проверьте тип, название и даты';end if;
 if p_kind<>'promotion' and p_customer_id is null then raise exception 'Для спецзаказа и распродажи выберите клиента';end if;
 if p_customer_id is not null and not exists(select 1 from public.counterparties where id=p_customer_id and status='active' and 'customer'=any(roles)) then raise exception 'Активный клиент не найден';end if;
 perform pg_advisory_xact_lock(hashtextextended(lower(btrim(p_name))||':'||p_kind||':'||coalesce(p_customer_id::text,''),0));
 select coalesce(max(version),0)+1 into v_version from public.commercial_programs where lower(name)=lower(btrim(p_name)) and kind=p_kind and customer_id is not distinct from p_customer_id;
 insert into public.commercial_programs(name,kind,customer_id,version,starts_on,ends_on) values(btrim(p_name),p_kind,p_customer_id,v_version,p_starts_on,p_ends_on) returning id into v_id;return v_id;
end$$;

create or replace function public.create_commercial_program_version(p_source_id uuid) returns uuid language plpgsql security definer set search_path='' as $$declare s public.commercial_programs;v_id uuid;v_version integer;begin
 if not private.has_permission('commercial_programs.create') then raise exception 'Нет права создавать версию';end if;s:=private.lock_commercial_program(p_source_id);if s.status not in ('approved','ordered','superseded') then raise exception 'Новую версию можно создать только из утверждённой программы';end if;
 perform pg_advisory_xact_lock(hashtextextended(lower(s.name)||':'||s.kind||':'||coalesce(s.customer_id::text,''),0));select max(version)+1 into v_version from public.commercial_programs where lower(name)=lower(s.name) and kind=s.kind and customer_id is not distinct from s.customer_id;
 insert into public.commercial_programs(name,kind,customer_id,version,based_on_id,starts_on,ends_on) values(s.name,s.kind,s.customer_id,v_version,s.id,s.starts_on,s.ends_on) returning id into v_id;
 insert into public.commercial_program_lines(commercial_program_id,product_id,inventory_balance_id,planned_quantity,promo_uplift_quantity,uom,discount_pct,target_unit_price,currency_id,remaining_shelf_life_pct,required_shelf_life_pct,comment)
 select v_id,product_id,inventory_balance_id,planned_quantity,promo_uplift_quantity,uom,discount_pct,target_unit_price,currency_id,remaining_shelf_life_pct,required_shelf_life_pct,comment from public.commercial_program_lines where commercial_program_id=s.id;return v_id;
end$$;

create or replace function public.upsert_commercial_program_line(p_program_id uuid,p_product_id uuid,p_inventory_balance_id uuid,p_planned_quantity numeric,p_promo_uplift_quantity numeric,p_uom text,p_discount_pct numeric,p_target_unit_price numeric,p_currency_id uuid,p_required_shelf_life_pct numeric,p_comment text default null) returns uuid language plpgsql security definer set search_path='' as $$declare p public.commercial_programs;b record;v_remaining numeric;v_id uuid;begin
 if not private.has_permission('commercial_programs.update') then raise exception 'Нет права изменять программу';end if;p:=private.lock_commercial_program(p_program_id);if p.status<>'draft' then raise exception 'Изменять можно только черновик';end if;
 if p_planned_quantity is null or p_planned_quantity<=0 or coalesce(p_promo_uplift_quantity,0)<0 or p_uom not in ('piece','box','layer','pallet','truck') or (p_target_unit_price is null)<>(p_currency_id is null) then raise exception 'Проверьте количество, единицу и цену';end if;
 if coalesce(p_discount_pct,0)<0 or coalesce(p_discount_pct,0)>100 or coalesce(p_required_shelf_life_pct,0)<0 or coalesce(p_required_shelf_life_pct,0)>100 then raise exception 'Процент должен быть от 0 до 100';end if;
 if not exists(select 1 from public.products where id=p_product_id and status='active') then raise exception 'Активный товар не найден';end if;
 if p.kind='promotion' and coalesce(p_promo_uplift_quantity,0)<=0 then raise exception 'Для промо укажите прирост прогноза';end if;
 if p.kind='low_shelf_life' then
  select ib.*,batch.product_id,batch.expiry_date,batch.manufacture_date,batch.status as batch_status,product.shelf_life_days into b from public.inventory_balances ib join public.inventory_batches batch on batch.id=ib.batch_id join public.products product on product.id=batch.product_id where ib.id=p_inventory_balance_id for update of ib;
  if not found or b.product_id<>p_product_id or b.uom<>p_uom or b.batch_status<>'available' or b.expiry_date<p.starts_on or b.quantity_on_hand-b.quantity_reserved<p_planned_quantity then raise exception 'Выбранная партия не подходит или доступного остатка недостаточно';end if;
  v_remaining:=private.sale_shelf_life_pct(b.expiry_date,b.manufacture_date,b.shelf_life_days,p.starts_on);
 elsif p_inventory_balance_id is not null then raise exception 'Конкретная партия выбирается только для распродажи низкого ОСГ';
 else v_remaining:=null;end if;
 select id into v_id from public.commercial_program_lines where commercial_program_id=p_program_id and product_id=p_product_id and uom=p_uom for update;
 if found then update public.commercial_program_lines set inventory_balance_id=p_inventory_balance_id,planned_quantity=p_planned_quantity,promo_uplift_quantity=coalesce(p_promo_uplift_quantity,0),discount_pct=p_discount_pct,target_unit_price=p_target_unit_price,currency_id=p_currency_id,remaining_shelf_life_pct=v_remaining,required_shelf_life_pct=p_required_shelf_life_pct,comment=nullif(btrim(p_comment),''),updated_at=now() where id=v_id;
 else insert into public.commercial_program_lines(commercial_program_id,product_id,inventory_balance_id,planned_quantity,promo_uplift_quantity,uom,discount_pct,target_unit_price,currency_id,remaining_shelf_life_pct,required_shelf_life_pct,comment) values(p_program_id,p_product_id,p_inventory_balance_id,p_planned_quantity,coalesce(p_promo_uplift_quantity,0),p_uom,p_discount_pct,p_target_unit_price,p_currency_id,v_remaining,p_required_shelf_life_pct,nullif(btrim(p_comment),'')) returning id into v_id;end if;return v_id;
end$$;

create or replace function public.remove_commercial_program_line(p_line_id uuid) returns void language plpgsql security definer set search_path='' as $$declare v_program uuid;p public.commercial_programs;begin if not private.has_permission('commercial_programs.update') then raise exception 'Нет права изменять программу';end if;select commercial_program_id into v_program from public.commercial_program_lines where id=p_line_id for update;if not found then raise exception 'Строка не найдена';end if;p:=private.lock_commercial_program(v_program);if p.status<>'draft' then raise exception 'Изменять можно только черновик';end if;delete from public.commercial_program_lines where id=p_line_id;end$$;

create or replace function public.submit_commercial_program(p_program_id uuid) returns void language plpgsql security definer set search_path='' as $$declare p public.commercial_programs;begin if not private.has_permission('commercial_programs.update') then raise exception 'Нет права отправлять программу';end if;p:=private.lock_commercial_program(p_program_id);if p.status<>'draft' then raise exception 'Отправить можно только черновик';end if;if not exists(select 1 from public.commercial_program_lines where commercial_program_id=p.id) then raise exception 'Добавьте хотя бы одну строку';end if;update public.commercial_programs set status='in_review',commercial_reviewed_by=null,commercial_reviewed_at=null,review_comment=null,updated_at=now() where id=p.id;end$$;

create or replace function public.review_commercial_program(p_program_id uuid,p_approve boolean,p_comment text default null) returns void language plpgsql security definer set search_path='' as $$declare p public.commercial_programs;begin if not private.has_permission('commercial_programs.review') then raise exception 'Нет права проверять программу';end if;p:=private.lock_commercial_program(p_program_id);if p.status<>'in_review' then raise exception 'Программа не находится на согласовании';end if;if p_approve then update public.commercial_programs set commercial_reviewed_by=auth.uid(),commercial_reviewed_at=now(),review_comment=nullif(btrim(p_comment),''),updated_at=now() where id=p.id;else if nullif(btrim(p_comment),'') is null then raise exception 'Укажите причину возврата';end if;update public.commercial_programs set status='draft',commercial_reviewed_by=null,commercial_reviewed_at=null,review_comment=btrim(p_comment),updated_at=now() where id=p.id;end if;end$$;

create or replace function public.approve_commercial_program(p_program_id uuid) returns void language plpgsql security definer set search_path='' as $$declare p public.commercial_programs;begin if not private.has_permission('commercial_programs.approve') then raise exception 'Нет права утверждать программу';end if;p:=private.lock_commercial_program(p_program_id);if p.status<>'in_review' or p.commercial_reviewed_at is null then raise exception 'Сначала требуется коммерческая проверка';end if;update public.commercial_programs set status='superseded',updated_at=now() where id<>p.id and lower(name)=lower(p.name) and kind=p.kind and customer_id is not distinct from p.customer_id and status='approved';update public.commercial_programs set status='approved',approved_by=auth.uid(),approved_at=now(),updated_at=now() where id=p.id;end$$;

create or replace function public.apply_commercial_program_to_forecast(p_program_id uuid,p_forecast_id uuid,p_period_start date,p_warehouse_id uuid default null) returns integer language plpgsql security definer set search_path='' as $$declare p public.commercial_programs;f public.forecasts;l record;v_base numeric;v_line uuid;v_count integer:=0;begin
 if not private.has_permission('commercial_programs.apply') or not private.has_permission('forecasts.update') then raise exception 'Нет права переносить промо в прогноз';end if;p:=private.lock_commercial_program(p_program_id);if p.status<>'approved' or p.kind<>'promotion' then raise exception 'В прогноз переносится только утверждённое промо';end if;select * into f from public.forecasts where id=p_forecast_id and status='draft' for update;if not found then raise exception 'Выберите черновик прогноза';end if;if p_period_start<f.horizon_start or p_period_start>f.horizon_end then raise exception 'Период вне горизонта прогноза';end if;
 for l in select * from public.commercial_program_lines where commercial_program_id=p.id loop
  select base_quantity into v_base from public.forecast_lines where forecast_id=f.id and product_id=l.product_id and customer_id is not distinct from p.customer_id and warehouse_id is not distinct from p_warehouse_id and period_start=p_period_start;
  v_line:=public.upsert_forecast_line(f.id,l.product_id,p.customer_id,p_warehouse_id,p_period_start,coalesce(v_base,0),l.promo_uplift_quantity,'Промо: '||p.name||' · v'||p.version);
  update public.commercial_program_lines set forecast_line_id=v_line,updated_at=now() where id=l.id;v_count:=v_count+1;
 end loop;return v_count;
end$$;

create or replace function public.create_sale_from_commercial_program(p_program_id uuid,p_warehouse_id uuid,p_planned_shipment_date date,p_currency_id uuid,p_contract_id uuid default null) returns uuid language plpgsql security definer set search_path='' as $$declare p public.commercial_programs;l record;v_sale uuid;v_item uuid;begin
 if not private.has_permission('commercial_programs.order') or not private.has_permission('sales.manage') then raise exception 'Нет права создавать заказ из программы';end if;p:=private.lock_commercial_program(p_program_id);if p.status<>'approved' or p.kind='promotion' or p.customer_id is null then raise exception 'Заказ создаётся из утверждённого спецзаказа или распродажи ОСГ';end if;if p.sale_id is not null then raise exception 'Заказ по этой программе уже создан';end if;
 if exists(select 1 from public.commercial_program_lines where commercial_program_id=p.id and target_unit_price is not null and currency_id<>p_currency_id) then raise exception 'Валюта цены строки не совпадает с валютой заказа';end if;
 v_sale:=public.create_customer_order(p.customer_id,p_contract_id,p_warehouse_id,p_planned_shipment_date,p_currency_id,'Коммерческая программа: '||p.name||' · v'||p.version);
 for l in select * from public.commercial_program_lines where commercial_program_id=p.id order by id loop
  v_item:=public.add_customer_order_item(v_sale,l.product_id,l.planned_quantity,l.uom,l.target_unit_price,l.required_shelf_life_pct);
 end loop;
 if p.kind='low_shelf_life' then
  if not private.has_permission('sales.override_fefo') then raise exception 'Нет права резервировать выбранные партии';end if;
  for l in select pl.*,si.id as sale_item_id from public.commercial_program_lines pl join public.sale_items si on si.sale_id=v_sale and si.product_id=pl.product_id and si.uom=pl.uom where pl.commercial_program_id=p.id order by pl.id loop
   perform public.reserve_customer_order_item_override(l.sale_item_id,l.inventory_balance_id,'Утверждённая распродажа низкого ОСГ: '||p.name);
  end loop;
 end if;
 update public.commercial_programs set status='ordered',sale_id=v_sale,updated_at=now() where id=p.id;return v_sale;
end$$;

create or replace function public.archive_commercial_program(p_program_id uuid) returns void language plpgsql security definer set search_path='' as $$declare p public.commercial_programs;begin p:=private.lock_commercial_program(p_program_id);if not ((p.status='draft' and p.created_by=auth.uid()) or private.has_permission('commercial_programs.archive')) then raise exception 'Нет права архивировать программу';end if;if p.status in ('approved','ordered') then raise exception 'Утверждённую или заказанную программу нельзя архивировать';end if;update public.commercial_programs set status='archived',updated_at=now() where id=p.id;end$$;

do $$declare f text;begin foreach f in array array[
 'public.create_commercial_program(text,text,uuid,date,date)','public.create_commercial_program_version(uuid)','public.upsert_commercial_program_line(uuid,uuid,uuid,numeric,numeric,text,numeric,numeric,uuid,numeric,text)','public.remove_commercial_program_line(uuid)','public.submit_commercial_program(uuid)','public.review_commercial_program(uuid,boolean,text)','public.approve_commercial_program(uuid)','public.apply_commercial_program_to_forecast(uuid,uuid,date,uuid)','public.create_sale_from_commercial_program(uuid,uuid,date,uuid,uuid)','public.archive_commercial_program(uuid)'
] loop execute format('revoke all on function %s from public,anon,authenticated,service_role',f);execute format('grant execute on function %s to authenticated',f);end loop;end$$;

drop trigger if exists audit_commercial_programs_changes on public.commercial_programs;create trigger audit_commercial_programs_changes after insert or update on public.commercial_programs for each row execute function private.write_access_audit();
drop trigger if exists audit_commercial_program_lines_changes on public.commercial_program_lines;create trigger audit_commercial_program_lines_changes after insert or update or delete on public.commercial_program_lines for each row execute function private.write_access_audit();
comment on table public.commercial_programs is 'Versioned promotions, customer special orders and approved low-shelf-life clearance programs.';
comment on table public.commercial_program_lines is 'Products, forecast uplift, commercial terms and optional exact inventory batch snapshots.';
