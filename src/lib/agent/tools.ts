// Read-only assistant tools. Each tool declares its permissions, strict parameters, output fields,
// row limit and timeout. Rows are projected through the field allow-list and masked here, so a data
// source that returns more columns still cannot leak them. There are no write tools.
import { HELP_TEXT, HELP_TOPICS, type HelpTopic } from "./help.ts";
import {
  documentStatusLabel, extractionStatusLabel, label, shelfLifeLabel, shipmentStatusLabel, shipmentTypeLabel,
  stageStatusLabel, taskPriorityLabel, taskStatusLabel, vehicleStatusLabel,
} from "./labels.ts";
import { maskDataText, maskSensitive } from "./masking.ts";
import { AGENT_TIME_ZONE } from "./time.ts";
import type { AgentTool, EntityRef, ShipmentRow, ToolField, ToolResult, ToolRow } from "./types.ts";

export const MAX_TOOL_ROWS = 20;
const DEFAULT_TIMEOUT_MS = 8000;
const SEARCH_TEXT = /^[\p{L}\p{N} _.\-/№]+$/u;
const SHIPMENT_STATUSES = Object.keys(shipmentStatusLabel);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Today's date in the assistant time zone (Asia/Aqtobe, UTC+5) as YYYY-MM-DD. */
export function localDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: AGENT_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

function str(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoDate(value: unknown): string | null {
  const text = str(value);
  return text && /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
}

function isoDateTime(value: unknown): string | null {
  const text = str(value);
  return text && !Number.isNaN(Date.parse(text)) ? new Date(text).toISOString() : null;
}

function localized(value: unknown): string | null {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return str(record.ru ?? record.en ?? record.kk);
  }
  return str(value);
}

function uuidRef(type: EntityRef["type"], id: unknown): EntityRef | undefined {
  return typeof id === "string" && UUID.test(id) ? { type, id } : undefined;
}

/** Keeps only declared fields; anything else the source returned is dropped. */
function project(subject: string, fields: readonly ToolField[], values: Record<string, string | number | null>, entity?: EntityRef): ToolRow {
  const kept: Record<string, string | number | null> = {};
  for (const field of fields) if (field.key in values && values[field.key] !== null && values[field.key] !== undefined) kept[field.key] = values[field.key];
  // Parts of the subject come from values already masked by the caller; mask again for secrets.
  const safeSubject = maskSensitive(subject).text.slice(0, 160);
  return entity ? { subject: safeSubject, values: kept, entity } : { subject: safeSubject, values: kept };
}

function shipmentSubject(number: unknown): string {
  return `Поставка ${str(number) ?? "без номера"}`;
}

function result(rows: ToolRow[], truncated: boolean, total: number | null, notes: string[] = []): ToolResult {
  return { rows, truncated, total, notes };
}

function limitParam(defaultHint: string) {
  return { type: "integer" as const, min: 1, max: MAX_TOOL_ROWS, optional: true, description: `Сколько записей вернуть, не больше ${MAX_TOOL_ROWS} (${defaultHint})` };
}

const SHIPMENT_FIELDS: ToolField[] = [
  { key: "shipment_number", label: "Номер поставки", kind: "id" },
  { key: "project_code", label: "Проект", kind: "id" },
  { key: "shipment_type", label: "Тип", kind: "status" },
  { key: "shipment_status", label: "Статус поставки", kind: "status" },
  { key: "planned_ready_date", label: "Плановая готовность", kind: "date" },
  { key: "planned_arrival_date", label: "Плановое прибытие", kind: "date" },
  { key: "supplier", label: "Поставщик", kind: "text" },
  { key: "customer", label: "Клиент", kind: "text" },
];

function shipmentValues(row: ShipmentRow) {
  return {
    shipment_number: str(row.shipment_number),
    project_code: maskDataText(str(row.project_code), 60),
    shipment_type: label(shipmentTypeLabel, row.type),
    shipment_status: label(shipmentStatusLabel, row.status),
    planned_ready_date: isoDate(row.planned_ready_date),
    planned_arrival_date: isoDate(row.planned_arrival_date),
    supplier: maskDataText(str(row.supplier_name), 120),
    customer: maskDataText(str(row.customer_name), 120),
  };
}

const findShipments: AgentTool = {
  name: "find_shipments",
  description: "Найти поставки по номеру или коду проекта, статусу и типу. Возвращает не больше 20 записей.",
  permissions: ["shipments.view"],
  params: {
    query: { type: "string", maxLength: 60, pattern: SEARCH_TEXT, optional: true, description: "Часть номера поставки или кода проекта" },
    status: { type: "enum", values: SHIPMENT_STATUSES, optional: true, description: "Статус поставки" },
    type: { type: "enum", values: ["import", "export", "domestic_transfer"], optional: true, description: "Тип поставки" },
    limit: limitParam("по умолчанию 10"),
  },
  fields: SHIPMENT_FIELDS,
  maxRows: MAX_TOOL_ROWS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  async run(ctx, params) {
    const limit = Number(params.limit ?? 10);
    const { rows, total } = await ctx.data.findShipments({ query: params.query as string | undefined, status: params.status as string | undefined, type: params.type as string | undefined, limit }, ctx.signal);
    const shown = rows.slice(0, limit);
    return result(shown.map((row) => project(shipmentSubject(row.shipment_number), SHIPMENT_FIELDS, shipmentValues(row), uuidRef("shipment", row.id))), rows.length > limit || (total !== null && total > shown.length), total);
  },
};

const SHIPMENT_CARD_FIELDS: ToolField[] = [
  ...SHIPMENT_FIELDS,
  { key: "route", label: "Маршрут", kind: "text" },
  { key: "responsible", label: "Ответственный", kind: "text" },
  { key: "hold_reason", label: "Причина приостановки", kind: "text" },
  { key: "cancel_reason", label: "Причина отмены", kind: "text" },
  { key: "stages_total", label: "Этапов всего", kind: "count" },
  { key: "stages_completed", label: "Этапов завершено", kind: "count" },
  { key: "item_lines_total", label: "Товарных строк всего", kind: "count" },
  { key: "sku_count", label: "Уникальных SKU", kind: "count" },
  { key: "stage_name", label: "Этап", kind: "text" },
  { key: "stage_status", label: "Статус этапа", kind: "status" },
  { key: "stage_reason", label: "Причина по этапу", kind: "text" },
  { key: "product_sku", label: "Артикул", kind: "id" },
  { key: "product_name", label: "Товар", kind: "text" },
  { key: "uom", label: "Единица", kind: "text" },
  { key: "ordered_quantity", label: "Заказано", kind: "number" },
  { key: "confirmed_quantity", label: "Подтверждено", kind: "number" },
  { key: "shipped_quantity", label: "Отгружено", kind: "number" },
  { key: "received_quantity", label: "Принято", kind: "number" },
];

const getShipment: AgentTool = {
  name: "get_shipment",
  description: "Карточка одной поставки: статус, даты, этапы (текущие и заблокированные), товары с количествами. Закупочные цены не возвращаются.",
  permissions: ["shipments.view"],
  params: { shipment_id: { type: "uuid", description: "Идентификатор поставки из find_shipments" } },
  fields: SHIPMENT_CARD_FIELDS,
  maxRows: MAX_TOOL_ROWS + 12,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  async run(ctx, params) {
    const id = String(params.shipment_id);
    const shipment = await ctx.data.getShipment(id, ctx.signal);
    if (!shipment) return result([], false, 0, ["Поставка не найдена или недоступна по вашим правам."]);
    const [stages, items] = await Promise.all([ctx.data.getShipmentStages(id, ctx.signal), ctx.data.getShipmentItems(id, MAX_TOOL_ROWS, ctx.signal)]);
    const entity = uuidRef("shipment", shipment.id);
    const subject = shipmentSubject(shipment.shipment_number);
    const allItemsLoaded = items.total !== null && items.total === items.rows.length;
    const skus = items.rows.map((item) => str(item.internal_sku)?.trim() || null);
    const skuCount = allItemsLoaded && skus.every((sku) => sku !== null) ? new Set(skus).size : null;
    const card = project(subject, SHIPMENT_CARD_FIELDS, {
      ...shipmentValues(shipment),
      route: maskDataText(localized(shipment.route_name), 120),
      responsible: maskDataText(str(shipment.responsible_name), 120),
      hold_reason: shipment.status === "on_hold" ? maskDataText(str(shipment.hold_reason)) : null,
      cancel_reason: shipment.status === "cancelled" ? maskDataText(str(shipment.cancel_reason)) : null,
      stages_total: stages.length,
      stages_completed: stages.filter((stage) => stage.status === "completed").length,
      item_lines_total: items.total,
      sku_count: skuCount,
    }, entity);
    const activeStages = stages.filter((stage) => stage.status === "in_progress" || stage.status === "blocked").slice(0, 10).map((stage) => project(`${subject} · этап «${maskDataText(localized(stage.stage_name), 80) ?? "без названия"}»`, SHIPMENT_CARD_FIELDS, {
      stage_name: maskDataText(localized(stage.stage_name), 120),
      stage_status: label(stageStatusLabel, stage.status),
      stage_reason: stage.status === "blocked" ? maskDataText(str(stage.status_reason)) : null,
    }, entity));
    const itemRows = items.rows.slice(0, MAX_TOOL_ROWS).map((item) => project(`${subject} · товар ${str(item.internal_sku) ?? "без артикула"}`, SHIPMENT_CARD_FIELDS, {
      product_sku: str(item.internal_sku),
      product_name: maskDataText(localized(item.product_name), 120),
      uom: str(item.uom),
      ordered_quantity: num(item.ordered_quantity),
      confirmed_quantity: num(item.confirmed_quantity),
      shipped_quantity: num(item.shipped_quantity),
      received_quantity: num(item.received_quantity),
    }, entity));
    const itemsTruncated = items.rows.length > MAX_TOOL_ROWS || (items.total !== null && items.total > itemRows.length);
    const notes = ["Закупочные цены и суммы в ответ ассистента не передаются."];
    if (itemsTruncated) notes.push(`Товаров в поставке больше, чем показано (${itemRows.length}).`);
    if (skuCount === null) notes.push("Точное количество уникальных SKU не определено: список товаров неполный или есть товар без артикула.");
    return result([card, ...activeStages, ...itemRows], itemsTruncated, null, notes);
  },
};

const VEHICLE_FIELDS: ToolField[] = [
  { key: "sequence_no", label: "Автомобиль №", kind: "number" },
  { key: "vehicle_status", label: "Статус автомобиля", kind: "status" },
  { key: "vehicle_plate", label: "Госномер", kind: "id" },
  { key: "vehicle_make", label: "Марка", kind: "text" },
  { key: "trailer_plate", label: "Прицеп", kind: "id" },
  { key: "trailer_make", label: "Марка прицепа", kind: "text" },
  { key: "carrier_name", label: "Перевозчик", kind: "text" },
  { key: "planned_loading_date", label: "Плановая загрузка", kind: "date" },
  { key: "actual_loading_date", label: "Фактическая загрузка", kind: "date" },
  { key: "planned_arrival_date", label: "Плановое прибытие", kind: "date" },
  { key: "actual_arrival_date", label: "Фактическое прибытие", kind: "date" },
  { key: "temperature_setpoint", label: "Температурный режим", kind: "text" },
];

const getShipmentVehicles: AgentTool = {
  name: "get_shipment_vehicles",
  description: "Автомобили поставки: статус, госномера, перевозчик, плановые и фактические даты. Данные водителя не возвращаются.",
  permissions: ["shipments.view"],
  params: { shipment_id: { type: "uuid", description: "Идентификатор поставки" } },
  fields: VEHICLE_FIELDS,
  maxRows: MAX_TOOL_ROWS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  async run(ctx, params) {
    const id = String(params.shipment_id);
    const vehicles = await ctx.data.getShipmentVehicles(id, ctx.signal);
    const rows = vehicles.slice(0, MAX_TOOL_ROWS).map((vehicle) => project(`${shipmentSubject(vehicle.shipment_number)} · автомобиль № ${num(vehicle.sequence_no) ?? "?"}`, VEHICLE_FIELDS, {
      sequence_no: num(vehicle.sequence_no),
      vehicle_status: label(vehicleStatusLabel, vehicle.status),
      vehicle_plate: maskDataText(str(vehicle.vehicle_plate), 40),
      vehicle_make: maskDataText(str(vehicle.vehicle_make), 80),
      trailer_plate: maskDataText(str(vehicle.trailer_plate), 40),
      trailer_make: maskDataText(str(vehicle.trailer_make), 80),
      carrier_name: maskDataText(str(vehicle.carrier_name), 120),
      planned_loading_date: isoDate(vehicle.planned_loading_date),
      actual_loading_date: isoDate(vehicle.actual_loading_date),
      planned_arrival_date: isoDate(vehicle.planned_arrival_date),
      actual_arrival_date: isoDate(vehicle.actual_arrival_date),
      temperature_setpoint: maskDataText(str(vehicle.temperature_setpoint), 40),
    }, uuidRef("shipment", id)));
    return result(rows, vehicles.length > MAX_TOOL_ROWS, vehicles.length, ["ФИО, телефон и документ водителя ассистенту не передаются."]);
  },
};

const PERSONAL_DOCUMENT_TYPES = new Set(["driver_document", "vehicle_document"]);
const DOCUMENT_FIELDS: ToolField[] = [
  { key: "document_type", label: "Тип документа", kind: "text" },
  { key: "document_title", label: "Название", kind: "text" },
  { key: "document_number", label: "Номер документа", kind: "id" },
  { key: "document_status", label: "Статус документа", kind: "status" },
  { key: "document_date", label: "Дата документа", kind: "date" },
  { key: "valid_until", label: "Действует до", kind: "date" },
  { key: "attached_to", label: "Относится к", kind: "text" },
  { key: "missing_document_type", label: "Отсутствует обязательный документ", kind: "text" },
];

const getShipmentDocuments: AgentTool = {
  name: "get_shipment_documents",
  description: "Документы поставки и её автомобилей (тип, номер, статус, даты) и отсутствующие обязательные документы. Содержимое файлов и суммы не возвращаются.",
  permissions: ["shipments.view", "documents.view"],
  params: { shipment_id: { type: "uuid", description: "Идентификатор поставки" } },
  fields: DOCUMENT_FIELDS,
  maxRows: MAX_TOOL_ROWS * 2,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  async run(ctx, params) {
    const { documents, missingTypes } = await ctx.data.getShipmentDocuments(String(params.shipment_id), ctx.signal);
    const shown = documents.slice(0, MAX_TOOL_ROWS).map((document) => {
      const personal = PERSONAL_DOCUMENT_TYPES.has(String(document.type_code));
      const docSubject = personal
        ? `${str(document.type_name) ?? "Документ"} (документ водителя или автомобиля)`
        : `${str(document.type_name) ?? "Документ"}${str(document.document_number) ? ` № ${maskDataText(str(document.document_number), 60)}` : ""}`;
      return project(docSubject, DOCUMENT_FIELDS, {
        document_type: str(document.type_name),
        document_title: personal ? "[скрыто: документ водителя или автомобиля]" : maskDataText(str(document.title), 120),
        document_number: personal ? null : maskDataText(str(document.document_number), 60),
        document_status: label(documentStatusLabel, document.status),
        document_date: isoDate(document.document_date),
        valid_until: isoDate(document.valid_until),
        attached_to: document.vehicle_sequence_no ? `Автомобиль ${document.vehicle_sequence_no}` : "Поставка",
      }, uuidRef("document", document.id));
    });
    const missing = missingTypes.slice(0, MAX_TOOL_ROWS).map((type) => project(`Отсутствует обязательный документ: ${str(type.type_name) ?? "тип не указан"}`, DOCUMENT_FIELDS, { missing_document_type: str(type.type_name) }));
    const notes = ["Содержимое файлов, суммы документов и данные водителей ассистенту не передаются."];
    if (!missingTypes.length) notes.push("Отсутствующих обязательных документов по правилам процесса не найдено.");
    return result([...shown, ...missing], documents.length > MAX_TOOL_ROWS, documents.length, notes);
  },
};

/** Structured extraction fields that may reach the model: logistics only, no prices or personal data. */
export const EXTRACTION_ALLOWED_FIELDS: Record<string, { label: string; kind: "id" | "text" | "date" | "number" }> = {
  order_number: { label: "Номер заказа", kind: "id" },
  invoice_number: { label: "Номер инвойса", kind: "id" },
  contract_number: { label: "Номер договора", kind: "id" },
  cmr_number: { label: "Номер CMR", kind: "id" },
  ttn_number: { label: "Номер ТТН", kind: "id" },
  packing_list_number: { label: "Номер упаковочного листа", kind: "id" },
  waybill_number: { label: "Номер накладной", kind: "id" },
  esf_number: { label: "Номер ЭСФ", kind: "id" },
  order_date: { label: "Дата заказа", kind: "date" },
  shipping_date: { label: "Дата отгрузки", kind: "date" },
  invoice_date: { label: "Дата инвойса", kind: "date" },
  contract_date: { label: "Дата договора", kind: "date" },
  vehicle_plate: { label: "Госномер", kind: "id" },
  vehicle_make: { label: "Марка автомобиля", kind: "text" },
  trailer_plate: { label: "Прицеп", kind: "id" },
  trailer_make: { label: "Марка прицепа", kind: "text" },
  carrier_name: { label: "Перевозчик", kind: "text" },
  seals: { label: "Пломбы", kind: "text" },
  temperature_setpoint: { label: "Температурный режим", kind: "text" },
  pallet_count: { label: "Паллет", kind: "number" },
  gross_weight_kg: { label: "Вес брутто, кг", kind: "number" },
  net_weight_kg: { label: "Вес нетто, кг", kind: "number" },
  incoterms: { label: "Incoterms", kind: "text" },
  loading_city: { label: "Город загрузки", kind: "text" },
  loading_country: { label: "Страна загрузки", kind: "text" },
  unloading_country: { label: "Страна выгрузки", kind: "text" },
  goods_category: { label: "Категория товара", kind: "text" },
};

const EXTRACTION_FIELDS: ToolField[] = [
  { key: "document_title", label: "Документ", kind: "text" },
  { key: "source_kind", label: "Вид источника", kind: "text" },
  { key: "extraction_status", label: "Статус распознавания", kind: "status" },
  { key: "extraction_method", label: "Способ", kind: "text" },
  { key: "data_state", label: "Данные", kind: "text" },
  { key: "conflict_fields", label: "Поля с расхождениями", kind: "text" },
  ...Object.entries(EXTRACTION_ALLOWED_FIELDS).map(([key, field]) => ({ key, label: field.label, kind: field.kind })),
];

const getDocumentExtraction: AgentTool = {
  name: "get_document_extraction",
  description: "Результаты распознавания документов поставки: статус и только разрешённые логистические поля (номера, даты, госномера, вес, паллеты). Цены, данные водителя, адреса, реквизиты и текст документа не возвращаются.",
  permissions: ["shipments.view", "documents.view"],
  params: {
    shipment_id: { type: "uuid", description: "Идентификатор поставки" },
    document_id: { type: "uuid", optional: true, description: "Только этот документ" },
    limit: { type: "integer", min: 1, max: 10, optional: true, description: "Сколько результатов вернуть, не больше 10" },
  },
  fields: EXTRACTION_FIELDS,
  maxRows: 10,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  async run(ctx, params) {
    const limit = Number(params.limit ?? 5);
    const { rows, total } = await ctx.data.getExtractions({ shipmentId: String(params.shipment_id), documentId: params.document_id as string | undefined, limit }, ctx.signal);
    const shown = rows.slice(0, limit).map((row) => {
      const confirmed = row.confirmed_data && typeof row.confirmed_data === "object" && Object.keys(row.confirmed_data).length > 0;
      const data = (confirmed ? row.confirmed_data : row.extracted_data) as Record<string, unknown> | null;
      const values: Record<string, string | number | null> = {
        document_title: PERSONAL_DOCUMENT_TYPES.has(String(row.source_kind)) || row.source_kind === "driver_document" ? "[скрыто: документ водителя или автомобиля]" : maskDataText(str(row.document_title), 120),
        source_kind: str(row.source_kind),
        extraction_status: label(extractionStatusLabel, row.status),
        extraction_method: row.extraction_method === "ocr" ? "OCR" : row.extraction_method ? "Текстовый слой" : null,
        data_state: confirmed ? "Подтверждено сотрудником" : "Предложение распознавания, не подтверждено",
        conflict_fields: Array.isArray(row.conflicts)
          ? (row.conflicts as Array<{ field?: unknown }>).map((conflict) => String(conflict?.field ?? "")).filter((field) => field in EXTRACTION_ALLOWED_FIELDS).map((field) => EXTRACTION_ALLOWED_FIELDS[field].label).join(", ") || null
          : null,
      };
      for (const [key, field] of Object.entries(EXTRACTION_ALLOWED_FIELDS)) {
        const raw = data?.[key];
        if (raw === null || raw === undefined || typeof raw === "object") continue;
        values[key] = field.kind === "number" ? num(raw) : field.kind === "date" ? isoDate(raw) ?? maskDataText(String(raw), 40) : maskDataText(String(raw), 120);
      }
      return project(`Распознавание: ${values.document_title ?? "документ"}`, EXTRACTION_FIELDS, values, uuidRef("document", row.document_id));
    });
    return result(shown, rows.length > limit || (total !== null && total > shown.length), total, [
      "Цены из ЭСФ, данные водителя, адреса, реквизиты и полный текст документа ассистенту не передаются.",
    ]);
  },
};

const DELAY_FIELDS: ToolField[] = [
  { key: "kind", label: "Объект", kind: "text" },
  { key: "shipment_number", label: "Номер поставки", kind: "id" },
  { key: "sequence_no", label: "Автомобиль №", kind: "number" },
  { key: "status", label: "Статус", kind: "status" },
  { key: "planned_arrival_date", label: "Плановое прибытие", kind: "date" },
  { key: "days_late", label: "Дней задержки", kind: "number" },
];

const listDelayedShipments: AgentTool = {
  name: "list_delayed_shipments",
  description: "Задержанные поставки и автомобили: плановая дата прибытия прошла, а поставка не закрыта или автомобиль не прибыл. Возвращает не больше 20 записей каждого вида.",
  permissions: ["shipments.view"],
  params: { limit: limitParam("по умолчанию 20") },
  fields: DELAY_FIELDS,
  maxRows: MAX_TOOL_ROWS * 2,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  async run(ctx, params) {
    const limit = Number(params.limit ?? MAX_TOOL_ROWS);
    const today = localDate(new Date());
    const data = await ctx.data.listDelayedShipments({ today, limit }, ctx.signal);
    const shipments = data.shipments.slice(0, limit).map((row) => project(shipmentSubject(row.shipment_number), DELAY_FIELDS, {
      kind: "Поставка",
      shipment_number: str(row.shipment_number),
      status: label(shipmentStatusLabel, row.status),
      planned_arrival_date: isoDate(row.planned_arrival_date),
      days_late: isoDate(row.planned_arrival_date) ? daysBetween(isoDate(row.planned_arrival_date)!, today) : null,
    }, uuidRef("shipment", row.id)));
    const vehicles = data.vehicles.slice(0, limit).map((row) => project(`${shipmentSubject(row.shipment_number)} · автомобиль № ${num(row.sequence_no) ?? "?"}`, DELAY_FIELDS, {
      kind: "Автомобиль",
      shipment_number: str(row.shipment_number),
      sequence_no: num(row.sequence_no),
      status: label(vehicleStatusLabel, row.status),
      planned_arrival_date: isoDate(row.planned_arrival_date),
      days_late: isoDate(row.planned_arrival_date) ? daysBetween(isoDate(row.planned_arrival_date)!, today) : null,
    }, uuidRef("shipment", row.shipment_id)));
    const truncated = (data.shipmentTotal ?? 0) > shipments.length || (data.vehicleTotal ?? 0) > vehicles.length;
    return result([...shipments, ...vehicles], truncated, (data.shipmentTotal ?? 0) + (data.vehicleTotal ?? 0), [
      `Задержка считается по плановой дате прибытия до ${today} (${AGENT_TIME_ZONE}): поставка не закрыта и не отменена, автомобиль не прибыл, не разгружен и не отменён.`,
      `Задержанных поставок всего: ${data.shipmentTotal ?? "неизвестно"}; автомобилей: ${data.vehicleTotal ?? "неизвестно"}.`,
    ]);
  },
};

const STOCK_FIELDS: ToolField[] = [
  { key: "internal_sku", label: "Артикул", kind: "id" },
  { key: "product_name", label: "Товар", kind: "text" },
  { key: "warehouse_code", label: "Склад", kind: "id" },
  { key: "uom", label: "Единица", kind: "text" },
  { key: "quantity_available", label: "Доступно", kind: "number" },
  { key: "quantity_on_hand", label: "На складе", kind: "number" },
  { key: "quantity_reserved", label: "В резерве", kind: "number" },
  { key: "nearest_expiry_date", label: "Ближайший срок годности", kind: "date" },
  { key: "worst_shelf_life_state", label: "Худшее состояние срока", kind: "status" },
  { key: "batch_count", label: "Партий", kind: "count" },
];

const SHELF_ORDER = ["expired", "blocked", "quarantine", "critical", "warning", "normal"];
export const STOCK_SOURCE_LIMIT = 200;

const getStockStatus: AgentTool = {
  name: "get_stock_status",
  description: "Остатки товаров по складам: доступно, на складе, резерв, ближайший срок годности. Минимальный остаток в Nexus не задан, поэтому инструмент не определяет нехватку.",
  permissions: ["inventory.view", "products.view", "warehouses.view"],
  params: {
    product_query: { type: "string", maxLength: 60, pattern: SEARCH_TEXT, optional: true, description: "Артикул, бренд или часть названия товара" },
    warehouse_code: { type: "string", maxLength: 20, pattern: /^[A-Z_]{2,20}$/, optional: true, description: "Код склада, например AKT" },
    limit: limitParam("по умолчанию 20"),
  },
  fields: STOCK_FIELDS,
  maxRows: MAX_TOOL_ROWS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  async run(ctx, params) {
    const limit = Number(params.limit ?? MAX_TOOL_ROWS);
    const { rows } = await ctx.data.getStock({ productQuery: params.product_query as string | undefined, warehouseCode: params.warehouse_code as string | undefined, limit: STOCK_SOURCE_LIMIT }, ctx.signal);
    const groups = new Map<string, { sku: string | null; name: string | null; warehouse: string | null; uom: string | null; available: number; onHand: number; reserved: number; expiry: string | null; state: string | null; batches: number }>();
    for (const row of rows) {
      const key = `${row.internal_sku}|${row.warehouse_code}|${row.uom}`;
      const group = groups.get(key) ?? { sku: str(row.internal_sku), name: localized(row.product_name), warehouse: str(row.warehouse_code), uom: str(row.uom), available: 0, onHand: 0, reserved: 0, expiry: null, state: null, batches: 0 };
      group.available += num(row.quantity_available) ?? 0;
      group.onHand += num(row.quantity_on_hand) ?? 0;
      group.reserved += num(row.quantity_reserved) ?? 0;
      const expiry = isoDate(row.expiry_date);
      if (expiry && (!group.expiry || expiry < group.expiry)) group.expiry = expiry;
      const state = str(row.shelf_life_state);
      if (state && (!group.state || SHELF_ORDER.indexOf(state) < SHELF_ORDER.indexOf(group.state))) group.state = state;
      group.batches += 1;
      groups.set(key, group);
    }
    const all = [...groups.values()].sort((a, b) => a.available - b.available);
    const shown = all.slice(0, limit).map((group) => project(`Товар ${group.sku ?? "без артикула"}, склад ${group.warehouse ?? "?"}, ${group.uom ?? "ед."}`, STOCK_FIELDS, {
      internal_sku: group.sku,
      product_name: maskDataText(group.name, 120),
      warehouse_code: group.warehouse,
      uom: group.uom,
      quantity_available: group.available,
      quantity_on_hand: group.onHand,
      quantity_reserved: group.reserved,
      nearest_expiry_date: group.expiry,
      worst_shelf_life_state: label(shelfLifeLabel, group.state),
      batch_count: group.batches,
    }));
    const sourceTruncated = rows.length >= STOCK_SOURCE_LIMIT;
    const notes = [
      "Минимальный остаток для товаров в Nexus не задан: нельзя утверждать, что товар заканчивается, по порогу. Можно только показать текущие количества.",
      "Записи отсортированы по возрастанию доступного количества.",
    ];
    if (sourceTruncated) notes.push(`Прочитаны первые ${STOCK_SOURCE_LIMIT} партий: суммы по товарам могут быть неполными.`);
    return result(shown, sourceTruncated || all.length > shown.length, sourceTruncated ? null : all.length, notes);
  },
};

const TASK_FIELDS: ToolField[] = [
  { key: "task_title", label: "Задача", kind: "text" },
  { key: "task_status", label: "Статус задачи", kind: "status" },
  { key: "priority", label: "Приоритет", kind: "text" },
  { key: "due_at", label: "Срок", kind: "datetime" },
  { key: "shipment_number", label: "Поставка", kind: "id" },
];

const getMyTasks: AgentTool = {
  name: "get_my_tasks",
  description: "Задачи, где вы исполнитель: открытые, в работе или просроченные. Возвращает не больше 20 записей.",
  permissions: ["tasks.view"],
  params: {
    filter: { type: "enum", values: ["active", "open", "in_progress", "overdue"], optional: true, description: "active — открытые и в работе (по умолчанию); overdue — срок прошёл" },
    limit: limitParam("по умолчанию 20"),
  },
  fields: TASK_FIELDS,
  maxRows: MAX_TOOL_ROWS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  async run(ctx, params) {
    const limit = Number(params.limit ?? MAX_TOOL_ROWS);
    // The assignee is the session user, never a value chosen by the model.
    const { rows, total } = await ctx.data.getMyTasks({ userId: ctx.userId, filter: String(params.filter ?? "active"), nowIso: new Date().toISOString(), limit }, ctx.signal);
    const shown = rows.slice(0, limit).map((row) => project(`Задача «${maskDataText(str(row.title), 120) ?? "без названия"}»`, TASK_FIELDS, {
      task_title: maskDataText(str(row.title), 160),
      task_status: label(taskStatusLabel, row.status),
      priority: label(taskPriorityLabel, row.priority),
      due_at: isoDateTime(row.due_at),
      shipment_number: str(row.shipment_number),
    }, uuidRef("shipment", row.shipment_id) ?? uuidRef("task", row.id)));
    return result(shown, rows.length > limit || (total !== null && total > shown.length), total, [`Время сроков — по ${AGENT_TIME_ZONE}.`]);
  },
};

const HELP_FIELDS: ToolField[] = [
  { key: "help_title", label: "Раздел справки", kind: "text" },
  { key: "help_text", label: "Справка", kind: "text" },
];

const getHelp: AgentTool = {
  name: "get_help",
  description: "Справка по работе с Nexus и ассистентом.",
  permissions: [],
  params: { topic: { type: "enum", values: HELP_TOPICS, description: "Тема справки" } },
  fields: HELP_FIELDS,
  maxRows: 1,
  timeoutMs: 1000,
  async run(_ctx, params) {
    const entry = HELP_TEXT[params.topic as HelpTopic];
    return result([project(`Справка: ${entry.title}`, HELP_FIELDS, { help_title: entry.title, help_text: entry.text })], false, 1);
  },
};

export const AGENT_TOOLS: readonly AgentTool[] = [
  findShipments, getShipment, getShipmentVehicles, getShipmentDocuments, getDocumentExtraction,
  listDelayedShipments, getStockStatus, getMyTasks, getHelp,
];

export const TOOL_BY_NAME: ReadonlyMap<string, AgentTool> = new Map(AGENT_TOOLS.map((tool) => [tool.name, tool]));

/** Every permission any tool needs; loaded once per check from my_permissions. */
export const TOOL_PERMISSIONS: readonly string[] = [...new Set(AGENT_TOOLS.flatMap((tool) => tool.permissions))];
