-- Phase 7C: versioned purchase plans and controlled creation of an RVI shipment.

insert into public.permissions(code,module,action,name,description) values
 ('purchase_plans.view','purchase_plans','view','Планы закупок: просмотр','Просмотр версий и статусов планов закупок'),
 ('purchase_plans.detail','purchase_plans','detail','Планы закупок: детализация','Просмотр строк и расчётных снимков'),
 ('purchase_plans.create','purchase_plans','create','Планы закупок: создание','Создание плана из утверждённого прогноза'),
 ('purchase_plans.update','purchase_plans','update','Планы закупок: изменение','Изменение строк черновика'),
 ('purchase_plans.review','purchase_plans','review','Планы закупок: логистическая проверка','Проверка плана логистическим руководителем'),
 ('purchase_plans.approve','purchase_plans','approve','Планы закупок: утверждение','Итоговое утверждение плана закупок'),
 ('purchase_plans.order','purchase_plans','order','Планы закупок: создать поставку','Создание поставки RVI из утверждённого плана'),
 ('purchase_plans.archive','purchase_plans','archive','Планы закупок: архивирование','Архивирование версии плана')
on conflict(code) do update set module=excluded.module,action=excluded.action,name=excluded.name,description=excluded.description;

insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true from public.app_roles r cross join public.permissions p where
 (p.code='purchase_plans.view' and r.code in ('director','executive_director','commercial_director','logistics_director','senior_logistics_manager','logistics_specialist','accountant','marketer','administrator')) or
 (p.code='purchase_plans.detail' and r.code in ('director','executive_director','commercial_director','logistics_director','senior_logistics_manager','logistics_specialist','accountant','marketer')) or
 (p.code in ('purchase_plans.create','purchase_plans.update') and r.code in ('director','executive_director','logistics_director','senior_logistics_manager')) or
 (p.code='purchase_plans.review' and r.code in ('director','executive_director','logistics_director')) or
 (p.code='purchase_plans.approve' and r.code in ('director','executive_director')) or
 (p.code='purchase_plans.order' and r.code in ('director','executive_director','logistics_director','senior_logistics_manager')) or
 (p.code='purchase_plans.archive' and r.code in ('director','executive_director'))
on conflict(role_id,permission_id) do update set granted=true;

create table if not exists public.purchase_plans(
 id uuid primary key default gen_random_uuid(),name text not null check(length(btrim(name)) between 2 and 160),
 forecast_id uuid not null references public.forecasts(id) on delete restrict,
 supplier_id uuid not null references public.counterparties(id) on delete restrict,
 version integer not null check(version>0),based_on_id uuid references public.purchase_plans(id) on delete restrict,
 horizon_start date not null,horizon_end date not null,
 status text not null default 'draft' check(status in ('draft','in_review','approved','ordered','superseded','archived')),
 logistic_reviewed_by uuid references public.profiles(id) on delete restrict,logistic_reviewed_at timestamptz,review_comment text,
 approved_by uuid references public.profiles(id) on delete restrict,approved_at timestamptz,
 created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(forecast_id,supplier_id,version),check(horizon_end>=horizon_start)
);
create unique index if not exists purchase_plans_one_approved_scope on public.purchase_plans(forecast_id,supplier_id) where status='approved';
create index if not exists purchase_plans_status_created_idx on public.purchase_plans(status,created_at desc);

create table if not exists public.purchase_plan_lines(
 id uuid primary key default gen_random_uuid(),purchase_plan_id uuid not null references public.purchase_plans(id) on delete restrict,
 product_id uuid not null references public.products(id) on delete restrict,
 forecast_demand numeric(14,3) not null check(forecast_demand>=0),
 stock_on_hand numeric(14,3) not null default 0 check(stock_on_hand>=0),
 stock_in_transit numeric(14,3) not null default 0 check(stock_in_transit>=0),
 stock_reserved numeric(14,3) not null default 0 check(stock_reserved>=0 and stock_reserved<=stock_on_hand),
 safety_stock numeric(14,3) not null default 0 check(safety_stock>=0),
 expiring_before_sale numeric(14,3) not null default 0 check(expiring_before_sale>=0),
 suggested_quantity numeric(14,3) not null check(suggested_quantity>=0),
 rounding_uom text not null default 'piece' check(rounding_uom in ('piece','box','layer','pallet','truck')),
 pack_multiple numeric(14,3) not null default 1 check(pack_multiple>0),
 rounded_quantity numeric(14,3) generated always as (ceiling(suggested_quantity/pack_multiple)*pack_multiple) stored,
 approved_quantity numeric(14,3) not null check(approved_quantity>0),
 planned_order_date date,shipment_id uuid references public.shipments(id) on delete restrict,comment text,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(purchase_plan_id,product_id)
);
create index if not exists purchase_plan_lines_plan_idx on public.purchase_plan_lines(purchase_plan_id);

alter table public.purchase_plans enable row level security;alter table public.purchase_plan_lines enable row level security;
revoke all on public.purchase_plans,public.purchase_plan_lines from public,anon,authenticated,service_role;
grant select on public.purchase_plans,public.purchase_plan_lines to authenticated;
drop policy if exists "purchase plan headers visible" on public.purchase_plans;
create policy "purchase plan headers visible" on public.purchase_plans for select to authenticated using ((select private.has_permission('purchase_plans.view')));
drop policy if exists "purchase plan lines visible" on public.purchase_plan_lines;
create policy "purchase plan lines visible" on public.purchase_plan_lines for select to authenticated using ((select private.has_permission('purchase_plans.detail')) and exists(select 1 from public.purchase_plans p where p.id=purchase_plan_id));

create or replace function private.lock_purchase_plan(p_id uuid) returns public.purchase_plans language plpgsql security definer set search_path='' as $$declare p public.purchase_plans;begin select * into p from public.purchase_plans where id=p_id for update;if not found then raise exception 'План закупок не найден';end if;return p;end$$;
revoke all on function private.lock_purchase_plan(uuid) from public,anon,authenticated,service_role;

create or replace function public.create_purchase_plan(p_name text,p_forecast_id uuid,p_supplier_id uuid) returns uuid language plpgsql security definer set search_path='' as $$declare f public.forecasts;s public.counterparties;v_id uuid;v_version integer;begin
 if not private.has_permission('purchase_plans.create') then raise exception 'Нет права создавать план закупок';end if;
 select * into f from public.forecasts where id=p_forecast_id and status='approved';if not found then raise exception 'Выберите утверждённый прогноз';end if;
 select * into s from public.counterparties where id=p_supplier_id and status='active' and (roles&&array['supplier','manufacturer']);if not found then raise exception 'Активный поставщик не найден';end if;
 if length(btrim(p_name)) not between 2 and 160 then raise exception 'Укажите название плана';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_forecast_id::text||':'||p_supplier_id::text,0));select coalesce(max(version),0)+1 into v_version from public.purchase_plans where forecast_id=p_forecast_id and supplier_id=p_supplier_id;
 insert into public.purchase_plans(name,forecast_id,supplier_id,version,horizon_start,horizon_end,created_by) values(btrim(p_name),f.id,s.id,v_version,f.horizon_start,f.horizon_end,auth.uid()) returning id into v_id;return v_id;
end$$;

create or replace function public.create_purchase_plan_version(p_source_id uuid) returns uuid language plpgsql security definer set search_path='' as $$declare s public.purchase_plans;v_id uuid;v_version integer;begin
 if not private.has_permission('purchase_plans.create') then raise exception 'Нет права создавать версию';end if;s:=private.lock_purchase_plan(p_source_id);if s.status not in ('approved','ordered','superseded') then raise exception 'Новую версию можно создать только из утверждённого плана';end if;
 perform pg_advisory_xact_lock(hashtextextended(s.forecast_id::text||':'||s.supplier_id::text,0));select max(version)+1 into v_version from public.purchase_plans where forecast_id=s.forecast_id and supplier_id=s.supplier_id;
 insert into public.purchase_plans(name,forecast_id,supplier_id,version,based_on_id,horizon_start,horizon_end,created_by) values(s.name,s.forecast_id,s.supplier_id,v_version,s.id,s.horizon_start,s.horizon_end,auth.uid()) returning id into v_id;
 insert into public.purchase_plan_lines(purchase_plan_id,product_id,forecast_demand,stock_on_hand,stock_in_transit,stock_reserved,safety_stock,expiring_before_sale,suggested_quantity,rounding_uom,pack_multiple,approved_quantity,planned_order_date,comment)
 select v_id,product_id,forecast_demand,stock_on_hand,stock_in_transit,stock_reserved,safety_stock,expiring_before_sale,suggested_quantity,rounding_uom,pack_multiple,approved_quantity,planned_order_date,comment from public.purchase_plan_lines where purchase_plan_id=s.id;return v_id;
end$$;

create or replace function public.upsert_purchase_plan_line(p_plan_id uuid,p_product_id uuid,p_stock_on_hand numeric,p_stock_in_transit numeric,p_stock_reserved numeric,p_safety_stock numeric,p_expiring_before_sale numeric,p_suggested_quantity numeric,p_rounding_uom text,p_pack_multiple numeric,p_approved_quantity numeric,p_planned_order_date date default null,p_comment text default null) returns uuid language plpgsql security definer set search_path='' as $$declare p public.purchase_plans;v_demand numeric;v_id uuid;begin
 if not private.has_permission('purchase_plans.update') then raise exception 'Нет права изменять план закупок';end if;p:=private.lock_purchase_plan(p_plan_id);if p.status<>'draft' then raise exception 'Изменять можно только черновик';end if;
 if not exists(select 1 from public.products x where x.id=p_product_id and x.status='active' and x.manufacturer_id=p.supplier_id) then raise exception 'Товар не относится к выбранному производителю';end if;
 select coalesce(sum(final_quantity),0) into v_demand from public.forecast_lines where forecast_id=p.forecast_id and product_id=p_product_id;
 p_stock_on_hand:=coalesce(p_stock_on_hand,0);p_stock_in_transit:=coalesce(p_stock_in_transit,0);p_stock_reserved:=coalesce(p_stock_reserved,0);p_safety_stock:=coalesce(p_safety_stock,0);p_expiring_before_sale:=coalesce(p_expiring_before_sale,0);
 if least(p_stock_on_hand,p_stock_in_transit,p_stock_reserved,p_safety_stock,p_expiring_before_sale,p_suggested_quantity)<0 or p_stock_reserved>p_stock_on_hand or p_pack_multiple<=0 or p_approved_quantity<=0 or p_rounding_uom not in ('piece','box','layer','pallet','truck') then raise exception 'Проверьте количества и кратность';end if;
 if mod(p_approved_quantity,p_pack_multiple)<>0 then raise exception 'Утверждаемое количество должно быть кратно упаковке';end if;
 select id into v_id from public.purchase_plan_lines where purchase_plan_id=p_plan_id and product_id=p_product_id for update;
 if found then update public.purchase_plan_lines set forecast_demand=v_demand,stock_on_hand=p_stock_on_hand,stock_in_transit=p_stock_in_transit,stock_reserved=p_stock_reserved,safety_stock=p_safety_stock,expiring_before_sale=p_expiring_before_sale,suggested_quantity=p_suggested_quantity,rounding_uom=p_rounding_uom,pack_multiple=p_pack_multiple,approved_quantity=p_approved_quantity,planned_order_date=p_planned_order_date,comment=nullif(btrim(p_comment),''),updated_at=now() where id=v_id;
 else insert into public.purchase_plan_lines(purchase_plan_id,product_id,forecast_demand,stock_on_hand,stock_in_transit,stock_reserved,safety_stock,expiring_before_sale,suggested_quantity,rounding_uom,pack_multiple,approved_quantity,planned_order_date,comment) values(p_plan_id,p_product_id,v_demand,p_stock_on_hand,p_stock_in_transit,p_stock_reserved,p_safety_stock,p_expiring_before_sale,p_suggested_quantity,p_rounding_uom,p_pack_multiple,p_approved_quantity,p_planned_order_date,nullif(btrim(p_comment),'')) returning id into v_id;end if;return v_id;
end$$;

create or replace function public.remove_purchase_plan_line(p_line_id uuid) returns void language plpgsql security definer set search_path='' as $$declare v_plan uuid;p public.purchase_plans;begin if not private.has_permission('purchase_plans.update') then raise exception 'Нет права изменять план закупок';end if;select purchase_plan_id into v_plan from public.purchase_plan_lines where id=p_line_id for update;if not found then raise exception 'Строка не найдена';end if;p:=private.lock_purchase_plan(v_plan);if p.status<>'draft' then raise exception 'Изменять можно только черновик';end if;delete from public.purchase_plan_lines where id=p_line_id;end$$;

create or replace function public.submit_purchase_plan(p_plan_id uuid) returns void language plpgsql security definer set search_path='' as $$declare p public.purchase_plans;begin if not private.has_permission('purchase_plans.update') then raise exception 'Нет права отправлять план';end if;p:=private.lock_purchase_plan(p_plan_id);if p.status<>'draft' then raise exception 'Отправить можно только черновик';end if;if not exists(select 1 from public.purchase_plan_lines where purchase_plan_id=p.id) then raise exception 'Добавьте хотя бы одну строку';end if;update public.purchase_plans set status='in_review',logistic_reviewed_by=null,logistic_reviewed_at=null,review_comment=null,updated_at=now() where id=p.id;end$$;

create or replace function public.review_purchase_plan(p_plan_id uuid,p_approve boolean,p_comment text default null) returns void language plpgsql security definer set search_path='' as $$declare p public.purchase_plans;begin if not private.has_permission('purchase_plans.review') then raise exception 'Нет права проверять план';end if;p:=private.lock_purchase_plan(p_plan_id);if p.status<>'in_review' then raise exception 'План не находится на согласовании';end if;if p_approve then update public.purchase_plans set logistic_reviewed_by=auth.uid(),logistic_reviewed_at=now(),review_comment=nullif(btrim(p_comment),''),updated_at=now() where id=p.id;else if nullif(btrim(p_comment),'') is null then raise exception 'Укажите причину возврата';end if;update public.purchase_plans set status='draft',logistic_reviewed_by=null,logistic_reviewed_at=null,review_comment=btrim(p_comment),updated_at=now() where id=p.id;end if;end$$;

create or replace function public.approve_purchase_plan(p_plan_id uuid) returns void language plpgsql security definer set search_path='' as $$declare p public.purchase_plans;begin if not private.has_permission('purchase_plans.approve') then raise exception 'Нет права утверждать план';end if;p:=private.lock_purchase_plan(p_plan_id);if p.status<>'in_review' or p.logistic_reviewed_at is null then raise exception 'Сначала требуется логистическая проверка';end if;update public.purchase_plans set status='superseded',updated_at=now() where id<>p.id and forecast_id=p.forecast_id and supplier_id=p.supplier_id and status='approved';update public.purchase_plans set status='approved',approved_by=auth.uid(),approved_at=now(),updated_at=now() where id=p.id;end$$;

create or replace function public.create_purchase_plan_shipment(p_plan_id uuid,p_route_id uuid,p_currency_id uuid,p_warehouse_id uuid,p_responsible_user_id uuid,p_planned_ready_date date default null,p_planned_arrival_date date default null) returns uuid language plpgsql security definer set search_path='' as $$declare p public.purchase_plans;v_shipment uuid;begin
 if not private.has_permission('purchase_plans.order') then raise exception 'Нет права создавать поставку из плана';end if;p:=private.lock_purchase_plan(p_plan_id);if p.status<>'approved' then raise exception 'Поставка создаётся только из утверждённого плана';end if;if exists(select 1 from public.purchase_plan_lines where purchase_plan_id=p.id and shipment_id is not null) then raise exception 'Поставка по этому плану уже создана';end if;
 select public.create_shipment_with_stages('PP-'||left(replace(p.id::text,'-',''),8),'import',p.supplier_id,null,p_route_id,p_currency_id,p_warehouse_id,p_responsible_user_id,p_planned_ready_date,p_planned_arrival_date) into v_shipment;
 insert into public.shipment_items(shipment_id,product_id,uom,ordered_quantity,currency_id) select v_shipment,product_id,'piece',approved_quantity,p_currency_id from public.purchase_plan_lines where purchase_plan_id=p.id and approved_quantity>0;
 update public.purchase_plan_lines set shipment_id=v_shipment,updated_at=now() where purchase_plan_id=p.id;update public.purchase_plans set status='ordered',updated_at=now() where id=p.id;return v_shipment;
end$$;

create or replace function public.archive_purchase_plan(p_plan_id uuid) returns void language plpgsql security definer set search_path='' as $$declare p public.purchase_plans;begin p:=private.lock_purchase_plan(p_plan_id);if not ((p.status='draft' and p.created_by=auth.uid()) or private.has_permission('purchase_plans.archive')) then raise exception 'Нет права архивировать план';end if;if p.status in ('approved','ordered') then raise exception 'Утверждённый или заказанный план нельзя архивировать';end if;update public.purchase_plans set status='archived',updated_at=now() where id=p.id;end$$;

do $$declare f text;begin foreach f in array array[
 'public.create_purchase_plan(text,uuid,uuid)','public.create_purchase_plan_version(uuid)','public.upsert_purchase_plan_line(uuid,uuid,numeric,numeric,numeric,numeric,numeric,numeric,text,numeric,numeric,date,text)','public.remove_purchase_plan_line(uuid)','public.submit_purchase_plan(uuid)','public.review_purchase_plan(uuid,boolean,text)','public.approve_purchase_plan(uuid)','public.create_purchase_plan_shipment(uuid,uuid,uuid,uuid,uuid,date,date)','public.archive_purchase_plan(uuid)'
] loop execute format('revoke all on function %s from public,anon,authenticated,service_role',f);execute format('grant execute on function %s to authenticated',f);end loop;end$$;

drop trigger if exists audit_purchase_plans_changes on public.purchase_plans;create trigger audit_purchase_plans_changes after insert or update on public.purchase_plans for each row execute function private.write_access_audit();
drop trigger if exists audit_purchase_plan_lines_changes on public.purchase_plan_lines;create trigger audit_purchase_plan_lines_changes after insert or update or delete on public.purchase_plan_lines for each row execute function private.write_access_audit();
comment on table public.purchase_plans is 'Versioned purchase plans based on one approved forecast and one direct supplier.';
comment on table public.purchase_plan_lines is 'Demand and inventory snapshots, manual suggested quantity, packaging rounding and resulting shipment link.';
