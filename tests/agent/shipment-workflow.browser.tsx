import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ShipmentWorkflowScope } from "../../src/components/assistant/shipment-workflow-scope";
import { ShipmentDriveFolderView } from "../../src/components/documents/shipment-drive-folder-view";
import { preparationRequest, documentActionReturn } from "../../src/lib/agent/shipment-workflow";

const id = "00000000-0000-4000-8000-000000000001";
function Example() {
  const [count, setCount] = useState(0), [result, setResult] = useState("");
  const action = async (form: FormData) => { setCount(n => n + 1); setResult(documentActionReturn(form, id, "success", "done")); };
  const request = preparationRequest("Подготовь поставку из папки https://drive.google.com/drive/folders/Synthetic_folder_123");
  return <><h1>Подготовка поставки</h1><p>Чтение → проверка → отдельное подтверждение операции</p><a href={request?.href}>Открыть подготовку</a><output id="calls">{count}</output>
    <ShipmentWorkflowScope shipmentId={id}><ShipmentDriveFolderView shipmentId={id} binding={null} files={[]} types={[]} canImport={true} initialFolder="https://drive.google.com/drive/folders/Synthetic_folder_123" operationId="00000000-0000-4000-8000-000000000002" actions={{ bind: action, scan: action, upload: action }} />
      <form action={async form => { setCount(n => n + 1); setResult(documentActionReturn(form, id, "success", "reviewed", true)); }}><input type="hidden" name="shipment_id" value={id}/><label><input type="checkbox" name="checked" required/>Проверил данные</label><button>Подтвердить данные</button></form>
    </ShipmentWorkflowScope><output id="result">{result}</output></>;
}
createRoot(document.getElementById("root")!).render(<Example/>);
