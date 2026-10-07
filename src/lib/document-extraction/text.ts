import "server-only";
import PizZip from "pizzip";
import ExcelJS from "exceljs";
import { NeedsOcrError } from "@/lib/ocr/types";

// A PDF whose text layer holds fewer visible characters than this is treated as a scan.
const MIN_TEXT_LAYER_CHARS = 40;

export async function extractDocumentText(bytes: Uint8Array, mimeType: string) {
  if (mimeType === "application/pdf") {
    const pdfParser = await import("pdf-parse");
    const parse = pdfParser.default as unknown as (input: Buffer) => Promise<{ text?: string }>;
    const result = await parse(Buffer.from(bytes) as never);
    const text = result.text?.trim() ?? "";
    if (text.replace(/\s/g, "").length < MIN_TEXT_LAYER_CHARS) throw new NeedsOcrError("scan_pdf");
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
