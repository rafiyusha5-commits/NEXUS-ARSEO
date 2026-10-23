-- Real dates of an executed shipment (202609277300): permission and reason, validation, stages, vehicles,
-- receipts with their batches, history, unchanged days keep their time, and a closed shipment can be corrected
-- through this function only (date columns only).
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('ec000000-0000-4000-8000-000000000001','dates-director@test.local','{"full_name":"Dates Director"}'),
 ('ec000000-0000-4000-8000-000000000002','dates-logistics@test.local','{"full_name":"Dates Logistics"}');
insert into public.user_roles(user_id,role_id) select v.u::uuid,r.id from (values
 ('ec000000-0000-4000-8000-000000000001','director'),('ec000000-0000-4000-8000-000000000002','senior_logistics_manager')) v(u,code)
 join public.app_roles r on r.code=v.code;
insert into public.counterparties(id,roles,legal_name,country,tax_id)
values('ec100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Dates supplier','FI','DATES-FI');
insert into public.products(id,internal_sku,name,manufacturer_id,status)
values('ec200000-0000-4000-8000-000000000001','DATES-001','{"ru":"Товар для дат"}','ec100000-0000-4000-8000-000000000001','active');

create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql; exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm; end if;
  return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on function pg_temp.fails(text,text) to authenticated;
create temporary table dc(shipment_id uuid,transport_id uuid,item_id uuid,receipt_id uuid,run_id uuid,pending_run_id uuid,today date);
grant select,insert,update on dc to authenticated;
insert into dc(today) values ((now() at time zone 'Asia/Almaty')::date);

-- An executed shipment entered today: the vehicle arrived and was received, all with today's stamps.
set role authenticated;
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000001',false);
update dc set shipment_id=public.create_shipment_with_stages(
 'DATES-1','import','ec100000-0000-4000-8000-000000000001',null,
 (select id from public.routes where status='active' order by created_at limit 1),
 (select id from public.currencies where code='EUR'),
 (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),
 'ec000000-0000-4000-8000-000000000001',today-30,today-10);
select public.add_shipment_transport(shipment_id) from dc;
update dc c set
 transport_id=(select t.id from public.shipment_transports t where t.shipment_id=c.shipment_id and t.sequence_no=1),
 item_id=public.create_shipment_item(c.shipment_id,'ec200000-0000-4000-8000-000000000001','piece',100,1,(select id from public.currencies where code='EUR'));
select public.allocate_shipment_item(item_id,transport_id,100) from dc;
select public.change_shipment_transport_status(transport_id,'arrived') from dc;
update dc set receipt_id=public.receive_shipment_transport(transport_id,null,jsonb_build_array(jsonb_build_object(
  'item_id',item_id,'accepted_quantity',100,'batch_number','DATES-BATCH','manufacture_date',(today-60)::text,'expiry_date',(today+300)::text)),
  'Кладовщик',null);
update dc c set
 run_id=(select run.id from public.shipment_stage_runs run join public.shipment_stages st on st.id=run.stage_id
         where run.shipment_id=c.shipment_id and run.shipment_transport_id=c.transport_id and st.code='warehouse_receiving'),
 pending_run_id=(select run.id from public.shipment_stage_runs run join public.shipment_stages st on st.id=run.stage_id
         where run.shipment_id=c.shipment_id and run.status='pending' order by st.sequence_order desc limit 1);
do $$ begin
 assert (select run_id is not null and pending_run_id is not null and receipt_id is not null from dc),'fixture is ready';
 assert (select actual_arrival_date=current_date from public.shipment_transports where id=(select transport_id from dc)),'arrival was stamped with today';
end $$;

-- ---------- permission and reason ----------
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000002',false);
select pg_temp.fails(format($$select public.correct_shipment_dates(%L,'{"transports":[{"id":"%s","actual_arrival_date":"2026-01-10"}]}','Ввод прошедшей поставки')$$,
 (select shipment_id from dc),(select transport_id from dc)),'Недостаточно прав');
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000001',false);
select pg_temp.fails(format($$select public.correct_shipment_dates(%L,'{"transports":[]}','  ')$$,(select shipment_id from dc)),'причину');
-- Nothing but these functions writes the history.
select pg_temp.fails(format($$insert into public.shipment_date_corrections(shipment_id,entity_type,entity_id,field,new_value,reason,corrected_by)
 values(%L,'transport',%L,'actual_arrival_date','2026-01-01','x','ec000000-0000-4000-8000-000000000001')$$,(select shipment_id from dc),(select transport_id from dc)),'permission denied');

-- ---------- validation ----------
create function pg_temp.correct(p_changes jsonb) returns jsonb language sql as $$
 select public.correct_shipment_dates((select shipment_id from dc),p_changes,'Ввод прошедшей поставки')
$$;
grant execute on function pg_temp.correct(jsonb) to authenticated;
select pg_temp.fails($$select pg_temp.correct(jsonb_build_object('transports',jsonb_build_array(jsonb_build_object('id',(select transport_id from dc),'actual_arrival_date',((select today from dc)+1)::text))))$$,'в будущем');
select pg_temp.fails($$select pg_temp.correct(jsonb_build_object('transports',jsonb_build_array(jsonb_build_object('id',(select transport_id from dc),'actual_arrival_date','10.01.2026'))))$$,'ГГГГ-ММ-ДД');
select pg_temp.fails($$select pg_temp.correct(jsonb_build_object('transports',jsonb_build_array(jsonb_build_object('id',(select transport_id from dc),'actual_arrival_date','2026-02-30'))))$$,'такой даты нет');
select pg_temp.fails($$select pg_temp.correct(jsonb_build_object('transports',jsonb_build_array(jsonb_build_object('id',(select transport_id from dc),
  'actual_loading_date',((select today from dc)-5)::text,'actual_arrival_date',((select today from dc)-6)::text))))$$,'погрузка позже прибытия');
select pg_temp.fails($$select pg_temp.correct(jsonb_build_object('stages',jsonb_build_array(jsonb_build_object('id',(select pending_run_id from dc),'started_on',((select today from dc)-5)::text))))$$,'не начат');
select pg_temp.fails($$select pg_temp.correct(jsonb_build_object('stages',jsonb_build_array(jsonb_build_object('id',(select run_id from dc),
  'started_on',((select today from dc)-3)::text,'completed_on',((select today from dc)-4)::text))))$$,'начало позже завершения');
select pg_temp.fails($$select pg_temp.correct(jsonb_build_object('receipts',jsonb_build_array(jsonb_build_object('id',(select receipt_id from dc),'received_on',((select today from dc)-40)::text))))$$,'приёмка раньше прибытия');
select pg_temp.fails($$select pg_temp.correct(jsonb_build_object('transports',jsonb_build_array(jsonb_build_object('id','ec900000-0000-4000-8000-000000000001','actual_arrival_date','2026-01-10'))))$$,'не относится к этой поставке');
select pg_temp.fails($$select pg_temp.correct('{"shipment":[]}')$$,'Некорректные изменения');
do $$ begin
 assert not exists(select 1 from public.shipment_date_corrections),'refused corrections left no history';
 assert (select actual_arrival_date=current_date from public.shipment_transports where id=(select transport_id from dc)),'refused corrections changed nothing';
end $$;

-- ---------- the real dates ----------
do $$
declare c dc%rowtype; r jsonb; v_batch_received timestamptz; v_receipt_received timestamptz;
begin
 select * into c from dc;
 r:=pg_temp.correct(jsonb_build_object(
   'transports',jsonb_build_array(jsonb_build_object('id',c.transport_id,'actual_loading_date',(c.today-20)::text,'actual_arrival_date',(c.today-10)::text)),
   'receipts',jsonb_build_array(jsonb_build_object('id',c.receipt_id,'received_on',(c.today-9)::text)),
   'stages',jsonb_build_array(jsonb_build_object('id',c.run_id,'started_on',(c.today-9)::text,'completed_on',(c.today-9)::text))));
 assert (r->>'changed')::int=5,'five dates corrected (loading, arrival, receipt, stage start and completion): '||r::text;
 assert (select actual_loading_date=c.today-20 and actual_arrival_date=c.today-10 from public.shipment_transports where id=c.transport_id),'vehicle dates';
 select received_at into v_receipt_received from public.shipment_transport_receipts where id=c.receipt_id;
 assert (v_receipt_received at time zone 'Asia/Almaty')::date=c.today-9,'receipt day';
 assert (v_receipt_received at time zone 'UTC')::date=c.today-9,'midday in Almaty is the same day in UTC';
 select b.received_at into v_batch_received from public.inventory_batches b where b.source_shipment_transport_id=c.transport_id;
 assert v_batch_received=v_receipt_received,'the batch of the receipt gets the same day (FIFO order)';
 assert (select (started_at at time zone 'Asia/Almaty')::date=c.today-9 and (completed_at at time zone 'Asia/Almaty')::date=c.today-9
         from public.shipment_stage_runs where id=c.run_id),'stage dates';
 assert (select count(*)=5 from public.shipment_date_corrections where shipment_id=c.shipment_id and reason='Ввод прошедшей поставки'
         and corrected_by='ec000000-0000-4000-8000-000000000001'),'history with reason and employee';
 assert (select previous_value=current_date::text and new_value=(c.today-10)::text from public.shipment_date_corrections
         where entity_id=c.transport_id and field='actual_arrival_date'),'history keeps the previous value';
 -- The same days again: nothing changes.
 r:=pg_temp.correct(jsonb_build_object('transports',jsonb_build_array(jsonb_build_object('id',c.transport_id,'actual_arrival_date',(c.today-10)::text)),
   'receipts',jsonb_build_array(jsonb_build_object('id',c.receipt_id,'received_on',(c.today-9)::text))));
 assert (r->>'changed')::int=0 and (select count(*)=5 from public.shipment_date_corrections),'unchanged days add nothing';
end $$;
-- A day that is already stored keeps its exact time.
do $$
declare c dc%rowtype; v_before timestamptz; r jsonb;
begin
 select * into c from dc;
 select completed_at into v_before from public.shipment_stage_runs run join public.shipment_stages st on st.id=run.stage_id
 where run.shipment_id=c.shipment_id and st.code='quantity_check' and run.shipment_transport_id=c.transport_id;
 r:=pg_temp.correct(jsonb_build_object('stages',jsonb_build_array(jsonb_build_object('id',
   (select run.id from public.shipment_stage_runs run join public.shipment_stages st on st.id=run.stage_id where run.shipment_id=c.shipment_id and st.code='quantity_check' and run.shipment_transport_id=c.transport_id),
   'completed_on',((v_before at time zone 'Asia/Almaty')::date)::text))));
 assert (r->>'changed')::int=0,'the same day is not rewritten';
 assert (select completed_at=v_before from public.shipment_stage_runs run join public.shipment_stages st on st.id=run.stage_id
         where run.shipment_id=c.shipment_id and st.code='quantity_check' and run.shipment_transport_id=c.transport_id),'time kept';
end $$;

-- ---------- a closed shipment: dates only, through this function only ----------
reset role;
set session_replication_role=replica;
update public.shipments set status='closed',is_locked=true where id=(select shipment_id from dc);
set session_replication_role=origin;
set role authenticated;
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000001',false);
do $$
declare c dc%rowtype; r jsonb;
begin
 select * into c from dc;
 r:=pg_temp.correct(jsonb_build_object('stages',jsonb_build_array(jsonb_build_object('id',c.run_id,'completed_on',(c.today-8)::text))));
 assert (r->>'changed')::int=1,'a closed shipment gets its real dates';
 assert (select status='closed' and is_locked from public.shipments where id=c.shipment_id),'and stays closed';
end $$;
-- Other functions still refuse the closed shipment, even with the correction flag set by the caller.
select set_config('nexus.shipment_date_correction',(select shipment_id::text from dc),false);
select pg_temp.fails($$select public.change_shipment_stage_status((select run_id from dc),'in_progress')$$,'Закрытая поставка');
select pg_temp.fails($$update public.shipment_stage_runs set completed_at=now() where id=(select run_id from dc)$$,'permission denied');
reset role;
-- Even a writer with table rights cannot change anything but the dates under the flag.
select pg_temp.fails($$update public.shipment_stage_runs set status='in_progress' where id=(select run_id from dc)$$,'недоступна для изменений');
select pg_temp.fails($$update public.shipment_transports set driver_name='X', actual_arrival_date=actual_arrival_date where id=(select transport_id from dc)$$,'недоступна для изменений');
select set_config('nexus.shipment_date_correction','',false);
select pg_temp.fails($$update public.shipment_stage_runs set completed_at=now() where id=(select run_id from dc)$$,'недоступна для изменений');

-- ---------- a cancelled shipment ----------
set session_replication_role=replica;
update public.shipments set status='cancelled' where id=(select shipment_id from dc);
set session_replication_role=origin;
set role authenticated;
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000001',false);
select pg_temp.fails($$select pg_temp.correct(jsonb_build_object('transports',jsonb_build_array(jsonb_build_object('id',(select transport_id from dc),'actual_arrival_date',((select today from dc)-11)::text))))$$,'отменённой');

reset role;
rollback;
