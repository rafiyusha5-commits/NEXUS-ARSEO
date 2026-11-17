-- Block 4: Nexus notifications delivered to the employee's own linked Telegram chat.
-- Owner decisions of 2026-11-16 (damirator1-afk):
--   * only what needs the employee's action: task assigned, task overdue, order cannot ship, batch at shelf-life risk,
--     approval requested (and "Проверьте цену" of block 1Б, which needs a price decision); nothing informational;
--   * only to the recipient, in the personal chat linked by that employee; no group chats;
--   * quiet hours 21:00-08:00 Kazakhstan time: nothing is sent, in the morning the waiting ones come as one summary;
--   * older than 12 hours (the bot was off): not sent one by one, one line "N unread notifications" instead;
--   * the same reminder about the same object at most once a day;
--   * off by default; only the employee turns it on; an administrator sees who has it on but cannot turn it on.
-- The text is fixed per type plus a link: no prices, amounts, personal data or document text, whatever the
-- notification says. Rights, the link and the settings are checked again when the message is prepared.
-- At most one Telegram message per notification: a message whose outcome is unknown is never sent again.
-- The in-app notification never depends on Telegram. Sending runs in the existing bot worker (no new service).
begin;

alter table public.notification_deliveries drop constraint if exists notification_deliveries_channel_check;
alter table public.notification_deliveries add constraint notification_deliveries_channel_check
  check (channel in ('in_app', 'email', 'whatsapp', 'telegram'));
alter table public.notification_deliveries drop constraint if exists notification_deliveries_status_check;
alter table public.notification_deliveries add constraint notification_deliveries_status_check
  check (status in ('queued', 'sending', 'sent', 'delivered', 'failed', 'skipped'));
alter table public.notification_deliveries
  add column if not exists recipient_user_id uuid references public.profiles(id) on delete cascade,
  add column if not exists attempts integer not null default 0,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists claim_token uuid,
  add column if not exists claimed_until timestamptz,
  add column if not exists external_message_id bigint,
  add column if not exists updated_at timestamptz not null default now();
create unique index if not exists notification_deliveries_one_telegram
  on public.notification_deliveries(notification_id) where channel = 'telegram';
create index if not exists notification_deliveries_telegram_queue
  on public.notification_deliveries(next_attempt_at, created_at) where channel = 'telegram' and status = 'queued';
create index if not exists notification_deliveries_recipient_idx on public.notification_deliveries(recipient_user_id);

-- Settings: one row per employee; enabled = false until the employee turns it on.
create table if not exists public.telegram_notification_settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  enabled boolean not null default false,
  types text[] not null default '{}',
  updated_at timestamptz not null default now()
);
alter table public.telegram_notification_settings enable row level security;
revoke all on public.telegram_notification_settings from public, anon, authenticated, service_role;

create or replace function private.telegram_notification_types() returns text[]
language sql immutable set search_path = '' as $$
  select array['task_assigned', 'overdue', 'order_blocked', 'low_shelf_life', 'approval_request', 'price_review']
$$;
revoke all on function private.telegram_notification_types() from public, anon, authenticated, service_role;

-- May this employee still see this notification's object? notification_visible_to plus the rights of the object.
create or replace function private.telegram_notification_allowed(p_user uuid, p_notification public.notifications)
returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_active_employee(p_user)
     and private.notification_visible_to(p_user, p_notification.entity_type, p_notification.shipment_id)
     and case p_notification.entity_type
           when 'sale' then private.user_has_permission(p_user, 'sales.view')
           when 'price_review' then private.user_has_permission(p_user, 'prices.purchase.view') and private.user_has_permission(p_user, 'pricing.list.manage')
           when 'shelf_life_control' then private.user_has_permission(p_user, 'inventory.view')
           when 'shipment_document_check' then private.user_has_permission(p_user, 'shipments.view') and private.user_has_permission(p_user, 'documents.view')
           else true end
$$;
revoke all on function private.telegram_notification_allowed(uuid, public.notifications) from public, anon, authenticated, service_role;

-- Queue: a new notification of a chosen type for an employee with delivery on. The same type about the same
-- object within 24 hours is recorded as skipped (throttled), not queued.
create or replace function private.queue_telegram_delivery() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    if not new.type = any(private.telegram_notification_types()) then return null; end if;
    if not exists (select 1 from public.telegram_notification_settings s
                    where s.user_id = new.recipient_user_id and s.enabled and new.type = any(s.types)) then return null; end if;
    insert into public.notification_deliveries(notification_id, channel, status, recipient_user_id, next_attempt_at, error_message)
    select new.id, 'telegram',
           case when exists (select 1 from public.notification_deliveries d join public.notifications n on n.id = d.notification_id
                              where d.channel = 'telegram' and d.recipient_user_id = new.recipient_user_id
                                and n.type = new.type and n.entity_id is not distinct from new.entity_id and new.entity_id is not null
                                and d.status in ('queued', 'sending', 'sent') and d.created_at > now() - interval '24 hours')
                then 'skipped' else 'queued' end,
           new.recipient_user_id, now(), null
    on conflict do nothing;
    update public.notification_deliveries set error_message = 'throttled'
     where notification_id = new.id and channel = 'telegram' and status = 'skipped' and error_message is null;
  exception when others then
    -- The in-app notification is never lost because of the Telegram queue.
    raise warning 'telegram delivery not queued: %', sqlerrm;
  end;
  return null;
end $$;
revoke all on function private.queue_telegram_delivery() from public, anon, authenticated, service_role;
drop trigger if exists notifications_queue_telegram on public.notifications;
create trigger notifications_queue_telegram after insert on public.notifications
  for each row execute function private.queue_telegram_delivery();

-- Employee: own settings ------------------------------------------------------------------------------------------
create or replace function public.my_telegram_notifications() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'enabled', coalesce(s.enabled, false), 'types', coalesce(to_jsonb(s.types), '[]'::jsonb),
    'available', to_jsonb(private.telegram_notification_types()),
    'linked', exists (select 1 from public.telegram_links l where l.user_id = auth.uid() and l.chat_id is not null))
  from (select 1) x left join public.telegram_notification_settings s on s.user_id = auth.uid()
  where private.is_employee()
$$;
revoke all on function public.my_telegram_notifications() from public, anon, authenticated, service_role;
grant execute on function public.my_telegram_notifications() to authenticated;

create or replace function public.set_my_telegram_notifications(p_enabled boolean, p_types text[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_employee() then raise exception 'Нет доступа' using errcode = '42501'; end if;
  if p_enabled is null or p_types is null or not p_types <@ private.telegram_notification_types() or cardinality(p_types) > 10 then
    raise exception 'Выберите типы уведомлений из списка';
  end if;
  if p_enabled and not exists (select 1 from public.telegram_links where user_id = auth.uid() and chat_id is not null) then
    raise exception 'Сначала подключите личный чат Telegram';
  end if;
  insert into public.telegram_notification_settings(user_id, enabled, types, updated_at)
  values (auth.uid(), p_enabled, (select coalesce(array_agg(distinct t order by t), '{}') from unnest(p_types) t), now())
  on conflict (user_id) do update set enabled = excluded.enabled, types = excluded.types, updated_at = now();
end $$;
revoke all on function public.set_my_telegram_notifications(boolean, text[]) from public, anon, authenticated, service_role;
grant execute on function public.set_my_telegram_notifications(boolean, text[]) to authenticated;

-- Administrator: who has delivery on (read only) and the state of the queue for "Состояние системы".
create or replace function public.telegram_notification_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.has_permission('system.health.view') and not private.has_permission('users.manage') then
    raise exception 'Нет доступа' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'enabled_users', (select coalesce(jsonb_agg(jsonb_build_object('name', p.full_name, 'types', s.types, 'linked',
                        exists (select 1 from public.telegram_links l where l.user_id = s.user_id and l.chat_id is not null))
                        order by p.full_name), '[]'::jsonb)
                      from public.telegram_notification_settings s join public.profiles p on p.id = s.user_id where s.enabled),
    'queued', (select count(*) from public.notification_deliveries where channel = 'telegram' and status = 'queued'),
    'sending', (select count(*) from public.notification_deliveries where channel = 'telegram' and status = 'sending'),
    'oldest_queued', (select min(created_at) from public.notification_deliveries where channel = 'telegram' and status = 'queued'),
    'last_24h', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) n from public.notification_deliveries
                  where channel = 'telegram' and updated_at > now() - interval '24 hours' group by status) x),
    'recent_errors', (select coalesce(jsonb_agg(jsonb_build_object('at', updated_at, 'status', status, 'error', error_message)
                        order by updated_at desc), '[]'::jsonb)
                      from (select * from public.notification_deliveries where channel = 'telegram' and status in ('failed', 'skipped')
                              and error_message is not null order by updated_at desc limit 10) e));
end $$;
revoke all on function public.telegram_notification_overview() from public, anon, authenticated, service_role;
grant execute on function public.telegram_notification_overview() to authenticated;

-- Worker (service_role only) ---------------------------------------------------------------------------------------
-- Claims what may be sent now, grouped by employee. Re-checks rights, settings and the chat; marks the rest skipped.
-- A delivery left in "sending" by a crashed worker is failed (outcome unknown), never sent a second time.
-- p_now exists for tests only (quiet hours, staleness); the worker never passes it.
create or replace function public.telegram_notification_batch(p_limit integer default 50, p_now timestamptz default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := coalesce(p_now, clock_timestamp());
  v_local time := (v_now at time zone 'Asia/Almaty')::time;
  v_token uuid := gen_random_uuid();
  d record;
  v_users jsonb := '{}'::jsonb;
  v_reason text;
begin
  update public.notification_deliveries set status = 'failed', error_message = 'outcome_unknown', claim_token = null, updated_at = v_now
   where channel = 'telegram' and status = 'sending' and claimed_until < v_now;
  if v_local >= time '21:00' or v_local < time '08:00' then
    return jsonb_build_object('quiet', true, 'token', null, 'users', '[]'::jsonb);
  end if;
  for d in
    select dl.id, dl.recipient_user_id, dl.created_at, n as notification, l.chat_id, s.enabled, s.types
      from public.notification_deliveries dl
      join public.notifications n on n.id = dl.notification_id
      left join public.telegram_links l on l.user_id = dl.recipient_user_id
      left join public.telegram_notification_settings s on s.user_id = dl.recipient_user_id
     where dl.channel = 'telegram' and dl.status = 'queued' and coalesce(dl.next_attempt_at, dl.created_at) <= v_now
     order by dl.created_at, dl.id
     limit greatest(1, least(coalesce(p_limit, 50), 200))
     for update of dl skip locked
  loop
    v_reason := case
      when not coalesce(d.enabled, false) then 'disabled'
      when not (d.notification).type = any(coalesce(d.types, '{}')) then 'type_not_selected'
      when d.chat_id is null then 'chat_not_linked'
      when not private.telegram_notification_allowed(d.recipient_user_id, d.notification) then 'no_access'
      end;
    if v_reason is not null then
      update public.notification_deliveries set status = 'skipped', error_message = v_reason, updated_at = v_now where id = d.id;
      continue;
    end if;
    update public.notification_deliveries
       set status = 'sending', claim_token = v_token, claimed_until = v_now + interval '2 minutes', attempts = attempts + 1,
           attempted_at = v_now, updated_at = v_now
     where id = d.id;
    v_users := jsonb_set(v_users, array[d.recipient_user_id::text], coalesce(v_users->(d.recipient_user_id::text),
                 jsonb_build_object('user_id', d.recipient_user_id, 'chat_id', d.chat_id::text,
                   'unread', (select count(*) from public.notifications x where x.recipient_user_id = d.recipient_user_id and not x.is_read),
                   'items', '[]'::jsonb)), true);
    v_users := jsonb_set(v_users, array[d.recipient_user_id::text, 'items'],
                 (v_users->(d.recipient_user_id::text)->'items') || jsonb_build_array(jsonb_build_object(
                   'id', d.id, 'type', (d.notification).type, 'entity_type', (d.notification).entity_type,
                   'entity_id', (d.notification).entity_id, 'shipment_id', (d.notification).shipment_id,
                   'stale', d.created_at < v_now - interval '12 hours')));
  end loop;
  return jsonb_build_object('quiet', false, 'token', v_token,
    'users', (select coalesce(jsonb_agg(value), '[]'::jsonb) from jsonb_each(v_users)));
end $$;
drop function if exists public.telegram_notification_batch(integer);
revoke all on function public.telegram_notification_batch(integer, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.telegram_notification_batch(integer, timestamptz) to service_role;

-- The outcome of one message covering p_ids: sent (stale items are recorded as skipped, summarized), retry later
-- (Telegram definitely did not take it: limited attempts), or failed (refused, or outcome unknown: never resent).
create or replace function public.telegram_notification_result(p_token uuid, p_ids uuid[], p_outcome text,
                                                               p_message_id bigint default null, p_error text default null,
                                                               p_retry_after integer default null)
returns integer
language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz := clock_timestamp(); v_count integer;
begin
  if p_token is null or p_outcome not in ('sent', 'retry', 'failed') then raise exception 'TELEGRAM_RESULT_INVALID'; end if;
  if p_outcome = 'sent' then
    update public.notification_deliveries d
       set status = case when d.created_at < d.attempted_at - interval '12 hours' then 'skipped' else 'sent' end,
           error_message = case when d.created_at < d.attempted_at - interval '12 hours' then 'stale_summarized' end,
           external_message_id = p_message_id, claim_token = null, claimed_until = null, updated_at = v_now
     where d.id = any(p_ids) and d.claim_token = p_token and d.status = 'sending';
  elsif p_outcome = 'retry' then
    update public.notification_deliveries d
       set status = case when d.attempts >= 5 then 'failed' else 'queued' end,
           error_message = case when d.attempts >= 5 then 'retries_exhausted:' else '' end || left(coalesce(p_error, 'retry'), 60),
           next_attempt_at = v_now + make_interval(secs => greatest(coalesce(p_retry_after, 0), 60 * d.attempts)),
           claim_token = null, claimed_until = null, updated_at = v_now
     where d.id = any(p_ids) and d.claim_token = p_token and d.status = 'sending';
  else
    update public.notification_deliveries d
       set status = 'failed', error_message = left(coalesce(p_error, 'failed'), 60), claim_token = null, claimed_until = null, updated_at = v_now
     where d.id = any(p_ids) and d.claim_token = p_token and d.status = 'sending';
  end if;
  get diagnostics v_count = row_count;
  return v_count;
end $$;
revoke all on function public.telegram_notification_result(uuid, uuid[], text, bigint, text, integer) from public, anon, authenticated, service_role;
grant execute on function public.telegram_notification_result(uuid, uuid[], text, bigint, text, integer) to service_role;
commit;
