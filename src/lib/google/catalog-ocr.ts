import { catalogText } from "./catalog-text.ts";
import type { CatalogClaim, CatalogSyncDeps } from "./catalog-sync.ts";
import type { DriveFile } from "./drive-readonly.ts";
import { inspectOcrFile } from "../ocr/validate.ts";
import { OcrError, type OcrLimits, type OcrProvider } from "../ocr/types.ts";

export type CatalogOcrDeps = Pick<CatalogSyncDeps, "rpc" | "drive"> & { provider: OcrProvider | null; limits: OcrLimits; authorize: (signal: AbortSignal) => Promise<boolean> };

/** One claimed source, only read from Drive; OCR text remains unverified source material. */
export async function catalogOcrStep(deps: CatalogOcrDeps, signal: AbortSignal): Promise<CatalogClaim> {
  if (!deps.provider || deps.provider.id !== "http") throw new OcrError("disabled", "OCR архива не настроен");
  signal.throwIfAborted();
  const claim = await deps.rpc("claim", {}) as CatalogClaim;
  if (!claim.item || !claim.token || !claim.runId) return claim;
  if (claim.status !== "extracting") throw new Error("CATALOG_OCR_MODE");
  const file = claim.item as DriveFile & { ocrExhausted?: boolean };
  const receipt = { runId: claim.runId, token: claim.token };
  let status = "error"; let errorCode: string | null = null;
  let prepared = { text: "", truncated: false };
  let confidence: number | null = null; let pages: number | null = null;
  try {
    if (file.ocrExhausted) { errorCode = "retry_exhausted"; }
    else {
      if (!["application/pdf", "image/jpeg", "image/png"].includes(file.mimeType)) throw new OcrError("unsupported", "Формат OCR не поддерживается");
      if (Number(file.size) > deps.limits.maxFileBytes) throw new OcrError("too_large", "Файл превышает лимит OCR");
      const current = await deps.drive.catalogReference(file.id, file.ancestors ?? [], signal);
      if (Date.parse(current.modifiedTime ?? "") !== Date.parse(file.modifiedTime ?? "")) status = "changed";
      else {
        const download = await deps.drive.download(file.id, signal);
        if (download.blob.size > deps.limits.maxFileBytes) throw new OcrError("too_large", "Файл превышает лимит OCR");
        const bytes = new Uint8Array(await download.blob.arrayBuffer());
        const inspected = await inspectOcrFile(bytes, deps.limits);
        // The actual bytes, not the name or MIME supplied by Drive, determine the format.
        if (inspected.mimeType !== file.mimeType) throw new OcrError("invalid_file", "Формат файла не совпадает с содержимым");
        const ocrSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(deps.limits.timeoutMs, 90000))]);
        ocrSignal.throwIfAborted();
        if (!await deps.authorize(ocrSignal)) throw new OcrError("disabled", "Право распознавания отозвано");
        ocrSignal.throwIfAborted();
        const result = await deps.provider.recognize({ bytes, kind: inspected.kind, mimeType: inspected.mimeType, maxPages: deps.limits.maxPages, languageHints: ["ru", "kk", "en"] }, { signal: ocrSignal });
        if (result.pageCount !== inspected.pageCount) throw new OcrError("provider_error", "OCR прочитал не все страницы");
        prepared = catalogText(result.text);
        status = prepared.text ? "readable" : "needs_ocr";
        if (!prepared.text) errorCode = "empty";
        confidence = typeof result.confidence === "number" && Number.isFinite(result.confidence) && result.confidence >= 0 && result.confidence <= 1 ? result.confidence : null;
        pages = result.pageCount;
        const latest = await deps.drive.catalogReference(file.id, file.ancestors ?? [], signal);
        if (Date.parse(latest.modifiedTime ?? "") !== Date.parse(file.modifiedTime ?? "")) { status = "changed"; prepared = { text: "", truncated: false }; confidence = null; pages = null; }
      }
    }
  } catch (error) {
    prepared = { text: "", truncated: false }; confidence = null; pages = null;
    errorCode = error instanceof OcrError ? error.code : signal.aborted ? "timeout" : "provider_error";
    status = errorCode === "empty" ? "needs_ocr" : errorCode === "too_large" ? "too_large" : "error";
  }
  return await deps.rpc("save_text", { ...receipt, status, ...prepared, ocrConfidence: confidence, ocrPages: pages, ocrError: errorCode }) as CatalogClaim;
}
