-- Phase 6A: integration registry, synchronization journal, errors and mappings.

insert into public.permissions(code,module,action,name,description) values
 ('integrations.view','integrations','view','Просмотр интеграций','Просмотр статусов интеграций и журнала'),
 ('integrations.manage','integrations','manage','Настройка интеграций','Настройка безопасных параметров и статуса'),
 ('integrations.resolve','integrations','resolve','Разбор ошибок интеграций','Ручное сопоставление внешних записей')
on conflict(code) do update set module=excluded.module,action=excluded.action,name=excluded.name,description=excluded.description;

insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true from public.app_roles r cross join public.permissions p where
 (r.code in ('director','administrator') and p.code in ('integrations.view','integrations.manage','integrations.resolve')) or
 (r.code='executive_director' and p.code='integrations.view') or
 (r.code in ('commercial_director','logistics_director','senior_logistics_manager','accountant') and p.code='integrations.view') or
 (r.code in ('senior_logistics_manager','accountant') and p.code='integrations.resolve')
on conflict(role_id,permission_id) do update set granted=true;

create table if not exists public.integrations(
 id uuid primary key default gen_random_uuid(),code text not null unique check(code in ('google_drive','google_sheets','onec_accounting','onec_trade','whatsapp','email')),
 name text not null,direction text not null check(direction in ('inbound','outbound','bidirectional')),config jsonb not null default '{}'::jsonb,
 is_active boolean not null default false,last_status text not null default 'not_configured' check(last_status in ('not_configured','ready','running','success','partial','failed')),
 last_run_at timestamptz,last_success_at timestamptz,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check(code not in ('onec_accounting','onec_trade') or direction='inbound')
);

create table if not exists public.synchronization_runs(
 id uuid primary key default gen_random_uuid(),integration_id uuid not null references public.integrations(id) on delete restrict,
 entity_type text not null check(length(trim(entity_type))>0),started_at timestamptz not null default now(),finished_at timestamptz,
 status text not null default 'running' check(status in ('running','success','failed','partial')),
 records_read integer not null default 0 check(records_read>=0),records_created integer not null default 0 check(records_created>=0),
 records_updated integer not null default 0 check(records_updated>=0),records_failed integer not null default 0 check(records_failed>=0),
 triggered_by text not null check(triggered_by in ('schedule','manual')),triggered_by_user_id uuid references public.profiles(id) on delete restrict,
 summary text,created_at timestamptz not null default now(),
 check((status='running' and finished_at is null) or (status<>'running' and finished_at is not null))
);

create table if not exists public.synchronization_errors(
 id uuid primary key default gen_random_uuid(),run_id uuid not null references public.synchronization_runs(id) on delete restrict,
 entity_type text not null,external_id text,error_code text not null check(error_code in ('no_match','ambiguous_match','validation_failed','source_unavailable','permission_denied','other')),
 message text not null,payload jsonb not null default '{}'::jsonb,status text not null default 'open' check(status in ('open','resolved','ignored')),
 resolved_by uuid references public.profiles(id) on delete restrict,resolved_at timestamptz,resolution_note text,created_at timestamptz not null default now()
);

create table if not exists public.integration_mappings(
 id uuid primary key default gen_random_uuid(),integration_id uuid not null references public.integrations(id) on delete restrict,
 entity_type text not null check(entity_type in ('product','counterparty','warehouse','sale','receivable','document')),
 internal_id uuid not null,external_id text not null,external_code text,match_method text not null check(match_method in ('supplier_sku','gtin','tax_id','manual','guid')),
 last_synced_at timestamptz,source_hash text,created_by uuid references public.profiles(id) on delete restrict,created_at timestamptz not null default now(),
 unique(integration_id,entity_type,external_id),unique(integration_id,entity_type,internal_id)
);

insert into public.integrations(code,name,direction) values
 ('google_drive','Google Drive','inbound'),('google_sheets','Google Sheets','inbound'),
 ('onec_accounting','1С Бухгалтерия 8.3','inbound'),('onec_trade','1С Управление торговлей','inbound'),
 ('whatsapp','WhatsApp Business','outbound'),('email','Корпоративная почта','outbound')
on conflict(code) do nothing;

create index if not exists synchronization_runs_integration_started_idx on public.synchronization_runs(integration_id,started_at desc);
create index if not exists synchronization_errors_open_idx on public.synchronization_errors(status,created_at desc);
create index if not exists integration_mappings_internal_idx on public.integration_mappings(entity_type,internal_id);

do $$declare t text;begin foreach t in array array['integrations','synchronization_runs','synchronization_errors','integration_mappings'] loop
 execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);execute format('grant select on public.%I to authenticated',t);
 execute format('drop policy if exists "integration read" on public.%I',t);execute format('create policy "integration read" on public.%I for select to authenticated using ((select private.has_permission(''integrations.view'')))',t);
end loop;end$$;

create or replace function private.integration_config_is_safe(p_config jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare k text;v jsonb;begin
 if p_config is null then return true;end if;
 if jsonb_typeof(p_config)='object' then
  for k,v in select key,value from jsonb_each(p_config) loop
   if lower(k)~'(secret|password|token|api.?key|credential|private.?key)' or not private.integration_config_is_safe(v) then return false;end if;
  end loop;
 elsif jsonb_typeof(p_config)='array' then
  for v in select value from jsonb_array_elements(p_config) loop
   if not private.integration_config_is_safe(v) then return false;end if;
  end loop;
 end if;
 return true;
end$$;
revoke all on function private.integration_config_is_safe(jsonb) from public,anon,authenticated,service_role;

create or replace function public.configure_integration(p_integration_id uuid,p_direction text,p_config jsonb,p_is_active boolean)
returns void language plpgsql security definer set search_path='' as $$declare v_code text;begin
 if not (select private.has_permission('integrations.manage')) then raise exception 'Нет права настраивать интеграции';end if;
 if p_direction not in ('inbound','outbound','bidirectional') or jsonb_typeof(coalesce(p_config,'{}'::jsonb))<>'object' or not private.integration_config_is_safe(p_config) then raise exception 'Параметры содержат запрещённые секреты или имеют неверный формат';end if;
 select code into v_code from public.integrations where id=p_integration_id for update;if not found then raise exception 'Интеграция не найдена';end if;
 if v_code in ('onec_accounting','onec_trade') and p_direction<>'inbound' then raise exception '1С подключается только на чтение';end if;
 update public.integrations set direction=p_direction,config=coalesce(p_config,'{}'::jsonb),is_active=p_is_active,last_status=case when p_is_active then 'ready' else 'not_configured' end,updated_at=now() where id=p_integration_id;
end$$;

create or replace function public.resolve_synchronization_error(p_error_id uuid,p_internal_id uuid,p_external_code text,p_note text,p_ignore boolean default false)
returns void language plpgsql security definer set search_path='' as $$declare e record;v_integration uuid;begin
 if not (select private.has_permission('integrations.resolve')) then raise exception 'Нет права разбирать ошибки интеграций';end if;
 select se.*,sr.integration_id into e from public.synchronization_errors se join public.synchronization_runs sr on sr.id=se.run_id where se.id=p_error_id and se.status='open' for update of se;if not found then raise exception 'Открытая ошибка не найдена';end if;
 if p_ignore then update public.synchronization_errors set status='ignored',resolved_by=auth.uid(),resolved_at=now(),resolution_note=nullif(btrim(p_note),'') where id=p_error_id;return;end if;
 if p_internal_id is null or e.external_id is null or e.entity_type not in ('product','counterparty','warehouse','sale','receivable','document') then raise exception 'Для сопоставления выберите запись Nexus';end if;
 if (e.entity_type='product' and not exists(select 1 from public.products where id=p_internal_id)) or (e.entity_type='counterparty' and not exists(select 1 from public.counterparties where id=p_internal_id)) then raise exception 'Выбранная запись Nexus не найдена';end if;
 select sr.integration_id into v_integration from public.synchronization_runs sr where sr.id=e.run_id;
 insert into public.integration_mappings(integration_id,entity_type,internal_id,external_id,external_code,match_method,created_by)
 values(v_integration,e.entity_type,p_internal_id,e.external_id,nullif(btrim(p_external_code),''),'manual',auth.uid())
 on conflict(integration_id,entity_type,external_id) do update set internal_id=excluded.internal_id,external_code=excluded.external_code,match_method='manual',created_by=auth.uid();
 update public.synchronization_errors set status='resolved',resolved_by=auth.uid(),resolved_at=now(),resolution_note=nullif(btrim(p_note),'') where id=p_error_id;
end$$;

create or replace function public.start_synchronization_run(p_integration_code text,p_entity_type text,p_triggered_by text,p_triggered_by_user_id uuid default null)
returns uuid language plpgsql security definer set search_path='' as $$declare v_integration uuid;v_id uuid;begin
 select id into v_integration from public.integrations where code=p_integration_code and is_active for update;if not found then raise exception 'Интеграция не активна';end if;
 if p_triggered_by not in ('schedule','manual') then raise exception 'Неверный источник запуска';end if;
 insert into public.synchronization_runs(integration_id,entity_type,triggered_by,triggered_by_user_id) values(v_integration,btrim(p_entity_type),p_triggered_by,p_triggered_by_user_id) returning id into v_id;
 update public.integrations set last_status='running',last_run_at=now(),updated_at=now() where id=v_integration;return v_id;
end$$;

create or replace function public.finish_synchronization_run(p_run_id uuid,p_status text,p_records_read integer,p_records_created integer,p_records_updated integer,p_errors jsonb default '[]'::jsonb,p_summary text default null)
returns void language plpgsql security definer set search_path='' as $$declare v_integration uuid;v_error jsonb;v_failed integer;begin
 if p_status not in ('success','failed','partial') or least(p_records_read,p_records_created,p_records_updated)<0 or jsonb_typeof(p_errors)<>'array' then raise exception 'Неверный результат синхронизации';end if;
 select integration_id into v_integration from public.synchronization_runs where id=p_run_id and status='running' for update;if not found then raise exception 'Активный запуск не найден';end if;
 v_failed:=jsonb_array_length(p_errors);
 update public.synchronization_runs set status=p_status,finished_at=now(),records_read=p_records_read,records_created=p_records_created,records_updated=p_records_updated,records_failed=v_failed,summary=nullif(btrim(p_summary),'') where id=p_run_id;
 for v_error in select value from jsonb_array_elements(p_errors) loop
  insert into public.synchronization_errors(run_id,entity_type,external_id,error_code,message,payload) values(p_run_id,coalesce(v_error->>'entity_type','unknown'),v_error->>'external_id',coalesce(v_error->>'error_code','other'),coalesce(v_error->>'message','Ошибка синхронизации'),coalesce(v_error->'payload','{}'::jsonb));
 end loop;
 update public.integrations set last_status=p_status,last_success_at=case when p_status='success' then now() else last_success_at end,updated_at=now() where id=v_integration;
end$$;

revoke all on function public.configure_integration(uuid,text,jsonb,boolean),public.resolve_synchronization_error(uuid,uuid,text,text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.configure_integration(uuid,text,jsonb,boolean),public.resolve_synchronization_error(uuid,uuid,text,text,boolean) to authenticated;
revoke all on function public.start_synchronization_run(text,text,text,uuid),public.finish_synchronization_run(uuid,text,integer,integer,integer,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.start_synchronization_run(text,text,text,uuid),public.finish_synchronization_run(uuid,text,integer,integer,integer,jsonb,text) to service_role;

do $$declare t text;begin foreach t in array array['integrations','synchronization_errors','integration_mappings'] loop execute format('drop trigger if exists audit_%I_changes on public.%I',t,t);execute format('create trigger audit_%I_changes after insert or update on public.%I for each row execute function private.write_access_audit()',t,t);end loop;end$$;

comment on column public.integrations.config is 'Non-secret settings only. Credentials remain in server environment variables.';
comment on table public.synchronization_runs is 'Append-only synchronization execution journal written by trusted server jobs.';
