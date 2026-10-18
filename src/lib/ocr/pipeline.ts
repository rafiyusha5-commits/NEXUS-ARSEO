// Orchestration of OCR for one document. It is pure: the database client, the provider, the clock
// and hashing are injected, so permission, error and re-run behaviour can be tested without a network.
//
// Order of operations (the file never leaves the server before step 4):
//   1 provider configured?  2 file inspected (kind from bytes, size, pages, pixels)  3 checksum
//   4 claim the job in the database (idempotent reuse / busy lease / bounded attempts)  5 call provider
//   6 build the proposal  7 store it for review (the database refuses to confirm or touch the shipment)

import type { ExtractionConflict } from "../document-extraction/rules.ts";
import { proposeFromOcr, type OcrProposal } from "./recognize.ts";
import { inspectOcrFile } from "./validate.ts";
import { OcrError, type OcrLimits, type OcrProvider, type OcrResult } from "./types.ts";

export type RpcClient = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }> };

export type PipelineDeps = {
  db: RpcClient;
  provider: OcrProvider | null;
  limits: OcrLimits;
  now: () => number;
  sha256: (bytes: Uint8Array) => Promise<string>;
};

export type OcrDocument = {
  shipmentId: string;
  documentId: string;
  versionId: string;
  hintedKind: string;
  bytes: Uint8Array;
};

export type PreparedOcr =
  /** Nothing was sent to the provider; persist as a failed text-layer style row (no attempt is consumed). */
  | { state: "rejected"; message: string }
  | { state: "reused"; extractionId: string }
  | { state: "busy"; extractionId: string }
  | { state: "exhausted"; extractionId: string }
  | { state: "recognized"; extractionId: string; proposal: OcrProposal; ocr: OcrResult; ms: number }
  | { state: "failed"; extractionId: string; message: string; ms: number };

const LANGUAGES = ["ru", "kk", "en"];
const OCR_EXTRACTOR_VERSION = "ocr-rules-v3";

export const permissionMessage = "Нет права передавать документы на OCR";

const isPermissionError = (error: { message?: string; code?: string }) => error.code === "42501" || /Нет права/.test(error.message ?? "");

export class OcrPermissionError extends Error {}

/** Steps 1–6. The returned row stays 'pending' until persistOcrOutcome runs. */
export async function recognizeDocument(deps: PipelineDeps, doc: OcrDocument, options: { force?: boolean } = {}): Promise<PreparedOcr> {
  const { provider, limits } = deps;
  if (!provider) return { state: "rejected", message: "Распознавание сканов не настроено администратором: загрузите текстовую версию документа или введите данные вручную" };

  let inspected;
  try { inspected = await inspectOcrFile(doc.bytes, limits); }
  catch (error) { return { state: "rejected", message: error instanceof OcrError ? error.message : "Файл не подходит для распознавания" }; }

  const hash = await deps.sha256(doc.bytes);
  const claim = await deps.db.rpc("begin_shipment_source_ocr", {
    p_shipment_id: doc.shipmentId, p_document_id: doc.documentId, p_document_version_id: doc.versionId, p_source_kind: doc.hintedKind,
    p_source_sha256: hash, p_provider: provider.id, p_provider_version: provider.version,
    p_max_attempts: limits.maxAttempts, p_lease_seconds: limits.leaseSeconds, p_force: options.force === true,
  });
  if (claim.error) {
    if (isPermissionError(claim.error)) throw new OcrPermissionError(permissionMessage);
    return { state: "rejected", message: "Не удалось начать распознавание документа" };
  }
  const answer = claim.data as { action?: string; extraction_id?: string } | null;
  const extractionId = answer?.extraction_id ?? "";
  if (!extractionId) return { state: "rejected", message: "Не удалось начать распознавание документа" };
  if (answer?.action === "reuse") return { state: "reused", extractionId };
  if (answer?.action === "busy") return { state: "busy", extractionId };
  if (answer?.action === "exhausted") return { state: "exhausted", extractionId };

  const started = deps.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  try {
    const ocr = await provider.recognize({ bytes: doc.bytes, kind: inspected.kind, mimeType: inspected.mimeType, maxPages: limits.maxPages, languageHints: LANGUAGES }, { signal: controller.signal });
    return { state: "recognized", extractionId, proposal: proposeFromOcr(ocr, doc.hintedKind), ocr, ms: deps.now() - started };
  } catch (error) {
    const message = error instanceof OcrError ? error.message : controller.signal.aborted ? "Сервис распознавания не ответил вовремя" : "Не удалось распознать документ";
    return { state: "failed", extractionId, message, ms: deps.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** Step 7 for a prepared job; conflicts with other documents of the shipment are known by now. */
export async function persistOcrOutcome(deps: PipelineDeps, prepared: PreparedOcr, conflicts: ExtractionConflict[] = []) {
  if (prepared.state === "recognized") {
    const { proposal, ocr, ms, extractionId } = prepared;
    const status = proposal.status === "extracted" && conflicts.length ? "needs_review" : proposal.status;
    const evidence = Object.fromEntries(Object.entries(proposal.result.evidence).map(([field, item]) => [field, { ...item, method: "ocr" }]));
    const { error } = await deps.db.rpc("finish_shipment_source_ocr", {
      p_extraction_id: extractionId, p_status: status, p_extracted_data: proposal.result.data, p_field_evidence: evidence,
      p_conflicts: conflicts, p_error_message: proposal.error, p_extractor_version: OCR_EXTRACTOR_VERSION, p_page_count: ocr.pageCount,
      p_processing_ms: ms, p_confidence: proposal.confidence === null ? null : Math.round(proposal.confidence * 1000) / 1000,
      p_source_kind: proposal.sourceKind,
    });
    return { ok: !error, status: error ? "failed" : status };
  }
  if (prepared.state === "failed") {
    const { error } = await deps.db.rpc("finish_shipment_source_ocr", {
      p_extraction_id: prepared.extractionId, p_status: "failed", p_extracted_data: {}, p_field_evidence: {}, p_conflicts: [],
      p_error_message: prepared.message, p_extractor_version: OCR_EXTRACTOR_VERSION, p_page_count: null, p_processing_ms: prepared.ms, p_confidence: null,
    });
    return { ok: !error, status: "failed" as const };
  }
  return { ok: true, status: prepared.state };
}
