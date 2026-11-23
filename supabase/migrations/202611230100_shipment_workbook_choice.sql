-- The «Вн расчеты» a shipment works with (2026-11-23). An order folder may hold several workbooks of the same order
-- (the original and «Копия для расчетов …»); the employee picks one once and the review page opens it from then on.
-- The Drive file id does not change when the table is renamed or moved inside the folder. Read with shipments.view,
-- chosen with shipments.update, and only among the Google tables of the shipment's checked folder.
begin;

create table if not exists public.shipment_workbook_choices (
  shipment_id uuid primary key references public.shipments(id) on delete restrict,
  file_id text not null check (file_id ~ '^[A-Za-z0-9_-]{10,120}$'),
  chosen_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  chosen_at timestamptz not null default clock_timestamp()
);
create index if not exists shipment_workbook_choices_chosen_by_idx on public.shipment_workbook_choices(chosen_by);
alter table public.shipment_workbook_choices enable row level security;
revoke all on public.shipment_workbook_choices from public, anon, authenticated, service_role;
grant select on public.shipment_workbook_choices to authenticated;
drop policy if exists "employees view workbook choices" on public.shipment_workbook_choices;
create policy "employees view workbook choices" on public.shipment_workbook_choices for select to authenticated
  using ((select private.is_employee()) and (select private.has_permission('shipments.view')));

create or replace function public.choose_shipment_workbook(p_shipment_id uuid, p_file_id text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.can_write_shipments('update') then raise exception 'Недостаточно прав для изменения поставки' using errcode = '42501'; end if;
  if not exists (select 1 from public.shipment_drive_files f where f.shipment_id = p_shipment_id and f.file_id = p_file_id and f.present
                 and f.mime_type = 'application/vnd.google-apps.spreadsheet') then
    raise exception 'Таблица не найдена в папке поставки. Обновите папку из Drive' using errcode = 'P0001';
  end if;
  insert into public.shipment_workbook_choices as c (shipment_id, file_id) values (p_shipment_id, p_file_id)
  on conflict (shipment_id) do update set file_id = excluded.file_id, chosen_by = auth.uid(), chosen_at = clock_timestamp();
end $$;
revoke all on function public.choose_shipment_workbook(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.choose_shipment_workbook(uuid, text) to authenticated;

commit;
