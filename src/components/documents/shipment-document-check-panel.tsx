import { DocumentActions } from "@/components/documents/document-actions";
import { loadDocumentActions } from "@/lib/documents/load-actions";
import { createClient } from "@/lib/supabase/server";
import { loadPermissions } from "@/lib/permissions";
import { CHECK_STATE_LABEL, FIELD_LABELS, describeValues, parseDocumentCheck, summarizeFindings, type CheckFinding } from "@/lib/document-check/rules";
import { createDocumentCheckTaskAction, runDocumentCheckAction } from "@/app/shipments/document-check-actions";
import { PendingSubmitButton } from "@/components/pending-submit-button";

const sourceLabel: Record<string, string> = { recognition: "после распознавания или по кнопке", manual: "по кнопке", daily: "ежедневная проверка" };

// Agent «Сверка» (shipment documents against the card). The findings are calculated by the database for the signed-in
// employee each time the card opens; the agent itself changes nothing in the shipment.
export async function ShipmentDocumentCheckPanel({ shipmentId, notice }: { shipmentId: string; notice?: { kind: "error" | "success"; message: string } }) {
  const supabase = await createClient();
  const permissions = await loadPermissions(supabase, ["shipments.view", "documents.view", "tasks.create"] as const);
  if (!permissions["shipments.view"] || !permissions["documents.view"]) return null;
  const { data, error } = await supabase.rpc("shipment_document_check", { p_shipment_id: shipmentId });
  const check = parseDocumentCheck(data);
  const summary = summarizeFindings(check.findings);
  const documentActions = await loadDocumentActions(supabase, check.findings.map(finding => finding.documentId));
  const groups: Array<{ title: string; items: CheckFinding[] }> = [
    { title: "Ошибки", items: check.findings.filter((finding) => finding.severity === "error") },
    { title: "Предупреждения", items: check.findings.filter((finding) => finding.severity === "warning") },
  ].filter((group) => group.items.length > 0);

  // Compact by default (2026-11-23): one line with the result; the findings open by themselves when there are errors.
  const headline = error ? "Проверка недоступна" : !check.findings.length ? "Замечаний нет"
    : `${check.findings[0].message}${check.findings.length > 1 ? ` и ещё ${check.findings.length - 1}` : ""}`;
  return <section className={`panel admin-section docs-agent docs-agent-${error ? "warning" : summary.state}`} id="document-check">
    <div className="panel-heading"><div><p className="eyebrow">Агент «Сверка»</p><h2>{headline}</h2></div><div className="topbar-actions">
      {!error && <span className={`doc-check-state doc-check-${summary.state}`}>{CHECK_STATE_LABEL[summary.state]}{summary.state !== "ok" ? ` · ${summary.errors ? `ошибок ${summary.errors}` : ""}${summary.errors && summary.warnings ? ", " : ""}${summary.warnings ? `предупреждений ${summary.warnings}` : ""}` : ""}</span>}
      <form action={runDocumentCheckAction}><input type="hidden" name="shipment_id" value={shipmentId}/><PendingSubmitButton className="ghost compact doc-check-button" pendingText="Проверяем…">Проверить сейчас</PendingSubmitButton></form>
    </div></div>
    {notice?.kind === "error" && <div className="login-error admin-message" role="status">{notice.message}</div>}
    {notice?.kind === "success" && <div className="login-success admin-message" role="status">{notice.message}</div>}
    <details className="docs-collapse" open={summary.errors > 0 || Boolean(notice)}>
    <summary>{check.findings.length ? `Подробнее: замечаний ${check.findings.length}` : "Что проверяет агент"}</summary>
    <p className="form-help">Сверяет документы с карточкой поставки: госномера, вес и паллеты (допуск по весу — 2 % или 50 кг, что больше), номера договора и инвойса, обязательные документы по поставке и каждому автомобилю, сроки действия до планового прибытия. Проверка идёт после каждого распознавания и раз в день; о новых проблемах приходят уведомления в Nexus. Агент ничего не исправляет сам.</p>
    {error && <div className="setup-notice">Проверка недоступна. Если модуль ещё не подключён, примените миграцию <strong>202609276400_document_check_agent.sql</strong>.</div>}
    {!error && !check.findings.length && <div className="setup-notice">По выполненным проверкам реквизитов замечаний нет. Товарные строки и отличие от первоначального заказа проверяются отдельно ниже. Этот результат не подтверждает чтение сотрудником, полное совпадение документов или готовность нового комплекта.</div>}
    {groups.map((group) => <div className="doc-check-group" key={group.title}><h3>{group.title}</h3><ul className="doc-check-list">{group.items.map((finding) => {
      const values = describeValues(finding);
      return <li className={`doc-check-item doc-check-item-${finding.severity}`} key={finding.key}>
        <div>
          <strong>{finding.message}</strong>
          <small>
            {finding.transportNo ? `Автомобиль №${finding.transportNo}` : "Вся поставка"}
            {finding.field && FIELD_LABELS[finding.field] ? ` · ${FIELD_LABELS[finding.field]}` : ""}
            {values ? ` · ${values}` : ""}
          </small>
          {finding.documentId && <><small>{finding.documentTitle}</small><DocumentActions document={documentActions[finding.documentId]}/></>}
        </div>
        {permissions["tasks.create"] && <form action={createDocumentCheckTaskAction}><input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="finding_key" value={finding.key}/><button className="ghost compact doc-check-button" type="submit">Создать задачу</button></form>}
      </li>;
    })}</ul></div>)}
    {check.lastRunAt && <p className="form-help">Последняя автоматическая проверка: {new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Qyzylorda" }).format(new Date(check.lastRunAt))}{check.lastRunSource ? ` (${sourceLabel[check.lastRunSource] ?? check.lastRunSource})` : ""}.</p>}
    </details>
  </section>;
}
