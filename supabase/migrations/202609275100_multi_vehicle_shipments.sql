-- Phase 9H: several vehicles in one shipment, each with its own driver, vehicle, trailer and carrier;
-- source documents and OCR proposals belong to one vehicle; cargo is bound to vehicles by the user.
--
-- What already existed: shipment_transports (one row per vehicle), shipment_items.shipment_transport_id and
-- allocate_shipment_item (the user moves quantities between vehicles; nothing is distributed automatically).
-- What this migration adds:
--   * per-vehicle data on shipment_transports (plate, make, trailer plate and make, carrier, driver document);
--   * add / update / remove RPCs (direct writes to the table stay revoked);
--   * shipment_source_extractions.shipment_transport_id: the vehicle a source document or OCR proposal belongs to;
--     it is taken from a document link to a vehicle, or assigned by an employee, never guessed;
--   * the review RPC writes driver, vehicle and carrier fields to that vehicle only.
-- Shipments with one vehicle keep working: documents without an assignment apply to their only vehicle.

alter table public.shipment_transports
 add column if not exists vehicle_plate text,
 add column if not exists vehicle_make text,
 add column if not exists trailer_plate text,
 add column if not exists trailer_make text,
 add column if not exists carrier_name text,
 add column if not exists driver_document text;

alter table public.shipment_transports drop constraint if exists shipment_transports_vehicle_text_check;
alter table public.shipment_transports add constraint shipment_transports_vehicle_text_check check(
 (vehicle_plate is null or length(vehicle_plate) between 1 and 40)
 and (vehicle_make is null or length(vehicle_make) between 1 and 80)
 and (trailer_plate is null or length(trailer_plate) between 1 and 40)
 and (trailer_make is null or length(trailer_make) between 1 and 80)
 and (carrier_name is null or length(carrier_name) between 1 and 200)
 and (driver_document is null or length(driver_document) between 1 and 250)
);

-- Existing single-vehicle shipments: copy what is known from the linked vehicle and carrier so that every
-- reader can use the per-vehicle columns. The inactive-shipment protection is bypassed for this data copy only.
alter table public.shipment_transports disable trigger protect_inactive_shipment_transports;
update public.shipment_transports t set
 vehicle_plate=coalesce(t.vehicle_plate,nullif(btrim(v.plate_number),'')),
 trailer_plate=coalesce(t.trailer_plate,nullif(btrim(coalesce(v.trailer_plate_number,'')),''))
from public.vehicles v where t.vehicle_id=v.id and (t.vehicle_plate is null or t.trailer_plate is null);
update public.shipment_transports t set
 carrier_name=coalesce(t.carrier_name,nullif(btrim(coalesce(p.short_name,p.legal_name)),''))
from public.carriers c join public.counterparties p on p.id=c.counterparty_id where t.carrier_id=c.id and t.carrier_name is null;
alter table public.shipment_transports enable trigger protect_inactive_shipment_transports;

-- The same truck cannot be listed twice in one shipment (cancelled vehicles do not count).
create unique index if not exists shipment_transports_plate_unique
 on public.shipment_transports(shipment_id,upper(regexp_replace(vehicle_plate,'[^A-Za-zА-Яа-яЁё0-9]','','g')))
 where vehicle_plate is not null and status<>'cancelled';

drop trigger if exists audit_shipment_transports_changes on public.shipment_transports;
create trigger audit_shipment_transports_changes after insert or update or delete on public.shipment_transports
for each row execute function private.write_access_audit();

-- A source document / OCR proposal belongs to one vehicle (or to the shipment as a whole).
alter table public.shipment_source_extractions
 add column if not exists shipment_transport_id uuid references public.shipment_transports(id) on delete set null;
create index if not exists shipment_source_extractions_transport_idx on public.shipment_source_extractions(shipment_transport_id) where shipment_transport_id is not null;

create or replace function private.guard_extraction_transport() returns trigger
language plpgsql security definer set search_path=''
as $$
declare v_linked uuid;v_count integer;
begin
 if new.shipment_transport_id is null and tg_op='INSERT' then
  -- The document was uploaded with a link to a vehicle: that explicit choice is carried over. Several links are ambiguous and ignored.
  select count(distinct l.entity_id),min(l.entity_id::text)::uuid into v_count,v_linked
  from public.document_links l join public.shipment_transports t on t.id=l.entity_id
  where l.document_id=new.document_id and l.entity_type='shipment_transport' and l.removed_at is null
    and t.shipment_id=new.shipment_id and t.status<>'cancelled';
  if v_count=1 then new.shipment_transport_id:=v_linked;end if;
 end if;
 if new.shipment_transport_id is not null and not exists(
  select 1 from public.shipment_transports t where t.id=new.shipment_transport_id and t.shipment_id=new.shipment_id
 ) then raise exception 'Автомобиль не относится к этой поставке';end if;
 return new;
end $$;
revoke execute on function private.guard_extraction_transport() from public;
drop trigger if exists guard_extraction_transport on public.shipment_source_extractions;
create trigger guard_extraction_transport before insert or update of shipment_transport_id on public.shipment_source_extractions
for each row execute function private.guard_extraction_transport();

-- Trims a text value; empty becomes null; too long is an error (never silently cut).
create or replace function private.clean_transport_text(p_value text,p_max integer,p_label text) returns text
language plpgsql immutable set search_path=''
as $$
declare v text:=nullif(btrim(coalesce(p_value,'')),'');
begin
 if v is not null and length(v)>p_max then raise exception 'Поле «%» длиннее % символов',p_label,p_max;end if;
 return v;
end $$;
revoke execute on function private.clean_transport_text(text,integer,text) from public;

create or replace function private.normalize_plate(p_value text) returns text
language sql immutable set search_path=''
as $$select upper(regexp_replace(coalesce(p_value,''),'[^A-Za-zА-Яа-яЁё0-9]','','g'))$$;
revoke execute on function private.normalize_plate(text) from public;

-- Links to master data are resolved from what was typed, never the other way round.
create or replace function private.resolve_transport_links(p_plate text,p_carrier_name text,out o_vehicle uuid,out o_carrier uuid)
language plpgsql stable security definer set search_path=''
as $$
begin
 if p_plate is not null then
  select v.id,v.carrier_id into o_vehicle,o_carrier from public.vehicles v
  where private.normalize_plate(v.plate_number)=private.normalize_plate(p_plate) and v.status='active' limit 1;
 end if;
 if o_carrier is null and p_carrier_name is not null then
  select c.id into o_carrier from public.carriers c join public.counterparties p on p.id=c.counterparty_id
  where lower(btrim(coalesce(p.short_name,p.legal_name)))=lower(btrim(p_carrier_name)) limit 1;
 end if;
end $$;
revoke execute on function private.resolve_transport_links(text,text) from public;

-- New name instead of a new signature of add_shipment_transport: an overload would break the function allowlist of
-- the security hardening migration. The first vehicle takes over the transport-scope stages created with the shipment; later ones (and the first
-- vehicle after every vehicle was removed) get their own set.
create or replace function public.create_shipment_transport(
 p_shipment_id uuid,
 p_planned_loading_date date default null,
 p_planned_arrival_date date default null,
 p_temperature_setpoint text default null,
 p_notes text default null,
 p_driver_name text default null,
 p_driver_phone text default null,
 p_driver_document text default null,
 p_vehicle_plate text default null,
 p_vehicle_make text default null,
 p_trailer_plate text default null,
 p_trailer_make text default null,
 p_carrier_name text default null
) returns integer
language plpgsql security definer set search_path=''
as $$
declare
 v_shipment public.shipments%rowtype;v_sequence integer;v_transport uuid;v_first boolean;v_attached integer;
 v_plate text:=private.clean_transport_text(p_vehicle_plate,40,'Госномер автомобиля');
 v_carrier_name text:=private.clean_transport_text(p_carrier_name,200,'Перевозчик');
 v_vehicle uuid;v_carrier uuid;
begin
 if not private.can_write_shipments('update') then raise exception 'Недостаточно прав для добавления перевозки' using errcode='42501';end if;
 select * into v_shipment from public.shipments where id=p_shipment_id for update;
 if not found then raise exception 'Поставка не найдена';end if;
 if v_shipment.is_locked or v_shipment.status in ('on_hold','cancelled','closed') then raise exception 'Поставка в статусе "%" недоступна для изменений',v_shipment.status;end if;
 if p_planned_loading_date is not null and p_planned_arrival_date is not null and p_planned_arrival_date<p_planned_loading_date then raise exception 'Плановое прибытие раньше плановой загрузки';end if;
 if v_plate is not null and exists(select 1 from public.shipment_transports t where t.shipment_id=p_shipment_id and t.status<>'cancelled' and private.normalize_plate(t.vehicle_plate)=private.normalize_plate(v_plate)) then
  raise exception 'Автомобиль с госномером % уже есть в этой поставке',v_plate;
 end if;
 select r.o_vehicle,r.o_carrier into v_vehicle,v_carrier from private.resolve_transport_links(v_plate,v_carrier_name) r;

 select coalesce(max(sequence_no),0)+1 into v_sequence from public.shipment_transports where shipment_id=p_shipment_id;
 v_first:=not exists(select 1 from public.shipment_transports where shipment_id=p_shipment_id and status<>'cancelled');
 insert into public.shipment_transports(
  shipment_id,sequence_no,planned_loading_date,planned_arrival_date,temperature_setpoint,notes,status,
  driver_name,driver_phone,driver_document,vehicle_plate,vehicle_make,trailer_plate,trailer_make,carrier_name,vehicle_id,carrier_id
 ) values(
  p_shipment_id,v_sequence,p_planned_loading_date,p_planned_arrival_date,private.clean_transport_text(p_temperature_setpoint,50,'Температурный режим'),
  private.clean_transport_text(p_notes,500,'Примечание'),'planned',
  private.clean_transport_text(p_driver_name,200,'Водитель'),private.clean_transport_text(p_driver_phone,60,'Телефон водителя'),private.clean_transport_text(p_driver_document,250,'Документ водителя'),
  v_plate,private.clean_transport_text(p_vehicle_make,80,'Марка автомобиля'),private.clean_transport_text(p_trailer_plate,40,'Госномер прицепа'),private.clean_transport_text(p_trailer_make,80,'Марка прицепа'),
  v_carrier_name,v_vehicle,v_carrier
 ) returning id into v_transport;

 v_attached:=0;
 if v_first then
  update public.shipment_stage_runs r set shipment_transport_id=v_transport,updated_at=now()
  from public.shipment_stages s
  where r.shipment_id=p_shipment_id and r.shipment_transport_id is null and s.id=r.stage_id
    and s.process_template_id=v_shipment.process_template_id and s.scope='transport' and s.is_active;
  get diagnostics v_attached=row_count;
 end if;
 if v_attached=0 then
  insert into public.shipment_stage_runs(shipment_id,stage_id,shipment_transport_id,is_required,status,responsible_user_id,status_reason)
  select p_shipment_id,s.id,v_transport,s.requirement='required',
   case when s.requirement='conditional' then 'not_applicable' else 'pending' end,v_shipment.responsible_user_id,
   case when s.requirement='conditional' then 'Будет активирован при выполнении условия' end
  from public.shipment_stages s
  where s.process_template_id=v_shipment.process_template_id and s.scope='transport' and s.is_active;
 end if;
 return v_sequence;
end $$;

-- The earlier entry point keeps working and shares the implementation (a vehicle without personal data).
create or replace function public.add_shipment_transport(
 p_shipment_id uuid,p_planned_loading_date date default null,p_planned_arrival_date date default null,
 p_temperature_setpoint text default null,p_notes text default null
) returns integer
language sql security definer set search_path=''
as $$select public.create_shipment_transport(p_shipment_id,p_planned_loading_date,p_planned_arrival_date,p_temperature_setpoint,p_notes)$$;

-- Changes the listed fields of one vehicle. Unknown keys are refused; an empty string clears a text field.
create or replace function public.update_shipment_transport(p_transport_id uuid,p_changes jsonb) returns void
language plpgsql security definer set search_path=''
as $$
declare
 t public.shipment_transports%rowtype;s public.shipments%rowtype;v_key text;v_value jsonb;
 v_allowed constant text[]:=array['planned_loading_date','planned_arrival_date','temperature_setpoint','notes','driver_name','driver_phone','driver_document','vehicle_plate','vehicle_make','trailer_plate','trailer_make','carrier_name'];
 v_text text;v_plate text;v_carrier_name text;v_vehicle uuid;v_carrier uuid;v_loading date;v_arrival date;
begin
 if not private.can_write_shipments('update') then raise exception 'Недостаточно прав для изменения перевозки' using errcode='42501';end if;
 if jsonb_typeof(coalesce(p_changes,'{}'::jsonb))<>'object' or p_changes='{}'::jsonb then raise exception 'Укажите, что изменить';end if;
 select * into t from public.shipment_transports where id=p_transport_id for update;
 if not found then raise exception 'Автомобиль не найден';end if;
 select * into s from public.shipments where id=t.shipment_id for update;
 if s.is_locked or s.status in ('on_hold','cancelled','closed') then raise exception 'Поставка в статусе "%" недоступна для изменений',s.status;end if;
 if t.status='cancelled' then raise exception 'Отменённый автомобиль изменять нельзя';end if;
 for v_key,v_value in select key,value from jsonb_each(p_changes) loop
  if not(v_key=any(v_allowed)) then raise exception 'Недопустимое поле автомобиля: %',v_key;end if;
  if jsonb_typeof(v_value) not in('string','null') then raise exception 'Некорректное значение поля %',v_key;end if;
 end loop;
 v_loading:=case when p_changes?'planned_loading_date' then nullif(p_changes->>'planned_loading_date','')::date else t.planned_loading_date end;
 v_arrival:=case when p_changes?'planned_arrival_date' then nullif(p_changes->>'planned_arrival_date','')::date else t.planned_arrival_date end;
 if v_loading is not null and v_arrival is not null and v_arrival<v_loading then raise exception 'Плановое прибытие раньше плановой загрузки';end if;
 v_plate:=case when p_changes?'vehicle_plate' then private.clean_transport_text(p_changes->>'vehicle_plate',40,'Госномер автомобиля') else t.vehicle_plate end;
 v_carrier_name:=case when p_changes?'carrier_name' then private.clean_transport_text(p_changes->>'carrier_name',200,'Перевозчик') else t.carrier_name end;
 if v_plate is not null and exists(select 1 from public.shipment_transports o where o.shipment_id=t.shipment_id and o.id<>t.id and o.status<>'cancelled' and private.normalize_plate(o.vehicle_plate)=private.normalize_plate(v_plate)) then
  raise exception 'Автомобиль с госномером % уже есть в этой поставке',v_plate;
 end if;
 if p_changes?'vehicle_plate' or p_changes?'carrier_name' then
  select r.o_vehicle,r.o_carrier into v_vehicle,v_carrier from private.resolve_transport_links(v_plate,v_carrier_name) r;
 else v_vehicle:=t.vehicle_id;v_carrier:=t.carrier_id;end if;
 update public.shipment_transports set
  planned_loading_date=v_loading,planned_arrival_date=v_arrival,
  temperature_setpoint=case when p_changes?'temperature_setpoint' then private.clean_transport_text(p_changes->>'temperature_setpoint',50,'Температурный режим') else temperature_setpoint end,
  notes=case when p_changes?'notes' then private.clean_transport_text(p_changes->>'notes',500,'Примечание') else notes end,
  driver_name=case when p_changes?'driver_name' then private.clean_transport_text(p_changes->>'driver_name',200,'Водитель') else driver_name end,
  driver_phone=case when p_changes?'driver_phone' then private.clean_transport_text(p_changes->>'driver_phone',60,'Телефон водителя') else driver_phone end,
  driver_document=case when p_changes?'driver_document' then private.clean_transport_text(p_changes->>'driver_document',250,'Документ водителя') else driver_document end,
  vehicle_plate=v_plate,
  vehicle_make=case when p_changes?'vehicle_make' then private.clean_transport_text(p_changes->>'vehicle_make',80,'Марка автомобиля') else vehicle_make end,
  trailer_plate=case when p_changes?'trailer_plate' then private.clean_transport_text(p_changes->>'trailer_plate',40,'Госномер прицепа') else trailer_plate end,
  trailer_make=case when p_changes?'trailer_make' then private.clean_transport_text(p_changes->>'trailer_make',80,'Марка прицепа') else trailer_make end,
  carrier_name=v_carrier_name,vehicle_id=v_vehicle,carrier_id=coalesce(v_carrier,case when p_changes?'carrier_name' or p_changes?'vehicle_plate' then null else carrier_id end),updated_at=now()
 where id=t.id;
end $$;

-- Removes a vehicle that has not started its way. Anything that would lose information blocks it:
-- allocated cargo, a receipt, a started stage, history. Such a vehicle is cancelled instead.
create or replace function public.remove_shipment_transport(p_transport_id uuid) returns void
language plpgsql security definer set search_path=''
as $$
declare t public.shipment_transports%rowtype;s public.shipments%rowtype;v_items integer;
begin
 if not private.can_write_shipments('update') then raise exception 'Недостаточно прав для удаления перевозки' using errcode='42501';end if;
 select * into t from public.shipment_transports where id=p_transport_id for update;
 if not found then raise exception 'Автомобиль не найден';end if;
 select * into s from public.shipments where id=t.shipment_id for update;
 if s.is_locked or s.status in ('on_hold','cancelled','closed') then raise exception 'Поставка в статусе "%" недоступна для изменений',s.status;end if;
 if t.status not in ('planned','cancelled') then raise exception 'Автомобиль уже в работе (статус «%»): отмените его, а не удаляйте',t.status;end if;
 select count(*) into v_items from public.shipment_items where shipment_transport_id=t.id;
 if v_items>0 then raise exception 'К автомобилю привязаны товары (позиций: %): сначала верните их в нераспределённые',v_items;end if;
 if exists(select 1 from public.shipment_transport_receipts where shipment_transport_id=t.id) then raise exception 'По автомобилю есть приёмка: удалить его нельзя';end if;
 if exists(select 1 from public.shipment_stage_runs r where r.shipment_transport_id=t.id and (r.status not in ('pending','not_applicable') or exists(select 1 from public.shipment_stage_history h where h.stage_run_id=r.id))) then
  raise exception 'По автомобилю уже выполнялись этапы: отмените его, а не удаляйте';
 end if;
 -- Documents that belonged to this vehicle stay with the shipment instead of pointing at nothing.
 update public.document_links l set removed_at=now(),removed_by=(select auth.uid())
 where l.entity_type='shipment_transport' and l.entity_id=t.id and l.removed_at is null
   and exists(select 1 from public.document_links o where o.document_id=l.document_id and o.entity_type='shipment' and o.entity_id=t.shipment_id and o.removed_at is null);
 update public.document_links l set entity_type='shipment',entity_id=t.shipment_id
 where l.entity_type='shipment_transport' and l.entity_id=t.id and l.removed_at is null;
 delete from public.shipment_stage_runs where shipment_transport_id=t.id;
 delete from public.shipment_transports where id=t.id;
end $$;

-- Binds a source document / OCR proposal to one vehicle (or back to the whole shipment). A confirmed proposal
-- keeps its vehicle: withdraw the confirmation first.
create or replace function public.assign_source_extraction_transport(p_extraction_id uuid,p_transport_id uuid) returns void
language plpgsql security definer set search_path=''
as $$
declare e public.shipment_source_extractions%rowtype;
begin
 if not (select private.has_permission('source_documents.extract')) then raise exception 'Нет права распознавать исходные документы' using errcode='42501';end if;
 if not (select private.has_permission('shipments.view')) or not (select private.has_permission('documents.view')) then raise exception 'Нет доступа к поставке или документам' using errcode='42501';end if;
 select * into e from public.shipment_source_extractions where id=p_extraction_id for update;
 if not found then raise exception 'Результат распознавания не найден';end if;
 if e.status in ('confirmed','superseded') then raise exception 'Подтверждённый или устаревший документ нельзя перепривязать: сначала отмените подтверждение';end if;
 if p_transport_id is not null and not exists(select 1 from public.shipment_transports t where t.id=p_transport_id and t.shipment_id=e.shipment_id and t.status<>'cancelled') then
  raise exception 'Автомобиль не относится к этой поставке или отменён';
 end if;
 update public.shipment_source_extractions set shipment_transport_id=p_transport_id,updated_at=now() where id=e.id;
end $$;

-- Review: driver, vehicle and carrier fields are written to the vehicle the extraction belongs to.
create or replace function public.review_shipment_source_extraction(
 p_extraction_id uuid,p_confirmed_data jsonb,p_apply_to_shipment boolean default true
) returns uuid
language plpgsql security definer set search_path=''
as $$
declare
 e public.shipment_source_extractions%rowtype;s public.shipments%rowtype;t public.shipment_transports%rowtype;
 v_data jsonb:='{}'::jsonb;v_key text;v_value jsonb;v_text text;v_number numeric;v_vehicle uuid;v_carrier uuid;
 v_allowed constant text[]:=array['order_number','invoice_number','contract_number','cmr_number','ttn_number','packing_list_number','waybill_number','esf_number','driver_name','driver_document','driver_phone','vehicle_plate','vehicle_make','trailer_plate','trailer_make','carrier_name','loading_address','unloading_address','seals','temperature_setpoint','pallet_count','gross_weight_kg','net_weight_kg','incoterms','order_date','shipping_date','invoice_date','contract_date',
  'loading_city','loading_country','unloading_country','goods_category','payment_terms','supplier_address','seller_correspondence_address','seller_phone','customer_address','customer_kpp','bank_details','sender_signatory'];
begin
 if not (select private.has_permission('source_documents.review')) then raise exception 'Нет права подтверждать распознанные данные' using errcode='42501';end if;
 if not (select private.has_permission('shipments.view')) or not (select private.has_permission('documents.view')) then raise exception 'Нет доступа к поставке или документам' using errcode='42501';end if;
 select * into e from public.shipment_source_extractions where id=p_extraction_id and status in('extracted','needs_review','confirmed') for update;
 if not found then raise exception 'Результат распознавания не найден или закрыт';end if;
 if jsonb_typeof(coalesce(p_confirmed_data,'{}'::jsonb))<>'object' then raise exception 'Подтверждённые данные должны быть объектом';end if;

 for v_key,v_value in select key,value from jsonb_each(coalesce(p_confirmed_data,e.extracted_data)) loop
  if v_key='invoice_items' then continue;end if; -- structured invoice lines are read from the confirmed extraction itself
  if not(v_key=any(v_allowed)) then raise exception 'Недопустимое поле распознавания: %',v_key;end if;
  if jsonb_typeof(v_value) not in('string','number') then raise exception 'Некорректное значение поля %',v_key;end if;
  v_text:=btrim(v_value#>>'{}');
  if v_text='' then continue;end if;
  if length(v_text)>(case when v_key in('loading_address','unloading_address','supplier_address','seller_correspondence_address','customer_address','bank_details') then 500 else 200 end) then raise exception 'Значение поля % слишком длинное',v_key;end if;
  if v_key in('pallet_count','gross_weight_kg','net_weight_kg') then
   begin v_number:=replace(replace(v_text,' ',''),',','.')::numeric;exception when others then raise exception 'Поле % должно быть числом',v_key;end;
   if v_number<0 then raise exception 'Поле % не может быть отрицательным',v_key;end if;
   v_data:=v_data||jsonb_build_object(v_key,v_number);
  elsif v_key in('order_date','shipping_date','invoice_date','contract_date') then
   if v_text!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'Поле % должно быть датой ГГГГ-ММ-ДД',v_key;end if;
   perform v_text::date;v_data:=v_data||jsonb_build_object(v_key,v_text);
  else v_data:=v_data||jsonb_build_object(v_key,v_text);end if;
 end loop;
 if v_data='{}'::jsonb then raise exception 'Укажите хотя бы одно подтверждённое поле';end if;

 select * into s from public.shipments where id=e.shipment_id for update;
 if not found then raise exception 'Поставка не найдена';end if;
 if p_apply_to_shipment then
  if not private.can_write_shipments('update') then raise exception 'Недостаточно прав для заполнения поставки' using errcode='42501';end if;
  if s.is_locked or s.status in('closed','cancelled') then raise exception 'Закрытую или заблокированную поставку нельзя изменить';end if;
  if v_data?'incoterms' then update public.shipments set incoterms=v_data->>'incoterms',updated_at=now() where id=s.id;end if;
  -- The vehicle this document belongs to: the one assigned to the extraction. A shipment with a single active
  -- vehicle needs no assignment. With several vehicles and no assignment nothing can be written safely, so the
  -- employee is asked to choose one instead of the data silently landing on the wrong vehicle.
  if e.shipment_transport_id is not null then
   select * into t from public.shipment_transports where id=e.shipment_transport_id and shipment_id=s.id and status<>'cancelled' for update;
  elsif (select count(*) from public.shipment_transports where shipment_id=s.id and status<>'cancelled')=1 then
   select * into t from public.shipment_transports where shipment_id=s.id and status<>'cancelled' for update;
  elsif (v_data ?| array['driver_name','driver_phone','driver_document','vehicle_plate','vehicle_make','trailer_plate','trailer_make','carrier_name','temperature_setpoint'])
    and exists(select 1 from public.shipment_transports where shipment_id=s.id and status<>'cancelled') then
   raise exception 'В поставке несколько автомобилей: укажите, к какому из них относится документ';
  end if;
  if t.id is not null then
   if v_data?'vehicle_plate' and exists(select 1 from public.shipment_transports o where o.shipment_id=s.id and o.id<>t.id and o.status<>'cancelled' and private.normalize_plate(o.vehicle_plate)=private.normalize_plate(v_data->>'vehicle_plate')) then
    raise exception 'Госномер % уже указан у другого автомобиля поставки',v_data->>'vehicle_plate';
   end if;
   if v_data?'vehicle_plate' or v_data?'carrier_name' then
    select r.o_vehicle,r.o_carrier into v_vehicle,v_carrier from private.resolve_transport_links(v_data->>'vehicle_plate',v_data->>'carrier_name') r;
   end if;
   update public.shipment_transports set
    driver_name=case when v_data?'driver_name' then private.clean_transport_text(v_data->>'driver_name',200,'Водитель') else driver_name end,
    driver_phone=case when v_data?'driver_phone' then private.clean_transport_text(v_data->>'driver_phone',60,'Телефон водителя') else driver_phone end,
    driver_document=case when v_data?'driver_document' then private.clean_transport_text(v_data->>'driver_document',250,'Документ водителя') else driver_document end,
    temperature_setpoint=case when v_data?'temperature_setpoint' then private.clean_transport_text(v_data->>'temperature_setpoint',50,'Температурный режим') else temperature_setpoint end,
    vehicle_plate=case when v_data?'vehicle_plate' then private.clean_transport_text(v_data->>'vehicle_plate',40,'Госномер автомобиля') else vehicle_plate end,
    vehicle_make=case when v_data?'vehicle_make' then private.clean_transport_text(v_data->>'vehicle_make',80,'Марка автомобиля') else vehicle_make end,
    trailer_plate=case when v_data?'trailer_plate' then private.clean_transport_text(v_data->>'trailer_plate',40,'Госномер прицепа') else trailer_plate end,
    trailer_make=case when v_data?'trailer_make' then private.clean_transport_text(v_data->>'trailer_make',80,'Марка прицепа') else trailer_make end,
    carrier_name=case when v_data?'carrier_name' then private.clean_transport_text(v_data->>'carrier_name',200,'Перевозчик') else carrier_name end,
    vehicle_id=coalesce(v_vehicle,vehicle_id),carrier_id=coalesce(v_carrier,carrier_id),updated_at=now()
   where id=t.id;
  end if;
 end if;
 update public.shipment_source_extractions set status='confirmed',confirmed_data=v_data,reviewed_by=(select auth.uid()),reviewed_at=now(),updated_at=now() where id=e.id;
 return e.id;
end $$;

revoke all on function public.create_shipment_transport(uuid,date,date,text,text,text,text,text,text,text,text,text,text) from public,anon,service_role;
grant execute on function public.create_shipment_transport(uuid,date,date,text,text,text,text,text,text,text,text,text,text) to authenticated;
revoke all on function public.add_shipment_transport(uuid,date,date,text,text) from public,anon,service_role;
grant execute on function public.add_shipment_transport(uuid,date,date,text,text) to authenticated;
revoke all on function public.update_shipment_transport(uuid,jsonb) from public,anon,service_role;
grant execute on function public.update_shipment_transport(uuid,jsonb) to authenticated;
revoke all on function public.remove_shipment_transport(uuid) from public,anon,service_role;
grant execute on function public.remove_shipment_transport(uuid) to authenticated;
revoke all on function public.assign_source_extraction_transport(uuid,uuid) from public,anon,service_role;
grant execute on function public.assign_source_extraction_transport(uuid,uuid) to authenticated;
revoke all on function public.review_shipment_source_extraction(uuid,jsonb,boolean) from public,anon,service_role;
grant execute on function public.review_shipment_source_extraction(uuid,jsonb,boolean) to authenticated;

comment on function public.create_shipment_transport(uuid,date,date,text,text,text,text,text,text,text,text,text,text) is 'Adds a vehicle with its own driver, plate, make, trailer and carrier together with its stage runs, in one transaction';
comment on function public.update_shipment_transport(uuid,jsonb) is 'Edits one vehicle of an active shipment; unknown fields are refused';
comment on function public.remove_shipment_transport(uuid) is 'Removes a vehicle that has not started; blocks when cargo, receipts or stage history would be lost';
comment on function public.assign_source_extraction_transport(uuid,uuid) is 'Binds an unconfirmed source document or OCR proposal to one vehicle of the shipment';
comment on function public.review_shipment_source_extraction(uuid,jsonb,boolean) is 'Confirms employee-reviewed source values and writes driver, vehicle and carrier fields to the vehicle the document belongs to';
