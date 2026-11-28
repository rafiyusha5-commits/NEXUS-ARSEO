// Read-only reports of Nexus for the assistant (2026-11-21): the same database functions the screens use — price
// list, customer conditions and margins, payables, payment calendar, receivables, profitability, document check, daily
// summary, shelf life risks. Each function checks the employee's permissions itself; the report list, function names and argument
// names are fixed here and never come from the model. The result is flattened into rows of label–value text.
import { maskDataText, maskOutgoing } from "./masking.ts";
import type { AgentTool, ParamSchema, ShipmentRow, ToolField, ToolRow } from "./types.ts";

type Params = Record<string, string | number>;
export type ReportDefinition = {
  key: string;
  title: string;
  rpc: string;
  permissions: string[];
  anyPermissions: string[];
  /** Function arguments from the tool parameters; null when a required parameter is missing. */
  args: (params: Params) => Record<string, string | number | null> | null;
  needs: string;
};

const id = (params: Params, name: string) => typeof params[name] === "string" ? String(params[name]) : null;
const date = (params: Params, name: string) => typeof params[name] === "string" ? String(params[name]) : null;
const required = (values: Record<string, string | number | null>, keys: string[]) => keys.every(key => values[key] !== null) ? values : null;

export const REPORTS: readonly ReportDefinition[] = [
  { key: "price_list", title: "Прайс: действующие цены по видам цен", rpc: "price_list", permissions: ["sales.view", "products.view"], anyPermissions: [],
    args: p => ({ p_date: date(p, "date") }), needs: "date — на дату (по умолчанию сегодня); query — артикул, название или бренд" },
  { key: "price_history", title: "История цен товара в прайсе", rpc: "price_list_history", permissions: ["sales.view", "products.view"], anyPermissions: [],
    args: p => required({ p_product_id: id(p, "product_id") }, ["p_product_id"]), needs: "product_id" },
  { key: "brands", title: "Бренды прайса и товары с брендом вне справочника", rpc: "brand_overview", permissions: ["sales.view", "products.view"], anyPermissions: [],
    args: () => ({}), needs: "—" },
  { key: "vat_rates", title: "Ставки НДС по странам", rpc: "vat_rate_history", permissions: ["sales.view", "products.view"], anyPermissions: [],
    args: () => ({}), needs: "—" },
  { key: "batch_margins", title: "Маржа партий товара по видам цен", rpc: "price_list_batch_margins", permissions: ["prices.purchase.view", "inventory.view"], anyPermissions: [],
    args: p => required({ p_product_id: id(p, "product_id"), p_date: date(p, "date") }, ["p_product_id"]), needs: "product_id; date" },
  { key: "customer_prices", title: "Условия цен клиента: вид цены, проценты по брендам, фиксированные цены", rpc: "customer_price_conditions", permissions: ["customers.view", "pricing.customer_terms.manage"], anyPermissions: [],
    args: p => required({ p_customer_id: id(p, "customer_id") }, ["p_customer_id"]), needs: "customer_id" },
  { key: "customer_margins", title: "Маржа клиента по товарам и партиям и его порог", rpc: "customer_margin_overview", permissions: ["customers.view", "pricing.customer_terms.manage", "prices.purchase.view", "inventory.view"], anyPermissions: [],
    args: p => required({ p_customer_id: id(p, "customer_id"), p_date: date(p, "date") }, ["p_customer_id"]), needs: "customer_id; date" },
  { key: "payables", title: "Кредиторская задолженность по получателям", rpc: "payables_summary", permissions: ["finance.view"], anyPermissions: [],
    args: () => ({}), needs: "query — получатель" },
  { key: "payables_payee", title: "Кредиторка получателя: расходы, оплаты, авансы, переплаты", rpc: "payables_payee", permissions: ["finance.view"], anyPermissions: [],
    args: p => required({ p_payee_id: id(p, "counterparty_id") }, ["p_payee_id"]), needs: "counterparty_id — получатель" },
  { key: "cash_calendar", title: "Платёжный календарь: остаток, поступления и выплаты по неделям, кассовый разрыв", rpc: "cash_calendar", permissions: ["finance.view"], anyPermissions: [],
    args: () => ({ p_step: "week", p_periods: 13 }), needs: "query — валюта" },
  { key: "receivables", title: "Дебиторская задолженность клиентов", rpc: "customer_receivables", permissions: ["receivables.view"], anyPermissions: [],
    args: () => ({}), needs: "query — клиент" },
  { key: "customer_statement", title: "Выписка клиента: отгрузки, оплаты, сальдо", rpc: "customer_statement", permissions: ["receivables.view"], anyPermissions: [],
    args: p => required({ p_customer_id: id(p, "customer_id") }, ["p_customer_id"]), needs: "customer_id" },
  { key: "credit_check", title: "Кредитная проверка заказа: лимит, просрочка, отсрочка", rpc: "customer_credit_check", permissions: ["sales.view"], anyPermissions: [],
    args: p => required({ p_sale_id: id(p, "sale_id") }, ["p_sale_id"]), needs: "sale_id" },
  { key: "profitability", title: "Прибыльность по поставкам, товарам или клиентам", rpc: "profitability_report", permissions: ["prices.purchase.view", "reports.view"], anyPermissions: [],
    args: p => required({ p_group: typeof p.group === "string" ? p.group : null, p_from: date(p, "date"), p_to: date(p, "date_to") }, ["p_group", "p_from", "p_to"]), needs: "group (shipment, product, customer); date и date_to — период" },
  { key: "profitability_lines", title: "Прибыльность: строки отгрузок за период", rpc: "profitability_lines", permissions: ["prices.purchase.view", "reports.view"], anyPermissions: [],
    args: p => required({ p_from: date(p, "date"), p_to: date(p, "date_to") }, ["p_from", "p_to"]), needs: "date и date_to — период; query — товар, клиент или поставка" },
  { key: "document_check", title: "Сверка документов поставки: замечания по машинам и документам", rpc: "shipment_document_check", permissions: ["documents.view", "shipments.view"], anyPermissions: [],
    args: p => required({ p_shipment_id: id(p, "shipment_id") }, ["p_shipment_id"]), needs: "shipment_id" },
  { key: "daily_summary", title: "Сводка дня: поставки, заказы, склад, задачи", rpc: "operational_summary", permissions: [], anyPermissions: ["shipments.view", "sales.view", "inventory.view", "tasks.view", "reports.view"],
    args: () => ({}), needs: "—" },
  { key: "losses", title: "Потери товара за период: списания, недостачи, списанные возвраты", rpc: "loss_report", permissions: ["reports.view", "inventory.view"], anyPermissions: [],
    args: p => required({ p_group: typeof p.group === "string" ? p.group : null, p_from: date(p, "date"), p_to: date(p, "date_to") }, ["p_group", "p_from", "p_to"]),
    needs: "group (reason, product, brand, warehouse, shipment, month); date и date_to — период" },
  { key: "loss_risk", title: "Товар под риском по сроку годности в деньгах", rpc: "loss_risk", permissions: ["reports.view", "inventory.view"], anyPermissions: [],
    args: p => ({ p_group: typeof p.group === "string" ? p.group : "bucket" }), needs: "group (bucket, warehouse, brand, supplier), по умолчанию bucket" },
  { key: "shelf_life_risks", title: "Сроки годности под риском", rpc: "shelf_life_risks", permissions: ["inventory.view", "products.view"], anyPermissions: [],
    args: p => ({ p_horizon_days: typeof p.days === "number" ? p.days : 30 }), needs: "days — горизонт в днях (по умолчанию 30)" },
];
export const REPORT_BY_KEY: ReadonlyMap<string, ReportDefinition> = new Map(REPORTS.map(report => [report.key, report]));
export const REPORT_RPCS: ReadonlySet<string> = new Set(REPORTS.map(report => report.rpc));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_KEY = /password|token|secret|passport|driver_document|iin|storage_path|checksum|sha256|account/i;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function text(value: unknown, depth = 0): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 6 }).format(value) : null;
  if (typeof value === "boolean") return value ? "да" : "нет";
  if (typeof value === "string") return UUID.test(value) ? null : maskDataText(value, 300);
  if (Array.isArray(value)) {
    if (value.every(item => !record(item) && !Array.isArray(item))) return maskDataText(value.map(item => text(item, depth + 1)).filter(Boolean).join(", "), 300) || null;
    return depth < 1 ? `${value.length} записей` : null;
  }
  if (record(value)) {
    if (typeof value.ru === "string") return maskDataText(value.ru, 300);
    if (depth >= 2) return null;
    const parts = Object.entries(value).filter(([key]) => !SECRET_KEY.test(key)).map(([key, item]) => {
      const shown = text(item, depth + 1); return shown === null ? null : `${key}: ${shown}`;
    }).filter(Boolean);
    return parts.length ? parts.join("; ") : null;
  }
  return null;
}

type Flat = { part: string; fields: [string, unknown][]; references: Record<string, string> };

/** Arrays of objects become rows (one level of nesting); the scalar fields of the top object become a summary row. */
export function flattenReport(value: unknown): Flat[] {
  const rows: Flat[] = [];
  const rowOf = (part: string, item: Record<string, unknown>): Flat => {
    const references: Record<string, string> = {};
    const fields: [string, unknown][] = [];
    for (const [key, item2] of Object.entries(item)) {
      if (SECRET_KEY.test(key)) continue;
      if (typeof item2 === "string" && UUID.test(item2)) { if (key === "id" || key.endsWith("_id")) references[key] = item2; continue; }
      fields.push([key, item2]);
    }
    return { part, fields, references };
  };
  const walk = (node: unknown, part: string, depth: number) => {
    if (Array.isArray(node)) {
      for (const item of node) if (record(item)) rows.push(rowOf(part, item));
      return;
    }
    if (!record(node)) return;
    const scalars: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node)) {
      if (Array.isArray(item) && item.some(record) && depth < 2) walk(item, part ? `${part}.${key}` : key, depth + 1);
      else if (record(item) && Object.values(item).some(child => Array.isArray(child) && child.some(record)) && depth < 2) walk(item, part ? `${part}.${key}` : key, depth + 1);
      else scalars[key] = item;
    }
    if (Object.keys(scalars).length) rows.unshift(rowOf(part || "итог", scalars));
  };
  walk(value, "", 0);
  return rows;
}

function details(row: Flat): string {
  const lines = row.fields.map(([key, value]) => { const shown = text(value); return shown === null ? null : `${key}: ${shown}`; }).filter(Boolean);
  return maskOutgoing(lines.join("\n")) || "Значения не заполнены.";
}

const FIELDS: ToolField[] = [{ key: "report_part", label: "Часть отчёта", kind: "text" }, { key: "record_details", label: "Данные Nexus", kind: "text" }];
const params: Record<string, ParamSchema> = {
  report: { type: "enum", values: REPORTS.map(report => report.key), description: "Отчёт Nexus; выбирай только доступный" },
  product_id: { type: "uuid", optional: true, description: "Товар (из поиска search_system products)" },
  customer_id: { type: "uuid", optional: true, description: "Клиент (counterparties)" },
  counterparty_id: { type: "uuid", optional: true, description: "Получатель платежей для payables_payee" },
  sale_id: { type: "uuid", optional: true, description: "Заказ покупателя" },
  shipment_id: { type: "uuid", optional: true, description: "Поставка" },
  group: { type: "enum", values: ["shipment", "product", "customer", "reason", "brand", "warehouse", "month", "bucket", "supplier"], optional: true,
    description: "Разрез отчёта: прибыльность — shipment, product, customer; потери — reason, product, brand, warehouse, shipment, month; товар под риском — bucket, warehouse, brand, supplier" },
  date: { type: "date", optional: true, description: "Дата или начало периода YYYY-MM-DD" },
  date_to: { type: "date", optional: true, description: "Конец периода включительно YYYY-MM-DD" },
  days: { type: "integer", min: 1, max: 365, optional: true, description: "Горизонт в днях для shelf_life_risks" },
  query: { type: "string", maxLength: 60, pattern: /^[\p{L}\p{N} _.\-/№]+$/u, optional: true, description: "Отбор строк отчёта по тексту: артикул, название, клиент, получатель" },
  offset: { type: "integer", min: 0, max: 10000, optional: true, description: "Начало страницы, по умолчанию 0" },
  limit: { type: "integer", min: 1, max: 20, optional: true, description: "Размер страницы, не больше 20" },
};

const getReport: AgentTool = {
  name: "get_report",
  description: `Готовые отчёты Nexus — те же, что на экранах, с правами сотрудника. ${REPORTS.map(report => `${report.key}: ${report.title} (${report.needs})`).join("; ")}. Нужные UUID сначала найди через search_system. Ничего не изменяет.`,
  permissions: [],
  scope: { param: "report", sections: REPORTS },
  params,
  fields: FIELDS,
  maxRows: 20,
  timeoutMs: 10000,
  async run(ctx, input) {
    const report = REPORT_BY_KEY.get(String(input.report));
    if (!report || !ctx.data.readReport) return { rows: [], total: 0, truncated: false, notes: ["Отчёт недоступен."] };
    const args = report.args(input);
    if (!args) return { rows: [], total: 0, truncated: false, notes: [`Для отчёта «${report.title}» нужно: ${report.needs}.`] };
    const value = await ctx.data.readReport(report.rpc, args, ctx.signal);
    const term = typeof input.query === "string" ? input.query.toLowerCase() : "";
    const all = flattenReport(value).filter(row => row.fields.some(([, field]) => text(field) !== null))
      .map(row => ({ row, text: details(row) }))
      .filter(item => !term || item.text.toLowerCase().includes(term) || item.row.part === "итог");
    const offset = Number(input.offset ?? 0), limit = Number(input.limit ?? 20);
    const shown: ToolRow[] = all.slice(offset, offset + limit).map(({ row, text: body }) => ({
      subject: `${report.title} · ${row.part}`.slice(0, 200),
      values: { report_part: row.part, record_details: body },
      references: row.references,
    }));
    return { rows: shown, total: all.length, truncated: all.length > offset + shown.length || offset > 0,
      notes: [`Источник: ${report.title}. Отчёт построен функцией Nexus с текущими правами сотрудника.`] };
  },
};

export const REPORT_TOOLS: readonly AgentTool[] = [getReport];
export type ReportRow = ShipmentRow;
