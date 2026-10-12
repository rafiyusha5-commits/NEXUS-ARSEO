// Agent «Контроль ОСГ»: the forecast is calculated in the database
// (supabase/migrations/202609276500_shelf_life_control_agent.sql); this module reads the answer and
// prepares the texts of the «Сроки годности под риском» screen. It decides nothing on its own.

export type RiskState = "expired" | "below" | "soon";
export type CustomerState = "below" | "soon" | "ok";
export type RequirementSource = "contract_product" | "contract" | "client" | "default";

export type RiskCustomer = {
  customerId?: string;
  customerName?: string;
  requiredPct: number;
  source: RequirementSource;
  lastOkDay: string | null;
  state: CustomerState;
  guaranteeLetter: boolean;
};

export type RiskBatch = {
  batchId: string;
  batchNumber: string;
  productId: string;
  sku: string;
  productName: string;
  expiryDate: string;
  manufactureDate: string | null;
  remainingPct: number | null;
  quantities: Array<{ uom: string; quantity: number }>;
  warehouses: string | null;
  state: RiskState;
  firstDeadline: string | null;
  customers: RiskCustomer[];
};

export type ShelfLifeRisks = { today: string | null; horizonDays: number; items: RiskBatch[]; unknownCount: number };

/** Mirrors private.shelf_life_default_pct(): the requirement when nothing else is known. */
export const DEFAULT_REQUIRED_PCT = 70;
export const DEFAULT_HORIZON_DAYS = 30;
export const HORIZON_OPTIONS = [7, 14, 30, 60, 90] as const;

export const RISK_STATE_LABEL: Record<RiskState, string> = {
  expired: "Срок годности истёк",
  below: "Уже ниже требований",
  soon: "Скоро ниже требований",
};
export const CUSTOMER_STATE_LABEL: Record<CustomerState, string> = { below: "ниже требования", soon: "успеть отгрузить", ok: "с запасом" };
export const SOURCE_LABEL: Record<RequirementSource, string> = {
  contract_product: "договор, по этому товару",
  contract: "договор",
  client: "карточка клиента",
  default: "по умолчанию",
};
const UOM: Record<string, string> = { piece: "шт.", box: "кор.", layer: "слой", pallet: "пал.", truck: "фура" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const date = (value: unknown) => (typeof value === "string" && DATE.test(value) ? value : null);
const num = (value: unknown) => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]) => (allowed as readonly unknown[]).includes(value) ? (value as T) : undefined;

/** Reads the RPC answer defensively: malformed rows are dropped, not shown half-way. */
export function parseShelfLifeRisks(raw: unknown): ShelfLifeRisks {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const items: RiskBatch[] = [];
  for (const item of Array.isArray(source.items) ? source.items : []) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const batchId = text(row.batch_id), productId = text(row.product_id), batchNumber = text(row.batch_number), expiryDate = date(row.expiry_date);
    const state = oneOf(row.state, ["expired", "below", "soon"] as const);
    if (!batchId || !UUID.test(batchId) || !productId || !UUID.test(productId) || !batchNumber || !expiryDate || !state) continue;
    items.push({
      batchId, productId, batchNumber, expiryDate, state,
      sku: text(row.internal_sku) ?? "—",
      productName: text(row.product_name) ?? text(row.internal_sku) ?? "Товар",
      manufactureDate: date(row.manufacture_date),
      remainingPct: num(row.remaining_pct),
      quantities: (Array.isArray(row.quantities) ? row.quantities : []).flatMap((entry) => {
        const q = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
        const quantity = num(q.quantity), uom = text(q.uom);
        return quantity !== null && uom ? [{ uom, quantity }] : [];
      }),
      warehouses: text(row.warehouses) ?? null,
      firstDeadline: date(row.first_deadline),
      customers: parseCustomers(row.customers),
    });
  }
  const horizon = num(source.horizon_days);
  return { today: date(source.today), horizonDays: horizon && horizon > 0 ? horizon : DEFAULT_HORIZON_DAYS, items, unknownCount: Math.max(0, num(source.unknown_count) ?? 0) };
}

function parseCustomers(raw: unknown): RiskCustomer[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const requiredPct = num(row.required_pct);
    const source = oneOf(row.source, ["contract_product", "contract", "client", "default"] as const);
    const state = oneOf(row.state, ["below", "soon", "ok"] as const);
    if (requiredPct === null || !source || !state) return [];
    const customerId = text(row.customer_id);
    return [{
      customerId: customerId && UUID.test(customerId) ? customerId : undefined,
      customerName: text(row.customer_name),
      requiredPct, source, state,
      lastOkDay: date(row.last_ok_day),
      guaranteeLetter: row.guarantee_letter === true,
    }];
  });
}

export function formatIsoDate(value: string | null) {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  return match ? `${match[3]}.${match[2]}.${match[1]}` : "—";
}

export function formatQuantities(quantities: RiskBatch["quantities"]) {
  return quantities.length ? quantities.map((q) => `${q.quantity.toLocaleString("ru-RU", { maximumFractionDigits: 3 })} ${UOM[q.uom] ?? q.uom}`).join(", ") : "—";
}

export function formatPct(value: number | null) {
  return value === null ? "—" : `${value.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} %`;
}

/** «Клиент 1 — требование 30 % (карточка клиента)», or «Любой клиент» for the default without customers. */
export function describeRequirement(customer: RiskCustomer) {
  return `${customer.customerName ?? "Любой клиент"} — требование ${formatPct(customer.requiredPct)} (${SOURCE_LABEL[customer.source]})`;
}

/** What the employee can do for one customer. */
export function customerAdvice(customer: RiskCustomer, expired: boolean) {
  if (expired) return "Срок годности истёк: продажа невозможна, решите вопрос списания или возврата.";
  if (customer.state === "below") {
    return customer.guaranteeLetter
      ? `Требование не выполняется с ${formatIsoDate(nextDay(customer.lastOkDay))}. Продажа возможна только с гарантийным письмом клиента.`
      : "Требование не выполняется.";
  }
  return `Отгрузить до ${formatIsoDate(customer.lastOkDay)} включительно.`;
}

function nextDay(value: string | null) {
  if (!value || !DATE.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

export function summarizeRisks(items: RiskBatch[]) {
  return {
    total: items.length,
    expired: items.filter((item) => item.state === "expired").length,
    below: items.filter((item) => item.state === "below").length,
    soon: items.filter((item) => item.state === "soon").length,
  };
}

export function parseHorizon(value: string | undefined) {
  const parsed = Number(value);
  return (HORIZON_OPTIONS as readonly number[]).includes(parsed) ? parsed : DEFAULT_HORIZON_DAYS;
}
