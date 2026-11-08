/** Deterministic planning only. Never changes stock, reservations or supplier orders. */
export const ALGORITHM = "kz-daily-fefo-v1";
export type City = "astana" | "almaty";
export type Settings = {
  aktobe: string; astana: string; almaty: string;
  productionDays: number; transitDays: number; cityDays: number; reviewDays: number;
  transferDays: number; historyDays: number; serviceZ: number;
  historyConfirmed: boolean;
  overrides: { productId: string; city: City; daily: number; reason: string }[];
};
export type Product = { id: string; sku: string; name: string; shelfDays: number | null; multiple: number | null; minimum: number };
export type Demand = { id: string; productId: string; city: City; customerId: string; date: string; quantity: number; requiredPct: number };
export type Supply = {
  id: string; productId: string; warehouseId: string; batch: string;
  quantity: number; expiry: string | null; manufactured: string | null;
  availableOn: string; kind: "stock" | "inbound";
  purpose: "kz" | "export" | "unknown"; city: City | null;
  usable: boolean; conversionKnown: boolean; step?: number;
};
export type Snapshot = {
  asOf: string; historyStart: string; historyEnd: string; settings: Settings;
  products: Product[]; sales: Demand[]; supplies: Supply[];
  commitments: { productId: string; city: City; quantity: number; reserved: number; requiredPct?: number }[];
  warnings: string[];
};
export type Risk = { supplyId: string; sku: string; batch: string; quantity: number; deadline: string | null; level: "critical" | "warning" | "unknown"; message: string };
export type Transfer = { supplyId: string; productId: string; from: string; to: City; quantity: number; arrival: string };
export type Line = {
  productId: string; sku: string; city: City; daily: number; demand: number; forecastDemand: number;
  safety: number; usable: number; inbound: number; proposedTransfer: number;
  shortage: number; purchase: number; afterTransfers: number; excludedExport: number;
  unknown: number; firstShortage: string | null; blockers: string[]; notes: string[];
};
export type Calculation = { version: string; asOf: string; horizonEnd: string; lines: Line[]; transfers: Transfer[]; risks: Risk[]; warnings: string[] };
const DAY = 86400000;
export function day(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Некорректная дата расчёта");
  const n = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(n) || new Date(n).toISOString().slice(0, 10) !== value) throw new Error("Некорректная дата расчёта");
  return n / DAY;
}
export const date = (n: number): string => new Date(n * DAY).toISOString().slice(0, 10);
const round = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
function positive(n: number, label: string, zero = true) {
  if (!Number.isFinite(n) || n < (zero ? 0 : Number.MIN_VALUE) || n > 1e9) throw new Error(`Некорректное значение: ${label}`);
}
/** Same two-decimal percentage as private.sale_shelf_life_pct; dates are business dates. */
export function shelfPct(supply: Pick<Supply, "expiry" | "manufactured">, shelfDays: number | null, on: number): number | null {
  if (!supply.expiry) return null;
  const duration = supply.manufactured ? day(supply.expiry) - day(supply.manufactured) : shelfDays;
  if (duration === null || duration <= 0) return null;
  return Math.round(Math.min(100, Math.max(0, 100 * (day(supply.expiry) - on) / duration)) * 100 + 1e-8) / 100;
}
export function lastEligible(supply: Supply, product: Product, pct: number): number | null {
  if (!supply.expiry || shelfPct(supply, product.shelfDays, day(supply.expiry)) === null) return null;
  let lo = supply.manufactured ? day(supply.manufactured) : day(supply.expiry) - product.shelfDays!;
  let hi = day(supply.expiry);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (shelfPct(supply, product.shelfDays, mid)! >= pct) lo = mid; else hi = mid - 1;
  }
  return lo;
}
function unique<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Map<string, T>();
  for (const r of rows) {
    if (!r.id) throw new Error("Источник без устойчивого идентификатора");
    const previous = seen.get(r.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(r)) throw new Error("Противоречащие версии одного источника");
    seen.set(r.id, r);
  }
  return [...seen.values()];
}
export function calculate(input: Snapshot): Calculation {
  const s = input.settings, start = day(input.asOf), historyStart = day(input.historyStart), historyEnd = day(input.historyEnd);
  const horizon = s.productionDays + s.transitDays + s.cityDays + s.reviewDays;
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 366 || historyEnd >= start || historyEnd < historyStart) throw new Error("Проверьте горизонт и историю");
  for (const v of [s.productionDays, s.transitDays, s.cityDays, s.reviewDays, s.transferDays]) if (!Number.isInteger(v) || v < 0 || v > 365) throw new Error("Некорректный срок доставки");
  if (new Set([s.aktobe, s.astana, s.almaty]).size !== 3 || !s.aktobe || !s.astana || !s.almaty) throw new Error("Выберите три разных склада");
  if (!Number.isFinite(s.serviceZ) || s.serviceZ < 0 || s.serviceZ > 3) throw new Error("Проверьте страховой запас");
  const products = unique(input.products), sales = unique(input.sales), supplies = unique(input.supplies);
  const productIds = new Set(products.map(p => p.id));
  for (const row of sales) {
    positive(row.quantity, "продажи"); day(row.date);
    if (!productIds.has(row.productId) || !["astana", "almaty"].includes(row.city) || row.requiredPct < 0 || row.requiredPct > 100 || !Number.isFinite(row.requiredPct)) throw new Error("Некорректный источник спроса");
  }
  for (const row of supplies) {
    positive(row.quantity, "запас"); day(row.availableOn);
    if (row.step !== undefined) positive(row.step, "единица перемещения", false);
    if (row.expiry) day(row.expiry); if (row.manufactured) day(row.manufactured);
    if (!productIds.has(row.productId)) throw new Error("Неизвестный товар в остатках");
  }
  const overrideKeys = new Set<string>();
  for (const row of s.overrides) {
    positive(row.daily, "ручной спрос");
    const key = `${row.productId}:${row.city}`;
    if (!productIds.has(row.productId) || !["astana", "almaty"].includes(row.city) || !row.reason.trim() || overrideKeys.has(key)) throw new Error("Проверьте ручной спрос и причину");
    overrideKeys.add(key);
  }
  const result: Calculation = { version: ALGORITHM, asOf: input.asOf, horizonEnd: date(start + horizon - 1), lines: [], transfers: [], risks: [], warnings: [...input.warnings] };
  const remaining = new Map(supplies.map(x => [x.id, x.quantity]));
  const protectedSafety = new Map<string, number>();
  const unmet = new Map<string, { on: number; pct: number; quantity: number }[]>();
  const channels = new Map<string, { pct: number; daily: number }[]>();
  const localWarehouse = (city: City) => s[city];
  for (const p of products) for (const city of ["astana", "almaty"] as const) {
    const history = sales.filter(r => r.productId === p.id && r.city === city && day(r.date) >= historyStart && day(r.date) <= historyEnd);
    const days = historyEnd - historyStart + 1;
    const quantities = Array.from({ length: days }, (_, i) => sum(history.filter(r => day(r.date) === historyStart + i).map(r => r.quantity)));
    const historicalDaily = sum(quantities) / days;
    const manual = s.overrides.find(r => r.productId === p.id && r.city === city);
    const daily = manual?.daily ?? historicalDaily;
    const sd = Math.sqrt(sum(quantities.map(q => (q - historicalDaily) ** 2)) / days);
    const safety = s.serviceZ * sd * Math.sqrt(horizon);
    const obligations = input.commitments.filter(o => o.productId === p.id && o.city === city);
    for (const o of obligations) { positive(o.quantity, "открытые заказы"); positive(o.reserved, "резервы"); if (o.reserved > o.quantity) throw new Error("Резерв превышает заказ"); if (o.requiredPct !== undefined && (!Number.isFinite(o.requiredPct) || o.requiredPct < 0 || o.requiredPct > 100)) throw new Error("Проверьте ОСГ открытого заказа"); }
    const reserved = sum(obligations.map(o => o.reserved));
    // Forecast includes known orders; reserved demand and reserved stock are both removed once.
    const forecastDemand = Math.max(daily * horizon, sum(obligations.map(o => o.quantity)));
    const demand = Math.max(0, forecastDemand - reserved);
    const rows = supplies.filter(r => r.productId === p.id);
    const line: Line = { productId: p.id, sku: p.sku, city, daily, demand: round(demand), forecastDemand, safety: round(safety), usable: 0, inbound: 0, proposedTransfer: 0, shortage: 0, purchase: 0, afterTransfers: 0, excludedExport: sum(rows.filter(r => r.purpose === "export").map(r => r.quantity)), unknown: sum(rows.filter(r => r.purpose === "unknown").map(r => r.quantity)), firstShortage: null, blockers: [], notes: [] };
    if (forecastDemand > daily * horizon) line.notes.push("Открытые заказы превышают оценку спроса: прогноз включает весь их объём, а закупка исключает уже зарезервированное количество");
    if (!s.historyConfirmed && !manual) line.blockers.push("Подтвердите полноту истории продаж, включая дни отсутствия товара, или задайте спрос с причиной");
    if (!history.length && !manual) line.blockers.push("Нет истории: задайте стартовый спрос, в том числе ноль с причиной");
    if (manual) line.notes.push(`Ручной спрос: ${manual.reason}`);
    if (!p.multiple || p.multiple <= 0) line.blockers.push("Не задана кратность упаковки");
    if (line.unknown) line.blockers.push("Есть товар с неизвестным назначением");
    if (rows.some(r => !r.conversionKnown)) line.blockers.push("Не удалось перевести единицы в штуки");
    if (rows.some(r => r.purpose === "kz" && r.usable && (!r.expiry || (!r.manufactured && !p.shelfDays)))) line.blockers.push("Уточните ОСГ доступного товара до решения о закупке");
    const total = sum(history.map(h => h.quantity));
    const requirements = [...new Set(history.map(h => h.requiredPct))].sort((a, b) => b - a);
    const known = sum(obligations.map(o => o.quantity - o.reserved));
    const residual = Math.max(0, demand - known);
    const pools = requirements.length ? requirements.map(pct => ({ pct, daily: residual / horizon * sum(history.filter(h => h.requiredPct === pct).map(h => h.quantity)) / total })) : [{ pct: 70, daily: residual / horizon }];
    pools.push(...obligations.filter(o => o.quantity > o.reserved).map(o => ({ pct: o.requiredPct ?? Math.max(70, ...requirements), daily: (o.quantity - o.reserved) / horizon })));
    pools.sort((a, b) => b.pct - a.pct);
    if (!requirements.length) line.notes.push("Для нового спроса ОСГ 70% — допущение до появления требований клиентов");
    channels.set(`${p.id}:${city}`, pools);
    const needs: { on: number; pct: number; quantity: number }[] = [];
    unmet.set(`${p.id}:${city}`, needs);
    const local = rows.filter(r => r.purpose === "kz" && r.usable && r.conversionKnown && (!r.city || r.city === city) && (r.kind === "stock" ? r.warehouseId === localWarehouse(city) : r.city === city));
    local.sort((a, b) => (a.expiry ?? "9999").localeCompare(b.expiry ?? "9999") || a.id.localeCompare(b.id));
    for (let t = start; t < start + horizon; t++) for (const pool of pools) {
      let need = pool.daily;
      for (const stock of local) {
        if (day(stock.availableOn) > t || stock.expiry === null || day(stock.expiry) < t) continue;
        if ((shelfPct(stock, p.shelfDays, t) ?? -1) < pool.pct) continue;
        const taken = Math.min(need, remaining.get(stock.id)!);
        remaining.set(stock.id, remaining.get(stock.id)! - taken); need -= taken;
        if (stock.kind === "stock") line.usable += taken; else line.inbound += taken;
      }
      if (need > 0.001) {
        needs.push({ on: t, pct: pool.pct, quantity: need });
        if (!line.firstShortage) line.firstShortage = date(t);
      }
    }
    line.usable = round(line.usable); line.inbound = round(line.inbound);
    // Eligible surplus can cover safety stock, but cannot be suggested to another city twice.
    let extra = safety;
    for (const stock of local) {
      if (day(stock.availableOn) >= start + horizon || (stock.expiry && day(stock.expiry) < start + horizon - 1)) continue;
      if ((shelfPct(stock, p.shelfDays, start + horizon - 1) ?? -1) < Math.max(...pools.map(x => x.pct))) continue;
      const taken = Math.min(extra, remaining.get(stock.id)!); remaining.set(stock.id, remaining.get(stock.id)! - taken); extra -= taken;
      protectedSafety.set(stock.id, (protectedSafety.get(stock.id) ?? 0) + taken);
      if (stock.kind === "stock") line.usable += taken; else line.inbound += taken;
    }
    if (extra > 0.001) needs.push({ on: start + horizon - 1, pct: Math.max(...pools.map(x => x.pct)), quantity: extra });
    line.shortage = round(Math.max(0, demand + safety - line.usable - line.inbound));
    result.lines.push(line);
  }
  // Only surplus after donor demand AND safety. An Aktobe quantity is allocated at most once.
  for (const line of [...result.lines].sort((a, b) => (a.firstShortage ?? "9999").localeCompare(b.firstShortage ?? "9999") || b.shortage - a.shortage || a.city.localeCompare(b.city))) {
    const p = products.find(p => p.id === line.productId)!;
    const candidates = supplies.filter(r => r.productId === p.id && r.purpose === "kz" && r.usable && r.conversionKnown && r.kind === "stock" && r.warehouseId !== s[line.city] && [s.aktobe, s.astana, s.almaty].includes(r.warehouseId) && (!r.city || r.city === line.city));
    for (const stock of candidates.sort((a, b) => (a.expiry ?? "9999").localeCompare(b.expiry ?? "9999") || a.id.localeCompare(b.id))) {
      const donor = result.lines.find(l => l.productId === p.id && s[l.city] === stock.warehouseId);
      if ((!stock.city && donor?.blockers.length) || line.blockers.length) continue;
      const arrival = Math.max(start, day(stock.availableOn)) + s.transferDays;
      if (arrival >= start + horizon || !stock.expiry || day(stock.expiry) < arrival) continue;
      // Only still-uncovered days/channels: local stock and earlier suggestions may
      // already cover every day before this batch loses the required shelf life.
      const needs = unmet.get(`${p.id}:${line.city}`)!.filter(need => need.on >= arrival && need.on <= day(stock.expiry!) && (shelfPct(stock, p.shelfDays, need.on) ?? -1) >= need.pct);
      const eligibleDemand = sum(needs.map(need => need.quantity));
      const step = Math.max(1, stock.step ?? 1);
      const quantity = Math.floor((Math.min(remaining.get(stock.id)!, Math.max(0, line.shortage - line.proposedTransfer), eligibleDemand) + 1e-8) / step) * step;
      if (quantity <= 0) continue;
      let allocation = quantity;
      for (const need of needs) { const taken = Math.min(allocation, need.quantity); need.quantity -= taken; allocation -= taken; }
      remaining.set(stock.id, remaining.get(stock.id)! - quantity); line.proposedTransfer += quantity;
      result.transfers.push({ supplyId: stock.id, productId: p.id, from: stock.warehouseId, to: line.city, quantity, arrival: date(arrival) });
    }
  }
  for (const line of result.lines) {
    const p = products.find(p => p.id === line.productId)!;
    const pack = p.multiple ?? 1;
    const rounded = (n: number) => n > 0.001 ? Math.ceil(Math.max(n, p.minimum) / pack) * pack : 0;
    line.purchase = rounded(line.shortage);
    line.afterTransfers = rounded(Math.max(0, line.shortage - line.proposedTransfer));
    if (line.proposedTransfer) line.notes.push("Уменьшение закупки возможно только после подтверждения перемещения; текущий заказ его не вычитает");
    if (line.firstShortage && day(line.firstShortage) < start + s.productionDays + s.transitDays + s.cityDays) line.notes.push("Дефицит раньше нового импорта: требуется отдельное решение");
  }
  for (const stock of supplies.filter(s => s.kind === "stock" && s.purpose === "kz" && s.quantity > 0)) {
    const p = products.find(p => p.id === stock.productId)!;
    const relevant = result.lines.filter(l => l.productId === p.id && (!stock.city || stock.city === l.city));
    const allPools = relevant.flatMap(l => channels.get(`${p.id}:${l.city}`) ?? []);
    const pools = allPools.some(pool => pool.daily > 0) ? allPools.filter(pool => pool.daily > 0) : allPools;
    const deadlines = pools.map(pool => lastEligible(stock, p, pool.pct)).filter((d): d is number => d !== null);
    const last = deadlines.length ? Math.max(...deadlines) : null;
    if (stock.expiry && day(stock.expiry) < start) result.risks.push({ supplyId: stock.id, sku: p.sku, batch: stock.batch, quantity: stock.quantity, deadline: stock.expiry, level: "critical", message: "Срок годности истёк" });
    else if (last === null) result.risks.push({ supplyId: stock.id, sku: p.sku, batch: stock.batch, quantity: stock.quantity, deadline: null, level: "unknown", message: "Недостаточно данных для ОСГ" });
    else if (last < start + horizon) {
      // An unconfirmed suggestion must not make an existing shelf-life risk disappear.
      const atRisk = remaining.get(stock.id)! + (protectedSafety.get(stock.id) ?? 0) + sum(result.transfers.filter(t => t.supplyId === stock.id).map(t => t.quantity));
      if (atRisk > 0.001) result.risks.push({ supplyId: stock.id, sku: p.sku, batch: stock.batch, quantity: round(atRisk), deadline: date(last), level: last < start + s.reviewDays ? "critical" : "warning", message: "Прогнозируемый остаток к последнему дню допустимого ОСГ; предложения перемещения требуют подтверждения" });
    }
  }
  return result;
}
