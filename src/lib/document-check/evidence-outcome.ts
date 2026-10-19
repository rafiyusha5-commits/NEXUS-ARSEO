import type { CommodityComparison } from "../document-extraction/commodity-evidence.ts";

// Presentation of the existing comparison, never a second matching/quantity calculation.
export function evidenceOutcome(comparisons: CommodityComparison[], current: boolean, reviewed: boolean, warnings: string[]) {
  if (!current) return { reading: "Актуальность и доступ не подтверждены", comparison: "Сверка недоступна", differences: [] as string[] };
  const differences = comparisons.flatMap(row => row.orderedDelta === null || row.orderedDelta === 0 ? [] : [
    `${row.line.sku ?? "Строка"}: ${row.orderedDelta > 0 ? "+" : ""}${row.orderedDelta.toLocaleString("ru-RU", { maximumFractionDigits: 6 })} ${row.line.unit ?? ""} к заказу`,
  ]);
  const complete = comparisons.length > 0 && warnings.length === 0 && comparisons.every(row => row.line.warnings.length === 0);
  return {
    reading: reviewed ? "Чтение декларации подтверждено сотрудником" : "Чтение декларации ещё не подтверждено",
    comparison: complete && comparisons.every(row => row.invoiceMatched)
      ? "ДТ и инвойс: проверенные артикулы, количества и суммы совпадают"
      : "ДТ и инвойс: есть расхождения или недостаточно данных — см. строки ниже",
    differences,
  };
}
