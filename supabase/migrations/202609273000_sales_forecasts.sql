-- Phase 7B: versioned sales forecasts with commercial review and final approval.

insert into public.permissions(code,module,action,name,description) values
 ('forecasts.view','forecasts','view','Прогнозы: просмотр','Просмотр версий прогноза'),
 ('forecasts.detail','forecasts','detail','Прогнозы: детализация','Просмотр строк прогноза'),
 ('forecasts.create','forecasts','create','Прогнозы: создание','Создание версии прогноза'),
 ('forecasts.update','forecasts','update','Прогнозы: изменение','Изменение строк черновика и отправка на согласование'),
 ('forecasts.review','forecasts','review','Прогнозы: коммерческая проверка','Предварительная проверка прогноза продаж'),
 ('forecasts.approve','forecasts','approve','Прогнозы: утверждение','Итоговое утверждение прогноза'),
 ('forecasts.archive','forecasts','archive','Прогнозы: архивирование','Архивирование версии прогноза')
on conflict(code) do update set module=excluded.module,action=excluded.action,name=excluded.name,description=excluded.description;

insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true from public.app_roles r cross join public.permissions p where
 (p.code='forecasts.view' and r.code in ('director','executive_director','commercial_director','logistics_director','senior_logistics_manager','logistics_specialist','accountant','marketer','administrator')) or
 (p.code='forecasts.detail' and r.code in ('director','executive_director','commercial_director','logistics_director','senior_logistics_manager','logistics_specialist','accountant','marketer')) or
 (p.code in ('forecasts.create','forecasts.update') and r.code in ('director','executive_director','commercial_director','logistics_director','senior_logistics_manager','marketer')) or
 (p.code='forecasts.review' and r.code in ('director','executive_director','commercial_director')) or
 (p.code='forecasts.approve' and r.code in ('director','executive_director')) or
 (p.code='forecasts.archive' and r.code in ('director','executive_director'))
on conflict(role_id,permission_id) do update set granted=true;

create table if not exists public.forecasts(
 id uuid primary key default gen_random_uuid(),
 name text not null check(length(btrim(name)) between 2 and 160),
 scenario text not null check(scenario in ('base','optimistic','pessimistic','custom')),
 version integer not null check(version>0),
 based_on_id uuid references public.forecasts(id) on delete restrict,
 horizon_start date not null,horizon_end date not null,
 granularity text not null check(granularity in ('week','month')),
 method text not null default 'manual' check(method in ('manual','moving_average','seasonal','imported')),
 method_params jsonb not null default '{}'::jsonb,
 input_snapshot_at timestamptz,
 status text not null default 'draft' check(status in ('draft','in_review','approved','superseded','archived')),
 commercial_reviewed_by uuid references public.profiles(id) on delete restrict,
 commercial_reviewed_at timestamptz,review_comment text,
 approved_by uuid references public.profiles(id) on delete restrict,approved_at timestamptz,
 created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(name,scenario,version),check(horizon_end>=horizon_start)
);
create unique index if not exists forecasts_one_approved_scope on public.forecasts(name,scenario,horizon_start,horizon_end) where status='approved';
create index if not exists forecasts_status_created_idx on public.forecasts(status,created_at desc);

create table if not exists public.forecast_lines(
 id uuid primary key default gen_random_uuid(),forecast_id uuid not null references public.forecasts(id) on delete restrict,
 product_id uuid not null references public.products(id) on delete restrict,
 customer_id uuid references public.counterparties(id) on delete restrict,
 warehouse_id uuid references public.warehouses(id) on delete restrict,
 period_start date not null,base_quantity numeric(14,3) not null check(base_quantity>=0),
 promo_uplift_quantity numeric(14,3) not null default 0 check(promo_uplift_quantity>=0),
 final_quantity numeric(14,3) generated always as (base_quantity+promo_uplift_quantity) stored,
 is_manual_override boolean not null default true,comment text,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create unique index if not exists forecast_lines_scope_unique on public.forecast_lines(forecast_id,product_id,coalesce(customer_id,'00000000-0000-0000-0000-000000000000'::uuid),coalesce(warehouse_id,'00000000-0000-4000-8000-000000000000'::uuid),period_start);
create index if not exists forecast_lines_forecast_period_idx on public.forecast_lines(forecast_id,period_start);

alter table public.forecasts enable row level security;alter table public.forecast_lines enable row level security;
revoke all on public.forecasts,public.forecast_lines from public,anon,authenticated,service_role;
grant select on public.forecasts,public.forecast_lines to authenticated;
drop policy if exists "forecast headers visible" on public.forecasts;
create policy "forecast headers visible" on public.forecasts for select to authenticated using ((select private.has_permission('forecasts.view')));
drop policy if exists "forecast lines visible" on public.forecast_lines;
create policy "forecast lines visible" on public.forecast_lines for select to authenticated using ((select private.has_permission('forecasts.detail')) and exists(select 1 from public.forecasts f where f.id=forecast_id));

create or replace function private.lock_forecast(p_id uuid) returns public.forecasts language plpgsql security definer set search_path='' as $$declare f public.forecasts;begin
 select * into f from public.forecasts where id=p_id for update;if not found then raise exception 'Прогноз не найден';end if;return f;
end$$;
revoke all on function private.lock_forecast(uuid) from public,anon,authenticated,service_role;

create or replace function public.create_forecast(p_name text,p_scenario text,p_horizon_start date,p_horizon_end date,p_granularity text,p_method text default 'manual') returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;v_version integer;begin
 if not (select private.has_permission('forecasts.create')) then raise exception 'Нет права создавать прогноз';end if;
 if length(btrim(p_name)) not between 2 and 160 or p_scenario not in ('base','optimistic','pessimistic','custom') or p_granularity not in ('week','month') or p_method not in ('manual','moving_average','seasonal','imported') or p_horizon_end<p_horizon_start then raise exception 'Проверьте параметры прогноза';end if;
 perform pg_advisory_xact_lock(hashtextextended(lower(btrim(p_name))||':'||p_scenario,0));select coalesce(max(version),0)+1 into v_version from public.forecasts where lower(name)=lower(btrim(p_name)) and scenario=p_scenario;
 insert into public.forecasts(name,scenario,version,horizon_start,horizon_end,granularity,method,created_by) values(btrim(p_name),p_scenario,v_version,p_horizon_start,p_horizon_end,p_granularity,p_method,auth.uid()) returning id into v_id;return v_id;
end$$;

create or replace function public.create_forecast_version(p_source_id uuid) returns uuid language plpgsql security definer set search_path='' as $$declare s public.forecasts;v_id uuid;v_version integer;begin
 if not (select private.has_permission('forecasts.create')) then raise exception 'Нет права создавать версию';end if;s:=private.lock_forecast(p_source_id);
 if s.status not in ('approved','superseded') then raise exception 'Новую версию можно создать только из утверждённого прогноза';end if;
 perform pg_advisory_xact_lock(hashtextextended(lower(s.name)||':'||s.scenario,0));select max(version)+1 into v_version from public.forecasts where lower(name)=lower(s.name) and scenario=s.scenario;
 insert into public.forecasts(name,scenario,version,based_on_id,horizon_start,horizon_end,granularity,method,method_params,input_snapshot_at,created_by) values(s.name,s.scenario,v_version,s.id,s.horizon_start,s.horizon_end,s.granularity,s.method,s.method_params,s.input_snapshot_at,auth.uid()) returning id into v_id;
 insert into public.forecast_lines(forecast_id,product_id,customer_id,warehouse_id,period_start,base_quantity,promo_uplift_quantity,is_manual_override,comment) select v_id,product_id,customer_id,warehouse_id,period_start,base_quantity,promo_uplift_quantity,is_manual_override,comment from public.forecast_lines where forecast_id=s.id;return v_id;
end$$;

create or replace function public.upsert_forecast_line(p_forecast_id uuid,p_product_id uuid,p_customer_id uuid,p_warehouse_id uuid,p_period_start date,p_base_quantity numeric,p_promo_uplift_quantity numeric default 0,p_comment text default null) returns uuid language plpgsql security definer set search_path='' as $$declare f public.forecasts;v_id uuid;begin
 if not (select private.has_permission('forecasts.update')) then raise exception 'Нет права изменять прогноз';end if;f:=private.lock_forecast(p_forecast_id);if f.status<>'draft' then raise exception 'Изменять можно только черновик';end if;
 p_promo_uplift_quantity:=coalesce(p_promo_uplift_quantity,0);
 if p_period_start not between f.horizon_start and f.horizon_end or (f.granularity='month' and extract(day from p_period_start)<>1) or (f.granularity='week' and extract(isodow from p_period_start)<>1) then raise exception 'Период не соответствует горизонту и детализации';end if;
 if p_base_quantity<0 or p_promo_uplift_quantity<0 or p_base_quantity+p_promo_uplift_quantity<=0 then raise exception 'Количество должно быть положительным';end if;
 if not exists(select 1 from public.products where id=p_product_id and status='active') then raise exception 'Активный товар не найден';end if;
 if p_customer_id is not null and not exists(select 1 from public.counterparties where id=p_customer_id and status='active' and 'customer'=any(roles)) then raise exception 'Активный клиент не найден';end if;
 if p_warehouse_id is not null and not exists(select 1 from public.warehouses where id=p_warehouse_id and status='active') then raise exception 'Активный склад не найден';end if;
 select id into v_id from public.forecast_lines where forecast_id=p_forecast_id and product_id=p_product_id and customer_id is not distinct from p_customer_id and warehouse_id is not distinct from p_warehouse_id and period_start=p_period_start for update;
 if found then update public.forecast_lines set base_quantity=p_base_quantity,promo_uplift_quantity=p_promo_uplift_quantity,is_manual_override=true,comment=nullif(btrim(p_comment),''),updated_at=now() where id=v_id;
 else insert into public.forecast_lines(forecast_id,product_id,customer_id,warehouse_id,period_start,base_quantity,promo_uplift_quantity,is_manual_override,comment) values(p_forecast_id,p_product_id,p_customer_id,p_warehouse_id,p_period_start,p_base_quantity,p_promo_uplift_quantity,true,nullif(btrim(p_comment),'')) returning id into v_id;end if;return v_id;
end$$;

create or replace function public.remove_forecast_line(p_line_id uuid) returns void language plpgsql security definer set search_path='' as $$declare v_forecast uuid;begin
 if not (select private.has_permission('forecasts.update')) then raise exception 'Нет права изменять прогноз';end if;select forecast_id into v_forecast from public.forecast_lines where id=p_line_id for update;if not found then raise exception 'Строка не найдена';end if;perform private.lock_forecast(v_forecast);if (select status from public.forecasts where id=v_forecast)<>'draft' then raise exception 'Изменять можно только черновик';end if;delete from public.forecast_lines where id=p_line_id;
end$$;

create or replace function public.submit_forecast(p_forecast_id uuid) returns void language plpgsql security definer set search_path='' as $$declare f public.forecasts;begin
 if not (select private.has_permission('forecasts.update')) then raise exception 'Нет права отправлять прогноз';end if;f:=private.lock_forecast(p_forecast_id);if f.status<>'draft' then raise exception 'Отправить можно только черновик';end if;if not exists(select 1 from public.forecast_lines where forecast_id=f.id) then raise exception 'Добавьте хотя бы одну строку';end if;
 update public.forecasts set status='in_review',commercial_reviewed_by=null,commercial_reviewed_at=null,review_comment=null,updated_at=now() where id=f.id;
end$$;

create or replace function public.review_forecast(p_forecast_id uuid,p_approve boolean,p_comment text default null) returns void language plpgsql security definer set search_path='' as $$declare f public.forecasts;begin
 if not (select private.has_permission('forecasts.review')) then raise exception 'Нет права проверять прогноз';end if;f:=private.lock_forecast(p_forecast_id);if f.status<>'in_review' then raise exception 'Прогноз не находится на согласовании';end if;
 if p_approve then update public.forecasts set commercial_reviewed_by=auth.uid(),commercial_reviewed_at=now(),review_comment=nullif(btrim(p_comment),''),updated_at=now() where id=f.id;
 else if nullif(btrim(p_comment),'') is null then raise exception 'Укажите причину возврата';end if;update public.forecasts set status='draft',commercial_reviewed_by=null,commercial_reviewed_at=null,review_comment=btrim(p_comment),updated_at=now() where id=f.id;end if;
end$$;

create or replace function public.approve_forecast(p_forecast_id uuid) returns void language plpgsql security definer set search_path='' as $$declare f public.forecasts;begin
 if not (select private.has_permission('forecasts.approve')) then raise exception 'Нет права утверждать прогноз';end if;f:=private.lock_forecast(p_forecast_id);if f.status<>'in_review' or f.commercial_reviewed_at is null then raise exception 'Сначала требуется коммерческая проверка';end if;
 update public.forecasts set status='superseded',updated_at=now() where id<>f.id and name=f.name and scenario=f.scenario and horizon_start=f.horizon_start and horizon_end=f.horizon_end and status='approved';
 update public.forecasts set status='approved',approved_by=auth.uid(),approved_at=now(),updated_at=now() where id=f.id;
end$$;

create or replace function public.archive_forecast(p_forecast_id uuid) returns void language plpgsql security definer set search_path='' as $$declare f public.forecasts;begin
 f:=private.lock_forecast(p_forecast_id);if not ((f.status='draft' and f.created_by=auth.uid()) or (select private.has_permission('forecasts.archive'))) then raise exception 'Нет права архивировать прогноз';end if;if f.status='approved' then raise exception 'Сначала создайте и утвердите новую версию';end if;update public.forecasts set status='archived',updated_at=now() where id=f.id;
end$$;

do $$declare f text;begin foreach f in array array[
 'public.create_forecast(text,text,date,date,text,text)','public.create_forecast_version(uuid)','public.upsert_forecast_line(uuid,uuid,uuid,uuid,date,numeric,numeric,text)','public.remove_forecast_line(uuid)','public.submit_forecast(uuid)','public.review_forecast(uuid,boolean,text)','public.approve_forecast(uuid)','public.archive_forecast(uuid)'
] loop execute format('revoke all on function %s from public,anon,authenticated,service_role',f);execute format('grant execute on function %s to authenticated',f);end loop;end$$;

drop trigger if exists audit_forecasts_changes on public.forecasts;create trigger audit_forecasts_changes after insert or update on public.forecasts for each row execute function private.write_access_audit();
drop trigger if exists audit_forecast_lines_changes on public.forecast_lines;create trigger audit_forecast_lines_changes after insert or update or delete on public.forecast_lines for each row execute function private.write_access_audit();

comment on table public.forecasts is 'Versioned sales forecasts; approved versions are immutable and replaced through based_on_id.';
comment on table public.forecast_lines is 'Manual or imported product/customer/warehouse quantities by week or month.';
