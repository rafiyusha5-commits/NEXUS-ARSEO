// Labels of locations and batches (202611280500) as PDF: an A4 sheet of 3 × 8 labels (70 × 37 mm) or one thermal label
// of 58 × 40 mm per page. Each label: the title, a line under it, the Code 128 of the Nexus code and the code in text,
// so it can be typed when nothing scans.
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { code128Modules } from "./code128.ts";

export type LabelData = { code: string; title: string; subtitle: string };
export type LabelFormat = "a4" | "thermal";

const MM = 72 / 25.4;

function fit(text: string, font: PDFFont, size: number, width: number) {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let cut = text;
  while (cut.length > 1 && font.widthOfTextAtSize(`${cut}…`, size) > width) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function drawLabel(page: PDFPage, label: LabelData, x: number, y: number, width: number, height: number, fonts: { regular: PDFFont; bold: PDFFont }) {
  const pad = 3 * MM;
  const inner = width - 2 * pad;
  page.drawText(fit(label.title, fonts.bold, 11, inner), { x: x + pad, y: y + height - pad - 10, size: 11, font: fonts.bold });
  page.drawText(fit(label.subtitle, fonts.regular, 7.5, inner), { x: x + pad, y: y + height - pad - 20, size: 7.5, font: fonts.regular });
  const modules = code128Modules(label.code);
  const step = Math.min(inner / modules.length, 0.5 * MM);
  const barsWidth = step * modules.length;
  const barHeight = height - pad * 2 - 34;
  const left = x + (width - barsWidth) / 2;
  const bottom = y + pad + 11;
  let run = 0;
  modules.forEach((bar, index) => {
    if (bar) run += 1;
    if (run && (!bar || index === modules.length - 1)) {
      const end = bar ? index + 1 : index;
      page.drawRectangle({ x: left + (end - run) * step, y: bottom, width: run * step, height: barHeight, color: rgb(0, 0, 0) });
      run = 0;
    }
  });
  const codeWidth = fonts.bold.widthOfTextAtSize(label.code, 9);
  page.drawText(label.code, { x: x + (width - codeWidth) / 2, y: y + pad, size: 9, font: fonts.bold });
}

export async function renderLabelsPdf(labels: LabelData[], format: LabelFormat, copies: number,
                                      fonts: { regular: Uint8Array; bold: Uint8Array }): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(fonts.regular, { subset: true });
  const bold = await pdf.embedFont(fonts.bold, { subset: true });
  pdf.setTitle("Этикетки Nexus");
  const all = labels.flatMap(label => Array.from({ length: copies }, () => label));
  if (format === "thermal") {
    for (const label of all) {
      const page = pdf.addPage([58 * MM, 40 * MM]);
      drawLabel(page, label, 0, 0, 58 * MM, 40 * MM, { regular, bold });
    }
  } else {
    const columns = 3, rows = 8, width = 70 * MM, height = 37 * MM;
    const top = (297 * MM - rows * height) / 2;
    let page: PDFPage | null = null;
    all.forEach((label, index) => {
      const slot = index % (columns * rows);
      if (slot === 0) page = pdf.addPage([210 * MM, 297 * MM]);
      const column = slot % columns, row = Math.floor(slot / columns);
      drawLabel(page!, label, column * width, 297 * MM - top - (row + 1) * height, width, height, { regular, bold });
    });
  }
  return pdf.save();
}
