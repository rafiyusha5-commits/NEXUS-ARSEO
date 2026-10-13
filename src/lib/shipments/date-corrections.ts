// Real dates of an executed shipment: the form shows every stored date as a calendar day in Almaty and sends
// back only the days the employee changed; the database keeps the time of a day that stays the same.

export const BUSINESS_TIME_ZONE = "Asia/Almaty";

/** A stored moment as the calendar day shown to the employee (YYYY-MM-DD), or "" when there is none. */
export function businessDay(value: string | null | undefined) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const moment = new Date(value);
  if (Number.isNaN(moment.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(moment);
}

export type DateChanges = {
  stages: Array<{ id: string; started_on?: string; completed_on?: string }>;
  transports: Array<{ id: string; actual_loading_date?: string; actual_arrival_date?: string }>;
  receipts: Array<{ id: string; received_on?: string }>;
};

const FIELDS: Array<[prefix: string, group: keyof DateChanges, key: string]> = [
  ["stage_started_", "stages", "started_on"],
  ["stage_completed_", "stages", "completed_on"],
  ["transport_loading_", "transports", "actual_loading_date"],
  ["transport_arrival_", "transports", "actual_arrival_date"],
  ["receipt_", "receipts", "received_on"],
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Form fields "<prefix><id>" with the day and "orig_<prefix><id>" with the day shown before. Only changed,
 * non-empty days are returned: a stored date is never cleared from this form.
 */
export function readDateChanges(entries: Iterable<[string, unknown]>) {
  const values = new Map<string, string>();
  for (const [key, raw] of entries) if (typeof raw === "string") values.set(key, raw.trim());
  const changes: DateChanges = { stages: [], transports: [], receipts: [] };
  const byId = new Map<string, Record<string, string>>();
  let count = 0;
  for (const [key, value] of values) {
    const field = FIELDS.find(([prefix]) => key.startsWith(prefix));
    if (!field || !value) continue;
    const [prefix, group, name] = field;
    const id = key.slice(prefix.length);
    if (!UUID.test(id)) throw new Error("Некорректная запись в форме дат");
    if (!DAY.test(value)) throw new Error("Укажите дату в формате ГГГГ-ММ-ДД");
    if (values.get(`orig_${key}`) === value) continue;
    let entry = byId.get(`${group}:${id}`);
    if (!entry) {
      entry = { id };
      byId.set(`${group}:${id}`, entry);
      (changes[group] as Array<Record<string, string>>).push(entry);
    }
    entry[name] = value;
    count += 1;
  }
  return { changes, count };
}
