// A line already in the order gets its price here, before the order is confirmed (202611180100):
// recalculate from the price list (a rate or a condition appeared later) or set it by hand with a reason.
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { repriceCustomerOrderItem, setCustomerOrderItemPrice } from "@/app/sales/actions";

export function OrderLinePriceActions({ saleId, itemId, priceSource }: { saleId: string; itemId: string; priceSource: string | null }) {
  if (priceSource === "commercial_program") return null;
  return (
    <div className="order-line-price-actions">
      <form action={repriceCustomerOrderItem} className="inline-action">
        <input type="hidden" name="sale_id" value={saleId} />
        <input type="hidden" name="sale_item_id" value={itemId} />
        <PendingSubmitButton pendingText="Пересчитываем…" className="secondary" type="submit">Пересчитать из прайса</PendingSubmitButton>
      </form>
      <details className="order-line-price-manual">
        <summary>Указать вручную</summary>
        <form action={setCustomerOrderItemPrice} className="inline-action">
          <input type="hidden" name="sale_id" value={saleId} />
          <input type="hidden" name="sale_item_id" value={itemId} />
          <label>Цена за единицу<input name="unit_price" type="number" min="0" step="0.0001" required /></label>
          <label>Причина<input name="price_reason" required minLength={3} maxLength={1000} placeholder="Например: цена из письма клиента" /></label>
          <PendingSubmitButton pendingText="Сохраняем…" className="primary" type="submit">Сохранить цену</PendingSubmitButton>
        </form>
      </details>
    </div>
  );
}
