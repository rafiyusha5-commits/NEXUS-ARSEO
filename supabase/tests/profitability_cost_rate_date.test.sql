-- Audit of 2026-11-18, finding Н1: "the cost of a batch that is not in tenge is converted at today's rate".
-- The profitability report (202611170500) converts it at the official rate of the date of the operation (the
-- shipment date), with the rule of block 1 for days without a rate. This test checks it on a sale shipped 30 days ago
-- when the official rate of that day and today's rate differ. Synthetic data only; rolled back.
\set ON_ERROR_STOP 1
begin;
set local timezone='UTC';
\ir fixtures/historical_sales.sql
-- The batch cost 10 EUR per piece; the official EUR rate was 500 on the shipment date and is 600 today.
update public.inventory_batches set unit_landed_cost=10,cost_currency_id=(select id from public.currencies where code='EUR'),cost_uom='piece'
 where id='af410000-0000-4000-8000-000000000001';
insert into public.exchange_rates(base_currency_id,quote_currency_id,rate,source,rate_date,created_by)
select (select id from public.currencies where code='EUR'),(select id from public.currencies where code='KZT'),v.r,'official',v.d,'af010000-0000-4000-8000-000000000001'
  from (values (500::numeric,(select d from tests.historical_context where k='day')),(600::numeric,private.business_today())) v(r,d);

-- A sale shipped 30 days ago, through the real path: order, line, reservation, confirmation, fulfillment.
select set_config('request.jwt.claim.sub','af010000-0000-4000-8000-000000000001',true);
set local role authenticated;
insert into tests.historical_context values ('sale',pg_temp.historical_create(),null);
insert into tests.historical_context select 'item',public.add_customer_order_item(id,'af310000-0000-4000-8000-000000000001',10,'piece',20,80,'Синтетическая цена теста'),null
  from tests.historical_context where k='sale';
select public.reserve_customer_order_item_fefo(id) from tests.historical_context where k='item';
select public.confirm_customer_order(id) from tests.historical_context where k='sale';
select public.fulfill_customer_order(id) from tests.historical_context where k='sale';
reset role;

do $$
declare l record; v_day date := (select d from tests.historical_context where k='day');
begin
 select * into l from private.profit_lines(v_day, v_day) where sale_id=(select id from tests.historical_context where k='sale');
 assert l.line_date=v_day,'the line is dated by the shipment, 30 days ago';
 assert l.cost_amount=100 and l.cost_rate=500 and l.cost_rate_date=v_day,
   format('cost 10 x 10 = 100 EUR at the rate of the shipment date (500), not today''s 600: got %s at %s on %s', l.cost_amount, l.cost_rate, l.cost_rate_date);
 assert l.cost_kzt=50000,'100 EUR x 500 = 50 000 KZT';
end $$;
\echo profitability_cost_rate_date: Н1 not confirmed, the cost is converted at the rate of the shipment date
rollback;
