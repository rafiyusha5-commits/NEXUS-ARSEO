do $$declare v_other text;begin
 assert (select status='shipped' from public.sales where id=(select id from tests.fulfillment_context where k='sale'));
 assert (select count(*)=2 and sum(quantity)=150 from public.inventory_movements where sale_id=(select id from tests.fulfillment_context where k='sale')),'10 concurrent requests issue exactly once';
 assert (select count(*)=2 from public.inventory_reservations where sale_item_id=(select id from tests.fulfillment_context where k='item') and status='fulfilled');
 select status into v_other from public.sales where id=(select id from tests.fulfillment_context where k='other');
 assert v_other in ('shipped','cancelled');
 assert (select sum(quantity_reserved)=0 and sum(quantity_on_hand)=case when v_other='shipped' then 100 else 150 end from public.inventory_balances where warehouse_id='ef200000-0000-4000-8000-000000000001'),'race stock consistent';
 assert (select count(*)=case when v_other='shipped' then 1 else 0 end from public.inventory_movements where sale_id=(select id from tests.fulfillment_context where k='other')),'race ledger consistent';
 assert (select status=case when v_other='shipped' then 'fulfilled' else 'cancelled' end from public.inventory_reservations where sale_item_id=(select id from tests.fulfillment_context where k='other-item'));
end$$;
\echo fulfillment concurrency passed
