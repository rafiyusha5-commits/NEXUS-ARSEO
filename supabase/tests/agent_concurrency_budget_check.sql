-- Verifies the outcome of 30 parallel reservations against a budget with room for exactly 7.
\set ON_ERROR_STOP 1
select set_config('tests.agent_granted',:'granted',false),set_config('tests.agent_limited',:'limited',false);
do $$
declare v_granted int:=current_setting('tests.agent_granted')::int;v_limited int:=current_setting('tests.agent_limited')::int;
begin
 assert v_granted=7,format('exactly the remaining budget is reserved, got %s',v_granted);
 assert v_limited=23,format('the other parallel requests hit the monthly budget, got %s',v_limited);
end$$;
