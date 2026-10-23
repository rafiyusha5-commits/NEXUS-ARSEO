// Closed command vocabulary. The model proposes data, never an RPC, URL or SQL.
import { validateParams } from "./schema.ts";
import type { ParamSchema } from "./types.ts";

export const OPERATION_KINDS = ["inventory_transfer", "customer_order_fulfillment"] as const;
export type OperationKind = typeof OPERATION_KINDS[number];
export type OperationIntent = { kind: OperationKind; params: Record<string, string | number> };
const transfer: Record<string, ParamSchema> = {
  product_id: { type: "uuid", description: "Точный товар из справочника" },
  from_warehouse_id: { type: "uuid", description: "Склад отправления" },
  to_warehouse_id: { type: "uuid", description: "Склад назначения" },
  quantity: { type: "string", maxLength: 18, pattern: /^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/, description: "Положительное количество, до 0,001" },
  uom: { type: "enum", values: ["piece", "box", "layer", "pallet", "truck"], description: "Единица запроса, без предположений об упаковке" },
};
export function parseOperationIntent(input: unknown): OperationIntent | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== 2) return null;
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
}, { type: "null" }] };

export const OPERATION_ERRORS: Record<string, string> = {
  ASSISTANT_OPERATION_DENIED: "Нет доступа к этой операции. Права могли измениться.",
  ASSISTANT_OPERATION_INVALID: "Не удалось однозначно определить параметры. Уточните товар, склады, количество и единицу.",
  ASSISTANT_OPERATION_STALE: "Заказ, остатки, партии или условия изменились. Обновите предварительный просмотр и подтвердите заново.",
  ASSISTANT_OPERATION_ORDER_STATE: "Для отгрузки нужен существующий подтверждённый заказ. Проверьте его текущее состояние.",
  ASSISTANT_OPERATION_ORDER_BLOCKED: "Отгрузка недоступна: проверьте резервы, партии и гарантийные письма в карточке заказа.",
  ASSISTANT_OPERATION_UNITS: "Не задана точная упаковка для пересчёта. Уточните единицы.",
  ASSISTANT_OPERATION_STOCK: "Недостаточно доступного остатка для полного перемещения.",
  ASSISTANT_OPERATION_EXPIRED: "Срок предварительного просмотра истёк. Подготовьте его заново.",
};
export function operationError(error: unknown): string {
  const message = error && typeof error === "object" && "message" in error ? String(error.message) : "";
  return OPERATION_ERRORS[message] ?? "Не удалось выполнить действие. Обновите состояние операции; не создавайте повторный запрос, пока не проверен результат.";
}
