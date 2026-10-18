import { confirmShipmentCustomsAction } from "@/app/shipments/source-document-actions";
import { PendingSubmitButton } from "@/components/pending-submit-button";

export function CustomsReviewForm({ shipmentId, extractionId, versionId, record, note, reviewedAt }: {
  shipmentId: string; extractionId: string; versionId: string; record: unknown; note?: unknown; reviewedAt?: string | null;
}) {
  return <form action={confirmShipmentCustomsAction} className="source-review-form">
    <input type="hidden" name="shipment_id" value={shipmentId}/>
    <input type="hidden" name="extraction_id" value={extractionId}/>
    <input type="hidden" name="document_version_id" value={versionId}/>
    <input type="hidden" name="expected_record" value={JSON.stringify(record)}/>
    <p>Подтверждается соответствие прочитанных реквизитов и товарных строк оригиналу декларации. Расхождения с заказом остаются в таблице. Количества поставки, склад, расходы и платежи не изменяются.</p>
    {reviewedAt && <p>Сверка сохранена: {new Date(reviewedAt).toLocaleString("ru-RU", { timeZone: "Asia/Almaty" })} (Казахстан).</p>}
    <div className="doc-form"><label className="doc-form-full">Результат сверки декларации<textarea name="review_note" rows={5} required minLength={10} maxLength={2000} defaultValue={typeof note === "string" ? note : ""} placeholder="Что сверено с оригиналом; какие расхождения с заказом остаются и почему"/></label></div>
    <label className="check-label"><input type="checkbox" name="checked" required/> Реквизиты и все товарные строки сверены с оригиналом; оставшиеся расхождения описаны</label>
    <PendingSubmitButton className="primary compact" pendingText="Сохраняем сверку…">{reviewedAt ? "Сохранить уточнение сверки декларации" : "Подтвердить сверку декларации"}</PendingSubmitButton>
  </form>;
}
