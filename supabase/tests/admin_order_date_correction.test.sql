\set ON_ERROR_STOP 1
begin;
\ir fixtures/historical_sales.sql
insert into auth.users(id,email,raw_user_meta_data) values
 ('ad010000-0000-4000-8000-000000000003','date-second-admin@example.invalid','{"full_name":"Second test admin"}');
insert into public.user_roles(user_id,role_id)
 select 'ad010000-0000-4000-8000-000000000003',id from public.app_roles where code='administrator';
set local role authenticated;
select set_config('request.jwt.claim.sub','af010000-0000-4000-8000-000000000001',true);
insert into tests.historical_context select 'sale',public.create_customer_order(
 'af110000-0000-4000-8000-000000000002',null,'af210000-0000-4000-8000-000000000001',
 current_date+1,(select id from tests.historical_context where k='currency'),null),null;
insert into tests.historical_context select 'item',public.add_customer_order_item(id,
 'af310000-0000-4000-8000-000000000001',10,'piece',10,0,'Синтетическая цена теста'),null from tests.historical_context where k='sale';
reset role;
-- A pre-existing ordinary draft, created five days ago, with a mistaken planned date.
update public.sales set sale_date=private.business_today()-5,planned_shipment_date=private.business_today()-1
 where id=(select id from tests.historical_context where k='sale');
insert into tests.historical_context values ('old-date',null,private.business_today()-1),('new-date',null,private.business_today()-5),('today',null,private.business_today());
create function pg_temp.correct_date(req uuid default 'ad610000-0000-4000-8000-000000000001',reason text default 'Дата по документу INV-TEST, исправление плановой даты') returns uuid
language sql as $$ select public.correct_customer_order_date((select id from tests.historical_context where k='sale'),req,
 (select d from tests.historical_context where k='old-date'),(select d from tests.historical_context where k='new-date'),reason) $$;
create function pg_temp.date_snapshot() returns jsonb language sql as $$
 select jsonb_build_object('sales',(select jsonb_agg(to_jsonb(s) order by id) from public.sales s),
 'items',(select jsonb_agg(to_jsonb(i) order by id) from public.sale_items i),
 'reserves',(select jsonb_agg(to_jsonb(r) order by id) from public.inventory_reservations r),
 'movements',(select jsonb_agg(to_jsonb(m) order by id) from public.inventory_movements m),
 'balances',(select jsonb_agg(to_jsonb(b) order by id) from public.inventory_balances b),
 'history',(select jsonb_agg(to_jsonb(h) order by id) from public.sale_shipment_date_changes h),
 'documents',(select jsonb_agg(to_jsonb(d) order by id) from public.documents d))
$$;
create temp table date_baseline as select pg_temp.date_snapshot() snapshot;
grant select on date_baseline to authenticated;
do $$begin
 assert not has_function_privilege('anon','public.correct_customer_order_date(uuid,uuid,date,date,text)','execute');
 assert not has_function_privilege('service_role','public.correct_customer_order_date(uuid,uuid,date,date,text)','execute');
 assert not has_function_privilege('authenticated','private.can_correct_customer_order_date()','execute');
 assert not has_table_privilege('authenticated','public.sale_shipment_date_changes','insert,update,delete');
end$$;
set local role authenticated;
select set_config('request.jwt.claim.sub','af010000-0000-4000-8000-000000000002',true);
do $$begin assert not public.can_correct_customer_order_date();end$$;
select pg_temp.historical_reject('select pg_temp.correct_date()','администратор');
select set_config('request.jwt.claim.sub','',true);
select pg_temp.historical_reject('select pg_temp.correct_date()','администратор');
select set_config('request.jwt.claim.sub','af010000-0000-4000-8000-000000000001',true);
select pg_temp.historical_reject($q$select pg_temp.correct_date(reason=>' ')$q$,'причину');
select pg_temp.historical_reject($q$select pg_temp.correct_date(reason=>repeat('x',1001))$q$,'причину');
select pg_temp.historical_reject($q$select pg_temp.correct_date(req=>null)$q$,'Обновите');
-- The ordinary path is still unavailable for past dates, including to administrators.
select pg_temp.historical_reject($q$select public.reschedule_customer_order((select id from tests.historical_context where k='sale'),(select d from tests.historical_context where k='new-date'),'test')$q$,'прошлом');
reset role;
do $$declare permission_code text;begin
 foreach permission_code in array array['sales.view','sales.manage'] loop
  insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
   select 'af010000-0000-4000-8000-000000000001',id,'deny','test','af010000-0000-4000-8000-000000000001' from public.permissions where code=permission_code;
  assert not public.can_correct_customer_order_date();
  perform pg_temp.historical_reject('select pg_temp.correct_date()','прав|администратор');
  delete from public.user_permission_overrides where user_id='af010000-0000-4000-8000-000000000001';
 end loop;
end$$;
savepoint disabled;
update public.profiles set is_active=false where id='af010000-0000-4000-8000-000000000001';
select pg_temp.historical_reject('select pg_temp.correct_date()','прав|администратор');
rollback to disabled;
savepoint disabled;
update public.user_roles set expires_at=clock_timestamp()-interval '1 second' where user_id='af010000-0000-4000-8000-000000000001';
select pg_temp.historical_reject('select pg_temp.correct_date()','прав|администратор');
rollback to disabled;
savepoint disabled;
update public.app_roles set is_enabled=false where code='administrator';
select pg_temp.historical_reject('select pg_temp.correct_date()','прав|администратор');
rollback to disabled;
do $$declare d date;begin
 foreach d in array array[null::date,'infinity'::date,'-infinity'::date,private.business_today()+1,date '1899-12-31',private.business_today()-6,private.business_today()-1] loop
  begin
   perform public.correct_customer_order_date((select id from tests.historical_context where k='sale'),gen_random_uuid(),private.business_today()-1,d,'test');
   raise exception 'Unexpected accepted date';
  exception when raise_exception then assert sqlerrm<>'Unexpected accepted date',sqlerrm;end;
 end loop;
end$$;
select pg_temp.historical_reject($q$select public.correct_customer_order_date((select id from tests.historical_context where k='sale'),gen_random_uuid(),current_date-20,current_date-5,'test')$q$,'уже изменилась');
do $$begin assert pg_temp.date_snapshot()=(select snapshot from date_baseline),'Denied attempts changed data';end$$;
set local role authenticated;
select pg_temp.correct_date();
select pg_temp.correct_date();
reset role;
do $$declare before_row jsonb; after_row jsonb; before_all jsonb; after_all jsonb;begin
 select snapshot into before_all from date_baseline;after_all:=pg_temp.date_snapshot();
 assert before_all-array['sales','history']=after_all-array['sales','history'],'Correction changed stock, lines or documents';
 select x into before_row from jsonb_array_elements(before_all->'sales') x where x->>'id'=(select id::text from tests.historical_context where k='sale');
 select to_jsonb(s) into after_row from public.sales s where id=(select id from tests.historical_context where k='sale');
 assert before_row-array['planned_shipment_date','updated_at']=after_row-array['planned_shipment_date','updated_at'],'Correction changed other sale fields';
 assert (after_row->>'planned_shipment_date')::date=private.business_today()-5;
 assert (select count(*)=1 from public.sale_shipment_date_changes where sale_id=(select id from tests.historical_context where k='sale')),'Retry duplicated history';
 assert exists(select 1 from public.sale_shipment_date_changes where id='ad610000-0000-4000-8000-000000000001'
  and previous_date=private.business_today()-1 and new_date=private.business_today()-5
  and changed_by=auth.uid() and change_kind='admin_correction' and changed_at is not null and reason like '%INV-TEST%');
end$$;
select pg_temp.historical_reject($q$select pg_temp.correct_date(reason=>'Другие данные')$q$,'другие данные');
select pg_temp.historical_reject($q$select pg_temp.correct_date(req=>gen_random_uuid())$q$,'уже изменилась');
savepoint subsequent;
update public.sales set planned_shipment_date=private.business_today()-3 where id=(select id from tests.historical_context where k='sale');
select pg_temp.historical_reject('select pg_temp.correct_date()','повторно');
rollback to subsequent;
-- Revoking permissions after success also blocks replay.
savepoint replay_deny;
update public.profiles set is_active=false where id=auth.uid();
select pg_temp.historical_reject('select pg_temp.correct_date()','прав|администратор');
rollback to replay_deny;
-- State checks do not alter reserves, stock or fulfilled orders.
savepoint states;
do $$declare st text; before_state jsonb;begin
 foreach st in array array['reserved','confirmed','shipped','cancelled'] loop
  update public.sales set status=st where id=(select id from tests.historical_context where k='sale');
  before_state:=pg_temp.date_snapshot();
  perform pg_temp.historical_reject('select pg_temp.correct_date(req=>gen_random_uuid())','черновика');
  assert before_state=pg_temp.date_snapshot();
 end loop;
 update public.sales set status='draft' where id=(select id from tests.historical_context where k='sale');
end$$;
rollback to states;
savepoint reserved;
set local role authenticated;
select public.reserve_customer_order_item_fefo(id) from tests.historical_context where k='item';
reset role;
update public.sales set status='draft' where id=(select id from tests.historical_context where k='sale');
select pg_temp.historical_reject('select pg_temp.correct_date(req=>gen_random_uuid())','резервы');
rollback to reserved;
savepoint historical;
set local role authenticated;
update tests.historical_context set id=pg_temp.historical_create() where k='sale';
select pg_temp.historical_reject('select pg_temp.correct_date(req=>gen_random_uuid())','черновика');
rollback to historical;
rollback;
