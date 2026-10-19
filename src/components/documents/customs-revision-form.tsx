import { randomUUID } from "node:crypto";
import { reviseShipmentCustomsAction } from "@/app/shipments/source-document-actions";
import { PendingSubmitButton } from "@/components/pending-submit-button";

export function CustomsRevisionForm({ shipmentId, documentId, extractionId, versionId, updatedAt }: {
  shipmentId: string; documentId: string; extractionId: string; versionId: string; updatedAt: string;
}) {
  return <details><summary>Повторно прочитать декларацию</summary><form action={reviseShipmentCustomsAction} className="source-review-form">
    <input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="document_id" value={documentId}/>
    <input type="hidden" name="extraction_id" value={extractionId}/><input type="hidden" name="document_version_id" value={versionId}/>
    <input type="hidden" name="expected_updated_at" value={updatedAt}/><input type="hidden" name="request_id" value={randomUUID()}/>
    <p>Файл будет прочитан заново. Прежний результат и сверка останутся в истории. Ручные реквизиты сохранятся; новую редакцию декларации потребуется подтвердить повторно.</p>
    <label>Причина новой редакции<textarea name="reason" required minLength={10} maxLength={2000} rows={3}/></label>
    <label className="check-label"><input type="checkbox" name="checked" required/> Создать новую редакцию и повторить ручную сверку</label>
    <PendingSubmitButton className="secondary compact" pendingText="Читаем новую редакцию…">Создать новую редакцию распознавания</PendingSubmitButton>
  </form></details>;
}
