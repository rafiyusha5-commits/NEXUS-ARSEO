// Closed command vocabulary. The model proposes data, never an RPC, URL or SQL.
import { validateParams } from "./schema.ts";
import type { ParamSchema } from "./types.ts";

export const OPERATION_KINDS = ["inventory_transfer", "customer_order_fulfillment", "customer_order_create"] as const;
export type OperationKind = typeof OPERATION_KINDS[number];
export type OperationIntent = { kind: OperationKind; params: Record<string, string | number | null | Record<string, string | number>[]> };
const transfer: Record<string, ParamSchema> = {
  product_id: { type: "uuid", description: "Точный товар из справочника" },
  from_warehouse_id: { type: "uuid", description: "Склад отправления" },
  to_warehouse_id: { type: "uuid", description: "Склад назначения" },
  quantity: { type: "string", maxLength: 18, pattern: /^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/, description: "Положительное количество, до 0,001" },
  uom: { type: "enum", values: ["piece", "box", "layer", "pallet", "truck"], description: "Единица запроса, без предположений об упаковке" },
};
const draftHeader: Record<string, ParamSchema> = {
  customer_id: { type: "uuid", description: "Выбранный покупатель" },
  warehouse_id: { type: "uuid", description: "Выбранный склад" },
  currency_id: { type: "uuid", description: "Явно выбранная валюта" },
  planned_shipment_date: { type: "date", description: "Согласованная дата отгрузки" },
};
const draftItem: Record<string, ParamSchema> = {
  product_id: transfer.product_id, quantity: transfer.quantity, uom: transfer.uom,
  unit_price: { type: "string", maxLength: 15, pattern: /^(?:0|[1-9]\d{0,9})(?:\.\d{1,4})?$/, description: "Явная цена за выбранную единицу, до 0,0001; отсутствие цены не равно нулю" },
};
export function parseOperationIntent(input: unknown): OperationIntent | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== 2) return null;
  if (value.kind === "customer_order_create") {
    if (!value.params || typeof value.params !== "object" || Array.isArray(value.params)) return null;
    const params = value.params as Record<string, unknown>;
    const { items, contract_id, ...header } = params;
    if (!Object.hasOwn(params, "contract_id") || !Array.isArray(items) || items.length < 1 || items.length > 25) return null;
    const parsedHeader = validateParams(draftHeader, header);
    if (!parsedHeader.ok || (contract_id !== null && !validateParams({ contract_id: { type: "uuid", description: "Договор покупателя" } }, { contract_id }).ok)) return null;
    const lines: Record<string, string | number>[] = [], seen = new Set<string>();
    for (const item of items) {
      const parsed = validateParams(draftItem, item);
      if (!parsed.ok || Number(parsed.value.quantity) <= 0) return null;
      const key = `${String(parsed.value.product_id).toLowerCase()}:${parsed.value.uom}`;
      if (seen.has(key)) return null; // Do not silently combine prices/quantities of repeated lines.
      seen.add(key); lines.push(parsed.value);
    }
    return { kind: "customer_order_create", params: { ...parsedHeader.value, contract_id: contract_id as string | null, items: lines } };
  }
  if (value.kind === "customer_order_fulfillment") {
    const parsed = validateParams({ sale_id: { type: "uuid", description: "Подтверждённый заказ из текущего поиска" } }, value.params);
    return parsed.ok ? { kind: "customer_order_fulfillment", params: parsed.value } : null;
  }
  if (value.kind !== "inventory_transfer") return null;
  const parsed = validateParams(transfer, value.params);
  if (!parsed.ok || Number(parsed.value.quantity) <= 0 || parsed.value.from_warehouse_id === parsed.value.to_warehouse_id) return null;
  return { kind: "inventory_transfer", params: parsed.value };
}

const transferSchema = {
  type: "object", additionalProperties: false, required: ["kind", "params"],
  properties: {
    kind: { type: "string", enum: ["inventory_transfer"] },
    params: { type: "object", additionalProperties: false, required: Object.keys(transfer), properties: {
      product_id: { type: "string" }, from_warehouse_id: { type: "string" }, to_warehouse_id: { type: "string" },
      quantity: { type: "string" }, uom: { type: "string", enum: ["piece", "box", "layer", "pallet", "truck"] },
    } },
  },
};
export const OPERATION_INTENT_SCHEMA = { anyOf: [transferSchema, {
  type: "object", additionalProperties: false, required: ["kind", "params"], properties: {
    kind: { type: "string", enum: ["customer_order_fulfillment"] },
    params: { type: "object", additionalProperties: false, required: ["sale_id"], properties: { sale_id: { type: "string" } } },
  },
}, {
  type: "object", additionalProperties: false, required: ["kind", "params"], properties: {
    kind: { type: "string", enum: ["customer_order_create"] },
    params: { type: "object", additionalProperties: false, required: [...Object.keys(draftHeader), "contract_id", "items"], properties: {
      customer_id: { type: "string" }, warehouse_id: { type: "string" }, currency_id: { type: "string" }, planned_shipment_date: { type: "string" },
      contract_id: { type: ["string", "null"] },
      items: { type: "array", minItems: 1, maxItems: 25, items: { type: "object", additionalProperties: false, required: Object.keys(draftItem), properties: {
        product_id: { type: "string" }, quantity: { type: "string" }, unit_price: { type: "string" }, uom: { type: "string", enum: ["piece", "box", "layer", "pallet", "truck"] },
      } } },
    } },
  },
}, { type: "null" }] };

export const OPERATION_ERRORS: Record<string, string> = {
  ASSISTANT_OPERATION_DENIED: "Нет доступа к этой операции. Права могли измениться.",
  ASSISTANT_OPERATION_INVALID: "Не удалось однозначно определить параметры. Уточните товар, склады, количество и единицу.",
  ASSISTANT_OPERATION_STALE: "Заказ, остатки, партии или условия изменились. Обновите предварительный просмотр и подтвердите заново.",
  ASSISTANT_OPERATION_ORDER_STATE: "Для отгрузки нужен существующий подтверждённый заказ. Проверьте его текущее состояние.",
  ASSISTANT_OPERATION_ORDER_BLOCKED: "Отгрузка недоступна: проверьте резервы, партии и гарантийные письма в карточке заказа.",
  ASSISTANT_OPERATION_DRAFT_INVALID: "Уточните покупателя, договор (или явно без договора), склад, дату, валюту и цену каждой позиции. Повторяющиеся строки нужно разобрать вручную.",
  ASSISTANT_OPERATION_DRAFT_SOURCE: "Выбранные покупатель, договор, товар, склад или валюта больше недоступны для создания заказа. Обновите выбор.",
  ASSISTANT_OPERATION_UNITS: "Не задана точная упаковка для пересчёта. Уточните единицы.",
  ASSISTANT_OPERATION_STOCK: "Недостаточно доступного остатка для полного перемещения.",
  ASSISTANT_OPERATION_EXPIRED: "Срок предварительного просмотра истёк. Подготовьте его заново.",
};
export function operationError(error: unknown): string {
  const message = error && typeof error === "object" && "message" in error ? String(error.message) : "";
  return OPERATION_ERRORS[message] ?? "Не удалось выполнить действие. Обновите состояние операции; не создавайте повторный запрос, пока не проверен результат.";
}
