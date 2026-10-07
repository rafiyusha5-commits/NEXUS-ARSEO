import { normalizeProductName } from "../document-extraction/esf.ts";

// Normalised view of one shipment for the export workbook. It is built from the flat generation
// data (shipment card + confirmed source documents) and contains no spreadsheet knowledge.

export type ExportOutput = "workbook" | "cmr" | "ttn" | "packing_list";

export type ExportBatch = { quantity: number | null; expiryDate: string | null };

export type ExportItem = {
  productName: string;
  hsCode: string;
  supplierSku: string;
  countryOfOrigin: string;
  boxBarcode: string;
  pieces: number | null;
  batches: ExportBatch[];
  unitPrice: number | null;
  /** kg of net product per piece: the reference workbook keeps it inside the row formulas (`=E*0.19`). */
  netPerPieceKg: number | null;
  piecesPerBox: number | null;
  pallets: number | null;
  grossWeightKg: number | null;
};

export type ExportModel = {
  orderNumber: string;
  orderDate: string;
  shippingDate: string;
  driverName: string;
  driverDocument: string;
  vehiclePlate: string;
  vehicleMake: string;
  trailerPlate: string;
  trailerMake: string;
  carrierName: string;
  ttnNumber: string;
  loadingCity: string;
  loadingCountry: string;
  goodsCategory: string;
  palletCount: number | null;
  temperature: string;
  seals: string;
  loadingAddress: string;
  unloadingAddress: string;
  unloadingCountry: string;
  cmrNumber: string;
  waybillNumber: string;
  esfNumber: string;
  invoiceNumber: string;
  packingListNumber: string;
  hsCodes: string;
  paymentTerms: string;
  contractNumber: string;
  contractDate: string;
  sellerName: string;
  sellerTaxId: string;
  sellerCountry: string;
  sellerAddress: string;
  sellerCorrespondenceAddress: string;
  sellerPhone: string;
  buyerName: string;
  buyerTaxId: string;
  buyerKpp: string;
  buyerCountry: string;
  buyerAddress: string;
  bankDetails: string;
  senderTitle: string;
  items: ExportItem[];
  includesPrices: boolean;
  /** Differences between the shipment and the confirmed invoice, for the pre-flight check. */
  invoiceNotes: string[];
};

const COUNTRIES: Record<string, string> = {
  KZ: "Казахстан", RU: "Российская Федерация", FI: "Финляндия", BY: "Беларусь", KG: "Кыргызстан", UZ: "Узбекистан", AM: "Армения",
  DE: "Германия", PL: "Польша", TR: "Турция", CN: "Китай", IT: "Италия", FR: "Франция", ES: "Испания", NL: "Нидерланды", LT: "Литва", LV: "Латвия", EE: "Эстония", SE: "Швеция",
};

export const countryName = (value: unknown) => {
  const text = str(value);
  return /^[A-Z]{2}$/.test(text) ? COUNTRIES[text] ?? text : text;
};

export function str(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/ /g, " ").trim();
}

export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number(String(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

const positive = (value: number | null) => value !== null && value > 0 ? value : null;
const isoDate = (value: unknown) => {
  const text = str(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const ru = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text);
  return ru ? `${ru[3]}-${ru[2].padStart(2, "0")}-${ru[1].padStart(2, "0")}` : "";
};

const rows = (value: unknown) => Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => !!row && typeof row === "object") : [];

export function formatRuDate(iso: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : iso;
}

/**
 * Matches the lines of the confirmed electronic invoice to shipment items (by product name, then by
 * HS code and quantity). The invoice price is the selling price printed on CMR and ТТН, so it replaces
 * any other price of a matched item, but only when prices were requested; the HS code only fills a gap.
 */
function reconcileWithInvoice(items: ExportItem[], lines: Array<Record<string, unknown>>, withPrices: boolean) {
  const notes: string[] = [];
  if (!lines.length) return notes;
  const invoice = lines.map(line => ({ name: str(line.product_name), hs: str(line.hs_code), quantity: num(line.quantity), price: num(line.unit_price) }));
  const used = new Set<number>();
  items.forEach((item, index) => {
    const key = normalizeProductName(item.productName);
    let found = invoice.findIndex((line, position) => !used.has(position) && !!key && normalizeProductName(line.name) === key);
    if (found < 0) found = invoice.findIndex((line, position) => !used.has(position) && !!line.hs && line.hs === item.hsCode && line.quantity !== null && line.quantity === item.pieces);
    const title = `Позиция ${index + 1}${item.productName ? ` «${item.productName}»` : ""}`;
    if (found < 0) { notes.push(`${title}: не найдена среди строк инвойса`); return; }
    used.add(found);
    const line = invoice[found];
    if (withPrices && line.price !== null && line.price > 0) item.unitPrice = line.price;
    if (!item.hsCode && line.hs) item.hsCode = line.hs;
    if (line.hs && item.hsCode && line.hs !== item.hsCode) notes.push(`${title}: код ТН ВЭД ${item.hsCode} в поставке, ${line.hs} в инвойсе`);
    if (line.quantity !== null && item.pieces !== null && Math.abs(line.quantity - item.pieces) > 1e-6) notes.push(`${title}: ${item.pieces} шт. в поставке, ${line.quantity} шт. в инвойсе`);
  });
  invoice.forEach((line, position) => { if (!used.has(position)) notes.push(`Строка инвойса «${line.name}» (${line.quantity ?? "?"} шт.) отсутствует в поставке`); });
  return notes;
}

export function buildExportModel(data: Record<string, unknown>): ExportModel {
  const transports = rows(data.transports);
  const first = transports[0] ?? {};
  const pick = (key: string) => str(data[key]) || str(first[key]);
  const items: ExportItem[] = rows(data.items).map(item => {
    const pieces = positive(num(item.piece_count)) ?? (str(item.uom) === "piece" ? positive(num(item.ordered_quantity)) : null);
    const boxes = positive(num(item.box_count));
    const net = positive(num(item.total_net_weight_kg));
    const declaredBatches = rows(item.batches).map(batch => ({ quantity: positive(num(batch.quantity)), expiryDate: isoDate(batch.expiry_date) || null }));
    const batches = declaredBatches.length ? declaredBatches : [{ quantity: pieces, expiryDate: isoDate(item.expiry_date) || null }];
    return {
      productName: str(item.product_name),
      hsCode: str(item.hs_code),
      supplierSku: str(item.supplier_sku) || str(item.internal_sku),
      countryOfOrigin: countryName(item.country_of_origin),
      boxBarcode: str(item.box_barcode) || str(item.gtin) || str(item.unit_barcode),
      pieces,
      batches,
      unitPrice: positive(num(item.unit_price)),
      netPerPieceKg: net !== null && pieces ? net / pieces : null,
      piecesPerBox: pieces && boxes ? pieces / boxes : null,
      pallets: num(item.pallet_count),
      grossWeightKg: positive(num(item.total_gross_weight_kg)),
    };
  });
  const invoiceNotes = reconcileWithInvoice(items, rows(data.invoice_lines), data.prices_included === true);
  const includesPrices = items.some(item => item.unitPrice !== null);
  const hsCodes = str(data.hs_codes) || [...new Set(items.map(item => item.hsCode).filter(Boolean))].join(", ");
  // A load is counted in whole pallets: per-line fractions (a pallet shared by two products) are rounded up in the total only.
  const summed = items.length && items.every(item => item.pallets !== null) ? Math.ceil(items.reduce((sum, item) => sum + (item.pallets ?? 0), 0) - 1e-9) : null;
  const palletCount = num(data.pallet_count) ?? summed;
  return {
    orderNumber: str(data.order_number) || str(data.project_code) || str(data.shipment_number),
    orderDate: isoDate(data.order_date) || isoDate(data.planned_ready_date),
    shippingDate: isoDate(data.shipping_date) || isoDate(first.actual_loading_date) || isoDate(first.planned_loading_date) || isoDate(data.planned_ready_date),
    driverName: pick("driver_name"),
    driverDocument: pick("driver_document"),
    vehiclePlate: pick("vehicle_plate"),
    vehicleMake: pick("vehicle_make"),
    trailerPlate: pick("trailer_plate"),
    trailerMake: pick("trailer_make"),
    carrierName: pick("carrier_name"),
    ttnNumber: str(data.ttn_number),
    loadingCity: str(data.loading_city),
    loadingCountry: countryName(data.loading_country) || countryName(data.supplier_country),
    goodsCategory: str(data.goods_category),
    palletCount,
    temperature: pick("temperature_setpoint"),
    seals: str(data.seals),
    loadingAddress: str(data.loading_address),
    unloadingAddress: str(data.unloading_address) || str(data.destination_address),
    unloadingCountry: countryName(data.unloading_country) || countryName(data.customer_country),
    cmrNumber: str(data.cmr_number),
    waybillNumber: str(data.waybill_number),
    esfNumber: str(data.esf_number),
    invoiceNumber: str(data.invoice_number),
    packingListNumber: str(data.packing_list_number),
    hsCodes,
    paymentTerms: str(data.payment_terms) || [str(data.incoterms), str(data.contract_number) ? `Договор № ${str(data.contract_number)}${isoDate(data.contract_date) ? ` от ${formatRuDate(isoDate(data.contract_date))}` : ""}` : ""].filter(Boolean).join(", "),
    contractNumber: str(data.contract_number),
    contractDate: isoDate(data.contract_date),
    sellerName: str(data.supplier_name),
    sellerTaxId: str(data.supplier_tax_id),
    sellerCountry: countryName(data.supplier_country),
    sellerAddress: str(data.supplier_address),
    sellerCorrespondenceAddress: str(data.seller_correspondence_address) || str(data.supplier_address),
    sellerPhone: str(data.seller_phone),
    buyerName: str(data.customer_name),
    buyerTaxId: str(data.customer_tax_id),
    buyerKpp: str(data.customer_kpp),
    buyerCountry: countryName(data.customer_country),
    buyerAddress: str(data.customer_address),
    bankDetails: str(data.bank_details),
    senderTitle: str(data.sender_signatory),
    items,
    includesPrices,
    invoiceNotes,
  };
}

export const contractLabel = (model: ExportModel) => model.contractNumber
  ? `№ ${model.contractNumber}${model.contractDate ? ` от ${formatRuDate(model.contractDate)}` : ""}`
  : "";
export const partiesLabel = (model: ExportModel) => model.sellerName && model.buyerName ? `${model.sellerName} и ${model.buyerName}` : "";
