\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('dc630000-0000-4000-8000-000000000001','delivery-admin@test.local','{"full_name":"Delivery test"}'),
 ('dc630000-0000-4000-8000-000000000002','delivery-other@test.local','{"full_name":"Other test"}');
insert into public.user_roles(user_id,role_id) select 'dc630000-0000-4000-8000-000000000001',id from public.app_roles where code='administrator';
insert into public.telegram_links(user_id,chat_id,linked_at) values('dc630000-0000-4000-8000-000000000001',63001,now());
do $$begin
 assert (select provolatile='s' and prosecdef from pg_proc where oid='public.telegram_authorize_delivery(bigint,text,uuid,jsonb)'::regprocedure),'one stable statement snapshot, no fresh internal snapshots';
 assert has_function_privilege('service_role','public.telegram_authorize_delivery(bigint,text,uuid,jsonb)','execute');
 assert not has_function_privilege('authenticated','public.telegram_authorize_delivery(bigint,text,uuid,jsonb)','execute');
 assert not has_function_privilege('anon','public.telegram_authorize_delivery(bigint,text,uuid,jsonb)','execute');
 assert not has_table_privilege('service_role','public.drive_catalog_text','select');
end$$;
set local role service_role;
select set_config('tests.delivery_token',public.telegram_claim_update(63001,63001),true);
select public.telegram_update_progress(63001,current_setting('tests.delivery_token'),'session','dc630000-0000-4000-8000-000000000001',null,null);
do $$begin
 assert not public.telegram_authorize_delivery(63001,current_setting('tests.delivery_token'),'dc630000-0000-4000-8000-000000000001','[]'),'no authorization before delivery mark';
 assert public.telegram_update_status(63001,current_setting('tests.delivery_token'),'delivery_started');
 assert public.telegram_authorize_delivery(63001,current_setting('tests.delivery_token'),'dc630000-0000-4000-8000-000000000001','[{"all":["documents.drive.view"],"any":["prices.purchase.view","nonexistent.permission"]}]'),'bound authorized employee';
 assert not public.telegram_authorize_delivery(63001,'wrong','dc630000-0000-4000-8000-000000000001','[]'),'claim required';
 assert not public.telegram_authorize_delivery(63001,current_setting('tests.delivery_token'),'dc630000-0000-4000-8000-000000000002','[]'),'expected employee required';
 assert not public.telegram_authorize_delivery(63001,current_setting('tests.delivery_token'),'dc630000-0000-4000-8000-000000000001','[{"all":["nonexistent.permission"],"any":[]}]'),'all required';
 assert not public.telegram_authorize_delivery(63001,current_setting('tests.delivery_token'),'dc630000-0000-4000-8000-000000000001','[{"all":[],"any":["nonexistent.permission"]}]'),'any required';
 assert not public.telegram_authorize_delivery(63001,current_setting('tests.delivery_token'),'dc630000-0000-4000-8000-000000000001','{}'),'malformed denied';
end$$;
reset role;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'dc630000-0000-4000-8000-000000000001',id,'deny','Delivery test','dc630000-0000-4000-8000-000000000001' from public.permissions where code='prices.purchase.view';
set local role service_role;
do $$begin
 assert not public.telegram_authorize_delivery(63001,current_setting('tests.delivery_token'),'dc630000-0000-4000-8000-000000000001','[{"all":["prices.purchase.view"],"any":[]}]'),'personal deny wins';
end$$;
reset role;
-- Binding changes committed between the old link check and final authorization.
update public.telegram_links set chat_id=null where user_id='dc630000-0000-4000-8000-000000000001';
set local role service_role;
do $$begin
 assert not public.telegram_authorize_delivery(63001,current_setting('tests.delivery_token'),'dc630000-0000-4000-8000-000000000001','[]'),'unlinked during processing: no send';
end$$;
reset role;
insert into public.telegram_links(user_id,chat_id,linked_at) values('dc630000-0000-4000-8000-000000000002',63001,now());
set local role service_role;
do $$begin
 assert not public.telegram_authorize_delivery(63001,current_setting('tests.delivery_token'),'dc630000-0000-4000-8000-000000000001','[]'),'relinked chat: no send';
end$$;
reset role;
rollback;
