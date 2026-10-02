begin;

insert into public.counterparties(id,legal_name,short_name,roles,country) values
('c9000000-0000-4000-8000-000000000001','Factory Alpha','Factory A',array['manufacturer','supplier'],'FI'),
('c9000000-0000-4000-8000-000000000002','Factory Beta','Factory B',array['manufacturer','supplier'],'SE'),
('c9000000-0000-4000-8000-000000000003','Historical Distributor','Distributor',array['supplier'],'KZ');

insert into public.products(id,internal_sku,name,manufacturer_id,category,status)
values('c9100000-0000-4000-8000-000000000001','CATALOG-TEST-1','{"ru":"Тестовый товар"}',
       'c9000000-0000-4000-8000-000000000001','Прочее','active');

do $$
begin
  if not exists(
    select 1 from public.product_suppliers
    where product_id='c9100000-0000-4000-8000-000000000001'
      and supplier_id='c9000000-0000-4000-8000-000000000001'
      and status='active' and is_primary
  ) then raise exception 'product insert did not create the factory assortment link'; end if;

  begin
    update public.product_suppliers set status='inactive',is_primary=false
    where product_id='c9100000-0000-4000-8000-000000000001';
    insert into public.product_suppliers(product_id,supplier_id,status,is_primary)
    values('c9100000-0000-4000-8000-000000000001','c9000000-0000-4000-8000-000000000002','active',true);
    raise exception 'a different factory was accepted for the product';
  exception when others then
    if sqlerrm='a different factory was accepted for the product' then raise; end if;
    if position('совпадать с его заводом-производителем' in sqlerrm)=0 then raise; end if;
  end;

  begin
    insert into public.products(id,internal_sku,name,manufacturer_id,category,status)
    values('c9100000-0000-4000-8000-000000000002','CATALOG-TEST-2','{"ru":"Ошибочный товар"}',
           'c9000000-0000-4000-8000-000000000003','Прочее','active');
    raise exception 'a distributor was accepted as an active factory';
  exception when others then
    if sqlerrm='a distributor was accepted as an active factory' then raise; end if;
    if position('только действующий завод-производитель' in sqlerrm)=0 then raise; end if;
  end;
end$$;

rollback;
