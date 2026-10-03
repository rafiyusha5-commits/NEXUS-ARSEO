-- Purchase price and landed-cost confidentiality.
-- Sales price-list data and employee access to internal document files are intentionally
-- unchanged. External document access remains governed by the explicit client-sharing model.

insert into public.permissions(code,module,action,name,description) values
 ('prices.purchase.view','prices','purchase_view','Закупочные цены и себестоимость','Просмотр закупочных цен, стоимости товара и фактической себестоимости')
on conflict(code) do update set module=excluded.module,action=excluded.action,name=excluded.name,description=excluded.description;

insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true
from public.app_roles r cross join public.permissions p
where p.code='prices.purchase.view' and r.code in (
 'administrator','director','executive_director','commercial_director',
 'logistics_director','senior_logistics_manager','accountant'
)
on conflict(role_id,permission_id) do update set granted=true;

-- The company sales price/order values are ordinary employee data. This keeps the existing
-- sales module and adds the only missing internal role (marketer); external roles are excluded.
insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true from public.app_roles r cross join public.permissions p
where p.code='sales.view' and r.code in (
 'administrator','director','executive_director','commercial_director','logistics_director',
 'senior_logistics_manager','logistics_specialist','accountant','marketer'
)
on conflict(role_id,permission_id) do update set granted=true;

delete from public.role_permissions rp
using public.app_roles r, public.permissions p
where rp.role_id=r.id and rp.permission_id=p.id
  and p.code='sales.view' and r.code='external_client';

-- A personal deny must also remove a default role grant.
delete from public.role_permissions rp
using public.app_roles r, public.permissions p
where rp.role_id=r.id and rp.permission_id=p.id
  and p.code='prices.purchase.view'
  and r.code in ('logistics_specialist','marketer','external_client');

-- Mixed tables expose only their operational columns through PostgREST. Confidential
-- columns are returned through permission-checked RPCs below.
revoke select, insert, update on public.products from authenticated;
do $$ declare v_columns text; begin
 select string_agg(format('%I',column_name),', ' order by ordinal_position) into v_columns
 from information_schema.columns where table_schema='public' and table_name='products' and column_name<>'base_purchase_price';
 execute format('grant select (%s) on public.products to authenticated',v_columns);
 execute format('grant insert (%s) on public.products to authenticated',v_columns);
 execute format('grant update (%s) on public.products to authenticated',v_columns);
end $$;

revoke select, insert, update on public.shipment_items from authenticated;
do $$ declare v_columns text; begin
 select string_agg(format('%I',column_name),', ' order by ordinal_position) into v_columns
 from information_schema.columns where table_schema='public' and table_name='shipment_items' and column_name<>'unit_price';
 execute format('grant select (%s) on public.shipment_items to authenticated',v_columns);
end $$;

revoke select on public.inventory_batches from authenticated;
do $$ declare v_columns text; begin
 select string_agg(format('%I',column_name),', ' order by ordinal_position) into v_columns
 from information_schema.columns where table_schema='public' and table_name='inventory_batches'
   and column_name not in ('unit_landed_cost','cost_currency_id','cost_calculation_id');
 execute format('grant select (%s) on public.inventory_batches to authenticated',v_columns);
end $$;

create or replace function public.my_product_purchase_prices(p_product_ids uuid[] default null)
returns table(product_id uuid,base_purchase_price numeric,currency_id uuid)
language plpgsql stable security definer set search_path=''
as $$begin
 if not (select private.has_permission('products.view')) or not (select private.has_permission('prices.purchase.view')) then
  raise exception 'Нет доступа к закупочным ценам' using errcode='42501';
 end if;
 return query select p.id,p.base_purchase_price,p.default_currency_id from public.products p
 where p_product_ids is null or p.id=any(p_product_ids);
end $$;

create or replace function public.my_shipment_item_purchase_prices(p_shipment_id uuid)
returns table(item_id uuid,unit_price numeric)
language plpgsql stable security definer set search_path=''
as $$begin
 if not (select private.has_permission('shipments.view')) or not (select private.has_permission('prices.purchase.view')) then
  raise exception 'Нет доступа к закупочным ценам' using errcode='42501';
 end if;
 return query select i.id,i.unit_price from public.shipment_items i where i.shipment_id=p_shipment_id;
end $$;

create or replace function public.my_inventory_batch_costs(p_product_id uuid default null)
returns table(batch_id uuid,unit_landed_cost numeric,cost_currency_id uuid,cost_calculation_id uuid)
language plpgsql stable security definer set search_path=''
as $$begin
 if not (select private.has_permission('inventory.view')) or not (select private.has_permission('prices.purchase.view')) then
  raise exception 'Нет доступа к себестоимости' using errcode='42501';
 end if;
 return query select b.id,b.unit_landed_cost,b.cost_currency_id,b.cost_calculation_id
 from public.inventory_batches b where p_product_id is null or b.product_id=p_product_id;
end $$;

create or replace function public.create_shipment_item(
 p_shipment_id uuid,p_product_id uuid,p_uom text,p_quantity numeric,p_unit_price numeric default null,p_currency_id uuid default null
) returns uuid language plpgsql security definer set search_path=''
as $$declare v_id uuid;begin
 if not private.can_write_shipments('update') then raise exception 'Недостаточно прав для добавления товара' using errcode='42501';end if;
 if p_quantity is null or p_quantity<=0 then raise exception 'Количество должно быть больше нуля';end if;
 if p_unit_price is not null and not (select private.has_permission('prices.purchase.view')) then raise exception 'Нет права указывать закупочную цену' using errcode='42501';end if;
 if p_unit_price is not null and p_unit_price<0 then raise exception 'Цена не может быть отрицательной';end if;
 insert into public.shipment_items(shipment_id,product_id,uom,ordered_quantity,unit_price,currency_id)
 values(p_shipment_id,p_product_id,coalesce(nullif(btrim(p_uom),''),'piece'),p_quantity,p_unit_price,p_currency_id)
 returning id into v_id;
 return v_id;
end $$;

create or replace function public.update_shipment_item(p_item_id uuid,p_quantity numeric,p_unit_price numeric default null)
returns void language plpgsql security definer set search_path=''
as $$declare v_locked boolean;v_can_price boolean:=(select private.has_permission('prices.purchase.view'));begin
 if not private.can_write_shipments('update') then raise exception 'Недостаточно прав для изменения товара' using errcode='42501';end if;
 if p_quantity is null or p_quantity<=0 then raise exception 'Количество должно быть больше нуля';end if;
 if p_unit_price is not null and not v_can_price then raise exception 'Нет права изменять закупочную цену' using errcode='42501';end if;
 if p_unit_price is not null and p_unit_price<0 then raise exception 'Цена не может быть отрицательной';end if;
 select s.is_locked into v_locked from public.shipment_items i join public.shipments s on s.id=i.shipment_id where i.id=p_item_id;
 if not found then raise exception 'Позиция поставки не найдена';end if;
 if v_locked then raise exception 'Закрытая поставка недоступна для изменений';end if;
 update public.shipment_items set ordered_quantity=p_quantity,
  unit_price=case when v_can_price then p_unit_price else unit_price end,updated_at=now() where id=p_item_id;
end $$;

-- Price terms in contracts follow the new permission for reads and writes.
drop policy if exists "employees view permitted contract terms" on public.contract_terms;
create policy "employees view permitted contract terms" on public.contract_terms for select to authenticated using(
 exists(select 1 from public.contracts c where c.id=contract_id and (select private.can_access_counterparty_record('view',c.counterparty_id)))
 and (term_type<>'price' or (select private.has_permission('prices.purchase.view'))));
drop policy if exists "employees create permitted contract terms" on public.contract_terms;
create policy "employees create permitted contract terms" on public.contract_terms for insert to authenticated with check(
 exists(select 1 from public.contracts c where c.id=contract_id and (select private.can_access_counterparty_record('create',c.counterparty_id)))
 and (term_type<>'price' or (select private.has_permission('prices.purchase.view'))));
drop policy if exists "employees update permitted contract terms" on public.contract_terms;
create policy "employees update permitted contract terms" on public.contract_terms for update to authenticated using(
 exists(select 1 from public.contracts c where c.id=contract_id and (select private.can_access_counterparty_record('update',c.counterparty_id)))
 and (term_type<>'price' or (select private.has_permission('prices.purchase.view')))) with check(
 exists(select 1 from public.contracts c where c.id=contract_id and (select private.can_access_counterparty_record('update',c.counterparty_id)))
 and (term_type<>'price' or (select private.has_permission('prices.purchase.view'))));

-- Cost ledgers always require the new permission, including assigned-shipment branches.
do $$ declare t text;begin foreach t in array array['cost_calculations','cost_calculation_items'] loop
 execute format('drop policy if exists "finance read" on public.%I',t);
 execute format('create policy "finance read" on public.%I for select to authenticated using ((select private.has_permission(''costing.view'')) and (select private.has_permission(''prices.purchase.view'')))',t);
end loop;end $$;
drop policy if exists "finance read" on public.expenses;
create policy "finance read" on public.expenses for select to authenticated using(
 (select private.has_permission('finance.view'))
 and (expense_type<>'goods_cost' or (select private.has_permission('prices.purchase.view'))));
drop policy if exists "finance read" on public.expense_allocations;
create policy "finance read" on public.expense_allocations for select to authenticated using(
 (select private.has_permission('finance.view')) and exists(select 1 from public.expenses e where e.id=expense_id
 and (e.expense_type<>'goods_cost' or (select private.has_permission('prices.purchase.view')))));
drop policy if exists "assigned costing read" on public.cost_calculations;
create policy "assigned costing read" on public.cost_calculations for select to authenticated using(
 (select private.has_permission('prices.purchase.view')) and (select private.has_permission('costing.view_assigned'))
 and exists(select 1 from public.shipments s where s.id=shipment_id and s.responsible_user_id=auth.uid()));
drop policy if exists "assigned costing item read" on public.cost_calculation_items;
create policy "assigned costing item read" on public.cost_calculation_items for select to authenticated using(
 (select private.has_permission('prices.purchase.view')) and (select private.has_permission('costing.view_assigned'))
 and exists(select 1 from public.cost_calculations c join public.shipments s on s.id=c.shipment_id where c.id=calculation_id and s.responsible_user_id=auth.uid()));

drop policy if exists "own logistics expense read" on public.expenses;
create policy "own logistics expense read" on public.expenses for select to authenticated using(
 (select private.has_permission('finance.draft')) and (expense_type<>'goods_cost' or (select private.has_permission('prices.purchase.view')))
 and (created_by=auth.uid() or exists(select 1 from public.shipments s where s.id=shipment_id and s.responsible_user_id=auth.uid())));
drop policy if exists "own logistics allocation read" on public.expense_allocations;
create policy "own logistics allocation read" on public.expense_allocations for select to authenticated using(
 (select private.has_permission('finance.draft')) and exists(select 1 from public.expenses e where e.id=expense_id
 and (e.expense_type<>'goods_cost' or (select private.has_permission('prices.purchase.view')))
 and (e.created_by=auth.uid() or exists(select 1 from public.shipments s where s.id=e.shipment_id and s.responsible_user_id=auth.uid()))));

-- Preserve the existing API but prevent creation of a hidden goods-cost row.
create or replace function public.create_expense(p_shipment_id uuid,p_expense_type text,p_payee_counterparty_id uuid,p_amount numeric,p_currency_id uuid,p_incurred_at date,p_is_planned boolean,p_document_id uuid,p_notes text)
returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;begin
 if not ((select private.has_permission('finance.manage')) or (select private.has_permission('finance.draft'))) then raise exception 'Нет права создавать расходы';end if;
 if p_expense_type='goods_cost' and not (select private.has_permission('prices.purchase.view')) then raise exception 'Нет права указывать стоимость товара' using errcode='42501';end if;
 if p_amount<=0 or p_expense_type not in ('goods_cost','transport','logistics','broker_fee','customs_duty','tax','stickering','marking','bank_fee','promo','return','other') then raise exception 'Проверьте сумму и вид расхода';end if;
 if not exists(select 1 from public.shipments where id=p_shipment_id and status<>'cancelled') then raise exception 'Поставка не найдена';end if;
 insert into public.expenses(shipment_id,expense_type,payee_counterparty_id,amount,currency_id,incurred_at,is_planned,document_id,notes)
 values(p_shipment_id,p_expense_type,p_payee_counterparty_id,p_amount,p_currency_id,p_incurred_at,p_is_planned,p_document_id,nullif(btrim(p_notes),'')) returning id into v_id;return v_id;
end $$;

-- A personal price deny must also stop SECURITY DEFINER costing actions. Read RLS alone
-- is insufficient because these functions intentionally operate behind it.
create or replace function public.confirm_expense(p_expense_id uuid)
returns void language plpgsql security definer set search_path='' as $$declare v_type text;begin
 if not (select private.has_permission('finance.confirm')) then raise exception 'Нет права подтверждать расходы';end if;
 select expense_type into v_type from public.expenses where id=p_expense_id;
 if v_type='goods_cost' and not (select private.has_permission('prices.purchase.view')) then raise exception 'Нет доступа к стоимости товара' using errcode='42501';end if;
 update public.expenses set status='confirmed',confirmed_by=auth.uid(),confirmed_at=now(),updated_at=now() where id=p_expense_id and status='draft';if not found then raise exception 'Подтвердить можно только черновик';end if;
end $$;

create or replace function public.allocate_expense(p_expense_id uuid,p_method text,p_target_currency_id uuid)
returns void language plpgsql security definer set search_path='' as $$declare e record;r record;v_rate numeric;v_rate_id uuid;v_total numeric:=0;v_amount numeric;v_left numeric;v_n integer;v_i integer:=0;begin
 if not (select private.has_permission('costing.calculate')) then raise exception 'Нет права распределять расходы';end if;
 if not (select private.has_permission('prices.purchase.view')) then raise exception 'Нет доступа к себестоимости' using errcode='42501';end if;
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
returns void language plpgsql security definer set search_path='' as $$declare v_type text;begin
 if not (select private.has_permission('finance.pay')) then raise exception 'Нет права подтверждать оплату';end if;
 select expense_type into v_type from public.expenses where id=p_expense_id;
 if v_type='goods_cost' and not (select private.has_permission('prices.purchase.view')) then raise exception 'Нет доступа к стоимости товара' using errcode='42501';end if;
 update public.expenses set status='paid',paid_by=auth.uid(),paid_at=now(),updated_at=now() where id=p_expense_id and status='allocated';if not found then raise exception 'Оплатить можно только распределённый расход';end if;
end $$;

create or replace function public.calculate_shipment_cost(p_shipment_id uuid,p_target_currency_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$declare v_id uuid;v_version integer;v_goods numeric;v_expenses numeric;v_goods_item numeric;v_exp_item numeric;r record;v_rate numeric;begin
 if not (select private.has_permission('costing.calculate')) then raise exception 'Нет права рассчитывать себестоимость';end if;
 if not (select private.has_permission('prices.purchase.view')) then raise exception 'Нет доступа к себестоимости' using errcode='42501';end if;
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
 if not (select private.has_permission('prices.purchase.view')) then raise exception 'Нет доступа к себестоимости' using errcode='42501';end if;
 select * into c from public.cost_calculations where id=p_calculation_id and status='draft' for update;if not found then raise exception 'Расчёт не найден или уже утверждён';end if;
 update public.cost_calculations set status='superseded' where shipment_id=c.shipment_id and status='approved';
 update public.cost_calculations set status='approved',approved_by=auth.uid(),approved_at=now() where id=c.id;
 update public.inventory_batches b set unit_landed_cost=i.unit_landed_cost,cost_currency_id=i.currency_id,cost_calculation_id=c.id,updated_at=now() from public.cost_calculation_items i where i.calculation_id=c.id and i.shipment_item_id=b.source_shipment_item_id;
end $$;

do $$declare f text;begin foreach f in array array[
 'public.my_product_purchase_prices(uuid[])','public.my_shipment_item_purchase_prices(uuid)','public.my_inventory_batch_costs(uuid)',
 'public.create_shipment_item(uuid,uuid,text,numeric,numeric,uuid)','public.update_shipment_item(uuid,numeric,numeric)','public.create_expense(uuid,text,uuid,numeric,uuid,date,boolean,uuid,text)',
 'public.confirm_expense(uuid)','public.allocate_expense(uuid,text,uuid)','public.mark_expense_paid(uuid)','public.calculate_shipment_cost(uuid,uuid)','public.approve_shipment_cost(uuid)'
] loop execute format('revoke all on function %s from public,anon,authenticated,service_role',f);execute format('grant execute on function %s to authenticated',f);end loop;end $$;

comment on function public.my_product_purchase_prices(uuid[]) is 'Returns product purchase prices only to prices.purchase.view holders';
comment on function public.my_shipment_item_purchase_prices(uuid) is 'Returns shipment purchase prices only to prices.purchase.view holders';
comment on function public.my_inventory_batch_costs(uuid) is 'Returns landed costs only to prices.purchase.view holders';
