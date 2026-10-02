-- Warehouse operation documents: draft -> posted -> cancelled, with atomic stock effects.

create sequence if not exists public.inventory_operation_document_no_seq;

create table if not exists public.inventory_operation_documents (
  id uuid primary key default gen_random_uuid(),
  document_number text not null unique,
  operation_type text not null check (operation_type in ('transfer','write_off','adjustment')),
  status text not null default 'draft' check (status in ('draft','posted','cancelled')),
  document_date date not null default current_date,
  from_warehouse_id uuid not null references public.warehouses(id) on delete restrict,
  to_warehouse_id uuid references public.warehouses(id) on delete restrict,
  reference text,
  reason text,
  performed_by_name text,
  created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
  posted_by uuid references public.profiles(id) on delete restrict,
  posted_at timestamptz,
  cancelled_by uuid references public.profiles(id) on delete restrict,
  cancelled_at timestamptz,
  cancellation_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (operation_type='transfer' and to_warehouse_id is not null and from_warehouse_id<>to_warehouse_id)
    or (operation_type in ('write_off','adjustment') and to_warehouse_id is null)
  ),
  check ((status='draft' and posted_at is null and cancelled_at is null)
    or (status='posted' and posted_at is not null and cancelled_at is null)
    or (status='cancelled' and cancelled_at is not null)),
  check (status<>'cancelled' or nullif(trim(cancellation_reason),'') is not null)
);

create table if not exists public.inventory_operation_lines (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.inventory_operation_documents(id) on delete restrict,
  source_balance_id uuid not null references public.inventory_balances(id) on delete restrict,
  batch_id uuid not null references public.inventory_batches(id) on delete restrict,
  from_location_id uuid references public.warehouse_locations(id) on delete restrict,
  to_location_id uuid references public.warehouse_locations(id) on delete restrict,
  uom text not null check (uom in ('piece','box','layer','pallet','truck')),
  quantity numeric(14,3) not null check (quantity>0),
  adjustment_direction text check (adjustment_direction in ('increase','decrease')),
  notes text,
  created_at timestamptz not null default now(),
  unique(document_id,source_balance_id,to_location_id),
  check (length(coalesce(notes,''))<=1000)
);

create index if not exists inventory_operation_documents_created_idx
  on public.inventory_operation_documents(created_at desc);
create index if not exists inventory_operation_documents_status_idx
  on public.inventory_operation_documents(status,document_date desc);
create index if not exists inventory_operation_lines_document_idx
  on public.inventory_operation_lines(document_id,created_at);
create unique index if not exists inventory_operation_lines_unique_source
  on public.inventory_operation_lines(document_id,source_balance_id,coalesce(to_location_id,'00000000-0000-0000-0000-000000000000'::uuid));

alter table public.inventory_movements
  add column if not exists inventory_operation_document_id uuid references public.inventory_operation_documents(id) on delete restrict,
  add column if not exists inventory_operation_line_id uuid references public.inventory_operation_lines(id) on delete restrict,
  add column if not exists is_reversal boolean not null default false;
create index if not exists inventory_movements_operation_document_idx
  on public.inventory_movements(inventory_operation_document_id,created_at);

alter table public.inventory_operation_documents enable row level security;
alter table public.inventory_operation_lines enable row level security;
revoke all on public.inventory_operation_documents,public.inventory_operation_lines from anon,authenticated;
grant select on public.inventory_operation_documents,public.inventory_operation_lines to authenticated;

drop policy if exists "employees view inventory operation documents" on public.inventory_operation_documents;
create policy "employees view inventory operation documents" on public.inventory_operation_documents
  for select to authenticated using ((select private.has_permission('inventory.view')));
drop policy if exists "employees view inventory operation lines" on public.inventory_operation_lines;
create policy "employees view inventory operation lines" on public.inventory_operation_lines
  for select to authenticated using ((select private.has_permission('inventory.view')));

create or replace function private.require_inventory_operation_permission(p_operation_type text)
returns void language plpgsql stable security definer set search_path='' as $$
begin
  if p_operation_type='transfer' and not (select private.has_permission('inventory.move')) then
    raise exception 'Недостаточно прав для перемещения товара';
  elsif p_operation_type='write_off' and not (select private.has_permission('inventory.write_off')) then
    raise exception 'Недостаточно прав для списания товара';
  elsif p_operation_type='adjustment' and not (select private.has_permission('inventory.control')) then
    raise exception 'Недостаточно прав для корректировки остатков';
  elsif p_operation_type not in ('transfer','write_off','adjustment') then
    raise exception 'Некорректный вид складской операции';
  end if;
end $$;
revoke all on function private.require_inventory_operation_permission(text) from public;

create or replace function public.create_inventory_operation_document(
  p_operation_type text,
  p_document_date date,
  p_from_warehouse_id uuid,
  p_to_warehouse_id uuid default null,
  p_reference text default null,
  p_reason text default null,
  p_performed_by_name text default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare
  v_id uuid;
  v_prefix text;
  v_number text;
begin
  perform private.require_inventory_operation_permission(p_operation_type);
  if not exists(select 1 from public.warehouses where id=p_from_warehouse_id and status='active') then
    raise exception 'Склад-отправитель недоступен';
  end if;
  if p_operation_type='transfer' then
    if p_to_warehouse_id is null or p_to_warehouse_id=p_from_warehouse_id
      or not exists(select 1 from public.warehouses where id=p_to_warehouse_id and status='active') then
      raise exception 'Выберите другой активный склад назначения';
    end if;
  elsif p_to_warehouse_id is not null then
    raise exception 'Склад назначения указывается только для перемещения';
  end if;
  if p_operation_type='write_off' and nullif(trim(p_reason),'') is null then
    raise exception 'Укажите причину списания';
  end if;
  v_prefix:=case p_operation_type when 'transfer' then 'ПРМ' when 'write_off' then 'СПС' else 'КОР' end;
  v_number:=v_prefix||'-'||to_char(coalesce(p_document_date,current_date),'YYYYMMDD')||'-'||lpad(nextval('public.inventory_operation_document_no_seq')::text,6,'0');
  insert into public.inventory_operation_documents(
    document_number,operation_type,document_date,from_warehouse_id,to_warehouse_id,reference,reason,performed_by_name,created_by
  ) values(
    v_number,p_operation_type,coalesce(p_document_date,current_date),p_from_warehouse_id,p_to_warehouse_id,
    nullif(trim(p_reference),''),nullif(trim(p_reason),''),nullif(trim(p_performed_by_name),''),auth.uid()
  ) returning id into v_id;
  return v_id;
end $$;

create or replace function public.add_inventory_operation_line(
  p_document_id uuid,
  p_source_balance_id uuid,
  p_to_location_id uuid,
  p_quantity numeric,
  p_adjustment_direction text default null,
  p_notes text default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare
  v_document record;
  v_balance record;
  v_id uuid;
begin
  select * into v_document from public.inventory_operation_documents where id=p_document_id for update;
  if not found then raise exception 'Складской документ не найден'; end if;
  perform private.require_inventory_operation_permission(v_document.operation_type);
  if v_document.status<>'draft' then raise exception 'Строки можно менять только в черновике'; end if;
  if p_quantity is null or p_quantity<=0 then raise exception 'Количество должно быть больше нуля'; end if;
  select balance.*,batch.status as batch_status into v_balance
  from public.inventory_balances balance join public.inventory_batches batch on batch.id=balance.batch_id
  where balance.id=p_source_balance_id;
  if not found or v_balance.warehouse_id<>v_document.from_warehouse_id then raise exception 'Остаток не относится к складу документа'; end if;
  if v_document.operation_type in ('transfer','write_off') and v_balance.batch_status<>'available' then raise exception 'Партия недоступна для операции'; end if;
  if v_document.operation_type='transfer' then
    if p_to_location_id is not null and not exists(
      select 1 from public.warehouse_locations where id=p_to_location_id and warehouse_id=v_document.to_warehouse_id and status='active'
    ) then raise exception 'Зона не относится к складу назначения'; end if;
    if p_adjustment_direction is not null then raise exception 'Направление корректировки здесь не используется'; end if;
  elsif p_to_location_id is not null then
    raise exception 'Зона назначения используется только при перемещении';
  elsif v_document.operation_type='adjustment' and p_adjustment_direction not in ('increase','decrease') then
    raise exception 'Выберите направление корректировки';
  elsif v_document.operation_type<>'adjustment' and p_adjustment_direction is not null then
    raise exception 'Направление корректировки здесь не используется';
  end if;
  insert into public.inventory_operation_lines(
    document_id,source_balance_id,batch_id,from_location_id,to_location_id,uom,quantity,adjustment_direction,notes
  ) values(
    p_document_id,p_source_balance_id,v_balance.batch_id,v_balance.warehouse_location_id,p_to_location_id,v_balance.uom,p_quantity,p_adjustment_direction,nullif(trim(p_notes),'')
  ) returning id into v_id;
  return v_id;
end $$;

create or replace function public.remove_inventory_operation_line(p_line_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_document record;
begin
  select document.* into v_document from public.inventory_operation_lines line
  join public.inventory_operation_documents document on document.id=line.document_id
  where line.id=p_line_id for update of document;
  if not found then raise exception 'Строка документа не найдена'; end if;
  perform private.require_inventory_operation_permission(v_document.operation_type);
  if v_document.status<>'draft' then raise exception 'Строки можно удалять только из черновика'; end if;
  delete from public.inventory_operation_lines where id=p_line_id;
end $$;

create or replace function public.post_inventory_operation_document(p_document_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare
  v_document record;
  v_line record;
  v_group_id uuid;
  v_movement_id uuid;
  v_available numeric;
begin
  select * into v_document from public.inventory_operation_documents where id=p_document_id for update;
  if not found then raise exception 'Складской документ не найден'; end if;
  perform private.require_inventory_operation_permission(v_document.operation_type);
  if v_document.status<>'draft' then raise exception 'Провести можно только черновик'; end if;
  if not exists(select 1 from public.inventory_operation_lines where document_id=p_document_id) then raise exception 'Добавьте хотя бы одну строку'; end if;

  for v_line in select * from public.inventory_operation_lines where document_id=p_document_id order by created_at,id loop
    if v_document.operation_type='transfer' then
      v_group_id:=public.transfer_inventory_batch(
        v_line.source_balance_id,v_document.to_warehouse_id,v_line.to_location_id,v_line.quantity,
        coalesce(v_document.reference,v_document.document_number),v_document.reason,v_document.performed_by_name
      );
      update public.inventory_movements set inventory_operation_document_id=p_document_id,inventory_operation_line_id=v_line.id
      where transfer_group_id=v_group_id;
    elsif v_document.operation_type='write_off' then
      v_movement_id:=public.write_off_inventory(
        v_line.source_balance_id,v_line.quantity,coalesce(v_document.reason,'Списание'),
        coalesce(v_document.reference,v_document.document_number),v_document.performed_by_name
      );
      update public.inventory_movements set inventory_operation_document_id=p_document_id,inventory_operation_line_id=v_line.id
      where id=v_movement_id;
    else
      select quantity_on_hand-quantity_reserved into v_available from public.inventory_balances where id=v_line.source_balance_id for update;
      if not found then raise exception 'Остаток строки не найден'; end if;
      if v_line.adjustment_direction='decrease' then
        if v_line.quantity>v_available then raise exception 'Недостаточный доступный остаток для корректировки'; end if;
        update public.inventory_balances set quantity_on_hand=quantity_on_hand-v_line.quantity,updated_at=now() where id=v_line.source_balance_id;
        insert into public.inventory_movements(
          batch_id,movement_type,quantity,uom,from_warehouse_id,from_location_id,reference,reason,performed_by_name,
          inventory_operation_document_id,inventory_operation_line_id
        ) values(
          v_line.batch_id,'adjustment',v_line.quantity,v_line.uom,v_document.from_warehouse_id,v_line.from_location_id,
          coalesce(v_document.reference,v_document.document_number),coalesce(v_document.reason,'Корректировка остатка'),v_document.performed_by_name,
          p_document_id,v_line.id
        );
      else
        update public.inventory_balances set quantity_on_hand=quantity_on_hand+v_line.quantity,updated_at=now() where id=v_line.source_balance_id;
        insert into public.inventory_movements(
          batch_id,movement_type,quantity,uom,to_warehouse_id,to_location_id,reference,reason,performed_by_name,
          inventory_operation_document_id,inventory_operation_line_id
        ) values(
          v_line.batch_id,'adjustment',v_line.quantity,v_line.uom,v_document.from_warehouse_id,v_line.from_location_id,
          coalesce(v_document.reference,v_document.document_number),coalesce(v_document.reason,'Корректировка остатка'),v_document.performed_by_name,
          p_document_id,v_line.id
        );
      end if;
    end if;
  end loop;
  update public.inventory_operation_documents set status='posted',posted_by=auth.uid(),posted_at=now(),updated_at=now()
  where id=p_document_id;
end $$;

create or replace function public.cancel_inventory_operation_document(p_document_id uuid,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare
  v_document record;
  v_line record;
  v_destination_id uuid;
  v_destination_available numeric;
  v_group_id uuid;
begin
  if nullif(trim(p_reason),'') is null then raise exception 'Укажите причину отмены'; end if;
  select * into v_document from public.inventory_operation_documents where id=p_document_id for update;
  if not found then raise exception 'Складской документ не найден'; end if;
  perform private.require_inventory_operation_permission(v_document.operation_type);
  if v_document.status='cancelled' then raise exception 'Документ уже отменён'; end if;
  if v_document.status='posted' then
    for v_line in select * from public.inventory_operation_lines where document_id=p_document_id order by created_at desc,id desc loop
      if v_document.operation_type='transfer' then
        select id,quantity_on_hand-quantity_reserved into v_destination_id,v_destination_available
        from public.inventory_balances where batch_id=v_line.batch_id and warehouse_id=v_document.to_warehouse_id
          and warehouse_location_id is not distinct from v_line.to_location_id and uom=v_line.uom for update;
        if v_destination_id is null or v_destination_available<v_line.quantity then
          raise exception 'Нельзя отменить перемещение: товар на складе назначения уже использован';
        end if;
        update public.inventory_balances set quantity_on_hand=quantity_on_hand-v_line.quantity,updated_at=now() where id=v_destination_id;
        update public.inventory_balances set quantity_on_hand=quantity_on_hand+v_line.quantity,updated_at=now() where id=v_line.source_balance_id;
        v_group_id:=gen_random_uuid();
        insert into public.inventory_movements(
          batch_id,movement_type,quantity,uom,from_warehouse_id,from_location_id,to_warehouse_id,to_location_id,
          reference,reason,transfer_group_id,performed_by_name,inventory_operation_document_id,inventory_operation_line_id,is_reversal
        ) values(
          v_line.batch_id,'transfer',v_line.quantity,v_line.uom,v_document.to_warehouse_id,v_line.to_location_id,
          v_document.from_warehouse_id,v_line.from_location_id,'Сторно '||v_document.document_number,trim(p_reason),v_group_id,
          v_document.performed_by_name,p_document_id,v_line.id,true
        );
      elsif v_document.operation_type='write_off' or (v_document.operation_type='adjustment' and v_line.adjustment_direction='decrease') then
        update public.inventory_balances set quantity_on_hand=quantity_on_hand+v_line.quantity,updated_at=now() where id=v_line.source_balance_id;
        insert into public.inventory_movements(
          batch_id,movement_type,quantity,uom,to_warehouse_id,to_location_id,reference,reason,performed_by_name,
          inventory_operation_document_id,inventory_operation_line_id,is_reversal
        ) values(
          v_line.batch_id,'adjustment',v_line.quantity,v_line.uom,v_document.from_warehouse_id,v_line.from_location_id,
          'Сторно '||v_document.document_number,trim(p_reason),v_document.performed_by_name,p_document_id,v_line.id,true
        );
        update public.inventory_batches set status='available',updated_at=now() where id=v_line.batch_id and status='depleted';
      else
        select quantity_on_hand-quantity_reserved into v_destination_available from public.inventory_balances where id=v_line.source_balance_id for update;
        if v_destination_available<v_line.quantity then raise exception 'Нельзя отменить корректировку: добавленный остаток уже использован'; end if;
        update public.inventory_balances set quantity_on_hand=quantity_on_hand-v_line.quantity,updated_at=now() where id=v_line.source_balance_id;
        insert into public.inventory_movements(
          batch_id,movement_type,quantity,uom,from_warehouse_id,from_location_id,reference,reason,performed_by_name,
          inventory_operation_document_id,inventory_operation_line_id,is_reversal
        ) values(
          v_line.batch_id,'adjustment',v_line.quantity,v_line.uom,v_document.from_warehouse_id,v_line.from_location_id,
          'Сторно '||v_document.document_number,trim(p_reason),v_document.performed_by_name,p_document_id,v_line.id,true
        );
      end if;
    end loop;
  end if;
  update public.inventory_operation_documents set status='cancelled',cancelled_by=auth.uid(),cancelled_at=now(),
    cancellation_reason=trim(p_reason),updated_at=now() where id=p_document_id;
end $$;

revoke all on function public.create_inventory_operation_document(text,date,uuid,uuid,text,text,text) from public;
revoke all on function public.add_inventory_operation_line(uuid,uuid,uuid,numeric,text,text) from public;
revoke all on function public.remove_inventory_operation_line(uuid) from public;
revoke all on function public.post_inventory_operation_document(uuid) from public;
revoke all on function public.cancel_inventory_operation_document(uuid,text) from public;
grant execute on function public.create_inventory_operation_document(text,date,uuid,uuid,text,text,text) to authenticated;
grant execute on function public.add_inventory_operation_line(uuid,uuid,uuid,numeric,text,text) to authenticated;
grant execute on function public.remove_inventory_operation_line(uuid) to authenticated;
grant execute on function public.post_inventory_operation_document(uuid) to authenticated;
grant execute on function public.cancel_inventory_operation_document(uuid,text) to authenticated;

do $$ declare t text; begin
  foreach t in array array['inventory_operation_documents','inventory_operation_lines'] loop
    execute format('drop trigger if exists audit_%I_changes on public.%I',t,t);
    execute format('create trigger audit_%I_changes after insert or update or delete on public.%I for each row execute function private.write_access_audit()',t,t);
  end loop;
end $$;

comment on table public.inventory_operation_documents is 'Warehouse operation documents with controlled draft, posting and reversal lifecycle';
comment on table public.inventory_operation_lines is 'Batch lines of warehouse operation documents; immutable after posting';
comment on function public.post_inventory_operation_document(uuid) is 'Atomically posts all lines and writes the immutable inventory ledger';
comment on function public.cancel_inventory_operation_document(uuid,text) is 'Atomically reverses a posted warehouse operation when stock still permits it';
