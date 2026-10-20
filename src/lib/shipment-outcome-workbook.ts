import type { XlsxCell, XlsxSheet } from "./xlsx.ts";
import type { BatchOutcome, DocumentCheckFinding } from "./shipment-outcome-rules.ts";

// Sheets of the final report in the XLSX export, from the same data as the page. A block the employee may not
// see becomes a one-line sheet saying so, never an empty table that looks like "nothing happened".

type OutcomeForWorkbook = {
  today: string;
  inventoryVisible: boolean;
  salesVisible: boolean;
  outcomes: BatchOutcome[];
  products: Map<string, { internal_sku: string; name: string }>;
  summary: { units: Array<{ uom: string; received: number; issued: number; writtenOff: number; onHand: number; reserved: number }>; balanced: boolean; batches: number };
  cost: { version: number; status: string; approvedAt: string | null; currency: string | null; goodsTotal: number; expensesTotal: number; landedTotal: number; items: Array<{ shipmentItemId: string; quantity: number; costQuantity?: number; landedAmount: number; unitLandedCost: number }> } | null | "hidden";
  documentCheck: { lastRunAt: string | null; findings: DocumentCheckFinding[]; counts: { errors: number; warnings: number } } | "hidden";
  shelfLife: Array<{ batchId: string; state: string; firstDeadline: string | null }> | "hidden";
};
type ItemRef = { id: string; uom: string; product: unknown };

const shelfState: Record<string, string> = { expired: "Просрочена", below: "Ниже требований клиентов", soon: "Скоро ниже требований" };

export function outcomeWorkbookSheets(outcome: OutcomeForWorkbook, items: readonly ItemRef[]): XlsxSheet[] {
  const summary: XlsxCell[][] = [["Показатель", "Ед.", "Значение"], ["Дата отчёта", "", outcome.today]];
  if (!outcome.inventoryVisible) summary.push(["Движение партий", "", "Нет права просматривать склад"]);
  for (const unit of outcome.summary.units) {
    summary.push(["Принято на склад", unit.uom, unit.received], ["Отгружено и продано", unit.uom, unit.issued], ["Списано", unit.uom, unit.writtenOff], ["На складе", unit.uom, unit.onHand], ["В резерве", unit.uom, unit.reserved]);
  }
  if (outcome.inventoryVisible) summary.push(["Движения и остатки", "", !outcome.summary.batches ? "Нет партий" : outcome.summary.balanced ? "Сходятся" : "Есть расхождение"]);
  summary.push(["Себестоимость", outcome.cost && outcome.cost !== "hidden" ? outcome.cost.currency : "",
    outcome.cost === "hidden" ? "Нет доступа" : outcome.cost ? outcome.cost.landedTotal : "Не рассчитана"]);
  summary.push(["«Сверка»", "", outcome.documentCheck === "hidden" ? "Нет доступа" : `Ошибок: ${outcome.documentCheck.counts.errors}, предупреждений: ${outcome.documentCheck.counts.warnings}`]);
  summary.push(["«Контроль ОСГ»", "", outcome.shelfLife === "hidden" ? "Нет доступа" : outcome.shelfLife.length ? outcome.shelfLife.map(entry => shelfState[entry.state] ?? entry.state).join(", ") : "Риска нет"]);

  const shelf = outcome.shelfLife === "hidden" ? new Map() : new Map(outcome.shelfLife.map(entry => [entry.batchId, entry]));
  const flows: XlsxCell[][] = [["Партия", "Артикул", "Товар", "Срок годности", "ОСГ, %", "Риск ОСГ", "Ед.", "Принято", "Отгружено", "Списано", "Корректировки +", "Корректировки −", "На складе", "В резерве", "Сходится", "Покупатели"]];
  for (const entry of outcome.outcomes) {
    const product = outcome.products.get(entry.batch.product_id);
    const customers = outcome.salesVisible
      ? entry.customers.map(customer => `${customer.saleNumber} ${customer.customerName ?? "клиент скрыт"}: ${customer.fulfilled ? `отгружено ${customer.fulfilled}` : `резерв ${customer.reserved}`} ${customer.uom}`).join("; ")
      : "Нет права просматривать заказы";
    for (const flow of entry.flows) {
      const risk = shelf.get(entry.batch.id);
      flows.push([entry.batch.batch_number, product?.internal_sku, product?.name, entry.batch.expiry_date, entry.remainingPct, risk ? shelfState[risk.state] ?? risk.state : "", flow.uom,
        flow.received, flow.issued, flow.writtenOff, flow.adjustedIn, flow.adjustedOut, flow.onHand, flow.reserved, flow.balanced ? "да" : "НЕТ", customers]);
    }
  }
  const sheets: XlsxSheet[] = [{ name: "Итог", rows: summary }, { name: "Движение партий", rows: outcome.inventoryVisible ? flows : [["Нет права просматривать склад"]] }];

  if (outcome.cost !== "hidden") {
    const itemById = new Map(items.map(item => [item.id, item]));
    const sku = (item: ItemRef | undefined) => { const product = item?.product as { internal_sku?: string } | Array<{ internal_sku?: string }> | null | undefined; return Array.isArray(product) ? product[0]?.internal_sku : product?.internal_sku; };
    sheets.push({ name: "Себестоимость", rows: outcome.cost ? [
      ["Версия", outcome.cost.version], ["Статус", outcome.cost.status === "approved" ? "утверждена" : "черновик"], ["Валюта", outcome.cost.currency],
      ["Товар", outcome.cost.goodsTotal], ["Расходы", outcome.cost.expensesTotal], ["Себестоимость поставки", outcome.cost.landedTotal], [],
      ["Артикул", "Ед.", "Количество по приёмке/карточке", "Расчётное количество", "Себестоимость позиции", "За единицу"],
      ...outcome.cost.items.map(row => { const item = itemById.get(row.shipmentItemId); return [sku(item), item?.uom, row.quantity, row.costQuantity ?? row.quantity, row.landedAmount, row.unitLandedCost]; }),
    ] : [["Расчёт себестоимости ещё не выполнен"]] });
  }
  if (outcome.documentCheck !== "hidden") {
    sheets.push({ name: "Сверка", rows: [["Важность", "Автомобиль", "Замечание", "Документ"], ...outcome.documentCheck.findings.map(finding => [finding.severity === "error" ? "Ошибка" : "Предупреждение", finding.transport_no ?? "", finding.message, finding.document_title ?? ""])] });
  }
  return sheets;
}
