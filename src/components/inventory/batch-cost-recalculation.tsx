import { PendingSubmitButton } from "@/components/pending-submit-button";
import { recalculateBatchCost } from "@/app/inventory/actions";

const units: Record<string, string> = { piece: "шт.", box: "кор.", layer: "слой", pallet: "пал.", truck: "фура" };

type CostState = { cost: string | null; uom: string | null; currency: string | null; basis: string | null };
type Source = {
  shipment_number: string | null; vehicle: number | null; uom: string; quantity: string;
  unit_cost: string | null; currency: string | null; calculation_version: number | null; approved: boolean;
};
export type BatchCostPreview = { batch_id: string; old: CostState; new: CostState; changes: boolean; sources: Source[]; stamp: string };

const number = (value: string | null) => value == null ? null : Number(value).toLocaleString("ru-RU", { maximumFractionDigits: 4 });
function cost(state: CostState) {
  const value = number(state.cost);
  if (value == null) return "не утверждена";
  return `${value} ${state.currency ?? ""} за ${units[state.uom ?? ""] ?? state.uom ?? "ед."}`;
}

/** Administrator recalculation of one batch by its receipts: was, will be, of what it is made, and a reason. */
export function BatchCostRecalculation({ preview }: { preview: BatchCostPreview }) {
  return <details className="panel admin-section create-disclosure">
    <summary><span><small>Себестоимость</small><strong>Пересчитать себестоимость партии по приходам</strong></span></summary>
    <p className="form-help">Партия получает средневзвешенную себестоимость всех своих приходов. Пока хотя бы один приход не утверждён, себестоимость не задаётся. Утверждённые расчёты поставок не меняются, меняется только себестоимость этой партии. Изменение записывается в журнал действий.</p>
    <div className="detail-grid">
      <div><small>Сейчас</small><strong>{cost(preview.old)}</strong>{preview.old.basis === "source_item" && <small>по прежнему правилу: по первой позиции поставки</small>}</div>
      <div><small>Станет</small><strong>{cost(preview.new)}</strong></div>
    </div>
    <table className="import-table">
      <thead><tr><th>Поставка</th><th>Машина</th><th>Принято</th><th>Себестоимость единицы</th><th>Расчёт</th></tr></thead>
      <tbody>{preview.sources.map((source, index) => <tr key={index}>
        <td>{source.shipment_number ?? "—"}</td>
        <td>{source.vehicle ?? "—"}</td>
        <td>{number(source.quantity)} {units[source.uom] ?? source.uom}</td>
        <td>{source.approved ? `${number(source.unit_cost)} ${source.currency ?? ""}` : "не утверждена"}</td>
        <td>{source.calculation_version ? `версия ${source.calculation_version}` : "—"}</td>
      </tr>)}</tbody>
    </table>
    {preview.changes
      ? <form action={recalculateBatchCost} className="inline-action">
        <input type="hidden" name="batch_id" value={preview.batch_id} />
        <input type="hidden" name="stamp" value={preview.stamp} />
        <label>Причина пересчёта<input name="reason" required minLength={10} maxLength={1000} placeholder="Например: партия пришла двумя машинами" /></label>
        <PendingSubmitButton pendingText="Пересчитываем…" className="secondary" type="submit">Пересчитать себестоимость</PendingSubmitButton>
      </form>
      : <p className="form-help">Себестоимость уже соответствует приходам партии. Пересчёт не нужен.</p>}
  </details>;
}
