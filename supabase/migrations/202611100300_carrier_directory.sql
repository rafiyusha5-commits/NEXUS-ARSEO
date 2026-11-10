-- Stage 9A: directories and explicit transport context. No rates, expenses or stock effects.
insert into public.permissions(code,module,action,name,description) values
 ('carriers.directory.read','carriers','directory_read','Справочники перевозки: просмотр','Перевозчики, водители и транспорт без документов водителя'),
 ('carriers.directory.manage','carriers','directory_manage','Справочники перевозки: изменение','Изменения с причиной и историей'),
 ('freight.context.read','freight','context_read','Рейсы: просмотр','Дополнительно нужны права на каждую связанную операцию'),
 ('freight.context.manage','freight','context_manage','Рейсы: изменение','Транспортный контекст, без проведения операций'),
 ('drivers.documents.view','drivers','documents_view','Документы водителей: просмотр','Отдельный доступ к ИИН и реквизитам документа')
on conflict(code) do nothing;

alter table public.carriers
 add column if not exists directory_active boolean not null default true,
 add column if not exists inactive_reason text,
 add column if not exists directions text[] not null default '{}',
 add column if not exists payment_terms text,
 add column if not exists signatory text,
 add column if not exists framework_contract_id uuid references public.documents(id),
 add column if not exists directory_version bigint not null default 1;
create index if not exists carriers_contract_idx on public.carriers(framework_contract_id);
alter table public.vehicles
 add column if not exists registration_country text,
 add column if not exists make text,
 add column if not exists body_type text,
 add column if not exists capacity_kg numeric(12,3),
 add column if not exists pallet_capacity integer,
 add column if not exists directory_version bigint not null default 1;
-- Existing records are not normalized/merged. Country of legacy records remains unknown.
alter table public.vehicles drop constraint if exists vehicles_plate_number_key;
create unique index if not exists vehicles_country_type_identity on public.vehicles
 (registration_country,vehicle_type,upper(regexp_replace(plate_number,'[[:space:]-]','','g')))
 where registration_country is not null;

create table if not exists public.freight_drivers (
 id uuid primary key default gen_random_uuid(), full_name text not null,
 phones text[] not null default '{}', whatsapp text,
 carrier_id uuid references public.carriers(id),active boolean not null default true,inactive_reason text,
 directory_version bigint not null default 1,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create index if not exists freight_driver_carrier_idx on public.freight_drivers(carrier_id);
alter table public.freight_drivers enable row level security;
revoke all on public.freight_drivers from public,anon,authenticated,service_role;

create table if not exists private.freight_driver_documents (
 driver_id uuid primary key references public.freight_drivers(id),iin text,document_requisites text,
 version bigint not null default 1
);
create table if not exists private.freight_directory_history (
 id uuid primary key default gen_random_uuid(),kind text not null,entity_id uuid not null,
 actor_id uuid not null references public.profiles(id),reason text not null,
 before_value jsonb,after_value jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create index if not exists freight_history_actor_idx on private.freight_directory_history(actor_id);
create index if not exists freight_history_entity_idx on private.freight_directory_history(kind,entity_id,created_at desc);
create table if not exists private.freight_directory_requests (
 id uuid primary key,actor_id uuid not null references public.profiles(id),digest text not null,result_id uuid not null,
 created_at timestamptz not null default clock_timestamp()
);
create index if not exists freight_request_actor_idx on private.freight_directory_requests(actor_id);
create table if not exists private.freight_source_bindings (
 source_type text not null,source_id uuid not null,kind text not null,entity_id uuid not null,
 primary key(source_type,source_id,kind)
);
alter table private.freight_source_bindings enable row level security;
revoke all on private.freight_source_bindings from public,anon,authenticated,service_role;
alter table private.freight_driver_documents enable row level security;
alter table private.freight_directory_history enable row level security;
alter table private.freight_directory_requests enable row level security;
revoke all on private.freight_driver_documents,private.freight_directory_history,private.freight_directory_requests from public,anon,authenticated,service_role;

create or replace function private.freight_directory_allowed(p_write boolean default false) returns boolean
language sql stable security definer set search_path='' as $$
 select private.is_employee() and private.has_permission('suppliers.view') and private.has_permission('carriers.directory.read')
 and (not p_write or private.has_permission('carriers.directory.manage'))
$$;
revoke all on function private.freight_directory_allowed(boolean) from public,anon,authenticated,service_role;

-- Existing reference imports use their checked definer; direct API writes must not bypass the new history.
revoke insert,update,delete on public.carriers,public.vehicles from authenticated;

create or replace function private.freight_text(p_value jsonb,p_field text,p_max integer,p_required boolean default false) returns text
language plpgsql immutable set search_path='' as $$
declare v text;
begin
 if p_value ? p_field and jsonb_typeof(p_value->p_field) not in('string','null') then raise exception 'Некорректное поле %',p_field using errcode='22023';end if;
 v:=nullif(btrim(p_value->>p_field),'');
 if (p_required and v is null) or length(v)>p_max then raise exception 'Проверьте поле %',p_field using errcode='22023';end if;
 return v;
end$$;
revoke all on function private.freight_text(jsonb,text,integer,boolean) from public,anon,authenticated,service_role;

create or replace function private.freight_text_array(p_values jsonb,p_max integer) returns text[]
language plpgsql immutable set search_path='' as $$
declare result text[];
begin
 if p_values is null then return '{}'::text[];end if;
 if jsonb_typeof(p_values)<>'array' or jsonb_array_length(p_values)>20 then raise exception 'Некорректный список' using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements(p_values) x where jsonb_typeof(x)<>'string' or length(btrim(x#>>'{}')) not between 1 and p_max) then raise exception 'Некорректный элемент списка' using errcode='22023';end if;
 select coalesce(array_agg(distinct btrim(value)),'{}'::text[]) into result from jsonb_array_elements_text(p_values);
 return result;
end$$;
revoke all on function private.freight_text_array(jsonb,integer) from public,anon,authenticated,service_role;

create or replace function private.guard_freight_history() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'История перевозок неизменяема' using errcode='42501';end$$;
revoke all on function private.guard_freight_history() from public,anon,authenticated,service_role;
drop trigger if exists freight_history_immutable on private.freight_directory_history;
create trigger freight_history_immutable before update or delete on private.freight_directory_history for each row execute function private.guard_freight_history();

-- Names and plates can be ambiguous across countries. A text-only legacy form must never choose arbitrarily.
create or replace function private.resolve_transport_links(p_plate text,p_carrier_name text,out o_vehicle uuid,out o_carrier uuid)
language plpgsql stable security definer set search_path='' as $$
declare count_matches integer;
begin
 if nullif(btrim(p_plate),'') is not null then
  select count(*),min(v.id::text)::uuid into count_matches,o_vehicle from public.vehicles v join public.carriers c on c.id=v.carrier_id
   where private.normalize_plate(v.plate_number)=private.normalize_plate(p_plate) and v.status='active' and c.directory_active;
  if count_matches=1 then select carrier_id into o_carrier from public.vehicles where id=o_vehicle;else o_vehicle:=null;end if;
 end if;
 if o_carrier is null and nullif(btrim(p_carrier_name),'') is not null then
  select count(*),min(c.id::text)::uuid into count_matches,o_carrier from public.carriers c join public.counterparties p on p.id=c.counterparty_id
   where c.directory_active and lower(btrim(coalesce(p.short_name,p.legal_name)))=lower(btrim(p_carrier_name));
  if count_matches<>1 then o_carrier:=null;end if;
 end if;
end$$;
revoke all on function private.resolve_transport_links(text,text) from public,anon,authenticated,service_role;

create or replace function public.save_freight_directory(p_kind text,p_request uuid,p_id uuid,p_version bigint,p_values jsonb,p_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare allowed text[];before_row jsonb;after_row jsonb;entity uuid:=coalesce(p_id,gen_random_uuid());version bigint;
 old_request private.freight_directory_requests%rowtype;digest text;carrier uuid;counterparty uuid;active boolean;number text;country text;kind text;doc uuid;
 source_value jsonb;source_entity uuid;
begin
 if not private.freight_directory_allowed(true) then raise exception 'Недостаточно прав для изменения справочника' using errcode='42501';end if;
 if p_request is null or p_kind is null or p_kind not in('carrier','driver','vehicle','driver_documents') or jsonb_typeof(p_values) is distinct from 'object'
  or p_reason is null or length(btrim(p_reason)) not between 3 and 1000 then raise exception 'Укажите данные и причину изменения' using errcode='22023';end if;
 if p_kind='driver_documents' and not private.has_permission('drivers.documents.view') then raise exception 'Нет доступа к документам водителя' using errcode='42501';end if;
 allowed:=case p_kind when 'carrier' then array['counterparty_id','active','inactive_reason','directions','transport_types','payment_terms','signatory','framework_contract_id']
 when 'driver' then array['full_name','phones','whatsapp','carrier_id','active','inactive_reason']
 when 'vehicle' then array['carrier_id','plate_number','registration_country','vehicle_type','make','body_type','capacity_kg','pallet_capacity','temperature_capability','status']
 else array['iin','document_requisites'] end;
 if exists(select 1 from jsonb_object_keys(p_values) k where not k=any(allowed||array['source'])) then raise exception 'Неизвестное поле справочника' using errcode='22023';end if;
 digest:=encode(sha256(convert_to(jsonb_build_object('kind',p_kind,'id',p_id,'version',p_version,'values',p_values,'reason',btrim(p_reason))::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended('freight-request:'||p_request,0));
 select * into old_request from private.freight_directory_requests where id=p_request;
 if found then
  if old_request.actor_id<>auth.uid() or old_request.digest<>digest then raise exception 'Идентификатор операции уже использован';end if;
  if not private.freight_directory_allowed(true) or (p_kind='driver_documents' and not private.has_permission('drivers.documents.view')) then raise exception 'Недостаточно прав' using errcode='42501';end if;
  return old_request.result_id;
 end if;
 if p_values ? 'source' then
  source_value:=p_values->'source';
  if jsonb_typeof(source_value) is distinct from 'object' or p_kind='driver_documents' then raise exception 'Некорректный источник';end if;
  perform pg_advisory_xact_lock(hashtextextended('freight-source:'||(source_value->>'type')||':'||(source_value->>'id')||':'||p_kind,0));
  if source_value->>'type'='transport' then
   perform 1 from public.shipment_transports where id=(source_value->>'id')::uuid for share;
  elsif source_value->>'type'='extraction' then
   perform 1 from public.documents where id=(select document_id from public.shipment_source_extractions where id=(source_value->>'id')::uuid) for share;
   perform 1 from public.shipment_source_extractions where id=(source_value->>'id')::uuid for share;
   perform 1 from public.document_versions where id=(select document_version_id from public.shipment_source_extractions where id=(source_value->>'id')::uuid) for share;
   perform 1 from public.document_links where document_id=(select document_id from public.shipment_source_extractions where id=(source_value->>'id')::uuid) and removed_at is null order by id for share;
  end if;
  if source_value->>'stamp' is distinct from (public.freight_source_preview(source_value->>'type',(source_value->>'id')::uuid)->>'stamp') then raise exception 'Источник изменился. Повторите предпросмотр';end if;
  select b.entity_id into source_entity from private.freight_source_bindings b where b.source_type=source_value->>'type' and b.source_id=(source_value->>'id')::uuid and b.kind=p_kind;
  if source_entity is not null and source_entity is distinct from p_id then raise exception 'Источник уже перенесён. Откройте существующую запись для изменения';end if;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('freight-directory:'||p_kind||':'||entity,0));
 if p_kind='carrier' then
  perform set_config('nexus.freight_reason',btrim(p_reason),true);
  counterparty:=private.freight_text(p_values,'counterparty_id',36,true)::uuid;
  perform pg_advisory_xact_lock(hashtextextended('freight-counterparty:'||counterparty,0));
  if not exists(select 1 from public.counterparties c where c.id=counterparty and private.can_access_counterparty_record('view',c.id) and 'carrier'=any(c.roles)) then raise exception 'Контрагент перевозчика недоступен' using errcode='42501';end if;
  if p_id is null and exists(select 1 from public.carriers where counterparty_id=counterparty) then raise exception 'Перевозчик уже есть в справочнике';end if;
  select to_jsonb(c),c.directory_version into before_row,version from public.carriers c where id=entity for update;
 elsif p_kind='vehicle' then select to_jsonb(v),v.directory_version into before_row,version from public.vehicles v where id=entity for update;
 elsif p_kind='driver' then select to_jsonb(d),d.directory_version into before_row,version from public.freight_drivers d where id=entity for update;
 else
  if p_id is null or not exists(select 1 from public.freight_drivers where id=p_id) then raise exception 'Водитель не найден';end if;
  select to_jsonb(d),d.version into before_row,version from private.freight_driver_documents d where driver_id=entity for update;
 end if;
 if (p_id is not null and p_kind<>'driver_documents' and before_row is null) or coalesce(version,0) is distinct from p_version then raise exception 'Запись уже изменилась. Обновите страницу';end if;
 -- Recheck after every blocking lock, including personal denial while waiting.
 if not private.freight_directory_allowed(true) or (p_kind='driver_documents' and not private.has_permission('drivers.documents.view')) then raise exception 'Недостаточно прав' using errcode='42501';end if;
 if p_kind in('carrier','driver') then
  if jsonb_typeof(p_values->'active') is distinct from 'boolean' then raise exception 'Укажите активность';end if;
  active:=(p_values->>'active')::boolean;
  if not active and private.freight_text(p_values,'inactive_reason',1000) is null then raise exception 'Укажите причину прекращения работы';end if;
  if p_kind='carrier' and active and not exists(select 1 from public.counterparties where id=counterparty and status='active') then raise exception 'Юридическое лицо перевозчика неактивно';end if;
 end if;
 if p_kind in('driver','vehicle') then
  carrier:=private.freight_text(p_values,'carrier_id',36,p_kind='vehicle')::uuid;
  if carrier is not null then
   perform 1 from public.carriers where id=carrier and (directory_active or carrier=nullif(before_row->>'carrier_id','')::uuid) for share;
   if not found then raise exception 'Перевозчик неактивен или не найден';end if;
  end if;
 end if;
 if p_kind='carrier' then
  doc:=private.freight_text(p_values,'framework_contract_id',36)::uuid;
  if before_row is not null and (before_row->>'counterparty_id')::uuid<>counterparty then raise exception 'Нельзя заменить юридическое лицо существующего перевозчика';end if;
  if doc is not null and (not private.has_permission('documents.view') or not private.document_is_active(doc) or not private.can_view_generated_document(doc)) then raise exception 'Документ недоступен' using errcode='42501';end if;
  insert into public.carriers(id,counterparty_id,directory_active,inactive_reason,directions,transport_types,payment_terms,signatory,framework_contract_id,directory_version)
   values(entity,counterparty,active,private.freight_text(p_values,'inactive_reason',1000),private.freight_text_array(p_values->'directions',200),private.freight_text_array(p_values->'transport_types',100),private.freight_text(p_values,'payment_terms',1000),private.freight_text(p_values,'signatory',200),doc,coalesce(version,0)+1)
   on conflict(id) do update set counterparty_id=excluded.counterparty_id,directory_active=excluded.directory_active,inactive_reason=excluded.inactive_reason,directions=excluded.directions,transport_types=excluded.transport_types,payment_terms=excluded.payment_terms,signatory=excluded.signatory,framework_contract_id=excluded.framework_contract_id,directory_version=excluded.directory_version,updated_at=now();
  select to_jsonb(c) into after_row from public.carriers c where id=entity;
 elsif p_kind='driver' then
  insert into public.freight_drivers(id,full_name,phones,whatsapp,carrier_id,active,inactive_reason,directory_version)
   values(entity,private.freight_text(p_values,'full_name',200,true),private.freight_text_array(p_values->'phones',50),private.freight_text(p_values,'whatsapp',50),carrier,active,private.freight_text(p_values,'inactive_reason',1000),coalesce(version,0)+1)
   on conflict(id) do update set full_name=excluded.full_name,phones=excluded.phones,whatsapp=excluded.whatsapp,carrier_id=excluded.carrier_id,active=excluded.active,inactive_reason=excluded.inactive_reason,directory_version=excluded.directory_version,updated_at=now();
  select to_jsonb(d) into after_row from public.freight_drivers d where id=entity;
 elsif p_kind='vehicle' then
  perform set_config('nexus.freight_reason',btrim(p_reason),true);
  number:=private.freight_text(p_values,'plate_number',40,true);country:=upper(private.freight_text(p_values,'registration_country',2,true));kind:=private.freight_text(p_values,'vehicle_type',20,true);
  if country!~'^[A-Z]{2}$' or kind not in('truck','trailer','refrigerator') or upper(regexp_replace(number,'[[:space:]-]','','g'))='' then raise exception 'Проверьте страну, номер и тип транспорта';end if;
  if p_values->>'status' is null or p_values->>'status' not in('active','archived') then raise exception 'Укажите статус';end if;
  if nullif(p_values->>'capacity_kg','') is not null and (p_values->>'capacity_kg' !~ '^\d{1,8}(\.\d{1,3})?$' or (p_values->>'capacity_kg')::numeric<=0) then raise exception 'Проверьте грузоподъёмность';end if;
  if nullif(p_values->>'pallet_capacity','') is not null and (p_values->>'pallet_capacity' !~ '^\d{1,3}$' or (p_values->>'pallet_capacity')::int<=0) then raise exception 'Проверьте вместимость в паллетах';end if;
  insert into public.vehicles(id,carrier_id,plate_number,registration_country,vehicle_type,make,body_type,capacity_kg,pallet_capacity,temperature_capability,status,directory_version)
   values(entity,carrier,number,country,kind,private.freight_text(p_values,'make',100),private.freight_text(p_values,'body_type',100),nullif(p_values->>'capacity_kg','')::numeric,nullif(p_values->>'pallet_capacity','')::integer,private.freight_text(p_values,'temperature_capability',200),p_values->>'status',coalesce(version,0)+1)
   on conflict(id) do update set carrier_id=excluded.carrier_id,plate_number=excluded.plate_number,registration_country=excluded.registration_country,vehicle_type=excluded.vehicle_type,make=excluded.make,body_type=excluded.body_type,capacity_kg=excluded.capacity_kg,pallet_capacity=excluded.pallet_capacity,temperature_capability=excluded.temperature_capability,status=excluded.status,directory_version=excluded.directory_version,updated_at=now();
  select to_jsonb(v) into after_row from public.vehicles v where id=entity;
 else
  number:=private.freight_text(p_values,'iin',12);if number is not null and number!~'^\d{12}$' then raise exception 'ИИН должен содержать 12 цифр';end if;
  insert into private.freight_driver_documents(driver_id,iin,document_requisites,version) values(entity,number,private.freight_text(p_values,'document_requisites',1000),coalesce(version,0)+1)
  on conflict(driver_id) do update set iin=excluded.iin,document_requisites=excluded.document_requisites,version=excluded.version;
  select to_jsonb(d) into after_row from private.freight_driver_documents d where driver_id=entity;
 end if;
 -- All acquired directory locks precede this final check; denial rolls back every write.
 if not private.freight_directory_allowed(true) or (p_kind='driver_documents' and not private.has_permission('drivers.documents.view')) then raise exception 'Недостаточно прав' using errcode='42501';end if;
 if source_value is not null and source_value->>'stamp' is distinct from (public.freight_source_preview(source_value->>'type',(source_value->>'id')::uuid)->>'stamp') then raise exception 'Источник изменился. Повторите предпросмотр';end if;
 if p_kind in('driver','driver_documents') then
  insert into private.freight_directory_history(kind,entity_id,actor_id,reason,before_value,after_value) values(p_kind,entity,auth.uid(),btrim(p_reason),before_row,after_row||jsonb_build_object('source',source_value));
 end if;
 if source_value is not null then
  insert into private.freight_source_bindings(source_type,source_id,kind,entity_id) values(source_value->>'type',(source_value->>'id')::uuid,p_kind,entity) on conflict do nothing;
 end if;
 insert into private.freight_directory_requests(id,actor_id,digest,result_id) values(p_request,auth.uid(),digest,entity);
 perform set_config('nexus.freight_reason','',true);
 return entity;
exception when unique_violation then raise exception 'Такая запись уже есть. Найдите её в справочнике' using errcode='23505';
end$$;
revoke all on function public.save_freight_directory(text,uuid,uuid,bigint,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.save_freight_directory(text,uuid,uuid,bigint,jsonb,text) to authenticated;

-- Directory reads never include protected driver fields in lists, search or history.
create or replace function public.freight_directory(p_kind text,p_query text default '',p_after uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare rows jsonb;
begin
 if not private.freight_directory_allowed() then raise exception 'Нет доступа к справочникам перевозки' using errcode='42501';end if;
 if p_kind not in('carrier','driver','vehicle') or length(coalesce(p_query,''))>200 then raise exception 'Некорректный поиск';end if;
 if p_kind='carrier' then
  select coalesce(jsonb_agg(r.data order by r.id),'[]') into rows from (
   select c.id,to_jsonb(c)||jsonb_build_object('name',coalesce(p.short_name,p.legal_name)) as data
   from public.carriers c join public.counterparties p on p.id=c.counterparty_id
   where (p_after is null or c.id>p_after) and private.can_access_counterparty_record('view',p.id)
    and (p_query='' or position(lower(p_query) in lower(p.legal_name||' '||coalesce(p.short_name,'')))>0)
   order by c.id limit 51
  ) r;
 elsif p_kind='driver' then
  select coalesce(jsonb_agg(r.data order by r.id),'[]') into rows from (
   select d.id,to_jsonb(d) as data from public.freight_drivers d
   where (p_after is null or d.id>p_after) and (p_query='' or position(lower(p_query) in lower(d.full_name||' '||array_to_string(d.phones,' ')))>0)
   order by d.id limit 51
  ) r;
 else
  select coalesce(jsonb_agg(r.data order by r.id),'[]') into rows from (
   select v.id,to_jsonb(v) as data from public.vehicles v
   where (p_after is null or v.id>p_after) and (p_query='' or position(lower(p_query) in lower(v.plate_number||' '||coalesce(v.registration_country,'')))>0)
   order by v.id limit 51
  ) r;
 end if;
 return rows;
end$$;
revoke all on function public.freight_directory(text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.freight_directory(text,text,uuid) to authenticated;

create or replace function public.freight_directory_detail(p_kind text,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare entity jsonb;history jsonb;
begin
 if not private.freight_directory_allowed() then raise exception 'Нет доступа к справочникам перевозки' using errcode='42501';end if;
 if p_kind='carrier' then
  select to_jsonb(c)||jsonb_build_object('name',coalesce(p.short_name,p.legal_name)) into entity
  from public.carriers c join public.counterparties p on p.id=c.counterparty_id where c.id=p_id and private.can_access_counterparty_record('view',p.id);
 elsif p_kind='driver' then select to_jsonb(d) into entity from public.freight_drivers d where id=p_id;
 elsif p_kind='vehicle' then select to_jsonb(v) into entity from public.vehicles v where id=p_id;
 elsif p_kind='driver_documents' then
  if not private.has_permission('drivers.documents.view') then raise exception 'Нет доступа к документам водителя' using errcode='42501';end if;
  select to_jsonb(d) into entity from private.freight_driver_documents d where driver_id=p_id;
 else raise exception 'Неизвестный вид справочника';end if;
 select coalesce(jsonb_agg(to_jsonb(h) order by h.created_at desc,h.id),'[]') into history from (
  select id,reason,before_value,after_value,created_at,actor_id from private.freight_directory_history
  where kind=p_kind and entity_id=p_id order by created_at desc,id limit 100
 ) h;
 return jsonb_build_object('record',entity,'history',history);
end$$;
revoke all on function public.freight_directory_detail(text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.freight_directory_detail(text,uuid) to authenticated;

-- An operation keeps its own type and foreign key. No synthetic import shipment is created.
create table if not exists private.freight_trips (
 id uuid primary key default gen_random_uuid(),mode text not null check(mode in('purchase','sale','transfer')),
 version bigint not null, snapshot jsonb not null,updated_at timestamptz not null default clock_timestamp()
);
create table if not exists private.freight_trip_links (
 id uuid primary key default gen_random_uuid(),trip_id uuid not null references private.freight_trips(id),
 transport_id uuid references public.shipment_transports(id),sale_id uuid references public.sales(id),
 transfer_id uuid references public.inventory_operation_documents(id),
 check(num_nonnulls(transport_id,sale_id,transfer_id)=1),
 unique(transport_id),unique(sale_id),unique(transfer_id)
);
create index if not exists freight_trip_links_trip_idx on private.freight_trip_links(trip_id);
create table if not exists private.freight_trip_versions (
 trip_id uuid not null references private.freight_trips(id),version bigint not null,
 snapshot jsonb not null,actor_id uuid not null references public.profiles(id),reason text not null,
 created_at timestamptz not null default clock_timestamp(),primary key(trip_id,version)
);
create index if not exists freight_trip_versions_actor_idx on private.freight_trip_versions(actor_id);
alter table private.freight_trips enable row level security;
alter table private.freight_trip_links enable row level security;
alter table private.freight_trip_versions enable row level security;
revoke all on private.freight_trips,private.freight_trip_links,private.freight_trip_versions from public,anon,authenticated,service_role;
drop trigger if exists freight_trip_version_immutable on private.freight_trip_versions;
create trigger freight_trip_version_immutable before update or delete on private.freight_trip_versions
 for each row execute function private.guard_freight_history();

create or replace function private.freight_operation_allowed(p_mode text,p_id uuid,p_write boolean default false)
returns boolean language sql stable security definer set search_path='' as $$
 select private.is_employee() and private.has_permission('freight.context.read')
 and (not p_write or private.has_permission('freight.context.manage'))
 and case p_mode
 when 'purchase' then private.has_permission('shipments.view') and (not p_write or private.can_write_shipments('update'))
  and exists(select 1 from public.shipment_transports t join public.shipments s on s.id=t.shipment_id
   where t.id=p_id and s.type='import' and (not p_write or (t.status not in('unloaded','cancelled') and s.status not in('closed','on_hold','cancelled') and not s.is_locked)))
 when 'sale' then private.has_permission('sales.view') and (not p_write or private.has_permission('sales.manage'))
  and exists(select 1 from public.sales s where s.id=p_id and private.can_access_counterparty_record('view',s.customer_id)
   and (not p_write or s.status not in('shipped','cancelled')))
 when 'transfer' then private.has_permission('inventory.view') and (not p_write or private.has_permission('inventory.move'))
  and exists(select 1 from public.inventory_operation_documents d where d.id=p_id and d.operation_type='transfer' and (not p_write or d.status='draft'))
 else false end
$$;
revoke all on function private.freight_operation_allowed(text,uuid,boolean) from public,anon,authenticated,service_role;

create or replace function private.freight_trip_allowed(p_id uuid,p_write boolean default false)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.freight_trip_links where trip_id=p_id)
 and not exists(select 1 from private.freight_trip_links l join private.freight_trips t on t.id=l.trip_id
  where t.id=p_id and not private.freight_operation_allowed(t.mode,coalesce(l.transport_id,l.sale_id,l.transfer_id),p_write))
$$;
revoke all on function private.freight_trip_allowed(uuid,boolean) from public,anon,authenticated,service_role;

create or replace function private.freight_snapshot_allowed(p_snapshot jsonb)
returns boolean language sql stable security definer set search_path='' as $$
 select jsonb_array_length(p_snapshot->'operations')>0 and not exists(
  select 1 from jsonb_array_elements(p_snapshot->'operations') op
  where not private.freight_operation_allowed(p_snapshot->>'mode',(op->>'id')::uuid))
$$;
revoke all on function private.freight_snapshot_allowed(jsonb) from public,anon,authenticated,service_role;

create or replace function public.freight_operation_choices(p_mode text,p_after uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if not private.is_employee() or not private.has_permission('freight.context.read') then raise exception 'Нет доступа к рейсам' using errcode='42501';end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') into result from (
  select id,label from (
   select t.id,s.shipment_number||' · '||s.project_code||' · машина '||t.sequence_no as label
    from public.shipment_transports t join public.shipments s on s.id=t.shipment_id where p_mode='purchase'
   union all select s.id,s.sale_number from public.sales s where p_mode='sale'
   union all select d.id,d.document_number from public.inventory_operation_documents d where p_mode='transfer'
  ) source where (p_after is null or id>p_after) and private.freight_operation_allowed(p_mode,id,true)
  order by id limit 51
 ) r;
 return result;
end$$;
revoke all on function public.freight_operation_choices(text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.freight_operation_choices(text,uuid) to authenticated;

-- Build a safe snapshot from current reference rows. Driver identity documents never enter a trip.
create or replace function private.freight_trip_snapshot(p_mode text,p_operations uuid[],p_values jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare carrier jsonb;driver jsonb;vehicle jsonb;trailer jsonb;origin jsonb;destination jsonb;op uuid;operations jsonb:='[]';
 c uuid;d uuid;v uuid;tr uuid;w uuid;tare numeric;field text;address jsonb;label text;stamp timestamptz;
begin
 if not private.freight_directory_allowed() or not private.has_permission('freight.context.manage') then raise exception 'Недостаточно прав для подготовки рейса' using errcode='42501';end if;
 if p_mode is null or p_mode not in('purchase','sale','transfer') or coalesce(cardinality(p_operations),0) not between 1 and 30
  or jsonb_typeof(p_values) is distinct from 'object' then raise exception 'Выберите вид и операции рейса';end if;
 if exists(select 1 from unnest(p_operations) x where x is null) or (select count(distinct x) from unnest(p_operations) x)<>cardinality(p_operations) then raise exception 'Повтор операции в рейсе';end if;
 if exists(select 1 from jsonb_object_keys(p_values) k where k not in('carrier_id','driver_id','vehicle_id','trailer_id','origin','destination','pallet_tare_kg')) then raise exception 'Неизвестное поле рейса';end if;
 foreach op in array p_operations loop
  if not private.freight_operation_allowed(p_mode,op,true) then raise exception 'Операция недоступна или уже проведена' using errcode='42501';end if;
  if p_mode='purchase' then select s.shipment_number||' · машина '||t.sequence_no,t.updated_at into label,stamp from public.shipment_transports t join public.shipments s on s.id=t.shipment_id where t.id=op;
  elsif p_mode='sale' then select sale_number,updated_at into label,stamp from public.sales where id=op;
  else select document_number,updated_at into label,stamp from public.inventory_operation_documents where id=op;end if;
  operations:=operations||jsonb_build_array(jsonb_build_object('id',op,'label',label,'updated_at',stamp));
 end loop;
 c:=private.freight_text(p_values,'carrier_id',36,true)::uuid;
 d:=private.freight_text(p_values,'driver_id',36,true)::uuid;
 v:=private.freight_text(p_values,'vehicle_id',36,true)::uuid;
 tr:=private.freight_text(p_values,'trailer_id',36)::uuid;
 select jsonb_build_object('id',x.id,'counterparty_id',p.id,'name',p.legal_name,'tax_id',p.tax_id,'country',p.country,'version',x.directory_version)
 into carrier from public.carriers x join public.counterparties p on p.id=x.counterparty_id
 where x.id=c and x.directory_active and p.status='active' and private.can_access_counterparty_record('view',p.id);
 select jsonb_build_object('id',id,'full_name',full_name,'phones',phones,'whatsapp',whatsapp,'version',directory_version)
 into driver from public.freight_drivers where id=d and active and carrier_id=c;
 select to_jsonb(x)-'notes' into vehicle from public.vehicles x where id=v and status='active' and carrier_id=c and vehicle_type<>'trailer' and registration_country is not null;
 if tr is not null then select to_jsonb(x)-'notes' into trailer from public.vehicles x where id=tr and status='active' and carrier_id=c and vehicle_type='trailer' and registration_country is not null;end if;
 if carrier is null or driver is null or vehicle is null or (tr is not null and trailer is null) then raise exception 'Проверьте активного перевозчика, водителя, машину и прицеп';end if;
 if p_values->>'pallet_tare_kg' is null or p_values->>'pallet_tare_kg' !~ '^2[0-5](\.\d{1,3})?$' then raise exception 'Вес пустой паллеты — от 20 до 25 кг';end if;
 tare:=(p_values->>'pallet_tare_kg')::numeric;
 if tare not between 20 and 25 then raise exception 'Вес пустой паллеты — от 20 до 25 кг';end if;
 foreach field in array array['origin','destination'] loop
  address:=p_values->field;
  if jsonb_typeof(address) is distinct from 'object' or exists(select 1 from jsonb_object_keys(address) k where k not in('warehouse_id','address','contact','confirmed')) then raise exception 'Проверьте адрес';end if;
  w:=private.freight_text(address,'warehouse_id',36)::uuid;
  if w is not null then
   if not private.has_permission('warehouses.view') then raise exception 'Нет доступа к складам' using errcode='42501';end if;
   select jsonb_build_object('warehouse_id',wh.id,'name',wh.name->>'ru','address',wh.address,'contact',private.freight_text(p_values->field,'contact',300)) into address
   from public.warehouses wh where wh.id=w and wh.status='active' and nullif(btrim(wh.address),'') is not null;
   if address is null then raise exception 'Адрес склада не заполнен';end if;
  else
   if address->'confirmed' is distinct from 'true'::jsonb then raise exception 'Подтвердите ручной адрес';end if;
   address:=jsonb_build_object('warehouse_id',null,'address',private.freight_text(address,'address',1000,true),'contact',private.freight_text(address,'contact',300));
  end if;
  if field='origin' then origin:=address;else destination:=address;end if;
 end loop;
 return jsonb_build_object('mode',p_mode,'operations',operations,'carrier',carrier,'driver',driver,'vehicle',vehicle,'trailer',trailer,'origin',origin,'destination',destination,'pallet_tare_kg',tare);
end$$;
revoke all on function private.freight_trip_snapshot(text,uuid[],jsonb) from public,anon,authenticated,service_role;

create or replace function public.preview_freight_trip(p_mode text,p_operations uuid[],p_values jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare snapshot jsonb;
begin
 snapshot:=private.freight_trip_snapshot(p_mode,p_operations,p_values);
 return jsonb_build_object('snapshot',snapshot,'digest',encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'));
end$$;
revoke all on function public.preview_freight_trip(text,uuid[],jsonb) from public,anon,authenticated,service_role;
grant execute on function public.preview_freight_trip(text,uuid[],jsonb) to authenticated;

create or replace function public.save_freight_trip(p_request uuid,p_id uuid,p_version bigint,p_mode text,p_operations uuid[],p_values jsonb,p_preview_digest text,p_reason text)
returns uuid language plpgsql security definer set search_path='' as $$
declare entity uuid:=coalesce(p_id,gen_random_uuid());prev private.freight_trips%rowtype;req private.freight_directory_requests%rowtype;
 digest text;snapshot jsonb;op uuid;
begin
 if not private.freight_directory_allowed() or not private.has_permission('freight.context.manage') then raise exception 'Недостаточно прав' using errcode='42501';end if;
 if p_request is null or p_reason is null or length(btrim(p_reason)) not between 3 and 1000 then raise exception 'Укажите причину';end if;
 if p_mode is null or p_mode not in('purchase','sale','transfer') or coalesce(cardinality(p_operations),0) not between 1 and 30
  or jsonb_typeof(p_values) is distinct from 'object' then raise exception 'Выберите вид и операции рейса';end if;
 if exists(select 1 from unnest(p_operations) x where x is null) or (select count(distinct x) from unnest(p_operations) x)<>cardinality(p_operations) then raise exception 'Повтор операции в рейсе';end if;
 digest:=encode(sha256(convert_to(jsonb_build_object('id',p_id,'version',p_version,'mode',p_mode,'operations',p_operations,'values',p_values,'preview',p_preview_digest,'reason',p_reason)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended('freight-request:'||p_request,0));
 select * into req from private.freight_directory_requests where id=p_request;
 if found then
  if req.actor_id<>auth.uid() or req.digest<>digest then raise exception 'Идентификатор операции уже использован';end if;
  if not private.freight_trip_allowed(req.result_id) then raise exception 'Рейс недоступен' using errcode='42501';end if;
  return req.result_id;
 end if;
 perform pg_advisory_xact_lock(hashtextextended('freight-trip:'||entity,0));
 select * into prev from private.freight_trips where id=entity for update;
 if (p_id is not null and prev.id is null) or coalesce(prev.version,0) is distinct from p_version then raise exception 'Рейс изменился. Повторите предпросмотр';end if;
 if p_id is not null and (prev.mode<>p_mode or not private.freight_trip_allowed(entity,true)) then raise exception 'Рейс недоступен для изменения' using errcode='42501';end if;
 -- Stable lock order: operations, carrier, driver, vehicles, warehouses. The same rows are read again below.
 for op in select x from unnest(p_operations) x union select coalesce(transport_id,sale_id,transfer_id) from private.freight_trip_links where trip_id=entity order by 1 loop
  if not private.freight_operation_allowed(p_mode,op,true) then raise exception 'Операция недоступна или уже проведена' using errcode='42501';end if;
  if p_mode='purchase' then
   perform 1 from public.shipments s where s.id=(select shipment_id from public.shipment_transports where id=op) for share;
   perform 1 from public.shipment_transports where id=op for share;
  elsif p_mode='sale' then perform 1 from public.sales where id=op for share;
  elsif p_mode='transfer' then perform 1 from public.inventory_operation_documents where id=op for share;end if;
 end loop;
 perform 1 from public.carriers where id=(p_values->>'carrier_id')::uuid for share;
 perform 1 from public.counterparties where id=(select counterparty_id from public.carriers where id=(p_values->>'carrier_id')::uuid) for share;
 perform 1 from public.freight_drivers where id=(p_values->>'driver_id')::uuid for share;
 perform 1 from public.vehicles where id in((p_values->>'vehicle_id')::uuid,nullif(p_values->>'trailer_id','')::uuid) order by id for share;
 perform 1 from public.warehouses where id in(nullif(p_values->'origin'->>'warehouse_id','')::uuid,nullif(p_values->'destination'->>'warehouse_id','')::uuid) order by id for share;
 snapshot:=private.freight_trip_snapshot(p_mode,p_operations,p_values);
 if p_preview_digest is distinct from encode(sha256(convert_to(snapshot::text,'UTF8')),'hex') then raise exception 'Исходные данные изменились. Повторите предпросмотр';end if;
 if p_id is not null and not private.freight_trip_allowed(entity,true) then raise exception 'Рейс недоступен' using errcode='42501';end if;
 insert into private.freight_trips(id,mode,version,snapshot) values(entity,p_mode,coalesce(prev.version,0)+1,snapshot)
 on conflict(id) do update set version=excluded.version,snapshot=excluded.snapshot,updated_at=clock_timestamp();
 delete from private.freight_trip_links where trip_id=entity;
 foreach op in array p_operations loop
  insert into private.freight_trip_links(trip_id,transport_id,sale_id,transfer_id)
  values(entity,case when p_mode='purchase' then op end,case when p_mode='sale' then op end,case when p_mode='transfer' then op end);
 end loop;
 insert into private.freight_trip_versions(trip_id,version,snapshot,actor_id,reason) values(entity,coalesce(prev.version,0)+1,snapshot,auth.uid(),btrim(p_reason));
 insert into private.freight_directory_requests(id,actor_id,digest,result_id) values(p_request,auth.uid(),digest,entity);
 return entity;
exception when unique_violation then raise exception 'Операция уже связана с другим рейсом. Откройте существующий рейс' using errcode='23505';
end$$;
revoke all on function public.save_freight_trip(uuid,uuid,bigint,text,uuid[],jsonb,text,text) from public,anon,authenticated,service_role;
grant execute on function public.save_freight_trip(uuid,uuid,bigint,text,uuid[],jsonb,text,text) to authenticated;

create or replace function public.freight_trips(p_id uuid default null,p_after uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if not private.is_employee() or not private.has_permission('freight.context.read') then raise exception 'Нет доступа к рейсам' using errcode='42501';end if;
 if p_id is not null then
  if not private.freight_trip_allowed(p_id) then raise exception 'Рейс недоступен' using errcode='42501';end if;
  select to_jsonb(t)||jsonb_build_object(
   'history',(select coalesce(jsonb_agg(to_jsonb(v) order by version desc),'[]') from private.freight_trip_versions v where trip_id=p_id and private.freight_snapshot_allowed(v.snapshot)),
   'history_hidden',exists(select 1 from private.freight_trip_versions v where trip_id=p_id and not private.freight_snapshot_allowed(v.snapshot))) into result from private.freight_trips t where id=p_id;
 else
  select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') into result from (
   select id,mode,version,snapshot,updated_at from private.freight_trips where (p_after is null or id>p_after) and private.freight_trip_allowed(id) order by id limit 51
  ) r;
 end if;
 return result;
end$$;
revoke all on function public.freight_trips(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.freight_trips(uuid,uuid) to authenticated;

create or replace function public.freight_source_preview(p_type text,p_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare data jsonb;source jsonb;suggested jsonb;fingerprint text;
begin
 if not private.freight_directory_allowed() or not private.has_permission('shipments.view') then raise exception 'Источник недоступен' using errcode='42501';end if;
 if p_type='transport' then
  select to_jsonb(t),jsonb_build_object('type',p_type,'id',t.id,'label',s.shipment_number||' · машина '||t.sequence_no,'updated_at',t.updated_at)
  into data,source from public.shipment_transports t join public.shipments s on s.id=t.shipment_id where t.id=p_id;
 elsif p_type='extraction' then
  if not private.has_permission('documents.view') then raise exception 'Документ недоступен' using errcode='42501';end if;
  select e.confirmed_data,jsonb_build_object('type',p_type,'id',e.id,'label',d.title,'document_id',d.id,'version_id',v.id,'updated_at',e.updated_at)
  into data,source from public.shipment_source_extractions e
  join public.documents d on d.id=e.document_id and d.archived_at is null and d.status<>'rejected'
  join public.document_versions v on v.id=e.document_version_id and v.document_id=d.id and v.is_current and v.version_number=d.current_version
  where e.id=p_id and e.status='confirmed' and private.can_view_generated_document(d.id)
   and exists(select 1 from public.document_links l where l.document_id=d.id and l.removed_at is null
    and ((l.entity_type='shipment' and l.entity_id=e.shipment_id) or (l.entity_type='shipment_transport' and l.entity_id in(select id from public.shipment_transports where shipment_id=e.shipment_id))));
 else raise exception 'Неизвестный источник';end if;
 if data is null then raise exception 'Источник недоступен, не подтверждён или заменён';end if;
 -- No driver_document/IIN, raw OCR, evidence or URLs are returned, even to a privileged reader.
 suggested:=jsonb_build_object('carrier_name',data->>'carrier_name','full_name',data->>'driver_name','phone',data->>'driver_phone',
  'plate_number',data->>'vehicle_plate','make',data->>'vehicle_make','trailer_plate',data->>'trailer_plate');
 fingerprint:=encode(sha256(convert_to(jsonb_build_object('source',source,'suggested',suggested)::text,'UTF8')),'hex');
 return jsonb_build_object('source',source,'suggested',suggested,'stamp',fingerprint,
  'existing',coalesce((select jsonb_object_agg(kind,entity_id) from private.freight_source_bindings where source_type=p_type and source_id=p_id),'{}'));
end$$;
revoke all on function public.freight_source_preview(text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.freight_source_preview(text,uuid) to authenticated;

create or replace function public.freight_source_choices(p_type text,p_after uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if not private.freight_directory_allowed() or not private.has_permission('shipments.view') then raise exception 'Нет доступа к источникам' using errcode='42501';end if;
 if p_type='extraction' and not private.has_permission('documents.view') then raise exception 'Нет доступа к документам' using errcode='42501';end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') into result from (
  select id,label from (
   select t.id,s.shipment_number||' · машина '||t.sequence_no as label from public.shipment_transports t join public.shipments s on s.id=t.shipment_id where p_type='transport'
   union all
   select e.id,d.title from public.shipment_source_extractions e join public.documents d on d.id=e.document_id
   join public.document_versions v on v.id=e.document_version_id and v.document_id=d.id and v.is_current and v.version_number=d.current_version
   where p_type='extraction' and e.status='confirmed' and d.archived_at is null and d.status<>'rejected' and private.can_view_generated_document(d.id)
    and exists(select 1 from public.document_links l where l.document_id=d.id and l.removed_at is null
     and ((l.entity_type='shipment' and l.entity_id=e.shipment_id) or (l.entity_type='shipment_transport' and l.entity_id in(select id from public.shipment_transports where shipment_id=e.shipment_id))))
  ) source where p_after is null or id>p_after order by id limit 51
 ) r;
 return result;
end$$;
revoke all on function public.freight_source_choices(text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.freight_source_choices(text,uuid) to authenticated;

-- Legacy checked imports remain usable, but cannot silently invalidate optimistic edits or history.
create or replace function private.freight_reference_version() returns trigger
language plpgsql set search_path='' as $$
begin
 if tg_op='UPDATE' then new.directory_version:=old.directory_version+1;end if;
 return new;
end$$;
create or replace function private.freight_reference_history() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is not null then
  insert into private.freight_directory_history(kind,entity_id,actor_id,reason,before_value,after_value)
  values(case tg_table_name when 'carriers' then 'carrier' else 'vehicle' end,new.id,auth.uid(),
   coalesce(nullif(current_setting('nexus.freight_reason',true),''),'Изменение через штатный импорт справочников'),
   case when tg_op='UPDATE' then to_jsonb(old) end,to_jsonb(new));
 end if;
 return new;
end$$;
revoke all on function private.freight_reference_version(),private.freight_reference_history() from public,anon,authenticated,service_role;
drop trigger if exists freight_carrier_version on public.carriers;
create trigger freight_carrier_version before update on public.carriers for each row execute function private.freight_reference_version();
drop trigger if exists freight_vehicle_version on public.vehicles;
create trigger freight_vehicle_version before update on public.vehicles for each row execute function private.freight_reference_version();
drop trigger if exists freight_carrier_history on public.carriers;
create trigger freight_carrier_history after insert or update on public.carriers for each row execute function private.freight_reference_history();
drop trigger if exists freight_vehicle_history on public.vehicles;
create trigger freight_vehicle_history after insert or update on public.vehicles for each row execute function private.freight_reference_history();
