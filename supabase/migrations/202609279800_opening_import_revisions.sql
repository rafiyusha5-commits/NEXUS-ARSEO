-- The source file is immutable; an explicit correction is a new audited import revision.
alter table public.receivables_import_batches drop constraint if exists receivables_import_batches_kind_file_sha256_key;
create unique index if not exists receivables_bank_file_unique on public.receivables_import_batches(kind,file_sha256) where kind='bank';
create unique index if not exists receivables_file_payload_unique on public.receivables_import_batches(kind,file_sha256,payload_hash);

-- Reuse the guarded ledger writer and the single preview plan. Opening corrections must explicitly
-- replace every current row with a reason; unchanged retries, including old revisions, never write again.
do $$ declare definition text; old_block text; new_block text; begin
 definition:=replace(pg_get_functiondef('public.confirm_receivables_import(uuid,jsonb,text)'::regprocedure),chr(13),'');
 old_block:=$old$if prior.id is null then
   select * into prior from public.receivables_import_batches where kind=p_payload->>'kind' and file_sha256=p_payload->>'file_sha256';
 end if;$old$;
 new_block:=$new$if prior.id is null then
   select * into prior from public.receivables_import_batches
    where kind=p_payload->>'kind' and file_sha256=p_payload->>'file_sha256' and payload_hash=h;
 end if;
 if prior.id is null and exists(select 1 from public.receivables_import_batches
   where kind=p_payload->>'kind' and file_sha256=p_payload->>'file_sha256') then
   if p_payload->>'kind' is distinct from 'opening' then
    raise exception 'Файл уже подтверждён с другими данными: откройте историю импорта';
   end if;
   if jsonb_typeof(p_payload->'rows') is distinct from 'array' then raise exception 'Нет строк исправления'; end if;
   if jsonb_array_length(p_payload->'rows')=0 or exists(select 1 from jsonb_array_elements(p_payload->'rows') correction_row
      where nullif(correction_row->>'replace_id','') is null or coalesce(length(btrim(correction_row->>'reason')),0)<5) then
    raise exception 'Исправление прежнего файла требует явной замены каждого сальдо с причиной';
   end if;
 end if;$new$;
 if position(new_block in definition)=0 then
  if position(old_block in definition)=0 then raise exception 'Import writer changed: review revision integration'; end if;
  execute replace(definition,old_block,new_block);
 end if;
 definition:=pg_get_functiondef('private.receivables_import_plan(jsonb)'::regprocedure);
 old_block:='select id into duplicate_batch from public.receivables_import_batches where kind=k and file_sha256=p->>''file_sha256'';';
 new_block:='select id into duplicate_batch from public.receivables_import_batches where kind=k and file_sha256=p->>''file_sha256'' order by created_at desc,id desc limit 1;';
 if position(new_block in definition)=0 then
  if position(old_block in definition)=0 then raise exception 'Import preview changed: review revision integration'; end if;
  execute replace(definition,old_block,new_block);
 end if;
end $$;
