import type { CalculatorImportPackage } from "./parser.ts";

export type CalculatorQualityIssue = {
  row: number | null;
  sku: string;
  kind: "missing" | "quantity" | "weight";
  message: string;
};

type PackagingLevel = {
  uom: string;
  units_per_parent: number;
  net_weight_kg?: number;
  gross_weight_kg?: number;
};

const format = (value: number) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(value);

export function auditCalculatorPackaging(pkg: CalculatorImportPackage): CalculatorQualityIssue[] {
  const issues: CalculatorQualityIssue[] = [];
  const rowsBySku = new Map(pkg.source.rows.map((row) => [row.internal_sku, row.row]));

  for (const product of pkg.reference.products) {
    const row = rowsBySku.get(product.internal_sku) ?? null;
    const levels = new Map((product.packaging as PackagingLevel[]).map((level) => [level.uom, level]));
    const piece = levels.get("piece");
    const box = levels.get("box");
    const pallet = levels.get("pallet");
    const truck = levels.get("truck");
    const add = (kind: CalculatorQualityIssue["kind"], message: string) => {
      issues.push({ row, sku: product.internal_sku, kind, message });
    };

    for (const [uom, label] of [["box", "короб"], ["pallet", "паллета"], ["truck", "машина"]] as const) {
      if (!levels.has(uom)) add("missing", `Не заполнен уровень «${label}»`);
    }

    for (const [level, label] of [[box, "коробе"], [pallet, "паллете"], [truck, "машине"]] as const) {
      if (level && !Number.isInteger(level.units_per_parent)) {
        add("quantity", `Количество штук в ${label} должно быть целым: ${format(level.units_per_parent)}`);
      }
    }

    if (box && pallet) {
      const boxes = pallet.units_per_parent / box.units_per_parent;
      if (!Number.isInteger(boxes)) {
        add("quantity", `${format(pallet.units_per_parent)} штук на паллете не делятся без остатка на ${format(box.units_per_parent)} штук в коробе`);
      }
    }
    if (pallet && truck) {
      const pallets = truck.units_per_parent / pallet.units_per_parent;
      if (!Number.isInteger(pallets)) {
        add("quantity", `${format(truck.units_per_parent)} штук в машине не делятся без остатка на ${format(pallet.units_per_parent)} штук на паллете`);
      }
    }

    if (piece?.net_weight_kg && piece.gross_weight_kg && piece.gross_weight_kg < piece.net_weight_kg) {
      add("weight", `Брутто единицы ${format(piece.gross_weight_kg)} кг меньше нетто ${format(piece.net_weight_kg)} кг`);
    }
    if (piece?.net_weight_kg) {
      for (const [level, label] of [[box, "короба"], [pallet, "паллеты"], [truck, "машины"]] as const) {
        if (!level?.gross_weight_kg) continue;
        const minimum = piece.net_weight_kg * level.units_per_parent;
        if (level.gross_weight_kg + 0.001 < minimum) {
          add("weight", `Брутто ${label} ${format(level.gross_weight_kg)} кг меньше суммарного нетто товара ${format(minimum)} кг`);
        }
      }
    }
  }

  return issues.sort((left, right) => (left.row ?? Number.MAX_SAFE_INTEGER) - (right.row ?? Number.MAX_SAFE_INTEGER));
}
