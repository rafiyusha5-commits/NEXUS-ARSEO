-- K3 of the audit of 2026-11-11 (docs/audit-2026-11-11.md): the production database had no record of which
-- migrations it has received. This table is that record. It is filled outside migrations, by the person (or agent at
-- the owner's request) who applies them, with SQL printed by scripts/migration-registry.mts:
--   * method 'reconciled' — a migration applied earlier, without a record, whose result was confirmed by comparing the
--     schema with a reference built from the migrations (scripts/schema-reference.sh, scripts/schema-diff.mts);
--   * method 'applied' — a migration applied and recorded at the same time.
-- Readable and writable only with the database owner's credentials: no API role sees it. Not data of the business.
begin;

create table if not exists private.applied_migrations (
  name text primary key check (name ~ '^[0-9]{12}_[a-z0-9_]+\.sql$'),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  method text not null check (method in ('reconciled', 'applied')),
  applied_at timestamptz not null default clock_timestamp(),
  recorded_by text not null check (length(btrim(recorded_by)) between 2 and 200),
  note text check (note is null or length(note) <= 1000)
);
alter table private.applied_migrations enable row level security;
revoke all on private.applied_migrations from public, anon, authenticated, service_role;
comment on table private.applied_migrations is
  'Migrations of supabase/migrations received by this database (K3). Filled with scripts/migration-registry.mts.';

commit;
