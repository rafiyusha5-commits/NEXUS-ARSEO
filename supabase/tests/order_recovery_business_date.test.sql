\set ON_ERROR_STOP 1
begin;
\ir fixtures/order_fulfillment.sql

create function pg_temp.expect_failure(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql; exception when others then
  if sqlerrm !~ p_pattern and sqlstate<>p_pattern then raise exception 'Unexpected failure: % (%)',sqlerrm,sqlstate;end if;
  return;
 end;
 raise exception 'Expected failure: %',p_sql;
end $$;
do $$begin
 assert private.business_date('2026-10-13 18:59:59+00')='2026-10-13'::date;
 assert private.business_date('2026-10-13 19:00:00+00')='2026-10-14'::date;
 assert private.business_date('2026-12-31 19:00:00+00')='2027-01-01'::date;
 assert not has_function_privilege('authenticated','private.business_today()','EXECUTE');
 assert not has_function_privilege('service_role','public.return_customer_order_to_preparation(uuid,text)','EXECUTE');
end$$;
create temporary table recovery_before as select id,sale_number,customer_id from public.sales;
grant select on recovery_before to authenticated;

-- A personal deny overrides the director role and leaves the order and its letters untouched.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'ef000000-0000-4000-8000-000000000001',id,'deny','Recovery regression','ef000000-0000-4000-8000-000000000001'
from public.permissions where code='sales.view';
set role authenticated;
select pg_temp.expect_failure($q$select public.return_customer_order_to_preparation(id,'Blocked batch') from tests.fulfillment_context where k='sale'$q$,'42501');
reset role;
do $$begin
 assert not exists(select 1 from public.sale_preparation_returns);
 assert (select status='confirmed' from public.sales where id=(select id from tests.fulfillment_context where k='sale'));
 assert (select status='approved' from public.guarantee_letters where id=(select id from tests.fulfillment_context where k='letter'));
end$$;
delete from public.user_permission_overrides where user_id='ef000000-0000-4000-8000-000000000001';

-- Blocked stock cannot ship or be excused by a letter; the same order can be recovered and re-reserved.
update public.inventory_batches set status='blocked' where id='ef400000-0000-4000-8000-000000000001';
set role authenticated;
select pg_temp.expect_failure($q$select public.fulfill_customer_order(id) from tests.fulfillment_context where k='sale'$q$,'заблокирована');
select pg_temp.expect_failure($q$select public.return_customer_order_to_preparation(id,'  ') from tests.fulfillment_context where k='sale'$q$,'причину');
select public.return_customer_order_to_preparation(id,'Партия заблокирована') from tests.fulfillment_context where k='sale';
select pg_temp.expect_failure($q$select public.confirm_customer_order(id) from tests.fulfillment_context where k='sale'$q$,'замените резерв');
select pg_temp.expect_failure($q$select public.change_sale_guarantee_status(id,'approved') from tests.fulfillment_context where k='letter'$q$,'завершено');
select public.reserve_customer_order_item_fefo(id) from tests.fulfillment_context where k='item';
select public.confirm_customer_order(id) from tests.fulfillment_context where k='sale';
select public.fulfill_customer_order(id) from tests.fulfillment_context where k='sale';
select pg_temp.expect_failure($q$select public.return_customer_order_to_preparation(id,'Already shipped') from tests.fulfillment_context where k='sale'$q$,'неотгруженный');
reset role;
do $$begin
 assert (select status='cancelled' from public.guarantee_letters where id=(select id from tests.fulfillment_context where k='letter'));
 assert exists(select 1 from public.guarantee_letter_items where guarantee_letter_id=(select id from tests.fulfillment_context where k='letter')),'Old letter rows remain';
 assert (select count(*)=1 from public.sale_preparation_returns);
 assert not exists(select 1 from public.sales s join recovery_before b on b.id=s.id where s.sale_number<>b.sale_number or s.customer_id<>b.customer_id);
 assert (select quantity=150 from public.sale_items where id=(select id from tests.fulfillment_context where k='item'));
 assert (select count(*)=1 from public.inventory_movements where sale_id=(select id from tests.fulfillment_context where k='sale') and movement_type='issue');
end$$;

-- A delayed confirmed order needs a new letter for the actual remaining shelf life.
create or replace function private.business_today() returns date language sql stable set search_path='' as $$select date '2099-11-01'$$;
set role authenticated;
select pg_temp.expect_failure($q$select public.fulfill_customer_order(id) from tests.fulfillment_context where k='other'$q$,'гарантийного письма');
select public.return_customer_order_to_preparation(id,'Отгрузка задержалась') from tests.fulfillment_context where k='other';
insert into tests.fulfillment_context select 'delayed-letter',public.create_sale_guarantee_letter(id,'На фактическую дату') from tests.fulfillment_context where k='other';
select public.change_sale_guarantee_status(id,'approved') from tests.fulfillment_context where k='delayed-letter';
select public.confirm_customer_order(id) from tests.fulfillment_context where k='other';

-- Expiry checks use the business date even while UTC is still the previous day.
reset role;
create or replace function private.business_today() returns date language sql stable set search_path='' as $$select date '2099-12-07'$$;
set role authenticated;
select pg_temp.expect_failure($q$select public.fulfill_customer_order(id) from tests.fulfillment_context where k='other'$q$,'просрочена');
reset role;
create or replace function private.business_today() returns date language sql stable set search_path='' as $$select date '2099-11-01'$$;
set role authenticated;
select public.fulfill_customer_order(id) from tests.fulfillment_context where k='other';
reset role;
do $$begin
 assert not exists(select 1 from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id where i.sale_id in(select id from tests.fulfillment_context where k in ('sale','other')) and r.status='active');
 assert (select count(*)=2 from public.sale_preparation_returns);
 assert (select max(remaining_shelf_life_pct)<60 from public.guarantee_letter_items where guarantee_letter_id=(select id from tests.fulfillment_context where k='delayed-letter'));
end$$;
rollback;
