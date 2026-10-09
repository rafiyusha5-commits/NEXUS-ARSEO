// Verified answers. The model never writes a verified statement: it only selects a tool call, a row
// and fields of that row. The statement shown as verified is assembled here, by code, from the row's
// subject (built by the tool from the data) and the selected values. Anything the model writes in its
// own words is commentary and is always shown separately as unverified.
import { SYSTEM_BY_KEY } from "./system-registry.ts";
import { maskSensitive } from "./masking.ts";
import { AGENT_TIME_ZONE } from "./time.ts";
import type { AgentAnswer, AgentTool, Commentary, FactValue, ToolField, ToolResult, VerifiedFact } from "./types.ts";

const MAX_FACTS = 12;
const MAX_FIELDS = 8;
const MAX_COMMENTARY = 6;
const MAX_LIMITATIONS = 5;

export const ANSWER_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["facts", "commentary", "limitations"],
  properties: {
    facts: {
      type: "array",
      maxItems: MAX_FACTS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["call", "row", "fields"],
        properties: {
          call: { type: "string" },
          row: { type: "integer" },
          fields: { type: "array", minItems: 1, maxItems: MAX_FIELDS, items: { type: "string" } },
        },
      },
    },
    commentary: {
      type: "array",
      maxItems: MAX_COMMENTARY,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "text"],
        properties: { kind: { type: "string", enum: ["assumption", "explanation"] }, text: { type: "string", maxLength: 600 } },
      },
    },
    limitations: { type: "array", maxItems: MAX_LIMITATIONS, items: { type: "string", maxLength: 300 } },
  },
};

export type CallRecord = { tool: AgentTool; result: ToolResult; access?: { all: string[]; any: string[] }; records?: { section: string; ids: string[] } };

type RawFact = { call: string; row: number; fields: string[] };
type RawCommentary = { kind: "assumption" | "explanation"; text: string };
type RawAnswer = { facts: RawFact[]; commentary: RawCommentary[]; limitations: string[] };

const exact = (object: unknown, keys: string[]) =>
  typeof object === "object" && object !== null && !Array.isArray(object)
  && Object.keys(object).length === keys.length && keys.every((key) => key in (object as object));

/** Strict structural validation of the model's JSON; any extra or missing key rejects it. */
export function parseAnswer(content: string | null): RawAnswer | null {
  if (!content || content.length > 20_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (!exact(value, ["facts", "commentary", "limitations"])) return null;
  const answer = value as RawAnswer;
  if (!Array.isArray(answer.facts) || answer.facts.length > MAX_FACTS) return null;
  if (!Array.isArray(answer.commentary) || answer.commentary.length > MAX_COMMENTARY) return null;
  if (!Array.isArray(answer.limitations) || answer.limitations.length > MAX_LIMITATIONS) return null;
  for (const fact of answer.facts) {
    if (!exact(fact, ["call", "row", "fields"]) || typeof fact.call !== "string" || fact.call.length > 100 || !Number.isInteger(fact.row)) return null;
    if (!Array.isArray(fact.fields) || !fact.fields.length || fact.fields.length > MAX_FIELDS || !fact.fields.every((field) => typeof field === "string" && field.length <= 60)) return null;
  }
  for (const item of answer.commentary) {
    if (!exact(item, ["kind", "text"]) || (item.kind !== "assumption" && item.kind !== "explanation") || typeof item.text !== "string" || item.text.length > 600) return null;
  }
  if (!answer.limitations.every((item) => typeof item === "string" && item.length <= 300)) return null;
  return answer;
}

const DATETIME_FORMAT = new Intl.DateTimeFormat("ru-RU", { timeZone: AGENT_TIME_ZONE, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const NUMBER_FORMAT = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 });

export function formatValue(field: ToolField, value: string | number): string {
  if (field.kind === "date" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-");
    return `${day}.${month}.${year}`;
  }
  if (field.kind === "datetime" && typeof value === "string" && !Number.isNaN(Date.parse(value))) return DATETIME_FORMAT.format(new Date(value));
  if (typeof value === "number") return NUMBER_FORMAT.format(value);
  return String(value);
}

const URL = /\bhttps?:\/\/\S+|\bwww\.\S+|\[([^\]]*)\]\([^)]*\)/gi;

function cleanText(text: string): string {
  return maskSensitive(text.replace(URL, (_m, linkText?: string) => linkText ?? "").replace(/\s+/g, " ").trim()).text;
}

function link(entity: { type: string; id: string; section?: string } | undefined): string | undefined {
  if (!entity) return undefined;
  if (entity.type === "system") {
    const section=SYSTEM_BY_KEY.get(entity.section??"");
    if (!section) return undefined;
    if (section.key === "products" || section.key === "product_prices" || section.key === "calculator" || section.key === "calculator_finance") return `/products/${entity.id}`;
    if (["counterparties","warehouses","shipments","sales","documents","templates","listing_cards"].includes(section.key)) return `${section.path}/${entity.id}`;
    return section.path || undefined;
  }
  if (entity.type === "shipment") return `/shipments/${entity.id}`;
  if (entity.type === "document") return `/documents/${entity.id}`;
  if (entity.type === "task") return "/tasks";
  return undefined;
}

function toolTitle(tool: AgentTool): string {
  return tool.description.split(".")[0];
}

/**
 * Builds one verified statement from the selected call, row and fields. The subject and the values
 * come from the tool result only; a field that does not exist or is empty in that row is refused.
 */
function buildFact(raw: RawFact, index: number, calls: ReadonlyMap<string, CallRecord>, rejected: string[]): VerifiedFact | null {
  const position = `Факт ${index + 1}`;
  const call = calls.get(raw.call);
  if (!call) {
    rejected.push(`${position}: ссылка на запрос, которого не было.`);
    return null;
  }
  const fields = [...new Set([...raw.fields, ...(raw.fields.includes("record_details") ? call.tool.fields.filter(field => (field.kind === "protected" || field.kind === "financial") && call.result.rows[raw.row]?.values[field.key] != null).map(field => field.key) : [])])];
  const aggregate = fields.filter((field) => field === "$count" || field === "$total");
  if (aggregate.length) {
    if (aggregate.length !== fields.length) rejected.push(`${position}: количество записей нельзя смешивать с полями записи.`);
    const values: FactValue[] = [];
    for (const field of aggregate) {
      const value = field === "$count" ? call.result.rows.length : call.result.total;
      if (value === null) {
        rejected.push(`${position}: общее количество записей неизвестно.`);
        continue;
      }
      values.push({ field, label: field === "$count" ? "Показано записей" : "Всего записей", value: String(value) });
    }
    return values.length ? { subject: `Результат: ${toolTitle(call.tool)}`, values, source: { tool: call.tool.name, row: -1 } } : null;
  }
  const row = call.result.rows[raw.row];
  if (!row || raw.row < 0) {
    rejected.push(`${position}: в результате «${toolTitle(call.tool)}» нет записи ${raw.row + 1}.`);
    return null;
  }
  const values: FactValue[] = [];
  for (const key of fields) {
    const field = call.tool.fields.find((item) => item.key === key);
    const value = field ? row.values[key] : undefined;
    if (!field) {
      rejected.push(`${position}: поле не входит в результат «${toolTitle(call.tool)}».`);
      continue;
    }
    if (value === undefined || value === null) {
      rejected.push(`${position}: у объекта «${row.subject}» нет значения «${field.label}».`);
      continue;
    }
    values.push({ field: key, label: field.label, value: formatValue(field, value), ...(field.kind === "protected" || field.kind === "financial" ? { kind: field.kind } : {}) });
  }
  if (!values.length) return null;
  const href = link(row.entity);
  return { subject: row.subject, values, source: { tool: call.tool.name, row: raw.row }, ...(href ? { link: { label: row.subject, href } } : {}) };
}

/** Turns the model's selection into a verified answer; the server's own notes are always appended. */
export function verifyAnswer(raw: RawAnswer, calls: ReadonlyMap<string, CallRecord>): AgentAnswer {
  const rejected: string[] = [];
  const facts: VerifiedFact[] = [];
  raw.facts.forEach((item, index) => {
    const fact = buildFact(item, index, calls, rejected);
    if (fact) facts.push(fact);
  });
  // Catalogue pages are assembled by code; never let a model omit part of the requested list.
  if ([...calls.values()].some(call => call.tool.name === "find_products")) {
    for (let i = facts.length - 1; i >= 0; i--) if (facts[i].source.tool === "find_products") facts.splice(i, 1);
  }
  for (const [id, call] of calls) if (call.tool.name === "find_products") {
    const complete = buildFact({ call: id, row: 0, fields: ["product_list", "products_total", "products_shown"] }, facts.length, calls, rejected);
    if (complete) {
      complete.link = { label: "Справочник товаров", href: `/products?q=${encodeURIComponent(String(call.result.rows[0]?.values.search_query ?? ""))}` };
      facts.push(complete);
    }
  }
  // A requested system page is rendered completely by code, rather than depending on how many
  // of its records the model selected (its JSON schema has a smaller fact limit).
  for(let index=facts.length-1;index>=0;index--) if(["search_system","get_system_record"].includes(facts[index].source.tool) && facts[index].source.row>=0) facts.splice(index,1);
  for (const [id, call] of calls) if (["search_system", "get_system_record"].includes(call.tool.name)) {
    const countOnly=raw.facts.some(fact=>fact.call===id && fact.fields.every(field=>field==="$count"||field==="$total"));
    if (countOnly) continue;
    call.result.rows.forEach((_,row)=>{
      const fact=buildFact({call:id,row,fields:["record_details"]},facts.length,calls,rejected);
      if(fact) facts.push(fact);
    });
  }
  // Free text is never verified: masked, stripped of links and shown apart from the facts.
  const commentary: Commentary[] = raw.commentary
    .map((item) => ({ kind: item.kind, text: cleanText(item.text) }))
    .filter((item) => item.text.length > 0);
  // Model-written limitations are not checked either, so they may not carry numbers, dates or identifiers.
  const limitations = raw.limitations.map(cleanText).filter((item) => item && !/\d/.test(item));
  for (const [, call] of calls) {
    for (const note of call.result.notes) if (!limitations.includes(note)) limitations.push(note);
    if (call.result.truncated && call.tool.name !== "find_products") {
      const note = `${toolTitle(call.tool)}: показаны не все записи (${call.result.rows.length}${call.result.total !== null ? ` из ${call.result.total}` : ""}).`;
      if (!limitations.includes(note)) limitations.push(note);
    }
  }
  if (!facts.length) limitations.unshift("Проверенных данных Nexus в ответе нет.");
  return { facts, commentary, rejected, limitations, toolsUsed: [...new Set([...calls.values()].map((call) => call.tool.name))] };
}
