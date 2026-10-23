-- Test-only, session-local function; no persistent application changes.
create function pg_temp.recovery_snapshot() returns jsonb language plpgsql as $$
declare r record; value jsonb; result jsonb:='{}'; begin
 for r in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('public','private','auth','storage','supabase_migrations','recovery_drill') and c.relkind='r'
  order by 1,2 loop
  execute format('select jsonb_build_object(''rows'',count(*),''sha256'',encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),''[]''::jsonb)::text,''UTF8'')),''hex'')) from %I.%I t',r.nspname,r.relname) into value;
  result:=result||jsonb_build_object(r.nspname||'.'||r.relname,value);
 end loop;
 return result;
end $$;
select pg_temp.recovery_snapshot();
