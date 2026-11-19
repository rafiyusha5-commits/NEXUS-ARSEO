export type SchemaColumn = {
  key: string; block: string | null; field_ru: string;
  visibility: "catalog" | "sales" | "confidential" | "calculated";
};
export type CalculatorSchemaReview = {
  status: "unchanged" | "approval_required" | "blocked" | "approved";
  current_count: number; incoming_count: number; expected_schema: string | null;
  added: SchemaColumn[]; removed: SchemaColumn[];
  changed: { before: SchemaColumn; after: SchemaColumn }[];
};
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function column(value: unknown): value is SchemaColumn {
  return record(value) && typeof value.key === "string" && value.key.length > 0
    && typeof value.field_ru === "string" && (value.block === null || typeof value.block === "string")
    && ["catalog", "sales", "confidential", "calculated"].includes(String(value.visibility));
}
export function parseCalculatorSchemaReview(value: unknown): CalculatorSchemaReview | null {
  if (!record(value) || !["unchanged", "approval_required", "blocked", "approved"].includes(String(value.status))
    || !Number.isInteger(value.current_count) || !Number.isInteger(value.incoming_count)
    || Number(value.current_count) < 0 || Number(value.incoming_count) < 1 || Number(value.incoming_count) > 500
    || !(value.expected_schema === null || (typeof value.expected_schema === "string" && /^[a-f0-9]{64}$/.test(value.expected_schema)))
    || !Array.isArray(value.added) || !value.added.every(column)
    || !Array.isArray(value.removed) || !value.removed.every(column)
    || !Array.isArray(value.changed) || !value.changed.every(c => record(c) && column(c.before) && column(c.after))) return null;
  if (["approval_required", "approved"].includes(String(value.status))
    && (!value.expected_schema || !value.added.length || value.removed.length || value.changed.length)) return null;
  return value as CalculatorSchemaReview;
}

// The approval and application both require a new read of the exact complete
// source snapshot seen by the employee. No cached source data is applied.
export function calculatorSnapshotMatches(mode: "preview" | "apply" | "approve-schema", actual: string, expected?: string) {
  return mode === "preview" || (typeof expected === "string" && /^[a-f0-9]{64}$/.test(expected) && expected === actual);
}
