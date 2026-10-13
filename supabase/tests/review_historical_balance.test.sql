-- Receivables (202609277600): opening balance from 1С, shipments due after the contract deferral, payments from the
-- bank statement matched by BIN or order number, returns, adjustments, FIFO ageing, reconciliation acts, and the
-- warning with a recorded decision before an order of a customer at risk is confirmed.
-- Shipping to the customer is simulated (it belongs to the fulfillment of customer orders).
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('ef000000-0000-4000-8000-000000000001','recv-director@test.local','{"full_name":"Receivables Director"}'),
 ('ef000000-0000-4000-8000-000000000002','recv-sales@test.local','{"full_name":"Receivables Sales"}'),
 ('ef000000-0000-4000-8000-000000000003','recv-accountant@test.local','{"full_name":"Receivables Accountant"}');
insert into public.user_roles(user_id,role_id) select v.u::uuid,r.id from (values
 ('ef000000-0000-4000-8000-000000000001','director'),('ef000000-0000-4000-8000-000000000002','director'),
 ('ef000000-0000-4000-8000-000000000003','accountant')) v(u,role)
 join public.app_roles r on r.code=v.role;
-- A sales manager who works with orders but does not see the receivables.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'ef000000-0000-4000-8000-000000000002'::uuid,p.id,'deny','receivables test','ef000000-0000-4000-8000-000000000001'
from public.permissions p where p.code in ('receivables.view','receivables.manage');
insert into public.counterparties(id,roles,legal_name,short_name,country,tax_id) values
 ('ef100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Recv Supplier',null,'FI','RECV-SUP'),
 ('ef100000-0000-4000-8000-000000000002',array['customer'],'ТОО «Дебитор»','Дебитор','KZ','1234 5678 9012'),
 ('ef100000-0000-4000-8000-000000000003',array['customer'],'ТОО «Старый долг»',null,'KZ','210987654321');
insert into public.contracts(id,counterparty_id,number,type,status,sign_date) values
 ('ef500000-0000-4000-8000-000000000001','ef100000-0000-4000-8000-000000000002','Д-1','sale','active',current_date-400);
insert into public.contract_terms(contract_id,term_type,value_numeric,valid_from) values
 ('ef500000-0000-4000-8000-000000000001','payment_terms',30,current_date-400);
insert into public.products(id,internal_sku,name,manufacturer_id,status,shelf_life_days) values
 ('ef200000-0000-4000-8000-000000000001','RECV-001','{"ru":"Товар в долг"}','ef100000-0000-4000-8000-000000000001','active',400);

create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql; exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm; end if;
  return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on function pg_temp.fails(text,text) to authenticated;
create temporary table rt(name text primary key,id uuid);
grant select,insert,update on rt to authenticated;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from rt where name=p_name $$;
grant execute on function pg_temp.id(text) to authenticated;
create function pg_temp.aging(p_customer text,p_currency text default 'KZT') returns jsonb language sql as $$
 select e from jsonb_array_elements(public.customer_statement(p_customer::uuid)->'aging') e where e->>'currency'=p_currency $$;
grant execute on function pg_temp.aging(text,text) to authenticated;
create function pg_temp.sha(p text) returns text language sql as $$ select encode(sha256(convert_to(p,'UTF8')),'hex') $$;
grant execute on function pg_temp.sha(text) to authenticated;

insert into rt select 'warehouse',id from public.warehouses where status='active' and not is_virtual order by code limit 1;
insert into public.inventory_batches(id,product_id,batch_number,manufacture_date,expiry_date,created_by) values
 ('ef300000-0000-4000-8000-000000000001','ef200000-0000-4000-8000-000000000001','RECV-B1',current_date-50,current_date+300,'ef000000-0000-4000-8000-000000000001');
insert into public.inventory_balances(id,batch_id,warehouse_id,uom,quantity_on_hand) values
 ('ef400000-0000-4000-8000-000000000001','ef300000-0000-4000-8000-000000000001',pg_temp.id('warehouse'),'piece',100);


set role authenticated;
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000001',false);
select public.import_opening_balances(current_date-30,'[{"bin":"123456789012","amount":100}]');
select public.import_opening_balances(current_date-10,'[{"bin":"123456789012","amount":200}]');
select public.record_reconciliation_act('ef100000-0000-4000-8000-000000000002','KZT',current_date-20,100,'review reproduction');
select as_of,act_balance,nexus_balance from public.customer_reconciliation_acts;


do $$ begin
 assert (select nexus_balance=100 from public.customer_reconciliation_acts), 'Historical act uses the older opening balance';
end $$;
-- Re-import the same past date: the latest import replaces the active balance, as before this fix.
select public.import_opening_balances(current_date-30,'[{"bin":"123456789012","amount":125}]');
select public.record_reconciliation_act('ef100000-0000-4000-8000-000000000002','KZT',current_date-19,125,'corrected opening');
select public.record_reconciliation_act('ef100000-0000-4000-8000-000000000002','KZT',current_date,125,'current opening');
do $$ begin
 assert (select nexus_balance=125 from public.customer_reconciliation_acts where as_of=current_date-19), 'Latest same-date correction wins';
 assert (select nexus_balance=125 from public.customer_reconciliation_acts where as_of=current_date), 'Latest import remains the active balance';
end $$;
rollback;
