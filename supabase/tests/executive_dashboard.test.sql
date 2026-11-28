-- 202611280400: the executive dashboard. Who sees it, which tiles each one gets, the shipments and decisions tiles against
-- their sources, the whole dashboard against its tiles, and a failing source that does not take the other tiles down.
-- The money tiles are checked against their reports on the data of those tests (profitability, loss_report,
-- cash_calendar). Synthetic data; rolled back.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('db000000-0000-4000-8000-000000000001','dash-director@example.invalid','{"full_name":"Dash director"}'),
 ('db000000-0000-4000-8000-000000000002','dash-commercial@example.invalid','{"full_name":"Dash commercial"}'),
 ('db000000-0000-4000-8000-000000000003','dash-logistics@example.invalid','{"full_name":"Dash logistics director"}'),
 ('db000000-0000-4000-8000-000000000004','dash-accountant@example.invalid','{"full_name":"Dash accountant"}');
insert into public.user_roles(user_id,role_id) select u.id::uuid,r.id from (values
 ('db000000-0000-4000-8000-000000000001','director'),('db000000-0000-4000-8000-000000000002','commercial_director'),
 ('db000000-0000-4000-8000-000000000003','logistics_director'),('db000000-0000-4000-8000-000000000004','accountant')) u(id,code)
 join public.app_roles r on r.code=u.code;
-- The director reads reports, tasks and orders whatever the role gives.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'db000000-0000-4000-8000-000000000001',id,'allow','dashboard test','db000000-0000-4000-8000-000000000001'
   from public.permissions where code in ('reports.view','tasks.view','sales.view','shipments.view','inventory.view');
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
create function pg_temp.tiles(p jsonb) returns text[] language sql immutable as $$
 select coalesce(array_agg(x->>'tile' order by x->>'tile'),'{}') from jsonb_array_elements(p->'tiles') x $$;
grant execute on all functions in schema pg_temp to authenticated;

-- Shipments: one in transit and late with a vehicle on the road, one planned; a cancelled one with a vehicle is not counted.
insert into public.counterparties(id,roles,legal_name,country) values ('db100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Dash supplier','FI');
insert into public.shipments(id,shipment_number,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,
                             responsible_user_id,created_by,status,planned_arrival_date)
select v.id::uuid,v.n,'import','db100000-0000-4000-8000-000000000001',
       (select id from public.routes where status='active' order by created_at limit 1),
       (select id from public.process_templates where code='import_eu_kz' and version=1),(select id from public.currencies where code='EUR'),
       (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),
       'db000000-0000-4000-8000-000000000001','db000000-0000-4000-8000-000000000001',v.s,current_date+v.d
  from (values ('db200000-0000-4000-8000-000000000001','DASH-1','in_transit',-3),('db200000-0000-4000-8000-000000000002','DASH-2','planning',20),
               ('db200000-0000-4000-8000-000000000003','DASH-3','in_transit',-10)) v(id,n,s,d);
insert into public.shipment_transports(shipment_id,sequence_no,status) values
 ('db200000-0000-4000-8000-000000000001',1,'in_transit'),('db200000-0000-4000-8000-000000000001',2,'arrived'),
 ('db200000-0000-4000-8000-000000000003',1,'in_transit');
update public.shipments set status='cancelled' where id='db200000-0000-4000-8000-000000000003';
-- Decisions of the director: two unread approvals, a price review, a read blocked order; an overdue task; an order with a
-- line without a price.
insert into public.notifications(recipient_user_id,type,title,body) values
 ('db000000-0000-4000-8000-000000000001','approval_request','Согласуйте','1'),('db000000-0000-4000-8000-000000000001','approval_request','Согласуйте','2'),
 ('db000000-0000-4000-8000-000000000001','price_review','Проверьте цену','3'),('db000000-0000-4000-8000-000000000003','approval_request','Чужое','4');
insert into public.notifications(recipient_user_id,type,title,body,is_read,read_at) values
 ('db000000-0000-4000-8000-000000000001','order_blocked','Заказ','5',true,now());
insert into public.tasks(title,assignee_user_id,status,due_at) values ('Дашборд: просрочена','db000000-0000-4000-8000-000000000001','open',now()-interval '1 day');
insert into public.counterparties(id,roles,legal_name,country) values ('db100000-0000-4000-8000-000000000002',array['customer'],'Dash customer','KZ');
insert into public.products(id,internal_sku,name,manufacturer_id,status)
 values ('db300000-0000-4000-8000-000000000001','DASH-P','{"ru":"Товар дашборда"}','db100000-0000-4000-8000-000000000001','active');
insert into public.sales(id,sale_number,customer_id,warehouse_id,sale_date,planned_shipment_date,status,created_by)
 values ('db400000-0000-4000-8000-000000000001','DASH-S1','db100000-0000-4000-8000-000000000002',
         (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),current_date,current_date+2,'draft',
         'db000000-0000-4000-8000-000000000001');
insert into public.sale_items(sale_id,product_id,quantity,uom,unit_price) values ('db400000-0000-4000-8000-000000000001','db300000-0000-4000-8000-000000000001',3,'piece',null);

-- 1. Who sees the dashboard and which tiles.
select set_config('request.jwt.claim.sub','db000000-0000-4000-8000-000000000004',true);
set local role authenticated;
select pg_temp.fails($q$select public.executive_dashboard()$q$,'Нет доступа к дашборду руководителя');
select pg_temp.fails($q$select public.executive_dashboard_tile('cash')$q$,'Нет доступа к дашборду руководителя');
select set_config('request.jwt.claim.sub','db000000-0000-4000-8000-000000000001',true);
select pg_temp.fails($q$select public.executive_dashboard_tile('salary')$q$,'Неизвестная плитка');
select pg_temp.fails($q$select public.executive_dashboard((current_date+interval '1 month')::date)$q$,'не позже текущего');
do $$begin
 assert pg_temp.tiles(public.executive_dashboard())='{cash,decisions,payables,receivables,revenue,shelf_life,shipments}','the director: every tile';
end $$;
-- The commercial director: no finance, no shipments -> no payables, cash or shipments tiles, in the answer as on the screen.
select set_config('request.jwt.claim.sub','db000000-0000-4000-8000-000000000002',true);
do $$begin
 assert public.executive_dashboard_tile('cash') is null and public.executive_dashboard_tile('payables') is null;
 assert not (pg_temp.tiles(public.executive_dashboard()) && array['cash','payables']),'no tile without the rights to its data';
end $$;
-- The logistics director: shipments, no money of customers or payees.
select set_config('request.jwt.claim.sub','db000000-0000-4000-8000-000000000003',true);
do $$declare t text[] := pg_temp.tiles(public.executive_dashboard());begin
 assert not (t && array['receivables','payables','cash']),format('logistics: %s',t);
end $$;

-- 2. Shipments = operational_summary (and the vehicles on the road of open shipments).
select set_config('request.jwt.claim.sub','db000000-0000-4000-8000-000000000001',true);
do $$
declare t jsonb := public.executive_dashboard_tile('shipments'); s jsonb := public.operational_summary();
begin
 assert t->>'status'='ok' and (t->>'active')::integer=(s->'shipments'->>'active')::integer and (t->>'late')::integer=(s->'shipments'->>'late')::integer
    and (t->>'stages_late')::integer=(s->'stages'->>'late')::integer and (t->>'stages_blocked')::integer=(s->'stages'->>'blocked')::integer,
   'the same counts as the operational analytics';
 assert (t->>'in_transit')::integer=coalesce((s->'shipments'->'by_status'->>'in_transit')::integer,0)+coalesce((s->'shipments'->'by_status'->>'customs')::integer,0);
 assert (t->>'vehicles_on_road')::integer=(select count(*) from public.shipment_transports x join public.shipments y on y.id=x.shipment_id
                                           where x.status in ('in_transit','at_customs') and y.status not in ('closed','cancelled'));
 assert (t->>'vehicles_on_road')::integer>=1 and (t->>'late')::integer>=1,'DASH-1 is on the road and late';
end $$;

-- 3. Decisions: what waits for this employee only.
do $$declare t jsonb := public.executive_dashboard_tile('decisions');begin
 assert (t->>'approvals')::integer=2 and (t->>'price_reviews')::integer=1 and (t->>'blocked_orders')::integer=0,'own unread notifications only';
 assert (t->>'total')::integer=(t->>'approvals')::integer+(t->>'price_reviews')::integer+(t->>'tasks_overdue')::integer+(t->>'unpriced_orders')::integer;
 assert (t->>'tasks_overdue')::integer=(select count(*) from public.tasks where status not in ('done','cancelled') and due_at<now())
    and (t->>'tasks_overdue')::integer>=1;
 assert (t->>'unpriced_orders')::integer=(select count(distinct s.id) from public.sales s join public.sale_items i on i.sale_id=s.id
                                          where s.status in ('draft','reserved','confirmed') and i.unit_price is null)
    and (t->>'unpriced_orders')::integer>=1;
end $$;

-- 4. The whole dashboard is the tiles, one by one.
do $$
declare d jsonb := public.executive_dashboard(); k text;
begin
 assert (d->>'month')::date=date_trunc('month',current_date)::date;
 foreach k in array array['revenue','receivables','payables','cash','shelf_life','shipments','decisions'] loop
  assert (select x from jsonb_array_elements(d->'tiles') x where x->>'tile'=k)=public.executive_dashboard_tile(k),format('tile %s',k);
 end loop;
end $$;
reset role;

-- 5. A source that fails: its tile says "error" (no figures, no zero), the other tiles are there.
create or replace function public.operational_summary() returns jsonb language plpgsql stable security invoker set search_path='' as $$
begin raise exception 'source unavailable'; end $$;
select set_config('request.jwt.claim.sub','db000000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$
declare d jsonb := public.executive_dashboard(); t jsonb;
begin
 t := (select x from jsonb_array_elements(d->'tiles') x where x->>'tile'='shipments');
 assert t->>'status'='error' and not (t ? 'active') and not (t ? 'late'),'the failed tile carries no figure';
 assert (select count(*) from jsonb_array_elements(d->'tiles') x where x->>'status'='ok')=6,'the other six tiles are fine';
end $$;
reset role;

rollback;
\echo 'executive_dashboard: all checks passed'
