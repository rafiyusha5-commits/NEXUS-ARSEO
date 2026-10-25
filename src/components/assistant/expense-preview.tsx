import { EXPENSE_TYPES } from "@/lib/agent/expenses";
export type ExpenseData = { shipment_number: string; expense_type: keyof typeof EXPENSE_TYPES; payee: string | null; amount: string; currency: string;
 incurred_at: string; amount_kind: "actual" | "planned"; document: string | null; notes: string | null; performer: string; existing_same_count: number };
export function ExpensePreview({ preview: p }: { preview: ExpenseData }) {
 return <>
  <h4>Черновик расхода · {p.shipment_number}</h4>
  <dl className="assistant-values"><div><dt>Вид</dt><dd>{EXPENSE_TYPES[p.expense_type]}</dd></div>
   <div><dt>Сумма</dt><dd>{p.amount} {p.currency}</dd></div><div><dt>Тип суммы</dt><dd>{p.amount_kind === "planned" ? "План" : "Факт"}</dd></div>
   <div><dt>Дата расхода</dt><dd>{p.incurred_at}</dd></div><div><dt>Получатель</dt><dd>{p.payee ?? "Не указан"}</dd></div>
   <div><dt>Документ</dt><dd>{p.document ?? "Без документа"}</dd></div><div><dt>Исполнитель</dt><dd>{p.performer}</dd></div></dl>
  <p>Примечание: {p.notes ?? "Без примечания"}</p>
  {p.existing_same_count > 0 && <p role="note" className="admin-message">У вас уже есть совпадающих расходов: {p.existing_same_count}. Подтверждение создаст ещё один, не исправит существующий.</p>}
  <p className="admin-message">{p.amount_kind === "planned" ? "Плановый расход служит для сравнения; он не распределяется и не оплачивается, в фактическую себестоимость не входит." : "Фактический расход будет создан как черновик. До бухгалтерского подтверждения и распределения либо отмены он может блокировать новый расчёт себестоимости."}</p>
  {p.expense_type === "goods_cost" && <p>Стоимость товара не добавляется повторно как дополнительный расход в себестоимость.</p>}
  <p className="form-help">Кнопка подтверждает только создание черновика. Бухгалтерское подтверждение, распределение, расчёт себестоимости и оплата не выполняются. Остатки и платежи не меняются. Плановый расход не заменяется фактическим автоматически; история сохраняется.</p>
 </>;
}

