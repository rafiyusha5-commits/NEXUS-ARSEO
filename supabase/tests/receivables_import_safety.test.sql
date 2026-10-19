\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email) values ('b9300000-0000-4000-8000-000000000001','import-safety@test.local');
insert into public.user_roles(user_id,role_id) select 'b9300000-0000-4000-8000-000000000001',id from public.app_roles where code='accountant';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('b9400000-0000-4000-8000-000000000001',array['customer'],'Синтетический А','KZ','990000000011'),
 ('b9400000-0000-4000-8000-000000000002',array['customer'],'Синтетический Б','KZ','990000000012');
insert into public.sales(sale_number,customer_id,warehouse_id,sale_date,planned_shipment_date,created_by)
select 'SO-2026-998812','b9400000-0000-4000-8000-000000000002',id,'2026-01-01','2026-01-05','b9300000-0000-4000-8000-000000000001' from public.warehouses limit 1;
create function pg_temp.fails(q text,pattern text) returns void language plpgsql as $$ begin
 begin execute q; exception when others then assert sqlerrm ~* pattern,sqlerrm; return; end;
 raise exception 'Expected failure: %',q;
end $$;
grant execute on function pg_temp.fails(text,text) to authenticated;
create function pg_temp.bank(f text,op text default 'OP-1') returns jsonb language sql as $$ select jsonb_build_object(
 'kind','bank','file_name',f||'.txt','file_sha256',encode(sha256(convert_to(f,'UTF8')),'hex'),'account','KZTEST','currency','KZT',
 'rows',jsonb_build_array(jsonb_build_object('rowNumber',7,'operation_id',op,'identity_source','bank','doc_number','15','doc_date','2026-01-05',
 'amount',100,'payer_bin','990000000011','payer_account','KZPAYER','purpose','За товар'))) $$;
grant execute on function pg_temp.bank(text,text) to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub','b9300000-0000-4000-8000-000000000001',true);
select pg_temp.fails($$select public.import_bank_statement('x',repeat('a',64),null,null,null,'KZT','[]')$$,'permission denied');
select pg_temp.fails($$select public.import_opening_balances('2026-01-01','[]')$$,'permission denied');
do $$ declare p jsonb:=pg_temp.bank('one'); v jsonb; r jsonb; r2 jsonb; opening jsonb; oldid uuid; begin
 v:=public.preview_receivables_import(p);
 assert (v->>'can_confirm')::boolean,v::text;
 assert not exists(select 1 from public.bank_statement_lines),'preview is read-only';
 r:=public.confirm_receivables_import('b9500000-0000-4000-8000-000000000001',p,v->>'fingerprint');
 r2:=public.confirm_receivables_import('b9500000-0000-4000-8000-000000000001',p,v->>'fingerprint');
 assert r=r2,'lost-response retry returns saved result';
 r2:=public.confirm_receivables_import('b9500000-0000-4000-8000-000000000002',p||'{"file_name":"renamed.txt"}',v->>'fingerprint');
 assert r=r2,'renamed file has the same result';
 assert (select count(*)=1 from public.bank_statement_lines),'one payment';
 p:=pg_temp.bank('overlap'); p:=jsonb_set(p,'{rows,0,purpose}','"За  товар, изменён формат"');
 v:=public.preview_receivables_import(p);
 assert v->'rows'->0->>'status'='duplicate','purpose does not decide identity';
 r:=public.confirm_receivables_import('b9500000-0000-4000-8000-000000000003',p,v->>'fingerprint');
 assert (r->>'new')::int=0 and (r->>'duplicates')::int=1,'overlap does not add money';
 p:=pg_temp.bank('distinct','OP-2'); v:=public.preview_receivables_import(p);
 r:=public.confirm_receivables_import('b9500000-0000-4000-8000-000000000004',p,v->>'fingerprint');
 assert (select count(*)=2 from public.bank_statement_lines),'two real operations, same date/amount/customer';
 p:=jsonb_set(pg_temp.bank('changed'),'{rows,0,amount}','101'); v:=public.preview_receivables_import(p);
 assert not (v->>'can_confirm')::boolean,'same identity with changed amount blocks';
 p:=jsonb_set(pg_temp.bank('weak'),'{rows,0,operation_id}','null'); v:=public.preview_receivables_import(p);
 assert not (v->>'can_confirm')::boolean,'date+amount+customer is not identity';
 p:=jsonb_set(pg_temp.bank('conflict','OP-3'),'{rows,0,purpose}','"Оплата SO-2026-998812"');
 v:=public.preview_receivables_import(p);
 assert not (v->>'can_confirm')::boolean and v->'rows'->0->>'problem' like '%разных покупателей%','BIN/order conflict';
 p:=jsonb_set(pg_temp.bank('multi-order','OP-4'),'{rows,0,purpose}','"SO-2026-998812 SO-2026-998813"');
 v:=public.preview_receivables_import(p); assert not (v->>'can_confirm')::boolean,'multiple order references cannot choose first';
 -- No prefix of an invalid batch can be committed.
 p:=pg_temp.bank('atomic','OP-5'); p:=jsonb_set(p,'{rows}',p->'rows'||jsonb_build_array((p->'rows'->0)||'{"operation_id":"OP-6","amount":0}'));
 begin perform public.confirm_receivables_import('b9500000-0000-4000-8000-000000000099',p,'x'); raise exception 'unexpected success';
 exception when others then assert sqlerrm like '%положительной суммы%',sqlerrm; end;
 assert (select count(*)=2 from public.bank_statement_lines),'invalid batch has no partial payment';
 opening:='{"kind":"opening","file_name":"flat.csv","file_sha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","as_of":"2026-01-01","rows":[{"rowNumber":2,"name":"Синтетический А","bin":"990000000011","currency":"KZT","amount":500}]}';
 v:=public.preview_receivables_import(opening);
 r:=public.confirm_receivables_import('b9500000-0000-4000-8000-000000000005',opening,v->>'fingerprint');
 select id into oldid from public.customer_opening_balances where customer_id='b9400000-0000-4000-8000-000000000001' and superseded_at is null;
 opening:=opening||jsonb_build_object('file_sha256',repeat('e',64));
 v:=public.preview_receivables_import(opening);
 assert not (v->>'can_confirm')::boolean and v->'rows'->0->'previous_balance'->>'id'=oldid::text,'same-date balance conflict';
 opening:=jsonb_set(opening,'{rows,0}',opening->'rows'->0||jsonb_build_object('replace_id',oldid,'reason','Сверен исправленный отчёт','amount',550));
 v:=public.preview_receivables_import(opening);
 r:=public.confirm_receivables_import('b9500000-0000-4000-8000-000000000006',opening,v->>'fingerprint');
 assert (select amount=550 from public.customer_opening_balances where customer_id='b9400000-0000-4000-8000-000000000001' and superseded_at is null),'explicit replacement';
 assert (select superseded_by is not null from public.customer_opening_balances where id=oldid),'history retained';
 assert (select count(*)=5 from public.receivables_import_sources),'including duplicate observations with source row';
 assert (select count(*)=5 from public.receivables_import_batches where created_by=auth.uid()),'actor attribution';
 opening:=jsonb_set(opening,'{rows}',jsonb_build_array(opening->'rows'->0,opening->'rows'->0));
 v:=public.preview_receivables_import(opening); assert v->'rows'->1->>'problem' like 'Повтор покупателя%','parent and children not summed';
end $$;
reset role;
-- Previously imported rows have no stable identity. Manual linking must never turn into "new"
-- when a competing decision has already assigned another identity to that legacy row.
select public.import_bank_statement('legacy.txt',repeat('a',64),'KZLEGACY',null,null,'KZT',
 '[{"doc_number":"legacy","doc_date":"2026-01-05","amount":100,"payer_bin":"990000000011","payer_account":"KZPAYER","purpose":"Legacy synthetic"}]');
set local role authenticated;
do $$ declare p jsonb:=pg_temp.bank('legacy-review','LEGACY-ID')||'{"account":"KZLEGACY"}'; v jsonb; legacy uuid; begin
 select id into legacy from public.bank_statement_lines where doc_number='legacy';
 v:=public.preview_receivables_import(p);assert not (v->>'can_confirm')::boolean,'legacy requires explicit choice';
 p:=jsonb_set(p,'{rows,0}',p->'rows'->0||jsonb_build_object('legacy_decision','same','legacy_id',legacy,'reason','Verified legacy payment'));
 v:=public.preview_receivables_import(p);assert (v->>'can_confirm')::boolean,v::text;
 perform public.confirm_receivables_import('b9500000-0000-4000-8000-000000000008',p,v->>'fingerprint');
 p:=jsonb_set(p||jsonb_build_object('file_sha256',repeat('b',64)),'{rows,0,operation_id}','"OTHER-LEGACY-ID"');
 v:=public.preview_receivables_import(p);assert not (v->>'can_confirm')::boolean,'stale same-payment choice never becomes new payment';
end $$;
reset role;
insert into public.currencies(code,name) values ('USD','{"ru":"Synthetic USD"}') on conflict do nothing;
set local role authenticated;
do $$ declare p jsonb:=pg_temp.bank('multi','PAIR-A'); v jsonb; r jsonb;begin
 p:=jsonb_set(p,'{rows}',p->'rows'||jsonb_build_array((p->'rows'->0)||'{"operation_id":"PAIR-B"}'));
 v:=public.preview_receivables_import(p);
 r:=public.confirm_receivables_import('b9500000-0000-4000-8000-000000000009',p,v->>'fingerprint');
 assert (r->>'new')::int=2,'two equal payments with distinct stable IDs in ONE file';
 assert (select count(*)=1 from public.bank_statement_imports where file_name='multi.txt'),'one file creates one bank batch';
 p:=jsonb_set(p||jsonb_build_object('file_name','reordered.txt','file_sha256',repeat('3',64)),
   '{rows}',jsonb_build_array((p->'rows'->1)||'{"purpose":"За  товар"}',(p->'rows'->0)||'{"purpose":"За товар  "}'));
 v:=public.preview_receivables_import(p);
 r:=public.confirm_receivables_import('b9500000-0000-4000-8000-000000000010',p,v->>'fingerprint');
 assert (r->>'new')::int=0 and (r->>'duplicates')::int=2,'row order and formatting do not create payments';
 p:=pg_temp.bank('currency','PAIR-A')||'{"currency":"USD"}';v:=public.preview_receivables_import(p);
 r:=public.confirm_receivables_import('b9500000-0000-4000-8000-000000000011',p,v->>'fingerprint');
 assert (r->>'new')::int=1,'currencies are not collapsed into one identity';
end $$;
reset role;
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('b9400000-0000-4000-8000-000000000003',array['customer'],'Синтетический дубль БИН','KZ','9900 0000 0011');
set local role authenticated;
do $$ declare p jsonb:=jsonb_set(pg_temp.bank('ambiguous','OP-7'),'{rows,0,purpose}','"SO-2026-998812"');v jsonb;begin
 v:=public.preview_receivables_import(p);assert not (v->>'can_confirm')::boolean,'ambiguous BIN cannot fall back to order';
end $$;
reset role;
-- A personal deny defeats direct RPC, even when manage remains granted.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'b9300000-0000-4000-8000-000000000001',id,'deny','Synthetic deny','b9300000-0000-4000-8000-000000000001' from public.permissions where code='receivables.view';
set local role authenticated;
select pg_temp.fails($$select public.preview_receivables_import(pg_temp.bank('one'))$$,'Нет права');
select pg_temp.fails($$select public.confirm_receivables_import('b9500000-0000-4000-8000-000000000001',pg_temp.bank('one'),'x')$$,'Нет права');
do $$ begin assert not exists(select 1 from public.receivables_import_batches),'RLS hides provenance'; end $$;
reset role;
rollback;
