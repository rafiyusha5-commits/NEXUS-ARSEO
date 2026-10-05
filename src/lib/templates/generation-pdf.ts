import { readFile } from "node:fs/promises";
import { join } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, PDFPage, PDFFont, rgb } from "pdf-lib";

export type ExportPdfKind = "cmr" | "ttn" | "packing_list";

const ink = rgb(0.08, 0.1, 0.09);
const muted = rgb(0.35, 0.39, 0.37);
const red = rgb(0.67, 0.05, 0.04);
const fill = rgb(0.82, 0.82, 0.82);
const text = (value: unknown) => value === null || value === undefined ? "" : String(value);
const rows = (data: Record<string, unknown>) => Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : [];
const transports = (data: Record<string, unknown>) => Array.isArray(data.transports) ? data.transports as Array<Record<string, unknown>> : [];
const firstTransport = (data: Record<string, unknown>) => transports(data)[0] ?? {};

type Fonts = { regular: PDFFont; bold: PDFFont };

async function createDocument() {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  const [regularBytes, boldBytes] = await Promise.all([
    readFile(join(process.cwd(), "public", "fonts", "ubuntu-regular.ttf")),
    readFile(join(process.cwd(), "public", "fonts", "ubuntu-bold.ttf")),
  ]);
  const regular = await document.embedFont(regularBytes, { subset: true });
  const bold = await document.embedFont(boldBytes, { subset: true });
  return { document, fonts: { regular, bold } };
}

function fit(font: PDFFont, value: string, size: number, width: number) {
  if (!value) return "";
  if (font.widthOfTextAtSize(value, size) <= width) return value;
  let result = value;
  while (result.length > 1 && font.widthOfTextAtSize(`${result}…`, size) > width) result = result.slice(0, -1);
  return `${result}…`;
}

function write(page: PDFPage, font: PDFFont, value: unknown, x: number, y: number, size = 7, color = ink, maxWidth?: number) {
  const stringValue = text(value);
  page.drawText(maxWidth ? fit(font, stringValue, size, maxWidth) : stringValue, { x, y, size, font, color });
}

function line(page: PDFPage, x1: number, y1: number, x2: number, y2: number, thickness = 0.55) {
  page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color: ink });
}

function box(page: PDFPage, x: number, y: number, width: number, height: number, shaded = false) {
  page.drawRectangle({ x, y, width, height, borderWidth: 0.55, borderColor: ink, color: shaded ? fill : undefined });
}

function labelValue(page: PDFPage, fonts: Fonts, label: string, value: unknown, x: number, y: number, width: number) {
  write(page, fonts.regular, label, x, y + 9, 4.7, muted, width);
  write(page, fonts.bold, value || "—", x, y, 6.5, ink, width);
}

function party(data: Record<string, unknown>, type: "supplier" | "customer") {
  return {
    name: text(data[`${type}_name`]),
    tax: text(data[`${type}_tax_id`]),
    country: text(data[`${type}_country`]),
    address: text(data[`${type}_address`]),
  };
}

function total(data: Record<string, unknown>, key: string) {
  return text(data[key]) || rows(data).reduce((sum, item) => sum + Number(text(item[key]).replace(",", ".") || 0), 0).toLocaleString("ru-RU", { maximumFractionDigits: 3 });
}

async function packingList(data: Record<string, unknown>) {
  const { document, fonts } = await createDocument();
  const page = document.addPage([792, 612]);
  const margin = 44, width = 704;
  const transport = firstTransport(data), customer = party(data, "customer"), supplier = party(data, "supplier");
  write(page, fonts.bold, "УПАКОВОЧНЫЙ ЛИСТ", 520, 563, 12);
  write(page, fonts.bold, `№ ${text(data.packing_list_number) || text(data.shipment_number)}`, 520, 547, 8);
  write(page, fonts.regular, `от ${text(data.shipping_date) || text(data.generated_date)}`, 520, 535, 7);
  write(page, fonts.bold, `к заказу № ${text(data.order_number) || text(data.project_code) || text(data.shipment_number)}`, 520, 520, 7);
  write(page, fonts.regular, `к договору № ${text(data.contract_number) || "—"}`, 520, 508, 7);
  const left = [
    ["Водитель", transport.driver_name], ["Документ водителя", transport.driver_document],
    ["Госномер автомобиля", transport.vehicle_plate], ["Марка автомобиля", transport.vehicle_make],
    ["Госномер прицепа", transport.trailer_plate], ["Марка прицепа", transport.trailer_make],
  ];
  left.forEach(([label, value], index) => labelValue(page, fonts, String(label), value, margin, 554 - index * 16, 330));
  write(page, fonts.bold, `${supplier.name || "ТОО ARSEO"} → ${customer.name || "Покупатель"}`, 520, 493, 7, ink, 225);

  const tableY = 330, tableH = 142;
  box(page, margin, tableY, width, tableH);
  const widths = [22, 80, 70, 190, 48, 52, 52, 50, 42, 48, 50];
  let x = margin;
  widths.slice(0, -1).forEach(column => { x += column; line(page, x, tableY, x, tableY + tableH); });
  line(page, margin, tableY + tableH - 34, margin + width, tableY + tableH - 34);
  const headers = ["№", "Страна", "Штрихкод", "Наименование", "Кол-во", "Нетто", "Нетто с упаковкой", "Коробов", "Поддонов", "Брутто", "С паллетами"];
  x = margin;
  headers.forEach((header, index) => { write(page, fonts.bold, header, x + 2, tableY + tableH - 21, 5.2, ink, widths[index] - 4); x += widths[index]; });
  const items = rows(data).slice(0, 8), rowH = Math.min(13, 102 / Math.max(items.length + 1, 1));
  items.forEach((item, index) => {
    const y = tableY + tableH - 47 - index * rowH;
    const values = [index + 1, item.country_of_origin, item.box_barcode || item.gtin || item.unit_barcode, item.product_name, item.piece_count || item.ordered_quantity, item.total_net_weight_kg, item.net_weight_with_packaging_kg, item.box_count, item.pallet_count, item.total_gross_weight_kg, item.gross_with_pallets_kg];
    x = margin; values.forEach((value, column) => { write(page, fonts.regular, value, x + 2, y, 5.3, ink, widths[column] - 4); x += widths[column]; });
    line(page, margin, y - 4, margin + width, y - 4, 0.3);
  });
  const totals = ["", "", "", "ИТОГО", text(data.total_piece_count || data.total_quantity), total(data, "total_net_weight_kg"), "", text(data.box_count), text(data.pallet_count), total(data, "total_gross_weight_kg"), text(data.gross_with_pallets_kg)];
  x = margin; totals.forEach((value, column) => { write(page, fonts.bold, value, x + 2, tableY + 6, 5.5, ink, widths[column] - 4); x += widths[column]; });

  const partyY = 102, partyH = 170, partyWidth = 340;
  box(page, margin, partyY, partyWidth, partyH); box(page, margin + width - partyWidth, partyY, partyWidth, partyH);
  write(page, fonts.bold, "ПОКУПАТЕЛЬ", margin + 130, partyY + partyH - 16, 8);
  write(page, fonts.bold, customer.name || "—", margin + 10, partyY + partyH - 37, 7, ink, partyWidth - 20);
  write(page, fonts.regular, customer.address || text(data.unloading_address) || text(data.destination_address) || "Адрес не указан", margin + 10, partyY + partyH - 65, 6.2, ink, partyWidth - 20);
  write(page, fonts.regular, `ИНН/БИН ${customer.tax || "—"}`, margin + 10, partyY + 14, 6.5);
  write(page, fonts.bold, "ПРОДАВЕЦ", margin + width - 210, partyY + partyH - 16, 8);
  write(page, fonts.bold, supplier.name || "ТОО ARSEO", margin + width - partyWidth + 10, partyY + partyH - 37, 7, ink, partyWidth - 20);
  write(page, fonts.regular, supplier.address || text(data.loading_address) || "Адрес не указан", margin + width - partyWidth + 10, partyY + partyH - 65, 6.2, ink, partyWidth - 20);
  write(page, fonts.regular, `ИНН/БИН ${supplier.tax || "—"}`, margin + width - partyWidth + 10, partyY + 14, 6.5);
  return new Uint8Array(await document.save());
}

async function ttn(data: Record<string, unknown>) {
  const { document, fonts } = await createDocument();
  const page = document.addPage([792, 612]);
  const margin = 42, width = 708, transport = firstTransport(data), customer = party(data, "customer");
  write(page, fonts.bold, `ТОВАРНО-ТРАНСПОРТНАЯ НАКЛАДНАЯ № ${text(data.ttn_number) || text(data.shipment_number)}`, 415, 564, 9);
  write(page, fonts.regular, `от ${text(data.shipping_date) || text(data.generated_date)}`, 482, 548, 6.5);
  const details = [
    ["Автомобиль", `${text(transport.vehicle_make)} ${text(transport.vehicle_plate)}`],
    ["Перевозчик", transport.carrier_name], ["Водитель", transport.driver_name],
    ["Заказчик", party(data, "supplier").name || "ТОО ARSEO"], ["Грузополучатель", customer.name],
    ["Пункт погрузки", text(data.loading_address) || text(data.loading_city)], ["Пункт разгрузки", text(data.unloading_address) || text(data.destination_address)],
  ];
  details.forEach(([label, value], index) => { write(page, fonts.regular, `${label}:`, margin, 526 - index * 16, 6); write(page, fonts.bold, value || "—", margin + 88, 526 - index * 16, 6.5, ink, 610); line(page, margin + 85, 523 - index * 16, margin + width, 523 - index * 16, 0.35); });
  write(page, fonts.bold, "СВЕДЕНИЯ О ГРУЗЕ", 330, 398, 7);
  const tableY = 272, tableH = 112; box(page, margin, tableY, width, tableH);
  const widths = [25, 70, 215, 45, 55, 65, 55, 58, 60, 60];
  let x = margin; widths.slice(0, -1).forEach(w => { x += w; line(page, x, tableY, x, tableY + tableH); });
  line(page, margin, tableY + tableH - 27, margin + width, tableY + tableH - 27);
  const headers = ["№", "Заказ", "Наименование", "Мест", "Кол-во", "Цена", "Сумма", "Темп.", "Вес брутто", "Поддонов"];
  x = margin; headers.forEach((header, index) => { write(page, fonts.bold, header, x + 2, tableY + tableH - 17, 5, ink, widths[index] - 4); x += widths[index]; });
  rows(data).slice(0, 5).forEach((item, index) => {
    const y = tableY + tableH - 41 - index * 13;
    const values = [index + 1, data.order_number || data.project_code, item.product_name, item.box_count || "", item.piece_count || item.ordered_quantity, item.unit_price, item.line_total, transport.temperature_setpoint, item.total_gross_weight_kg, item.pallet_count];
    x = margin; values.forEach((value, col) => { write(page, fonts.regular, value, x + 2, y, 5.3, ink, widths[col] - 4); x += widths[col]; }); line(page, margin, y - 4, margin + width, y - 4, 0.3);
  });
  write(page, fonts.bold, `ИТОГО: ${text(data.total_piece_count || data.total_quantity)} ед. · ${total(data, "total_gross_weight_kg")} кг · ${text(data.pallet_count) || "—"} паллет`, margin + 310, tableY + 6, 6.2);
  const signatureY = 82; box(page, margin, signatureY, width, 154);
  line(page, margin + width / 2, signatureY, margin + width / 2, signatureY + 154);
  write(page, fonts.bold, "Груз сдал", margin + 10, signatureY + 136, 7); write(page, fonts.bold, "Груз принял", margin + width / 2 + 10, signatureY + 136, 7);
  [112, 88, 64, 40].forEach(offset => { line(page, margin + 10, signatureY + offset, margin + width / 2 - 10, signatureY + offset, 0.35); line(page, margin + width / 2 + 10, signatureY + offset, margin + width - 10, signatureY + offset, 0.35); });
  write(page, fonts.regular, "должность, Ф.И.О., подпись, печать", margin + 92, signatureY + 25, 5.5, muted);
  write(page, fonts.regular, "должность, Ф.И.О., подпись, печать", margin + width / 2 + 92, signatureY + 25, 5.5, muted);
  return new Uint8Array(await document.save());
}

async function cmr(data: Record<string, unknown>) {
  const { document, fonts } = await createDocument();
  const page = document.addPage([612, 792]);
  const margin = 28, width = 556, split = 330, transport = firstTransport(data), supplier = party(data, "supplier"), customer = party(data, "customer");
  box(page, margin, 55, width, 700); line(page, split, 55, split, 755);
  write(page, fonts.bold, "INTERNATIONAL CONSIGNMENT NOTE / CMR", split + 8, 737, 7);
  write(page, fonts.bold, text(data.cmr_number) || text(data.shipment_number), 495, 731, 11, red, 84);
  const section = (no: string, title: string, value: string, y: number, height: number, right = false) => {
    const x = right ? split : margin, w = right ? margin + width - split : split - margin;
    box(page, x, y, w, height); write(page, fonts.bold, no, x + 3, y + height - 11, 8); write(page, fonts.regular, title, x + 22, y + height - 10, 4.7, muted, w - 26); write(page, fonts.bold, value || "—", x + 4, y + 8, 6.2, red, w - 8);
  };
  section("1", "Отправитель / Sender", `${supplier.name}\n${supplier.address || text(data.loading_address)} ${supplier.country}`, 688, 67);
  section("2", "Получатель / Consignee", `${customer.name} ${customer.address || text(data.unloading_address)} ${customer.country}`, 625, 63);
  section("3", "Место разгрузки / Place of delivery", text(data.unloading_address) || text(data.destination_address), 581, 44);
  section("4", "Место и дата погрузки / Place and date of taking over", `${text(data.loading_address) || text(data.loading_city)}, ${text(data.shipping_date) || text(data.generated_date)}`, 537, 44);
  section("5", "Прилагаемые документы / Documents attached", `Инвойс ${text(data.invoice_number)} · ТТН ${text(data.ttn_number)}`, 493, 44);
  section("16", "Перевозчик / Carrier", text(transport.carrier_name), 662, 36, true);
  section("17", "Последующий перевозчик / Successive carriers", "", 617, 45, true);
  section("18", "Оговорки перевозчика / Carrier reservations", "", 537, 80, true);
  const goodsY = 425, goodsH = 68; box(page, margin, goodsY, width, goodsH);
  const goodsWidths = [72, 52, 55, 222, 62, 93]; let x = margin; goodsWidths.slice(0, -1).forEach(w => { x += w; line(page, x, goodsY, x, goodsY + goodsH); });
  ["6 Знаки", "7 Мест", "8 Упаковка", "9 Наименование груза", "10 ТН ВЭД", "11 Вес брутто"].forEach((header, index) => { const start = margin + goodsWidths.slice(0, index).reduce((sum, value) => sum + value, 0); write(page, fonts.bold, header, start + 3, goodsY + goodsH - 12, 5.2, ink, goodsWidths[index] - 6); });
  write(page, fonts.bold, text(data.order_number) || text(data.project_code), margin + 3, goodsY + 11, 6, red, 66);
  write(page, fonts.bold, text(data.pallet_count) || "—", margin + 75, goodsY + 11, 6, red, 45);
  write(page, fonts.bold, "Паллеты", margin + 128, goodsY + 11, 6, red, 50);
  write(page, fonts.bold, text(data.goods_category) || `${rows(data).length} товарных позиций`, margin + 183, goodsY + 11, 6, red, 215);
  write(page, fonts.bold, text(data.hs_codes), margin + 405, goodsY + 11, 5.5, red, 56);
  write(page, fonts.bold, total(data, "total_gross_weight_kg"), margin + 467, goodsY + 11, 6, red, 86);
  section("13", "Указания отправителя / Sender's instructions", text(data.special_instructions), 317, 108);
  section("19", "Платежи / To be paid by", text(data.payment_terms) || text(data.incoterms), 317, 108, true);
  section("14", "Возврат / Cash on delivery", "", 286, 31);
  section("15", "Условия оплаты / Instructions as to payment", `${text(data.incoterms)} · Договор № ${text(data.contract_number)}`, 249, 37);
  section("20", "Особые согласования / Special agreements", text(data.temperature_setpoint) || text(transport.temperature_setpoint), 249, 68, true);
  section("21", "Составлен в / Established in", `${text(data.loading_city)} · ${text(data.generated_date)}`, 212, 37);
  section("22", "Подпись отправителя / Signature of sender", "", 106, 106);
  section("23", "Подпись перевозчика / Signature of carrier", "", 106, 106, true);
  section("25", "Регистрация транспорта / Registration", `${text(transport.vehicle_make)} ${text(transport.vehicle_plate)} · ${text(transport.trailer_make)} ${text(transport.trailer_plate)}`, 55, 51);
  section("24", "Груз получен / Load accepted", "", 55, 51, true);
  return new Uint8Array(await document.save());
}

export async function renderShipmentPdf(kind: ExportPdfKind, data: Record<string, unknown>) {
  if (kind === "cmr") return cmr(data);
  if (kind === "ttn") return ttn(data);
  return packingList(data);
}
