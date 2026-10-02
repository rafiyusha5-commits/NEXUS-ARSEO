-- Customs processing is mandatory for the EU-to-Kazakhstan import process.
-- Earlier migrations created these stages as conditional but did not provide an
-- activation mechanism, leaving import shipments able to bypass customs.

update public.shipment_stages stage
set requirement = 'required',
    updated_at = now()
from public.process_templates template
where stage.process_template_id = template.id
  and template.code = 'import_eu_kz'
  and stage.code in ('broker_processing', 'customs_clearance')
  and stage.requirement <> 'required';

-- Recover existing import shipments without touching completed work or any
-- shipment, product, transport, document or inventory data.
update public.shipment_stage_runs run
set is_required = true,
    status = case when run.status = 'not_applicable' then 'pending' else run.status end,
    status_reason = case when run.status = 'not_applicable' then null else run.status_reason end,
    updated_at = now()
from public.shipments shipment,
     public.shipment_stages stage,
     public.process_templates template
where run.shipment_id = shipment.id
  and run.stage_id = stage.id
  and stage.process_template_id = template.id
  and shipment.type = 'import'
  and template.code = 'import_eu_kz'
  and stage.code in ('broker_processing', 'customs_clearance')
  and (not run.is_required or run.status = 'not_applicable');

comment on column public.shipment_stage_runs.is_required is
  'True for mandatory process stages, including broker and customs processing in import_eu_kz';
