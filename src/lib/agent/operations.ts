// Closed command vocabulary. The model proposes data, never an RPC, URL or SQL.
import { validateParams } from "./schema.ts";
import type { ParamSchema } from "./types.ts";
import { parseExpensePayment, expensePaymentSchema } from "./expense-payment.ts";
import { parseExpenseReversal, expenseReversalSchema } from "./expense-reversal.ts";
import { parseExpenseCancellation, expenseCancellationSchema } from "./expense-cancellation.ts";
import { parseReceiving, receivingSchema } from "./receiving.ts";
import { parseReturn, returnSchema } from "./returns.ts";
import { parseReturnDecision, returnDecisionSchema } from "./return-decisions.ts";

import { parseReturnCancellation, returnCancellationSchema } from "./return-cancellation.ts";

import {parseCostApproval,costApprovalSchema} from "./cost-approval.ts";
import { parseCost, costSchema } from "./cost-calculation.ts";
import { parseAllocation, allocationSchema } from "./expense-allocation.ts";
import { parseExpense, expenseSchema } from "./expenses.ts";

export const OPERATION_KINDS = ["inventory_transfer", "customer_order_fulfillment", "customer_order_create", "customer_order_reserve", "customer_order_confirm", "shipment_transport_receive", "customer_return_create", "customer_return_decide", "customer_return_cancel", "expense_create", "expense_confirm", "expense_allocate", "shipment_cost_calculate", "shipment_cost_approve", "expense_cancel", "expense_reverse", "expense_mark_paid"] as const;
export type OperationKind = typeof OPERATION_KINDS[number];
export type OperationIntent = { kind: OperationKind; params: Record<string, string | number | null | Record<string, string | number | null>[]> };
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
  if(value.kind==="expense_mark_paid"){const p=parseExpensePayment(value.params);return p?{kind:value.kind,params:p}:null;}
  if(value.kind==="expense_reverse"){const p=parseExpenseReversal(value.params);return p?{kind:value.kind,params:p}:null;}
  if(value.kind==="expense_cancel"){const p=parseExpenseCancellation(value.params);return p?{kind:value.kind,params:p}:null;}
  if(value.kind==="shipment_cost_approve"){const p=parseCostApproval(value.params);return p?{kind:value.kind,params:p}:null;}
  if (value.kind === "shipment_cost_calculate") {
    const p=parseCost(value.params);return p?{kind:value.kind,params:p}:null;
  }
  if (value.kind === "expense_allocate") {
    const p = parseAllocation(value.params);
    return p ? {kind:value.kind,params:p} : null;
  }
  if (value.kind === "expense_confirm") {
    const p = validateParams({ expense_id: { type: "uuid", description: "Выбранный черновик расхода" } }, value.params);
    return p.ok ? { kind: value.kind, params: p.value } : null;
  }
  if (value.kind === "expense_create") {
    const params = parseExpense(value.params);
    return params ? { kind: value.kind, params } : null;
  }
  if (value.kind === "customer_return_cancel") {
    const params = parseReturnCancellation(value.params);
    return params ? { kind: value.kind, params } : null;
  }
  if (value.kind === "customer_return_decide") {
    const params = parseReturnDecision(value.params);
    return params ? { kind: value.kind, params } : null;
  }
  if (value.kind === "customer_return_create") {
    const params = parseReturn(value.params);
    return params ? { kind: value.kind, params } : null;
  }
  if (value.kind === "shipment_transport_receive") {
    const params = parseReceiving(value.params);
    return params ? { kind: value.kind, params } : null;
  }
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
  if (value.kind === "customer_order_fulfillment" || value.kind === "customer_order_reserve" || value.kind === "customer_order_confirm") {
    const parsed = validateParams({ sale_id: { type: "uuid", description: "Подтверждённый заказ из текущего поиска" } }, value.params);
    return parsed.ok ? { kind: value.kind, params: parsed.value } : null;
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
export const OPERATION_INTENT_SCHEMA = { anyOf: [expensePaymentSchema, expenseReversalSchema, expenseCancellationSchema, costApprovalSchema, costSchema, allocationSchema, { type: "object", additionalProperties: false, required: ["kind", "params"], properties: { kind: { type: "string", enum: ["expense_confirm"] }, params: { type: "object", additionalProperties: false, required: ["expense_id"], properties: { expense_id: { type: "string", description: "UUID выбранного черновика расхода из поиска" } } } } }, expenseSchema, returnCancellationSchema, returnDecisionSchema, returnSchema, receivingSchema, transferSchema, {
  type: "object", additionalProperties: false, required: ["kind", "params"], properties: {
    kind: { type: "string", enum: ["customer_order_fulfillment", "customer_order_reserve", "customer_order_confirm"] },
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
  ASSISTANT_EXPENSE_PAYMENT_INVALID: "Выберите один точный расход. Сумму, дату платежа и банковский перевод эта операция не принимает.",
  ASSISTANT_EXPENSE_PAYMENT_STATE: "Нужен фактический распределённый расход без прежней отметки оплаты. План, черновик и уже оплаченный расход не подходят.",
  ASSISTANT_EXPENSE_PAYMENT_STALE: "Расход или распределение изменились. Подготовьте новый просмотр фиксации оплаты.",
  ASSISTANT_EXPENSE_PAYMENT_REFUSED: "Фиксация оплаты не сохранена: штатная проверка или сверка результата отклонила действие.",
  ASSISTANT_EXPENSE_REVERSE_INVALID: "Выберите оплаченный расход и укажите причину сторнирования от 1 до 500 символов.",
  ASSISTANT_EXPENSE_REVERSE_STATE: "Для сторнирования нужен оплаченный расход с сохранёнными сведениями об оплате. Неоплаченный расход отменяется отдельно.",
  ASSISTANT_EXPENSE_REVERSE_STALE: "Расход, оплата или распределение изменились. Подготовьте новый просмотр сторнирования.",
  ASSISTANT_EXPENSE_REVERSE_REFUSED: "Сторнирование не сохранено: штатная проверка или сверка результата отклонила действие.",
  ASSISTANT_EXPENSE_CANCEL_INVALID: "Выберите расход и укажите причину отмены от 1 до 500 символов.",
  ASSISTANT_EXPENSE_CANCEL_STATE: "Отменить можно только неоплаченный расход: черновик, подтверждённый или распределённый. Оплаченный требует отдельного сторнирования.",
  ASSISTANT_EXPENSE_CANCEL_STALE: "Расход или его контекст изменился. Подготовьте новый просмотр отмены.",
  ASSISTANT_EXPENSE_CANCEL_REFUSED: "Отмена не сохранена: штатная проверка или сверка результата отклонила действие.",
  ASSISTANT_COST_APPROVAL_INVALID: "Выберите конкретную сохранённую версию расчёта.",
  ASSISTANT_COST_APPROVAL_STATE: "Нужна действующая черновая версия. Уже утверждённую или заменённую версию нельзя утвердить повторно.",
  ASSISTANT_COST_APPROVAL_STALE: "Исходные данные расчёта изменились. Сначала создайте новую версию себестоимости.",
  ASSISTANT_COST_APPROVAL_PRELIMINARY: "Расчёт предварительный: подтвердите ДТ и создайте новую версию перед утверждением.",
  ASSISTANT_COST_APPROVAL_LIMIT: "Нужен полный просмотр: от 1 до 200 строк и не более 200 затрагиваемых партий.",
  ASSISTANT_COST_APPROVAL_REFUSED: "Утверждение не сохранено. Результат отличается от предпросмотра; проверьте состояние.",
  ASSISTANT_COST_INVALID: "Выберите поставку и валюту расчёта. Суммы рассчитывает сервер.",
  ASSISTANT_COST_STATE: "Поставка или валюта недоступна для расчёта.",
  ASSISTANT_COST_LIMIT: "Предпросмотр доступен для поставок от 1 до 200 позиций, без сокращения списка.",
  ASSISTANT_COST_REFUSED: "Расчёт не сохранён: исходные данные или результат изменились. Подготовьте новый просмотр.",
  ASSISTANT_ALLOCATION_INVALID: "Выберите расход, способ и валюту распределения. Суммы по товарам рассчитываются сервером.",
  ASSISTANT_ALLOCATION_STATE: "Нужен действующий фактический расход поставки: подтверждённый, распределённый или оплаченный.",
  ASSISTANT_ALLOCATION_RATE: "Нет подходящего курса на дату расхода. Распределение не выполнено.",
  ASSISTANT_ALLOCATION_BASIS: "Проверьте количество, цену, вес или объём товаров. Поддерживается от 1 до 200 позиций; отрицательный остаток округления не допускается.",
  ASSISTANT_ALLOCATION_REFUSED: "Штатное распределение отклонено или не совпало с предпросмотром. Изменения не сохранены.",
  ASSISTANT_EXPENSE_CONFIRM_INVALID: "Выберите один точный черновик расхода. Сумму и реквизиты в этой операции менять нельзя.",
  ASSISTANT_EXPENSE_CONFIRM_STATE: "Расход уже не черновик или его источники недоступны. Начните новый просмотр.",
  ASSISTANT_EXPENSE_CONFIRM_REFUSED: "Штатная операция отклонила бухгалтерское подтверждение. Изменения не сохранены.",
  ASSISTANT_EXPENSE_INVALID: "Уточните поставку, вид, точную сумму, валюту, дату и план/факт; получателя, документ и примечание укажите явно.",
  ASSISTANT_EXPENSE_STATE: "Поставка, валюта, получатель или документ недоступны. Проверьте данные и начните новый просмотр.",
  ASSISTANT_EXPENSE_REFUSED: "Штатная операция отклонила создание расхода. Изменения не сохранены.",
  ASSISTANT_CANCEL_INVALID: "Укажите точный возврат и причину отмены до 500 символов.",
  ASSISTANT_CANCEL_STATE: "Отмена недоступна: возврат уже отменён, есть решение по позиции или слишком много позиций для просмотра.",
  ASSISTANT_CANCEL_REFUSED: "Штатная операция отклонила отмену. Изменения не сохранены.",
  ASSISTANT_DECISION_INVALID: "Уточните позицию возврата, решение, зону и причину. Количество и партию менять нельзя.",
  ASSISTANT_DECISION_STATE: "Решение недоступно: возврат отменён, позиция уже обработана или выбранная зона недоступна.",
  ASSISTANT_DECISION_REFUSED: "Штатная операция отклонила решение по возврату. Частичных изменений не сохранено.",
  ASSISTANT_RETURN_INVALID: "Уточните отгруженный заказ, партии, количества и причины. Возврат не оформлен.",
  ASSISTANT_RETURN_STATE: "Возврат недоступен: нужен отгруженный заказ и количество не больше оставшегося к возврату по партии.",
  ASSISTANT_RETURN_REFUSED: "Штатная операция отклонила возврат. Частичных записей не сохранено. Проверьте заказ в разделе продаж.",
  ASSISTANT_RECEIVING_INVALID: "Уточните все позиции автомобиля, фактически годное и повреждённое количество, партии, сроки и причины расхождений. Приёмка не выполнена.",
  ASSISTANT_RECEIVING_STATE: "Приёмка недоступна: нужен прибывший, ещё не принятый автомобиль доступной поставки.",
  ASSISTANT_RECEIVING_REFUSED: "Штатная приёмка отклонила операцию. Проверьте данные в карточке поставки. Частичных записей не сохранено.",
  ASSISTANT_OPERATION_CONFIRM_STATE: "Подтвердить можно полностью зарезервированный заказ. Проверьте его текущее состояние.",
  ASSISTANT_OPERATION_CONFIRM_BLOCKED: "Подтверждение недоступно: проверьте полноту резервов, пригодность партий и действующие гарантийные письма в карточке заказа.",
  ASSISTANT_OPERATION_CONFIRM_REFUSED: "Штатная проверка отклонила подтверждение заказа. Проверьте условия и финансовое согласование в карточке заказа с уполномоченным сотрудником. Отгрузка не выполнялась.",
  ASSISTANT_OPERATION_RESERVE_STATE: "Нужен черновик без действующих резервов. Существующие резервы изменяйте через штатный просмотр заказа.",
  ASSISTANT_OPERATION_RESERVE_SIZE: "В заказе нет позиций или набор слишком большой для полного просмотра. Откройте карточку заказа.",
  ASSISTANT_OPERATION_RESERVE_BLOCKED: "Подбор не выполнен: проверьте свободный остаток, упаковку, состояние партий и письма в заказе. Никакие резервы не созданы.",
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
  if (message.startsWith("Нет курса ")) return "Не хватает курса на дату расчёта или подтверждённой ДТ. Добавьте курс штатным способом и повторите просмотр.";
  if (message === "Подтвердите и распределите фактические расходы поставки или отмените ошибочные") return message;
  if (message === "Все расходы должны быть распределены в валюте расчёта") return message;
  if (message === "У позиции поставки не заполнена закупочная цена или валюта") return message;
  if (message.startsWith("Часть расходов распределена на позиции без прихода")) return "Есть расходы на позиции с нулевым приходом. Сначала проверьте и повторите их распределение.";
  if (message.startsWith("Для позиции указаны таможенные декларации с разными датами")) return "Неоднозначная дата ДТ. Уточните привязки документов перед расчётом.";
  return OPERATION_ERRORS[message] ?? "Не удалось выполнить действие. Обновите состояние операции; не создавайте повторный запрос, пока не проверен результат.";
}
