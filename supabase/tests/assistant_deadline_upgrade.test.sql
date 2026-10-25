-- Exercise an already-installed handler, not only a fresh migration chain.
create temporary table deadline_original(signature text,definition text,acl aclitem[],config text[]);
insert into deadline_original
select signature,pg_get_functiondef(signature::regprocedure),p.proacl,p.proconfig
from unnest(array[
 'private.confirm_assistant_transfer(uuid,uuid)',
 'private.confirm_assistant_stock_operation(uuid,uuid)',
 'private.confirm_assistant_prior_operation(uuid,uuid)',
 'private.confirm_assistant_before_confirmation(uuid,uuid)',
 'private.confirm_assistant_before_receiving(uuid,uuid)'
]) signature join pg_proc p on p.oid=signature::regprocedure;
do $test$
declare r record; stripped text;
begin
 for r in select * from deadline_original loop
  -- Strip only the second (post-lock) check while preserving the initial check.
  stripped:=regexp_replace(r.definition,
   E' if (row|r)\\.expires_at<clock_timestamp\\(\\) then raise exception ''ASSISTANT_OPERATION_EXPIRED'';end if;\\n( doc:=| perform public.fulfill_customer_order| sale:=public.create_customer_order| for line in select id from public.sale_items| begin perform public.confirm_customer_order)',
   E'\\2');
  if stripped=r.definition then raise exception 'Missing post-lock deadline guard: %',r.signature;end if;
  execute stripped;
 end loop;
end $test$;
\ir ../migrations/202610250100_assistant_confirmation_deadline.sql
\ir ../migrations/202610250100_assistant_confirmation_deadline.sql
do $test$
declare r record;
begin
 for r in select * from deadline_original loop
  assert pg_get_functiondef(r.signature::regprocedure)=r.definition,'upgrade/replay must restore exactly the guarded handler';
  assert (select proacl is not distinct from r.acl and proconfig is not distinct from r.config from pg_proc where oid=r.signature::regprocedure),'ACL and function settings must remain unchanged';
 end loop;
end $test$;
drop table deadline_original;
