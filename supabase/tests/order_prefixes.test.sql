-- 202611220200: order prefixes name the customer of a Drive order folder. Read with shipments.view, changed with
-- shipments.create; a customer prefix names an active customer, an own-stock prefix none. Synthetic data; rolled back.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('af100000-0000-4000-8000-000000000001','prefix-director@example.invalid','{"full_name":"Prefix director"}'),
 ('af100000-0000-4000-8000-000000000002','prefix-viewer@example.invalid','{"full_name":"Prefix viewer"}');
insert into public.user_roles(user_id,role_id) select u,id from public.app_roles,
 (values('af100000-0000-4000-8000-000000000001'::uuid),('af100000-0000-4000-8000-000000000002'::uuid)) v(u) where code='director';
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'af100000-0000-4000-8000-000000000002',id,'deny','Viewer only','af100000-0000-4000-8000-000000000001'
 from public.permissions where code='shipments.create';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('af110000-0000-4000-8000-000000000001',array['customer'],'Prefix customer','RU','AF1-C'),
 ('af110000-0000-4000-8000-000000000002',array['manufacturer','supplier'],'Prefix supplier','FI','AF1-S');
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub','af100000-0000-4000-8000-000000000001',true);
-- 1. A customer prefix and an own-stock prefix.
select public.set_order_prefix('QX','af110000-0000-4000-8000-000000000001',false,'Synthetic customer');
select public.set_order_prefix('QZ',null,true,null);
-- 2. The same letters in another case replace the entry instead of adding a second one.
select public.set_order_prefix('qx','af110000-0000-4000-8000-000000000001',false,null);
do $$begin
 assert (select count(*) from public.order_prefixes where upper(prefix)='QX')=1,'one entry per prefix';
 assert (select prefix from public.order_prefixes where upper(prefix)='QX')='qx';
 assert (select is_own_stock and counterparty_id is null from public.order_prefixes where prefix='QZ');
end $$;
-- 3. Bad input is refused.
select pg_temp.fails($q$select public.set_order_prefix('Q-1','af110000-0000-4000-8000-000000000001',false)$q$,'латинских букв');
select pg_temp.fails($q$select public.set_order_prefix('QY','af110000-0000-4000-8000-000000000002',false)$q$,'активного клиента');
select pg_temp.fails($q$select public.set_order_prefix('QY',null,false)$q$,'активного клиента');
select pg_temp.fails($q$select public.set_order_prefix('QY','af110000-0000-4000-8000-000000000001',true)$q$,'своих складов');
select pg_temp.fails($q$insert into public.order_prefixes(prefix,is_own_stock) values ('QW',true)$q$,'permission denied');
-- 4. Removal.
select public.remove_order_prefix('qz');
do $$begin assert not exists(select 1 from public.order_prefixes where upper(prefix)='QZ'); end $$;

-- 5. Without shipments.create the list is readable but not changeable.
select set_config('request.jwt.claim.sub','af100000-0000-4000-8000-000000000002',true);
do $$begin assert exists(select 1 from public.order_prefixes where upper(prefix)='QX'),'viewer reads the list'; end $$;
select pg_temp.fails($q$select public.set_order_prefix('QV',null,true)$q$,'Нет права');
select pg_temp.fails($q$select public.remove_order_prefix('QX')$q$,'Нет права');
reset role;
do $$begin
 assert not has_table_privilege('anon','public.order_prefixes','select');
 assert not has_function_privilege('anon','public.set_order_prefix(text,uuid,boolean,text)','execute');
end $$;
\echo order_prefixes: all checks passed
rollback;
