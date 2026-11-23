import Link from "next/link";
import type { ReactNode } from "react";
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
import { shipmentDriveGateway } from "@/lib/google/shipment-gateway";
import { documentFolders, typeTag } from "@/lib/documents/overview";

type LinkedDocument = {
  id: string;
  document_type_id: string;
  document_number: string | null;
  title: string;
  document_date: string | null;
  valid_until: string | null;
  status: string;
  archived_at: string | null;
  current_version: number;
  versions: { id: string; version_number: number; is_current: boolean; original_filename: string; mime_type: string }[];
  type: { name_ru: string } | { name_ru: string }[] | null;
};

type RequirementRow = DocumentRequirement & {
  type: { name_ru: string } | { name_ru: string }[] | null;
  stage: { name: Record<string, string> } | { name: Record<string, string> }[] | null;
};

const one = <T,>(value: T | T[] | null | undefined) => (Array.isArray(value) ? value[0] : value ?? undefined);

// Self-contained block for the shipment page: loads its own data with the user's
// session, so the shipment page only needs to render <ShipmentDocumentsPanel />.
export async function ShipmentDocumentsPanel({ shipmentId, reviews, hideMissing = false }: {
  shipmentId: string;
  reviews?: ReadonlyMap<string, { preview: ReactNode; isPackingList: boolean }>;
  /** The overview at the top of the tab already lists missing documents by stage. */
  hideMissing?: boolean;
}) {
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
      .select("entity_type, document:documents(id, document_type_id, document_number, title, document_date, valid_until, status, archived_at, current_version, type:document_types(name_ru), versions:document_versions!document_versions_document_id_fkey(id,version_number,is_current,original_filename,mime_type))")
      .is("removed_at", null)
      .eq("document.versions.is_current", true)
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
  // Documents are grouped by the Drive subfolder they came from; documents uploaded by hand form their own group.
  let folderOf = new Map<string, string>();
  try {
    const db = await shipmentDriveGateway(supabase);
    const files = await db.from("shipment_drive_files").select("imported_document_id,path").eq("shipment_id", shipmentId).not("imported_document_id", "is", null).limit(1000);
    if (!files.error) folderOf = new Map((files.data ?? []).map(file => [file.imported_document_id as string, String(file.path)]));
  } catch { /* without the Drive connection every document is in one group */ }
  const groups = documentFolders(documents.map(({ document }) => ({ id: document.id, status: document.status, path: folderOf.get(document.id) ?? null })));

  return (
    <section className="panel admin-section">
      {heading}

      {!hideMissing && missing.length > 0 && (
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

      <div className="doc-shipment-list" id="shipment-document-list">
        {groups.map(group => <details className="docs-folder" key={group.name} open={group.open}>
          <summary><span className="docs-folder-name">{group.name}</span><span className="docs-count">{group.ids.length}</span><span className="docs-folder-summary">{group.summary}</span></summary>
        {documents.filter(({ document }) => group.ids.includes(document.id)).map(({ document, viaTransport }) => {
          const requirement = coverage.byType.get(document.document_type_id);
          const expiry = documentExpiry(document.valid_until, today);
          const file = document.versions.find(version => version.is_current && version.version_number === document.current_version);
          const review = file && reviews?.get(file.id);
          const cardUrl = `/documents/${document.id}`;
          return (
            <article className="doc-shipment-row" id={`shipment-document-${document.id}`} key={document.id} aria-label={document.title}>
              <span className="docs-type-tag" aria-hidden="true">{typeTag(review?.isPackingList ? "Упаковочный лист" : one(document.type)?.name_ru ?? "Документ")}</span>
              <div>
                <span className="doc-type">{review?.isPackingList ? "Упаковочный лист" : one(document.type)?.name_ru ?? "Документ"}{viaTransport ? " · по перевозке" : ""}</span>
                <Link href={cardUrl}><strong>{document.document_number ? `№ ${document.document_number}` : document.title}</strong></Link>
                <small>{file ? `${file.original_filename} · версия ${file.version_number}` : document.title}</small>
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
              <div className="shipment-document-actions">
                <Link href={cardUrl}>Открыть карточку</Link>
                {file ? <a href={`${cardUrl}/download?version=${file.id}`}>Скачать оригинал{file.mime_type === "application/pdf" ? " PDF" : ""}</a>
                  : <span className="form-help">Файл для скачивания недоступен</span>}
              </div>
              {review?.preview}
            </article>
          );
        })}
        </details>)}
        {!documents.length && (
          <div className="empty-state">К поставке ещё не привязан ни один документ.</div>
        )}
      </div>
    </section>
  );
}
