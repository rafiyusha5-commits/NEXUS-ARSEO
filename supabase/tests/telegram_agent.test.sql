\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('bf530000-0000-4000-8000-000000000001','tg-employee@test.local','{"full_name":"Telegram employee"}'),
 ('bf530000-0000-4000-8000-000000000002','tg-other@test.local','{"full_name":"Other employee"}');
insert into public.user_roles(user_id,role_id) select u.id::uuid,r.id from (values
 ('bf530000-0000-4000-8000-000000000001'),('bf530000-0000-4000-8000-000000000002'))u(id)
 cross join public.app_roles r where r.code='logistics_specialist';

do $$begin
 assert not has_table_privilege('authenticated','public.telegram_link_codes','select'),'codes stay private';
 assert not has_table_privilege('service_role','public.telegram_link_codes','select'),'server uses only bounded RPCs';
 assert not has_table_privilege('authenticated','public.telegram_links','update'),'employees cannot bind chat IDs directly';
 assert not has_function_privilege('authenticated','public.telegram_employee(bigint)','execute'),'employees cannot resolve another chat';
 assert not has_function_privilege('anon','public.create_my_telegram_code()','execute'),'anon cannot link';
 assert not has_function_privilege('service_role','public.confirm_my_telegram_link()','execute'),'only employee confirms';
end$$;

set local role authenticated;
select set_config('request.jwt.claim.sub','bf530000-0000-4000-8000-000000000001',true);
select public.create_my_telegram_code() as link_code \gset
reset role;
do $$begin assert (select length(code_hash)=64 from public.telegram_link_codes where user_id='bf530000-0000-4000-8000-000000000001'),'only code hash stored';end$$;
set local role service_role;
select public.telegram_request_link(:'link_code',123456,'Owner') as requested \gset
\if :requested
\else
\quit 1
\endif
select public.telegram_request_link(:'link_code',999999,'Attacker') as reused \gset
\if :reused
\quit 1
\endif
do $$begin assert public.telegram_employee(123456) is null,'pending chat gets no business access';end$$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','bf530000-0000-4000-8000-000000000002',true);
do $$begin assert (select count(*) from public.telegram_links)=0,'other employee cannot see link';end$$;
select set_config('request.jwt.claim.sub','bf530000-0000-4000-8000-000000000001',true);
select public.confirm_my_telegram_link();
reset role;
set local role service_role;
do $$begin assert public.telegram_employee(123456)='bf530000-0000-4000-8000-000000000001'::uuid,'confirmed link resolves owner';end$$;
select public.telegram_claim_update(12345,123456) as update_token \gset
do $$begin assert public.telegram_claim_update(12345,123456) is null,'duplicate update is not run twice';end$$;
select public.telegram_update_status(12345,'wrong','delivery_started') as wrong_token \gset
\if :wrong_token
\quit 1
\endif
select public.telegram_update_status(12345,:'update_token','delivery_started') as delivering \gset
\if :delivering
\else
\quit 1
\endif
select public.telegram_update_status(12345,:'update_token','delivery_started') as redelivery \gset
\if :redelivery
\quit 1
\endif
select public.telegram_update_status(12345,:'update_token','completed');
reset role;
update public.profiles set is_active=false where id='bf530000-0000-4000-8000-000000000001';
set local role service_role;
do $$begin assert public.telegram_employee(123456) is null,'deactivated owner loses Telegram access';end$$;
select public.telegram_unlink_chat(123456);
reset role;
do $$begin assert not exists(select 1 from public.telegram_links where chat_id=123456),'unlink removes access';end$$;
rollback;
