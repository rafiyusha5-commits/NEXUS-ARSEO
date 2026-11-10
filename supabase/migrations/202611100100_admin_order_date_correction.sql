-- Correct the document date of an existing unreserved draft; never conduct a sale.
begin;
alter table public.sale_shipment_date_changes
  add column if not exists change_kind text not null default 'reschedule'
  check (change_kind in ('reschedule','admin_correction'));

create or replace function private.can_correct_customer_order_date() returns boolean
language sql volatile security definer set search_path='' as $$
 select auth.uid() is not null
  and private.has_permission('sales.view') and private.has_permission('sales.manage')
  and exists(select 1 from public.user_roles u join public.app_roles r on r.id=u.role_id
    where u.user_id=auth.uid() and r.code='administrator' and r.is_enabled
      and (u.expires_at is null or u.expires_at>clock_timestamp()))
$$;
create or replace function public.can_correct_customer_order_date() returns boolean
language sql volatile security definer set search_path='' as $$
 select private.can_correct_customer_order_date()
$$;

create or replace function public.correct_customer_order_date(
 p_sale_id uuid,p_request_id uuid,p_expected_date date,p_date date,p_reason text
) returns uuid language plpgsql security definer set search_path='' as $$
declare s public.sales; h public.sale_shipment_date_changes; reason text:=nullif(btrim(p_reason),'');
begin
 if not private.can_correct_customer_order_date() then
  raise exception 'Корректировку даты выполняет только администратор с правами просмотра и изменения продаж' using errcode='42501';end if;
 if p_request_id is null or p_expected_date is null or not isfinite(p_expected_date) then
  raise exception 'Обновите страницу перед корректировкой даты';end if;
 if p_date is null or not isfinite(p_date) or p_date<date '1900-01-01' or p_date>private.business_today() then
  raise exception 'Укажите дату по документам не позднее сегодняшнего дня';end if;
 if reason is null or length(reason)>1000 then raise exception 'Укажите причину и документ-основание (до 1000 символов)';end if;
 -- Same sale row lock used by reservation, confirmation and fulfillment.
 select * into s from public.sales where id=p_sale_id for update;
 if not found then raise exception 'Заказ не найден';end if;
 if not private.can_correct_customer_order_date() then
  raise exception 'Недостаточно прав для корректировки даты' using errcode='42501';end if;
 select * into h from public.sale_shipment_date_changes where id=p_request_id;
 if found then
  if row(h.sale_id,h.previous_date,h.new_date,h.reason,h.changed_by,h.change_kind)
    is distinct from row(p_sale_id,p_expected_date,p_date,reason,auth.uid(),'admin_correction'::text) then
   raise exception 'Повторный запрос содержит другие данные';end if;
  if s.planned_shipment_date<>p_date then raise exception 'Дата уже изменена повторно. Обновите страницу';end if;
  return s.id;
 end if;
 if s.status<>'draft' or s.historical_shipment_date is not null or s.shipped_at is not null then
  raise exception 'Корректировка доступна только для обычного неотгруженного черновика';end if;
 if exists(select 1 from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
   where i.sale_id=s.id and r.status in ('active','fulfilled'))
   or exists(select 1 from public.inventory_movements m where m.sale_id=s.id) then
  raise exception 'У заказа есть резервы или складские движения. Корректировка даты недоступна';end if;
 if s.planned_shipment_date is distinct from p_expected_date then
  raise exception 'Дата заказа уже изменилась. Обновите страницу';end if;
 if p_date<s.sale_date then raise exception 'Дата отгрузки не может быть раньше даты заказа';end if;
 if p_date=s.planned_shipment_date then raise exception 'Дата отгрузки не изменилась';end if;
 update public.sales set planned_shipment_date=p_date,updated_at=clock_timestamp() where id=s.id;
 insert into public.sale_shipment_date_changes(id,sale_id,previous_date,new_date,reason,changed_by,change_kind)
  values(p_request_id,s.id,s.planned_shipment_date,p_date,reason,auth.uid(),'admin_correction');
 return s.id;
end $$;

revoke all on function private.can_correct_customer_order_date() from public,anon,authenticated,service_role;
revoke all on function public.can_correct_customer_order_date() from public,anon,authenticated,service_role;
revoke all on function public.correct_customer_order_date(uuid,uuid,date,date,text) from public,anon,authenticated,service_role;
grant execute on function public.can_correct_customer_order_date(),public.correct_customer_order_date(uuid,uuid,date,date,text) to authenticated;
commit;
