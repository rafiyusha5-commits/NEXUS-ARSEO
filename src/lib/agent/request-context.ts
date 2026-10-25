import { ANSWER_JSON_SCHEMA } from "./facts.ts";
import { OPERATION_INTENT_SCHEMA } from "./operations.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";

/** Routing is an input-size optimization, never an authorization decision.
 * Ambiguous follow-ups and mixed requests retain the full operation vocabulary.
 * Only the employee's current question is classified, never document/tool text.
 */
export function isSalesRequest(question: string): boolean {
  return /заказ|реализац|продаж|отгруз|резерв/iu.test(question)
    && !/поставк|закуп|при[её]м|расход|себестоим|возврат|перемещ|оплат|сторн/iu.test(question);
}

const SALES_GUIDANCE = `Для нового заказа или реализации сначала проверь, указал ли сотрудник цену продажи за единицу, валюту, дату отгрузки и договор либо явное решение «без договора». Если чего-то нет, задай один короткий вопрос со всеми недостающими реквизитами и верни operation=null. Попроси прислать полный запрос одним сообщением с товаром, количеством, складом, клиентом и этими реквизитами: прежние вопросы и цены в контексте диалога не сохраняются. Не ищи все договоры, цены, остатки и партии, пока сотрудник не уточнил эти реквизиты. Не подставляй 0, закупочную цену, сегодняшнюю дату или отсутствие договора по умолчанию. Создание заказа означает только черновик; резерв, подтверждение и отгрузка — отдельные действия после предпросмотра.
Поиск: warehouses — название/код/город; counterparties — название клиента; contracts — номер или parent_id клиента (related_by=counterparty_id); currencies — код валюты, без status. Остатки: get_stock_status либо balances по batch_id/warehouse_id, не query=артикул. Не повторяй ошибочный фильтр; используй подсказку инструмента. Если пользователь просит действие, ответ без operation не означает, что оно выполнено.`;

export function requestContext(question: string, operationsEnabled: boolean) {
  const sales = isSalesRequest(question);
  const start = SYSTEM_PROMPT.indexOf("Подготовка операции:");
  const end = SYSTEM_PROMPT.indexOf("Формат окончательного ответа");
  let prompt = SYSTEM_PROMPT;
  let operation: unknown = OPERATION_INTENT_SCHEMA;
  if (!operationsEnabled) {
    prompt = SYSTEM_PROMPT.slice(0, start) + SYSTEM_PROMPT.slice(end);
    operation = { type: "null" };
  } else if (sales) {
    const instructions = SYSTEM_PROMPT.slice(start, end).split("\n")
      .filter(line => /^(Подготовка операции:|Создание заказа покупателя:|Резервирование:|Подтверждение заказа:)/u.test(line));
    prompt = SYSTEM_PROMPT.slice(0, start) + instructions.join("\n") + "\n" + SYSTEM_PROMPT.slice(end);
    operation = { anyOf: OPERATION_INTENT_SCHEMA.anyOf.filter(item => item.type === "null"
      || ("properties" in item && item.properties.kind.enum.some(kind => kind.startsWith("customer_order_")))) };
  }
  return {
    sales,
    prompt: prompt + "\n" + SALES_GUIDANCE,
    answerSchema: { ...ANSWER_JSON_SCHEMA, properties: {
      ...(ANSWER_JSON_SCHEMA.properties as Record<string, unknown>), operation,
    } },
  };
}
