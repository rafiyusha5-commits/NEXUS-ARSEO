import { EXPENSE_TYPES } from "@/lib/agent/expenses";
export type ExpenseConfirmationData = { expense_id: string; shipment_number: string | null; customer: string | null; expense_type: keyof typeof EXPENSE_TYPES;
 payee: string | null; amount: string; currency: string; incurred_at: string; amount_kind: "planned" | "actual"; document: string | null; notes: string | null; creator: string; performer: string };
export function ExpenseConfirmationPreview({ preview: p }: { preview: ExpenseConfirmationData }) {
 return <>
  <h4>Черновик → Подтверждён</h4>
  <dl className="assistant-values">
   <div><dt>Поставка</dt><dd>{p.shipment_number ?? "Не привязан к поставке"}</dd></div>
   <div><dt>Клиент</dt><dd>{p.customer ?? "Не указан"}</dd></div>
   <div><dt>Вид</dt><dd>{EXPENSE_TYPES[p.expense_type]}</dd></div>
   <div><dt>Сумма</dt><dd>{p.amount} {p.currency}</dd></div>
   <div><dt>Тип суммы</dt><dd>{p.amount_kind === "planned" ? "План" : "Факт"}</dd></div>
   <div><dt>Дата расхода</dt><dd>{p.incurred_at}</dd></div>
   <div><dt>Получатель</dt><dd>{p.payee ?? "Не указан"}</dd></div>
   <div><dt>Документ</dt><dd>{p.document ?? "Без документа"}</dd></div>
   <div><dt>Создал</dt><dd>{p.creator}</dd></div>
   <div><dt>Подтвердит</dt><dd>{p.performer}</dd></div>
  </dl>
  <p>Примечание: {p.notes ?? "Без примечания"}</p>
  <p className="form-help">ID расхода: {p.expense_id}</p>
  <p className="admin-message">{p.amount_kind === "planned" ? "План останется планом: только для сравнения, без распределения и оплаты." : "Фактический расход станет подтверждённым. Распределение по товарам и расчёт себестоимости выполняются отдельно; одного подтверждения может быть недостаточно для расчёта."}</p>
  {p.expense_type === "goods_cost" && <p>Стоимость товара не добавляется повторно как дополнительный расход.</p>}
  <p className="form-help">Будут записаны бухгалтерский статус, сотрудник и время подтверждения. Сумма, валюта и план/факт не меняются. Оплата не создаётся, остатки не меняются, утверждённые расчёты не переписываются. Ошибка исправляется отдельной штатной операцией, не удалением истории.</p>
 </>;
}
