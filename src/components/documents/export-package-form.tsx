"use client";

import { useMemo, useState } from "react";
import { generateExportPackageAction } from "@/app/templates/actions";
import { OUTPUT_LABELS, type ExportOutput, type PreflightResult } from "@/lib/export-workbook/index.ts";

type OutputReadiness = PreflightResult & { output: ExportOutput };
const OUTPUTS: ExportOutput[] = ["workbook", "cmr", "ttn", "packing_list"];
const CHECK_LABELS: Record<ExportOutput, string> = {
  workbook: "Заполненная книга XLSX",
  cmr: "CMR (XLSX, лист CMR)",
  ttn: "ТТН (XLSX, лист ТТН)",
  packing_list: "Упаковочный лист (XLSX, лист упаков.лист)",
};

export function ExportPackageForm({
  templateId,
  shipmentId,
  transportId,
  includePrices,
  readiness,
  initialNumbers,
  templateMissingKeys,
  shipmentReady,
}: {
  templateId: string;
  shipmentId: string;
  transportId?: string;
  includePrices: boolean;
  readiness: OutputReadiness[];
  initialNumbers: { cmr: string; ttn: string; packing_list: string };
  templateMissingKeys: string[];
  shipmentReady: boolean;
}) {
  const [selected, setSelected] = useState<ExportOutput[]>(OUTPUTS);
  const [numbers, setNumbers] = useState(initialNumbers);
  const selectedReadiness = useMemo(() => readiness.filter(item => selected.includes(item.output)).map(item => {
    const issues = item.issues.filter(issue => !(
      (issue.key === "cmrNumber" && numbers.cmr.trim())
      || (issue.key === "ttnNumber" && numbers.ttn.trim())
      || (issue.key === "packingListNumber" && numbers.packing_list.trim())
    ));
    const requiredMissing = issues.filter(issue => issue.severity === "required").length;
    return { ...item, issues, requiredMissing, recommendedMissing: issues.length - requiredMissing, ready: requiredMissing === 0 };
  }), [readiness, selected, numbers]);
  const selectedMissing = selectedReadiness.some(item => !item.ready);
  const unresolvedTemplateFields = templateMissingKeys.filter(key => !(
    (key === "cmr_number" && numbers.cmr.trim())
    || (key === "ttn_number" && numbers.ttn.trim())
    || (key === "packing_list_number" && numbers.packing_list.trim())
  ));
  const disabled = selected.length === 0 || unresolvedTemplateFields.length > 0 || !shipmentReady || selectedMissing;

  const toggle = (output: ExportOutput, checked: boolean) => setSelected(current => checked
    ? [...current, output]
    : current.filter(item => item !== output));

  return <>
    <section className="panel admin-section document-readiness">
      <div className="panel-heading"><div><p className="eyebrow">Предварительная проверка</p><h2>Незаполненные поля выбранных документов</h2></div></div>
      <p className="form-help">Проверка меняется вместе с галочками ниже. Обязательные поля блокируют только тот документ, в котором они используются; рекомендуемые могут остаться пустыми.</p>
      {!selected.length && <div className="login-error admin-message">Отметьте хотя бы один документ.</div>}
      <div className="readiness-groups">{selectedReadiness.map(item => <article key={item.output}>
        <h3>{OUTPUT_LABELS[item.output]}</h3>
        <div className={item.ready ? "readiness-summary is-ready" : "readiness-summary is-missing"}>
          <strong>{item.ready ? "Готов к выпуску" : `Обязательных не хватает: ${item.requiredMissing}`}</strong>
          <span>{item.recommendedMissing ? `Рекомендуется: ${item.recommendedMissing}` : "Всё заполнено"}</span>
        </div>
        {item.issues.length > 0 && <div className="readiness-list">{item.issues.map(issue => <div className={issue.severity === "required" ? "readiness-row is-required" : "readiness-row is-warning"} key={issue.key}>
          <span aria-hidden="true">{issue.severity === "required" ? "!" : "·"}</span>
          <div><strong>{issue.label}</strong><small>{issue.where}</small><small>Источник: {issue.source}</small></div>
        </div>)}</div>}
      </article>)}</div>
    </section>
    <section className="panel admin-section">
      <div className="panel-heading"><div><p className="eyebrow">Экспортный комплект</p><h2>Выберите документы</h2></div></div>
      <form action={generateExportPackageAction} className="doc-form">
        <input type="hidden" name="template_id" value={templateId}/>
        <input type="hidden" name="shipment_id" value={shipmentId}/>
        {transportId && <input type="hidden" name="transport_id" value={transportId}/>} 
        <input type="hidden" name="include_prices" value={includePrices ? "true" : "false"}/>
        {(selected.includes("workbook") || selected.includes("cmr")) && <label>Номер CMR<input name="cmr_number" maxLength={120} required value={numbers.cmr} onChange={event => setNumbers(current => ({...current, cmr: event.target.value}))}/></label>}
        {(selected.includes("workbook") || selected.includes("ttn")) && <label>Номер ТТН<input name="ttn_number" maxLength={120} required value={numbers.ttn} onChange={event => setNumbers(current => ({...current, ttn: event.target.value}))}/></label>}
        {(selected.includes("workbook") || selected.includes("packing_list")) && <label>Номер упаковочного листа<input name="packing_list_number" maxLength={120} required value={numbers.packing_list} onChange={event => setNumbers(current => ({...current, packing_list: event.target.value}))}/></label>}
        <div className="package-output-checks doc-form-full">{OUTPUTS.map(output => <label key={output}>
          <input type="checkbox" name="outputs" value={output} checked={selected.includes(output)} onChange={event => toggle(output, event.target.checked)}/> {CHECK_LABELS[output]}
        </label>)}</div>
        <button className="primary" disabled={disabled}>Сформировать отмеченные документы</button>
        {selectedMissing && <p className="login-error admin-message doc-form-full">Заполните обязательные данные для отмеченных документов.</p>}
        {!shipmentReady && <p className="login-error admin-message doc-form-full">Сначала заполните обязательные данные поставки в блоке готовности выше.</p>}
        <p className="form-help doc-form-full">Все отмеченные файлы формируются из одного проверенного снимка поставки, регистрируются в реестре и автоматически связываются с поставкой.</p>
      </form>
    </section>
  </>;
}
