-- Repair already-installed guards as well as fresh installations. Keep the
-- operation ledger, pending review tokens, function identity and ACLs intact.
begin;
do $migration$
declare signature text; definition text; old_guard text; new_guard text; document_expr text; present_expr text; indent text;
begin
 for signature in select unnest(array[
  'private.require_assistant_expense_access(jsonb)',
  'private.require_assistant_expense_confirmation_access(uuid)',
  'private.require_assistant_expense_allocation_access(uuid)',
  'private.require_assistant_expense_cancellation_access(uuid)',
  'private.require_assistant_expense_reversal_access(uuid)',
  'private.require_assistant_expense_payment_access(uuid)'
 ]) loop
  if to_regprocedure(signature) is null then raise exception 'Missing assistant document guard: %',signature;end if;
  definition:=replace(pg_get_functiondef(to_regprocedure(signature)),E'\r\n',E'\n');
  if signature='private.require_assistant_expense_access(jsonb)' then
   present_expr:='p->>''document_id'''; document_expr:='(p->>''document_id'')::uuid'; indent:='  ';
  else
   present_expr:='e.document_id'; document_expr:='e.document_id'; indent:=' ';
  end if;
  old_guard:=format('%sor (%s is not null and not private.has_permission(''documents.view''))',indent,present_expr);
  new_guard:=format('%sor (%s is not null and (not private.has_permission(''documents.view'')%s%s or not private.can_view_generated_document(%s)))',indent,present_expr,E'\n',indent,document_expr);
  if position(new_guard in definition)>0 then continue;end if;
  if (length(definition)-length(replace(definition,old_guard,'')))/length(old_guard)<>1 then
   raise exception 'Unexpected assistant document guard definition: %',signature;
  end if;
  execute replace(definition,old_guard,new_guard);
 end loop;
end $migration$;
commit;
