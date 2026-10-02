-- Explicit supplier assortment. For ARSEO an active supplier is the product's factory-manufacturer.
create table if not exists public.product_suppliers (
  product_id uuid not null references public.products(id) on delete cascade,
  supplier_id uuid not null references public.counterparties(id) on delete restrict,
  is_primary boolean not null default false,
  status text not null default 'active' check (status in ('active','inactive')),
  notes text,
  created_by uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (product_id,supplier_id)
);

create index if not exists product_suppliers_supplier_idx on public.product_suppliers(supplier_id,product_id) where status='active';
create unique index if not exists product_suppliers_one_active on public.product_suppliers(product_id) where status='active';

-- Preserve every relationship that the application previously inferred.
insert into public.product_suppliers(product_id,supplier_id,is_primary,status,notes)
select p.id,p.manufacturer_id,true,'active','Перенесено из производителя товара'
from public.products p
join public.counterparties c on c.id=p.manufacturer_id and c.roles@>array['manufacturer']
on conflict (product_id,supplier_id) do update set status='active',is_primary=excluded.is_primary,updated_at=now();

insert into public.product_suppliers(product_id,supplier_id,is_primary,status,notes)
select distinct i.product_id,i.counterparty_id,false,'inactive','Перенесено из артикула поставщика'
from public.product_identifiers i
join public.counterparties c on c.id=i.counterparty_id and c.roles&&array['supplier','manufacturer']
where i.identifier_type='supplier_sku'
on conflict (product_id,supplier_id) do update set updated_at=now();

insert into public.product_suppliers(product_id,supplier_id,is_primary,status,notes)
select distinct si.product_id,s.supplier_id,false,'inactive','Перенесено из истории поставок'
from public.shipment_items si join public.shipments s on s.id=si.shipment_id
join public.counterparties c on c.id=s.supplier_id and c.roles&&array['supplier','manufacturer']
where s.type='import' and s.supplier_id is not null
on conflict (product_id,supplier_id) do update set updated_at=now();

create or replace function private.validate_product_supplier() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from public.products where id=new.product_id) then raise exception 'Товар не найден'; end if;
  if not exists(select 1 from public.counterparties where id=new.supplier_id and roles&&array['supplier','manufacturer']) then
    raise exception 'Выбранная организация не является поставщиком';
  end if;
  if new.status='active' and not exists(select 1 from public.counterparties where id=new.supplier_id and status='active' and roles@>array['manufacturer']) then
    raise exception 'Активным поставщиком может быть только действующий завод-производитель';
  end if;
  if new.status='active' and not exists(select 1 from public.products where id=new.product_id and manufacturer_id=new.supplier_id) then
    raise exception 'Поставщик товара должен совпадать с его заводом-производителем';
  end if;
  if new.is_primary and new.status='active' then
    update public.product_suppliers set is_primary=false,updated_at=now()
    where product_id=new.product_id and supplier_id<>new.supplier_id and is_primary;
  end if;
  new.updated_at:=now();
  return new;
end$$;
revoke all on function private.validate_product_supplier() from public,anon,authenticated,service_role;
drop trigger if exists validate_product_supplier on public.product_suppliers;
create trigger validate_product_supplier before insert or update on public.product_suppliers for each row execute function private.validate_product_supplier();

-- Every product write keeps the active supplier equal to the selected factory.
-- This also covers products created by the transactional reference-data import.
create or replace function private.sync_product_factory_supplier() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' and old.manufacturer_id is distinct from new.manufacturer_id then
    update public.product_suppliers set status='inactive',is_primary=false,updated_at=now()
    where product_id=new.id and status='active';
  end if;
  insert into public.product_suppliers(product_id,supplier_id,is_primary,status,notes,created_by)
  values(new.id,new.manufacturer_id,true,'active','Завод-производитель товара',auth.uid())
  on conflict (product_id,supplier_id) do update set is_primary=true,status='active',updated_at=now();
  return new;
end$$;
revoke all on function private.sync_product_factory_supplier() from public,anon,authenticated,service_role;
drop trigger if exists sync_product_factory_supplier on public.products;
create trigger sync_product_factory_supplier after insert or update of manufacturer_id on public.products for each row execute function private.sync_product_factory_supplier();

create or replace function private.validate_supplier_identifier() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.identifier_type='supplier_sku' and not exists(
    select 1 from public.product_suppliers ps where ps.product_id=new.product_id and ps.supplier_id=new.counterparty_id and ps.status='active'
  ) then raise exception 'Сначала привяжите поставщика к товару'; end if;
  return new;
end$$;
revoke all on function private.validate_supplier_identifier() from public,anon,authenticated,service_role;
drop trigger if exists validate_supplier_identifier on public.product_identifiers;
create trigger validate_supplier_identifier before insert or update of product_id,identifier_type,counterparty_id on public.product_identifiers for each row execute function private.validate_supplier_identifier();

create or replace function private.validate_shipment_item_supplier() returns trigger language plpgsql security definer set search_path='' as $$
declare v_type text;v_supplier uuid;
begin
  select type,supplier_id into v_type,v_supplier from public.shipments where id=new.shipment_id;
  if not found then raise exception 'Поставка не найдена'; end if;
  if v_type='import' and not exists(
    select 1 from public.product_suppliers ps where ps.product_id=new.product_id and ps.supplier_id=v_supplier and ps.status='active'
  ) then raise exception 'Этот товар не закреплён за выбранным поставщиком'; end if;
  return new;
end$$;
revoke all on function private.validate_shipment_item_supplier() from public,anon,authenticated,service_role;
drop trigger if exists validate_shipment_item_supplier on public.shipment_items;
create trigger validate_shipment_item_supplier before insert or update of shipment_id,product_id on public.shipment_items for each row execute function private.validate_shipment_item_supplier();

create or replace function private.validate_import_factory() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.type='import' and not exists(
    select 1 from public.counterparties where id=new.supplier_id and status='active' and roles@>array['manufacturer']
  ) then raise exception 'Для нового поступления выберите действующий завод-производитель'; end if;
  return new;
end$$;
revoke all on function private.validate_import_factory() from public,anon,authenticated,service_role;
drop trigger if exists validate_import_factory on public.shipments;
create trigger validate_import_factory before insert or update of type,supplier_id on public.shipments for each row execute function private.validate_import_factory();

alter table public.product_suppliers enable row level security;
grant select,insert,update on public.product_suppliers to authenticated;
drop policy if exists "employees view product suppliers" on public.product_suppliers;
create policy "employees view product suppliers" on public.product_suppliers for select to authenticated using (
  (select private.has_permission('products.view')) or (select private.has_permission('suppliers.view'))
);
drop policy if exists "employees create product suppliers" on public.product_suppliers;
create policy "employees create product suppliers" on public.product_suppliers for insert to authenticated with check (
  (select private.has_permission('products.create')) or (select private.has_permission('products.update'))
);
drop policy if exists "employees update product suppliers" on public.product_suppliers;
create policy "employees update product suppliers" on public.product_suppliers for update to authenticated using (
  (select private.has_permission('products.update'))
) with check ((select private.has_permission('products.update')));

drop trigger if exists audit_product_suppliers_changes on public.product_suppliers;
create trigger audit_product_suppliers_changes after insert or update on public.product_suppliers for each row execute function private.write_access_audit();

-- Purchase planning now uses the supplier assortment rather than manufacturer_id.
create or replace function public.upsert_purchase_plan_line(p_plan_id uuid,p_product_id uuid,p_stock_on_hand numeric,p_stock_in_transit numeric,p_stock_reserved numeric,p_safety_stock numeric,p_expiring_before_sale numeric,p_suggested_quantity numeric,p_rounding_uom text,p_pack_multiple numeric,p_approved_quantity numeric,p_planned_order_date date default null,p_comment text default null) returns uuid language plpgsql security definer set search_path='' as $$declare p public.purchase_plans;v_demand numeric;v_id uuid;begin
 if not private.has_permission('purchase_plans.update') then raise exception 'Нет права изменять план закупок';end if;p:=private.lock_purchase_plan(p_plan_id);if p.status<>'draft' then raise exception 'Изменять можно только черновик';end if;
 if not exists(select 1 from public.products x join public.product_suppliers ps on ps.product_id=x.id and ps.supplier_id=p.supplier_id and ps.status='active' where x.id=p_product_id and x.status='active') then raise exception 'Товар не входит в ассортимент выбранного поставщика';end if;
 select coalesce(sum(final_quantity),0) into v_demand from public.forecast_lines where forecast_id=p.forecast_id and product_id=p_product_id;
 p_stock_on_hand:=coalesce(p_stock_on_hand,0);p_stock_in_transit:=coalesce(p_stock_in_transit,0);p_stock_reserved:=coalesce(p_stock_reserved,0);p_safety_stock:=coalesce(p_safety_stock,0);p_expiring_before_sale:=coalesce(p_expiring_before_sale,0);
 if least(p_stock_on_hand,p_stock_in_transit,p_stock_reserved,p_safety_stock,p_expiring_before_sale,p_suggested_quantity)<0 or p_stock_reserved>p_stock_on_hand or p_pack_multiple<=0 or p_approved_quantity<=0 or p_rounding_uom not in ('piece','box','layer','pallet','truck') then raise exception 'Проверьте количества и кратность';end if;
 if mod(p_approved_quantity,p_pack_multiple)<>0 then raise exception 'Утверждаемое количество должно быть кратно упаковке';end if;
 select id into v_id from public.purchase_plan_lines where purchase_plan_id=p_plan_id and product_id=p_product_id for update;
 if found then update public.purchase_plan_lines set forecast_demand=v_demand,stock_on_hand=p_stock_on_hand,stock_in_transit=p_stock_in_transit,stock_reserved=p_stock_reserved,safety_stock=p_safety_stock,expiring_before_sale=p_expiring_before_sale,suggested_quantity=p_suggested_quantity,rounding_uom=p_rounding_uom,pack_multiple=p_pack_multiple,approved_quantity=p_approved_quantity,planned_order_date=p_planned_order_date,comment=nullif(btrim(p_comment),''),updated_at=now() where id=v_id;
 else insert into public.purchase_plan_lines(purchase_plan_id,product_id,forecast_demand,stock_on_hand,stock_in_transit,stock_reserved,safety_stock,expiring_before_sale,suggested_quantity,rounding_uom,pack_multiple,approved_quantity,planned_order_date,comment) values(p_plan_id,p_product_id,v_demand,p_stock_on_hand,p_stock_in_transit,p_stock_reserved,p_safety_stock,p_expiring_before_sale,p_suggested_quantity,p_rounding_uom,p_pack_multiple,p_approved_quantity,p_planned_order_date,nullif(btrim(p_comment),'')) returning id into v_id;end if;return v_id;
end$$;

comment on table public.product_suppliers is 'Explicit supplier assortment; inactive rows preserve history';
