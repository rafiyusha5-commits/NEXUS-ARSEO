// Fact checking of the model's final answer. A reference to a tool is not proof: every number,
// date, identifier and status word in a FACT block must equal a referenced field of an actual
// tool result, and the values shown to the user are rendered by this code from that result.
import { ALL_STATUS_LABELS } from "./labels.ts";
import { maskSensitive } from "./masking.ts";
import type { AgentAnswer, AgentTool, AnswerBlock, AnswerValue, ToolField, ToolResult } from "./types.ts";

export const ANSWER_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["blocks", "limitations"],
  properties: {
    blocks: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "text", "refs"],
        properties: {
          kind: { type: "string", enum: ["fact", "assumption"] },
          text: { type: "string", maxLength: 600 },
          refs: {
            type: "array",
            maxItems: 8,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["call", "row", "field"],
              properties: { call: { type: "string" }, row: { type: "integer" }, field: { type: "string" } },
            },
          },
        },
      },
    },
    limitations: { type: "array", maxItems: 5, items: { type: "string", maxLength: 300 } },
  },
};

export type CallRecord = { tool: AgentTool; result: ToolResult };

type RawRef = { call: string; row: number; field: string };
type RawBlock = { kind: "fact" | "assumption"; text: string; refs: RawRef[] };
type RawAnswer = { blocks: RawBlock[]; limitations: string[] };

/** Strict structural validation of the model's JSON; any extra or missing key rejects it. */
export function parseAnswer(content: string | null): RawAnswer | null {
  if (!content || content.length > 20_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  const exact = (object: unknown, keys: string[]) =>
    typeof object === "object" && object !== null && !Array.isArray(object)
    && Object.keys(object).length === keys.length && keys.every((key) => key in (object as object));
  if (!exact(value, ["blocks", "limitations"])) return null;
  const answer = value as RawAnswer;
  if (!Array.isArray(answer.blocks) || answer.blocks.length > 12 || !Array.isArray(answer.limitations) || answer.limitations.length > 5) return null;
  for (const block of answer.blocks) {
    if (!exact(block, ["kind", "text", "refs"]) || (block.kind !== "fact" && block.kind !== "assumption")) return null;
    if (typeof block.text !== "string" || block.text.length > 600 || !Array.isArray(block.refs) || block.refs.length > 8) return null;
    for (const ref of block.refs) {
      if (!exact(ref, ["call", "row", "field"]) || typeof ref.call !== "string" || typeof ref.field !== "string" || !Number.isInteger(ref.row)) return null;
    }
  }
  if (!answer.limitations.every((item) => typeof item === "string" && item.length <= 300)) return null;
  return answer;
}

const DATE_FORMAT = new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Qyzylorda", day: "2-digit", month: "2-digit", year: "numeric" });
const DATETIME_FORMAT = new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Qyzylorda", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
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

/** All spellings of a value the model may legitimately use in text. */
function variants(field: ToolField | null, value: string | number): Set<string> {
  const out = new Set<string>();
  const add = (text: string) => {
    const normalized = normalizeToken(text);
    if (!normalized) return;
    out.add(normalized);
    for (const part of normalized.split(/[^\p{L}\p{N}]+/u)) if (/\d/.test(part)) out.add(part);
  };
  add(String(value));
  if (typeof value === "number") {
    add(String(value).replace(".", ","));
    add(NUMBER_FORMAT.format(value).replace(/\s/g, ""));
    for (const part of NUMBER_FORMAT.format(value).split(/\s/)) add(part);
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-");
    for (const text of [`${day}.${month}.${year}`, `${day}.${month}`, `${Number(day)}.${month}.${year}`, `${day}.${month}.${year.slice(2)}`, `${Number(day)}`, year]) add(text);
  }
  if (field?.kind === "datetime" && typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    const formatted = DATETIME_FORMAT.format(new Date(value));
    add(formatted);
    for (const part of formatted.split(/[\s,]+/)) add(part);
    const date = DATE_FORMAT.format(new Date(value));
    add(date);
    add(date.slice(0, 5));
  }
  return out;
}

function normalizeToken(token: string): string {
  return token.toLowerCase().replace(/^[(«"']+|[)».,:;!?"'\-/]+$/g, "").replace(/ /g, " ").trim();
}

function digitTokens(text: string): string[] {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}\-_./:]*/gu) ?? []).map(normalizeToken).filter((token) => /\d/.test(token));
}

const COMPLETENESS = /(?<![\p{L}])(все|всего|полный\s+список|полностью|только\s+эти|исчерпывающ\p{L}*)(?![\p{L}])/iu;
const URL = /\bhttps?:\/\/\S+|\bwww\.\S+|\[([^\]]*)\]\([^)]*\)/gi;

function cleanText(text: string): string {
  return maskSensitive(text.replace(URL, (_m, linkText?: string) => linkText ?? "").replace(/\s+/g, " ").trim()).text;
}

function link(entity: { type: string; id: string } | undefined): string | undefined {
  if (!entity) return undefined;
  if (entity.type === "shipment") return `/shipments/${entity.id}`;
  if (entity.type === "document") return `/documents/${entity.id}`;
  if (entity.type === "task") return "/tasks";
  return undefined;
}

const STATUS_WORDS: string[] = [...new Set(Object.values(ALL_STATUS_LABELS).flatMap((map) => Object.values(map)))]
  .sort((a, b) => b.length - a.length);

function verifyFact(block: RawBlock, calls: ReadonlyMap<string, CallRecord>): AnswerBlock {
  const text = cleanText(block.text);
  if (!block.refs.length) return { kind: "unverified", text, reason: "Нет ссылки на данные Nexus." };
  const values: AnswerValue[] = [];
  const allowed = new Set<string>();
  const statusValues = new Set<string>();
  const links = new Map<string, string>();
  let truncated = false;
  for (const ref of block.refs) {
    const call = calls.get(ref.call);
    if (!call) return { kind: "unverified", text, reason: "Ссылка на несуществующий запрос." };
    truncated ||= call.result.truncated;
    if (ref.field === "$count" || ref.field === "$total") {
      const value = ref.field === "$count" ? call.result.rows.length : call.result.total;
      if (value === null) return { kind: "unverified", text, reason: "Общее количество неизвестно." };
      for (const item of variants(null, value)) allowed.add(item);
      values.push({ label: ref.field === "$count" ? "Показано записей" : "Всего записей", value: String(value), tool: call.tool.name, row: -1, field: ref.field });
      continue;
    }
    const row = call.result.rows[ref.row];
    const field = call.tool.fields.find((item) => item.key === ref.field);
    const value = row?.values[ref.field];
    if (!row || !field || value === undefined || value === null) return { kind: "unverified", text, reason: "Ссылка на отсутствующее поле результата." };
    for (const item of variants(field, value)) allowed.add(item);
    if (field.kind === "status") statusValues.add(String(value).toLowerCase());
    const href = link(row.entity);
    values.push({ label: field.label, value: formatValue(field, value), tool: call.tool.name, row: ref.row, field: ref.field, ...(href ? { link: href } : {}) });
    if (href) links.set(href, row.values.shipment_number ? String(row.values.shipment_number) : field.label);
  }
  const unmatched = digitTokens(text).filter((token) => !allowed.has(token) && !allowed.has(token.replace(/\s/g, "")));
  if (unmatched.length) return { kind: "unverified", text, reason: `Значение не совпадает с данными: ${unmatched.slice(0, 3).join(", ")}.` };
  const lower = text.toLowerCase();
  for (const word of STATUS_WORDS) {
    const lowered = word.toLowerCase();
    if (new RegExp(`(?<![\\p{L}])${lowered.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "iu").test(lower) && !statusValues.has(lowered)) {
      return { kind: "unverified", text, reason: `Статус «${word}» не подтверждён данными.` };
    }
  }
  if (truncated && COMPLETENESS.test(text)) return { kind: "unverified", text, reason: "Результат неполный, утверждать полноту нельзя." };
  return { kind: "fact", text, values, links: [...links].map(([href, label]) => ({ label, href })) };
}

/** Turns the model's JSON into a verified answer; the server's own notes are always appended. */
export function verifyAnswer(raw: RawAnswer, calls: ReadonlyMap<string, CallRecord>): AgentAnswer {
  const blocks: AnswerBlock[] = raw.blocks.map((block) =>
    block.kind === "assumption" ? { kind: "assumption", text: cleanText(block.text) } : verifyFact(block, calls));
  // Model-written limitations are not fact-checked, so they may not carry numbers, dates or identifiers.
  const limitations = raw.limitations.map(cleanText).filter((item) => item && !/\d/.test(item));
  for (const [, call] of calls) {
    for (const note of call.result.notes) if (!limitations.includes(note)) limitations.push(note);
    if (call.result.truncated) {
      const note = `${call.tool.description.split(".")[0]}: показаны не все записи (${call.result.rows.length}${call.result.total !== null ? ` из ${call.result.total}` : ""}).`;
      if (!limitations.includes(note)) limitations.push(note);
    }
  }
  if (!blocks.length) blocks.push({ kind: "unverified", text: "Ассистент не сформировал ответ по данным Nexus.", reason: "Пустой ответ." });
  return { blocks, limitations, toolsUsed: [...new Set([...calls.values()].map((call) => call.tool.name))] };
}
