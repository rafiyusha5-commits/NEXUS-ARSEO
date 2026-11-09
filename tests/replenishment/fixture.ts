import type { Snapshot } from "../../src/lib/replenishment/calculate.ts";
export function fixture(): Snapshot {
  return { asOf: "2026-11-08", historyStart: "2026-11-01", historyEnd: "2026-11-07", settings: {
    aktobe: "ACT", astana: "AST", almaty: "ALA", productionDays: 5, transitDays: 3, cityDays: 2, reviewDays: 4,
    transferDays: 1, historyDays: 7, serviceZ: 0, historyConfirmed: true,
    overrides: [{ productId: "P", city: "astana", daily: 10, reason: "Стартовый спрос" }, { productId: "P", city: "almaty", daily: 5, reason: "Стартовый спрос" }],
  }, products: [{ id: "P", sku: "SKU", name: "Товар", shelfDays: 540, multiple: 10, minimum: 0 }], sales: [], supplies: [], commitments: [], warnings: [] };
}
