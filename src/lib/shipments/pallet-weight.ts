export type CargoOperation = "purchase" | "sale";
export const operationLabel = { purchase: "Покупка / импорт", sale: "Продажа / экспорт" } as const;
export function cargoOperation(shipmentType: unknown): CargoOperation {
  return shipmentType === "export" ? "sale" : "purchase";
}
export function palletWeightColumn(operation: CargoOperation) {
  return operation === "sale" ? "sale_pallet_tare_kg" : "purchase_pallet_tare_kg";
}
export function validPalletWeight(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 20 && n <= 25 && Math.abs(n * 100 - Math.round(n * 100)) < 1e-7 ? n : null;
}
// A fractional packing capacity is not the number of physical pallets. Do not silently round it.
export function fullCargoGross(boxedKg: number | null, pallets: number | null, tare: number | null) {
  if (boxedKg === null || pallets === null || !Number.isInteger(pallets) || tare === null) return null;
  return boxedKg + pallets * tare;
}
