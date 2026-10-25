import type { SystemSection } from "./system-registry.ts";

/** Safe, fixed metadata only. Never expose database exception text or user values. */
export class SearchInputError extends Error {
  constructor(message: string) { super(message); }
}

export function validateSearchInput(section: SystemSection, params: Record<string, string | number>) {
  const links = section.columns.filter(key => key.endsWith("_id"));
  const hints = `Раздел ${section.key}. Текстовый поиск: ${section.search.length ? section.search.join(", ") : "нет; убери query"}. Связи: ${links.join(", ") || "нет"}. Дата: ${section.date || "нет"}. Статус: ${section.columns.includes("status") ? "status" : "нет; убери status"}.`;
  const badQuery = params.query && !section.search.length && section.key !== "calendar";
  const badStatus = params.status && !section.columns.includes("status") && section.key !== "calendar";
  const badDate = (params.date || params.date_to) && !section.date && section.key !== "calendar";
  const badLink = params.related_by && (!links.includes(String(params.related_by)) || (section.rpc && params.related_by !== section.parent));
  const missingLink = params.parent_id && !(params.related_by || section.parent);
  if (badQuery || badStatus || badDate || badLink || missingLink) throw new SearchInputError(hints);
}
