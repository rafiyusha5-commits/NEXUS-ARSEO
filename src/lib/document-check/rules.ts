// Agent «Сверка» (shipment documents against the card): the checks run in the database
// (supabase/migrations/202609276400_document_check_agent.sql); this module only reads the result and
// prepares it for the shipment card. Nothing here decides on its own or calls a language model.

export type CheckSeverity = "error" | "warning";
export type CheckState = "ok" | "warning" | "error";

export type CheckFinding = {
  key: string;
  code: string;
  severity: CheckSeverity;
  message: string;
  transportId?: string;
  transportNo?: number;
  documentId?: string;
  documentTitle?: string;
  field?: string;
  documentValue?: string;
  cardValue?: string;
};

export type DocumentCheck = {
  findings: CheckFinding[];
  lastRunAt: string | null;
  lastRunSource: string | null;
};

/** Mirrors private.document_check_weight_tolerance: the larger of 2 % and 50 kg. */
export const WEIGHT_TOLERANCE_SHARE = 0.02;
export const WEIGHT_TOLERANCE_MIN_KG = 50;
export function weightToleranceKg(expectedKg: number) {
  return Math.max(Math.abs(expectedKg) * WEIGHT_TOLERANCE_SHARE, WEIGHT_TOLERANCE_MIN_KG);
}

/** Mirrors private.document_check_recipient_roles: who is notified about new problems. */
export const DOCUMENT_CHECK_RECIPIENT_ROLES = [
  "administrator", "director", "logistics_director", "senior_logistics_manager", "logistics_specialist",
] as const;

export const FIELD_LABELS: Record<string, string> = {
  vehicle_plate: "Госномер автомобиля",
  trailer_plate: "Госномер прицепа",
  gross_weight_kg: "Вес брутто",
  net_weight_kg: "Вес нетто",
  pallet_count: "Паллеты",
  contract_number: "Номер договора",
  invoice_number: "Номер инвойса",
};

/** Codes whose card value is a date: «в документе / в карточке» reads as «действует до / прибытие». */
const DATE_CODES = new Set(["document_expired", "document_expires_before_arrival", "contract_expired", "contract_expires_before_arrival"]);
const VALUE_CODES = new Set(["plate_mismatch", "plate_missing_in_card", "plate_unknown", "vehicle_missing", "weight_mismatch",
  "pallet_mismatch", "contract_number_mismatch", "invoice_number_mismatch", "cargo_not_allocated", "load_not_calculated"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** Reads the RPC answer defensively: anything malformed is dropped rather than shown half-way. */
export function parseDocumentCheck(raw: unknown): DocumentCheck {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    findings: parseFindings(source.findings),
    lastRunAt: text(source.last_run_at) ?? null,
    lastRunSource: text(source.last_run_source) ?? null,
  };
}

export function parseFindings(raw: unknown): CheckFinding[] {
  if (!Array.isArray(raw)) return [];
  const findings: CheckFinding[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const key = text(row.key), code = text(row.code), message = text(row.message);
    const severity = row.severity === "error" || row.severity === "warning" ? row.severity : undefined;
    if (!key || !code || !message || !severity) continue;
    const transportNo = Number(row.transport_no);
    findings.push({
      key, code, severity, message,
      transportId: text(row.transport_id) && UUID.test(String(row.transport_id)) ? String(row.transport_id) : undefined,
      transportNo: Number.isInteger(transportNo) && transportNo > 0 ? transportNo : undefined,
      documentId: text(row.document_id) && UUID.test(String(row.document_id)) ? String(row.document_id) : undefined,
      documentTitle: text(row.document_title),
      field: text(row.field),
      documentValue: text(row.document_value),
      cardValue: text(row.card_value),
    });
  }
  return findings;
}

export function summarizeFindings(findings: CheckFinding[]) {
  const errors = findings.filter((finding) => finding.severity === "error").length;
  const warnings = findings.length - errors;
  const state: CheckState = errors ? "error" : warnings ? "warning" : "ok";
  return { state, errors, warnings };
}

export const CHECK_STATE_LABEL: Record<CheckState, string> = {
  ok: "В проверенных данных расхождений нет",
  warning: "Есть замечания",
  error: "Есть ошибки",
};

/** «В документе: … · В карточке: …» for findings that compare two values; null when there is nothing to compare. */
export function describeValues(finding: CheckFinding): string | null {
  if (DATE_CODES.has(finding.code)) {
    const parts = [finding.documentValue && `действует до ${formatIsoDate(finding.documentValue)}`,
      finding.cardValue && `плановое прибытие ${formatIsoDate(finding.cardValue)}`].filter(Boolean);
    return parts.length ? parts.join(" · ") : null;
  }
  if (!VALUE_CODES.has(finding.code)) return null;
  const parts = [finding.documentValue && `в документе: ${finding.documentValue}`,
    finding.cardValue && `${finding.code.startsWith("weight") || finding.code === "pallet_mismatch" ? "расчёт" : "в карточке"}: ${finding.cardValue}`].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

export function formatIsoDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value;
}

/** Title of the task an employee creates from a finding. The database limits titles to 200 characters. */
export function findingTaskTitle(finding: CheckFinding, shipmentNumber: string) {
  const vehicle = finding.transportNo ? `, автомобиль №${finding.transportNo}` : "";
  const title = `Документы ${shipmentNumber}${vehicle}: ${finding.message}`;
  return title.length > 200 ? `${title.slice(0, 199)}…` : title;
}

/** Description of that task: what was found and in which document, without prices. */
export function findingTaskDescription(finding: CheckFinding) {
  return [
    finding.message,
    finding.documentTitle && `Документ: ${finding.documentTitle}`,
    describeValues(finding),
    "Создано агентом «Сверка» по документам поставки.",
  ].filter(Boolean).join("\n").slice(0, 2000);
}
