import { fullCargoGross, palletWeightColumn, validPalletWeight, type CargoOperation } from "./pallet-weight.ts";

export type ShipmentLoadLine = {
  itemId: string;
  productId: string;
  transportId: string | null;
  quantity: number;
  uom: string;
  pieces: number | null;
  boxes: number | null;
  pallets: number | null;
  netWeightKg: number | null;
  grossWeightKg: number | null;
  boxedGrossWeightKg: number | null;
  grossWithPalletsKg: number | null;
  warnings: string[];
};

export type ShipmentLoadSummary = {
  lines: ShipmentLoadLine[];
  pieces: number | null;
  boxes: number | null;
  pallets: number | null;
  netWeightKg: number | null;
  grossWeightKg: number | null;
  boxedGrossWeightKg: number | null;
  grossWithPalletsKg: number | null;
  warnings: string[];
};

export function sumShipmentLoadLines(lines: ShipmentLoadLine[]) {
  const total = (key: "pieces" | "boxes" | "pallets" | "netWeightKg" | "grossWeightKg" | "boxedGrossWeightKg" | "grossWithPalletsKg") => {
    const known = lines.map((line) => line[key]).filter((value): value is number => value !== null);
    return known.length && known.length === lines.length ? known.reduce((sum, value) => sum + value, 0) : null;
  };
  return {
    pieces: total("pieces"),
    boxes: total("boxes"),
    pallets: total("pallets"),
    netWeightKg: total("netWeightKg"),
    grossWeightKg: total("grossWeightKg"),
    boxedGrossWeightKg: total("boxedGrossWeightKg"),
    grossWithPalletsKg: total("grossWithPalletsKg"),
  };
}

const numeric = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const quantityFor = (item: Record<string, unknown>) =>
  numeric(item.shipped_quantity) ?? numeric(item.confirmed_quantity) ?? numeric(item.ordered_quantity) ?? 0;

export function buildShipmentLoadSummary(
  items: Array<Record<string, unknown>>,
  packaging: Array<Record<string, unknown>>,
  context?: { operation: CargoOperation; transports: Array<Record<string, unknown>> },
): ShipmentLoadSummary {
  const byProduct = new Map<string, Map<string, Record<string, unknown>>>();
  for (const pack of packaging) {
    const productId = String(pack.product_id ?? "");
    const uom = String(pack.uom ?? "");
    const levels = byProduct.get(productId) ?? new Map<string, Record<string, unknown>>();
    levels.set(uom, pack);
    byProduct.set(productId, levels);
  }

  const lines = items.map((item): ShipmentLoadLine => {
    const itemId = String(item.id ?? "");
    const productId = String(item.product_id ?? "");
    const uom = String(item.uom ?? "piece");
    const quantity = quantityFor(item);
    const levels = byProduct.get(productId) ?? new Map<string, Record<string, unknown>>();
    const selected = levels.get(uom);
    const piece = levels.get("piece");
    const box = levels.get("box");
    const pallet = levels.get("pallet");
    const selectedFactor = uom === "piece" ? 1 : numeric(selected?.units_per_parent);
    const pieces = selectedFactor === null ? null : quantity * selectedFactor;
    const boxFactor = numeric(box?.units_per_parent);
    const palletFactor = numeric(pallet?.units_per_parent);
    const boxes = pieces !== null && boxFactor ? pieces / boxFactor : null;
    const pallets = pieces !== null && palletFactor ? pieces / palletFactor : null;

    const directGross = numeric(selected?.gross_weight_kg);
    const directNet = numeric(selected?.net_weight_kg);
    const pieceGross = numeric(piece?.gross_weight_kg);
    const pieceNet = numeric(piece?.net_weight_kg);
    const boxGross = numeric(box?.gross_weight_kg);
    const boxNet = numeric(box?.net_weight_kg);
    const boxedGrossWeightKg = boxes !== null && boxGross !== null && boxGross > 0 ? boxes * boxGross : null;
    const transport = context?.transports.find(t => t.id === item.shipment_transport_id);
    const tare = context ? validPalletWeight(transport?.[palletWeightColumn(context.operation)]) : null;
    const grossWithPalletsKg = fullCargoGross(boxedGrossWeightKg, pallets, tare);
    const grossWeightKg = directGross !== null && directGross > 0
      ? quantity * directGross
      : boxGross !== null && boxGross > 0 && boxes !== null
        ? boxes * boxGross
        : pieceGross !== null && pieceGross > 0 && pieces !== null ? pieces * pieceGross : null;
    const netWeightKg = directNet !== null && directNet > 0
      ? quantity * directNet
      : boxNet !== null && boxNet > 0 && boxes !== null
        ? boxes * boxNet
        : pieceNet !== null && pieceNet > 0 && pieces !== null ? pieces * pieceNet : null;

    const warnings: string[] = [];
    if (pieces === null) warnings.push(`Не задан перевод «${uom}» в штуки`);
    if (boxes === null) warnings.push("Не задано количество штук в коробе");
    if (pallets === null) warnings.push("Не задано количество штук на паллете");
    if (netWeightKg === null) warnings.push("Не хватает данных для веса нетто");
    if (grossWeightKg === null) warnings.push("Не хватает данных для веса брутто");
    if (context && boxedGrossWeightKg === null) warnings.push("Не задан вес брутто короба");
    if (context && tare === null) warnings.push("Укажите вес паллеты для выбранной операции у автомобиля (20–25 кг)");
    if (context && pallets !== null && !Number.isInteger(pallets)) warnings.push("Расчёт даёт неполные паллеты: полное брутто требует сверки фактической упаковки");
    if (!item.shipment_transport_id) warnings.push("Товар не распределён по автомобилю");

    return {
      itemId,
      productId,
      transportId: item.shipment_transport_id ? String(item.shipment_transport_id) : null,
      quantity,
      uom,
      pieces,
      boxes,
      pallets,
      netWeightKg,
      grossWeightKg,
      boxedGrossWeightKg,
      grossWithPalletsKg,
      warnings,
    };
  });

  const totals = sumShipmentLoadLines(lines);

  return {
    lines,
    ...totals,
    warnings: lines.flatMap((line) => line.warnings.map((warning) => `${line.itemId}: ${warning}`)),
  };
}
