// Checks a file before it can reach an OCR provider. The declared name and MIME type are chosen by
// the uploader, so the kind is decided from the bytes. Nothing here renders or executes the file:
// PDFs are inspected as text, images by their header only.

import { PDFDocument } from "pdf-lib";
import { OcrError, type OcrFileKind, type OcrLimits } from "./types.ts";

export type InspectedFile = { kind: OcrFileKind; mimeType: string; pageCount: number; width?: number; height?: number };

const starts = (bytes: Uint8Array, prefix: number[]) => bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
const MIME: Record<OcrFileKind, string> = { pdf: "application/pdf", jpeg: "image/jpeg", png: "image/png" };

export function detectOcrKind(bytes: Uint8Array): OcrFileKind | null {
  if (starts(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf";
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  return null;
}

function pngSize(bytes: Uint8Array) {
  // 8-byte signature, then the IHDR chunk: length(4) "IHDR"(4) width(4) height(4)
  if (bytes.length < 24 || String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") throw new OcrError("invalid_file", "Изображение повреждено");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function jpegSize(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { offset += marker === 0xff ? 1 : 2; continue; }
    const length = view.getUint16(offset + 2);
    // Start-of-frame markers carry the size: SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    if (length < 2) break;
    offset += 2 + length;
  }
  throw new OcrError("invalid_file", "Не удалось определить размер изображения: файл повреждён");
}

async function pdfPages(bytes: Uint8Array) {
  // The raw-text scan rejects encrypted files without parsing anything. The page count comes from
  // pdf-lib (it understands compressed object streams); a raw count is the fallback for odd files.
  const text = new TextDecoder("latin1").decode(bytes);
  if (/\/Encrypt(?![A-Za-z])/.test(text)) throw new OcrError("invalid_file", "PDF защищён паролем: снимите защиту и загрузите снова");
  try {
    const document = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: false });
    return document.getPageCount();
  } catch {
    const counts = [...text.matchAll(/\/Count\s+(\d{1,5})/g)].map(match => Number(match[1]));
    const objects = [...text.matchAll(/\/Type\s*\/Page(?![A-Za-z])/g)].length;
    const pages = Math.max(objects, counts.length ? Math.max(...counts) : 0);
    if (pages < 1) throw new OcrError("invalid_file", "PDF повреждён или не содержит страниц");
    return pages;
  }
}

export async function inspectOcrFile(bytes: Uint8Array, limits: OcrLimits): Promise<InspectedFile> {
  if (!bytes.length) throw new OcrError("invalid_file", "Файл пустой");
  if (bytes.length > limits.maxFileBytes) throw new OcrError("too_large", `Файл больше ${Math.round(limits.maxFileBytes / 1024 / 1024)} МБ: уменьшите его перед распознаванием`);
  const kind = detectOcrKind(bytes);
  if (!kind) throw new OcrError("unsupported", "Для OCR поддерживаются PDF, JPG и PNG");
  if (kind === "pdf") {
    const pageCount = await pdfPages(bytes);
    if (pageCount < 1) throw new OcrError("invalid_file", "В PDF не найдено страниц");
    if (pageCount > limits.maxPages) throw new OcrError("too_many_pages", `В документе ${pageCount} стр., для OCR допускается не более ${limits.maxPages}`);
    return { kind, mimeType: MIME[kind], pageCount };
  }
  const { width, height } = kind === "png" ? pngSize(bytes) : jpegSize(bytes);
  if (!width || !height || width < 50 || height < 50) throw new OcrError("invalid_file", "Изображение слишком маленькое для распознавания");
  if (width * height > limits.maxPixels) throw new OcrError("too_large", "Изображение слишком большое по числу пикселей: уменьшите разрешение");
  return { kind, mimeType: MIME[kind], pageCount: 1, width, height };
}
