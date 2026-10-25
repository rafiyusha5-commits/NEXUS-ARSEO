import { EXPENSE_TYPES } from "@/lib/agent/expenses";
export type ExpensePaymentData = { expense_id: string; shipment_number: string | null; customer: string | null; expense_type: keyof typeof EXPENSE_TYPES;
 payee: string | null; amount: string; currency: string; incurred_at: string; amount_kind: "planned" | "actual"; document: string | null; notes: string | null; creator: string; performer: string };
export function ExpensePaymentPreview({ preview: p }: { preview: ExpensePaymentData }) {
 return <>
  <h4>Распределён → Оплачен</h4>
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
   <div><dt>Зафиксирует оплату</dt><dd>{p.performer}</dd></div>
  </dl>
  <p>Примечание: {p.notes ?? "Без примечания"}</p>
  <p className="form-help">ID расхода: {p.expense_id}</p>
  <p className="admin-message">Будет зафиксирована полная оплата этого расхода в учёте. Подтверждайте только уже состоявшуюся оплату, сверив сумму, валюту и получателя с платёжными документами. Частичная оплата здесь не поддерживается.</p>
  <p className="form-help">Кнопка не переводит деньги, не обращается в банк и не проверяет банковское зачисление. Будут записаны статус «Оплачен», текущий сотрудник и время фиксации в системе — не выбранная дата банковского платежа. Сумма и распределения не меняются; повторного расхода, пересчёта себестоимости и складских движений нет. После фиксации обычная отмена недоступна: исправление — отдельное сторнирование с причиной и правами, без автоматического возврата денег.</p>
 </>;
}
