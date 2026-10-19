import Link from "next/link";
import { buildShipmentDocumentReadiness } from "@/lib/templates/readiness";

export function ShipmentDocumentReadiness({ shipmentId, data, confirmedSourceFields, result }: { shipmentId: string; data: Record<string, unknown>; confirmedSourceFields: string[]; result?: ReturnType<typeof buildShipmentDocumentReadiness> }) {
  const readiness = result ?? buildShipmentDocumentReadiness(data, confirmedSourceFields);
  const groups = [...new Set(readiness.items.map(item => item.group))];
  const done = readiness.items.filter(item => item.ready).length;
  return <section className="panel admin-section document-readiness">
    <div className="panel-heading"><div><p className="eyebrow">Контроль перед формированием</p><h2>Готовность документов перевозки</h2></div><span className={readiness.ready ? "readiness-total is-ready" : "readiness-total is-missing"}>{done}/{readiness.items.length}</span></div>
    <p className="form-help">Проверка показывает данные, которые попадут в книгу Fazer, CMR, ТТН и упаковочный лист. Значения из загруженных документов учитываются только после подтверждения сотрудником.</p>
    <div className={readiness.ready ? "readiness-summary is-ready" : "readiness-summary is-missing"}>
      <strong>{readiness.ready ? "Обязательные данные заполнены" : `Не заполнено обязательных данных: ${readiness.requiredMissing}`}</strong>
      <span>{readiness.recommendedMissing ? `Дополнительно рекомендуется заполнить: ${readiness.recommendedMissing}` : "Рекомендованные данные также заполнены"}</span>
    </div>
    <div className="readiness-groups">{groups.map(group => <article key={group}><h3>{group}</h3><div className="readiness-list">{readiness.items.filter(item => item.group === group).map(item => <div className={item.ready ? "readiness-row is-ready" : item.required ? "readiness-row is-required" : "readiness-row is-warning"} key={item.key}><span aria-hidden="true">{item.ready ? "✓" : item.required ? "!" : "○"}</span><div><strong>{item.label}</strong><small>{item.ready ? `Источник: ${item.source}` : item.required ? "Обязательно для комплекта" : "Рекомендуется заполнить"}</small></div>{!item.ready && <Link href={`/shipments/${shipmentId}?tab=${item.tab}`}>Заполнить →</Link>}</div>)}</div></article>)}</div>
  </section>;
}
