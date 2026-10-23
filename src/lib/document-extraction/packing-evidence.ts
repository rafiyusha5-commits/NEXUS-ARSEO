import { commodityUnit, type CommodityLine } from "./commodity-evidence.ts";

export type PackingEvidence = { number: string | null; items: { sku: string; quantity: number; unit: string }[]; total: number | null; warnings: string[] };
export const packingNumber = (value: string) => value.trim().toUpperCase().replace(/^WZ\s*/u, "").replace(/\s+/gu, "");

// Known Despatch Note layout: boxes (pieces), followed by weight/expiry. Never interpret weight as quantity.
// Lot rows repeat a SKU; original and translation remain separate evidence, not extra cargo.
export function parsePackingEvidence(raw: string): PackingEvidence | null {
  if (!/\bD[EI]SPATCH\s+NOTE\b/iu.test(raw)) return null;
  const result: PackingEvidence = { number: raw.match(/\bWZ\s+([\d/A-Z.-]+)/iu)?.[1] ?? null, items: [], total: null, warnings: [] };
  const candidates = raw.split(/\r?\n/u).filter(line => /^\s*\d+\s+\d{5,10}\s+\d{12,14}\b/u.test(line));
  for (const line of candidates) {
    const match = line.match(/^\s*\d+\s+(\d{5,10})\s+\d{12,14}\b.*?\s+\d+\s*\(\s*(\d+)\s*\)/u);
    if (!match) { result.warnings.push("Не прочитано количество одной из строк упаковочного листа"); continue; }
    result.items.push({ sku: match[1], quantity: Number(match[2]), unit: "piece" });
  }
  const totals = [...raw.matchAll(/\bTotal\s*:\s*\d+\s*\(\s*(\d+)\s*\)/giu)];
  if (totals.length === 1) result.total = Number(totals[0][1]);
  if (!result.number || !result.items.length || result.total === null || result.items.reduce((n, row) => n + row.quantity, 0) !== result.total) {
    result.warnings.push("Полнота упаковочного листа не подтверждена номером и итогом штук");
  }
  return result;
}
export function isPackingEvidence(value: unknown): value is PackingEvidence {
  if (!value || typeof value !== "object") return false;
  const p = value as PackingEvidence;
  return (p.number === null || typeof p.number === "string") && (p.total === null || Number.isFinite(p.total))
    && Array.isArray(p.warnings) && p.warnings.every(w => typeof w === "string") && Array.isArray(p.items)
    && p.items.every(row => row && typeof row.sku === "string" && Number.isFinite(row.quantity) && row.quantity >= 0 && typeof row.unit === "string");
}
export function comparePackingQuantities(items: CommodityLine[], references: string[], sources: PackingEvidence[]) {
  const refs = [...new Set(references.map(packingNumber))];
  const candidates = refs.length === 1 ? sources.filter(p => p.number && packingNumber(p.number) === refs[0]) : [];
  if (!items.length || !candidates.length || candidates.some(p => p.warnings.length || !p.items.length || p.total === null || p.items.reduce((n, r) => n + r.quantity, 0) !== p.total))
    return { matched: false, message: "Упаковочный лист: недостаточно данных, проверьте чтение и ссылку из ДТ", differences: [] as string[] };
  const aggregate = (rows: { sku: string | null; quantity: number | null; unit: string | null }[]) => {
    const map = new Map<string, number>();
    for (const row of rows) {
      if (!row.sku || row.quantity === null || !commodityUnit(row.unit)) return null;
      const key = `${row.sku} (${commodityUnit(row.unit)})`;
      map.set(key, (map.get(key) ?? 0) + row.quantity);
    }
    return [...map].sort(([a], [b]) => a.localeCompare(b));
  };
  const declared = aggregate(items), packing = candidates.map(p => aggregate(p.items));
  if (!declared || packing.some(p => !p) || new Set(packing.map(p => JSON.stringify(p))).size !== 1)
    return { matched: false, message: "Упаковочный лист: единицы не определены либо оригинал и перевод расходятся", differences: [] as string[] };
  const left = new Map(declared), right = new Map(packing[0]!);
  const differences = [...new Set([...left.keys(), ...right.keys()])].filter(k => !left.has(k) || !right.has(k) || Math.abs(left.get(k)! - right.get(k)!) > 0.000001)
    .map(k => `${k}: ДТ ${left.get(k) ?? "нет"}; упаковочный лист ${right.get(k) ?? "нет"}`);
  return { matched: !differences.length, message: differences.length ? "ДТ и упаковочный лист: есть расхождения" : "ДТ и упаковочный лист: состав и количества совпадают; перевод не удваивает груз", differences };
}
