-- PREPARED ONLY. Read-only inventory for an isolated test/operator-approved environment.
-- Not a migration, no schedule, no DELETE, no Google calls.
-- Storage API stores custom metadata in user_metadata on supported Supabase versions.
-- Do not run against owner environments as part of this task.
begin transaction read only;
select o.id as storage_object_id, op.id as operation_id, op.state, op.stage, o.created_at
from storage.objects o
join public.shipment_drive_operations op
 on (to_jsonb(o)->'user_metadata'->>'nexus_operation')=op.id::text
where o.bucket_id='nexus-documents'
 and o.created_at < clock_timestamp()-interval '24 hours'
 and (op.state='completed' or (op.state='failed' and op.stage='storage'))
 and not exists(select 1 from public.document_versions v where v.storage_bucket=o.bucket_id and v.storage_path=o.name)
 and not exists(select 1 from public.documents d where d.storage_bucket=o.bucket_id and d.storage_path=o.name)
order by o.created_at;
rollback;
-- Before deletion in a separately authorized procedure: freeze registration/worker activity,
-- reread exact Storage metadata and ALL document-version references; exclude pending/uncertain
-- operations. Delete through Storage API, NEVER by deleting storage.objects rows.
-- If any check is unavailable, retain. Untagged pre-existing objects require separate inventory.
