import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { requirePageUser } from "@/lib/auth/access";
import { countDate, countKindLabel, countStatusLabel, type CountList } from "@/lib/inventory/counts";
import { createInventoryCount, setInventoryCountTolerance } from "./actions";

// Inventory counts: the journal and a new draft. The database decides who may see, create and approve.
export default async function InventoryCountsPage({ searchParams }: { searchParams: Promise<{ error?: string; success?: string }> }) {
  const notice = await searchParams;
  const { profile, roles, supabase } = await requirePageUser();
  const [{ data, error }, { data: warehouses }] = await Promise.all([
    supabase.rpc("inventory_count_list", { p_limit: 200 }),
    supabase.from("warehouses").select("id,code,name").eq("status", "active").eq("is_virtual", false).order("code"),
  ]);
  const list = data as CountList | null;
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="inventory-counts"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Склад</p><h1>Инвентаризация</h1></div></header>
    {notice.error && <div className="login-error admin-message">{notice.error}</div>}{notice.success && <div className="login-success admin-message">{notice.success}</div>}
    {error && <div className="setup-notice">Инвентаризация доступна с правом на остатки или на пересчёт после миграции <strong>202611280300_inventory_counts.sql</strong>.</div>}
    {list && <>
      <p className="form-help">Пересчёт склада целиком или его части. При старте запоминается учётный остаток, и движения по считаемым местам блокируются до проведения или отмены; остальные места работают как обычно. В слепом пересчёте считающие не видят учётного количества. Позиции с расхождением сверх допуска пересчитывает другой сотрудник. Остатки меняются только при проведении — документом корректировки с причиной по каждой недостаче.</p>
      {list.can_manage && <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Новый пересчёт</p><h2>Черновик</h2></div></div>
        <form action={createInventoryCount} className="reference-form">
          <label>Склад<select name="warehouse_id" required>{(warehouses ?? []).map(w => <option key={w.id} value={w.id}>{(w.name as { ru?: string } | null)?.ru ?? w.code}</option>)}</select></label>
          <label>Вид<select name="kind" defaultValue="partial"><option value="partial">Часть склада: места, зоны или товары</option><option value="full">Весь склад</option></select></label>
          <label>Режим<select name="blind" defaultValue="true"><option value="true">Слепой: учётный остаток не показывается</option><option value="false">Открытый: считающие видят учёт</option></select></label>
          <label className="wide-field">Примечание<input name="note" maxLength={1000} placeholder="Например: плановый пересчёт стеллажей А"/></label>
          <PendingSubmitButton pendingText="Создаём…" className="primary" type="submit">Создать черновик</PendingSubmitButton>
        </form></section>}
      <section className="panel admin-section">
        <div className="panel-heading"><div><p className="eyebrow">Журнал</p><h2>Пересчёты</h2></div><span className="page-count">{list.counts.length}</span></div>
        <div className="import-table-wrap"><table className="import-table">
          <thead><tr><th>Номер</th><th>Склад</th><th>Вид</th><th>Статус</th><th>Ответственный</th><th>Создан</th><th>Начат</th><th>Записей</th></tr></thead>
          <tbody>{list.counts.map(count => <tr key={count.id}>
            <td><Link href={`/inventory/counts/${count.id}`}>{count.number}</Link></td><td>{count.warehouse}</td>
            <td>{countKindLabel[count.kind]}{count.blind ? ", слепой" : ""}</td><td>{countStatusLabel[count.status]}</td><td>{count.responsible ?? "—"}</td>
            <td>{countDate(count.created_at)}</td><td>{countDate(count.started_at)}</td><td>{count.entries}</td>
          </tr>)}</tbody>
        </table></div>
        {!list.counts.length && <p className="empty-state">Пересчётов пока нет.</p>}
      </section>
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Повторный подсчёт</p><h2>Допуск расхождения</h2></div></div>
        <p className="form-help">Расхождение больше допуска (в штуках) отправляет позицию на повторный подсчёт другим сотрудником. Сейчас: {list.tolerance_pieces} шт. Новое значение действует для пересчётов, начатых после изменения.</p>
        {list.can_settings && <form action={setInventoryCountTolerance} className="inline-action">
          <label>Допуск, шт.<input name="pieces" inputMode="decimal" required defaultValue={list.tolerance_pieces}/></label>
          <PendingSubmitButton pendingText="Сохраняем…" className="secondary" type="submit">Сохранить</PendingSubmitButton>
        </form>}
      </section>
    </>}
  </section></main>;
}
