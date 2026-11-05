import { confirmShipmentCustomsAction } from "@/app/shipments/source-document-actions";
import { PendingSubmitButton } from "@/components/pending-submit-button";

export function CustomsReviewForm({ shipmentId, extractionId, versionId, record, note, reviewedAt, mappingId }: {
  shipmentId: string; extractionId: string; versionId: string; record: unknown; note?: unknown; reviewedAt?: string | null; mappingId?: string;
}) {
  const kind = record && typeof record === "object" && "kind" in record ? record.kind : null;
  const title = kind === "value_declaration" ? "ДТС" : kind === "transit" ? "транзитной декларации" : "декларации";
  const scope = kind === "declaration" ? "Реквизиты и все товарные строки" : "Показанные реквизиты";
  return <form action={confirmShipmentCustomsAction} className="source-review-form">
    <input type="hidden" name="shipment_id" value={shipmentId}/>
    <input type="hidden" name="extraction_id" value={extractionId}/>
    <input type="hidden" name="document_version_id" value={versionId}/>
    <input type="hidden" name="expected_record" value={JSON.stringify(record)}/>
    <input type="hidden" name="mapping_id" value={mappingId??""}/>
    <p>Подтверждается соответствие прочитанных данных оригиналу {title}. {kind === "declaration" ? "Расхождения с заказом остаются в таблице." : "Состав товаров и таможенные начисления проверяются отдельно по ДТ. Подтверждение этих реквизитов не означает проверку всего расчёта."} Количества поставки, склад, расходы и платежи не изменяются.</p>
    {reviewedAt && <p>Сверка сохранена: {new Date(reviewedAt).toLocaleString("ru-RU", { timeZone: "Asia/Almaty" })} (Казахстан).</p>}
    <div className="doc-form"><label className="doc-form-full">Результат сверки {title}<textarea name="review_note" rows={5} required minLength={10} maxLength={2000} defaultValue={typeof note === "string" ? note : ""} placeholder="Что сверено с оригиналом; какие расхождения и ограничения остаются"/></label></div>
    <label className="check-label"><input type="checkbox" name="checked" required/> {scope} сверены с оригиналом; оставшиеся расхождения описаны</label>
    <PendingSubmitButton className="primary compact" pendingText="Сохраняем сверку…">{reviewedAt ? `Сохранить уточнение сверки ${title}` : `Подтвердить сверку ${title}`}</PendingSubmitButton>
  </form>;
}
