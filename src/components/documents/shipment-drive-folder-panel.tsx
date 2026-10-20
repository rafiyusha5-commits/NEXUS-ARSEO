import { selectAll } from "@/lib/supabase/select-all";
import { randomUUID } from "node:crypto";
import { ProcessingStatus } from "./processing-status";
import { loadProcessingClock } from "@/lib/documents/processing-clock";
import type { ProcessingReceipt } from "@/lib/documents/processing-status";
import { createClient } from "@/lib/supabase/server";
import { loadPermissions } from "@/lib/permissions";
import { shipmentDriveGateway } from "@/lib/google/shipment-gateway";
import { shipmentDrive } from "@/lib/google/drive-server";
import { bindShipmentDriveFolder, checkShipmentDriveFolder, importShipmentDriveFile } from "@/app/shipments/drive-folder-actions";
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
      const [fileResult, typeResult] = await Promise.all([
        selectAll((from, to) => db.from("shipment_drive_files").select("file_id,name,path,revision,present,imported_document_id,imported_revision").eq("shipment_id", shipmentId).order("path").order("file_id").range(from, to)),
        session.from("document_types").select("id,name_ru").eq("is_active", true).order("name_ru"),
      ]);
      if (fileResult.error || typeResult.error) throw new Error("Unavailable");
      files = (fileResult.data ?? []).map(file => ({ ...file, operation_id: randomUUID() })); types = typeResult.data ?? [];
    }
  } catch { failed = true; }
  if (failed) return <section className="panel admin-section" id="drive-folder"><h2>Папка Google Drive</h2><p role="status">Привязка Drive сейчас недоступна. Проверьте настройку подключения и доступ к папке. Сохранённые документы Nexus доступны в обычном списке.</p></section>;
  return <><ProcessingStatus receipts={receipts} serverNow={serverNow}/><ShipmentDriveFolderView operationId={randomUUID()} shipmentId={shipmentId} binding={binding} files={files} types={types} canImport={permissions["documents.create"] && permissions["documents.update"]} actions={{ bind: bindShipmentDriveFolder, scan: checkShipmentDriveFolder, upload: importShipmentDriveFile }}/></>;
}
