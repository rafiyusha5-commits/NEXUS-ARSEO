-- The latest catalogue trace must settle without breaking the accounting contract.
\set ON_ERROR_STOP 1
begin;
do $$declare v jsonb;begin
 v:=private.agent_clean_tools('[{"name":"find_products","params":{"query":"Merba","offset":20,"limit":20},"rows":1,"truncated":true,"ms":12}]');
 assert v->0->>'name'='find_products';
 assert (v->0->'params'->>'offset')::integer=20;
 assert not has_function_privilege('authenticated','private.agent_clean_tools(jsonb)','execute');
 begin
  perform private.agent_clean_tools('[{"name":"find_products","params":{"offset":10001},"rows":1,"truncated":true,"ms":12}]');
  raise exception 'expected invalid offset';
 exception when sqlstate '22023' then null;
 end;
end$$;
rollback;
