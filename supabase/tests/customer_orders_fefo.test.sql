-- Customer order FEFO allocation, shelf-life gate, guarantee and cancellation.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('f5000000-0000-4000-8000-000000000001','fefo-director@test.local','{"full_name":"FEFO Director"}');
insert into public.user_roles(user_id,role_id)
select 'f5000000-0000-4000-8000-000000000001',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id,min_remaining_shelf_life_pct) values
 ('f5100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'FEFO Supplier','FI','FEFO-SUP',null),
 ('f5100000-0000-4000-8000-000000000002',array['customer'],'FEFO Customer','KZ','FEFO-CUS',60);
insert into public.products(id,internal_sku,name,manufacturer_id,status,shelf_life_days) values
 ('f5200000-0000-4000-8000-000000000001','FEFO-001','{"ru":"Товар FEFO"}','f5100000-0000-4000-8000-000000000001','active',400);

create temporary table fefo_context(sale_id uuid,item_id uuid,warehouse_id uuid,balance_early uuid,balance_late uuid,letter_id uuid);
grant select,insert,update on fefo_context to authenticated;
insert into fefo_context(warehouse_id)
select id from public.warehouses where status='active' and not is_virtual order by code limit 1;
insert into public.inventory_batches(id,product_id,batch_number,manufacture_date,expiry_date,created_by) values
 ('f5300000-0000-4000-8000-000000000001','f5200000-0000-4000-8000-000000000001','FEFO-EARLY',current_date-300,current_date+100,'f5000000-0000-4000-8000-000000000001'),
 ('f5300000-0000-4000-8000-000000000002','f5200000-0000-4000-8000-000000000001','FEFO-LATE',current_date-100,current_date+300,'f5000000-0000-4000-8000-000000000001');
insert into public.inventory_balances(id,batch_id,warehouse_id,uom,quantity_on_hand)
select 'f5400000-0000-4000-8000-000000000001','f5300000-0000-4000-8000-000000000001',warehouse_id,'piece',100 from fefo_context;
insert into public.inventory_balances(id,batch_id,warehouse_id,uom,quantity_on_hand)
select 'f5400000-0000-4000-8000-000000000002','f5300000-0000-4000-8000-000000000002',warehouse_id,'piece',200 from fefo_context;
update fefo_context set balance_early='f5400000-0000-4000-8000-000000000001',balance_late='f5400000-0000-4000-8000-000000000002';

set role authenticated;
select set_config('request.jwt.claim.sub','f5000000-0000-4000-8000-000000000001',false);
update fefo_context set sale_id=public.create_customer_order(
 'f5100000-0000-4000-8000-000000000002',null,warehouse_id,current_date+10,
 (select id from public.currencies where code='KZT'),null);
update fefo_context set item_id=public.add_customer_order_item(sale_id,'f5200000-0000-4000-8000-000000000001',150,'piece',null,null);
select public.reserve_customer_order_item_fefo(item_id) from fefo_context;

do $$ declare c fefo_context%rowtype;
begin
 select * into c from fefo_context;
 assert (select quantity_reserved=100 from public.inventory_balances where id=c.balance_early),'FEFO reserves all of the earliest batch';
 assert (select quantity_reserved=50 from public.inventory_balances where id=c.balance_late),'FEFO continues with the next batch';
 assert (select status='reserved' from public.sales where id=c.sale_id),'fully allocated order becomes reserved';
 assert (select count(*)=2 from public.inventory_reservations where sale_item_id=c.item_id and status='active'),'split reservation has two rows';
 begin
  perform public.confirm_customer_order(c.sale_id);
  raise exception 'low shelf-life order confirmed without guarantee' using errcode='P0099';
 exception when sqlstate 'P0099' then raise; when others then assert position('гарантийное письмо' in sqlerrm)>0,'confirmation is blocked by shelf-life requirement'; end;
end $$;

update fefo_context set letter_id=public.create_sale_guarantee_letter(sale_id,'FEFO test') returning letter_id;
select public.change_sale_guarantee_status(letter_id,'approved') from fefo_context;
do $$ begin
 begin
  perform public.reserve_customer_order_item_fefo((select item_id from fefo_context));
  raise exception 'reservation changed after guarantee approval' using errcode='P0099';
 exception when sqlstate 'P0099' then raise; when others then assert position('утверждения гарантийного письма' in sqlerrm)>0,'approved guarantee freezes reservation batches'; end;
end $$;
select public.confirm_customer_order(sale_id) from fefo_context;
do $$ begin
 assert (select status='confirmed' from public.sales where id=(select sale_id from fefo_context)),'approved guarantee allows confirmation';
 assert (select count(*)=1 from public.guarantee_letter_items where guarantee_letter_id=(select letter_id from fefo_context)),'guarantee snapshots only the below-requirement batch';
end $$;

select public.cancel_customer_order(sale_id,'Тест отмены') from fefo_context;
do $$ begin
 assert (select status='cancelled' from public.sales where id=(select sale_id from fefo_context)),'order is cancelled';
 assert (select sum(quantity_reserved)=0 from public.inventory_balances where id in ((select balance_early from fefo_context),(select balance_late from fefo_context))),'cancellation releases every reservation';
 assert not exists(select 1 from public.inventory_reservations where sale_item_id=(select item_id from fefo_context) and status='active'),'reservation rows are cancelled';
end $$;

reset role;
rollback;
