-- One read-only MVCC snapshot, caller's privileges and underlying RLS throughout.
-- Never expose audit blobs, prices, extraction text, Storage paths or hidden document IDs.
create or replace function public.shipment_quantity_provenance(p_shipment_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('inventoryVisible',private.has_permission('inventory.view'),
 'auditVisible',private.has_permission('audit.view'),'items',coalesce(jsonb_agg(jsonb_build_object(
  'id',i.id,'sku',p.internal_sku,'name',p.name,'uom',i.uom,'transport',t.sequence_no,
  'ordered',i.ordered_quantity,'confirmed',i.confirmed_quantity,'shipped',i.shipped_quantity,
  'received',case when private.has_permission('inventory.view') then i.received_quantity end,
  'history',coalesce((select jsonb_agg(jsonb_build_object(
    'id',h.id,'field',h.field,'previous',h.previous_quantity,'quantity',h.quantity,
    'latest',not exists(select 1 from public.shipment_item_quantity_confirmations newer
      where newer.shipment_item_id=h.shipment_item_id and newer.field=h.field
      and newer.id<>h.id and newer.confirmed_at>=h.confirmed_at),
    'at',h.confirmed_at,'actor',actor.full_name,'documentId',d.id,'document',d.title,
    'version',v.version_number,'currentVersion',v.is_current and v.version_number=d.current_version,
    'reviewed',e.status='confirmed' and e.reviewed_at is not null
   ) order by h.confirmed_at,h.id)
   from public.shipment_item_quantity_confirmations h
   join public.documents d on d.id=h.document_id and d.archived_at is null and d.status<>'rejected'
   join public.document_versions v on v.id=h.document_version_id and v.document_id=d.id
   join public.shipment_source_extractions e on e.id=h.extraction_id and e.document_id=d.id
    and e.document_version_id=v.id and e.shipment_id=i.shipment_id
   left join public.profiles actor on actor.id=h.confirmed_by
   where h.shipment_id=i.shipment_id and h.shipment_item_id=i.id
    and private.can_view_generated_document(d.id)
    and (e.shipment_transport_id is null or e.shipment_transport_id=i.shipment_transport_id)
    and exists(select 1 from public.document_links l where l.document_id=d.id and l.removed_at is null
     and (l.entity_type='shipment' and l.entity_id=i.shipment_id
      or l.entity_type='shipment_transport' and l.entity_id=e.shipment_transport_id))),'[]'::jsonb),
  'demandHistory',coalesce((select jsonb_agg(jsonb_build_object(
    'id',a.id::text,'action',a.action,'previous',a.before_data->'ordered_quantity',
    'quantity',a.after_data->'ordered_quantity','uom',a.after_data->>'uom',
    'previousUom',a.before_data->>'uom','at',a.created_at,'actor',actor.full_name
   ) order by a.created_at,a.id)
   from public.audit_log a left join public.profiles actor on actor.id=a.actor_user_id
   where a.entity_type='shipment_items' and a.entity_id=i.id::text and a.metadata->>'source'='database'
    and a.action in ('insert','update') and (a.action='insert'
     or a.before_data->'ordered_quantity' is distinct from a.after_data->'ordered_quantity'
     or a.before_data->'uom' is distinct from a.after_data->'uom')),'[]'::jsonb),
  'receipts',coalesce((select jsonb_agg(jsonb_build_object(
    'id',r.id,'at',r.received_at,'actor',actor.full_name,'performedBy',r.performed_by_name,
    'expected',ri.expected_quantity,'accepted',ri.accepted_quantity,'damaged',ri.damaged_quantity,
    'shortage',ri.shortage_quantity,'overage',ri.overage_quantity,'reason',ri.discrepancy_reason
   ) order by r.received_at,r.id)
   from public.shipment_transport_receipt_items ri
   join public.shipment_transport_receipts r on r.id=ri.receipt_id and r.shipment_id=i.shipment_id
   left join public.profiles actor on actor.id=r.received_by where ri.shipment_item_id=i.id),'[]'::jsonb)
 ) order by t.sequence_no nulls last,i.created_at,i.id),'[]'::jsonb))
 from public.shipment_items i join public.shipments s on s.id=i.shipment_id
 left join public.products p on p.id=i.product_id
 left join public.shipment_transports t on t.id=i.shipment_transport_id
 where i.shipment_id=p_shipment_id and private.has_permission('shipments.view');
$$;
revoke all on function public.shipment_quantity_provenance(uuid) from public,anon,authenticated,service_role;
grant execute on function public.shipment_quantity_provenance(uuid) to authenticated;
