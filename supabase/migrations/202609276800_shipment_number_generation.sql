-- Allocate after the greatest existing number, including imported historical rows.
-- Keep the RPC's permissions, validation, transaction and per-year lock unchanged.
-- CREATE OR REPLACE replaces function settings. Keep the Kazakhstan business date
-- explicit even when this older migration is reapplied after 202609278300.
begin;
create or replace function public.create_shipment_with_stages(
  p_project_code text,p_type text,p_supplier_id uuid,p_customer_id uuid,p_route_id uuid,
  p_currency_id uuid,p_warehouse_id uuid,p_responsible_user_id uuid,p_planned_ready_date date default null,p_planned_arrival_date date default null
) returns uuid language plpgsql security definer set search_path='' set timezone='Asia/Almaty' as $$
declare v_template uuid; v_shipment uuid; v_number text; v_year text; v_serial text;
begin
  if not private.can_write_shipments('create') then raise exception 'Недостаточно прав для создания поставки'; end if;
  if p_type not in ('import','export','domestic_transfer') then raise exception 'Некорректный тип поставки'; end if;
  if not private.is_active_employee(p_responsible_user_id) then raise exception 'Ответственный сотрудник не найден или неактивен'; end if;
  v_year := to_char(current_date,'YYYY');
  perform pg_advisory_xact_lock(hashtext('nexus_shipment_number_' || v_year));
  select id into v_template from public.process_templates where status='active' and is_default and (shipment_type=p_type or shipment_type is null) order by version desc limit 1;
  if v_template is null then raise exception 'Активный шаблон процесса не найден'; end if;
  select (coalesce(max(substring(shipment_number from '^NAR-' || v_year || '-([0-9]+)$')::numeric),0)+1)::text
    into v_serial from public.shipments;
  v_number := 'NAR-' || v_year || '-' || lpad(v_serial,greatest(4,length(v_serial)),'0');
  insert into public.shipments(shipment_number,project_code,type,supplier_id,customer_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,planned_ready_date,planned_arrival_date,created_by)
  values(v_number,nullif(trim(p_project_code),''),p_type,p_supplier_id,p_customer_id,p_route_id,v_template,p_currency_id,p_warehouse_id,p_responsible_user_id,p_planned_ready_date,p_planned_arrival_date,(select auth.uid())) returning id into v_shipment;
  insert into public.shipment_stage_runs(shipment_id,stage_id,is_required,status,responsible_user_id,status_reason)
  select v_shipment,s.id,s.requirement='required',case when s.requirement='conditional' then 'not_applicable' else 'pending' end,p_responsible_user_id,
    case when s.requirement='conditional' then 'Будет активирован при выполнении условия' end
  from public.shipment_stages s where s.process_template_id=v_template and s.is_active;
  update public.shipments set leading_stage_id=(select id from public.shipment_stages where process_template_id=v_template and sequence_order=1) where id=v_shipment;
  return v_shipment;
end $$;
-- CREATE OR REPLACE retains the existing EXECUTE grants; no new RPC or privilege.
notify pgrst, 'reload schema';
commit;
