// Pure business rules for documents: expiry, requirements, search and metadata checks.

export const EXPIRING_SOON_DAYS = 30;
export const DOCUMENT_TIME_ZONE = "Asia/Qyzylorda";

export type ExpiryState = "none" | "valid" | "expiring" | "expired";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function dayNumber(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function isIsoDate(value: string) {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function todayIso(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: DOCUMENT_TIME_ZONE }).format(now);
}

export function documentExpiry(validUntil: string | null | undefined, today: string) {
  if (!validUntil || !isIsoDate(validUntil)) return { state: "none" as ExpiryState, daysLeft: null };
  const daysLeft = dayNumber(validUntil) - dayNumber(today);
  const state: ExpiryState = daysLeft < 0 ? "expired" : daysLeft <= EXPIRING_SOON_DAYS ? "expiring" : "valid";
  return { state, daysLeft };
}

export type DocumentRequirement = {
  id: string;
  document_type_id: string;
  applies_to: string;
  shipment_type: string | null;
  process_template_id: string | null;
  route_id: string | null;
  is_mandatory: boolean;
  is_active: boolean;
  due_description?: string | null;
};

export type ShipmentContext = {
  type: string;
  process_template_id: string | null;
  route_id: string | null;
};

// A requirement applies when it is active, targets shipments and every filter it sets
// (shipment type, process template, route) matches the shipment. Empty filters match all.
export function applicableRequirements<T extends DocumentRequirement>(requirements: T[], shipment: ShipmentContext) {
  return requirements.filter(
    (requirement) =>
      requirement.is_active &&
      requirement.applies_to === "shipment" &&
      (requirement.shipment_type === null || requirement.shipment_type === shipment.type) &&
      (requirement.process_template_id === null || requirement.process_template_id === shipment.process_template_id) &&
      (requirement.route_id === null || requirement.route_id === shipment.route_id),
  );
}

export type RequirementSummary = { mandatory: boolean; dueDescriptions: string[] };

// Groups requirements by document type (mandatory if any rule is mandatory) and lists
// mandatory types without an active, non-archived linked document.
export function requirementCoverage<T extends DocumentRequirement>(requirements: T[], presentTypeIds: Iterable<string>) {
  const byType = new Map<string, RequirementSummary>();
  for (const requirement of requirements) {
    const current = byType.get(requirement.document_type_id) ?? { mandatory: false, dueDescriptions: [] };
    current.mandatory ||= requirement.is_mandatory;
    if (requirement.due_description) current.dueDescriptions.push(requirement.due_description);
    byType.set(requirement.document_type_id, current);
  }
  const present = new Set(presentTypeIds);
  const missingMandatory = [...byType.entries()]
    .filter(([typeId, summary]) => summary.mandatory && !present.has(typeId))
    .map(([typeId]) => typeId);
  return { byType, missingMandatory };
}

// PostgREST "or" filters are built from strings; characters that change the filter
// grammar are removed so a search term can never add conditions. RLS still applies.
export function sanitizeSearchTerm(value: string | null | undefined) {
  return (value ?? "")
    .replace(/[,()"'\\*%:;{}[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export const DOCUMENT_STATUSES = ["uploaded", "under_review", "approved", "rejected"] as const;
export const DOCUMENT_LANGUAGES = ["ru", "kk", "en", "other"] as const;
export const LINK_ENTITY_TYPES = [
  "shipment",
  "shipment_transport",
  "supplier",
  "customer",
  "product",
  "warehouse",
  "contract",
  "customer_return",
] as const;
export const LINK_ROLES = ["primary", "related", "supporting"] as const;
export const MAX_LINKS_PER_DOCUMENT = 20;

export type LinkEntityType = (typeof LINK_ENTITY_TYPES)[number];
export type DocumentLinkInput = { entity_type: LinkEntityType; entity_id: string; link_role: (typeof LINK_ROLES)[number] };

export type DocumentMetadata = {
  document_type_id: string;
  title: string;
  document_number: string | null;
  description: string | null;
  document_date: string | null;
  valid_until: string | null;
  language: string | null;
  currency_id: string | null;
  amount: number | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID.test(value);
}

// Mirrors the database constraints so the user gets a clear message before any upload.
export function validateDocumentMetadata(metadata: DocumentMetadata): string | null {
  if (!isUuid(metadata.document_type_id)) return "Выберите тип документа";
  const title = metadata.title.trim();
  if (!title) return "Укажите название документа";
  if (title.length > 300) return "Название не должно быть длиннее 300 символов";
  if (metadata.document_number && metadata.document_number.length > 120) return "Номер не должен быть длиннее 120 символов";
  if (metadata.description && metadata.description.length > 4000) return "Описание не должно быть длиннее 4000 символов";
  if (metadata.document_date && !isIsoDate(metadata.document_date)) return "Некорректная дата документа";
  if (metadata.valid_until && !isIsoDate(metadata.valid_until)) return "Некорректный срок действия";
  if (metadata.document_date && metadata.valid_until && metadata.valid_until < metadata.document_date) {
    return "Срок действия не может быть раньше даты документа";
  }
  if (metadata.language && !(DOCUMENT_LANGUAGES as readonly string[]).includes(metadata.language)) return "Некорректный язык";
  if (metadata.amount !== null) {
    if (!Number.isFinite(metadata.amount) || metadata.amount < 0) return "Сумма должна быть неотрицательным числом";
    if (!isUuid(metadata.currency_id)) return "Для суммы выберите валюту";
  }
  if (metadata.currency_id && !isUuid(metadata.currency_id)) return "Некорректная валюта";
  return null;
}

export function validateLinks(links: DocumentLinkInput[]): string | null {
  if (links.length > MAX_LINKS_PER_DOCUMENT) return `Не более ${MAX_LINKS_PER_DOCUMENT} связей у документа`;
  const seen = new Set<string>();
  for (const link of links) {
    if (!(LINK_ENTITY_TYPES as readonly string[]).includes(link.entity_type)) return "Недопустимый тип связанного объекта";
    if (!isUuid(link.entity_id)) return "Некорректный связанный объект";
    if (!(LINK_ROLES as readonly string[]).includes(link.link_role)) return "Некорректное назначение связи";
    const key = `${link.entity_type}:${link.entity_id.toLowerCase()}`;
    if (seen.has(key)) return "Один и тот же объект указан дважды";
    seen.add(key);
  }
  return null;
}

// Parses "entity_type:uuid" values produced by the object selectors in the forms.
export function parseLinkValue(value: string, linkRole: DocumentLinkInput["link_role"] = "related"): DocumentLinkInput | null {
  const separator = value.indexOf(":");
  if (separator <= 0) return null;
  const entityType = value.slice(0, separator);
  const entityId = value.slice(separator + 1);
  if (!(LINK_ENTITY_TYPES as readonly string[]).includes(entityType) || !isUuid(entityId)) return null;
  return { entity_type: entityType as LinkEntityType, entity_id: entityId.toLowerCase(), link_role: linkRole };
}
