type Vehicle = { id: string; label: string };
type Change = { id: string; old_transport_id: string | null; new_transport_id: string | null; reason: string; changed_at: string; changed_by: string };
export function SourceTransportContext({ shipmentId, extractionId, shipmentLabel, transportId, vehicles, editable, history, historyUnavailable, action }: {
  shipmentId: string; extractionId: string; shipmentLabel: string; transportId: string | null; vehicles: Vehicle[];
  editable: boolean; history: Change[]; historyUnavailable: boolean; action: (form: FormData) => Promise<void>;
}) {
  const label = (id: string | null) => id ? vehicles.find(v => v.id === id)?.label ?? "Автомобиль недоступен или больше не действует" : "Вся поставка; участок перевозки не задан";
  return <section className="panel source-transport-context" aria-label="Контекст документа">
    <strong>{shipmentLabel}</strong>
    <p>{label(transportId)}</p>
    <small>Прочитанные реквизиты — предложение. Контекст не определяется по госномеру, языку или папке. Импорт и последующая продажа могут иметь разные перевозки.</small>
    {!transportId && <p role="status">Проверьте назначение документа. Если он описывает конкретную перевозку, выберите её автомобиль. Документ всей поставки не доказывает наличие CMR каждого автомобиля.</p>}
    {editable ? <form action={action} className="form-grid">
      <input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="extraction_id" value={extractionId}/>
      <label>Автомобиль документа<select name="transport_id" defaultValue={transportId ?? ""}><option value="">Вся поставка</option>{vehicles.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}</select></label>
      <label>Причина изменения контекста<input name="context_reason" minLength={5} maxLength={500} required placeholder="К какой перевозке относится этот документ"/></label>
      <button className="ghost compact" type="submit">Сохранить контекст</button>
    </form> : <p>Контекст подтверждённого, устаревшего или обрабатываемого источника здесь не меняется. Подтверждение не переносится на другую машину.</p>}
    <details><summary>История контекста ({history.length})</summary>
      {historyUnavailable ? <p>История загружена не полностью. Обновите страницу.</p> : history.length ? history.map(h => <p key={h.id}>
        {new Date(h.changed_at).toLocaleString("ru-RU", { timeZone: "Asia/Almaty" })} · сотрудник {h.changed_by}<br/>
        {label(h.old_transport_id)} → {label(h.new_transport_id)}<br/>{h.reason}
      </p>) : <p>Зафиксированных изменений нет. Старые связи автоматически не перепроверялись.</p>}
    </details>
  </section>;
}
