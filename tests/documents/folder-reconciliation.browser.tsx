import { createRoot } from "react-dom/client";
import { ShipmentDriveFolderView, type FolderFile } from "../../src/components/documents/shipment-drive-folder-view";
const files: FolderFile[] = Array.from({ length: 250 }, (_, i) => ({
  file_id: `synthetic-${i}`, name: `Синтетический файл ${i}.pdf`, path: `${i % 2 ? "Закупка" : "Продажа клиенту"}/файл-${i}.pdf`,
  revision: "2", present: true, imported_document_id: null, imported_revision: null, state: "new",
}));
files[0] = { ...files[0], name: "Инвойс.pdf", state: "exact", verified: true, candidates: [{
  id: "synthetic-document", title: "Инвойс синтетической поставки", version: 1, versionId: "synthetic-version", status: "approved", type: "Инвойс", basis: "checksum",
}] };
const action = async () => { document.getElementById("result")!.textContent = "Выбрана явная операция"; };
createRoot(document.getElementById("root")!).render(<>
  <ShipmentDriveFolderView shipmentId="synthetic-shipment" binding={{ folder_id: "synthetic-folder", folder_name: "Синтетическая поставка", checked_at: "2026-10-20T10:00:00Z" }}
    files={files} types={[{ id: "invoice", name_ru: "Инвойс" }]} canImport
    actions={{ bind: action, scan: action, upload: action, check: action, link: action }}/>
  <p id="result" role="status"/>
</>);
