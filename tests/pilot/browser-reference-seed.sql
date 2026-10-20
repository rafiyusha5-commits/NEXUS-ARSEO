-- Reference data only. No shipment/order/stock/document state is seeded.
insert into public.counterparties(roles,legal_name,country,tax_id,min_remaining_shelf_life_pct)
 values(array['manufacturer','supplier'],'Synthetic Browser Factory','FI','BROWSER-FACTORY',null),
 (array['customer'],'Synthetic Browser Buyer','KZ','BROWSER-BUYER',0);
insert into public.warehouses(code,name,city,country) values
 ('BROWSER-A','{"ru":"Учебный склад A"}','Synthetic','KZ'),
 ('BROWSER-B','{"ru":"Учебный склад B"}','Synthetic','KZ');
insert into public.routes(name,origin_country,destination_country)
 values('{"ru":"Учебный маршрут","en":"Browser Route"}','FI','KZ');
insert into public.products(internal_sku,name,manufacturer_id,status,shelf_life_days)
 select sku,jsonb_build_object('ru',title),c.id,'active',400 from public.counterparties c
 cross join (values('BROWSER-A','Учебный товар Альфа'),('BROWSER-B','Учебный товар Бета')) p(sku,title)
 where c.tax_id='BROWSER-FACTORY';
insert into public.product_packaging(product_id,uom,units_per_parent,gross_weight_kg,net_weight_kg)
 select id,'piece',1,1,0.9 from public.products where internal_sku in('BROWSER-A','BROWSER-B');
insert into public.product_packaging(product_id,uom,units_per_parent)
 select id,'box',10 from public.products where internal_sku='BROWSER-A';
insert into public.document_requirements(document_type_id,applies_to,shipment_type,is_mandatory,route_id)
 select dt.id,'shipment_transport','import',true,r.id from public.document_types dt cross join public.routes r
 where dt.code='cmr' and r.name->>'en'='Browser Route';
