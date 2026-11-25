import { correctShipmentDates } from "@/app/shipments/actions";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { loadPermissions } from "@/lib/permissions";
import { businessDay } from "@/lib/shipments/date-corrections";
import { requireUser } from "@/lib/auth/access";

const one = <T,>(value: T | T[] | null | undefined) => Array.isArray(value) ? value[0] : value ?? undefined;
const localName = (value: unknown) => value && typeof value === "object" ? String((value as Record<string, unknown>).ru ?? (value as Record<string, unknown>).en ?? "—") : "—";
const fieldLabel: Record<string, string> = {
  started_at: "Начало этапа", completed_at: "Завершение этапа", actual_loading_date: "Погрузка",
  actual_arrival_date: "Прибытие", received_at: "Приёмка",
};
const showDay = (value: string | null) => {
  const day = businessDay(value);
  return day ? new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`)) : "—";
};

function DayInput({ name, value, today, label }: { name: string; value: string; today: string; label: string }) {
  return <><input type="date" name={name} defaultValue={value} max={today} aria-label={label}/><input type="hidden" name={`orig_${name}`} value={value}/></>;
}

// Real dates of a shipment that was executed before it was entered: what the stages, vehicles and receipts
// recorded as "today" can be set to the actual days, with a reason and a history.
export async function ShipmentActualDatesPanel({ shipmentId, shipmentStatus }: { shipmentId: string; shipmentStatus: string }) {
  // The render's own client (requireUser is memoized per render): permissions the page already asked for are
  // answered without another round trip (src/lib/permissions.ts).
  const { supabase } = await requireUser();
  const permissions = await loadPermissions(supabase, ["shipments.backdate"] as const);
  if (!permissions["shipments.backdate"] || shipmentStatus === "cancelled") return null;
  const [{ data: runs }, { data: transports }, { data: receipts }, { data: corrections }] = await Promise.all([
    supabase.from("shipment_stage_runs").select("id,status,started_at,completed_at,stage:shipment_stages(name,sequence_order),transport:shipment_transports(sequence_no)")
      .eq("shipment_id", shipmentId).in("status", ["in_progress", "completed"]),
    supabase.from("shipment_transports").select("id,sequence_no,status,actual_loading_date,actual_arrival_date").eq("shipment_id", shipmentId).neq("status", "cancelled").order("sequence_no"),
    supabase.from("shipment_transport_receipts").select("id,received_at,transport:shipment_transports(sequence_no)").eq("shipment_id", shipmentId),
    supabase.from("shipment_date_corrections").select("id,entity_type,field,previous_value,new_value,reason,corrected_at,employee:profiles!shipment_date_corrections_corrected_by_fkey(full_name)")
      .eq("shipment_id", shipmentId).order("corrected_at", { ascending: false }).limit(20),
  ]);
  const today = businessDay(new Date().toISOString());
  const stageRuns = (runs ?? []).sort((left, right) => (one(left.stage)?.sequence_order ?? 0) - (one(right.stage)?.sequence_order ?? 0) || (one(left.transport)?.sequence_no ?? 0) - (one(right.transport)?.sequence_no ?? 0));
  const loaded = new Set(["loading", "in_transit", "at_customs", "arrived", "unloaded"]);
  const arrived = new Set(["arrived", "unloaded"]);
  const hasDates = stageRuns.length > 0 || (transports ?? []).some(transport => loaded.has(transport.status)) || (receipts ?? []).length > 0;

  return <section className="panel admin-section actual-dates" id="actual-dates">
    <details>
      <summary><div><p className="eyebrow">Ввод исполненной поставки</p><h2>Фактические даты</h2></div><span className="page-count">исправлений: {(corrections ?? []).length}</span></summary>
      <p className="form-help">Nexus ставит дату в момент отметки: если поставка уже прошла, этапы, автомобили и приёмка получили сегодняшний день. Укажите реальные даты — они попадут в отчёт, сроки этапов и порядок FIFO партий. Будущие даты недоступны; неизменённые поля не отправляются; причина и прежние значения сохраняются в журнале.</p>
      {!hasDates && <p className="empty-state">Пока нечего исправлять: нет начатых этапов, загруженных автомобилей и приёмок.</p>}
      {hasDates && <form action={correctShipmentDates} className="actual-dates-form">
        <input type="hidden" name="shipment_id" value={shipmentId}/>
        {(transports ?? []).some(transport => loaded.has(transport.status)) && <fieldset><legend>Автомобили</legend><div className="table-wrap"><table className="data-table"><thead><tr><th>Автомобиль</th><th>Погрузка</th><th>Прибытие</th></tr></thead><tbody>
          {(transports ?? []).filter(transport => loaded.has(transport.status)).map(transport => <tr key={transport.id}>
            <td>№{transport.sequence_no}</td>
            <td><DayInput name={`transport_loading_${transport.id}`} value={transport.actual_loading_date ?? ""} today={today} label={`Погрузка автомобиля №${transport.sequence_no}`}/></td>
            <td>{arrived.has(transport.status) ? <DayInput name={`transport_arrival_${transport.id}`} value={transport.actual_arrival_date ?? ""} today={today} label={`Прибытие автомобиля №${transport.sequence_no}`}/> : <small>ещё не прибыл</small>}</td>
          </tr>)}
        </tbody></table></div></fieldset>}
        {(receipts ?? []).length > 0 && <fieldset><legend>Приёмка на склад</legend><div className="table-wrap"><table className="data-table"><thead><tr><th>Автомобиль</th><th>Дата приёмки</th></tr></thead><tbody>
          {(receipts ?? []).map(receipt => <tr key={receipt.id}><td>№{one(receipt.transport)?.sequence_no ?? "—"}</td><td><DayInput name={`receipt_${receipt.id}`} value={businessDay(receipt.received_at)} today={today} label={`Приёмка автомобиля №${one(receipt.transport)?.sequence_no ?? ""}`}/><small>Дата поступления партий этой приёмки изменится вместе с ней.</small></td></tr>)}
        </tbody></table></div></fieldset>}
        {stageRuns.length > 0 && <fieldset><legend>Этапы</legend><div className="table-wrap"><table className="data-table"><thead><tr><th>Этап</th><th>Начало</th><th>Завершение</th></tr></thead><tbody>
          {stageRuns.map(run => { const stage = one(run.stage); const transport = one(run.transport); return <tr key={run.id}>
            <td>{stage?.sequence_order}. {localName(stage?.name)}{transport ? <small>Автомобиль №{transport.sequence_no}</small> : null}</td>
            <td><DayInput name={`stage_started_${run.id}`} value={businessDay(run.started_at)} today={today} label={`Начало этапа «${localName(stage?.name)}»`}/></td>
            <td>{run.status === "completed" ? <DayInput name={`stage_completed_${run.id}`} value={businessDay(run.completed_at)} today={today} label={`Завершение этапа «${localName(stage?.name)}»`}/> : <small>в работе</small>}</td>
          </tr>; })}
        </tbody></table></div></fieldset>}
        <div className="source-review-actions"><label>Причина исправления<input name="reason" required maxLength={500} placeholder="Например: ввод поставки, исполненной до запуска Nexus"/></label><PendingSubmitButton className="primary compact" pendingText="Сохраняем…">Сохранить фактические даты</PendingSubmitButton></div>
      </form>}
      {(corrections ?? []).length > 0 && <div className="operation-history-list">{(corrections ?? []).map(entry => <article className="operation-history-row" key={entry.id}>
        <time>{new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(entry.corrected_at))}</time>
        <div><strong>{fieldLabel[entry.field] ?? entry.field}: {showDay(entry.previous_value)} → {showDay(entry.new_value)}</strong><small>{entry.reason}</small></div>
        <small>{one(entry.employee)?.full_name ?? "—"}</small>
      </article>)}</div>}
    </details>
  </section>;
}
