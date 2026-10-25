\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('af000000-0000-4000-8000-000000000001','assistant-ops@test.local','{"full_name":"Synthetic operator"}'),
 ('af000000-0000-4000-8000-000000000002','assistant-other@test.local','{"full_name":"Synthetic other"}');
insert into public.user_roles(user_id,role_id) select u.id,r.id from auth.users u cross join public.app_roles r
 where u.id in ('af000000-0000-4000-8000-000000000001','af000000-0000-4000-8000-000000000002') and r.code='director';
insert into public.counterparties(id,roles,legal_name,country) values('af000000-0000-4000-8000-000000000011',array['manufacturer'],'Synthetic factory','KZ');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('af000000-0000-4000-8000-000000000021','SYNTH-AI-TRANSFER','{"ru":"Синтетическое печенье"}','af000000-0000-4000-8000-000000000011','active');
insert into public.product_packaging(product_id,uom,units_per_parent) values('af000000-0000-4000-8000-000000000021','box',12);
create temporary table ao(src uuid,dst uuid,payload jsonb,review jsonb,result jsonb);
grant all on ao to authenticated;
insert into ao(src,dst) values((select id from public.warehouses where status='active' and not is_virtual order by code limit 1),
 (select id from public.warehouses where status='active' and not is_virtual order by code offset 1 limit 1));
insert into public.inventory_batches(id,product_id,batch_number,expiry_date,created_by) values
 ('af000000-0000-4000-8000-000000000031','af000000-0000-4000-8000-000000000021','SYNTH-FIRST','2099-01-01','af000000-0000-4000-8000-000000000001'),
 ('af000000-0000-4000-8000-000000000032','af000000-0000-4000-8000-000000000021','SYNTH-SECOND','2099-02-01','af000000-0000-4000-8000-000000000001');
insert into public.inventory_balances(id,batch_id,warehouse_id,uom,quantity_on_hand)
 select 'af000000-0000-4000-8000-000000000041'::uuid,'af000000-0000-4000-8000-000000000031'::uuid,src,'piece',6 from ao union all
 select 'af000000-0000-4000-8000-000000000042'::uuid,'af000000-0000-4000-8000-000000000032'::uuid,src,'piece',30 from ao;
update ao set payload=jsonb_build_object('product_id','af000000-0000-4000-8000-000000000021','from_warehouse_id',src,'to_warehouse_id',dst,'quantity','2','uom','box');
set local role authenticated;
select set_config('request.jwt.claim.sub','af000000-0000-4000-8000-000000000001',true);
select public.prepare_assistant_operation('af000000-0000-4000-8000-000000000051','inventory_transfer',payload) from ao;
select public.prepare_assistant_operation('af000000-0000-4000-8000-000000000051','inventory_transfer',payload) from ao;
update ao set review=public.review_assistant_operation('af000000-0000-4000-8000-000000000051');
do $$ begin
 assert (select sum(quantity_on_hand)=36 from public.inventory_balances where batch_id in ('af000000-0000-4000-8000-000000000031','af000000-0000-4000-8000-000000000032')),'preview does not move stock';
 assert (select jsonb_array_length(review#>'{preview,lines}')=2 from ao),'two batches cover two boxes';
 assert (select (review#>>'{preview,lines,0,quantity}')::numeric=6 and (review#>>'{preview,lines,1,quantity}')::numeric=18 from ao),'12 pieces per box, FEFO';
 assert not has_table_privilege('authenticated','private.assistant_operations','select'),'no raw proposal history';
 assert not has_function_privilege('service_role','public.confirm_assistant_operation(uuid,uuid)','execute'),'no service role';
end $$;
-- A different employee cannot confirm or inspect this proposal even with the same business role.
select set_config('request.jwt.claim.sub','af000000-0000-4000-8000-000000000002',true);
do $$ begin
 begin perform public.review_assistant_operation('af000000-0000-4000-8000-000000000051');raise exception 'expected deny';
 exception when others then if sqlerrm<>'ASSISTANT_OPERATION_DENIED' then raise;end if;end;
end $$;
select set_config('request.jwt.claim.sub','af000000-0000-4000-8000-000000000001',true);
update ao set result=public.confirm_assistant_operation('af000000-0000-4000-8000-000000000051',(review->>'review_token')::uuid);
do $$ declare repeat_result jsonb; begin
 select public.confirm_assistant_operation('af000000-0000-4000-8000-000000000051',(review->>'review_token')::uuid) into repeat_result from ao;
 assert repeat_result=(select result from ao),'lost-response retry returns same result';
 assert (select count(*)=4 from public.inventory_movements where inventory_operation_document_id=(select (result->>'result_id')::uuid from ao)),'exactly two linked pairs, no double transfer';
 assert (select sum(quantity_on_hand)=12 from public.inventory_balances where warehouse_id=(select src from ao) and batch_id in ('af000000-0000-4000-8000-000000000031','af000000-0000-4000-8000-000000000032')),'source 36-24';
 assert (select sum(quantity_on_hand)=24 from public.inventory_balances where warehouse_id=(select dst from ao) and batch_id in ('af000000-0000-4000-8000-000000000031','af000000-0000-4000-8000-000000000032')),'destination 24';
 begin perform public.prepare_assistant_operation('af000000-0000-4000-8000-000000000052','inventory_transfer',(select payload from ao));raise exception 'expected insufficient stock';
 exception when others then if sqlerrm<>'ASSISTANT_OPERATION_STOCK' then raise;end if;end;
end $$;
update ao set payload=jsonb_set(payload,'{quantity}','"1"');
select public.prepare_assistant_operation('af000000-0000-4000-8000-000000000053','inventory_transfer',payload) from ao;
update ao set review=public.review_assistant_operation('af000000-0000-4000-8000-000000000053');
reset role;
update public.product_packaging set units_per_parent=6 where product_id='af000000-0000-4000-8000-000000000021' and uom='box';
set local role authenticated;
do $$ begin
 begin perform public.confirm_assistant_operation('af000000-0000-4000-8000-000000000053',(select (review->>'review_token')::uuid from ao));raise exception 'expected stale';
 exception when others then if sqlerrm<>'ASSISTANT_OPERATION_STALE' then raise;end if;end;
 assert (select sum(quantity_on_hand)=12 from public.inventory_balances where warehouse_id=(select src from ao) and batch_id in ('af000000-0000-4000-8000-000000000031','af000000-0000-4000-8000-000000000032')),'stale confirmation has no side effects';
end $$;
reset role;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'af000000-0000-4000-8000-000000000001',id,'deny','Synthetic deny','af000000-0000-4000-8000-000000000002' from public.permissions where code='inventory.move';
set local role authenticated;
do $$ begin
 begin perform public.review_assistant_operation('af000000-0000-4000-8000-000000000051');raise exception 'expected deny';
 exception when others then if sqlerrm<>'ASSISTANT_OPERATION_DENIED' then raise;end if;end;
end $$;
rollback;
