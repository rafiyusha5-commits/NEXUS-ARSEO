-- 202611170600: Telegram delivery of Nexus notifications. Synthetic data only, no Telegram call (the worker part is
-- tested in tests/telegram/notifications.test.ts with a fake bot). Everything is rolled back.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('ab700000-0000-4000-8000-000000000001','tg-one@example.invalid','{"full_name":"Telegram one"}'),
 ('ab700000-0000-4000-8000-000000000002','tg-two@example.invalid','{"full_name":"Telegram two"}'),
 ('ab700000-0000-4000-8000-000000000003','tg-logistics@example.invalid','{"full_name":"Logistics"}');
insert into public.user_roles(user_id,role_id) select u.id,r.id from (values
 ('ab700000-0000-4000-8000-000000000001'::uuid,'director'),('ab700000-0000-4000-8000-000000000002'::uuid,'director'),
 ('ab700000-0000-4000-8000-000000000003'::uuid,'logistics_specialist')) u(id,code) join public.app_roles r on r.code=u.code;
create temporary table d7(k text primary key,id uuid);
grant all on d7 to authenticated;
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
-- A notification as the database creates it (private.notify is what the rules call).
create function pg_temp.note(p_user uuid,p_type text,p_entity_type text,p_entity uuid,p_title text default 'Синтетика') returns uuid
language plpgsql as $$declare v uuid;begin
 insert into public.notifications(recipient_user_id,type,title,body,entity_type,entity_id) values(p_user,p_type,p_title,'Сумма 1 250 000,00 KZT',p_entity_type,p_entity)
 returning id into v;return v;end $$;
create function pg_temp.delivery(p_note uuid) returns public.notification_deliveries language sql stable as $$
 select * from public.notification_deliveries where notification_id=p_note and channel='telegram' $$;
-- 10:00 and 22:00 in Kazakhstan tomorrow (always after the deliveries were queued, whatever the hour of the run).
create function pg_temp.at(p_hour int) returns timestamptz language sql stable as $$
 select (current_date + 1 + make_time(p_hour,0,0)) at time zone 'Asia/Almaty' $$;
grant execute on all functions in schema pg_temp to authenticated;

-- 1. Off by default; turning on needs a linked chat and only the listed action types.
select set_config('request.jwt.claim.sub','ab700000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$begin
 assert (public.my_telegram_notifications()->>'enabled')::boolean is false and (public.my_telegram_notifications()->>'linked')::boolean is false;
end $$;
select pg_temp.fails($q$select public.set_my_telegram_notifications(true,array['task_assigned'])$q$,'подключите личный чат');
reset role;
insert into public.telegram_links(user_id,chat_id,display_name,linked_at) values
 ('ab700000-0000-4000-8000-000000000001',7001,'Чат один',now()),('ab700000-0000-4000-8000-000000000002',7002,'Чат два',now());
set local role authenticated;
select pg_temp.fails($q$select public.set_my_telegram_notifications(true,array['document_uploaded'])$q$,'из списка');
select public.set_my_telegram_notifications(true,array['task_assigned','order_blocked','task_assigned']);
do $$begin
 assert public.my_telegram_notifications()->'types'='["order_blocked", "task_assigned"]'::jsonb,'own settings, duplicates removed';
end $$;
select pg_temp.fails($q$select * from public.telegram_notification_settings$q$,'permission denied');
select pg_temp.fails($q$select public.telegram_notification_batch(10)$q$,'permission denied');
reset role;

-- 2. Queue: only chosen action types of employees who turned it on; informational ones never.
insert into d7 values
 ('task',pg_temp.note('ab700000-0000-4000-8000-000000000001','task_assigned','task',gen_random_uuid())),
 ('order',pg_temp.note('ab700000-0000-4000-8000-000000000001','order_blocked','sale','ab710000-0000-4000-8000-000000000001')),
 ('info',pg_temp.note('ab700000-0000-4000-8000-000000000001','document_uploaded','document',gen_random_uuid())),
 ('not_chosen',pg_temp.note('ab700000-0000-4000-8000-000000000001','overdue','task',gen_random_uuid())),
 ('other_user',pg_temp.note('ab700000-0000-4000-8000-000000000002','task_assigned','task',gen_random_uuid())),
 -- The same reminder about the same order within a day: recorded as throttled, not queued.
 ('order_again',pg_temp.note('ab700000-0000-4000-8000-000000000001','order_blocked','sale','ab710000-0000-4000-8000-000000000001'));
do $$begin
 assert (pg_temp.delivery((select id from d7 where k='task'))).status='queued';
 assert (pg_temp.delivery((select id from d7 where k='order'))).status='queued';
 assert (pg_temp.delivery((select id from d7 where k='info'))).id is null,'informational: no Telegram';
 assert (pg_temp.delivery((select id from d7 where k='not_chosen'))).id is null,'type not chosen';
 assert (pg_temp.delivery((select id from d7 where k='other_user'))).id is null,'employee did not turn it on';
 assert (pg_temp.delivery((select id from d7 where k='order_again'))).status='skipped'
   and (pg_temp.delivery((select id from d7 where k='order_again'))).error_message='throttled';
end $$;

-- 3. Quiet hours: nothing is claimed at 22:00 Kazakhstan time.
do $$begin
 assert (public.telegram_notification_batch(50,pg_temp.at(22))->>'quiet')::boolean;
 assert (pg_temp.delivery((select id from d7 where k='task'))).status='queued';
end $$;

-- 4. Claim at 10:00: both for employee one, in one group; a second (parallel) claim gets nothing.
create temporary table b(k text primary key,v jsonb);
insert into b select 'first',public.telegram_notification_batch(50,pg_temp.at(10));
insert into b select 'second',public.telegram_notification_batch(50,pg_temp.at(10));
do $$
declare u jsonb;
begin
 select x into u from jsonb_array_elements((select v->'users' from b where k='first')) x where x->>'user_id'='ab700000-0000-4000-8000-000000000001';
 assert u->>'chat_id'='7001' and jsonb_array_length(u->'items')=2;
 assert u::text !~ 'Сумма|1 250 000|Синтетика','the batch carries no title or body: the text is fixed per type';
 assert jsonb_array_length((select v->'users' from b where k='second'))=0,'claimed deliveries are not claimed twice';
end $$;

-- 5. Outcomes: sent; a definite refusal is retried a limited number of times; outcome unknown is never resent.
select public.telegram_notification_result((select (v->>'token')::uuid from b where k='first'),
 array[(pg_temp.delivery((select id from d7 where k='task'))).id],'sent',555);
select public.telegram_notification_result((select (v->>'token')::uuid from b where k='first'),
 array[(pg_temp.delivery((select id from d7 where k='order'))).id],'retry',null,'TELEGRAM_RATE_LIMIT',30);
do $$begin
 assert (pg_temp.delivery((select id from d7 where k='task'))).status='sent' and (pg_temp.delivery((select id from d7 where k='task'))).external_message_id=555;
 assert (pg_temp.delivery((select id from d7 where k='order'))).status='queued' and (pg_temp.delivery((select id from d7 where k='order'))).attempts=1;
 -- Repeating the result with the old token changes nothing.
 assert public.telegram_notification_result((select (v->>'token')::uuid from b where k='first'),
   array[(pg_temp.delivery((select id from d7 where k='task'))).id],'sent',556)=0;
end $$;
update public.notification_deliveries set attempts=5,next_attempt_at=now()-interval '1 minute' where notification_id=(select id from d7 where k='order') and channel='telegram';
insert into b select 'third',public.telegram_notification_batch(50,pg_temp.at(10)+interval '2 hours');
select public.telegram_notification_result((select (v->>'token')::uuid from b where k='third'),
 array[(pg_temp.delivery((select id from d7 where k='order'))).id],'retry',null,'TELEGRAM_UNREACHABLE');
do $$begin
 assert (pg_temp.delivery((select id from d7 where k='order'))).status='failed'
   and (pg_temp.delivery((select id from d7 where k='order'))).error_message like 'retries_exhausted:%','limited retries';
 assert exists(select 1 from public.notifications where id=(select id from d7 where k='order')),'the in-app notification stays';
end $$;
-- A worker that crashed while sending: the delivery fails as "outcome unknown", it is never claimed again.
insert into d7 values('crash',pg_temp.note('ab700000-0000-4000-8000-000000000001','task_assigned','task',gen_random_uuid()));
insert into b select 'crash',public.telegram_notification_batch(50,pg_temp.at(10));
update public.notification_deliveries set claimed_until=now()-interval '1 second' where notification_id=(select id from d7 where k='crash') and channel='telegram';
insert into b select 'after_crash',public.telegram_notification_batch(50,pg_temp.at(10));
do $$begin
 assert (pg_temp.delivery((select id from d7 where k='crash'))).status='failed' and (pg_temp.delivery((select id from d7 where k='crash'))).error_message='outcome_unknown';
 assert jsonb_array_length((select v->'users' from b where k='after_crash'))=0;
end $$;

-- 6. Checked again at sending: lost access, unlinked chat and turned off are skipped, nothing is sent.
insert into d7 values('lost',pg_temp.note('ab700000-0000-4000-8000-000000000001','order_blocked','sale',gen_random_uuid()));
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'ab700000-0000-4000-8000-000000000001',id,'deny','Lost access','ab700000-0000-4000-8000-000000000002' from public.permissions where code='sales.view';
insert into d7 values('unlinked',pg_temp.note('ab700000-0000-4000-8000-000000000001','task_assigned','task',gen_random_uuid()));
insert into b select 'recheck',public.telegram_notification_batch(50,pg_temp.at(10));
do $$begin
 assert (pg_temp.delivery((select id from d7 where k='lost'))).status='skipped' and (pg_temp.delivery((select id from d7 where k='lost'))).error_message='no_access';
 assert (pg_temp.delivery((select id from d7 where k='unlinked'))).status='sending','still allowed';
end $$;
update public.telegram_links set chat_id=null where user_id='ab700000-0000-4000-8000-000000000001';
insert into d7 values('no_chat',pg_temp.note('ab700000-0000-4000-8000-000000000001','task_assigned','task',gen_random_uuid()));
insert into b select 'no_chat',public.telegram_notification_batch(50,pg_temp.at(10));
do $$begin
 assert (pg_temp.delivery((select id from d7 where k='no_chat'))).error_message='chat_not_linked';
end $$;
update public.telegram_links set chat_id=7001 where user_id='ab700000-0000-4000-8000-000000000001';
update public.telegram_notification_settings set enabled=false where user_id='ab700000-0000-4000-8000-000000000001';
insert into d7 values('queued_then_off',gen_random_uuid());
-- (queued while on, then turned off)
update public.telegram_notification_settings set enabled=true where user_id='ab700000-0000-4000-8000-000000000001';
update d7 set id=pg_temp.note('ab700000-0000-4000-8000-000000000001','task_assigned','task',gen_random_uuid()) where k='queued_then_off';
update public.telegram_notification_settings set enabled=false where user_id='ab700000-0000-4000-8000-000000000001';
insert into b select 'off',public.telegram_notification_batch(50,pg_temp.at(10));
do $$begin
 assert (pg_temp.delivery((select id from d7 where k='queued_then_off'))).error_message='disabled';
end $$;

-- 7. Stale (the bot was off for more than 12 hours): one summary line instead of the old messages.
update public.telegram_notification_settings set enabled=true where user_id='ab700000-0000-4000-8000-000000000001';
insert into d7 values('old',pg_temp.note('ab700000-0000-4000-8000-000000000001','task_assigned','task',gen_random_uuid()));
update public.notification_deliveries set created_at=pg_temp.at(10)-interval '13 hours' where notification_id=(select id from d7 where k='old') and channel='telegram';
insert into b select 'stale',public.telegram_notification_batch(50,pg_temp.at(10));
do $$begin
 assert (select bool_or((i->>'stale')::boolean) from jsonb_array_elements((select v->'users'->0->'items' from b where k='stale')) i);
 assert ((select v->'users'->0->>'unread' from b where k='stale'))::int>=1;
end $$;
select public.telegram_notification_result((select (v->>'token')::uuid from b where k='stale'),
 array[(pg_temp.delivery((select id from d7 where k='old'))).id],'sent',777);
do $$begin
 assert (pg_temp.delivery((select id from d7 where k='old'))).status='skipped' and (pg_temp.delivery((select id from d7 where k='old'))).error_message='stale_summarized';
end $$;

-- 8. The administrator sees who has it on; nobody else; nobody can turn it on for another employee.
select set_config('request.jwt.claim.sub','ab700000-0000-4000-8000-000000000003',true);
set local role authenticated;
select pg_temp.fails($q$select public.telegram_notification_overview()$q$,'Нет доступа');
reset role;
do $$begin
 assert not has_function_privilege('authenticated','public.telegram_notification_batch(integer,timestamptz)','execute');
 assert not has_function_privilege('authenticated','public.telegram_notification_result(uuid,uuid[],text,bigint,text,integer)','execute');
 assert has_function_privilege('service_role','public.telegram_notification_batch(integer,timestamptz)','execute');
 assert not has_function_privilege('anon','public.set_my_telegram_notifications(boolean,text[])','execute');
end $$;
rollback;
\echo telegram_notifications: all checks passed
