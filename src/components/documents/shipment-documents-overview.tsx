import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { loadPermissions } from "@/lib/permissions";
import { applicableRequirements, type DocumentRequirement } from "@/lib/documents/rules";
import { parseDocumentCheck, summarizeFindings } from "@/lib/document-check/rules";
import { shipmentDriveGateway } from "@/lib/google/shipment-gateway";
import { isOrderWorkbook } from "@/lib/shipments/order-workbook";
import { kitRows, todoCards, type KitDocument, type KitRequirement } from "@/lib/documents/overview";

// The top of the «Документы» tab (2026-11-23): what to do now and the document set by stage. Display only — every
// action stays in the blocks below; the cards only count and link to them.
export async function ShipmentDocumentsOverview({ shipmentId }: { shipmentId: string }) {
  const supabase = await createClient();
  const permissions = await loadPermissions(supabase, ["documents.view", "shipments.view", "documents.drive.view"] as const);
  if (!permissions["documents.view"] || !permissions["shipments.view"]) return null;

  const [{ data: shipment }, { data: transports }, sources, check] = await Promise.all([
    supabase.from("shipments").select("type,process_template_id,route_id,leading_stage:shipment_stages!shipments_leading_stage_id_fkey(sequence_order)").eq("id", shipmentId).maybeSingle(),
    supabase.from("shipment_transports").select("id").eq("shipment_id", shipmentId),
    supabase.from("shipment_source_extractions").select("status,reviewed_at").eq("shipment_id", shipmentId).neq("status", "superseded"),
    supabase.rpc("shipment_document_check", { p_shipment_id: shipmentId }),
  ]);
  const transportIds = (transports ?? []).map(transport => transport.id as string);
  const linkFilter = transportIds.length
    ? `and(entity_type.eq.shipment,entity_id.eq.${shipmentId}),and(entity_type.eq.shipment_transport,entity_id.in.(${transportIds.join(",")}))`
    : `and(entity_type.eq.shipment,entity_id.eq.${shipmentId})`;
  const [links, requirements] = await Promise.all([
    supabase.from("document_links").select("document:documents(id,document_type_id,status,archived_at,type:document_types(name_ru))").is("removed_at", null).or(linkFilter),
    supabase.from("document_requirements").select("id,document_type_id,applies_to,shipment_type,process_template_id,route_id,is_mandatory,is_active,due_description,type:document_types(name_ru),stage:shipment_stages(name,sequence_order)").eq("is_active", true),
  ]);

  let drive: { uploadable: number; workbook: boolean; bound: boolean } = { uploadable: 0, workbook: false, bound: false };
  if (permissions["documents.drive.view"]) {
    try {
      const db = await shipmentDriveGateway(supabase);
      const [binding, files] = await Promise.all([
        db.from("shipment_drive_folders").select("folder_id").eq("shipment_id", shipmentId).maybeSingle(),
        db.from("shipment_drive_files").select("name,mime_type,present,imported_document_id").eq("shipment_id", shipmentId).eq("present", true).limit(1000),
      ]);
      if (!binding.error && !files.error) {
        const rows = files.data ?? [];
        // Google tables are read where they are used («Вн расчеты», distribution); they are not files to upload.
        drive = { bound: Boolean(binding.data), workbook: rows.some(file => isOrderWorkbook(file.name, file.mime_type)),
          uploadable: rows.filter(file => !file.imported_document_id && !file.mime_type.startsWith("application/vnd.google-apps")).length };
      }
    } catch { /* the Drive block below shows the reason */ }
  }

  const one = <T,>(value: T | T[] | null | undefined) => (Array.isArray(value) ? value[0] : value ?? undefined);
  const documents: KitDocument[] = [];
  for (const row of (links.data ?? []) as unknown as { document: { id: string; document_type_id: string; status: string; archived_at: string | null; type: { name_ru: string } | { name_ru: string }[] | null } | null }[]) {
    const document = one(row.document);
    if (document && !document.archived_at && !documents.some(item => item.id === document.id))
      documents.push({ id: document.id, typeId: document.document_type_id, typeName: one(document.type)?.name_ru ?? "Документ", status: document.status });
  }
  const rules: KitRequirement[] = shipment ? applicableRequirements((requirements.data ?? []) as unknown as (DocumentRequirement & { type: unknown; stage: unknown })[], {
    type: shipment.type as string, process_template_id: shipment.process_template_id as string | null, route_id: shipment.route_id as string | null,
  }).map(rule => {
    const stage = one(rule.stage as { name: Record<string, string>; sequence_order: number } | null);
    return { typeId: rule.document_type_id, typeName: one(rule.type as { name_ru: string } | null)?.name_ru ?? "Документ", mandatory: rule.is_mandatory,
      stageName: stage?.name?.ru ?? null, stageOrder: stage?.sequence_order ?? null };
  }) : [];
  const currentOrder = one(shipment?.leading_stage as unknown as { sequence_order: number } | { sequence_order: number }[] | null)?.sequence_order ?? 1;
  const kit = kitRows(rules, documents, currentOrder);
  const findings = summarizeFindings(parseDocumentCheck(check.error ? null : check.data).findings);
  const cards = todoCards({
    uploadable: drive.uploadable,
    toConfirm: (sources.data ?? []).filter(row => ["extracted", "needs_review"].includes(row.status as string)).length,
    unreadable: (sources.data ?? []).filter(row => row.status === "failed").length,
    errors: check.error ? 0 : findings.errors,
    workbook: drive.workbook,
  }, shipmentId);
  const ready = kit.flatMap(group => group.items).filter(item => item.tone === "ok").length;
  const total = kit.flatMap(group => group.items).filter(item => item.counted).length;

  return <div className="docs-overview">
    <section className="docs-todo" aria-labelledby="docs-todo-title">
      <h2 id="docs-todo-title">Что сделать сейчас</h2>
      {cards.length ? <div className="docs-todo-grid">{cards.map(card => <div className={`docs-todo-card docs-tone-${card.tone}`} key={card.key}>
        <div className="docs-todo-head">{card.count !== null && <b>{card.count}</b>}<strong>{card.title}</strong></div>
        <p>{card.hint}</p>
        <Link className="primary button-link" href={card.href}>{card.action}</Link>
      </div>)}</div> : <p className="docs-todo-none">Сейчас по документам делать ничего не нужно.</p>}
    </section>
    {kit.length > 0 && <section className="panel docs-kit" aria-labelledby="docs-kit-title">
      <div className="docs-kit-head"><h2 id="docs-kit-title">Комплект документов</h2><span>{total ? `Готово ${ready} из ${total}` : ""}{kit.some(group => group.items.some(item => item.tone === "later")) ? " · остальные понадобятся на следующих этапах" : ""}</span></div>
      <div className="docs-kit-grid">{kit.map(group => <div className="docs-kit-group" key={group.stage}>
        <span className="docs-kit-stage">{group.stage}</span>
        {group.items.map(item => <div className={`docs-kit-item docs-tone-${item.tone}`} key={`${group.stage}-${item.name}`}><span>{item.name}</span><b>{item.state}</b></div>)}
      </div>)}</div>
    </section>}
  </div>;
}
