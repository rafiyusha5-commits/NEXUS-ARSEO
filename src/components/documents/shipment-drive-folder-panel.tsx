import { selectAll } from "@/lib/supabase/select-all";
import { randomUUID } from "node:crypto";
import { ProcessingStatus } from "./processing-status";
import { loadProcessingClock } from "@/lib/documents/processing-clock";
import type { ProcessingReceipt } from "@/lib/documents/processing-status";
import { createClient } from "@/lib/supabase/server";
import { loadPermissions } from "@/lib/permissions";
import { shipmentDriveGateway } from "@/lib/google/shipment-gateway";
import { shipmentDrive } from "@/lib/google/drive-server";
import { bindShipmentDriveFolder, checkShipmentDriveFolder, importShipmentDriveFile, checkShipmentDriveContent, linkShipmentDriveDocument } from "@/app/shipments/drive-folder-actions";
import { reconcileSource, type VisibleDocument } from "@/lib/google/folder-reconciliation";
import { ShipmentDriveFolderView, type FolderBinding, type FolderFile } from "./shipment-drive-folder-view";

export async function ShipmentDriveFolderPanel({ shipmentId }: { shipmentId: string }) {
  const session = await createClient();
  const serverNow = await loadProcessingClock();
  const required = ["shipments.view", "shipments.update", "documents.view", "documents.drive.view", "prices.purchase.view"] as const;
  const permissions = await loadPermissions(session, [...required, "documents.create", "documents.update"] as const);
  if (required.some(p => !permissions[p])) return null;
  let binding: FolderBinding | null = null;
  let files: FolderFile[] = [];
  let types: { id: string; name_ru: string }[] = [];
  let failed = false;
  let receipts: ProcessingReceipt[] = [];
  try {
    const db = await shipmentDriveGateway(session);
    const result = await db.from("shipment_drive_folders").select("folder_id,folder_name,checked_at").eq("shipment_id", shipmentId).maybeSingle();
    if (result.error) throw result.error;
    binding = result.data;
    const history = await db.from("shipment_drive_operations").select("id,kind,state,stage,started_at,updated_at,lease_until,finished_at,error_code").eq("shipment_id", shipmentId).order("started_at", { ascending: false }).limit(20);
    if (history.error) throw history.error;
    receipts = (history.data ?? []) as ProcessingReceipt[];
    if (binding) {
      await shipmentDrive().scopedReference(binding.folder_id, AbortSignal.timeout(12000));
      const [fileResult, typeResult, documentResult, versionResult, linkResult, reviewResult] = await Promise.all([
        selectAll((from, to) => db.from("shipment_drive_files").select("file_id,name,path,mime_type,revision,present,imported_document_id,imported_revision,checked_revision,checked_checksum,verified_version_ids").eq("shipment_id", shipmentId).order("path").order("file_id").range(from, to)),
        session.from("document_types").select("id,name_ru").eq("is_active", true).order("name_ru"),
        selectAll((from, to) => session.from("documents").select("id,title,document_type_id,status,current_version,original_filename").is("archived_at", null).neq("status", "rejected").order("id").range(from, to)),
        selectAll((from, to) => session.from("document_versions").select("id,document_id,version_number,checksum_sha256").eq("is_current", true).order("id").range(from, to)),
        selectAll((from, to) => session.from("document_links").select("document_id,id").eq("entity_type", "shipment").eq("entity_id", shipmentId).is("removed_at", null).order("id").range(from, to)),
        selectAll((from, to) => session.from("shipment_source_extractions").select("id,document_id,document_version_id,status,reviewed_at").eq("shipment_id", shipmentId).neq("status", "superseded").order("id").range(from, to)),
      ]);
      if (fileResult.error || typeResult.error || documentResult.error || versionResult.error || linkResult.error || reviewResult.error) throw new Error("Unavailable");
      types = typeResult.data ?? [];
      const documents: VisibleDocument[] = (documentResult.data ?? []).flatMap(d => {
        const version = versionResult.data?.find(v => v.document_id === d.id && v.version_number === d.current_version);
        const reviewed = version && linkResult.data?.some(l => l.document_id === d.id)
          && reviewResult.data?.some(r => r.document_id === d.id && r.document_version_id === version.id && r.status === "confirmed" && r.reviewed_at);
        return version ? [{ id: d.id, title: d.title, type: types.find(t => t.id === d.document_type_id)?.name_ru ?? "Документ",
          status: d.status, review: reviewed ? "Чтение текущей версии подтверждено для этой поставки" : "Нет доступного подтверждения чтения текущей версии для этой поставки",
          versionId: version.id, version: version.version_number, checksum: version.checksum_sha256, filename: d.original_filename }] : [];
      });
      const linkedIds = new Set((linkResult.data ?? []).map(l => l.document_id));
      files = (fileResult.data ?? []).map(file => ({ ...reconcileSource(file, documents, linkedIds), operation_id: randomUUID() }));
    }
  } catch { failed = true; }
  if (failed) return <section className="panel admin-section" id="drive-folder"><h2>Папка Google Drive</h2><p role="status">Привязка Drive сейчас недоступна. Проверьте настройку подключения и доступ к папке. Сохранённые документы Nexus доступны в обычном списке.</p></section>;
  return <><ProcessingStatus receipts={receipts} serverNow={serverNow}/><ShipmentDriveFolderView operationId={randomUUID()} shipmentId={shipmentId} binding={binding} files={files} types={types} canImport={permissions["documents.create"] && permissions["documents.update"]} actions={{ bind: bindShipmentDriveFolder, scan: checkShipmentDriveFolder, upload: importShipmentDriveFile, check: checkShipmentDriveContent, link: linkShipmentDriveDocument }}/></>;
}
