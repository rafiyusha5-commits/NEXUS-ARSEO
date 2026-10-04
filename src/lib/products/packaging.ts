const packagingOrder: Record<string, number> = {
  piece: 0,
  box: 1,
  layer: 2,
  pallet: 3,
  truck: 4,
};

const contentsNames: Record<string, string> = {
  box: "штук",
  layer: "коробов",
  pallet: "коробов",
  truck: "паллет",
};

function formatNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(parsed)
    : "—";
}

export function sortPackagingLevels<T extends { uom: string }>(levels: readonly T[]) {
  return [...levels].sort(
    (left, right) => (packagingOrder[left.uom] ?? 99) - (packagingOrder[right.uom] ?? 99),
  );
}

export function packagingContentsLabel(uom: string, unitsPerParent: unknown) {
  if (uom === "piece") return "базовая единица";
  return `${formatNumber(unitsPerParent)} ${contentsNames[uom] ?? "единиц"}`;
}
