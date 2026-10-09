import type { AgentAnswer } from "../agent/types.ts";
import { maskDataText, maskFactText } from "../agent/masking.ts";
import { shortMessage } from "./protocol.ts";

const safe = (text: string) => maskDataText(text, 3900) ?? "";
export function telegramAnswer(answer: AgentAnswer, used: number, limit: number): string {
  const parts: string[] = [];
  // Facts are built by code from masked tool rows; free model text keeps the strict data rule.
  for (const fact of answer.facts) parts.push(["Факт · данные Nexus", maskFactText(fact.subject), ...fact.values.map(value => maskFactText(`${value.label}: ${value.value}`))].join("\n"));
  for (const item of answer.commentary) parts.push(`${item.kind === "assumption" ? "Предположение" : "Пояснение · не проверено"}\n${safe(item.text)}`);
  if (answer.limitations.length) parts.push("Ограничения\n" + answer.limitations.map(safe).join("\n"));
  if (!parts.length) parts.push("Подтверждённых данных для ответа нет. Уточните вопрос.");
  parts.push(`Вопросы сегодня: ${used} из ${limit}. Общий лимит с веб-чатом.`);
  return shortMessage(parts.join("\n\n"));
}
