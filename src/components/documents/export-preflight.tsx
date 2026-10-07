import type { PreflightResult } from "@/lib/export-workbook/index.ts";
import { OUTPUT_LABELS, type ExportOutput } from "@/lib/export-workbook/index.ts";

type OutputReadiness = PreflightResult & { output: ExportOutput };

export function ExportPreflight({ readiness }: { readiness: OutputReadiness[] }) {
  if (!readiness.length) return null;
  return <section className="panel admin-section document-readiness">
    <div className="panel-heading"><div><p className="eyebrow">Предварительная проверка</p><h2>Незаполненные поля экспортного комплекта</h2></div></div>
    <p className="form-help">Список строится по эталонной книге: показано, какие ячейки останутся пустыми и откуда нужно взять значение. Обязательные поля блокируют выпуск документа; рекомендуемые остаются пустыми в готовом файле.</p>
    <div className="readiness-groups">{readiness.map(item => <article key={item.output}>
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
  </section>;
}
