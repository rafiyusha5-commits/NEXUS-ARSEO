import { PendingSubmitButton } from "@/components/pending-submit-button";
import { correctCustomerOrderDate } from "@/app/sales/actions";

export function AdminOrderDateCorrection({ saleId, currentDate, orderDate, today, requestId }: {
  saleId: string; currentDate: string; orderDate: string; today: string; requestId: string;
}) {
  return <details className="order-reschedule">
    <summary>Исправить дату по документам · только администратор</summary>
    <p className="form-help">Для черновика без резервов. Дата может быть в прошлом. Укажите документ и причину исправления: прежняя дата, автор и время сохранятся в истории. Это меняет дату заказа, но не фиксирует фактическую отгрузку. При последующем проведении действуют обычные проверки ОСГ.</p>
    <form action={correctCustomerOrderDate} className="inline-action">
      <input type="hidden" name="sale_id" value={saleId}/>
      <input type="hidden" name="request_id" value={requestId}/>
      <input type="hidden" name="expected_date" value={currentDate}/>
      <label>Дата отгрузки по документам<input name="planned_shipment_date" type="date" required min={orderDate} max={today}/></label>
      <label>Причина и документ-основание<input name="reason" required maxLength={1000} placeholder="Документ, его дата и причина исправления"/></label>
      <PendingSubmitButton pendingText="Сохраняем…" className="secondary" type="submit">Сохранить корректировку даты</PendingSubmitButton>
    </form>
  </details>;
}
