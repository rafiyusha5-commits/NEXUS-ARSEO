-- Personal Telegram channel. Business data is still read with an employee Auth session.
create table if not exists public.telegram_links (
 user_id uuid primary key references public.profiles(id) on delete cascade,
 chat_id bigint unique check(chat_id>0 and chat_id<=9007199254740991),
 display_name text check(length(display_name)<=100), linked_at timestamptz,
 pending_chat_id bigint check(pending_chat_id>0 and pending_chat_id<=9007199254740991),
 pending_name text check(length(pending_name)<=100), pending_until timestamptz,
 updated_at timestamptz not null default now()
);
create table if not exists public.telegram_link_codes (
 user_id uuid primary key references public.profiles(id) on delete cascade,
 code_hash text not null unique check(length(code_hash)=64), expires_at timestamptz not null
);
create table if not exists public.telegram_updates (
 update_id bigint primary key check(update_id>=0 and update_id<=9007199254740991),
 chat_id bigint not null check(chat_id>0 and chat_id<=9007199254740991),
 claim_hash text not null check(length(claim_hash)=64),
 status text not null default 'processing' check(status in ('processing','completed','failed','delivery_started')),
 created_at timestamptz not null default now(), finished_at timestamptz
);
do $$declare t text;begin foreach t in array array['telegram_links','telegram_link_codes','telegram_updates'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
end loop;end$$;
grant select(user_id,chat_id,display_name,linked_at,pending_chat_id,pending_name,pending_until,updated_at) on public.telegram_links to authenticated;
drop policy if exists "own Telegram link" on public.telegram_links;
create policy "own Telegram link" on public.telegram_links for select to authenticated
 using(user_id=(select auth.uid()) and (select private.has_permission('agent.use')));

create or replace function public.create_my_telegram_code() returns text
language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid();v_code text;
begin
 if v_user is null or not private.user_has_permission(v_user,'agent.use') then raise exception 'AGENT_FORBIDDEN' using errcode='42501';end if;
 v_code:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
 insert into public.telegram_link_codes(user_id,code_hash,expires_at)
 values(v_user,encode(sha256(convert_to(v_code,'UTF8')),'hex'),now()+interval '10 minutes')
 on conflict(user_id) do update set code_hash=excluded.code_hash,expires_at=excluded.expires_at;
 -- A new code invalidates any older unconfirmed request.
 update public.telegram_links set pending_chat_id=null,pending_name=null,pending_until=null,updated_at=now() where user_id=v_user;
 return v_code;
end$$;

create or replace function public.telegram_request_link(p_code text,p_chat_id bigint,p_name text) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_user uuid;
begin
 if p_code is null or p_code!~'^[a-f0-9]{64}$' or p_chat_id is null or p_chat_id<=0 or p_chat_id>9007199254740991 then return false;end if;
 select c.user_id into v_user from public.telegram_link_codes c
 where c.code_hash=encode(sha256(convert_to(p_code,'UTF8')),'hex') and c.expires_at>now() for update;
 if v_user is null or not private.user_has_permission(v_user,'agent.use') then return false;end if;
 delete from public.telegram_link_codes where user_id=v_user;
 insert into public.telegram_links(user_id,pending_chat_id,pending_name,pending_until)
 values(v_user,p_chat_id,left(coalesce(p_name,''),100),now()+interval '10 minutes')
 on conflict(user_id) do update set pending_chat_id=excluded.pending_chat_id,pending_name=excluded.pending_name,
 pending_until=excluded.pending_until,updated_at=now();
 return true;
end$$;

create or replace function public.confirm_my_telegram_link() returns void
language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid();v_link public.telegram_links%rowtype;
begin
 if v_user is null or not private.user_has_permission(v_user,'agent.use') then raise exception 'AGENT_FORBIDDEN' using errcode='42501';end if;
 select * into v_link from public.telegram_links where user_id=v_user for update;
 if v_link.pending_chat_id is null or v_link.pending_until<=now() then raise exception 'TELEGRAM_LINK_EXPIRED';end if;
 update public.telegram_links set chat_id=pending_chat_id,display_name=pending_name,linked_at=now(),
 pending_chat_id=null,pending_name=null,pending_until=null,updated_at=now() where user_id=v_user;
end$$;

create or replace function public.unlink_my_telegram() returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'AGENT_FORBIDDEN' using errcode='42501';end if;
 delete from public.telegram_link_codes where user_id=auth.uid();
 delete from public.telegram_links where user_id=auth.uid();
end$$;

create or replace function public.telegram_employee(p_chat_id bigint) returns uuid
language sql stable security definer set search_path='' as $$
 select l.user_id from public.telegram_links l
 where l.chat_id=p_chat_id and private.user_has_permission(l.user_id,'agent.use');
$$;
create or replace function public.telegram_unlink_chat(p_chat_id bigint) returns void
language plpgsql security definer set search_path='' as $$
begin
 delete from public.telegram_link_codes where user_id in(select user_id from public.telegram_links where chat_id=p_chat_id or pending_chat_id=p_chat_id);
 delete from public.telegram_links where chat_id=p_chat_id or pending_chat_id=p_chat_id;
end$$;

-- Durable deduplication. Replayed or abandoned updates are never automatically re-run.
create or replace function public.telegram_claim_update(p_update_id bigint,p_chat_id bigint) returns text
language plpgsql security definer set search_path='' as $$
declare v_token text;v_inserted bigint;
begin
 v_token:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
 insert into public.telegram_updates(update_id,chat_id,claim_hash)
 values(p_update_id,p_chat_id,encode(sha256(convert_to(v_token,'UTF8')),'hex')) on conflict do nothing;
 get diagnostics v_inserted=row_count;
 if v_inserted=0 then return null;end if;
 return v_token;
end$$;
create or replace function public.telegram_update_status(p_update_id bigint,p_token text,p_status text) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_updated bigint;
begin
 if p_status not in ('completed','failed','delivery_started') then return false;end if;
 update public.telegram_updates set status=p_status,finished_at=case when p_status='delivery_started' then null else now() end
 where update_id=p_update_id and claim_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex')
 and (status='processing' or (status='delivery_started' and p_status in ('completed','failed')));
 get diagnostics v_updated=row_count;
 return v_updated=1;
end$$;

-- Link audit stores chat metadata only; it must never include a one-time code or user session.
drop trigger if exists audit_telegram_link_changes on public.telegram_links;
create trigger audit_telegram_link_changes after insert or update or delete on public.telegram_links
 for each row execute function private.write_access_audit();

do $$declare f text;begin foreach f in array array[
 'public.create_my_telegram_code()','public.confirm_my_telegram_link()','public.unlink_my_telegram()',
 'public.telegram_request_link(text,bigint,text)','public.telegram_employee(bigint)','public.telegram_unlink_chat(bigint)',
 'public.telegram_claim_update(bigint,bigint)','public.telegram_update_status(bigint,text,text)'
] loop execute format('revoke all on function %s from public,anon,authenticated,service_role',f);end loop;end$$;
grant execute on function public.create_my_telegram_code(),public.confirm_my_telegram_link(),public.unlink_my_telegram() to authenticated;
grant execute on function public.telegram_request_link(text,bigint,text),public.telegram_employee(bigint),public.telegram_unlink_chat(bigint),
 public.telegram_claim_update(bigint,bigint),public.telegram_update_status(bigint,text,text) to service_role;
