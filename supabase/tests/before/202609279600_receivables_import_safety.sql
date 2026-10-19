-- Assertions describe the vulnerable BASE, not the desired new behavior.
-- Run before the safety migration. Synthetic records are rolled back.
begin;
insert into public.currencies(code,name) values ('USD','{"ru":"Synthetic USD"}') on conflict do nothing;
insert into auth.users(id,email) values ('b9100000-0000-4000-8000-000000000001','import-before@test.local');
insert into public.user_roles(user_id,role_id) select 'b9100000-0000-4000-8000-000000000001',id from public.app_roles where code='accountant';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('b9200000-0000-4000-8000-000000000001',array['customer'],'Синтетический А','KZ','990000000001'),
 ('b9200000-0000-4000-8000-000000000002',array['customer'],'Синтетический Б','KZ','990000000002');
insert into public.sales(sale_number,customer_id,warehouse_id,sale_date,planned_shipment_date,created_by)
select 'SO-2026-998811','b9200000-0000-4000-8000-000000000002',id,'2026-01-01','2026-01-05','b9100000-0000-4000-8000-000000000001' from public.warehouses limit 1;
set local role authenticated;
select set_config('request.jwt.claim.sub','b9100000-0000-4000-8000-000000000001',true);
do $$ declare r jsonb; begin
 r := public.import_bank_statement('first.txt',repeat('a',64),'KZTEST',null,null,'KZT',
 '[{"doc_number":"1","doc_date":"2026-01-01","amount":100,"payer_bin":"990000000001","payer_account":"KZPAYER","purpose":"За товар"}]');
 r := public.import_bank_statement('overlap.txt',repeat('b',64),'KZTEST',null,null,'KZT',
 '[{"doc_number":"1","doc_date":"2026-01-01","amount":100,"payer_bin":"990000000001","payer_account":"KZPAYER","purpose":"За  товар"}]');
 assert (r->>'new')::int=1,'base double counts a formatting-only change';
 r := public.import_bank_statement('usd.txt',repeat('c',64),'KZTEST',null,null,'USD',
 '[{"doc_number":"1","doc_date":"2026-01-01","amount":100,"payer_bin":"990000000001","payer_account":"KZPAYER","purpose":"За товар"}]');
 assert (r->>'duplicates')::int=1,'base identity omits currency';
 r:=public.import_bank_statement('conflict.txt',repeat('f',64),'KZTEST',null,null,'KZT',
 '[{"doc_number":"7","doc_date":"2026-01-01","amount":100,"payer_bin":"990000000001","purpose":"Оплата SO-2026-998811"}]');
 assert (r->>'matched')::int=1,'conflicting BIN/order still auto-matched on base';
 perform public.import_opening_balances('2026-01-01','[{"bin":"990000000001","amount":100},{"bin":"990000000001","amount":100,"contract":"Д-1"}]');
 assert (select amount=200 from public.customer_opening_balances where customer_id='b9200000-0000-4000-8000-000000000001' and superseded_at is null),'parent + child double counted';
 perform public.import_opening_balances('2026-01-01','[{"bin":"990000000001","amount":300}]');
 assert (select amount=300 from public.customer_opening_balances where customer_id='b9200000-0000-4000-8000-000000000001' and superseded_at is null),'same-date balance silently replaced';
end $$;
reset role;
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('b9200000-0000-4000-8000-000000000003',array['customer'],'Синтетический дубль БИН','KZ','9900 0000 0001');
set local role authenticated;
do $$ declare r jsonb;begin
 r:=public.import_bank_statement('ambiguous.txt',repeat('1',64),'KZTEST',null,null,'KZT',
 '[{"doc_number":"8","doc_date":"2026-01-01","amount":100,"payer_bin":"990000000001","purpose":"Оплата SO-2026-998811"}]');
 assert (r->>'matched')::int=1,'ambiguous BIN silently falls back to an order on base';
 r:=public.import_bank_statement('distinct.txt',repeat('2',64),'KZTEST',null,null,'KZT',
 '[{"operation_id":"REAL-A","doc_number":"9","doc_date":"2026-01-01","amount":100,"payer_bin":"990000000002","purpose":"За товар"},
   {"operation_id":"REAL-B","doc_number":"9","doc_date":"2026-01-01","amount":100,"payer_bin":"990000000002","purpose":"За товар"}]');
 assert (r->>'new')::int=1 and (r->>'duplicates')::int=1,'two distinct bank IDs collapse on base';
end $$;
rollback;
