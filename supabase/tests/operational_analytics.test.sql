\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('c9000000-0000-4000-8000-000000000001','analytics-specialist@test.local','{"full_name":"Analytics Specialist"}');
insert into public.user_roles(user_id,role_id)
select 'c9000000-0000-4000-8000-000000000001',id from public.app_roles where code='logistics_specialist';

set role authenticated;
select set_config('request.jwt.claim.sub','c9000000-0000-4000-8000-000000000001',false);
do $$begin
 assert private.has_permission('reports.view'),'specialist can open operational analytics';
end$$;
reset role;

insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'c9000000-0000-4000-8000-000000000001',id,'deny','analytics test','c9000000-0000-4000-8000-000000000001'
from public.permissions where code='reports.view';

set role authenticated;
select set_config('request.jwt.claim.sub','c9000000-0000-4000-8000-000000000001',false);
do $$begin
 assert not private.has_permission('reports.view'),'personal deny closes analytics';
end$$;
reset role;

rollback;
