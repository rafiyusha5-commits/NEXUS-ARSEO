-- Phase 9F: requisites needed by the export workbook can be confirmed from source documents.
--
-- The export CMR / ТТН / packing list show party addresses, KPP, bank details and the signatory.
-- None of them lives in the counterparty directory, so they are taken from reviewed source documents.
-- Only the allow-list of the guarded review RPC (and the length limit for multi-line requisites) grows;
-- permissions, shipment/transport updates and grants are unchanged.

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
  select * into t from public.shipment_transports where shipment_id=s.id and status<>'cancelled' order by sequence_no limit 1 for update;
  if found then
   if v_data?'vehicle_plate' then
    select v.id,v.carrier_id into v_vehicle,v_carrier from public.vehicles v
    where regexp_replace(upper(v.plate_number),'[^A-ZА-Я0-9]','','g')=regexp_replace(upper(v_data->>'vehicle_plate'),'[^A-ZА-Я0-9]','','g') and v.status='active' limit 1;
   end if;
   if v_carrier is null and v_data?'carrier_name' then
    select c.id into v_carrier from public.carriers c join public.counterparties p on p.id=c.counterparty_id
    where lower(btrim(coalesce(p.short_name,p.legal_name)))=lower(btrim(v_data->>'carrier_name')) limit 1;
   end if;
   update public.shipment_transports set
    driver_name=case when v_data?'driver_name' then v_data->>'driver_name' else driver_name end,
    driver_phone=case when v_data?'driver_phone' then v_data->>'driver_phone' else driver_phone end,
    temperature_setpoint=case when v_data?'temperature_setpoint' then v_data->>'temperature_setpoint' else temperature_setpoint end,
    vehicle_id=coalesce(v_vehicle,vehicle_id),carrier_id=coalesce(v_carrier,carrier_id),updated_at=now()
   where id=t.id;
  end if;
 end if;
 update public.shipment_source_extractions set status='confirmed',confirmed_data=v_data,reviewed_by=(select auth.uid()),reviewed_at=now(),updated_at=now() where id=e.id;
 return e.id;
end $$;

revoke all on function public.review_shipment_source_extraction(uuid,jsonb,boolean) from public,anon,service_role;
grant execute on function public.review_shipment_source_extraction(uuid,jsonb,boolean) to authenticated;

comment on function public.review_shipment_source_extraction(uuid,jsonb,boolean) is 'Confirms employee-reviewed source values (including party requisites for export documents) and safely applies matching shipment and first-transport fields';
