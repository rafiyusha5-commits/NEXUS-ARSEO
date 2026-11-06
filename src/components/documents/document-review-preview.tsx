import { formatDate } from "@/lib/documents/labels";
import type { SourceFieldDefinition } from "@/lib/document-extraction/rules";
import { isCommodityInvoice } from "@/lib/document-extraction/commodity-evidence";
import { isPackingEvidence } from "@/lib/document-extraction/packing-evidence";
import { isSupplierLots } from "@/lib/document-extraction/yilmaz";

type ReviewSource = {
  id: string;
  status: string;
  confirmed_data: Record<string, unknown>;
  extracted_data: Record<string, unknown>;
};

export function DocumentReviewPreview({ source, definitions }: { source: ReviewSource; definitions: SourceFieldDefinition[] }) {
  const confirmed = source.status === "confirmed";
  const values = confirmed ? source.confirmed_data : source.extracted_data;
  const missing: string[] = [];
  const fields = definitions.flatMap(({ key, label, type }) => {
    const value = values?.[key];
    if (value == null || value === "") missing.push(label);
    if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return [];
    let display = String(value);
    if (type === "number" && Number.isFinite(Number(value))) {
      display = Number(value).toLocaleString("ru-RU", { maximumFractionDigits: 3 });
      if (key.endsWith("_kg")) display += " кг";
    } else if (type === "date") {
      display = formatDate(display);
    }
    return [{ key, label, display }];
  });
  const data = source.extracted_data ?? {};
  const customs = data.customs_record;
  const hasTables = isCommodityInvoice(data.commodity_invoice) || isPackingEvidence(data.packing_evidence)
    || isSupplierLots(data.supplier_lots) || (Array.isArray(data.invoice_items) && data.invoice_items.length > 0)
    || (customs && typeof customs === "object" && "fields" in customs && Array.isArray(customs.fields) && customs.fields.length > 0);
  if (!fields.length && !hasTables) return null;

  return <details className="document-review-preview">
    <summary>Посмотреть поля сверки</summary>
    {fields.length > 0 && <>
      <p>{confirmed ? "Подтверждено сотрудником" : "Распознано · ожидает проверки"}</p>
      <dl>{fields.map(field => <div key={field.key}><dt>{field.label}</dt><dd>{field.display}</dd></div>)}</dl>
    </>}
    {missing.length > 0 && <p>Не заполнено: {missing.join(", ")}</p>}
    <a href={`#source-result-${source.id}`}>Открыть полный результат сверки</a>
  </details>;
}
