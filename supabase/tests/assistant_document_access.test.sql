-- Same document visibility in RLS, prepare, review, confirmation and receipts.
\set ON_ERROR_STOP 1
\ir fixtures/assistant_document_access.sql

do $$ declare c document_cases;v jsonb;begin
 assert exists(select 1 from public.documents where id='f0690000-0000-4000-8000-000000000001');
 for c in select * from document_cases loop
  perform public.prepare_assistant_operation(c.id,c.kind,c.payload);
  v:=public.review_assistant_operation(c.id);
  assert v->'preview'->>'document'='PRIVATE-PURCHASE-DOCUMENT-123','allowed document title remains visible';
  update document_cases set token=(v->>'review_token')::uuid where kind=c.kind;
 end loop;
end $$;
reset role;
create function pg_temp.document_business_snapshot() returns jsonb language sql as $$
 select jsonb_build_object(
  'expenses',(select jsonb_agg(to_jsonb(e) order by e.id) from public.expenses e),
  'allocations',(select jsonb_agg(to_jsonb(a) order by a.id) from public.expense_allocations a),
  'costs',(select jsonb_agg(to_jsonb(c) order by c.id) from public.cost_calculations c),
  'cost_lines',(select jsonb_agg(to_jsonb(c) order by c.id) from public.cost_calculation_items c),
  'ledger',(select jsonb_agg(to_jsonb(o) order by o.id) from private.assistant_operations o),
  'audit',(select jsonb_agg(to_jsonb(a) order by a.id) from public.audit_log a));
$$;
create temporary table document_snapshot(value jsonb);
create function pg_temp.expect_document_denial(q text) returns void language plpgsql as $$
begin
 begin execute q;
 exception when insufficient_privilege then
  assert sqlerrm='ASSISTANT_OPERATION_DENIED','denial must not expose hidden data';return;
 end;
 raise exception 'Hidden document unexpectedly accessible: %',q;
end $$;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select auth.uid(),id,'deny','Synthetic hidden generated document',auth.uid() from public.permissions where code='templates.generate_prices';
insert into document_snapshot select pg_temp.document_business_snapshot();
set role authenticated;
do $$ declare c document_cases;begin
 assert not exists(select 1 from public.documents where id='f0690000-0000-4000-8000-000000000001'),'RLS hides the document';
 for c in select * from document_cases loop
  perform pg_temp.expect_document_denial(format('select public.prepare_assistant_operation(%L,%L,%L::jsonb)',gen_random_uuid(),c.kind,c.payload));
  perform pg_temp.expect_document_denial(format('select public.review_assistant_operation(%L)',c.id));
  perform pg_temp.expect_document_denial(format('select public.confirm_assistant_operation(%L,%L)',c.id,c.token));
 end loop;
end $$;
reset role;
do $$begin assert (select value from document_snapshot)=pg_temp.document_business_snapshot(),'denied operations must preserve all financial rows, ledger and audit';end $$;

-- Non-price generated documents must remain usable with the same personal deny.
set local session_replication_role=replica;
update public.document_generations set contains_prices=false where document_id='f0690000-0000-4000-8000-000000000001';
set local session_replication_role=origin;
set role authenticated;
do $$ declare c document_cases;begin
 assert exists(select 1 from public.documents where id='f0690000-0000-4000-8000-000000000001');
 for c in select * from document_cases loop
  assert public.review_assistant_operation(c.id)->'preview'->>'document'='PRIVATE-PURCHASE-DOCUMENT-123';
 end loop;
end $$;
reset role;
set local session_replication_role=replica;
update public.document_generations set contains_prices=true where document_id='f0690000-0000-4000-8000-000000000001';
set local session_replication_role=origin;
delete from public.user_permission_overrides where user_id=auth.uid();
set role authenticated;
-- Restoring access keeps the original tokens usable. Native operations still work.
do $$ declare c document_cases;v jsonb;begin
 for c in select * from document_cases order by kind loop
  v:=public.confirm_assistant_operation(c.id,c.token);
  assert v->>'status'='completed';
  assert public.confirm_assistant_operation(c.id,c.token)=v,'retry returns the same receipt';
 end loop;
end $$;
reset role;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select auth.uid(),id,'deny','Receipt access revoked',auth.uid() from public.permissions where code='templates.generate_prices';
truncate document_snapshot;
insert into document_snapshot select pg_temp.document_business_snapshot();
set role authenticated;
do $$ declare c document_cases;begin
 for c in select * from document_cases loop
  perform pg_temp.expect_document_denial(format('select public.review_assistant_operation(%L)',c.id));
  perform pg_temp.expect_document_denial(format('select public.confirm_assistant_operation(%L,%L)',c.id,c.token));
 end loop;
end $$;
reset role;
do $$begin assert (select value from document_snapshot)=pg_temp.document_business_snapshot(),'denied receipts must not mutate business data or ledger';end $$;
rollback;
