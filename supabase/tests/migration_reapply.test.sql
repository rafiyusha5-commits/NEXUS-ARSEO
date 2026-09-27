-- Checks the state after scripts/test-db.sh re-applies the document migrations in order
-- (202609271001 → 202609271600 → 202609271800). Re-running older migrations alone would
-- restore its older my_document_permissions() without the "approve" flag and its Storage
-- policies without the documents/ prefix; the later migrations must win again.

\set ON_ERROR_STOP 1

create schema if not exists tests;
grant usage on schema tests to authenticated;

create or replace function tests.act_as(p_user uuid) returns void
language sql as $$ select set_config('request.jwt.claim.sub', p_user::text, false) $$;
grant execute on function tests.act_as(uuid) to authenticated;

insert into auth.users (id, email, raw_user_meta_data) values
  ('b7000000-0000-4000-8000-000000000001', 'reapply-director@test.local', '{"full_name":"Директор (повтор миграций)"}'),
  ('b7000000-0000-4000-8000-000000000002', 'reapply-specialist@test.local', '{"full_name":"Специалист (повтор миграций)"}');

insert into public.user_roles (user_id, role_id)
select u.id::uuid, r.id
from (values
  ('b7000000-0000-4000-8000-000000000001', 'director'),
  ('b7000000-0000-4000-8000-000000000002', 'logistics_specialist')
) as u(id, role_code)
join public.app_roles r on r.code = u.role_code;

-- A user with documents.approve still gets approve = true.
select tests.act_as('b7000000-0000-4000-8000-000000000001');
set role authenticated;
do $$
declare
  v_flags jsonb := public.my_document_permissions();
begin
  assert (select private.has_permission('documents.approve')), 'director must hold documents.approve';
  assert v_flags ? 'approve', format('my_document_permissions() lost the approve key: %s', v_flags);
  assert (v_flags ->> 'approve')::boolean, format('approve must be true for a user with documents.approve: %s', v_flags);
  assert (v_flags ->> 'view')::boolean, 'other flags keep working';
end;
$$;
reset role;

-- A user without documents.approve gets the key with false (the 202609271600 version of the
-- function is active, not the older one from 202609271001 that had no key at all).
select tests.act_as('b7000000-0000-4000-8000-000000000002');
set role authenticated;
do $$
declare
  v_flags jsonb := public.my_document_permissions();
begin
  assert v_flags ? 'approve', format('my_document_permissions() lost the approve key: %s', v_flags);
  assert not (v_flags ->> 'approve')::boolean, 'approve must be false without documents.approve';
end;
$$;
reset role;

-- 202609271800 ran after 202609271001, so the document Storage policies stay scoped.
do $$
begin
  assert (select count(*) from pg_policies
          where schemaname = 'storage' and tablename = 'objects'
            and policyname in ('nexus documents: read registered files', 'nexus documents: remove own unregistered upload')
            and qual like '%documents/%') = 2,
    'document Storage policies must stay limited to documents/ after re-applying migrations';
end;
$$;

-- 202609271800 remains the final schema: templates have direction and cards use a
-- neutral counterparty reference for both suppliers and buyers.
do $$
begin
  assert exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'document_templates'
                   and column_name = 'flow_direction' and is_nullable = 'NO'),
    'document_templates.flow_direction must survive migration re-apply';
  assert exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'product_listing_cards'
                   and column_name = 'counterparty_id'),
    'listing cards must keep counterparty_id';
  assert not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'product_listing_cards'
                       and column_name = 'customer_id'),
    'legacy product_listing_cards.customer_id must not return';
end;
$$;

\echo 'migration_reapply: all checks passed'
