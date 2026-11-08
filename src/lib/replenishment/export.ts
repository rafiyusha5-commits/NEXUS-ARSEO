import { createXlsx } from "../xlsx.ts";
import { calculate, type Snapshot } from "./calculate.ts";
import { cityName } from "./workspace.ts";
export function exportCalculation(snapshot: Snapshot, runId: string): Buffer {
  const result = calculate(snapshot);
  return createXlsx([
    { name: "Заказ — предложение", rows: [
      ["ПРЕДЛОЖЕНИЕ, НЕ УТВЕРЖДЁННЫЙ ЗАКАЗ", runId], ["Дата", result.asOf, "Алгоритм", result.version],
      ["Артикул", "Город", "Спрос, шт.", "Страховой запас", "Запас в расчёте", "Приход в расчёте", "Предложение перемещения", "Закупка без неподтверждённых перемещений", "После подтверждения перемещений", "Замечания"],
      ...result.lines.map(l => [l.sku, cityName(l.city), l.demand, l.safety, l.usable, l.inbound, l.proposedTransfer, l.purchase, l.afterTransfers, [...l.blockers, ...l.notes].join("; ")]),
    ] },
    { name: "Перемещения", rows: [["Источник", "Товар", "Со склада", "Город", "Штук", "Ожидаемое прибытие"], ...result.transfers.map(t => [t.supplyId, snapshot.products.find(p => p.id === t.productId)?.sku, t.from, cityName(t.to), t.quantity, t.arrival])] },
    { name: "Риски ОСГ", rows: [["Артикул", "Партия", "Штук под риском", "Последний день", "Уровень", "Пояснение"], ...result.risks.map(r => [r.sku, r.batch, r.quantity, r.deadline, r.level, r.message])] },
    { name: "Основания", rows: [["История с", snapshot.historyStart, "по", snapshot.historyEnd], ["Горизонт до", result.horizonEnd], ["Google Drive и Sheets", "Только чтение; обратной записи нет"], ["Решение", "Нужны проверка и штатное согласование"], ...Object.entries(snapshot.settings).filter(([, v]) => typeof v !== "object").map(([k, v]) => [k, String(v)]), ...result.warnings.map(w => [w])] },
  ]);
}
