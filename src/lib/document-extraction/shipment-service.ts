import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DOCUMENT_BUCKET } from "@/lib/documents/files";
import { loadOcrConfig } from "@/lib/ocr/config";
import { OcrPermissionError, permissionMessage, persistOcrOutcome, recognizeDocument, type OcrDocument, type PipelineDeps, type PreparedOcr } from "@/lib/ocr/pipeline";
import { createOcrProvider } from "@/lib/ocr/providers";
import { NeedsOcrError } from "@/lib/ocr/types";
import { conflictsAcrossDocuments, detectShipmentSourceKind, extractShipmentFields, EXTRACTION_VERSION } from "./rules";
import { extractDocumentText } from "./text";

const one = <T,>(value: T | T[] | null | undefined) => Array.isArray(value) ? value[0] : value ?? undefined;

function sourceKind(code: string) {
  if (code === "cmr" || code === "ttn") return "waybill";
  if (code === "packing_list") return "specification";
  if (["invoice", "specification", "waybill", "transport_order", "vehicle_document", "driver_document"].includes(code)) return code;
  if (["supplier_contract", "customer_contract"].includes(code)) return "contract";
  return "other";
}

export type ShipmentExtractionSummary = {
  ready: number; review: number; failed: number; total: number;
  /** OCR jobs another request is still running. */
  processing: number;
  /** Scans that did not fit this run's limits and wait for the next run. */
  deferred: number;
  /** Scans whose stored OCR result was reused without calling the provider. */
  reused: number;
};

type Prepared = { documentId: string; versionId: string; sourceKind: string; result: ReturnType<typeof extractShipmentFields>; error: string | null };
type Scan = OcrDocument & { code: string };

export async function extractShipmentSources(
  supabase: SupabaseClient,
  shipmentId: string,
  options: { documentId?: string; force?: boolean } = {},
): Promise<ShipmentExtractionSummary> {
  const { data: transports, error: transportError, count: transportCount } = await supabase.from("shipment_transports").select("id", { count: "exact" }).eq("shipment_id", shipmentId).neq("status", "cancelled");
  if (transportError || transportCount !== transports?.length) throw new Error("Не удалось прочитать полный список автомобилей");
  const transportIds = (transports ?? []).map(row => row.id as string);
  const linkFilter = transportIds.length
    ? `and(entity_type.eq.shipment,entity_id.eq.${shipmentId}),and(entity_type.eq.shipment_transport,entity_id.in.(${transportIds.join(",")}))`
    : `and(entity_type.eq.shipment,entity_id.eq.${shipmentId})`;
  const { data: links, error: linkError, count: linkCount } = await supabase.from("document_links").select("document_id", { count: "exact" }).is("removed_at", null).or(linkFilter);
  if (linkError || linkCount !== links?.length) throw new Error("Не удалось прочитать полный список связей документов");
  const documentIds = [...new Set((links ?? []).map(row => row.document_id as string))].filter(id => !options.documentId || id === options.documentId);
  if (!documentIds.length) throw new Error("Сначала загрузите исходные документы поставки");

  const [{ data: documents, error: documentsError, count: documentCount }, { data: generated, error: generatedError, count: generatedCount }] = await Promise.all([
    supabase
      .from("documents")
      .select("id,title,archived_at,status,current_version,type:document_types(code),versions:document_versions!document_versions_document_id_fkey(id,storage_path,mime_type,is_current,version_number)", { count: "exact" })
      .in("id", documentIds),
    supabase.from("document_generations").select("document_id", { count: "exact" }).in("document_id", documentIds),
  ]);
  if (documentsError || generatedError || documentCount !== documents?.length || generatedCount !== generated?.length || documents.length !== documentIds.length) throw new Error("Не удалось прочитать полный список исходных документов");
  const generatedIds = new Set((generated ?? []).map(row => row.document_id as string));
  const sourceDocuments = (documents ?? []).filter(document => !document.archived_at && document.status !== "rejected" && !generatedIds.has(document.id));
  if (!sourceDocuments.length) throw new Error("В поставке нет исходных документов для распознавания");

  // Phase 1: read every document. Text documents are recognised here; scans and photos are queued for OCR.
  const prepared: Prepared[] = [];
  const scans: Scan[] = [];
  for (const document of sourceDocuments) {
    const currentVersions = (document.versions as Array<{ id: string; storage_path: string; mime_type: string; is_current: boolean; version_number: number }> | null)?.filter(item => item.is_current) ?? [];
    const version = currentVersions.length === 1 && currentVersions[0].version_number === document.current_version ? currentVersions[0] : null;
    const code = one(document.type as { code: string } | Array<{ code: string }> | null)?.code ?? "other";
    if (!version) {
      prepared.push({ documentId: document.id, versionId: "", sourceKind: sourceKind(code), result: { data: {}, evidence: {}, conflicts: [] }, error: "У документа нет текущей версии" });
      continue;
    }
    try {
      const { data: file, error: downloadError } = await supabase.storage.from(DOCUMENT_BUCKET).download(version.storage_path);
      if (downloadError || !file) throw new Error(downloadError?.message || "Файл не найден");
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        const rawText = await extractDocumentText(bytes, version.mime_type);
        const result = extractShipmentFields(rawText, { hintedKind: sourceKind(code) });
        prepared.push({ documentId: document.id, versionId: version.id, sourceKind: detectShipmentSourceKind(rawText, sourceKind(code)), result, error: Object.keys(result.data).length ? null : "Реквизиты не распознаны автоматически" });
      } catch (error) {
        if (!(error instanceof NeedsOcrError)) throw error;
        scans.push({ shipmentId, documentId: document.id, versionId: version.id, hintedKind: sourceKind(code), bytes, code });
      }
    } catch (error) {
      prepared.push({ documentId: document.id, versionId: version.id, sourceKind: sourceKind(code), result: { data: {}, evidence: {}, conflicts: [] }, error: error instanceof Error ? error.message : "Не удалось прочитать файл" });
    }
  }

  // Phase 2: OCR. Nothing leaves the server unless a provider is configured; the pipeline validates the
  // file first and claims an idempotent job in the database before the provider is called.
  const config = loadOcrConfig();
  const deps: PipelineDeps = {
    db: supabase, provider: createOcrProvider(config), limits: config.limits, now: Date.now,
    sha256: async bytes => createHash("sha256").update(bytes).digest("hex"),
  };
  const budgetEnd = Date.now() + config.limits.runBudgetMs;
  const outcomes: Array<{ scan: Scan; outcome: PreparedOcr }> = [];
  let sent = 0, deferred = 0;
  for (const scan of scans) {
    if (deps.provider && (sent >= config.limits.maxDocumentsPerRun || Date.now() > budgetEnd)) { deferred++; continue; }
    try {
      const outcome = await recognizeDocument(deps, scan, { force: options.force });
      if (outcome.state === "recognized" || outcome.state === "failed") sent++;
      outcomes.push({ scan, outcome });
    } catch (error) {
      outcomes.push({ scan, outcome: { state: "rejected", message: error instanceof OcrPermissionError ? permissionMessage : "Не удалось начать распознавание документа" } });
    }
  }

  // Phase 3: disagreements between documents (text and OCR alike), then write everything.
  const successful = [
    ...prepared.filter(item => !item.error).map(item => ({ documentId: item.documentId, result: item.result })),
    ...outcomes.flatMap(({ scan, outcome }) => outcome.state === "recognized" && outcome.proposal.status !== "failed" ? [{ documentId: scan.documentId, result: outcome.proposal.result }] : []),
  ];
  const commonConflicts = conflictsAcrossDocuments(successful);
  const summary: ShipmentExtractionSummary = { ready: 0, review: 0, failed: 0, total: prepared.length + scans.length, processing: 0, deferred, reused: 0 };

  for (const item of prepared) {
    if (!item.versionId) { summary.failed++; continue; }
    const conflicts = commonConflicts.filter(conflict => conflict.documents?.includes(item.documentId));
    const status = item.error ? "failed" : conflicts.length || item.result.data.customs_record ? "needs_review" : "extracted";
    const { error } = await supabase.rpc("upsert_shipment_source_extraction", {
      p_shipment_id: shipmentId, p_document_id: item.documentId, p_document_version_id: item.versionId,
      p_source_kind: item.sourceKind, p_status: status, p_extracted_data: item.result.data,
      p_field_evidence: item.result.evidence, p_conflicts: conflicts, p_error_message: item.error,
      p_extractor_version: EXTRACTION_VERSION,
    });
    if (error) summary.failed++;
    else if (status === "extracted") summary.ready++;
    else if (status === "needs_review") summary.review++;
    else summary.failed++;
  }

  for (const { scan, outcome } of outcomes) {
    if (outcome.state === "reused") { summary.reused++; continue; }
    if (outcome.state === "busy") { summary.processing++; continue; }
    if (outcome.state === "exhausted") { summary.failed++; continue; }
    if (outcome.state === "rejected") {
      // Rejected before anything was sent: record why, so the employee sees a clear "not read" state.
      const { error } = await supabase.rpc("upsert_shipment_source_extraction", {
        p_shipment_id: shipmentId, p_document_id: scan.documentId, p_document_version_id: scan.versionId,
        p_source_kind: scan.hintedKind, p_status: "failed", p_extracted_data: {}, p_field_evidence: {}, p_conflicts: [],
        p_error_message: outcome.message, p_extractor_version: "ocr-precheck",
      });
      void error;
      summary.failed++;
      continue;
    }
    const conflicts = outcome.state === "recognized" ? commonConflicts.filter(conflict => conflict.documents?.includes(scan.documentId)) : [];
    const stored = await persistOcrOutcome(deps, outcome, conflicts);
    if (stored.status === "extracted") summary.ready++;
    else if (stored.status === "needs_review") summary.review++;
    else summary.failed++;
  }
  return summary;
}
