begin;

insert into public.counterparties(id,legal_name,short_name,roles,country,status) values
('fa440000-0000-4000-8000-000000000001','Fazer Confectionary Ltd','Fazer',array['manufacturer','supplier'],'FI','active'),
('fa440000-0000-4000-8000-000000000002','Froosh AB','Froosh AB',array['manufacturer','supplier'],'SE','active');

insert into public.products(id,internal_sku,name,manufacturer_id,brand,category,status)
values('fa440000-0000-4000-8000-000000000010','FROOSH-TEST','{"ru":"Смузи Froosh"}',
       'fa440000-0000-4000-8000-000000000002','Froosh','Напитки','draft');

insert into public.product_identifiers(product_id,identifier_type,value,counterparty_id,is_primary)
values('fa440000-0000-4000-8000-000000000010','supplier_sku','FROOSH-SKU',
       'fa440000-0000-4000-8000-000000000002',true);

\ir ../migrations/202609274400_froosh_fazer_supplier_cleanup.sql

do $$
begin
  if not exists(
    select 1 from public.products
    where id='fa440000-0000-4000-8000-000000000010'
      and manufacturer_id='fa440000-0000-4000-8000-000000000001'
  ) then raise exception 'Froosh product was not moved to Fazer'; end if;

  if not exists(
    select 1 from public.product_identifiers
    where product_id='fa440000-0000-4000-8000-000000000010'
      and identifier_type='supplier_sku'
      and counterparty_id='fa440000-0000-4000-8000-000000000001'
  ) then raise exception 'Froosh supplier article was not moved to Fazer'; end if;

  if not exists(
    select 1 from public.product_suppliers
    where product_id='fa440000-0000-4000-8000-000000000010'
      and supplier_id='fa440000-0000-4000-8000-000000000001'
      and status='active' and is_primary
  ) then raise exception 'Fazer did not become the active product supplier'; end if;

  if not exists(
    select 1 from public.product_suppliers
    where product_id='fa440000-0000-4000-8000-000000000010'
      and supplier_id='fa440000-0000-4000-8000-000000000002'
      and status='inactive' and not is_primary
  ) then raise exception 'Historical Froosh supplier link was not preserved'; end if;

  if not exists(
    select 1 from public.counterparties
    where id='fa440000-0000-4000-8000-000000000002'
      and status='archived' and archived_at is not null
  ) then raise exception 'Former Froosh counterparty is still available for new operations'; end if;
end $$;

-- A second run must be harmless.
\ir ../migrations/202609274400_froosh_fazer_supplier_cleanup.sql

rollback;
