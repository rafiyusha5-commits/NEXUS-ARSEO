-- Historical sales retain the original dispatch date, without changing the clock or bypassing stock/OSG rules.
begin;
alter table public.sales
 add column if not exists historical_shipment_date date,
 add column if not exists historical_reference text,
 add column if not exists historical_reason text,
 add column if not exists historical_request_id uuid,
 add column if not exists shipped_recorded_at timestamptz;
create unique index if not exists sales_historical_request_unique on public.sales(historical_request_id) where historical_request_id is not null;
create unique index if not exists sales_historical_source_unique on public.sales(customer_id,lower(btrim(historical_reference))) where historical_shipment_date is not null and status<>'cancelled';

create or replace function private.can_record_historical_sale() returns boolean
language sql volatile security definer set search_path='' as $$
 select auth.uid() is not null and private.has_permission('sales.view') and private.has_permission('sales.manage')
  and private.has_permission('sales.reserve') and private.has_permission('inventory.view') and private.has_permission('inventory.move')
  and exists(select 1 from public.user_roles u join public.app_roles r on r.id=u.role_id
    where u.user_id=auth.uid() and r.code='administrator' and r.is_enabled
      and (u.expires_at is null or u.expires_at>clock_timestamp()))
$$;
create or replace function public.can_record_historical_sale() returns boolean
language sql volatile security definer set search_path='' as $$select private.can_record_historical_sale()$$;

-- A stored date, never a caller-controlled setting. Ordinary orders keep the current-date check.
create or replace function private.sale_effective_date(p_sale_id uuid) returns date
language sql volatile security definer set search_path='' as $$
 select coalesce(historical_shipment_date,greatest(planned_shipment_date,private.business_today())) from public.sales where id=p_sale_id
$$;

create or replace function private.guard_historical_sale() returns trigger
language plpgsql security definer set search_path='' as $$
declare sid uuid; hd date; b uuid;
begin
 if tg_table_name='sales' then
  if tg_op='DELETE' then sid:=old.id;hd:=old.historical_shipment_date;
  else sid:=new.id;hd:=new.historical_shipment_date;end if;
  if tg_op='UPDATE' and old.historical_shipment_date is not null and
   row(new.historical_shipment_date,new.historical_reference,new.historical_reason,new.historical_request_id,new.customer_id,new.warehouse_id,new.currency_id,new.contract_id)
   is distinct from row(old.historical_shipment_date,old.historical_reference,old.historical_reason,old.historical_request_id,old.customer_id,old.warehouse_id,old.currency_id,old.contract_id) then
    raise exception 'Основание исторической продажи неизменно: отмените черновик и создайте правильный';
  end if;
  if hd is not null and tg_op<>'DELETE' then
   if not isfinite(hd) or hd>=private.business_today() or hd<date '1900-01-01'
    or new.sale_date<>hd or new.planned_shipment_date<>hd or new.historical_request_id is null
    or coalesce(length(btrim(new.historical_reference)),0) not between 1 and 200
    or coalesce(length(btrim(new.historical_reason)),0) not between 1 and 500 then
     raise exception 'Укажите прошедшую дату, документ-основание и причину исторической продажи';end if;
   if new.shipped_at is not null and private.business_date(new.shipped_at)<>hd then raise exception 'Дата отгрузки должна совпадать с исторической датой';end if;
  end if;
 elsif tg_table_name='sale_items' then
  sid:=case when tg_op='DELETE' then old.sale_id else new.sale_id end;
  select historical_shipment_date into hd from public.sales where id=sid;
 elsif tg_table_name='inventory_reservations' then
  select s.id,s.historical_shipment_date into sid,hd from public.sales s join public.sale_items i on i.sale_id=s.id
   where i.id=case when tg_op='DELETE' then old.sale_item_id else new.sale_item_id end;
  if tg_op<>'DELETE' and new.status in ('active','fulfilled') then b:=new.batch_id;end if;
 elsif tg_table_name='inventory_movements' then
  sid:=case when tg_op='DELETE' then old.sale_id else new.sale_id end;
  select historical_shipment_date into hd from public.sales where id=sid;
  if tg_op='INSERT' and new.movement_type='issue' then b:=new.batch_id;else return coalesce(new,old);end if;
 end if;
 if hd is not null then
  if not private.can_record_historical_sale() then raise exception 'Исторические продажи проводит только администратор с правами продаж и склада' using errcode='42501';end if;
  if b is not null and exists(select 1 from public.inventory_batches where id=b and (private.business_date(received_at)>hd or manufacture_date>hd)) then
   raise exception 'Партия получена или произведена позже исторической отгрузки';end if;
 end if;
 return coalesce(new,old);
end $$;
do $$declare t text;begin
 foreach t in array array['sales','sale_items','inventory_reservations','inventory_movements'] loop
  execute format('drop trigger if exists guard_historical_sale on public.%I',t);
  execute format('create trigger guard_historical_sale before insert or update or delete on public.%I for each row execute function private.guard_historical_sale()',t);
 end loop;
end $$;

create or replace function public.create_historical_customer_order(
 p_request_id uuid,p_customer_id uuid,p_contract_id uuid,p_warehouse_id uuid,p_shipment_date date,
 p_currency_id uuid,p_reference text,p_reason text,p_notes text default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare s public.sales; result uuid; ref text:=nullif(btrim(p_reference),''); reason text:=nullif(btrim(p_reason),'');
begin
 if not private.can_record_historical_sale() then raise exception 'Исторические продажи проводит только администратор с правами продаж и склада' using errcode='42501';end if;
 if p_request_id is null or p_shipment_date is null or not isfinite(p_shipment_date) or p_shipment_date>=private.business_today() or p_shipment_date<date '1900-01-01' then raise exception 'Укажите прошедшую дату отгрузки';end if;
 if ref is null or length(ref)>200 or reason is null or length(reason)>500 then raise exception 'Укажите документ-основание (до 200 символов) и причину (до 500 символов)';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
 if not private.can_record_historical_sale() then raise exception 'Исторические продажи проводит только администратор' using errcode='42501';end if;
 select * into s from public.sales where historical_request_id=p_request_id for update;
 if found then
  if row(s.customer_id,s.contract_id,s.warehouse_id,s.historical_shipment_date,s.currency_id,s.historical_reference,s.historical_reason,s.notes)
    is distinct from row(p_customer_id,p_contract_id,p_warehouse_id,p_shipment_date,p_currency_id,ref,reason,nullif(btrim(p_notes),'')) then raise exception 'Повторный запрос содержит другие данные';end if;
  return s.id;
 end if;
 if p_currency_id is null or not exists(select 1 from public.currencies where id=p_currency_id and is_active) then raise exception 'Выберите действующую валюту исторической продажи';end if;
 -- Reuse existing customer/warehouse/contract validation and numbering. No stock is changed here.
 result:=public.create_customer_order(p_customer_id,p_contract_id,p_warehouse_id,private.business_today(),p_currency_id,p_notes);
 update public.sales set historical_shipment_date=p_shipment_date,historical_reference=ref,historical_reason=reason,
  historical_request_id=p_request_id,sale_date=p_shipment_date,planned_shipment_date=p_shipment_date where id=result;
 return result;
exception when unique_violation then raise exception 'Историческая продажа по этому документу уже существует';
end $$;

-- Reuse every existing calculation. Fail on an unknown definition instead of quietly leaving an unsafe path.
do $$declare r record; d text; old_text text; new_text text;begin
 for r in select * from (values
  ('private.refresh_sale_shelf_life(uuid)','greatest(s.planned_shipment_date,private.business_today())','private.sale_effective_date(s.id)'),
  ('private.plan_customer_order_item_fefo(uuid,jsonb)','greatest(v_item.planned_shipment_date,private.business_today())','private.sale_effective_date(v_item.sale_id)'),
  ('public.reserve_customer_order_item_override(uuid,uuid,text)','greatest(v_item.planned_shipment_date,private.business_today())','private.sale_effective_date(v_item.sale_id)'),
  ('private.reservation_replacement_snapshot(uuid)','greatest(s.planned_shipment_date,private.business_today())','private.sale_effective_date(s.id)'),
  ('private.reservation_replacement_plan(uuid,jsonb)','greatest(s.planned_shipment_date,private.business_today())','private.sale_effective_date(s.id)'),
  ('private.assistant_confirmation_preview(jsonb)','greatest(s.planned_shipment_date,private.business_today())','private.sale_effective_date(s.id)'),
  ('public.fulfill_customer_order(uuid)','v_today:=private.business_today();','v_today:=coalesce(s.historical_shipment_date,private.business_today());'),
  ('private.customer_order_allocation_blockers(uuid,date,boolean)','v_today:=private.business_today();','v_today:=coalesce(s.historical_shipment_date,private.business_today());')
 ) as x(fn,before_text,after_text) loop
  d:=pg_get_functiondef(r.fn::regprocedure);old_text:=r.before_text;new_text:=r.after_text;
  if position(old_text in d)>0 then execute replace(d,old_text,new_text);
  elsif position(new_text in d)=0 then raise exception 'Unknown historical sales dependency: %',r.fn;end if;
 end loop;
 d:=pg_get_functiondef('public.fulfill_customer_order(uuid)'::regprocedure);
 old_text:='shipped_at=clock_timestamp(),shipped_by=auth.uid()';
 new_text:='shipped_at=coalesce(s.historical_shipment_date::timestamp at time zone ''Asia/Almaty'',clock_timestamp()),shipped_recorded_at=clock_timestamp(),shipped_by=auth.uid()';
 if position(old_text in d)>0 then execute replace(d,old_text,new_text);
 elsif position(new_text in d)=0 then raise exception 'Unknown fulfillment timestamp definition';end if;
 -- Authorization before the idempotent success path, including after a role was removed.
 d:=pg_get_functiondef('public.fulfill_customer_order(uuid)'::regprocedure);
 old_text:='if s.status=''shipped'' and s.shipped_at is not null then return s.id; end if;';
 new_text:='if s.historical_shipment_date is not null and not private.can_record_historical_sale() then raise exception ''Исторические продажи проводит только администратор'' using errcode=''42501'';end if; '||old_text;
 if position(new_text in d)=0 then
  if position(old_text in d)=0 then raise exception 'Unknown fulfillment replay definition';end if;
  execute replace(d,old_text,new_text);
 end if;
 -- FEFO must skip lots that did not exist on the historical date, rather than select one then fail.
 d:=pg_get_functiondef('private.plan_customer_order_item_fefo(uuid,jsonb)'::regprocedure);
 old_text:='and batch.status=''available'' and batch.expiry_date>=private.sale_effective_date(v_item.sale_id)';
 new_text:=old_text||' and (not exists(select 1 from public.sales hs where hs.id=v_item.sale_id and hs.historical_shipment_date is not null) or (private.business_date(batch.received_at)<=private.sale_effective_date(v_item.sale_id) and (batch.manufacture_date is null or batch.manufacture_date<=private.sale_effective_date(v_item.sale_id))))';
 if position(new_text in d)=0 then
  if position(old_text in d)=0 then raise exception 'Unknown FEFO historical availability definition';end if;
  execute replace(d,old_text,new_text);
 end if;
 -- A subsequently corrected lot date must appear in the same blocker list used by assistant previews.
 d:=pg_get_functiondef('private.customer_order_allocation_blockers(uuid,date,boolean)'::regprocedure);
 old_text:='if v_line.batch_status<>''available'' then';
 new_text:='if s.historical_shipment_date is not null and exists(select 1 from public.inventory_batches hb where hb.id=v_line.batch_id and (private.business_date(hb.received_at)>s.historical_shipment_date or hb.manufacture_date>s.historical_shipment_date)) then
 return query select ''batch_after_historical_date''::text,format(''%s, партия %s: получена или произведена позже исторической отгрузки'',v_line.internal_sku,v_line.batch_number),v_line.sale_item_id,v_line.batch_id;continue;end if; '||old_text;
 if position(new_text in d)=0 then
  if position(old_text in d)=0 then raise exception 'Unknown historical blocker definition';end if;
  execute replace(d,old_text,new_text);
 end if;
 -- Assistant previews use the same date and role gate as the manual workflow.
 for r in select unnest(array['private.assistant_order_preview(jsonb)','private.assistant_reserve_preview(jsonb)','private.assistant_confirmation_preview(jsonb)']) fn loop
  d:=pg_get_functiondef(r.fn::regprocedure);
  old_text:='''document_date'',private.business_today()';new_text:='''document_date'',coalesce(s.historical_shipment_date,private.business_today())';
  if position(old_text in d)>0 then d:=replace(d,old_text,new_text);
  elsif position(new_text in d)=0 then raise exception 'Unknown assistant historical date definition: %',r.fn;end if;
  old_text:=case when r.fn='private.assistant_reserve_preview(jsonb)' then 'if not found or not private.can_access_counterparty_record(''view'',s.customer_id) then raise exception ''ASSISTANT_OPERATION_DENIED'';end if;'
   else 'if not found then raise exception ''ASSISTANT_OPERATION_DENIED'';end if;' end;
  new_text:=old_text||' if s.historical_shipment_date is not null and not private.can_record_historical_sale() then raise exception ''Исторические продажи проводит только администратор'' using errcode=''42501'';end if;';
  if position(new_text in d)=0 then
   if position(old_text in d)=0 then raise exception 'Unknown assistant historical access definition: %',r.fn;end if;
   d:=replace(d,old_text,new_text);
  end if;
  execute d;
 end loop;
end $$;

revoke all on function private.can_record_historical_sale(),private.sale_effective_date(uuid),private.guard_historical_sale(),
 public.can_record_historical_sale(),public.create_historical_customer_order(uuid,uuid,uuid,uuid,date,uuid,text,text,text)
 from public,anon,authenticated,service_role;
grant execute on function public.can_record_historical_sale(),public.create_historical_customer_order(uuid,uuid,uuid,uuid,date,uuid,text,text,text) to authenticated;
commit;
