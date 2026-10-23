-- Operational analytics counted in the database (202609278600, audit finding Н8): the counts of shipments, stages,
-- orders, shelf-life risks and tasks, with the caller's rights; a block only with its source permission.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('da000000-0000-4000-8000-000000000001','summary-director@test.local','{"full_name":"Summary Director"}'),
 ('da000000-0000-4000-8000-000000000002','summary-marketer@test.local','{"full_name":"Summary Marketer"}'),
 ('da000000-0000-4000-8000-000000000003','summary-client@test.local','{"full_name":"Summary Client"}');
insert into public.user_roles(user_id,role_id) select u.id,r.id from (values
 ('da000000-0000-4000-8000-000000000001'::uuid,'director'),('da000000-0000-4000-8000-000000000002'::uuid,'marketer'),
 ('da000000-0000-4000-8000-000000000003'::uuid,'external_client')) u(id,code) join public.app_roles r on r.code=u.code;
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('da100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Summary supplier','FI','SUM-FI'),
 ('da100000-0000-4000-8000-000000000002',array['customer'],'Summary customer','KZ','SUM-KZ');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('da200000-0000-4000-8000-000000000001','SUM-001','{"ru":"Сводка"}','da100000-0000-4000-8000-000000000001','active');

create temporary table sm(before jsonb,after jsonb,s1 uuid,s2 uuid,s3 uuid);
grant select,insert,update on sm to authenticated;
create function pg_temp.n(p jsonb,p_path text[]) returns bigint language sql immutable as $$ select coalesce((p#>>p_path)::bigint,0) $$;
grant execute on function pg_temp.n(jsonb,text[]) to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub','da000000-0000-4000-8000-000000000001',false);
insert into sm(before) select public.operational_summary();
reset role;

-- ---------- data: two shipments (one late), stages, orders, a risky batch, tasks ----------
set role authenticated;
select set_config('request.jwt.claim.sub','da000000-0000-4000-8000-000000000001',false);
update sm set
 s1=public.create_shipment_with_stages('SUM1','import','da100000-0000-4000-8000-000000000001',null,
  (select id from public.routes where status='active' order by created_at limit 1),(select id from public.currencies where code='EUR'),
  (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),'da000000-0000-4000-8000-000000000001',current_date-30,current_date-10),
 s2=public.create_shipment_with_stages('SUM2','import','da100000-0000-4000-8000-000000000001',null,
  (select id from public.routes where status='active' order by created_at limit 1),(select id from public.currencies where code='EUR'),
  (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),'da000000-0000-4000-8000-000000000001',current_date,current_date+20),
 s3=public.create_shipment_with_stages('SUM3','import','da100000-0000-4000-8000-000000000001',null,
  (select id from public.routes where status='active' order by created_at limit 1),(select id from public.currencies where code='EUR'),
  (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),'da000000-0000-4000-8000-000000000001',current_date-40,current_date-30);
reset role;
-- a cancelled shipment past its date is neither active nor late
update public.shipments set status='cancelled' where id=(select s3 from sm);
-- one stage blocked, one late, one blocked and late; a completed stage past its date is not late
update public.shipment_stage_runs set status='blocked',status_reason='Нет документов'
 where id=(select id from public.shipment_stage_runs where shipment_id=(select s1 from sm) and is_required order by id limit 1);
update public.shipment_stage_runs set status='pending',due_at=now()-interval '2 days'
 where id=(select id from public.shipment_stage_runs where shipment_id=(select s1 from sm) and is_required and status<>'blocked' order by id limit 1);
update public.shipment_stage_runs set status='blocked',status_reason='Ждём',due_at=now()-interval '1 day'
 where id=(select id from public.shipment_stage_runs where shipment_id=(select s2 from sm) and is_required order by id limit 1);
update public.shipment_stage_runs set status='completed',due_at=now()-interval '5 days'
 where id=(select id from public.shipment_stage_runs where shipment_id=(select s2 from sm) and is_required and status<>'blocked' order by id limit 1);
insert into public.sales(sale_number,customer_id,warehouse_id,sale_date,planned_shipment_date,status,created_by)
select v.n,'da100000-0000-4000-8000-000000000002',(select id from public.warehouses where status='active' and not is_virtual order by code limit 1),current_date-20,v.d,v.s,
 'da000000-0000-4000-8000-000000000001'
from (values ('SUM-SO-1',current_date-3,'draft'),('SUM-SO-2',current_date+3,'reserved'),('SUM-SO-3',current_date-9,'shipped'),
 ('SUM-SO-4',current_date-1,'cancelled')) v(n,d,s);
insert into public.inventory_batches(id,product_id,batch_number,expiry_date,created_by) values
 ('da300000-0000-4000-8000-000000000001','da200000-0000-4000-8000-000000000001','SUM-EXPIRED',current_date-1,'da000000-0000-4000-8000-000000000001'),
 ('da300000-0000-4000-8000-000000000002','da200000-0000-4000-8000-000000000001','SUM-FRESH',current_date+700,'da000000-0000-4000-8000-000000000001');
insert into public.inventory_balances(batch_id,warehouse_id,uom,quantity_on_hand)
select b,(select id from public.warehouses where status='active' and not is_virtual order by code limit 1),'piece',5
from unnest(array['da300000-0000-4000-8000-000000000001','da300000-0000-4000-8000-000000000002']::uuid[]) b;
insert into public.tasks(title,assignee_user_id,status,due_at) values
 ('Сводка: просрочена','da000000-0000-4000-8000-000000000001','open',now()-interval '1 day'),
 ('Сводка: в срок','da000000-0000-4000-8000-000000000001','open',now()+interval '1 day'),
 ('Сводка: выполнена','da000000-0000-4000-8000-000000000001','done',now()-interval '3 days');

set role authenticated;
select set_config('request.jwt.claim.sub','da000000-0000-4000-8000-000000000001',false);
update sm set after=public.operational_summary();
reset role;

do $$ declare b jsonb; a jsonb; begin
 select before,after into b,a from sm;
 assert a->>'today'=((now() at time zone 'Asia/Almaty')::date)::text,'the business day of Kazakhstan';
 assert pg_temp.n(a,'{shipments,total}')-pg_temp.n(b,'{shipments,total}')=3,'three shipments';
 assert pg_temp.n(a,'{shipments,by_status,cancelled}')-pg_temp.n(b,'{shipments,by_status,cancelled}')=1,'one of them cancelled';
 assert pg_temp.n(a,'{shipments,active}')-pg_temp.n(b,'{shipments,active}')=2,'both active';
 assert pg_temp.n(a,'{shipments,late}')-pg_temp.n(b,'{shipments,late}')=1,'one past its planned arrival';
 assert pg_temp.n(a,'{shipments,by_status,planning}')-pg_temp.n(b,'{shipments,by_status,planning}')=2,'counted by status';
 assert pg_temp.n(a,'{stages,blocked}')-pg_temp.n(b,'{stages,blocked}')=2,'two blocked stages';
 assert pg_temp.n(a,'{stages,late}')-pg_temp.n(b,'{stages,late}')=2,'two late stages; the completed one is not late';
 assert pg_temp.n(a,'{stages,attention}')-pg_temp.n(b,'{stages,attention}')=3,'a stage blocked and late is counted once';
 assert pg_temp.n(a,'{sales,total}')-pg_temp.n(b,'{sales,total}')=4,'four orders';
 assert pg_temp.n(a,'{sales,open}')-pg_temp.n(b,'{sales,open}')=2,'shipped and cancelled orders are not open';
 assert pg_temp.n(a,'{sales,late}')-pg_temp.n(b,'{sales,late}')=1,'one open order past its shipment date';
 assert pg_temp.n(a,'{sales,by_status,shipped}')-pg_temp.n(b,'{sales,by_status,shipped}')=1,'orders by status';
 assert pg_temp.n(a,'{inventory,risk}')-pg_temp.n(b,'{inventory,risk}')=1,'the expired batch is a risk, the fresh one is not';
 assert pg_temp.n(a,'{tasks,open}')-pg_temp.n(b,'{tasks,open}')=2,'two open tasks';
 assert pg_temp.n(a,'{tasks,late}')-pg_temp.n(b,'{tasks,late}')=1,'one late task';
end $$;

-- ---------- the day is the day in Kazakhstan whatever the session time zone ----------
set role authenticated;
select set_config('request.jwt.claim.sub','da000000-0000-4000-8000-000000000001',false);
set timezone='Etc/GMT+12';
do $$ begin assert public.operational_summary()->>'today'=((now() at time zone 'Asia/Almaty')::date)::text,'UTC-12'; end $$;
set timezone='Pacific/Kiritimati';
do $$ begin assert public.operational_summary()->>'today'=((now() at time zone 'Asia/Almaty')::date)::text,'UTC+14'; end $$;
reset timezone;
reset role;

-- ---------- a block only with its permission; no report without reports.view ----------
set role authenticated;
select set_config('request.jwt.claim.sub','da000000-0000-4000-8000-000000000002',false);
do $$ declare v jsonb:=public.operational_summary(); begin
 assert v ? 'shipments' and v ? 'stages' and v ? 'sales' and v ? 'tasks','the marketer sees the blocks of their sections';
 assert not v ? 'inventory','without inventory.view there is no inventory block';
end $$;
select set_config('request.jwt.claim.sub','da000000-0000-4000-8000-000000000003',false);
do $$ begin
 perform public.operational_summary();
 raise exception 'an external client read the operational summary';
exception when insufficient_privilege then null;
end $$;
reset role;

do $$ begin
 assert not (select prosecdef from pg_proc where oid='public.operational_summary()'::regprocedure),
  'the summary runs with the rights of the caller, through RLS';
 assert not has_function_privilege('anon','public.operational_summary()','execute'),'closed to anon';
end $$;

rollback;
\echo 'operational_summary: all checks passed'
