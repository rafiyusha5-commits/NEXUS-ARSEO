-- Order prefixes (2026-11-22, «Создать поставку из папки Drive»): the letters that start an order folder on Google
-- Drive name its customer — for example a prefix of a Russian retail customer, or one that stands for the company's own
-- Kazakhstan stock. The list itself is business data: it is entered on the screen, not in this migration.
-- Read with shipments.view; changed with shipments.create (whoever creates shipments from folders).
begin;

create table if not exists public.order_prefixes (
  prefix text primary key check (prefix ~ '^[A-Za-z]{1,12}$'),
  counterparty_id uuid references public.counterparties(id) on delete restrict,
  is_own_stock boolean not null default false,
  note text check (note is null or length(btrim(note)) between 1 and 200),
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (is_own_stock = (counterparty_id is null))
);
create unique index if not exists order_prefixes_key on public.order_prefixes(upper(prefix));
create index if not exists order_prefixes_counterparty_id_idx on public.order_prefixes(counterparty_id);
create index if not exists order_prefixes_created_by_idx on public.order_prefixes(created_by);

alter table public.order_prefixes enable row level security;
revoke all on public.order_prefixes from public, anon, authenticated, service_role;
grant select on public.order_prefixes to authenticated;
drop policy if exists "employees view order prefixes" on public.order_prefixes;
create policy "employees view order prefixes" on public.order_prefixes
  for select to authenticated using ((select private.is_employee()) and (select private.has_permission('shipments.view')));

-- Adds or changes a prefix. A customer prefix names an active customer; an own-stock prefix names none.
create or replace function public.set_order_prefix(p_prefix text, p_counterparty_id uuid, p_is_own_stock boolean, p_note text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_prefix text := btrim(coalesce(p_prefix, ''));
begin
  if not ((select private.is_employee()) and (select private.has_permission('shipments.create'))) then
    raise exception 'Нет права изменять префиксы заказов' using errcode = '42501';
  end if;
  if v_prefix !~ '^[A-Za-z]{1,12}$' then raise exception 'Префикс — от 1 до 12 латинских букв' using errcode = 'P0001'; end if;
  if coalesce(p_is_own_stock, false) then
    if p_counterparty_id is not null then raise exception 'Префикс своих складов не связывается с клиентом' using errcode = 'P0001'; end if;
  elsif p_counterparty_id is null or not exists (select 1 from public.counterparties c where c.id = p_counterparty_id and c.status = 'active' and 'customer' = any(c.roles)) then
    raise exception 'Выберите активного клиента' using errcode = 'P0001';
  end if;
  insert into public.order_prefixes as o (prefix, counterparty_id, is_own_stock, note)
  values (v_prefix, case when coalesce(p_is_own_stock, false) then null else p_counterparty_id end, coalesce(p_is_own_stock, false), nullif(btrim(p_note), ''))
  on conflict ((upper(prefix))) do update
    set prefix = excluded.prefix, counterparty_id = excluded.counterparty_id, is_own_stock = excluded.is_own_stock,
        note = excluded.note, updated_at = clock_timestamp();
end $$;
revoke all on function public.set_order_prefix(text, uuid, boolean, text) from public, anon, authenticated, service_role;
grant execute on function public.set_order_prefix(text, uuid, boolean, text) to authenticated;

create or replace function public.remove_order_prefix(p_prefix text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not ((select private.is_employee()) and (select private.has_permission('shipments.create'))) then
    raise exception 'Нет права изменять префиксы заказов' using errcode = '42501';
  end if;
  delete from public.order_prefixes where upper(prefix) = upper(btrim(coalesce(p_prefix, '')));
end $$;
revoke all on function public.remove_order_prefix(text) from public, anon, authenticated, service_role;
grant execute on function public.remove_order_prefix(text) to authenticated;

commit;
