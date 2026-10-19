-- Validate structured evidence at the database boundary, including legacy confirmation paths.
create or replace function private.validate_customs_evidence(p jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare item jsonb; field jsonb; k text; n numeric; seen numeric[]:='{}'; total int;
begin
 if jsonb_typeof(p) is distinct from 'object' or p->>'kind' is distinct from 'declaration'
 or jsonb_typeof(p->'fields') is distinct from 'array' or jsonb_typeof(p->'items') is distinct from 'array' then
  raise exception 'Нет реквизитов и товарных строк декларации';
 end if;
 total:=jsonb_array_length(p->'items');
 if total not between 1 and 2000 or jsonb_typeof(p->'expectedCount') is distinct from 'number'
 or (p->>'expectedCount')::numeric<>total or jsonb_array_length(p->'fields')=0 then
  raise exception 'Не все товарные строки декларации прочитаны';
 end if;
 for field in select value from jsonb_array_elements(p->'fields') loop
  if jsonb_typeof(field) is distinct from 'object'
  or jsonb_typeof(field->'label') is distinct from 'string' or nullif(btrim(field->>'label'),'') is null
  or jsonb_typeof(field->'value') is distinct from 'string' or nullif(btrim(field->>'value'),'') is null then
   raise exception 'Некорректный реквизит декларации';
  end if;
 end loop;
 if p ? 'warnings' then
  if jsonb_typeof(p->'warnings') is distinct from 'array' then raise exception 'Некорректные предупреждения декларации'; end if;
  if exists(select 1 from jsonb_array_elements(p->'warnings') w where jsonb_typeof(w)<>'string') then raise exception 'Некорректные предупреждения декларации'; end if;
 end if;
 for item in select value from jsonb_array_elements(p->'items') loop
  if jsonb_typeof(item) is distinct from 'object' then raise exception 'Некорректная товарная строка'; end if;
  foreach k in array array['sku','hsCode','unit','description'] loop
   if jsonb_typeof(item->k) is distinct from 'string' or nullif(btrim(item->>k),'') is null then
    raise exception 'В товарной строке не прочитано поле %',k;
   end if;
  end loop;
  if item->>'hsCode' !~ '^[0-9]{10}$' or regexp_replace(lower(btrim(item->>'unit')),'\.$','') not in
   ('шт','штук','штука','штуки','piece','pieces','pcs','pc','sztuka','szt','кг','kg','кор','короб','коробка','box','boxes','carton','cartons') then
   raise exception 'Проверьте десятизначный код ТН ВЭД и единицу товарной строки';
  end if;
  foreach k in array array['number','quantity','amount','grossKg','netKg','customsValue'] loop
   if jsonb_typeof(item->k) is distinct from 'number' then raise exception 'В товарной строке не прочитано число %',k; end if;
   if (item->>k)::numeric<0 then raise exception 'Отрицательное значение %',k; end if;
  end loop;
  n:=(item->>'number')::numeric;
  if n<>trunc(n) or n<1 or n>total or n=any(seen) then raise exception 'Номера товарных строк должны идти от 1 без повторов и пропусков'; end if;
  seen:=array_append(seen,n);
  if item ? 'warnings' then
   if jsonb_typeof(item->'warnings') is distinct from 'array' then raise exception 'Некорректные предупреждения строки'; end if;
   if exists(select 1 from jsonb_array_elements(item->'warnings') w where jsonb_typeof(w)<>'string') then raise exception 'Некорректные предупреждения строки'; end if;
  end if;
 end loop;
end $$;
revoke all on function private.validate_customs_evidence(jsonb) from public,anon,authenticated,service_role;

-- Preserve the original RPC and its locking/permission behavior; validate even an idempotent replay.
do $$ declare definition text; marker text:='-- Idempotent retries keep the original reviewer/time'; begin
 definition:=pg_get_functiondef('public.review_shipment_customs_evidence(uuid,uuid,uuid,jsonb,text)'::regprocedure);
 if position('perform private.validate_customs_evidence(v_record)' in definition)=0 then
  if position(marker in definition)=0 then raise exception 'Customs review changed: validate integration'; end if;
  execute replace(definition,marker,'perform private.validate_customs_evidence(v_record);'||chr(10)||marker);
 end if;
end $$;

create or replace function private.guard_customs_evidence_confirmation() returns trigger
language plpgsql set search_path='' as $$
begin
 if new.status='confirmed' and new.extracted_data#>>'{customs_record,kind}'='declaration' then
  perform private.validate_customs_evidence(new.extracted_data->'customs_record');
  if new.confirmed_data->'customs_record' is distinct from new.extracted_data->'customs_record'
  or coalesce(length(btrim(new.confirmed_data->>'customs_review_note')),0) not between 10 and 2000 then
   raise exception 'Подтвердите декларацию через сверку реквизитов и товарных строк';
  end if;
 end if;
 return new;
end $$;
revoke all on function private.guard_customs_evidence_confirmation() from public,anon,authenticated,service_role;
