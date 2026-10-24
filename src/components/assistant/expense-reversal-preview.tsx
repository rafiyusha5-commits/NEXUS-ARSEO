import { EXPENSE_TYPES } from "@/lib/agent/expenses";
export type ExpenseReversalData = { expense_id: string; shipment_number: string | null; customer: string | null; expense_type: keyof typeof EXPENSE_TYPES;
 payee: string | null; amount: string; currency: string; incurred_at: string; amount_kind: "planned" | "actual"; document: string | null; notes: string | null; creator: string; performer: string; status: "paid"; paid_at: string; paid_by: string; reason: string; allocation_count: number };
export function ExpenseReversalPreview({ preview: p }: { preview: ExpenseReversalData }) {
 return <>
  <h4>Оплачен → Сторнирован</h4>
  <dl className="assistant-values">
   <div><dt>Поставка</dt><dd>{p.shipment_number ?? "Не привязан к поставке"}</dd></div>
   <div><dt>Клиент</dt><dd>{p.customer ?? "Не указан"}</dd></div>
   <div><dt>Вид</dt><dd>{EXPENSE_TYPES[p.expense_type]}</dd></div>
   <div><dt>Сумма</dt><dd>{p.amount} {p.currency}</dd></div>
   <div><dt>Тип суммы</dt><dd>{p.amount_kind === "planned" ? "План" : "Факт"}</dd></div>
   <div><dt>Дата расхода</dt><dd>{p.incurred_at}</dd></div>
   <div><dt>Получатель</dt><dd>{p.payee ?? "Не указан"}</dd></div>
   <div><dt>Документ</dt><dd>{p.document ?? "Без документа"}</dd></div>
   <div><dt>Оплатил</dt><dd>{p.paid_by}</dd></div>
   <div><dt>Оплата зафиксирована</dt><dd>{p.paid_at}</dd></div>
   <div><dt>Создал</dt><dd>{p.creator}</dd></div>
   <div><dt>Сторнирует</dt><dd>{p.performer}</dd></div>
  </dl>
  <p>Примечание: {p.notes ?? "Без примечания"}</p>
  <p className="form-help">ID расхода: {p.expense_id}</p>
  <p><strong>Причина сторнирования:</strong> {p.reason}</p>
  <p>Распределений сохраняется в истории: {p.allocation_count}.</p>
  <p className="admin-message">{p.amount_kind === "planned" ? "Плановый расход исключается из будущего сравнения с планом; фактическим расходом он не становится." : "Фактический расход исключается из новых расчётов. Черновики себестоимости поставки потребуют пересчёта перед утверждением."}</p>
  {p.expense_type === "goods_cost" && <p>При новом расчёте вместо сторнированной стоимости товара может использоваться закупочная цена позиции. Это не простое вычитание суммы.</p>}
  <p className="form-help">Будут записаны сторнирование, причина, сотрудник и время. Сведения об оплате (кто и когда) сохраняются. Расход и распределения не удаляются. Утверждённые версии и стоимость партий сохраняются; автоматического пересчёта нет. Возврат денег, новая оплата и складские движения не выполняются. Сторнирование не означает, что деньги возвращены. Для неоплаченного расхода нужна отдельная отмена.</p>
 </>;
}
