import "server-only";
import ExcelJS from "exceljs";

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const text = (value: unknown) => value === null || value === undefined ? "" : String(value);
const number = (value: unknown) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(text(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
};
const dateValue = (value: unknown) => {
  const raw = text(value);
  if (!raw) return "";
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
  const ru = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (ru) return new Date(Date.UTC(Number(ru[3]), Number(ru[2]) - 1, Number(ru[1])));
  return raw;
};
const rowStyle = (source: ExcelJS.Row, target: ExcelJS.Row) => {
  target.height = source.height;
  source.eachCell({ includeEmpty: true }, (cell, column) => {
    const output = target.getCell(column);
    output.style = { ...cell.style };
    output.numFmt = cell.numFmt;
    if (cell.alignment) output.alignment = { ...cell.alignment };
    if (cell.border) output.border = { ...cell.border };
    if (cell.fill) output.fill = { ...cell.fill };
    if (cell.font) output.font = { ...cell.font };
  });
};

const cellAddress = (column: number, row: number) => {
  let letters = "";
  for (let value = column; value > 0; value = Math.floor((value - 1) / 26)) {
    letters = String.fromCharCode(65 + ((value - 1) % 26)) + letters;
  }
  return `${letters}${row}`;
};

const rangeBounds = (range: string) => {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
  if (!match) return null;
  const column = (letters: string) => [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
  return { left: column(match[1]), top: Number(match[2]), right: column(match[3]), bottom: Number(match[4]) };
};

// ExcelJS does not reliably move merged ranges when rows are spliced. The ARSEO
// packing-list footer contains merged signature/address cells below the product
// table, so move those ranges explicitly before expanding the table.
const insertRowsPreservingMerges = (sheet: ExcelJS.Worksheet, start: number, count: number) => {
  if (count <= 0) return;
  const merges = [...(((sheet.model as unknown as { merges?: string[] }).merges) ?? [])];
  const moving = merges.map(range => ({ range, bounds: rangeBounds(range) })).filter(row => row.bounds && row.bounds.bottom >= start) as Array<{ range: string; bounds: NonNullable<ReturnType<typeof rangeBounds>> }>;
  for (const { range } of moving) sheet.unMergeCells(range);
  sheet.spliceRows(start, 0, ...Array.from({ length: count }, () => []));
  for (const { bounds } of moving) {
    const top = bounds.top >= start ? bounds.top + count : bounds.top;
    const bottom = bounds.bottom + count;
    sheet.mergeCells(`${cellAddress(bounds.left, top)}:${cellAddress(bounds.right, bottom)}`);
  }
};

function firstTransport(data: Record<string, unknown>) {
  const transports = Array.isArray(data.transports) ? data.transports as Array<Record<string, unknown>> : [];
  return transports[0] ?? {};
}

export async function renderShipmentWorkbookTemplate(template: Uint8Array, data: Record<string, unknown>) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(template) as never);
  const input = workbook.getWorksheet("данные");
  const lines = workbook.getWorksheet("для Диляры");
  const packing = workbook.getWorksheet("упаков.лист");
  if (!input || !lines || !packing || !workbook.getWorksheet("CMR") || !workbook.getWorksheet("ТТН")) {
    throw new Error("XLSX не соответствует эталонной книге отгрузки ARSEO: отсутствуют обязательные листы");
  }
  const transport = firstTransport(data);
  const values: Record<string, unknown> = {
    C2: data.order_number || data.project_code || data.shipment_number,
    C3: dateValue(data.order_date || data.planned_ready_date),
    C4: dateValue(data.shipping_date || data.actual_loading_date || transport.actual_loading_date || transport.planned_loading_date),
    C5: data.driver_name || transport.driver_name,
    C6: data.driver_document || transport.driver_document,
    C7: data.vehicle_plate || transport.vehicle_plate,
    C8: data.vehicle_make || transport.vehicle_make,
    C9: data.trailer_plate || transport.trailer_plate,
    C10: data.trailer_make || transport.trailer_make,
    C11: data.carrier_name || transport.carrier_name,
    C12: data.ttn_number,
    C13: data.loading_city,
    C14: data.loading_country || data.supplier_country,
    C15: data.goods_category,
    C16: number(data.pallet_count) || "",
    C17: data.temperature_setpoint || transport.temperature_setpoint,
    C18: data.seals,
    C19: data.unloading_address || data.destination_address,
    C20: data.cmr_number,
    C21: data.waybill_number,
    C22: data.esf_number,
    C24: data.hs_codes || [...new Set((Array.isArray(data.items) ? data.items : []).map(item => text((item as Record<string, unknown>).hs_code)).filter(Boolean))].join(", "),
    C25: data.payment_terms || data.incoterms || (data.contract_number ? `Договор № ${data.contract_number}` : ""),
    C27: data.packing_list_number,
    C28: data.loading_address,
  };
  for (const [coordinate, value] of Object.entries(values)) if (value !== "") input.getCell(coordinate).value = value as ExcelJS.CellValue;

  const items = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : [];
  const detailStart = 17, detailCapacity = 7, detailTotalBase = 24;
  // The supplied HS-41.1 sample merges the first two rows for one product with
  // two expiry batches. Generated rows represent independent positions, so the
  // inherited merges must be removed before values are written.
  for (const range of ["A17:A18", "B17:B18", "C17:C18", "H17:H18"]) {
    if (lines.getCell(range.split(":")[0]).isMerged) lines.unMergeCells(range);
  }
  if (items.length > detailCapacity) {
    const extra = items.length - detailCapacity;
    insertRowsPreservingMerges(lines, detailTotalBase, extra);
    for (let row = detailTotalBase; row < detailTotalBase + extra; row++) rowStyle(lines.getRow(detailStart), lines.getRow(row));
  }
  const detailTotal = detailTotalBase + Math.max(0, items.length - detailCapacity);
  for (let row = detailStart; row < detailTotal; row++) for (let col = 1; col <= 9; col++) lines.getCell(row, col).value = null;
  items.forEach((item, index) => {
    const row = detailStart + index;
    lines.getCell(row, 1).value = index + 1;
    lines.getCell(row, 2).value = text(item.hs_code);
    lines.getCell(row, 3).value = text(item.product_name);
    lines.getCell(row, 4).value = number(item.total_net_weight_kg) || number(item.net_weight_kg) * number(item.ordered_quantity) || "";
    lines.getCell(row, 5).value = number(item.ordered_quantity);
    lines.getCell(row, 6).value = number(item.unit_price) || "";
    lines.getCell(row, 7).value = { formula: `F${row}*E${row}` };
    lines.getCell(row, 8).value = text(item.supplier_sku || item.internal_sku);
    lines.getCell(row, 9).value = dateValue(item.expiry_date);
  });
  lines.getCell(detailTotal, 2).value = "ИТОГО";
  for (const column of [4, 5, 6, 7]) lines.getCell(detailTotal, column).value = { formula: `SUM(${String.fromCharCode(64 + column)}${detailStart}:${String.fromCharCode(64 + column)}${Math.max(detailStart, detailStart + items.length - 1)})` };
  input.getCell("C23").value = { formula: `'для Диляры'!G${detailTotal}` };

  const packingStart = 12, packingCapacity = 6, packingTotalBase = 18;
  if (items.length > packingCapacity) {
    const extra = items.length - packingCapacity;
    insertRowsPreservingMerges(packing, packingTotalBase, extra);
    for (let row = packingTotalBase; row < packingTotalBase + extra; row++) rowStyle(packing.getRow(packingStart), packing.getRow(row));
  }
  const packingTotal = packingTotalBase + Math.max(0, items.length - packingCapacity);
  for (let row = packingStart; row < packingTotal; row++) for (let col = 1; col <= 11; col++) packing.getCell(row, col).value = null;
  items.forEach((item, index) => {
    const row = packingStart + index;
    packing.getCell(row, 1).value = index + 1;
    packing.getCell(row, 2).value = text(item.country_of_origin);
    packing.getCell(row, 3).value = text(item.box_barcode || item.gtin || item.unit_barcode);
    packing.getCell(row, 4).value = text(item.product_name);
    packing.getCell(row, 5).value = number(item.ordered_quantity);
    packing.getCell(row, 6).value = number(item.total_net_weight_kg) || number(item.net_weight_kg) * number(item.ordered_quantity) || "";
    packing.getCell(row, 7).value = number(item.net_weight_with_packaging_kg) || "";
    packing.getCell(row, 8).value = number(item.box_count) || "";
    packing.getCell(row, 9).value = number(item.pallet_count) || "";
    packing.getCell(row, 10).value = number(item.total_gross_weight_kg) || number(item.gross_weight_kg) * number(item.ordered_quantity) || "";
    packing.getCell(row, 11).value = number(item.gross_with_pallets_kg) || "";
  });
  for (const column of [5, 6, 7, 8, 9, 10, 11]) {
    const letter = String.fromCharCode(64 + column);
    packing.getCell(packingTotal, column).value = { formula: `SUM(${letter}${packingStart}:${letter}${Math.max(packingStart, packingStart + items.length - 1)})` };
  }
  input.getCell("C26").value = { formula: `упаков.лист!K${packingTotal}` };
  workbook.calcProperties.fullCalcOnLoad = true;
  const output = await workbook.xlsx.writeBuffer();
  return new Uint8Array(output as ArrayBuffer);
}
