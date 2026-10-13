\set ON_ERROR_STOP 1
set role authenticated;
select set_config('request.jwt.claim.sub','ab689000-0000-4000-8000-000000000001',false);
select 'shipment:'||public.create_shipment_with_stages('NUMBER-PARALLEL','import','ab689100-0000-4000-8000-000000000001',null,
 route_id,currency_id,warehouse_id,'ab689000-0000-4000-8000-000000000001') from tests.shipment_number_inputs;
