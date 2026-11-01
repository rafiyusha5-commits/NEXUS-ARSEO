-- Synthetic, disposable database only; caller owns the transaction.
create schema if not exists tests;
create table tests.historical_context(k text primary key,id uuid,d date);
grant usage on schema tests to authenticated;
grant all on tests.historical_context to authenticated;
insert into auth.users(id,email,raw_user_meta_data) values
 ('af010000-0000-4000-8000-000000000001','historical-admin@example.invalid','{"full_name":"Historical admin"}'),
 ('af010000-0000-4000-8000-000000000002','historical-director@example.invalid','{"full_name":"Historical director"}');
insert into public.user_roles(user_id,role_id)
 select 'af010000-0000-4000-8000-000000000001',id from public.app_roles where code='administrator';
insert into public.user_roles(user_id,role_id)
 select 'af010000-0000-4000-8000-000000000002',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id,min_remaining_shelf_life_pct) values
 ('af110000-0000-4000-8000-000000000001',array['supplier','manufacturer'],'Historical synthetic factory','FI','HIST-FACTORY',null),
 ('af110000-0000-4000-8000-000000000002',array['customer'],'Historical synthetic buyer','KZ','HIST-BUYER',80);
insert into public.warehouses(id,code,name,city,country) values
 ('af210000-0000-4000-8000-000000000001','HIST-TEST','{"ru":"Тестовый склад"}','Synthetic','KZ');
insert into public.products(id,internal_sku,name,manufacturer_id,shelf_life_days) values
 ('af310000-0000-4000-8000-000000000001','HIST-P','{"ru":"Тестовый товар"}','af110000-0000-4000-8000-000000000001',400);
insert into public.inventory_batches(id,product_id,batch_number,manufacture_date,expiry_date,received_at,created_by) values
 ('af410000-0000-4000-8000-000000000001','af310000-0000-4000-8000-000000000001','HIST-OLD',private.business_today()-100,private.business_today()+300,(private.business_today()-60)::timestamp at time zone 'Asia/Almaty','af010000-0000-4000-8000-000000000001'),
 ('af410000-0000-4000-8000-000000000002','af310000-0000-4000-8000-000000000001','HIST-LATE-RECEIPT',private.business_today()-101,private.business_today()+299,(private.business_today()-10)::timestamp at time zone 'Asia/Almaty','af010000-0000-4000-8000-000000000001');
insert into public.inventory_balances(id,batch_id,warehouse_id,uom,quantity_on_hand) values
 ('af510000-0000-4000-8000-000000000001','af410000-0000-4000-8000-000000000001','af210000-0000-4000-8000-000000000001','piece',100),
 ('af510000-0000-4000-8000-000000000002','af410000-0000-4000-8000-000000000001','af210000-0000-4000-8000-000000000001','box',10),
 ('af510000-0000-4000-8000-000000000003','af410000-0000-4000-8000-000000000002','af210000-0000-4000-8000-000000000001','piece',100);
insert into tests.historical_context values ('day',null,private.business_today()-30);
insert into tests.historical_context select 'currency',id,null from public.currencies where code='EUR';
create function pg_temp.historical_create(req uuid default 'af610000-0000-4000-8000-000000000001',ref text default 'INV-HIST-01',reason text default 'Загрузка состоявшейся отгрузки') returns uuid
language sql as $$select public.create_historical_customer_order(req,'af110000-0000-4000-8000-000000000002',null,'af210000-0000-4000-8000-000000000001',
 (select d from tests.historical_context where k='day'),(select id from tests.historical_context where k='currency'),ref,reason,null)$$;
create function pg_temp.historical_reject(sql_text text,pattern text) returns void language plpgsql as $$begin
 begin execute sql_text;exception when others then assert sqlerrm ~* pattern,sqlerrm;return;end;
 raise exception 'Expected rejection: %',sql_text;
end$$;
