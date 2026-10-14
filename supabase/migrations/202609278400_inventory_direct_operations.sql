-- Write-off and transfer only through a warehouse document. Audit 2026-10-13, finding Н13.
--
-- write_off_inventory and transfer_inventory_batch were callable through the API directly: stock changed without a
-- document, its number, a responsible person and a reversal. The interface never calls them; they are the posting
-- steps of post_inventory_operation_document, which runs as their owner and keeps calling them.
--
-- The direct call was the only way to write off a batch in quarantine or blocked (recalled or spoiled goods; the
-- batch keeps its status and reason, 202609277800). A write-off document now accepts such a batch. A transfer
-- still takes only an available batch.
begin;

revoke all on function public.write_off_inventory(uuid,numeric,text,text,text) from public, anon, authenticated, service_role;
revoke all on function public.transfer_inventory_batch(uuid,uuid,uuid,numeric,text,text,text) from public, anon, authenticated, service_role;

create or replace function public.add_inventory_operation_line(
  p_document_id uuid,p_source_balance_id uuid,p_to_location_id uuid,p_quantity numeric,
  p_adjustment_direction text default null,p_notes text default null
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
  if v_document.operation_type='transfer' and v_balance.batch_status<>'available' then raise exception 'Партия недоступна для операции'; end if;
  -- A batch in quarantine or blocked is written off as it is; only a depleted one has nothing to write off.
  if v_document.operation_type='write_off' and v_balance.batch_status not in ('available','quarantine','blocked') then
    raise exception 'Партия недоступна для операции';
  end if;
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
revoke all on function public.add_inventory_operation_line(uuid,uuid,uuid,numeric,text,text) from public, anon, service_role;
grant execute on function public.add_inventory_operation_line(uuid,uuid,uuid,numeric,text,text) to authenticated;

commit;
