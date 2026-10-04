const packagingOrder: Record<string, number> = {
  piece: 0,
  box: 1,
  layer: 2,
  pallet: 3,
  truck: 4,
};

function formatNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(parsed)
    : "—";
}

function wholeRatio(total: number, divisor: number) {
  if (!Number.isFinite(total) || !Number.isFinite(divisor) || divisor <= 0) return null;
  const ratio = total / divisor;
  return Number.isInteger(ratio) ? ratio : null;
}

function russianCount(value: number, forms: [string, string, string]) {
  const integer = Math.abs(Math.trunc(value));
  const lastTwo = integer % 100;
  const last = integer % 10;
  const form = lastTwo >= 11 && lastTwo <= 14
    ? forms[2]
    : last === 1
      ? forms[0]
      : last >= 2 && last <= 4
        ? forms[1]
        : forms[2];
  return `${formatNumber(value)} ${form}`;
}

export function sortPackagingLevels<T extends { uom: string }>(levels: readonly T[]) {
  return [...levels].sort(
    (left, right) => (packagingOrder[left.uom] ?? 99) - (packagingOrder[right.uom] ?? 99),
  );
}

type PackagingLevel = { uom: string; units_per_parent: unknown };

export function packagingContentsLabel(
  uom: string,
  unitsPerParent: unknown,
  levels: readonly PackagingLevel[] = [],
) {
  if (uom === "piece") return "базовая единица";
  const pieces = Number(unitsPerParent);
  if (!Number.isFinite(pieces)) return "— штук";

  const details = [`${formatNumber(pieces)} штук`];
  const boxPieces = Number(levels.find((level) => level.uom === "box")?.units_per_parent);
  const palletPieces = Number(levels.find((level) => level.uom === "pallet")?.units_per_parent);

  if (uom === "pallet" || uom === "truck") {
    const boxes = wholeRatio(pieces, boxPieces);
    if (boxes !== null) details.push(russianCount(boxes, ["короб", "короба", "коробов"]));
  }
  if (uom === "truck") {
    const pallets = wholeRatio(pieces, palletPieces);
    if (pallets !== null) details.splice(1, 0, russianCount(pallets, ["паллета", "паллеты", "паллет"]));
  }

  return details.join(" · ");
}
