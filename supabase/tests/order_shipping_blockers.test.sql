-- What prevents shipping a confirmed order (202609278900): every problem the shipment would stop at is listed at
-- once, and the list agrees with fulfill_customer_order — empty when it ships, the matching problem when it fails.
\set ON_ERROR_STOP 1
begin;
\ir fixtures/order_fulfillment.sql

create function pg_temp.codes() returns text[] language sql as $$
 select coalesce(array_agg(code order by code),'{}') from public.customer_order_shipping_blockers((select id from tests.fulfillment_context where k='sale')) $$;
create function pg_temp.messages() returns text language sql as $$
 select string_agg(message,' | ' order by message) from public.customer_order_shipping_blockers((select id from tests.fulfillment_context where k='sale')) $$;
-- The shipment fails with the expected message; its changes are undone with the failed statement.
create function pg_temp.ship_fails(p_pattern text) returns void language plpgsql as $$
begin
 begin perform public.fulfill_customer_order((select id from tests.fulfillment_context where k='sale'));
 exception when others then
  if sqlerrm !~ p_pattern then raise exception 'expected the shipment to fail with %, got: %',p_pattern,sqlerrm; end if;
  return;
 end;
 raise exception 'expected the shipment to fail with %, but it shipped',p_pattern;
end $$;
grant execute on function pg_temp.codes(),pg_temp.messages(),pg_temp.ship_fails(text) to authenticated;
create temporary table seen(step text primary key,codes text[],messages text);
grant select,insert on seen to authenticated;

-- ---------- each problem, one at a time, as the user sees it and as the shipment meets it ----------
set role authenticated;
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000001',false);
insert into seen select 'clean',pg_temp.codes(),pg_temp.messages();
reset role;

update public.inventory_batches set status='blocked',status_reason='Отзыв производителя' where id='ef400000-0000-4000-8000-000000000001';
set role authenticated;
insert into seen select 'blocked',pg_temp.codes(),pg_temp.messages();
select pg_temp.ship_fails('заблокирована');
reset role;
update public.inventory_batches set status='available',status_reason=null where id='ef400000-0000-4000-8000-000000000001';

update public.inventory_batches set manufacture_date=current_date-500,expiry_date=current_date-1 where id='ef400000-0000-4000-8000-000000000002';
set role authenticated;
insert into seen select 'expired',pg_temp.codes(),pg_temp.messages();
select pg_temp.ship_fails('просрочена');
reset role;
update public.inventory_batches set manufacture_date='2098-11-01',expiry_date='2099-12-06' where id='ef400000-0000-4000-8000-000000000002';

update public.guarantee_letters set status='cancelled' where id=(select id from tests.fulfillment_context where k='letter');
set role authenticated;
insert into seen select 'no_letter',pg_temp.codes(),pg_temp.messages();
select pg_temp.ship_fails('гарантийного письма');
reset role;
update public.guarantee_letters set status='approved' where id=(select id from tests.fulfillment_context where k='letter');

update public.sale_items set quantity=quantity+5 where id=(select id from tests.fulfillment_context where k='item');
set role authenticated;
insert into seen select 'short',pg_temp.codes(),pg_temp.messages();
select pg_temp.ship_fails('полностью зарезервирован');
reset role;
update public.sale_items set quantity=quantity-5 where id=(select id from tests.fulfillment_context where k='item');

do $$ declare r seen%rowtype; begin
 select * into r from seen where step='clean';
 assert r.codes='{}',format('a confirmed order without problems lists nothing: %s',r.messages);
 select * into r from seen where step='blocked';
 assert r.codes='{batch_unavailable}' and r.messages ~ 'SYNTH-FF-P, партия SYNTH-EARLY: заблокирована — Отзыв производителя',
  format('the blocked batch is named with its reason: %s',r.messages);
 select * into r from seen where step='expired';
 assert 'batch_expired'=any(r.codes) and r.messages ~ 'партия SYNTH-LATE: просрочена \(годна до',format('the expired batch: %s',r.messages);
 select * into r from seen where step='no_letter';
 assert r.codes='{shelf_life_letter}' and r.messages ~ 'ниже требуемых 60% — нужно действующее гарантийное письмо',
  format('the batch below the required shelf life without a letter: %s',r.messages);
 select * into r from seen where step='short';
 assert r.codes='{not_reserved}' and r.messages ~ 'SYNTH-FF-P: зарезервировано 150 из 155',format('the line not fully reserved: %s',r.messages);
end $$;

-- ---------- several problems at once are all listed; the order still ships once they are fixed ----------
update public.inventory_batches set status='quarantine',status_reason='Проверка' where id='ef400000-0000-4000-8000-000000000001';
update public.guarantee_letters set status='cancelled' where id=(select id from tests.fulfillment_context where k='letter');
set role authenticated;
do $$ begin
 assert pg_temp.codes() @> '{batch_unavailable,shelf_life_letter}',format('both problems at once: %s',pg_temp.messages());
end $$;
reset role;
update public.inventory_batches set status='available',status_reason=null where id='ef400000-0000-4000-8000-000000000001';
update public.guarantee_letters set status='approved' where id=(select id from tests.fulfillment_context where k='letter');
set role authenticated;
do $$ begin assert pg_temp.codes()='{}','fixed again'; end $$;
select public.fulfill_customer_order(id) from tests.fulfillment_context where k='sale';
do $$ begin assert pg_temp.codes()='{}','a shipped order has nothing to list'; end $$;
reset role;

-- ---------- only for those who see orders ----------
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'ef000000-0000-4000-8000-000000000001',id,'deny','Blockers test','ef000000-0000-4000-8000-000000000001' from public.permissions where code='sales.view';
set role authenticated;
do $$ begin
 perform pg_temp.codes();
 raise exception 'the list was read without sales.view';
exception when insufficient_privilege then null;
end $$;
reset role;
do $$ begin
 assert not has_function_privilege('anon','public.customer_order_shipping_blockers(uuid)','execute'),'closed to anon';
 assert not has_function_privilege('service_role','public.customer_order_shipping_blockers(uuid)','execute'),'closed to the server key';
end $$;

rollback;
\echo 'order_shipping_blockers: all checks passed'
