\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('a8000000-0000-4000-8000-000000000001','kz-director@test.local','{"full_name":"KZ Director"}'),
 ('a8000000-0000-4000-8000-000000000002','kz-deny@test.local','{"full_name":"KZ Denied"}');
insert into public.user_roles(user_id,role_id) select u::uuid,r.id from (values('a8000000-0000-4000-8000-000000000001'),('a8000000-0000-4000-8000-000000000002')) x(u) cross join public.app_roles r where r.code='director';
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'a8000000-0000-4000-8000-000000000002',id,'deny','test','a8000000-0000-4000-8000-000000000001' from public.permissions where code='customers.view';
insert into public.counterparties(id,roles,legal_name,country,min_remaining_shelf_life_pct) values
 ('a8100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Synthetic KZ maker','FI',null),
 ('a8100000-0000-4000-8000-000000000002',array['customer'],'KZ customer','KZ',80),
 ('a8100000-0000-4000-8000-000000000003',array['customer'],'RU customer','RU',90);
insert into public.warehouses(id,code,name,city,country) values
 ('a8200000-0000-4000-8000-000000000001','KZ-TEST-ACT','{"ru":"Тест Актобе"}','Актобе','KZ'),
 ('a8200000-0000-4000-8000-000000000002','KZ-TEST-AST','{"ru":"Тест Астана"}','Астана','KZ'),
 ('a8200000-0000-4000-8000-000000000003','KZ-TEST-ALA','{"ru":"Тест Алматы"}','Алматы','KZ');
insert into public.products(id,internal_sku,name,manufacturer_id,status,shelf_life_days) values
 ('a8300000-0000-4000-8000-000000000001','KZ-P1','{"ru":"Синтетический товар"}','a8100000-0000-4000-8000-000000000001','active',540),
 ('a8300000-0000-4000-8000-000000000002','KZ-P2','{"ru":"Без истории"}','a8100000-0000-4000-8000-000000000001','active',540);
insert into public.product_packaging(product_id,uom,units_per_parent) values('a8300000-0000-4000-8000-000000000001','box',10),('a8300000-0000-4000-8000-000000000002','box',12);
-- Synthetic facts only. Bypass old guards for fixture construction, not for any tested RPC.
set session_replication_role=replica;
insert into public.sales(id,sale_number,customer_id,warehouse_id,sale_date,planned_shipment_date,status,created_by,shipped_at)
select id::uuid,num,c::uuid,'a8200000-0000-4000-8000-000000000002',private.business_today()-5,private.business_today()-5,st,'a8000000-0000-4000-8000-000000000001',case when st='shipped' then now()-interval '5 days' end
from (values('a8400000-0000-4000-8000-000000000001','KZ-HIST','a8100000-0000-4000-8000-000000000002','shipped'),
 ('a8400000-0000-4000-8000-000000000002','RU-HIST','a8100000-0000-4000-8000-000000000003','shipped'),
 ('a8400000-0000-4000-8000-000000000003','RU-OPEN','a8100000-0000-4000-8000-000000000003','draft')) x(id,num,c,st);
insert into public.sale_items(sale_id,product_id,quantity,uom) values
 ('a8400000-0000-4000-8000-000000000001','a8300000-0000-4000-8000-000000000001',7,'box'),
 ('a8400000-0000-4000-8000-000000000002','a8300000-0000-4000-8000-000000000001',10000,'piece');
insert into public.inventory_batches(id,product_id,batch_number,expiry_date,status,created_by) values
 ('a8500000-0000-4000-8000-000000000001','a8300000-0000-4000-8000-000000000001','KZ-LOT',private.business_today()+500,'available','a8000000-0000-4000-8000-000000000001');
insert into public.inventory_balances(id,batch_id,warehouse_id,uom,quantity_on_hand,quantity_reserved) values
 ('a8600000-0000-4000-8000-000000000001','a8500000-0000-4000-8000-000000000001','a8200000-0000-4000-8000-000000000001','box',20,2);
set session_replication_role=origin;
create temp table kz_state as select (select md5(jsonb_agg(to_jsonb(b) order by b.id)::text) from public.inventory_balances b) balances,
 (select md5(jsonb_agg(to_jsonb(s) order by s.id)::text) from public.sales s) sales,(select count(*) from public.inventory_movements) movements;
create temp table kz_ids(profile uuid,run uuid,forecast uuid,plan uuid);
grant select,insert,update on kz_ids to authenticated;
create function pg_temp.kz_fails(sql text) returns void language plpgsql as $$begin
 begin execute sql;exception when others then return;end;raise exception 'expected rejection: %',sql;end$$;
grant execute on function pg_temp.kz_fails(text) to authenticated;
set role authenticated;
select set_config('request.jwt.claim.sub','a8000000-0000-4000-8000-000000000001',true);
insert into kz_ids(profile) select public.replenishment_create_profile('a8100000-0000-4000-8000-000000000001','Тестовый расчёт',
 '{"aktobe":"a8200000-0000-4000-8000-000000000001","astana":"a8200000-0000-4000-8000-000000000002","almaty":"a8200000-0000-4000-8000-000000000003","productionDays":14,"transitDays":30,"cityDays":3,"reviewDays":7,"transferDays":2,"historyDays":90,"serviceZ":1.65,"historyConfirmed":true,"overrides":[]}', 'Синтетическая проверка');
do $$declare w jsonb;s jsonb;p uuid;begin
 select profile into p from kz_ids;w:=public.replenishment_workspace(p);
 assert jsonb_array_length(w->'snapshot'->'products')=2,'new products are not silently dropped';
 assert jsonb_array_length(w->'snapshot'->'sales')=1,'Russian point orders excluded regardless of size';
 assert (w->'snapshot'->'sales'->0->>'quantity')::numeric=70,'boxes converted to pieces';
 assert (w->'snapshot'->'sales'->0->>'requiredPct')::numeric=80,'customer requirement';
 assert w->'snapshot'->'supplies'->0->>'purpose'='unknown','no implicit purpose';
 s:=w->'sources'->0;assert (s->>'quantity')::numeric=180,'reserved stock excluded once';
 perform public.replenishment_set_purpose(p,s->>'id',s->>'signature',100,80,null,'a8400000-0000-4000-8000-000000000003','Разделение рынка');
 perform public.replenishment_set_purpose(p,s->>'id',s->>'signature',100,80,null,'a8400000-0000-4000-8000-000000000003','Разделение рынка');
 w:=public.replenishment_workspace(p);assert jsonb_array_length(w->'purposes')=1,'repeat does not duplicate history';
 assert jsonb_array_length(w->'snapshot'->'supplies')=2,'split purpose retained';
 perform pg_temp.kz_fails(format('select public.replenishment_set_purpose(%L,%L,%L,181,0,null,null,%L)',p,s->>'id',s->>'signature','bad overflow'));
 perform pg_temp.kz_fails(format('select public.replenishment_set_purpose(%L,%L,%L,0,180,null,null,%L)',p,s->>'id',s->>'signature','missing export order'));
 perform pg_temp.kz_fails(format('select public.replenishment_set_purpose(%L,%L,%L,100,80,null,%L,%L)',p,s->>'id','stale','a8400000-0000-4000-8000-000000000003','stale signature'));
end$$;
update kz_ids set run=public.replenishment_capture(profile,'a8700000-0000-4000-8000-000000000001');
select public.replenishment_capture(profile,'a8700000-0000-4000-8000-000000000001') from kz_ids;
select public.replenishment_capture(profile,'a8700000-0000-4000-8000-000000000099') from kz_ids;
do $$begin assert (select jsonb_array_length(public.replenishment_workspace(profile)->'runs')=1 from kz_ids),'snapshot retry idempotent';end$$;
update kz_ids set forecast=public.replenishment_prepare_draft(run,'forecast','[{"productId":"a8300000-0000-4000-8000-000000000001","city":"astana","quantity":100}]','Сотрудник проверил предложение');
do $$declare f uuid;r uuid;begin select forecast,run into f,r from kz_ids;
 assert (select status='draft' from public.forecasts where id=f),'no auto approval';
 assert public.replenishment_prepare_draft(r,'forecast','[{"productId":"a8300000-0000-4000-8000-000000000001","city":"astana","quantity":100}]','Сотрудник проверил предложение')=f,'draft retry returns original';
 perform pg_temp.kz_fails(format('select public.replenishment_prepare_draft(%L,%L,%L,%L,%L)',r,'purchase','[{"productId":"a8300000-0000-4000-8000-000000000001","quantity":100}]','проверено',f));
end$$;
select public.submit_forecast(forecast) from kz_ids;
select public.review_forecast(forecast,true,'Синтетическая коммерческая проверка') from kz_ids;
select public.approve_forecast(forecast) from kz_ids;
update kz_ids set plan=public.replenishment_prepare_draft(run,'purchase','[{"productId":"a8300000-0000-4000-8000-000000000001","quantity":100}]','Проверено перед закупкой',forecast);
do $$begin assert(select status='draft' from public.purchase_plans where id=(select plan from kz_ids)),'purchase remains draft';end$$;
select pg_temp.kz_fails('update public.replenishment_runs set fingerprint=''forged''');
select pg_temp.kz_fails('select * from public.replenishment_runs');
select set_config('request.jwt.claim.sub','a8000000-0000-4000-8000-000000000002',true);
select pg_temp.kz_fails('select public.replenishment_workspace()');
select pg_temp.kz_fails(format('select public.replenishment_capture(%L,%L)',profile,'a8700000-0000-4000-8000-000000000002')) from kz_ids;
select pg_temp.kz_fails(format('select public.replenishment_prepare_draft(%L,%L,%L,%L)',run,'forecast','[]','denied')) from kz_ids;
reset role;
do $$begin
 assert (select md5(jsonb_agg(to_jsonb(b) order by b.id)::text) from public.inventory_balances b)=(select balances from kz_state),'no stock changes';
 assert (select md5(jsonb_agg(to_jsonb(s) order by s.id)::text) from public.sales s)=(select sales from kz_state),'no sales changes';
 assert (select count(*) from public.inventory_movements)=(select movements from kz_state),'no movements';
 assert not has_function_privilege('service_role','public.replenishment_workspace(uuid,uuid)','execute');
 assert not has_function_privilege('anon','public.replenishment_capture(uuid,uuid)','execute');
end$$;
-- A subsequent stock change invalidates both purpose and the saved run, even without a quantity change.
update public.inventory_balances set updated_at=clock_timestamp() where id='a8600000-0000-4000-8000-000000000001';
set role authenticated;
select set_config('request.jwt.claim.sub','a8000000-0000-4000-8000-000000000001',true);
do $$declare w jsonb;begin
 select public.replenishment_workspace(null,run) into w from kz_ids;assert w->>'fresh'='false','stale snapshot';
 select public.replenishment_workspace(profile) into w from kz_ids;assert w->'snapshot'->'supplies'->0->>'purpose'='unknown','stale allocation not reused';
end$$;
rollback;
