import type { AgentAnswer } from "../agent/types.ts";
import { maskDataText, maskFactText } from "../agent/masking.ts";
import { shortMessage } from "./protocol.ts";

const safe = (text: string) => maskDataText(text, 3900) ?? "";
function fullTelegramAnswer(answer: AgentAnswer, used: number, limit: number): string {
  const parts: string[] = [];
  // Facts are built by code from masked tool rows; free model text keeps the strict data rule.
  for (const fact of answer.facts) parts.push(["Факт · данные Nexus", maskFactText(fact.subject), ...fact.values.map(value => maskFactText(`${value.label}: ${value.value}`, value.field === "product_list" ? value.value.length + value.label.length + 10 : 400, value.field === "product_list"))].join("\n"));
  for (const item of answer.commentary) parts.push(`${item.kind === "assumption" ? "Предположение" : "Пояснение · не проверено"}\n${safe(item.text)}`);
  if (answer.limitations.length) parts.push("Ограничения\n" + answer.limitations.map(safe).join("\n"));
  if (!parts.length) parts.push("Подтверждённых данных для ответа нет. Уточните вопрос.");
  parts.push(`Вопросы сегодня: ${used} из ${limit}. Общий лимит с веб-чатом.`);
  return parts.join("\n\n");
}
export function telegramAnswer(answer: AgentAnswer, used: number, limit: number): string {
  return shortMessage(fullTelegramAnswer(answer, used, limit));
}
export function telegramDelivery(answer: AgentAnswer, used: number, limit: number): { text: string; document?: string } {
  const full = fullTelegramAnswer(answer, used, limit);
  if (full.length <= 3900) return { text: full };
  const catalogue = answer.facts.find(fact => fact.source.tool === "find_products");
  const count = catalogue?.values.find(value => value.field === "products_shown")?.value;
  const total = catalogue?.values.find(value => value.field === "products_total")?.value;
  const summary = count ? `\nПоказано товаров: ${count}${total ? ` из ${total}` : ""}.` : "";
  return { text: `Полный ответ без обрезки — в приложенном файле.${summary}\nВопросы сегодня: ${used} из ${limit}. Общий лимит с веб-чатом.`, document: full };
}
