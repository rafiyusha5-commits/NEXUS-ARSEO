-- Technical observations only. No role grants, schedules, business writes or external calls.
insert into public.permissions(code,module,action,name,description) values
 ('system.health.view','system','health_view','Состояние системы: просмотр','Диагностика без рабочих данных и секретов')
on conflict(code) do nothing;

-- Monitoring has no archived business payload. Preserve every existing business/price
-- check without granting the new technical permission to any employee or role.
create or replace function private.can_read_operational_archive()
returns boolean language sql stable security definer set search_path='' as $$
 select private.is_employee() and private.has_permission('audit.view')
 and private.has_permission('templates.generate_prices')
 and exists(select 1 from public.user_roles ur join public.app_roles r on r.id=ur.role_id
   where ur.user_id=auth.uid() and r.code='administrator' and r.is_enabled
   and (ur.expires_at is null or ur.expires_at>now()))
 and not exists(select 1 from public.permissions p
   where (p.code like '%.view' or p.code like 'prices.%')
     and p.code not in('external_documents.view','system.health.view') and not private.has_permission(p.code));
$$;
revoke all on function private.can_read_operational_archive() from public,anon,authenticated,service_role;

create table if not exists private.system_health_current (
 environment text not null check(environment in ('test','production','training','recovery')),
 component text not null check(component in ('app','database','storage','drive','ocr','telegram','backup')),
 code text not null check(code in ('OK','UNAVAILABLE','TIMEOUT','NOT_CONFIGURED','FAILED','STALE','NEEDS_ACTION','UNVERIFIED','DISABLED','MANUAL','IDLE','RUNNING','RETRY')),
 observed_at timestamptz not null,
 correlation uuid not null,
 primary key(environment,component)
);
create table if not exists private.system_health_incidents (
 id uuid primary key default gen_random_uuid(),
 environment text not null check(environment in ('test','production','training','recovery')),
 component text not null check(component in ('app','database','storage','drive','ocr','telegram','backup')),
 code text not null check(code in ('UNAVAILABLE','TIMEOUT','FAILED','STALE')),
 correlation uuid not null,
 first_at timestamptz not null,
 last_at timestamptz not null,
 occurrences bigint not null default 1 check(occurrences>0),
 recovered_at timestamptz
);
create unique index if not exists system_health_one_open on private.system_health_incidents(environment,component,code) where recovered_at is null;
create index if not exists system_health_history on private.system_health_incidents(environment,last_at desc,id);

create table if not exists private.system_health_delivery (
 id uuid primary key default gen_random_uuid(),
 incident_id uuid not null references private.system_health_incidents(id) on delete cascade,
 phase text not null check(phase in ('opened','recovered')),
 state text not null default 'queued' check(state in ('queued','sending','sent','failed')),
 attempts integer not null default 0,
 available_at timestamptz not null default now(),
 lease_until timestamptz,
 claim uuid,
 unique(incident_id,phase)
);
create index if not exists system_health_delivery_pending on private.system_health_delivery(state,available_at);
alter table private.system_health_current enable row level security;
alter table private.system_health_incidents enable row level security;
alter table private.system_health_delivery enable row level security;
revoke all on private.system_health_current,private.system_health_incidents,private.system_health_delivery from public,anon,authenticated,service_role;

create or replace function public.system_health_ping() returns boolean
language sql stable security definer set search_path='' as $$select true$$;

create or replace function public.record_system_health(p_environment text,p_component text,p_code text,p_observed_at timestamptz,p_correlation uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 previous private.system_health_current%rowtype;
 incident private.system_health_incidents%rowtype;
 recovered private.system_health_incidents%rowtype;
 is_failure boolean;
begin
 if p_environment is null or p_environment not in ('test','production','training','recovery')
   or p_component is null or p_component not in ('app','database','storage','drive','ocr','telegram','backup')
   or p_code is null or p_code not in ('OK','UNAVAILABLE','TIMEOUT','NOT_CONFIGURED','FAILED','STALE','NEEDS_ACTION','UNVERIFIED','DISABLED','MANUAL','IDLE','RUNNING','RETRY')
   or p_correlation is null or p_observed_at is null
   or p_observed_at>clock_timestamp()+interval '30 seconds' or p_observed_at<clock_timestamp()-interval '1 day' then
   raise exception 'Некорректное техническое наблюдение' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('system-health:'||p_environment||':'||p_component,0));
 select * into previous from private.system_health_current where environment=p_environment and component=p_component for update;
 if found and p_observed_at<=previous.observed_at then
   if p_correlation=previous.correlation and p_code<>previous.code then
     raise exception 'Идентификатор наблюдения уже использован' using errcode='22023';
   end if;
   return jsonb_build_object('accepted',false,'reason','OLDER_OR_REPEATED');
 end if;
 if found and p_correlation=previous.correlation then raise exception 'Идентификатор наблюдения уже использован' using errcode='22023'; end if;
 insert into private.system_health_current(environment,component,code,observed_at,correlation)
 values(p_environment,p_component,p_code,p_observed_at,p_correlation)
 on conflict(environment,component) do update set code=excluded.code,observed_at=excluded.observed_at,correlation=excluded.correlation;

 -- Only a proven healthy result closes an incident. Disabled/unverified cannot hide a failure.
 if p_code='OK' then
   for recovered in update private.system_health_incidents set recovered_at=p_observed_at,last_at=p_observed_at
     where environment=p_environment and component=p_component and recovered_at is null returning *
   loop
     insert into private.system_health_delivery(incident_id,phase) values(recovered.id,'recovered') on conflict do nothing;
     insert into public.notifications(recipient_user_id,type,title,body,entity_type,entity_id)
     select p.id,'system','Работа компонента восстановлена',p_component||' · OK','system_health',recovered.id
     from public.profiles p where private.user_has_permission(p.id,'system.health.view');
   end loop;
 end if;
 is_failure:=p_code in ('UNAVAILABLE','TIMEOUT','FAILED','STALE');
 if is_failure then
   select * into incident from private.system_health_incidents
     where environment=p_environment and component=p_component and code=p_code and recovered_at is null for update;
   if found then
     update private.system_health_incidents set last_at=p_observed_at,occurrences=occurrences+1 where id=incident.id;
   else
     insert into private.system_health_incidents(environment,component,code,correlation,first_at,last_at)
     values(p_environment,p_component,p_code,p_correlation,p_observed_at,p_observed_at) returning * into incident;
     insert into private.system_health_delivery(incident_id,phase) values(incident.id,'opened');
     insert into public.notifications(recipient_user_id,type,title,body,entity_type,entity_id)
     select p.id,'system','Системе требуется внимание',p_component||' · '||p_code,'system_health',incident.id
     from public.profiles p where private.user_has_permission(p.id,'system.health.view');
   end if;
 end if;
 return jsonb_build_object('accepted',true,'incident',incident.id);
end $$;

create or replace function public.system_health_snapshot(p_environment text,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if not private.has_permission('system.health.view') then raise exception 'Нет доступа к диагностике' using errcode='42501'; end if;
 if p_environment is null or p_environment not in ('test','production','training','recovery') or p_offset is null or p_offset<0 or p_offset>1000000 then raise exception 'Некорректный запрос' using errcode='22023'; end if;
 select jsonb_build_object(
   'observedAt',clock_timestamp(),
   'current',coalesce((select jsonb_agg(to_jsonb(s)) from private.system_health_current s where environment=p_environment),'[]'::jsonb),
   'incidents',coalesce((select jsonb_agg(to_jsonb(s)) from (select * from private.system_health_incidents where environment=p_environment order by last_at desc,id limit 51 offset p_offset) s),'[]'::jsonb),
   'delivery',jsonb_build_object('queued',(select count(*) from private.system_health_delivery d join private.system_health_incidents i on i.id=d.incident_id where i.environment=p_environment and d.state in ('queued','sending')),'failed',(select count(*) from private.system_health_delivery d join private.system_health_incidents i on i.id=d.incident_id where i.environment=p_environment and d.state='failed'))
 ) into result;
 return result;
end $$;

create or replace function public.system_health_jobs() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if coalesce(current_setting('role',true),'')<>'service_role' and not private.has_permission('system.health.view') then
   raise exception 'Нет доступа к диагностике' using errcode='42501';
 end if;
 -- No names, questions, chat IDs, document IDs or raw provider errors cross this boundary.
 with events as (
   select 'drive' as component,state as status,started_at as started,finished_at as finished,lease_until as lease from public.shipment_drive_operations
   union all select 'drive',case status when 'completed' then 'completed' when 'failed' then 'failed' else 'running' end,started_at,finished_at,started_at+interval '10 minutes' from public.drive_catalog_runs
   union all select 'ocr',case status when 'pending' then 'running' when 'failed' then 'failed' when 'needs_review' then 'needs_action' else 'completed' end,created_at,processing_finished_at,ocr_lease_until from public.shipment_source_extractions where status<>'superseded'
   union all select 'telegram',case status when 'completed' then 'completed' when 'failed' then 'failed' when 'delivery_unknown' then 'needs_action' else 'running' end,created_at,finished_at,updated_at+interval '5 minutes' from public.telegram_updates
 ), summary as (
   select c.component,jsonb_build_object(
    'queued',0,'running',count(*) filter(where e.status='running' and e.lease>now()),'retry',0,
    'needsAction',count(*) filter(where e.status='needs_action'),
    'expired',count(*) filter(where e.status='running' and (e.lease is null or e.lease<=now())),
    'failed',count(*) filter(where e.status='failed'),
    'lastSuccess',max(e.finished) filter(where e.status='completed'),'lastAttempt',max(e.started)
   ) as facts
   from (values('drive'),('ocr'),('telegram')) c(component) left join events e on e.component=c.component group by c.component
 ) select jsonb_object_agg(component,facts) into result from summary;
 return result;
end $$;

-- A bounded outbox for the separately enabled technical channel, not the document-processing queue.
create or replace function public.claim_system_health_delivery(p_environment text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d private.system_health_delivery%rowtype; i private.system_health_incidents%rowtype;
begin
 if p_environment is null or p_environment not in ('test','production','training','recovery') then raise exception 'Некорректная среда' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('system-health-delivery:'||p_environment,0));
 -- One outstanding lease and at most one start each 30 seconds per environment, including retries.
 if exists(select 1 from private.system_health_delivery q join private.system_health_incidents x on x.id=q.incident_id
   where x.environment=p_environment and q.lease_until>now()) then return null; end if;
 update private.system_health_delivery q set state='failed'
   from private.system_health_incidents x where x.id=q.incident_id and x.environment=p_environment and q.attempts>=5 and q.state<>'sent' and coalesce(q.lease_until,'-infinity')<=now();
 select q.* into d from private.system_health_delivery q join private.system_health_incidents x on x.id=q.incident_id
   where x.environment=p_environment and q.state in ('queued','sending') and q.available_at<=now() and coalesce(q.lease_until,'-infinity')<=now() and q.attempts<5
   order by q.available_at,q.id limit 1 for update of q skip locked;
 if not found then return null; end if;
 update private.system_health_delivery set state='sending',attempts=attempts+1,claim=gen_random_uuid(),lease_until=now()+interval '60 seconds'
 where id=d.id returning * into d;
 select * into i from private.system_health_incidents where id=d.incident_id;
 return jsonb_build_object('id',d.id,'claim',d.claim,'component',i.component,'code',case when d.phase='recovered' then 'OK' else i.code end,'observedAt',case when d.phase='recovered' then i.recovered_at else i.first_at end,'correlation',i.correlation);
end $$;

create or replace function public.finish_system_health_delivery(p_id uuid,p_claim uuid,p_success boolean)
returns boolean language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 if p_success is null then raise exception 'Некорректный результат' using errcode='22023'; end if;
 update private.system_health_delivery set state=case when p_success then 'sent' when attempts>=5 then 'failed' else 'queued' end,
   available_at=now()+make_interval(secs=>least(3600,30*power(2,attempts)::integer)),lease_until=now()+interval '30 seconds'
 where id=p_id and claim=p_claim and state='sending' and lease_until>now();
 get diagnostics n=row_count;
 return n=1;
end $$;

revoke all on function public.system_health_ping(),public.record_system_health(text,text,text,timestamptz,uuid),
 public.system_health_snapshot(text,integer),public.system_health_jobs(),public.claim_system_health_delivery(text),public.finish_system_health_delivery(uuid,uuid,boolean)
 from public,anon,authenticated,service_role;
grant execute on function public.system_health_snapshot(text,integer),public.system_health_jobs() to authenticated;
grant execute on function public.system_health_ping(),public.record_system_health(text,text,text,timestamptz,uuid),public.system_health_jobs(),
 public.claim_system_health_delivery(text),public.finish_system_health_delivery(uuid,uuid,boolean) to service_role;
