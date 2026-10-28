import "server-only";
import PizZip from "pizzip";
import ExcelJS from "exceljs";
import { NeedsOcrError } from "@/lib/ocr/types";
import { customsLayout, isCustomsForm, type PdfTextItem } from "./customs";
import { INVOICE_LAYOUT_MARKER, isBilingualInvoice } from "./commodity-evidence";
import { SUPPLIER_LAYOUT_MARKER, isSupplierLayout } from "./supplier-layout";

// A PDF whose text layer holds fewer visible characters than this is treated as a scan.
const MIN_TEXT_LAYER_CHARS = 40;

export async function extractDocumentText(bytes: Uint8Array, mimeType: string) {
  if (mimeType === "application/pdf") {
    // Import the parser implementation directly. The package entry point contains
    // a CLI/debug branch that Next.js can mistake for the main module and then
    // tries to open pdf-parse's non-shipped test fixture at runtime.
    const pdfParser = await import("pdf-parse/lib/pdf-parse.js");
    const parse = pdfParser.default as unknown as (input: Buffer, options?: { pagerender: (page: { getTextContent(): Promise<{ items: PdfTextItem[] }> }) => Promise<string> }) => Promise<{ text?: string }>;
    const result = await parse(Buffer.from(bytes) as never);
    const text = result.text?.trim() ?? "";
    if (text.replace(/\s/g, "").length < MIN_TEXT_LAYER_CHARS) throw new NeedsOcrError("scan_pdf");
    if (isCustomsForm(text) || isBilingualInvoice(text) || isSupplierLayout(text)) {
      const layout = await parse(Buffer.from(bytes), { pagerender: async page => customsLayout((await page.getTextContent()).items) + "\n\f\n" });
      return isCustomsForm(text) ? layout.text?.trim() || text : text + (isSupplierLayout(text) ? SUPPLIER_LAYOUT_MARKER : INVOICE_LAYOUT_MARKER) + (layout.text?.trim() ?? "");
    }
    return text;
  }
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const zip = new PizZip(bytes);
    const xml = zip.file("word/document.xml")?.asText() ?? "";
    const text = xml
      .replace(/<w:tab\/?[^>]*>/g, "\t")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
      .replace(/[ \t]+/g, " ").trim();
    if (!text) throw new Error("В DOCX не найден текст");
    return text;
  }
  if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(bytes) as never);
    const lines: string[] = [];
    workbook.eachSheet((sheet) => {
      lines.push(`Лист: ${sheet.name}`);
      sheet.eachRow({ includeEmpty: false }, (row) => {
        const values: string[] = [];
        row.eachCell({ includeEmpty: false }, (cell) => {
          const value = cell.text?.trim();
          if (value) values.push(value);
        });
        if (values.length) lines.push(values.join(" | "));
      });
    });
    if (!lines.length) throw new Error("В XLSX не найдены данные");
    return lines.join("\n");
  }
  if (mimeType === "text/csv") return new TextDecoder("utf-8").decode(bytes);
  if (mimeType === "application/vnd.ms-excel") throw new Error("Автоматическое чтение XLS пока не поддерживается. Сохраните копию в XLSX");
  if (mimeType === "image/jpeg" || mimeType === "image/png") throw new NeedsOcrError("image");
  throw new Error("Формат исходного документа пока не поддерживается для распознавания");
}
