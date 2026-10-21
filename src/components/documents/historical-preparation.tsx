"use client";
import { useState } from "react";
import { preparationPreview, preparationGroups, preparationVariants, preparationStates, type PreparationInput, type PreparationChoice } from "@/lib/shipments/historical-preparation";
import { PendingSubmitButton } from "@/components/pending-submit-button";

export function HistoricalPreparation({ input, id, revision, prepareNew, save }: {
  input: PreparationInput; id: string; revision: number; prepareNew: boolean; save: (form: FormData) => Promise<void>;
}) {
  const [choices, setChoices] = useState(input.choices);
  const [newShipment, setNewShipment] = useState(prepareNew);
  const [step, setStep] = useState(0);
  const preview = preparationPreview({ ...input, choices });
  function choose(choice: PreparationChoice) { setChoices(old => [...old.filter(c => c.id !== choice.id), choice]); }
  return <section className="panel admin-section historical-preparation">
    <p className="eyebrow">Проект импорта · без проведения</p><h2>Подготовка исторической поставки</h2>
    <p>Заказ — потребность. Инвойс и упаковочный лист — документальная отгрузка. Фактическая приёмка требует отдельного основания. Учебное допущение не является подтверждённым фактом.</p>
    <nav className="historical-steps" aria-label="Этапы подготовки">{["1. Назначение документов", "2. Источники значений", "3. Действия перед переносом"].map((label, n) => <button type="button" key={label} className={step === n ? "primary" : "ghost"} aria-current={step === n ? "step" : undefined} onClick={() => setStep(n)}>{label}</button>)}</nav>
    <label>Назначение проекта<select value={String(newShipment)} onChange={e => setNewShipment(e.target.value === "true")}><option value="false">Подготовить существующую поставку источников</option><option value="true">Подготовить новую поставку (пока не создавать)</option></select></label>
    <p className="form-help">Назначение и вид документа в проекте — предположение сотрудника для разбора, не новое подтверждение. Госномер, язык и имя папки не определяют перевозку. Для новой поставки связи и подтверждения автоматически не переносятся.</p>
    {step === 0 && <div className="historical-cards">{preview.rows.map(row => <article key={row.id} className="historical-card"><h3>{row.title}</h3><a href={row.href}>Источник: текущая версия</a><p>Контекст Nexus: {row.transportId ? `автомобиль ${input.transportIds.indexOf(row.transportId) + 1}` : "вся поставка / автомобиль не установлен"}</p>
      {row.stale && <p role="status">Источник изменён. Прежнее назначение не перенесено.</p>}
      <label>Операция: {row.title}<select value={row.choice.group} onChange={e => choose({ ...row.choice, group: e.target.value as PreparationChoice["group"] })}>{Object.entries(preparationGroups).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label>Вид: {row.title}<select value={row.choice.variant} onChange={e => choose({ ...row.choice, variant: e.target.value as PreparationChoice["variant"] })}>{Object.entries(preparationVariants).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <small>{row.choice.group === "unknown" ? preparationStates.unknown : preparationStates.assumption}. Переводы и копии не объединяются и не суммируются.</small>
    </article>)}</div>}
    {step === 1 && <div>{preview.rows.map(row => <details className="historical-card" key={row.id} open><summary>{row.title} · {preparationGroups[row.choice.group]}</summary>
      <dl className="historical-values">{row.fields.filter(f => f.value !== null || ["invoice_number", "shipping_date", "cmr_number"].includes(f.key)).map(field => <div key={field.key}><dt>{field.label}</dt><dd>{field.value ?? "Нет данных"}<small>{preparationStates[field.state as keyof typeof preparationStates]} · <a href={row.href}>источник</a></small></dd></div>)}</dl>
      {row.quantities && <><h4>Документальное количество, не приёмка</h4>{!row.lines.length && <p>Товарные строки не установлены.</p>}{row.quantities.proposals.map(p => <p key={p.itemId}>{p.line?.sku ?? "Позиция"}: {p.quantity ?? "не установлено"} {p.line?.uom ?? ""} · {p.review ?? "Сопоставлено существующими правилами; проверьте по источнику"} <a href={row.href}>Источник</a></p>)}{row.quantities.warnings.map(w => <p key={w}>{w}</p>)}</>}
    </details>)}</div>}
    {step === 2 && <><h3>Перед переносом данных</h3><ul>{preview.actions.map(action => <li key={action}>{action}</li>)}</ul><p>Готовность к проведению не утверждена. Продажу и экспорт разбирайте отдельно; экспортный CMR не заменяет импортный. Источники двух автомобилей проверяются раздельно.</p><a href={`/shipments/${input.shipmentId}?tab=documents`}>Открыть штатные формы сопоставления, контекста и подтверждения</a></>}
    {input.complete && <form action={save}><input type="hidden" name="id" value={id}/><input type="hidden" name="shipment_id" value={input.shipmentId}/><input type="hidden" name="revision" value={revision}/><input type="hidden" name="prepare_new" value={String(newShipment)}/><input type="hidden" name="choices" value={JSON.stringify(preview.rows.map(r => r.choice))}/><PendingSubmitButton className="primary" pendingText="Сохраняем проект…">Сохранить черновик</PendingSubmitButton></form>}
    <p className="form-help">Сохраняются только ссылки и отметки проекта. Подтверждения документов, количества, остатки и деньги не изменяются. Для продолжения откройте сохранённый проект в Nexus.</p>
  </section>;
}
