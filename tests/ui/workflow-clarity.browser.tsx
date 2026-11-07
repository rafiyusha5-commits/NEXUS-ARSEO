import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkflowHelp } from "../../src/components/workflow-help";
import { workflowGuides, type WorkflowSection } from "../../src/lib/ui/workflow-guides";
import { ShipmentDriveFolderView, type FolderFile } from "../../src/components/documents/shipment-drive-folder-view";
import { ProcessingStatus } from "../../src/components/documents/processing-status";
import { PendingSubmitButton } from "../../src/components/pending-submit-button";
import { DocumentActions } from "../../src/components/documents/document-actions";
import { OperationTabs } from "../../src/components/operation-tabs";
import { AppSidebar } from "../../src/components/app-sidebar";

const shipmentId = "00000000-0000-4000-8000-000000000001";
const files: FolderFile[] = [
  { file_id: "Invoice_example", name: "Инвойс производителя.pdf", path: "Закупка/Инвойс производителя.pdf", revision: "r1", present: true, imported_document_id: null, imported_revision: null, state: "new" },
  { file_id: "Packing_example", name: "Упаковочный лист.pdf", path: "Закупка/Упаковочный лист.pdf", revision: "r2", present: true, imported_document_id: shipmentId, imported_revision: "r2", state: "linked" },
];
const exampleDocument = { id: shipmentId, current: 1, files: { 1: "00000000-0000-4000-8000-000000000002" }, reviews: [{ href: "/shipments/synthetic?tab=documents#source-documents", shipment: "Проверочная поставка" }] };

function Example() {
  const [section, setSection] = useState<WorkflowSection>("shipments");
  const [calls, setCalls] = useState(0);
  const [payload, setPayload] = useState("");
  const [simulateError, setSimulateError] = useState(false);
  const [message, setMessage] = useState("");
  const action = async (form: FormData) => {
    setCalls(count => count + 1);
    setPayload(JSON.stringify(Object.fromEntries(form)));
    await new Promise(resolve => setTimeout(resolve, 400));
    setMessage(simulateError ? "Проверка отклонена: уточните основание" : "Проверочная форма выполнена");
  };
  return <main className="app-shell">
    <AppSidebar active="shipments" roles={[{ id: shipmentId, code: "administrator", name: "Администратор" }]} profile={{ id: shipmentId, full_name: "Проверочный пользователь", job_title: null, locale: "ru", is_active: true, user_type: "employee", counterparty_id: null, phone: null }}/>
    <section className="workspace admin-workspace">
      <header className="topbar"><div><p className="eyebrow">Синтетический стенд</p><h1>Подготовка поставки</h1></div><label>Проверяемый раздел<select aria-label="Проверяемый раздел" value={section} onChange={event => setSection(event.target.value as WorkflowSection)}>{Object.entries(workflowGuides).map(([key, guide]) => <option key={key} value={key}>{guide.title}</option>)}</select></label></header>
      <WorkflowHelp key={section} section={section}/>
      <OperationTabs tabs={[{ id: "main", label: "Основное" }, { id: "items", label: "Товары", badge: 5 }, { id: "delivery", label: "Доставка" }, { id: "documents", label: "Документы", badge: 7 }, { id: "stages", label: "Этапы" }, { id: "costs", label: "Расходы" }, { id: "history", label: "История" }]} activeTab="documents">
        <div/><div/><div/><section className="panel" id="example"><h2>Упаковочный лист.pdf</h2><DocumentActions document={exampleDocument}/></section><div/><div/><div/>
      </OperationTabs>
      <ShipmentDriveFolderView shipmentId={shipmentId} binding={null} files={[]} types={[]} canImport actions={{ bind: action, scan: action, upload: action }}/>
      <ShipmentDriveFolderView shipmentId={shipmentId} binding={{ folder_id: "Synthetic_folder_123", folder_name: "Проверочная поставка · документы", checked_at: "2026-11-07T08:00:00Z" }} files={files} types={[{ id: shipmentId, name_ru: "Инвойс" }]} canImport documentActions={{ [shipmentId]: exampleDocument }} actions={{ bind: action, scan: action, upload: action }}/>
      <ProcessingStatus receipts={[{ id: "synthetic-operation", kind: "ocr", state: "failed", stage: "recognizing", started_at: "2026-11-07T08:00:00Z", updated_at: "2026-11-07T08:00:10Z", lease_until: "2026-11-07T08:00:20Z", finished_at: "2026-11-07T08:00:10Z", error_code: "INTERRUPTED" }]} serverNow={Date.parse("2026-11-07T09:00:00Z")}/>
      <section className="panel admin-section"><h2>Проверка кнопки проведения</h2>
        <label><input type="checkbox" checked={simulateError} onChange={event => setSimulateError(event.target.checked)}/>Отклонить проверочную попытку</label>
        <form action={action} className="reference-form">
          <label>Основание<input name="reason" required/></label>
          <PendingSubmitButton name="decision" value="save" className="primary" pendingText="Сохраняем…">Сохранить проверочную запись</PendingSubmitButton>
          <PendingSubmitButton disabled className="ghost" pendingText="Выполняем…">Действие без права</PendingSubmitButton>
        </form><p role="status" id="message">{message}</p>
        <output id="calls">{calls}</output><output id="payload">{payload}</output>
      </section>
    </section>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Example/>);
