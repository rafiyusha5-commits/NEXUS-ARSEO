import type { AgentAnswer, VerifiedFact } from "../agent/types.ts";
import { maskDataText, maskFactText } from "../agent/masking.ts";
import { shortMessage } from "./protocol.ts";

const safe = (text: string) => maskDataText(text, 3900) ?? "";
const routineNote = (text: string) => /^Источник: .+Данные прочитаны с текущими правами сотрудника\./.test(text)
  || /^Это справочник товаров: наличие на складе проверяется отдельно\.$/.test(text)
  || /^Полный результат поиска: \d+ товаров\.$/.test(text)
  || /^Записи отсортированы по возрастанию доступного количества\.$/.test(text);
function factText(fact: VerifiedFact, otherFacts: boolean): string {
  const details = fact.values.find(value => value.field === "record_details")?.value ?? "";
  const code = fact.values.find(value => value.field === "public_code" && value.kind === "protected");
  if (code && fact.subject.startsWith("Артикулы поставщика и штрихкоды")) {
    const type = details.match(/(?:^|\n)Тип артикула\/штрихкода: ([a-z_]+)/)?.[1];
    const label: Record<string, string> = { unit_barcode: "Штрихкод единицы", box_barcode: "Штрихкод короба", gtin: "GTIN", supplier_sku: "Артикул поставщика" };
    return `${label[type ?? ""] ?? "Штрихкод / артикул"}: ${code.value}`;
  }
  const list = fact.values.find(value => value.field === "product_list");
  if (fact.source.tool === "find_products" && list && otherFacts && fact.values.some(value => value.field === "products_shown" && value.value === "1")) {
    return maskFactText(list.value.replace(/^1\.\s*/, ""), list.value.length + 10, true);
  }
  const lines = fact.values.map(value => value.kind === "protected" || value.kind === "financial" ? `${value.label}: ${value.value}`
    : maskFactText(["product_list", "record_details"].includes(value.field) ? value.value : `${value.label}: ${value.value}`,
      ["product_list", "record_details"].includes(value.field) ? value.value.length + value.label.length + 10 : 400,
      ["product_list", "record_details"].includes(value.field)));
  const detailLines = new Set(lines[fact.values.findIndex(value=>value.field === "record_details")]?.split("\n") ?? []);
  const conciseLines = lines.filter((line,index)=>fact.values[index].field === "record_details" || !detailLines.has(line));
  const subject = ["Каталог товаров Nexus", "Артикулы поставщика и штрихкоды", "Упаковка: веса, размеры и количество"].includes(fact.subject) ? "" : maskFactText(fact.subject);
  return [subject, ...conciseLines].filter(Boolean).join("\n");
}
function quotaNote(used: number, limit: number): string {
  return used >= limit - 2 ? `Осталось вопросов сегодня: ${Math.max(0, limit - used)}. Лимит общий с веб-чатом.` : "";
}
function fullTelegramAnswer(answer: AgentAnswer, used: number, limit: number): string {
  const otherFacts = answer.facts.some(fact => fact.source.tool !== "find_products");
  const facts = answer.facts.map(fact => factText(fact, otherFacts)).filter(Boolean);
  // A one-product lookup is useful context, rather than a second catalogue report.
  const parts = [...answer.facts.filter(fact => fact.source.tool === "find_products").map(fact => factText(fact, otherFacts)),
    ...answer.facts.filter(fact => fact.source.tool !== "find_products").map(fact => factText(fact, otherFacts))].filter(Boolean);
  for (const item of answer.commentary) parts.push(`${item.kind === "assumption" ? "Предположение" : "Пояснение · не проверено"}\n${safe(item.text)}`);
  const warnings = answer.limitations.filter(text => !routineNote(text)).map(safe).filter(Boolean);
  if (warnings.length) parts.push("Важно: " + [...new Set(warnings)].join("\n"));
  if (!facts.length && !answer.commentary.length) parts.unshift("Подтверждённых данных для ответа нет. Уточните вопрос.");
  const quota = quotaNote(used, limit); if (quota) parts.push(quota);
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
  const quota = quotaNote(used, limit);
  return { text: `Полный ответ — в приложенном файле.${summary}${quota ? `\n${quota}` : ""}`, document: full };
}
