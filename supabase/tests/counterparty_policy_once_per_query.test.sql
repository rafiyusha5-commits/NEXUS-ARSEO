-- 202611250200: counterparty policies check permissions once per query, with the same rule as
-- private.can_access_counterparty. Synthetic data; rolled back.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('cf000000-0000-4000-8000-000000000001','cp-director@example.invalid','{"full_name":"Counterparty director"}'),
 ('cf000000-0000-4000-8000-000000000002','cp-no-customers@example.invalid','{"full_name":"No customers"}'),
 ('cf000000-0000-4000-8000-000000000003','cp-no-suppliers@example.invalid','{"full_name":"No suppliers"}');
insert into public.user_roles(user_id,role_id)
select u::uuid,(select id from public.app_roles where code='director') from (values
 ('cf000000-0000-4000-8000-000000000001'),('cf000000-0000-4000-8000-000000000002'),('cf000000-0000-4000-8000-000000000003')) v(u);
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select x.u::uuid,p.id,'deny','counterparty policy test','cf000000-0000-4000-8000-000000000001' from (values
 ('cf000000-0000-4000-8000-000000000002','customers.view'),('cf000000-0000-4000-8000-000000000002','customers.create'),
 ('cf000000-0000-4000-8000-000000000002','customers.update'),
 ('cf000000-0000-4000-8000-000000000003','suppliers.view'),('cf000000-0000-4000-8000-000000000003','suppliers.create'),
 ('cf000000-0000-4000-8000-000000000003','suppliers.update')) x(u,code) join public.permissions p on p.code=x.code;
-- Every kind of party, and one with two roles.
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('cf100000-0000-4000-8000-000000000001',array['customer'],'CP customer','KZ','CP-1'),
 ('cf100000-0000-4000-8000-000000000002',array['manufacturer','supplier'],'CP factory','TR','CP-2'),
 ('cf100000-0000-4000-8000-000000000003',array['carrier'],'CP carrier','KZ','CP-3'),
 ('cf100000-0000-4000-8000-000000000004',array['customer','supplier'],'CP both','KZ','CP-4'),
 ('cf100000-0000-4000-8000-000000000005',array['printing_house'],'CP printer','KZ','CP-5'),
 ('cf100000-0000-4000-8000-000000000006',array['broker','other'],'CP broker','KZ','CP-6');
create function pg_temp.as_user(p_user text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub',p_user,true);
  perform set_config('request.jwt.claims',json_build_object('sub',p_user,'role','authenticated')::text,true);
end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- 1. Each user sees exactly what the old rule (can_access_counterparty) allows.
do $$
declare u uuid; expected uuid[]; actual uuid[];
begin
  foreach u in array array['cf000000-0000-4000-8000-000000000001','cf000000-0000-4000-8000-000000000002','cf000000-0000-4000-8000-000000000003']::uuid[] loop
    perform pg_temp.as_user(u::text);
    select array_agg(id order by id) into expected from public.counterparties
     where tax_id like 'CP-%' and private.can_access_counterparty('view',roles);
    execute 'set local role authenticated';
    select array_agg(id order by id) into actual from public.counterparties where tax_id like 'CP-%';
    execute 'reset role';
    assert actual is not distinct from expected, format('user %s: sees %s, the rule allows %s', u, actual, expected);
  end loop;
end $$;
-- The same sets spelled out: no customers → every party with a supplier-side role; no suppliers → only customers.
select pg_temp.as_user('cf000000-0000-4000-8000-000000000002');
set local role authenticated;
do $$begin
  assert (select array_agg(tax_id order by tax_id) from public.counterparties where tax_id like 'CP-%')='{CP-2,CP-3,CP-4,CP-5,CP-6}',
    'without customers.view: every party with a supplier-side role, including the one that is also a customer';
end $$;
reset role;
select pg_temp.as_user('cf000000-0000-4000-8000-000000000003');
set local role authenticated;
do $$begin
  assert (select array_agg(tax_id order by tax_id) from public.counterparties where tax_id like 'CP-%')='{CP-1,CP-4}',
    'without suppliers.view: customers only, including the one that is also a supplier';
end $$;
reset role;

-- 2. Create and update follow the same rule.
select pg_temp.as_user('cf000000-0000-4000-8000-000000000002');
set local role authenticated;
do $$begin
  begin
    insert into public.counterparties(roles,legal_name,country,tax_id) values (array['customer'],'CP new customer','KZ','CP-7');
    raise exception 'a customer was created without customers.create';
  exception when insufficient_privilege then null;
  end;
  insert into public.counterparties(roles,legal_name,country,tax_id) values (array['supplier'],'CP new supplier','KZ','CP-8');
  update public.counterparties set short_name='renamed' where tax_id in ('CP-1','CP-2');
end $$;
reset role;
do $$begin
  assert exists(select 1 from public.counterparties where tax_id='CP-8'),'a supplier is created with suppliers.create';
  assert (select short_name from public.counterparties where tax_id='CP-2')='renamed','the supplier is updated';
  assert (select short_name from public.counterparties where tax_id='CP-1') is distinct from 'renamed','the customer is not updated without customers.update';
end $$;
select pg_temp.as_user('cf000000-0000-4000-8000-000000000003');
set local role authenticated;
do $$begin
  begin
    update public.counterparties set roles=array['supplier'] where tax_id='CP-1';
    if exists(select 1 from public.counterparties where tax_id='CP-1' and roles=array['supplier']) then
      raise exception 'a customer was turned into a supplier without suppliers.update';
    end if;
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
do $$begin assert (select roles from public.counterparties where tax_id='CP-1')=array['customer'],'the roles did not change'; end $$;

-- 3. The permission checks run once per query: the plan has no per-row subplan for the policy.
select pg_temp.as_user('cf000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$
declare line text; plan text := '';
begin
  for line in execute 'explain (costs off) select id from public.counterparties' loop plan := plan || line || E'\n'; end loop;
  assert plan !~ 'SubPlan', 'the counterparty policy runs a subplan per row:' || E'\n' || plan;
  assert plan ~ 'InitPlan', 'the permission checks are evaluated once per query:' || E'\n' || plan;
end $$;
reset role;
\echo counterparty_policy_once_per_query: all checks passed
rollback;
