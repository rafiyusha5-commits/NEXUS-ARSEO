import { applyDocumentQuantitiesAction } from "@/app/shipments/source-document-actions";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import {
  defaultQuantityTarget, itemsInDocumentScope, proposeDocumentQuantities,
  type DocumentLine, type QuantityItem,
} from "@/lib/shipments/document-quantities";

export type QuantityFormItem = QuantityItem & {
  ordered_quantity: number | string;
  confirmed_quantity: number | string | null;
  shipped_quantity: number | string | null;
};
export type QuantityHistoryRow = { shipment_item_id: string; extraction_id: string; field: string; quantity: number | string; confirmed_at: string };

const units: Record<string, string> = { piece: "шт.", box: "кор.", layer: "слой", pallet: "пал.", truck: "фура" };
const one = <T,>(value: T | T[] | null | undefined) => Array.isArray(value) ? value[0] : value ?? undefined;
const number = (value: unknown) => value === null || value === undefined || value === "" ? "—" : Number(value).toLocaleString("ru-RU", { maximumFractionDigits: 3 });
const localName = (value: unknown) => value && typeof value === "object" ? String((value as Record<string, unknown>).ru ?? (value as Record<string, unknown>).en ?? "") : "";
const matchLabel: Record<string, string> = { name: "по наименованию", sku: "по артикулу", hs_code: "по коду ТН ВЭД" };

// Step 3 of a confirmed invoice, packing list or waybill: the quantities it states, checked by the employee.
export function DocumentQuantitiesForm({ shipmentId, extractionId, sourceKind, transportId, items, lines, history, canApply }: {
  shipmentId: string; extractionId: string; sourceKind: string; transportId: string | null;
  items: QuantityFormItem[]; lines: DocumentLine[]; history: QuantityHistoryRow[]; canApply: boolean;
}) {
  const scoped = itemsInDocumentScope(items, transportId);
  const proposals = new Map(proposeDocumentQuantities(scoped, lines).map(proposal => [proposal.itemId, proposal]));
  const written = history.filter(row => row.extraction_id === extractionId);
  const target = defaultQuantityTarget(sourceKind);
  if (!scoped.length) return <p className="form-help">В поставке нет позиций{transportId ? " этого автомобиля" : ""}: количества по документу записывать некуда.</p>;
  if (!canApply) return written.length ? <p className="form-help">По этому документу записано значений количества: {written.length}.</p> : null;
  return <form action={applyDocumentQuantitiesAction} className="source-review-form document-quantities">
    <input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="extraction_id" value={extractionId}/>
    <p className="eyebrow">Шаг 3 · Количества по документу</p>
    <p className="form-help">Сверьте количество каждой позиции с оригиналом документа. {lines.length ? "Значения, найденные в строках документа, подставлены; строки в другой единице показаны подсказкой и не пересчитываются. " : "Строки товаров в документе не распознаны: введите количества вручную. "}Пустые поля не меняются. Отчёт, приёмка, себестоимость и «Сверка» используют записанные количества вместо заказанных.</p>
    <div className="table-wrap"><table className="data-table"><thead><tr><th>Товар</th><th>Заказано</th><th>Подтверждено</th><th>Отгружено</th><th>По документу</th></tr></thead><tbody>
      {scoped.map(item => {
        const proposal = proposals.get(item.id);
        const product = one(item.product);
        const unit = units[item.uom] ?? item.uom;
        const current = target === "confirmed" ? item.confirmed_quantity : item.shipped_quantity;
        return <tr key={item.id}>
          <td><strong>{product?.internal_sku}</strong> {localName(product?.name)}</td>
          <td>{number(item.ordered_quantity)} {unit}</td>
          <td>{number(item.confirmed_quantity)}</td>
          <td>{number(item.shipped_quantity)}</td>
          <td><label className="document-quantity-input"><input aria-label={`Количество по документу, ${unit}: ${product?.internal_sku ?? ""}`} name={`qty_${item.id}`} inputMode="decimal" pattern="[0-9 ]*([.,][0-9]{1,3})?" defaultValue={proposal?.quantity ?? (current ?? "") as string | number} placeholder={`заказано ${number(item.ordered_quantity)}`}/> {unit}</label>
            {proposal?.line && <small>{proposal.unitMismatch ? `В документе: ${number(proposal.line.quantity)} ${proposal.line.uom ?? ""} — другая единица, введите в «${unit}»` : `Строка ${proposal.line.line_number ?? ""} документа, найдена ${matchLabel[proposal.matchedBy ?? ""] ?? ""}`}</small>}
          </td>
        </tr>;
      })}
    </tbody></table></div>
    <div className="source-review-actions">
      <label>Записать как<select name="target" defaultValue={target}><option value="confirmed">Подтверждённое поставщиком (инвойс)</option><option value="shipped">Отгруженное (упаковочный лист, накладная)</option><option value="both">Подтверждённое и отгруженное</option></select></label>
      <label className="check-label"><input type="checkbox" name="checked" required/> Я сверил количества с оригиналом документа</label>
      <PendingSubmitButton className="primary compact" pendingText="Записываем…">Записать количества</PendingSubmitButton>
    </div>
    {written.length > 0 && <p className="form-help">Ранее по этому документу записано значений: {written.length}; последнее — {new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(written[0].confirmed_at))}.</p>}
  </form>;
}
