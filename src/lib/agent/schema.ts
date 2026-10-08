// Strict parameter schemas: unknown fields, wrong types and out-of-range values are rejected.
import type { ParamSchema } from "./types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ValidationResult = { ok: true; value: Record<string, string | number> } | { ok: false; error: string };

export function validateParams(schema: Record<string, ParamSchema>, input: unknown): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "PARAMS_NOT_OBJECT" };
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!(key in schema)) return { ok: false, error: `PARAM_UNKNOWN:${key}` };
  const value: Record<string, string | number> = {};
  for (const [key, rule] of Object.entries(schema)) {
    const raw = record[key];
    if (raw === undefined || raw === null || raw === "") {
      if (rule.optional) continue;
      return { ok: false, error: `PARAM_REQUIRED:${key}` };
    }
    if (rule.type === "integer") {
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < rule.min || raw > rule.max) return { ok: false, error: `PARAM_INVALID:${key}` };
      value[key] = raw;
      continue;
    }
    if (typeof raw !== "string") return { ok: false, error: `PARAM_INVALID:${key}` };
    if (rule.type === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw)) || new Date(raw).toISOString().slice(0, 10) !== raw)) return { ok: false, error: `PARAM_INVALID:${key}` };
    if (rule.type === "uuid" && !UUID.test(raw)) return { ok: false, error: `PARAM_INVALID:${key}` };
    if (rule.type === "enum" && !rule.values.includes(raw)) return { ok: false, error: `PARAM_INVALID:${key}` };
    if (rule.type === "string") {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.length > rule.maxLength || (rule.pattern && !rule.pattern.test(trimmed))) return { ok: false, error: `PARAM_INVALID:${key}` };
      value[key] = trimmed;
      continue;
    }
    value[key] = raw;
  }
  return { ok: true, value };
}

/** JSON schema for strict function calling: every property listed, optional ones nullable. */
export function toJsonSchema(schema: Record<string, ParamSchema>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(schema)) {
    const nullable = (type: string) => (rule.optional ? [type, "null"] : type);
    if (rule.type === "integer") properties[key] = { type: nullable("integer"), minimum: rule.min, maximum: rule.max, description: rule.description };
    else if (rule.type === "enum") properties[key] = { type: nullable("string"), enum: rule.optional ? [...rule.values, null] : [...rule.values], description: rule.description };
    else if (rule.type === "uuid") properties[key] = { type: nullable("string"), description: `${rule.description} (UUID)` };
    else if (rule.type === "date") properties[key] = { type: nullable("string"), description: `${rule.description} (YYYY-MM-DD, календарная дата)` };
    else properties[key] = { type: nullable("string"), maxLength: rule.maxLength, description: rule.description };
  }
  return { type: "object", properties, required: Object.keys(schema), additionalProperties: false };
}

/** Parses tool-call arguments; malformed JSON is a rejected call, never a guess. */
export function parseArguments(raw: string): unknown {
  if (raw.length > 4000) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
