-- Phase 9D: atomically register the XLSX shipment workbook and selected printable export PDFs.

alter table public.document_generations drop constraint if exists document_generations_output_format_check;
alter table public.document_generations add constraint document_generations_output_format_check
  check(output_format in ('docx','xlsx','pdf'));

create or replace function public.register_generated_document_package(
 p_template_id uuid,
 p_template_version_id uuid,
 p_shipment_id uuid,
 p_files jsonb,
 p_contains_prices boolean default false,
 p_fields_snapshot jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path=''
as $$
declare
 v_template public.document_templates%rowtype;
 v_version public.document_template_versions%rowtype;
 v_shipment public.shipments%rowtype;
 v_file jsonb;
 v_type_id uuid;
 v_type_code text;
 v_format text;
 v_document_id uuid;
 v_generation_id uuid;
 v_result jsonb:='[]'::jsonb;
begin
 if not (select private.has_permission('templates.generate')) then raise exception 'Недостаточно прав для формирования документа';end if;
 if not (select private.has_permission('documents.create')) then raise exception 'Недостаточно прав для регистрации документа';end if;
 if not (select private.has_permission('shipments.view')) then raise exception 'Нет доступа к поставке';end if;
 if p_contains_prices and not (select private.has_permission('templates.generate_prices')) then raise exception 'Нет права формировать документы с ценами';end if;
 if jsonb_typeof(coalesce(p_fields_snapshot,'{}'::jsonb))<>'object' or pg_column_size(coalesce(p_fields_snapshot,'{}'::jsonb))>1048576 then raise exception 'Некорректный или слишком большой снимок данных';end if;
 if not p_contains_prices and (coalesce(p_fields_snapshot->>'total_amount','')<>'' or exists(
  select 1 from jsonb_array_elements(coalesce(p_fields_snapshot->'items','[]'::jsonb)) item
  where coalesce(item->>'unit_price','')<>'' or coalesce(item->>'line_total','')<>'' or coalesce(item->>'currency_code','')<>''
 )) then raise exception 'Финансовые поля требуют отдельного права';end if;
 if jsonb_typeof(coalesce(p_files,'[]'::jsonb))<>'array' or jsonb_array_length(coalesce(p_files,'[]'::jsonb)) not between 1 and 4 then raise exception 'Выберите от одного до четырёх документов комплекта';end if;

 select * into v_template from public.document_templates where id=p_template_id;
 if not found or v_template.status<>'approved' or not v_template.is_active or v_template.archived_at is not null then raise exception 'Шаблон не утверждён или отключён';end if;
 select * into v_version from public.document_template_versions where id=p_template_version_id and template_id=p_template_id and is_current;
 if not found or v_version.mime_type<>'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' then raise exception 'Для экспортного комплекта нужна текущая версия шаблона XLSX';end if;
 select * into v_shipment from public.shipments where id=p_shipment_id;
 if not found then raise exception 'Поставка не найдена';end if;
 if v_template.counterparty_id is not null and ((v_template.flow_direction='input' and v_template.counterparty_id is distinct from v_shipment.supplier_id) or (v_template.flow_direction='output' and v_template.counterparty_id is distinct from v_shipment.customer_id)) then raise exception 'Шаблон предназначен для другого контрагента';end if;

 if (select count(distinct value->>'document_type_code') from jsonb_array_elements(p_files))<>jsonb_array_length(p_files) then raise exception 'Один тип документа выбран несколько раз';end if;
 for v_file in select value from jsonb_array_elements(p_files) loop
  v_type_code:=v_file->>'document_type_code';v_format:=v_file->>'output_format';
  v_document_id:=nullif(v_file->>'document_id','')::uuid;v_generation_id:=nullif(v_file->>'generation_id','')::uuid;
  if v_document_id is null or v_generation_id is null or length(btrim(coalesce(v_file->>'title','')))<2 or length(btrim(coalesce(v_file->>'original_filename','')))<3 then raise exception 'Некорректные реквизиты файла комплекта';end if;
  if (v_format='xlsx' and v_type_code<>'shipment_workbook') or (v_format='pdf' and v_type_code not in ('cmr','ttn','packing_list')) or v_format not in ('xlsx','pdf') then raise exception 'Недопустимое сочетание типа и формата документа';end if;
  select id into v_type_id from public.document_types where code=v_type_code and is_active;
  if v_type_id is null then raise exception 'Тип документа % не найден или выключен',v_type_code;end if;
  perform public.register_document(
   v_document_id,v_type_id,btrim(v_file->>'title'),v_file->>'storage_path',btrim(v_file->>'original_filename'),
   nullif(btrim(v_file->>'document_number'),''),'Сформировано автоматически из экспортного шаблона «'||v_template.name||'», версия '||v_version.version_number,
   current_date,null,v_template.language,null,null,v_file->>'checksum_sha256',
   jsonb_build_array(jsonb_build_object('entity_type','shipment','entity_id',p_shipment_id,'link_role','primary'))
  );
  insert into public.document_generations(id,template_id,template_version_id,shipment_id,document_id,output_format,contains_prices,fields_snapshot,generated_by)
  values(v_generation_id,p_template_id,p_template_version_id,p_shipment_id,v_document_id,v_format,p_contains_prices,p_fields_snapshot,auth.uid());
  v_result:=v_result||jsonb_build_array(jsonb_build_object('document_id',v_document_id,'document_type_code',v_type_code));
 end loop;
 return v_result;
end $$;

revoke all on function public.register_generated_document_package(uuid,uuid,uuid,jsonb,boolean,jsonb) from public,anon,service_role;
grant execute on function public.register_generated_document_package(uuid,uuid,uuid,jsonb,boolean,jsonb) to authenticated;

comment on function public.register_generated_document_package(uuid,uuid,uuid,jsonb,boolean,jsonb) is
 'Atomically registers a selected XLSX/PDF export package with immutable template and field provenance';
