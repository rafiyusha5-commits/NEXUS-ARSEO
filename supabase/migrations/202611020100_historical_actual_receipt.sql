-- Record an actual historical customer receipt. This is not a guarantee or prior agreement.
begin;
create table if not exists public.historical_sale_receipts (
 id uuid primary key default gen_random_uuid(),
 request_id uuid not null unique,
 sale_id uuid not null references public.sales(id) on delete restrict,
 reason text not null check(length(btrim(reason)) between 10 and 2000),
 snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),
 created_by uuid not null default auth.uid() references public.profiles(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp()
);
create index if not exists historical_sale_receipts_sale_idx on public.historical_sale_receipts(sale_id);
create index if not exists historical_sale_receipts_actor_idx on public.historical_sale_receipts(created_by);
alter table public.historical_sale_receipts enable row level security;
revoke all on public.historical_sale_receipts from public,anon,authenticated,service_role;
grant select on public.historical_sale_receipts to authenticated;
drop policy if exists historical_receipts_read on public.historical_sale_receipts;
create policy historical_receipts_read on public.historical_sale_receipts for select to authenticated using (
 (select private.has_permission('sales.view')) and exists(select 1 from public.sales s where s.id=sale_id
 and private.can_access_counterparty_record('view',s.customer_id))
);

create or replace function private.historical_receipt_snapshot(p_sale_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('sale_id',s.id,'customer_id',s.customer_id,'warehouse_id',s.warehouse_id,
 'shipment_date',s.historical_shipment_date,'reference',s.historical_reference,
 'items',coalesce((select jsonb_agg(jsonb_build_object('item_id',i.id,'product_id',i.product_id,
   'sku',p.internal_sku,'quantity',i.quantity,'uom',i.uom,'required_pct',i.required_shelf_life_pct,
   'reservations',coalesce((select jsonb_agg(jsonb_build_object('reservation_id',r.id,'balance_id',r.inventory_balance_id,
     'batch_id',b.id,'batch',b.batch_number,'quantity',r.quantity,'uom',r.uom,'sale_quantity',r.sale_quantity,
     'manufacture_date',b.manufacture_date,'expiry',b.expiry_date,'received_date',private.business_date(b.received_at),
     'shelf_days',p.shelf_life_days,'actual_pct',private.sale_shelf_life_pct(b.expiry_date,b.manufacture_date,p.shelf_life_days,s.historical_shipment_date)) order by r.id)
     from public.inventory_reservations r join public.inventory_batches b on b.id=r.batch_id
     where r.sale_item_id=i.id and r.status in ('active','fulfilled')),'[]'::jsonb)) order by i.id)
   from public.sale_items i join public.products p on p.id=i.product_id where i.sale_id=s.id),'[]'::jsonb))
 from public.sales s where s.id=p_sale_id and s.historical_shipment_date is not null
$$;

create or replace function private.historical_receipt_valid(p_sale_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.historical_sale_receipts h join public.sales s on s.id=h.sale_id
 where s.id=p_sale_id and s.historical_shipment_date is not null and s.status in ('reserved','confirmed','shipped')
 and h.snapshot=private.historical_receipt_snapshot(s.id))
$$;

create or replace function public.historical_sale_receipt_preview(p_sale_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s public.sales; snap jsonb;begin
 if not private.has_permission('sales.view') then raise exception 'Нет права просмотра продаж' using errcode='42501';end if;
 select * into s from public.sales where id=p_sale_id;
 if not found or not private.can_access_counterparty_record('view',s.customer_id) then raise exception 'Продажа недоступна' using errcode='42501';end if;
 if s.historical_shipment_date is null then return null;end if;
 snap:=private.historical_receipt_snapshot(s.id);
 return jsonb_build_object('snapshot',snap,'token',md5(snap::text),'valid',private.historical_receipt_valid(s.id));
end $$;

create or replace function private.guard_historical_receipt() returns trigger
language plpgsql security definer set search_path='' as $$begin
 if tg_op<>'INSERT' then raise exception 'История фактической приёмки неизменна';end if;
 if not private.can_record_historical_sale() or new.created_by is distinct from auth.uid() then
 raise exception 'Факт исторической приёмки вносит только администратор' using errcode='42501';end if;
 return new;
end $$;
drop trigger if exists guard_historical_receipt on public.historical_sale_receipts;
create trigger guard_historical_receipt before insert or update or delete on public.historical_sale_receipts
 for each row execute function private.guard_historical_receipt();
drop trigger if exists audit_historical_receipt on public.historical_sale_receipts;
create trigger audit_historical_receipt after insert on public.historical_sale_receipts
 for each row execute function private.write_access_audit();

create or replace function public.record_historical_sale_receipt(p_sale_id uuid,p_request_id uuid,p_expected_token text,p_reason text,p_acknowledged boolean)
returns uuid language plpgsql security definer set search_path='' as $$
declare s public.sales; old public.historical_sale_receipts; snap jsonb; result uuid; reason text:=btrim(p_reason);begin
 if not private.can_record_historical_sale() then raise exception 'Факт исторической приёмки вносит только администратор' using errcode='42501';end if;
 if p_request_id is null or p_acknowledged is distinct from true or coalesce(length(reason),0) not between 10 and 2000 then
 raise exception 'Подтвердите фактическую приёмку без письма и предварительного согласования и укажите основание';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,20261102));
 select * into s from public.sales where id=p_sale_id for update;
 if not found or not private.can_access_counterparty_record('view',s.customer_id) then raise exception 'Продажа недоступна' using errcode='42501';end if;
 if s.historical_shipment_date is null or s.historical_shipment_date>=private.business_today() then raise exception 'Основание разрешено только для исторической продажи';end if;
 select * into old from public.historical_sale_receipts where request_id=p_request_id;
 if found then
  if old.sale_id<>s.id or old.reason<>reason or md5(old.snapshot::text) is distinct from p_expected_token then raise exception 'Повтор содержит другие данные';end if;
  return old.id;
 end if;
 if s.status<>'reserved' then raise exception 'Сначала полностью зарезервируйте историческую продажу';end if;
 perform 1 from public.sale_items where sale_id=s.id order by id for update;
 perform 1 from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id where i.sale_id=s.id order by r.id for update of r;
 perform 1 from public.inventory_batches b where b.id in (select r.batch_id from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id where i.sale_id=s.id) order by id for share;
 perform 1 from public.products p where p.id in(select product_id from public.sale_items where sale_id=s.id) order by id for share;
 if not private.can_record_historical_sale() then raise exception 'Требуется администратор' using errcode='42501';end if;
 perform private.refresh_sale_shelf_life(s.id);
 if not exists(select 1 from public.sale_items where sale_id=s.id) or exists(select 1 from public.sale_items i where i.sale_id=s.id
  and i.quantity<>(select coalesce(sum(r.sale_quantity),0) from public.inventory_reservations r where r.sale_item_id=i.id and r.status='active')) then raise exception 'Требуется полный резерв';end if;
 if exists(select 1 from public.guarantee_letters where sale_id=s.id and status in ('approved','sent','accepted')) then raise exception 'У продажи уже есть гарантийное письмо';end if;
 if not exists(select 1 from public.sale_items i join public.inventory_reservations r on r.sale_item_id=i.id and r.status='active'
 where i.sale_id=s.id and r.remaining_shelf_life_pct<i.required_shelf_life_pct) then raise exception 'Нет отклонений ОСГ для фиксации';end if;
 snap:=private.historical_receipt_snapshot(s.id);
 if p_expected_token is distinct from md5(snap::text) then raise exception 'Партии, количества или сроки изменились: обновите просмотр';end if;
 insert into public.historical_sale_receipts(request_id,sale_id,reason,snapshot) values(p_request_id,s.id,reason,snap) returning id into result;
 return result;
end $$;

-- Only the low-OSG gate accepts the recorded historical fact. Stock, expiry, credit,
-- administrator rights, immutable dates and ordinary-sale rules remain in the existing functions.
do $$declare f text; d text; before_text text; after_text text;begin
 f:='public.confirm_customer_order(uuid)';
 d:=replace(pg_get_functiondef(f::regprocedure),E'\r\n',E'\n');
 before_text:=E'    where not exists(\n      select 1 from public.guarantee_letters';
 after_text:=E'    where not private.historical_receipt_valid(p_sale_id) and not exists(\n      select 1 from public.guarantee_letters';
 if position(after_text in d)=0 then
  if position(before_text in d)=0 then raise exception 'Unknown confirmation definition';end if;
  execute replace(d,before_text,after_text);
 end if;
 foreach f in array array['public.fulfill_customer_order(uuid)','private.customer_order_allocation_blockers(uuid,date,boolean)'] loop
  d:=pg_get_functiondef(f::regprocedure);
  before_text:='if v_line.required_shelf_life_pct is not null and v_pct<v_line.required_shelf_life_pct and not exists(';
  after_text:='if v_line.required_shelf_life_pct is not null and v_pct<v_line.required_shelf_life_pct and not private.historical_receipt_valid(s.id) and not exists(';
  if position(after_text in d)=0 then
   if position(before_text in d)=0 then raise exception 'Unknown historical receipt dependency: %',f;end if;
   execute replace(d,before_text,after_text);
  end if;
 end loop;
 -- Freeze product shelf-life inputs while confirming/fulfilling the exact recorded snapshot.
 foreach f in array array['public.confirm_customer_order(uuid)','public.fulfill_customer_order(uuid)'] loop
  d:=pg_get_functiondef(f::regprocedure);
  before_text:=case when f='public.confirm_customer_order(uuid)' then 'perform private.refresh_sale_shelf_life(p_sale_id);'
   else 'perform 1 from public.guarantee_letters where sale_id=s.id order by id for update;' end;
  after_text:='perform 1 from public.products hp where hp.id in (select product_id from public.sale_items where sale_id=p_sale_id) order by hp.id for share; '||before_text;
  if position(after_text in d)=0 then
   if position(before_text in d)=0 then raise exception 'Unknown receipt input-lock dependency: %',f;end if;
   execute replace(d,before_text,after_text);
  end if;
 end loop;
end $$;

revoke all on function private.historical_receipt_snapshot(uuid),private.historical_receipt_valid(uuid),private.guard_historical_receipt(),
 public.historical_sale_receipt_preview(uuid),public.record_historical_sale_receipt(uuid,uuid,text,text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.historical_sale_receipt_preview(uuid),public.record_historical_sale_receipt(uuid,uuid,text,text,boolean) to authenticated;
commit;
