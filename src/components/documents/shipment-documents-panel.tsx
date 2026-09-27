import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { documentStatusLabel, formatDate } from "@/lib/documents/labels.ts";
import {
  type DocumentRequirement,
  applicableRequirements,
  documentExpiry,
  isUuid,
  requirementCoverage,
  todayIso,
} from "@/lib/documents/rules.ts";
import { loadDocumentPermissions } from "@/lib/documents/supabase-gateway.ts";

type LinkedDocument = {
  id: string;
  document_type_id: string;
  document_number: string | null;
  title: string;
  document_date: string | null;
  valid_until: string | null;
  status: string;
  archived_at: string | null;
  type: { name_ru: string } | { name_ru: string }[] | null;
};

type RequirementRow = DocumentRequirement & {
  type: { name_ru: string } | { name_ru: string }[] | null;
  stage: { name: Record<string, string> } | { name: Record<string, string> }[] | null;
};

const one = <T,>(value: T | T[] | null | undefined) => (Array.isArray(value) ? value[0] : value ?? undefined);

// Self-contained block for the shipment page: loads its own data with the user's
// session, so the shipment page only needs to render <ShipmentDocumentsPanel />.
export async function ShipmentDocumentsPanel({ shipmentId }: { shipmentId: string }) {
  if (!isUuid(shipmentId)) return null;
  const supabase = await createClient();
  const permissions = await loadDocumentPermissions(supabase);

  const heading = (
    <div className="panel-heading">
      <div><p className="eyebrow">Документооборот</p><h2>Документы поставки</h2></div>
      {permissions.create && (
        <Link className="primary button-link compact" href={`/documents?link=shipment:${shipmentId}#register`}>+ Добавить документ</Link>
      )}
    </div>
  );

  if (!permissions.view) {
    return (
      <section className="panel admin-section">
        {heading}
        <div className="empty-state">Нет права просмотра документов. Обратитесь к администратору.</div>
      </section>
    );
  }

  const [{ data: shipment }, { data: transports }] = await Promise.all([
    supabase.from("shipments").select("type, process_template_id, route_id").eq("id", shipmentId).maybeSingle(),
    supabase.from("shipment_transports").select("id").eq("shipment_id", shipmentId),
  ]);
  const transportIds = (transports ?? []).map((transport) => transport.id as string);

  const linkFilter = transportIds.length
    ? `and(entity_type.eq.shipment,entity_id.eq.${shipmentId}),and(entity_type.eq.shipment_transport,entity_id.in.(${transportIds.join(",")}))`
    : `and(entity_type.eq.shipment,entity_id.eq.${shipmentId})`;

  const [linksResult, requirementsResult] = await Promise.all([
    supabase
      .from("document_links")
      .select("entity_type, document:documents(id, document_type_id, document_number, title, document_date, valid_until, status, archived_at, type:document_types(name_ru))")
      .is("removed_at", null)
      .or(linkFilter),
    supabase
      .from("document_requirements")
      .select("id, document_type_id, applies_to, shipment_type, process_template_id, route_id, is_mandatory, is_active, due_description, type:document_types(name_ru), stage:shipment_stages(name)")
      .eq("is_active", true),
  ]);

  if (linksResult.error || requirementsResult.error) {
    return (
      <section className="panel admin-section">
        {heading}
        <div className="setup-notice">
          Документы поставки недоступны. Если модуль ещё не подключён, примените миграцию <strong>202609271001_document_management.sql</strong>.
        </div>
      </section>
    );
  }

  const documentsById = new Map<string, { document: LinkedDocument; viaTransport: boolean }>();
  for (const row of (linksResult.data ?? []) as unknown as { entity_type: string; document: LinkedDocument | LinkedDocument[] | null }[]) {
    const document = one(row.document);
    if (!document || document.archived_at) continue;
    const existing = documentsById.get(document.id);
    documentsById.set(document.id, { document, viaTransport: (existing?.viaTransport ?? true) && row.entity_type === "shipment_transport" });
  }
  const documents = [...documentsById.values()];

  const requirements = shipment
    ? applicableRequirements((requirementsResult.data ?? []) as unknown as RequirementRow[], {
        type: shipment.type as string,
        process_template_id: shipment.process_template_id as string | null,
        route_id: shipment.route_id as string | null,
      })
    : [];
  const coverage = requirementCoverage(requirements, documents.map(({ document }) => document.document_type_id));
  const missing = coverage.missingMandatory.map((typeId) => {
    const rule = requirements.find((requirement) => requirement.document_type_id === typeId && requirement.is_mandatory)!;
    return { typeId, name: one(rule.type)?.name_ru ?? "Документ", stage: one(rule.stage)?.name?.ru, due: rule.due_description };
  });
  const today = todayIso();

  return (
    <section className="panel admin-section">
      {heading}

      {missing.length > 0 && (
        <div className="doc-missing">
          <strong>Не хватает обязательных документов: {missing.length}</strong>
          <ul>
            {missing.map((item) => (
              <li key={item.typeId}>
                <span>{item.name}{item.stage ? ` · этап «${item.stage}»` : ""}{item.due ? ` · ${item.due}` : ""}</span>
                {permissions.create && <Link href={`/documents?link=shipment:${shipmentId}&doc_type=${item.typeId}#register`}>Загрузить</Link>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="doc-shipment-list">
        {documents.map(({ document, viaTransport }) => {
          const requirement = coverage.byType.get(document.document_type_id);
          const expiry = documentExpiry(document.valid_until, today);
          return (
            <Link className="doc-shipment-row" href={`/documents/${document.id}`} key={document.id}>
              <div>
                <span className="doc-type">{one(document.type)?.name_ru ?? "Документ"}{viaTransport ? " · по перевозке" : ""}</span>
                <strong>{document.document_number ? `№ ${document.document_number}` : document.title}</strong>
                <small>{document.document_number ? document.title : "Без номера"}</small>
              </div>
              <div><strong>{formatDate(document.document_date)}</strong><small>дата</small></div>
              <span className={`doc-badge doc-status-${document.status}`}>{documentStatusLabel[document.status] ?? document.status}</span>
              <span className={`doc-badge ${requirement?.mandatory ? "doc-required" : "doc-optional"}`}>
                {requirement ? (requirement.mandatory ? "Обязательный" : "Необязательный") : "Вне перечня"}
              </span>
              <div>
                <strong>{document.valid_until ? `до ${formatDate(document.valid_until)}` : "Бессрочно"}</strong>
                {expiry.state === "expired" && <span className="doc-badge doc-expired">Истёк</span>}
                {expiry.state === "expiring" && <span className="doc-badge doc-expiring">{expiry.daysLeft} дн.</span>}
              </div>
            </Link>
          );
        })}
        {!documents.length && (
          <div className="empty-state">К поставке ещё не привязан ни один документ.</div>
        )}
      </div>
    </section>
  );
}
