\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('c8000000-0000-4000-8000-000000000001','integration-admin@test.local','{"full_name":"Integration Admin"}'),
 ('c8000000-0000-4000-8000-000000000002','integration-accountant@test.local','{"full_name":"Integration Accountant"}');
insert into public.user_roles(user_id,role_id) select u.id::uuid,r.id from (values('c8000000-0000-4000-8000-000000000001','administrator'),('c8000000-0000-4000-8000-000000000002','accountant'))u(id,code) join public.app_roles r on r.code=u.code;
insert into public.counterparties(id,roles,legal_name,country,tax_id) values('c8100000-0000-4000-8000-000000000001',array['customer'],'Integration Customer','KZ','INT-CUS');

set role authenticated;select set_config('request.jwt.claim.sub','c8000000-0000-4000-8000-000000000001',false);
select public.configure_integration((select id from public.integrations where code='onec_trade'),'inbound','{"endpoint_label":"Первый Бит"}',true);
do $$begin
 begin perform public.configure_integration((select id from public.integrations where code='onec_trade'),'bidirectional','{}',true);raise exception 'write-back enabled' using errcode='P0099';exception when sqlstate 'P0099' then raise;when others then assert position('только на чтение' in sqlerrm)>0,'1C stays inbound';end;
 begin perform public.configure_integration((select id from public.integrations where code='google_drive'),'inbound','{"api_key":"secret"}',true);raise exception 'secret stored' using errcode='P0099';exception when sqlstate 'P0099' then raise;when others then assert position('запрещённые секреты' in sqlerrm)>0,'secrets rejected';end;
 begin perform public.configure_integration((select id from public.integrations where code='google_drive'),'inbound','{"auth":{"token":"nested-secret"}}',true);raise exception 'nested secret stored' using errcode='P0099';exception when sqlstate 'P0099' then raise;when others then assert position('запрещённые секреты' in sqlerrm)>0,'nested secrets rejected';end;
end$$;reset role;

set role service_role;
do $$declare v_run uuid;begin
 v_run:=public.start_synchronization_run('onec_trade','counterparty','schedule',null);
 perform public.finish_synchronization_run(v_run,'partial',2,0,0,'[{"entity_type":"counterparty","external_id":"1C-77","error_code":"no_match","message":"Контрагент не найден"}]','Тест');
end$$;
reset role;
do $$begin assert (select records_failed=1 and status='partial' from public.synchronization_runs where entity_type='counterparty'),'run totals stored';assert exists(select 1 from public.synchronization_errors where external_id='1C-77' and status='open'),'row error stored';end$$;

set role authenticated;select set_config('request.jwt.claim.sub','c8000000-0000-4000-8000-000000000002',false);
select public.resolve_synchronization_error((select id from public.synchronization_errors where external_id='1C-77'),'c8100000-0000-4000-8000-000000000001','CUS-77','Сопоставлено',false);
do $$begin assert exists(select 1 from public.integration_mappings where external_id='1C-77' and internal_id='c8100000-0000-4000-8000-000000000001' and match_method='manual'),'manual mapping stored';assert exists(select 1 from public.synchronization_errors where external_id='1C-77' and status='resolved'),'error resolved';end$$;
reset role;rollback;
