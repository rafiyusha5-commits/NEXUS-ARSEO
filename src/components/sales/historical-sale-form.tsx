import { randomUUID } from "node:crypto";
import { createHistoricalCustomerOrder } from "@/app/sales/actions";
import { businessToday } from "@/lib/dates/business-day";

type Choice = { id: string; label: string };
export function HistoricalSaleForm({ customers, warehouses, currencies, contracts }: {
  customers: Choice[]; warehouses: Choice[]; currencies: Choice[]; contracts: Choice[];
}) {
  const yesterday = new Date(Date.parse(`${businessToday()}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  return <details className="panel admin-section create-disclosure">
    <summary><span><small>Только администратор</small><strong>Внести продажу задним числом</strong></span><b aria-hidden="true">+</b></summary>
    <div className="create-disclosure-body">
      <p className="form-help">Для уже состоявшейся отгрузки. Укажите её фактическую дату и документ-основание. После создания добавьте товары, выберите партии и подтвердите отгрузку. Остатки и ОСГ проверяются; время внесения сохраняется отдельно.</p>
      <form action={createHistoricalCustomerOrder} className="reference-form">
        <input type="hidden" name="request_id" value={randomUUID()}/>
        <label>Клиент<select name="customer_id" required defaultValue=""><option value="" disabled>Выберите клиента</option>{customers.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
        <label>Склад отгрузки<select name="warehouse_id" required defaultValue=""><option value="" disabled>Выберите склад</option>{warehouses.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
        <label>Фактическая дата отгрузки<input name="shipment_date" type="date" min="1900-01-01" max={yesterday} required/></label>
        <label>Валюта<select name="currency_id" required defaultValue=""><option value="" disabled>Выберите валюту</option>{currencies.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
        <label>Контракт<select name="contract_id" defaultValue=""><option value="">Без контракта</option>{contracts.map(c=><option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
        <label>Документ-основание<input name="reference" required maxLength={200} placeholder="Номер и дата накладной или инвойса"/></label>
        <label>Причина внесения задним числом<input name="reason" required maxLength={500}/></label>
        <label>Комментарий<input name="notes"/></label>
        <button className="primary" type="submit">Создать историческую продажу</button>
      </form>
    </div>
  </details>;
}
