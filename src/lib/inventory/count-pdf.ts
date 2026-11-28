// Printed count sheets (202611280300). A blind count gets empty rows per location: no book quantity and no list of what
// the book expects there. An open count lists the book with an empty column to fill. A recount lists the lines to count
// again and who must not count them.
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { countStatusLabel, uomLabel, type CountSheet } from "./counts.ts";

export type SheetSection = { title: string; columns: string[]; widths: number[]; rows: string[][]; blankRows: number };

const EMPTY_ROWS = 14;

/** What the printed sheet holds: never the book quantity of a blind count. */
export function countSheetSections(sheet: CountSheet): SheetSection[] {
  if (sheet.status === "recount" && sheet.recount) {
    return [{
      title: "Повторный подсчёт",
      columns: ["Место", "Товар", "Партия", "Ед.", "Количество", "Не считает"],
      widths: [70, 170, 80, 35, 70, 110],
      rows: sheet.recount.map(item => [item.location ?? "без зоны", `${item.sku} ${item.product}`, item.batch ?? "не определена",
        uomLabel[item.uom] ?? item.uom, "", item.first_counters.join(", ")]),
      blankRows: 0,
    }];
  }
  const places = [...sheet.locations.map(location => ({ id: location.id as string | null, code: location.code })),
    ...(sheet.no_location ? [{ id: null, code: "без зоны" }] : [])];
  if (!sheet.blind && sheet.book) {
    return places.map(place => ({
      title: `Место ${place.code}`,
      columns: ["Товар", "Партия", "Срок", "Ед.", "Учёт", "Посчитано"],
      widths: [190, 85, 65, 35, 60, 100],
      rows: sheet.book!.filter(row => row.location_id === place.id).map(row => [`${row.sku} ${row.product}`, row.batch, row.expiry_date ?? "",
        uomLabel[row.uom] ?? row.uom, row.quantity, ""]),
      blankRows: 4,
    }));
  }
  return places.map(place => ({
    title: `Место ${place.code}`,
    columns: ["Товар (артикул)", "Партия", "Срок", "Ед.", "Количество", "Примечание"],
    widths: [190, 85, 65, 35, 70, 90],
    rows: [],
    blankRows: EMPTY_ROWS,
  }));
}

/** Text that fits a column width at a font size; cut with an ellipsis. */
function fit(text: string, font: PDFFont, size: number, width: number) {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let cut = text;
  while (cut.length > 1 && font.widthOfTextAtSize(`${cut}…`, size) > width) cut = cut.slice(0, -1);
  return `${cut}…`;
}

export async function renderCountSheetPdf(sheet: CountSheet, fonts: { regular: Uint8Array; bold: Uint8Array }): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(fonts.regular, { subset: true });
  const bold = await pdf.embedFont(fonts.bold, { subset: true });
  pdf.setTitle(`Инвентаризация ${sheet.number}`);
  const margin = 36, rowHeight = 20, size = 9;
  let page: PDFPage = pdf.addPage([595.28, 841.89]);
  let y = page.getHeight() - margin;
  const newPage = () => { page = pdf.addPage([595.28, 841.89]); y = page.getHeight() - margin; };
  const line = (x1: number, y1: number, x2: number, y2: number) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.5, color: rgb(0.5, 0.5, 0.5) });
  page.drawText(`Инвентаризация ${sheet.number}`, { x: margin, y: y - 14, size: 14, font: bold });
  y -= 30;
  const subtitle = `${sheet.warehouse} · ${countStatusLabel[sheet.status]}${sheet.blind ? " · слепой пересчёт" : ""}`;
  page.drawText(fit(subtitle, regular, 10, 520), { x: margin, y, size: 10, font: regular });
  y -= 22;
  for (const section of countSheetSections(sheet)) {
    const total = section.rows.length + section.blankRows;
    if (y - rowHeight * Math.min(total + 2, 6) < margin + 40) newPage();
    page.drawText(section.title, { x: margin, y, size: 11, font: bold });
    y -= 16;
    const header = () => {
      let x = margin;
      section.columns.forEach((column, index) => { page.drawText(fit(column, bold, size, section.widths[index] - 4), { x: x + 2, y: y - 13, size, font: bold }); x += section.widths[index]; });
      line(margin, y, x, y); line(margin, y - rowHeight, x, y - rowHeight);
      y -= rowHeight;
    };
    header();
    const cells = [...section.rows, ...Array.from({ length: section.blankRows }, () => section.columns.map(() => ""))];
    for (const row of cells) {
      if (y - rowHeight < margin + 40) { newPage(); header(); }
      let x = margin;
      row.forEach((cell, index) => { if (cell) page.drawText(fit(cell, regular, size, section.widths[index] - 4), { x: x + 2, y: y - 13, size, font: regular }); x += section.widths[index]; });
      line(margin, y - rowHeight, x, y - rowHeight);
      y -= rowHeight;
    }
    y -= 14;
  }
  if (y < margin + 50) newPage();
  page.drawText("Считал: ______________________   Подпись: ____________   Дата и время: ________________", { x: margin, y: margin + 20, size: 10, font: regular });
  return pdf.save();
}
