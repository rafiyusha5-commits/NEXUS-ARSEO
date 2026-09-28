-- Phase 5A: shipment expenses, exchange rates and approved landed cost.

insert into public.permissions(code,module,action,name,description) values
 ('finance.draft','finance','draft','Черновики расходов','Создание черновиков расходов'),
 ('finance.confirm','finance','confirm','Подтверждение расходов','Подтверждение расходов'),
 ('finance.pay','finance','pay','Оплата расходов','Подтверждение оплаты расходов'),
 ('costing.view','costing','view','Просмотр себестоимости','Просмотр себестоимости'),
 ('costing.view_assigned','costing','view_assigned','Себестоимость своих поставок','Просмотр себестоимости своих поставок'),
 ('costing.calculate','costing','calculate','Расчёт себестоимости','Расчёт себестоимости'),
 ('costing.approve','costing','approve','Утверждение себестоимости','Утверждение себестоимости')
on conflict(code) do update set module=excluded.module,action=excluded.action,name=excluded.name,description=excluded.description;

insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true from public.app_roles r cross join public.permissions p
where (r.code in ('director','executive_director','accountant') and p.code in ('finance.view','finance.manage','finance.draft','finance.confirm','finance.pay','costing.view','costing.calculate'))
   or (r.code in ('director','executive_director') and p.code='costing.approve')
   or (r.code in ('logistics_director','senior_logistics_manager','logistics_specialist') and p.code='finance.draft')
   or (r.code in ('logistics_director','senior_logistics_manager') and p.code='costing.view_assigned')
   or (r.code='administrator' and p.code in ('finance.view','finance.manage','finance.draft','finance.confirm','finance.pay','costing.view','costing.calculate','costing.approve'))
on conflict(role_id,permission_id) do update set granted=true;

create table if not exists public.exchange_rates(
 id uuid primary key default gen_random_uuid(),
 base_currency_id uuid not null references public.currencies(id) on delete restrict,
 quote_currency_id uuid not null references public.currencies(id) on delete restrict,
 rate numeric(18,6) not null check(rate>0),
 source text not null check(source in ('official','bank')),
 source_name text,
 rate_date date not null,
 created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
 created_at timestamptz not null default now(),
 check(base_currency_id<>quote_currency_id),
 unique(base_currency_id,quote_currency_id,source,rate_date)
);

create table if not exists public.expenses(
 id uuid primary key default gen_random_uuid(),
 shipment_id uuid references public.shipments(id) on delete restrict,
 attributed_customer_id uuid references public.counterparties(id) on delete restrict,
 expense_type text not null check(expense_type in ('goods_cost','transport','logistics','broker_fee','customs_duty','tax','stickering','marking','bank_fee','promo','return','other')),
 payee_counterparty_id uuid references public.counterparties(id) on delete restrict,
 amount numeric(14,2) not null check(amount>0),
 currency_id uuid not null references public.currencies(id) on delete restrict,
 exchange_rate_id uuid references public.exchange_rates(id) on delete restrict,
 document_id uuid references public.documents(id) on delete restrict,
 incurred_at date not null,
 is_planned boolean not null default true,
 status text not null default 'draft' check(status in ('draft','confirmed','allocated','paid')),
 notes text,
 confirmed_by uuid references public.profiles(id) on delete restrict,
 confirmed_at timestamptz,
 paid_by uuid references public.profiles(id) on delete restrict,
 paid_at timestamptz,
 created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check(shipment_id is not null or attributed_customer_id is not null)
);

create table if not exists public.expense_allocations(
 id uuid primary key default gen_random_uuid(),
 expense_id uuid not null references public.expenses(id) on delete restrict,
 shipment_item_id uuid references public.shipment_items(id) on delete restrict,
 batch_id uuid references public.inventory_batches(id) on delete restrict,
 allocation_method text not null check(allocation_method in ('by_quantity','by_weight','by_volume','by_value','manual')),
 allocation_basis numeric(18,6),
 allocation_share numeric(12,9) not null check(allocation_share>=0 and allocation_share<=1),
 allocated_amount numeric(14,2) not null check(allocated_amount>=0),
 currency_id uuid not null references public.currencies(id) on delete restrict,
 created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
 created_at timestamptz not null default now(),
 check(shipment_item_id is not null or batch_id is not null),
 unique(expense_id,shipment_item_id,batch_id)
);

create table if not exists public.cost_calculations(
 id uuid primary key default gen_random_uuid(),shipment_id uuid not null references public.shipments(id) on delete restrict,
 version_number integer not null check(version_number>0),currency_id uuid not null references public.currencies(id) on delete restrict,
 status text not null default 'draft' check(status in ('draft','approved','superseded')),
 goods_total numeric(14,2) not null default 0,expenses_total numeric(14,2) not null default 0,landed_total numeric(14,2) not null default 0,
 calculated_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,calculated_at timestamptz not null default now(),
 approved_by uuid references public.profiles(id) on delete restrict,approved_at timestamptz,unique(shipment_id,version_number)
);

create table if not exists public.cost_calculation_items(
 id uuid primary key default gen_random_uuid(),calculation_id uuid not null references public.cost_calculations(id) on delete restrict,
 shipment_item_id uuid not null references public.shipment_items(id) on delete restrict,product_id uuid not null references public.products(id) on delete restrict,
 quantity numeric(14,3) not null check(quantity>0),goods_amount numeric(14,2) not null check(goods_amount>=0),
 allocated_expenses numeric(14,2) not null check(allocated_expenses>=0),landed_amount numeric(14,2) not null check(landed_amount>=0),
 unit_landed_cost numeric(14,4) not null check(unit_landed_cost>=0),currency_id uuid not null references public.currencies(id) on delete restrict,
 unique(calculation_id,shipment_item_id)
);

alter table public.inventory_batches add column if not exists unit_landed_cost numeric(14,4) check(unit_landed_cost is null or unit_landed_cost>=0);
alter table public.inventory_batches add column if not exists cost_currency_id uuid references public.currencies(id) on delete restrict;
alter table public.inventory_batches add column if not exists cost_calculation_id uuid references public.cost_calculations(id) on delete restrict;

create index if not exists expenses_shipment_idx on public.expenses(shipment_id,incurred_at desc);
create index if not exists expense_allocations_item_idx on public.expense_allocations(shipment_item_id);
create index if not exists cost_calculations_shipment_idx on public.cost_calculations(shipment_id,version_number desc);

do $$ declare t text;begin foreach t in array array['exchange_rates','expenses','expense_allocations','cost_calculations','cost_calculation_items'] loop
 execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from anon,authenticated',t);execute format('grant select on public.%I to authenticated',t);
 execute format('drop policy if exists "finance read" on public.%I',t);
 execute format('create policy "finance read" on public.%I for select to authenticated using ((select private.has_permission(%L)))',t,case when t like 'cost_%%' then 'costing.view' else 'finance.view' end);
end loop;end $$;
-- Logistics staff can see their own drafts and expenses of shipments assigned to them.
drop policy if exists "own logistics expense read" on public.expenses;
create policy "own logistics expense read" on public.expenses for select to authenticated using(
 (select private.has_permission('finance.draft')) and (created_by=auth.uid() or exists(select 1 from public.shipments s where s.id=shipment_id and s.responsible_user_id=auth.uid())));
drop policy if exists "own logistics allocation read" on public.expense_allocations;
create policy "own logistics allocation read" on public.expense_allocations for select to authenticated using(exists(select 1 from public.expenses e where e.id=expense_id and (e.created_by=auth.uid() or exists(select 1 from public.shipments s where s.id=e.shipment_id and s.responsible_user_id=auth.uid()))));
drop policy if exists "assigned costing read" on public.cost_calculations;
create policy "assigned costing read" on public.cost_calculations for select to authenticated using((select private.has_permission('costing.view_assigned')) and exists(select 1 from public.shipments s where s.id=shipment_id and s.responsible_user_id=auth.uid()));
drop policy if exists "assigned costing item read" on public.cost_calculation_items;
create policy "assigned costing item read" on public.cost_calculation_items for select to authenticated using((select private.has_permission('costing.view_assigned')) and exists(select 1 from public.cost_calculations c join public.shipments s on s.id=c.shipment_id where c.id=calculation_id and s.responsible_user_id=auth.uid()));

create or replace function private.finance_rate(p_base uuid,p_quote uuid,p_on date) returns table(rate_id uuid,rate numeric)
language plpgsql stable security definer set search_path='' as $$begin
 if p_base=p_quote then return query select null::uuid,1::numeric;return;end if;
 return query select r.id,r.rate from public.exchange_rates r where r.base_currency_id=p_base and r.quote_currency_id=p_quote and r.rate_date<=p_on order by r.rate_date desc,(r.source='bank') desc limit 1;
end$$;
revoke all on function private.finance_rate(uuid,uuid,date) from public,anon,authenticated,service_role;

create or replace function public.add_exchange_rate(p_base_currency_id uuid,p_quote_currency_id uuid,p_rate numeric,p_source text,p_source_name text,p_rate_date date)
returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;begin
 if not (select private.has_permission('finance.manage')) then raise exception 'Нет права добавлять курсы валют';end if;
 if p_rate<=0 or p_source not in ('official','bank') or p_rate_date>current_date then raise exception 'Проверьте курс, источник и дату';end if;
 insert into public.exchange_rates(base_currency_id,quote_currency_id,rate,source,source_name,rate_date) values(p_base_currency_id,p_quote_currency_id,p_rate,p_source,nullif(btrim(p_source_name),''),p_rate_date) returning id into v_id;return v_id;
end $$;

create or replace function public.create_expense(p_shipment_id uuid,p_expense_type text,p_payee_counterparty_id uuid,p_amount numeric,p_currency_id uuid,p_incurred_at date,p_is_planned boolean,p_document_id uuid,p_notes text)
returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;begin
 if not ((select private.has_permission('finance.manage')) or (select private.has_permission('finance.draft'))) then raise exception 'Нет права создавать расходы';end if;
 if p_amount<=0 or p_expense_type not in ('goods_cost','transport','logistics','broker_fee','customs_duty','tax','stickering','marking','bank_fee','promo','return','other') then raise exception 'Проверьте сумму и вид расхода';end if;
 if not exists(select 1 from public.shipments where id=p_shipment_id and status<>'cancelled') then raise exception 'Поставка не найдена';end if;
 insert into public.expenses(shipment_id,expense_type,payee_counterparty_id,amount,currency_id,incurred_at,is_planned,document_id,notes)
 values(p_shipment_id,p_expense_type,p_payee_counterparty_id,p_amount,p_currency_id,p_incurred_at,p_is_planned,p_document_id,nullif(btrim(p_notes),'')) returning id into v_id;return v_id;
end $$;

create or replace function public.confirm_expense(p_expense_id uuid)
returns void language plpgsql security definer set search_path='' as $$begin
 if not (select private.has_permission('finance.confirm')) then raise exception 'Нет права подтверждать расходы';end if;
 update public.expenses set status='confirmed',confirmed_by=auth.uid(),confirmed_at=now(),updated_at=now() where id=p_expense_id and status='draft';if not found then raise exception 'Подтвердить можно только черновик';end if;
end $$;

create or replace function public.allocate_expense(p_expense_id uuid,p_method text,p_target_currency_id uuid)
returns void language plpgsql security definer set search_path='' as $$declare e record;r record;v_rate numeric;v_rate_id uuid;v_total numeric:=0;v_amount numeric;v_left numeric;v_n integer;v_i integer:=0;begin
 if not (select private.has_permission('costing.calculate')) then raise exception 'Нет права распределять расходы';end if;
 if p_method not in ('by_quantity','by_weight','by_volume','by_value') then raise exception 'Выберите способ распределения';end if;
 select * into e from public.expenses where id=p_expense_id and status in ('confirmed','allocated') and shipment_id is not null for update;if not found then raise exception 'Сначала подтвердите расход';end if;
 select rate_id,rate into v_rate_id,v_rate from private.finance_rate(e.currency_id,p_target_currency_id,e.incurred_at);if v_rate is null then raise exception 'Нет курса валюты на дату расхода';end if;
 update public.expenses set exchange_rate_id=v_rate_id where id=e.id;delete from public.expense_allocations where expense_id=e.id;
 create temporary table if not exists pg_temp.finance_basis(item_id uuid,basis numeric) on commit drop;truncate pg_temp.finance_basis;
 insert into pg_temp.finance_basis
 select i.id,case p_method when 'by_quantity' then coalesce(i.received_quantity,i.shipped_quantity,i.confirmed_quantity,i.ordered_quantity)
 when 'by_value' then coalesce(i.received_quantity,i.shipped_quantity,i.confirmed_quantity,i.ordered_quantity)*i.unit_price
 when 'by_weight' then coalesce(i.received_quantity,i.shipped_quantity,i.confirmed_quantity,i.ordered_quantity)*p.gross_weight_kg
 else coalesce(i.received_quantity,i.shipped_quantity,i.confirmed_quantity,i.ordered_quantity)*p.volume_m3 end
 from public.shipment_items i left join lateral(select pp.gross_weight_kg,coalesce(pp.volume_m3,(pp.length_cm*pp.width_cm*pp.height_cm)/1000000) volume_m3 from public.product_packaging pp where pp.product_id=i.product_id and pp.uom=i.uom limit 1)p on true
 where i.shipment_id=e.shipment_id;
 if exists(select 1 from pg_temp.finance_basis where basis is null or basis<=0) then raise exception 'Для выбранного способа не хватает цены, веса или объёма у позиций';end if;
 select sum(basis),count(*) into v_total,v_n from pg_temp.finance_basis;if coalesce(v_total,0)<=0 then raise exception 'В поставке нет позиций для распределения';end if;
 v_amount:=round(e.amount*v_rate,2);v_left:=v_amount;
 for r in select * from pg_temp.finance_basis order by item_id loop v_i:=v_i+1;
  insert into public.expense_allocations(expense_id,shipment_item_id,allocation_method,allocation_basis,allocation_share,allocated_amount,currency_id)
  values(e.id,r.item_id,p_method,r.basis,r.basis/v_total,case when v_i=v_n then v_left else round(v_amount*r.basis/v_total,2) end,p_target_currency_id);
  if v_i<v_n then v_left:=v_left-round(v_amount*r.basis/v_total,2);end if;
 end loop;
 update public.expenses set status='allocated',updated_at=now() where id=e.id;
end $$;

create or replace function public.mark_expense_paid(p_expense_id uuid)
returns void language plpgsql security definer set search_path='' as $$begin
 if not (select private.has_permission('finance.pay')) then raise exception 'Нет права подтверждать оплату';end if;
 update public.expenses set status='paid',paid_by=auth.uid(),paid_at=now(),updated_at=now() where id=p_expense_id and status='allocated';if not found then raise exception 'Оплатить можно только распределённый расход';end if;
end $$;

create or replace function public.calculate_shipment_cost(p_shipment_id uuid,p_target_currency_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;v_version integer;v_goods numeric;v_expenses numeric;v_goods_item numeric;v_exp_item numeric;r record;v_rate numeric;begin
 if not (select private.has_permission('costing.calculate')) then raise exception 'Нет права рассчитывать себестоимость';end if;
 if exists(select 1 from public.expenses where shipment_id=p_shipment_id and status in ('draft','confirmed')) then raise exception 'Подтвердите и распределите все расходы поставки';end if;
 if exists(select 1 from public.expenses e join public.expense_allocations a on a.expense_id=e.id where e.shipment_id=p_shipment_id and a.currency_id<>p_target_currency_id) then raise exception 'Все расходы должны быть распределены в валюте расчёта';end if;
 if not exists(select 1 from public.shipment_items where shipment_id=p_shipment_id) then raise exception 'В поставке нет товаров';end if;
 select coalesce(max(version_number),0)+1 into v_version from public.cost_calculations where shipment_id=p_shipment_id;
 insert into public.cost_calculations(shipment_id,version_number,currency_id) values(p_shipment_id,v_version,p_target_currency_id) returning id into v_id;
 for r in select i.*,coalesce(i.received_quantity,i.shipped_quantity,i.confirmed_quantity,i.ordered_quantity) qty from public.shipment_items i where i.shipment_id=p_shipment_id order by i.id loop
  if r.unit_price is null or r.currency_id is null then raise exception 'У позиции поставки не заполнена закупочная цена или валюта';end if;
  select rate into v_rate from private.finance_rate(r.currency_id,p_target_currency_id,current_date);if v_rate is null then raise exception 'Нет курса для закупочной цены';end if;
  select coalesce(nullif(sum(a.allocated_amount) filter(where e.expense_type='goods_cost'),0),round(r.qty*r.unit_price*v_rate,2)),coalesce(sum(a.allocated_amount) filter(where e.expense_type<>'goods_cost'),0)
  into v_goods_item,v_exp_item from public.expense_allocations a join public.expenses e on e.id=a.expense_id where a.shipment_item_id=r.id;
  insert into public.cost_calculation_items(calculation_id,shipment_item_id,product_id,quantity,goods_amount,allocated_expenses,landed_amount,unit_landed_cost,currency_id)
  values(v_id,r.id,r.product_id,r.qty,v_goods_item,v_exp_item,round(v_goods_item+v_exp_item,2),round((v_goods_item+v_exp_item)/r.qty,4),p_target_currency_id);
 end loop;
 select coalesce(sum(goods_amount),0),coalesce(sum(allocated_expenses),0) into v_goods,v_expenses from public.cost_calculation_items where calculation_id=v_id;
 update public.cost_calculations set goods_total=v_goods,expenses_total=v_expenses,landed_total=v_goods+v_expenses where id=v_id;return v_id;
end $$;

create or replace function public.approve_shipment_cost(p_calculation_id uuid)
returns void language plpgsql security definer set search_path='' as $$declare c record;begin
 if not (select private.has_permission('costing.approve')) then raise exception 'Нет права утверждать себестоимость';end if;
 select * into c from public.cost_calculations where id=p_calculation_id and status='draft' for update;if not found then raise exception 'Расчёт не найден или уже утверждён';end if;
 update public.cost_calculations set status='superseded' where shipment_id=c.shipment_id and status='approved';
 update public.cost_calculations set status='approved',approved_by=auth.uid(),approved_at=now() where id=c.id;
 update public.inventory_batches b set unit_landed_cost=i.unit_landed_cost,cost_currency_id=i.currency_id,cost_calculation_id=c.id,updated_at=now() from public.cost_calculation_items i where i.calculation_id=c.id and i.shipment_item_id=b.source_shipment_item_id;
end $$;

do $$declare f text;begin foreach f in array array[
 'public.add_exchange_rate(uuid,uuid,numeric,text,text,date)','public.create_expense(uuid,text,uuid,numeric,uuid,date,boolean,uuid,text)',
 'public.confirm_expense(uuid)','public.allocate_expense(uuid,text,uuid)','public.mark_expense_paid(uuid)','public.calculate_shipment_cost(uuid,uuid)','public.approve_shipment_cost(uuid)'] loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',f);execute format('grant execute on function %s to authenticated',f);end loop;end $$;

do $$declare t text;begin foreach t in array array['exchange_rates','expenses','expense_allocations','cost_calculations','cost_calculation_items'] loop execute format('drop trigger if exists audit_%I_changes on public.%I',t,t);execute format('create trigger audit_%I_changes after insert or update on public.%I for each row execute function private.write_access_audit()',t,t);end loop;end $$;

comment on table public.exchange_rates is 'Append-only currency rates used by approved cost calculations';
comment on table public.cost_calculations is 'Versioned shipment landed-cost snapshots; approved values flow to inventory batches';
