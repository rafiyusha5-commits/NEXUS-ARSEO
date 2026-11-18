-- Minimal stand-in for the parts of Supabase that the migrations rely on, so the
-- migrations and RLS policies can be tested on a plain local PostgreSQL.
-- NOT a migration: never apply this file to a real Supabase project.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

-- Supabase reads the user id from the JWT; tests set request.jwt.claim.sub instead.
create function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create schema storage;
create table storage.buckets (
  id text primary key,
  name text not null unique,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id),
  name text not null,
  owner_id text,
  metadata jsonb,
  created_at timestamptz not null default now(),
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated, service_role;
grant select, insert, update, delete on storage.objects to authenticated;
grant select on storage.buckets to authenticated;

-- Default privileges of the public schema, as in the working Supabase project.
-- Functions: every new function is executable by the API roles, so the explicit REVOKE
-- statements in the migrations are actually exercised by the tests.
-- Tables and sequences: the working project gives the API roles no read or write access by
-- default; a table is reachable only through the GRANT its migration writes. Verified on
-- 18.11.2026 against the ACL of a production backup: new tables carry only REFERENCES,
-- TRIGGER, TRUNCATE (and MAINTAIN on PostgreSQL 17) for anon, authenticated and service_role,
-- sequences carry nothing. With the former "grant all" a test could pass on a DELETE or a
-- nextval() that the working database refuses.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant references, trigger, truncate on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
