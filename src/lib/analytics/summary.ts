// The counts of /analytics, computed by public.operational_summary() (audit 2026-10-13, finding Н8). A block the
// person has no permission for is absent; a malformed value reads as absent rather than as zero.

export type StatusCounts = [status: string, count: number][];

export type OperationalSummary = {
  today: string | null;
  shipments: { total: number; active: number; late: number; byStatus: StatusCounts } | null;
  stages: { blocked: number; late: number; attention: number } | null;
  sales: { total: number; open: number; late: number; byStatus: StatusCounts } | null;
  inventory: { risk: number } | null;
  tasks: { open: number; late: number } | null;
};

type Row = Record<string, unknown>;

const record = (value: unknown): Row | null => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : null);

function count(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function counts<K extends string>(value: unknown, keys: readonly K[]): Record<K, number> | null {
  const row = record(value);
  if (!row) return null;
  const result = {} as Record<K, number>;
  for (const key of keys) {
    const parsed = count(row[key]);
    if (parsed === null) return null;
    result[key] = parsed;
  }
  return result;
}

function byStatus(value: unknown): StatusCounts {
  const row = record(value);
  if (!row) return [];
  return Object.entries(row)
    .flatMap(([status, raw]): StatusCounts => {
      const parsed = count(raw);
      return parsed && parsed > 0 ? [[status, parsed]] : [];
    })
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function parseOperationalSummary(value: unknown): OperationalSummary {
  const row = record(value) ?? {};
  const shipments = counts(row.shipments, ["total", "active", "late"] as const);
  const sales = counts(row.sales, ["total", "open", "late"] as const);
  return {
    today: typeof row.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.today) ? row.today : null,
    shipments: shipments ? { ...shipments, byStatus: byStatus(record(row.shipments)?.by_status) } : null,
    stages: counts(row.stages, ["blocked", "late", "attention"] as const),
    sales: sales ? { ...sales, byStatus: byStatus(record(row.sales)?.by_status) } : null,
    inventory: counts(row.inventory, ["risk"] as const),
    tasks: counts(row.tasks, ["open", "late"] as const),
  };
}
