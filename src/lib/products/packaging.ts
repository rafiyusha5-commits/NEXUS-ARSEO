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

/** Pieces in one unit of the level (units_per_parent); null when the level is not set. */
export function piecesPerUnit(uom: string, levels: readonly PackagingLevel[]) {
  if (uom === "piece") return 1;
  const pieces = Number(levels.find((level) => level.uom === uom)?.units_per_parent);
  return Number.isFinite(pieces) && pieces > 0 ? pieces : null;
}

const thousandths = (value: number) => BigInt(Math.round(value * 1000));

/**
 * Exact conversion to the thousandth through the packaging, the same rule as private.convert_uom
 * in the database: null when a level is missing or the amount does not convert exactly.
 */
export function convertQuantity(quantity: number, from: string, to: string, levels: readonly PackagingLevel[]) {
  if (!Number.isFinite(quantity)) return null;
  if (from === to) return quantity;
  const fromPieces = piecesPerUnit(from, levels);
  const toPieces = piecesPerUnit(to, levels);
  if (fromPieces === null || toPieces === null) return null;
  // Thousandths in integers: quantity × pieces is in millionths, divided by thousandths of the target.
  const numerator = thousandths(quantity) * thousandths(fromPieces);
  const denominator = thousandths(toPieces);
  if (denominator === BigInt(0) || numerator % denominator !== BigInt(0)) return null;
  return Number(numerator / denominator) / 1000;
}
