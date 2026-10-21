-- Preparation only. No document, shipment, inventory or financial facts are written.
create table if not exists public.historical_shipment_drafts (
 id uuid primary key,
 owner_id uuid not null default auth.uid() references public.profiles(id),
 source_shipment_id uuid not null references public.shipments(id),
 prepare_new boolean not null default false,
 revision integer not null default 1 check(revision>0),
 choices jsonb not null default '[]' check(jsonb_typeof(choices)='array' and jsonb_array_length(choices)<=500),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table public.historical_shipment_drafts enable row level security;
revoke all on public.historical_shipment_drafts from public,anon,authenticated,service_role;
grant select,insert,update on public.historical_shipment_drafts to authenticated;
drop policy if exists historical_draft_access on public.historical_shipment_drafts;
create policy historical_draft_access on public.historical_shipment_drafts to authenticated
 using(owner_id=auth.uid() and (select private.shipment_drive_allowed())
   and exists(select 1 from public.shipments s where s.id=source_shipment_id))
 with check(owner_id=auth.uid() and (select private.shipment_drive_allowed())
   and exists(select 1 from public.shipments s where s.id=source_shipment_id));

-- Trigger also protects direct REST writes, not just the form/RPC. The JSON is a
-- small reference-only vocabulary, never cached extracted/confirmed values.
create or replace function private.guard_historical_draft() returns trigger
language plpgsql security invoker set search_path='' as $$
declare c jsonb;
begin
 if not private.shipment_drive_allowed() or new.owner_id is distinct from auth.uid()
 then raise exception 'Недостаточно прав' using errcode='42501'; end if;
 if tg_op='UPDATE' and (new.id<>old.id or new.owner_id<>old.owner_id or new.source_shipment_id<>old.source_shipment_id
   or new.created_at<>old.created_at or new.revision<>old.revision+1) then
   raise exception 'Обновите проект перед сохранением' using errcode='40001';
 end if;
 if tg_op='INSERT' and new.revision<>1 then raise exception 'Некорректная ревизия'; end if;
 if not exists(select 1 from public.shipment_drive_folders where shipment_id=new.source_shipment_id)
 then raise exception 'Источник недоступен'; end if;
 if jsonb_typeof(new.choices) is distinct from 'array' or jsonb_array_length(new.choices)>500
 then raise exception 'Некорректный проект'; end if;
 if exists(select 1 from jsonb_array_elements(new.choices) x group by x->>'id' having count(*)>1)
 then raise exception 'Повтор источника'; end if;
 for c in select * from jsonb_array_elements(new.choices) loop
   if jsonb_typeof(c)<>'object' or not (c ?& array['id','version','updated','group','variant'])
     or c - array['id','version','updated','group','variant'] <> '{}'::jsonb
     or c->>'group' not in ('unknown','procurement','import_transport','customs','sale','export_transport')
     or c->>'variant' not in ('unknown','original','translation','copy','new_version')
     or exists(select 1 from jsonb_each(c) e where jsonb_typeof(e.value)<>'string')
   then raise exception 'Некорректный проект'; end if;
   if not exists(
     select 1 from public.shipment_source_extractions e
     join public.documents d on d.id=e.document_id
     join public.document_versions v on v.id=e.document_version_id and v.document_id=d.id
     where e.id=(c->>'id')::uuid and e.shipment_id=new.source_shipment_id
       and e.document_version_id=(c->>'version')::uuid and e.updated_at=(c->>'updated')::timestamptz
       and e.status in ('extracted','needs_review','confirmed') and d.archived_at is null and d.status<>'rejected'
       and v.is_current and v.version_number=d.current_version
       and (e.shipment_transport_id is null or exists(select 1 from public.shipment_transports t
         where t.id=e.shipment_transport_id and t.shipment_id=e.shipment_id and t.status<>'cancelled'))
       and exists(select 1 from public.document_links l where l.document_id=d.id and l.removed_at is null
         and (l.entity_type='shipment' and l.entity_id=e.shipment_id
           or l.entity_type='shipment_transport' and l.entity_id=e.shipment_transport_id))
   ) then raise exception 'Источник изменён или недоступен. Обновите проект' using errcode='40001'; end if;
 end loop;
 new.updated_at:=clock_timestamp();
 return new;
end $$;
revoke all on function private.guard_historical_draft() from public,anon,authenticated,service_role;
drop trigger if exists guard_historical_draft on public.historical_shipment_drafts;
create trigger guard_historical_draft before insert or update on public.historical_shipment_drafts
 for each row execute function private.guard_historical_draft();

create or replace function public.save_historical_shipment_draft(p_id uuid,p_shipment_id uuid,p_prepare_new boolean,p_revision integer,p_choices jsonb)
returns integer language plpgsql security invoker set search_path='' as $$
declare d public.historical_shipment_drafts%rowtype;
begin
 if not private.shipment_drive_allowed() then raise exception 'Недостаточно прав' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('historical-draft:'||p_id::text,0));
 select * into d from public.historical_shipment_drafts where id=p_id for update;
 if found then
   if d.source_shipment_id is distinct from p_shipment_id then raise exception 'Источник проекта не меняется'; end if;
   -- Lost-response replay, including from another browser: no extra revision/write.
   if d.choices=p_choices and d.prepare_new=p_prepare_new then return d.revision; end if;
   if d.revision<>p_revision then raise exception 'Проект изменён в другом окне. Обновите страницу' using errcode='40001'; end if;
   update public.historical_shipment_drafts set choices=p_choices,prepare_new=p_prepare_new,revision=revision+1 where id=p_id returning revision into p_revision;
 else
   if p_revision<>0 then raise exception 'Проект недоступен'; end if;
   insert into public.historical_shipment_drafts(id,source_shipment_id,prepare_new,choices) values(p_id,p_shipment_id,p_prepare_new,p_choices);
   p_revision:=1;
 end if;
 return p_revision;
end $$;
revoke all on function public.save_historical_shipment_draft(uuid,uuid,boolean,integer,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.save_historical_shipment_draft(uuid,uuid,boolean,integer,jsonb) to authenticated;
