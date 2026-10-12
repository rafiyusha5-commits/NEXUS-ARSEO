\set ON_ERROR_STOP 1
begin;
do $$declare cleaned jsonb;begin
 assert exists(select 1 from public.permissions where code='documents.drive.view'),'archive permission registered';
 assert exists(select 1 from public.role_permissions rp join public.permissions p on p.id=rp.permission_id join public.app_roles r on r.id=rp.role_id where p.code='documents.drive.view' and r.code='administrator' and rp.granted),'administrator grant';
 assert exists(select 1 from public.role_permissions rp join public.permissions p on p.id=rp.permission_id join public.app_roles r on r.id=rp.role_id where p.code='documents.drive.view' and r.code='director' and rp.granted),'director grant';
 assert not exists(select 1 from public.role_permissions rp join public.permissions p on p.id=rp.permission_id join public.app_roles r on r.id=rp.role_id where p.code='documents.drive.view' and rp.granted and r.code not in ('administrator','director')),'no additional default grants';
 assert not has_function_privilege('authenticated','private.agent_clean_tools(jsonb)','execute'),'trace sanitizer remains private';
 cleaned:=private.agent_clean_tools('[{"name":"find_drive_documents","params":{"query":"Belgian ДС","offset":0},"rows":1,"truncated":false,"ms":1300}]'::jsonb);
 assert cleaned->0->>'name'='find_drive_documents','new tool can close its accounting run';
end$$;
rollback;
