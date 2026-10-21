import { usableSourceContext, type ContextSource } from "../document-extraction/source-context.ts";
import { SOURCE_FIELD_DEFINITIONS, conflictsAcrossDocuments } from "../document-extraction/rules.ts";
import { analyseDocumentQuantities, itemsInDocumentScope, type DocumentLine, type QuantityItem } from "./document-quantities.ts";

export const preparationGroups = { unknown: "Назначение не установлено", procurement: "Закупка", import_transport: "Импортная перевозка", customs: "Таможня", sale: "Продажа", export_transport: "Экспортная перевозка" } as const;
export const preparationVariants = { unknown: "Вид не установлен", original: "Оригинал", translation: "Перевод", copy: "Копия", new_version: "Новая версия файла" } as const;
export const preparationStates = { documented: "Установлено по документу", confirmed: "Подтверждено сотрудником", assumption: "Предположение", unknown: "Не установлено", conflict: "Противоречие" } as const;
export type PreparationChoice = { id: string; version: string; updated: string; group: keyof typeof preparationGroups; variant: keyof typeof preparationVariants };
export type PreparationSource = ContextSource & { id: string; document_id: string; updated_at: string; reviewed_at: string | null; source_kind: string; extracted_data: Record<string, unknown>; confirmed_data: Record<string, unknown> };
export type PreparationInput = { shipmentId: string; transportIds: string[]; complete: boolean; sources: PreparationSource[]; choices: PreparationChoice[]; items: QuantityItem[] };

export function preparationSourceValues(source: PreparationSource): PreparationSource {
  const project = (data: Record<string, unknown>) => Object.fromEntries(SOURCE_FIELD_DEFINITIONS.flatMap(f => {
    const v = data?.[f.key]; return typeof v === "string" || typeof v === "number" && Number.isFinite(v) ? [[f.key, v]] : [];
  }));
  const lines = source.extracted_data?.invoice_items;
  return { ...source, confirmed_data: project(source.confirmed_data), extracted_data: { ...project(source.extracted_data),
    ...(Array.isArray(lines) ? { invoice_items: lines.map(line => {
      if (!line || typeof line !== "object") return null;
      return Object.fromEntries(["line_number", "product_name", "sku", "hs_code", "uom", "quantity"].filter(k => k in line).map(k => [k, line[k]]));
    }) } : {}),
  } };
}

// This is a projection, not a second extraction/matching engine. Persist references only;
// current source values are obtained anew through employee RLS on every opening.
export function preparationPreview(input: PreparationInput) {
  const sources = input.complete ? input.sources.filter(s => usableSourceContext(s, input.shipmentId, input.transportIds)) : [];
  const rows = [...new Map(sources.map(s => [s.id, s])).values()].map(source => {
    const saved = input.choices.find(c => c.id === source.id);
    const stale = Boolean(saved && (saved.version !== source.document_version_id || saved.updated !== source.updated_at));
    const choice: PreparationChoice = saved && !stale ? saved : { id: source.id, version: source.document_version_id, updated: source.updated_at, group: "unknown", variant: "unknown" };
    const confirmed = source.status === "confirmed" && Boolean(source.reviewed_at);
    const fields = SOURCE_FIELD_DEFINITIONS.map(field => {
      const reviewed = confirmed ? source.confirmed_data[field.key] : undefined;
      const raw = reviewed ?? source.extracted_data[field.key];
      const value = typeof raw === "string" || typeof raw === "number" ? String(raw) : null;
      return { key: field.key, label: field.label, value, state: value === null || value === "" ? "unknown" as const : reviewed !== undefined && reviewed !== null ? "confirmed" as const : "documented" as const };
    });
    const document = Array.isArray(source.document) ? source.document[0] : source.document;
    const title = (document as typeof document & { title?: string })?.title ?? "Документ";
    const rawLines = source.extracted_data.invoice_items;
    const malformed = Array.isArray(rawLines) && rawLines.some(line => !line || typeof line !== "object"
      || ["sku", "product_name", "hs_code", "uom"].some(k => line[k] != null && typeof line[k] !== "string")
      || line.quantity != null && (typeof line.quantity !== "number" || !Number.isFinite(line.quantity)));
    const lines = Array.isArray(rawLines) && !malformed ? rawLines as DocumentLine[] : [];
    const quantities = ["invoice", "specification"].includes(source.source_kind)
      ? analyseDocumentQuantities(itemsInDocumentScope(input.items, source.shipment_transport_id ?? null), lines) : null;
    if (malformed && quantities) quantities.warnings.push("Товарные строки повреждены: требуется повторная проверка источника.");
    return { id: source.id, documentId: source.document_id, version: source.document_version_id, title, choice, stale,
      transportId: source.shipment_transport_id ?? null, fields, quantities, lines,
      href: `/documents/${source.document_id}/download?version=${source.document_version_id}` };
  });
  // Do not compare import/export or different vehicles, nor infer their context from filenames.
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.choice.group === "unknown") continue;
    const key = `${row.choice.group}:${row.transportId ?? "whole"}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const group of groups.values()) {
    const conflicts = conflictsAcrossDocuments(group.map(row => ({ documentId: row.id, result: {
      data: Object.fromEntries(row.fields.filter(f => f.value !== null).map(f => [f.key, f.value])), evidence: {}, conflicts: [],
    } })));
    for (const row of group) for (const field of row.fields) {
      if (conflicts.some(c => c.field === field.key && c.documents?.includes(row.id))) {
        // The projection carries a distinct conflict state without changing either source.
        (field as { state: keyof typeof preparationStates }).state = "conflict";
      }
    }
  }
  const actions = new Set<string>(["Фактическую приёмку подтвердить отдельным основанием; этот мастер её не проводит."]);
  if (!input.complete) actions.add("Не удалось загрузить полный доступный комплект. Обновите проверку; готовность не определена.");
  if (!rows.length) actions.add("Загрузить и проверить доступные документы через существующее сопоставление папки.");
  if (input.choices.some(c => !rows.some(r => r.id === c.id)) || rows.some(r => r.stale)) actions.add("Часть ранее выбранных источников изменилась или недоступна. Повторно проверить комплект и назначение; прежние отметки не перенесены.");
  for (const row of rows) {
    if (row.choice.group === "unknown") actions.add(`Установить операцию для «${row.title}» по содержимому, а не имени файла.`);
    if (row.choice.variant === "unknown") actions.add(`Установить вид «${row.title}»: оригинал, перевод, копия или новая версия.`);
    if (row.choice.group.endsWith("transport") && !row.transportId) actions.add(`Установить автомобиль для «${row.title}» в существующей форме контекста. Выбор в проекте не меняет привязку.`);
    if (row.fields.some(f => (f.state as string) === "conflict")) actions.add(`Разобрать противоречия «${row.title}»; значения не перезаписывались.`);
    if (row.fields.some(f => f.state === "documented")) actions.add(`Проверить прочитанные значения «${row.title}» в штатной форме подтверждения.`);
    if (row.quantities && (!row.lines.length || row.quantities.warnings.length || row.quantities.proposals.some(p => p.review))) actions.add(`Сопоставить товарные строки и единицы «${row.title}»; количества не перенесены.`);
  }
  for (const group of ["procurement", "import_transport", "customs"] as const) if (!rows.some(r => r.choice.group === group)) actions.add(`Уточнить наличие или неприменимость раздела «${preparationGroups[group]}». Это вопрос для проверки, а не признание обязательного недостающего документа.`);
  return { rows, actions: [...actions] };
}
