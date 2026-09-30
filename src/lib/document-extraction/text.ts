import "server-only";
import PizZip from "pizzip";
import ExcelJS from "exceljs";

export async function extractDocumentText(bytes: Uint8Array, mimeType: string) {
  if (mimeType === "application/pdf") {
    const pdfParser = await import("pdf-parse");
    const parse = pdfParser.default as unknown as (input: Buffer) => Promise<{ text?: string }>;
    const result = await parse(Buffer.from(bytes) as never);
    const text = result.text?.trim() ?? "";
    if (!text) throw new Error("В PDF нет текстового слоя. Требуется OCR или текстовая версия файла");
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
  if (mimeType.startsWith("image/")) throw new Error("Для изображения требуется OCR; загрузите текстовый PDF или XLSX");
  throw new Error("Формат исходного документа пока не поддерживается для распознавания");
}
