-- Model the previously installed guards, then apply the upgrade twice.
create temporary table document_guard_original(signature text,definition text,acl aclitem[],config text[]);
insert into document_guard_original
select signature,replace(pg_get_functiondef(signature::regprocedure),E'\r\n',E'\n'),p.proacl,p.proconfig
from unnest(array[
 'private.require_assistant_expense_access(jsonb)',
 'private.require_assistant_expense_confirmation_access(uuid)',
 'private.require_assistant_expense_allocation_access(uuid)',
 'private.require_assistant_expense_cancellation_access(uuid)',
 'private.require_assistant_expense_reversal_access(uuid)',
 'private.require_assistant_expense_payment_access(uuid)'
]) signature join pg_proc p on p.oid=signature::regprocedure;
do $$declare r record;old_guard text;new_guard text;expr text;present text;indent text;begin
 for r in select * from document_guard_original loop
  if r.signature='private.require_assistant_expense_access(jsonb)' then
   present:='p->>''document_id''';expr:='(p->>''document_id'')::uuid';indent:='  ';
  else present:='e.document_id';expr:='e.document_id';indent:=' ';end if;
  old_guard:=format('%sor (%s is not null and not private.has_permission(''documents.view''))',indent,present);
  new_guard:=format('%sor (%s is not null and (not private.has_permission(''documents.view'')%s%s or not private.can_view_generated_document(%s)))',indent,present,E'\n',indent,expr);
  assert position(new_guard in r.definition)>0,'document guard must exist before upgrade test';
  execute replace(r.definition,new_guard,old_guard);
 end loop;
end $$;
\ir ../migrations/202610250200_assistant_document_access.sql
\ir ../migrations/202610250200_assistant_document_access.sql
do $$declare r record;begin
 for r in select * from document_guard_original loop
  assert replace(pg_get_functiondef(r.signature::regprocedure),E'\r\n',E'\n')=r.definition,'upgrade/replay must restore the guarded function (ignoring line endings)';
  assert (select proacl is not distinct from r.acl and proconfig is not distinct from r.config from pg_proc where oid=r.signature::regprocedure),'ACL and function settings must remain unchanged';
 end loop;
end $$;
drop table document_guard_original;
