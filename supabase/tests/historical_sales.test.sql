\set ON_ERROR_STOP 1
begin;
set local timezone='UTC';
\ir fixtures/historical_sales.sql
do $$begin
 assert not has_function_privilege('anon','public.create_historical_customer_order(uuid,uuid,uuid,uuid,date,uuid,text,text,text)','execute');
 assert not has_function_privilege('service_role','public.create_historical_customer_order(uuid,uuid,uuid,uuid,date,uuid,text,text,text)','execute');
 assert not has_function_privilege('authenticated','private.sale_effective_date(uuid)','execute');
 assert not has_table_privilege('authenticated','public.sales','update');
end$$;
set local role authenticated;
select set_config('request.jwt.claim.sub','af010000-0000-4000-8000-000000000002',true);
do $$begin assert not public.can_record_historical_sale(),'Director must not backdate';end$$;
select pg_temp.historical_reject('select pg_temp.historical_create()','только администратор');
select set_config('request.jwt.claim.sub','af010000-0000-4000-8000-000000000001',true);
do $$begin assert public.can_record_historical_sale();end$$;
select pg_temp.historical_reject($q$select pg_temp.historical_create(reason=>' ')$q$,'основание');
select pg_temp.historical_reject($q$select public.create_customer_order('af110000-0000-4000-8000-000000000002',null,'af210000-0000-4000-8000-000000000001',(select d from tests.historical_context where k='day'),null,null)$q$,'прошлом');
insert into tests.historical_context values ('sale',pg_temp.historical_create(),null);
do $$begin assert pg_temp.historical_create()=(select id from tests.historical_context where k='sale'),'Retry must return same order';end$$;
select pg_temp.historical_reject($q$select pg_temp.historical_create(reason=>'Другой запрос')$q$,'другие данные');
select pg_temp.historical_reject($q$select pg_temp.historical_create('af610000-0000-4000-8000-000000000002',' inv-hist-01 ')$q$,'уже существует');
insert into tests.historical_context select 'item',public.add_customer_order_item(id,'af310000-0000-4000-8000-000000000001',10,'piece',10,80),null from tests.historical_context where k='sale';
select public.reserve_customer_order_item_fefo(id) from tests.historical_context where k='item';
do $$begin
 assert (select count(*)=1 and min(batch_id::text)='af410000-0000-4000-8000-000000000001' and min(remaining_shelf_life_pct)=82.5 from public.inventory_reservations where sale_item_id=(select id from tests.historical_context where k='item') and status='active'),'FEFO uses historical date and skips later receipts';
end$$;
select pg_temp.historical_reject($q$select public.reserve_customer_order_item_override((select id from tests.historical_context where k='item'),'af510000-0000-4000-8000-000000000003','ручной выбор')$q$,'позже исторической');
select public.confirm_customer_order(id) from tests.historical_context where k='sale';
do $$begin assert not exists(select 1 from public.customer_order_shipping_blockers((select id from tests.historical_context where k='sale'))),'Preview must agree with fulfillment';end$$;
reset role;

-- Role expiry, disabled role/employee and personal denials are enforced after creation as well.
savepoint denied;
update public.profiles set is_active=false where id='af010000-0000-4000-8000-000000000001';
set local role authenticated;
do $$begin assert not public.can_record_historical_sale();end$$;
select pg_temp.historical_reject('select pg_temp.historical_create()','администратор');
rollback to denied;
savepoint denied;
update public.user_roles set expires_at=clock_timestamp()-interval '1 second' where user_id='af010000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.historical_reject('select public.fulfill_customer_order((select id from tests.historical_context where k=''sale''))','прав|администратор');
rollback to denied;
savepoint denied;
update public.app_roles set is_enabled=false where code='administrator';
set local role authenticated;
do $$begin assert not public.can_record_historical_sale();end$$;
select pg_temp.historical_reject('select pg_temp.historical_create()','администратор');
rollback to denied;
savepoint denied;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'af010000-0000-4000-8000-000000000001',id,'deny','test','af010000-0000-4000-8000-000000000001' from public.permissions where code='sales.view';
set local role authenticated;
select pg_temp.historical_reject('select pg_temp.historical_create()','администратор');
select pg_temp.historical_reject('select public.fulfill_customer_order((select id from tests.historical_context where k=''sale''))','прав|администратор');
rollback to denied;
savepoint denied;
set local role authenticated;
select set_config('request.jwt.claim.sub','af010000-0000-4000-8000-000000000002',true);
select pg_temp.historical_reject('select public.fulfill_customer_order((select id from tests.historical_context where k=''sale''))','администратор');
select pg_temp.historical_reject($q$select public.cancel_customer_order((select id from tests.historical_context where k='sale'),'test')$q$,'администратор');
select pg_temp.historical_reject($q$select public.return_customer_order_to_preparation((select id from tests.historical_context where k='sale'),'test')$q$,'администратор');
rollback to denied;

-- A present/future date and a missing request id cannot enter the historical path.
savepoint invalid_date;
update tests.historical_context set d=private.business_today() where k='day';
set local role authenticated;
select pg_temp.historical_reject($q$select pg_temp.historical_create('af610000-0000-4000-8000-000000000003','TODAY')$q$,'прошедшую');
rollback to invalid_date;
savepoint invalid_date;
update tests.historical_context set d=private.business_today()+1 where k='day';
set local role authenticated;
select pg_temp.historical_reject($q$select pg_temp.historical_create('af610000-0000-4000-8000-000000000003','FUTURE')$q$,'прошедшую');
select pg_temp.historical_reject($q$select pg_temp.historical_create(null,'NO-ID')$q$,'прошедшую');
rollback to invalid_date;

-- Historical date is not a license to ship blocked/expired/low-OSG stock or ignore shortages.
savepoint bad;
update public.inventory_batches set status='blocked' where id='af410000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.historical_reject('select public.fulfill_customer_order((select id from tests.historical_context where k=''sale''))','заблокирована');
rollback to bad;
savepoint bad;
update public.inventory_batches set expiry_date=private.business_today()-31 where id='af410000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.historical_reject('select public.fulfill_customer_order((select id from tests.historical_context where k=''sale''))','просрочена');
rollback to bad;
savepoint bad;
update public.sale_items set required_shelf_life_pct=90 where sale_id=(select id from tests.historical_context where k='sale');
set local role authenticated;
select pg_temp.historical_reject('select public.fulfill_customer_order((select id from tests.historical_context where k=''sale''))','гарантийн');
rollback to bad;
savepoint bad;
update public.inventory_balances set quantity_on_hand=9,quantity_reserved=9 where id='af510000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.historical_reject('select public.fulfill_customer_order((select id from tests.historical_context where k=''sale''))','остат|согласован|Недостаточно');
rollback to bad;
select pg_temp.historical_reject($q$update public.sales set historical_shipment_date=historical_shipment_date-1 where id=(select id from tests.historical_context where k='sale')$q$,'неизменно');
select pg_temp.historical_reject($q$update public.sales set planned_shipment_date=planned_shipment_date+1 where id=(select id from tests.historical_context where k='sale')$q$,'исторической продажи');
set local role authenticated;
select public.fulfill_customer_order(id) from tests.historical_context where k='sale';
select public.fulfill_customer_order(id) from tests.historical_context where k='sale';
reset role;
do $$declare s public.sales;begin
 select * into s from public.sales where id=(select id from tests.historical_context where k='sale');
 assert s.status='shipped' and private.business_date(s.shipped_at)=s.historical_shipment_date;
 assert s.shipped_recorded_at>=transaction_timestamp() and s.created_at>=transaction_timestamp();
 assert s.shipped_by='af010000-0000-4000-8000-000000000001' and s.created_by=s.shipped_by;
 assert exists(select 1 from public.audit_log where entity_type='sales' and entity_id=s.id::text
  and actor_user_id=s.created_by and after_data->>'historical_reason'=s.historical_reason and created_at>=transaction_timestamp()),'Reason and recording actor remain in audit history';
 assert exists(select 1 from private.customer_ledger(s.customer_id) where kind='shipment' and ref_id=s.id
  and entry_date=s.historical_shipment_date and due_date=s.historical_shipment_date and amount=100),'Receivables use the actual dispatch date';
 assert (select count(*)=1 and sum(quantity)=10 and min(created_at)>=transaction_timestamp() from public.inventory_movements where sale_id=s.id and movement_type='issue');
 assert (select quantity_on_hand=90 and quantity_reserved=0 from public.inventory_balances where id='af510000-0000-4000-8000-000000000001');
 assert not exists(select 1 from public.inventory_reservations where sale_item_id=(select id from tests.historical_context where k='item') and status='active');
end$$;
set local role authenticated;
select set_config('request.jwt.claim.sub','af010000-0000-4000-8000-000000000002',true);
select pg_temp.historical_reject('select public.fulfill_customer_order((select id from tests.historical_context where k=''sale''))','администратор');
rollback;
