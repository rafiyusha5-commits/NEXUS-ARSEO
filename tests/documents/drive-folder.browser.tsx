import { createRoot } from "react-dom/client";
import { ShipmentDriveFolderView } from "../../src/components/documents/shipment-drive-folder-view";
const action = async () => { await new Promise(resolve => setTimeout(resolve, 2500)); };
const common = { shipmentId: "00000000-0000-4000-8000-000000000001", types: [{ id: "invoice", name_ru: "Инвойс" }], canImport: true, actions: { bind: action, scan: action, upload: action } };
createRoot(document.getElementById("root")!).render(<>
  <ShipmentDriveFolderView {...common} binding={null} files={[]}/>
  <ShipmentDriveFolderView {...common} binding={{ folder_id: "Synthetic_folder", folder_name: "Учебная поставка · тест интерфейса", checked_at: "2026-10-19T10:00:00Z" }} files={[
    { file_id: "new", name: "Инвойс.pdf", path: "Закупка / Инвойс.pdf", revision: "1", present: true, imported_document_id: null, imported_revision: null },
    { file_id: "changed", name: "Упаковочный лист.pdf", path: "Закупка / Упаковочный лист.pdf", revision: "2", present: true, imported_document_id: "synthetic", imported_revision: "1" },
    { file_id: "missing", name: "Ранее загруженный CMR.pdf", path: "CMR.pdf", revision: "1", present: false, imported_document_id: "synthetic", imported_revision: "1" },
  ]}/>
</>);
