import { PDFDocument } from "pdf-lib";
import type { OcrLimits } from "../../src/lib/ocr/types.ts";

export const limits = (overrides: Partial<OcrLimits> = {}): OcrLimits => ({
  maxFileBytes: 4 * 1024 * 1024, maxPages: 5, maxPixels: 40_000_000, timeoutMs: 30_000, maxDocumentsPerRun: 5, maxAttempts: 3, leaseSeconds: 300, runBudgetMs: 100_000, ...overrides,
});

/** Smallest byte sequence the header checks accept; the pixels themselves are never decoded. */
export function pngBytes(width: number, height: number) {
  const bytes = new Uint8Array(33 + 12);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

export function jpegBytes(width: number, height: number) {
  const bytes = new Uint8Array(30);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00], 0); // SOI, APP0 (length 4)
  bytes.set([0xff, 0xc0, 0x00, 0x0b, 0x08], 8); // SOF0, length 11, precision 8
  const view = new DataView(bytes.buffer);
  view.setUint16(13, height);
  view.setUint16(15, width);
  return bytes;
}

export async function pdfBytes(pages: number) {
  const document = await PDFDocument.create();
  for (let index = 0; index < pages; index++) document.addPage([200, 200]);
  return new Uint8Array(await document.save());
}

export const encryptedLooking = () => new TextEncoder().encode("%PDF-1.4\n1 0 obj << /Type /Catalog /Encrypt 5 0 R >> endobj\n%%EOF");

export type Call = { name: string; args: Record<string, unknown> };

/** Scripted database client: records every RPC and answers from the supplied handlers. */
export function fakeDb(handlers: Record<string, (args: Record<string, unknown>) => { data?: unknown; error?: { message?: string; code?: string } | null }>) {
  const calls: Call[] = [];
  return {
    calls,
    db: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        const answer = handlers[name]?.(args) ?? { data: null, error: null };
        return Promise.resolve({ data: answer.data ?? null, error: answer.error ?? null });
      },
    },
  };
}
