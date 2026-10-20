import { checkDocumentFile } from "../documents/files.ts";

export type Candidate = {
  id: string; title: string; type: string; versionId: string; version: number;
  status: string; review?: string; basis: "checksum" | "name" | "linked";
};
export type ReconciliationSource = {
  file_id: string; name: string; path: string; revision: string; present: boolean;
  mime_type?: string; imported_document_id: string | null; imported_revision: string | null;
  checked_revision?: string | null; checked_checksum?: string | null;
};
export type VisibleDocument = Omit<Candidate, "basis"> & { checksum: string | null; filename: string | null };
export const reconciliationLabels = {
  linked: "Уже связан с документом Nexus",
  exact: "Точное совпадение содержимого",
  possible: "Возможное совпадение — нужна проверка",
  new: "Новый файл — связь не выбрана",
  changed: "Изменён на Drive после загрузки",
  missing: "Отсутствует при последней полной проверке",
  unsupported: "Формат пока не поддерживается",
} as const;
export type ReconciliationState = keyof typeof reconciliationLabels;
export function supportedSource(source: ReconciliationSource) {
  return ["application/vnd.google-apps.document", "application/vnd.google-apps.spreadsheet", "application/vnd.google-apps.presentation"].includes(source.mime_type ?? "")
    || checkDocumentFile({ name: source.name, size: 1, type: "" }).ok;
}
/** Input documents MUST already be restricted by session RLS. Never send hashes to the client. */
export function reconcileSource(source: ReconciliationSource, documents: VisibleDocument[], activeLinkedIds: Set<string>) {
  const { checked_checksum, checked_revision, imported_document_id, imported_revision, ...safe } = source;
  const linked = documents.find(d => d.id === imported_document_id && activeLinkedIds.has(d.id));
  const verified = checked_revision === source.revision && Boolean(checked_checksum);
  const candidates: Candidate[] = documents.flatMap(d => {
    const basis = linked?.id === d.id ? "linked" : verified && d.checksum === checked_checksum ? "checksum"
      : [d.title, d.filename].some(n => n?.trim().toLocaleLowerCase("ru") === source.name.trim().toLocaleLowerCase("ru")) ? "name" : null;
    if (!basis) return [];
    return [{ id: d.id, title: d.title, type: d.type, versionId: d.versionId, version: d.version, status: d.status, review: d.review, basis }];
  });
  const state: ReconciliationState = !source.present ? "missing"
    : linked && imported_revision !== source.revision ? "changed" : linked ? "linked"
    : !supportedSource(source) ? "unsupported" : candidates.some(c => c.basis === "checksum") ? "exact"
    : candidates.length ? "possible" : "new";
  // A receipt for a document no longer visible/linked must not disclose its identity or existence.
  return { ...safe, state, candidates, verified, imported_document_id: linked?.id ?? null,
    imported_revision: linked ? imported_revision : null };
}
