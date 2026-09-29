import { AppSidebar } from "@/components/app-sidebar";
import { requireAccessManager } from "@/lib/auth/access";
import { inviteExternalClient, setExternalAccess, setExternalActive } from "./actions";

type Override = { effect: string; revoked_at: string | null; permissions: { code: string } | { code: string }[] | null };
type ClientUser = { id: string; full_name: string; email: string | null; phone: string | null; locale: string; is_active: boolean; counterparties: { legal_name: string } | { legal_name: string }[] | null; user_permission_overrides: Override[] };
const codeOf = (row: Override) => (Array.isArray(row.permissions) ? row.permissions[0]?.code : row.permissions?.code);

export default async function ClientAccessPage({ searchParams }: { searchParams: Promise<{ error?: string; success?: string }> }) {
  const params = await searchParams;
  const { profile, roles, supabase } = await requireAccessManager();
  const [{ data: customers, error: customersError }, { data: users, error: usersError }] = await Promise.all([
    supabase.from("counterparties").select("id,legal_name").contains("roles", ["customer"]).eq("status", "active").order("legal_name"),
    supabase.from("profiles").select("id,full_name,email,phone,locale,is_active,counterparties(legal_name),user_permission_overrides(effect,revoked_at,permissions(code))").eq("user_type", "external").order("full_name"),
  ]);
  const ready = !customersError && !usersError;
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="client-access" />
    <section className="workspace admin-workspace">
      <header className="topbar"><div><p className="eyebrow">Внешний контур</p><h1>Доступ клиентов</h1></div><span className="page-count">{users?.length ?? 0} представителей</span></header>
      {params.error && <div className="login-error admin-message">{params.error}</div>}{params.success && <div className="login-success admin-message">{params.success}</div>}
      {!ready && <div className="setup-notice">Примените миграцию <strong>202609273300_external_client_portal.sql</strong>.</div>}
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Новая учётная запись</p><h2>Пригласить представителя клиента</h2></div></div>
        <form action={inviteExternalClient} className="admin-form-grid">
          <label>ФИО<input name="full_name" required /></label><label>Электронная почта<input name="email" type="email" required /></label>
          <label>Клиент<select name="counterparty_id" required defaultValue=""><option value="" disabled>Выберите клиента</option>{(customers ?? []).map((item) => <option key={item.id} value={item.id}>{item.legal_name}</option>)}</select></label>
          <label>Телефон<input name="phone" maxLength={50} /></label><label>Язык<select name="locale" defaultValue="ru"><option value="ru">Русский</option><option value="kk">Қазақша</option><option value="en">English</option></select></label>
          <div className="permission-checks"><label><input type="checkbox" name="view" defaultChecked /> Просмотр</label><label><input type="checkbox" name="download" defaultChecked /> Скачивание</label><label><input type="checkbox" name="upload" /> Загрузка</label></div>
          <button className="primary" type="submit" disabled={!ready}>Отправить приглашение</button>
        </form><p className="form-help">Клиент видит только документы своей компании, которые сотрудник ARSEO открыл вручную.</p>
      </section>
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Учётные записи</p><h2>Представители клиентов</h2></div></div><div className="user-list">
        {((users ?? []) as unknown as ClientUser[]).map((client) => {
          const company = Array.isArray(client.counterparties) ? client.counterparties[0] : client.counterparties;
          const enabled = new Set(client.user_permission_overrides.filter((row) => row.effect === "allow" && !row.revoked_at).map(codeOf));
          return <article className="user-card" key={client.id}><div className="user-main"><span className={`user-state ${client.is_active ? "is-active" : "is-disabled"}`} /><div><strong>{client.full_name}</strong><small>{company?.legal_name ?? "Клиент не указан"} · {client.email}</small></div></div>
            <form action={setExternalAccess} className="permission-form"><input type="hidden" name="user_id" value={client.id} /><label><input type="checkbox" name="view" defaultChecked={enabled.has("external_documents.view")} /> Просмотр</label><label><input type="checkbox" name="download" defaultChecked={enabled.has("external_documents.download")} /> Скачивание</label><label><input type="checkbox" name="upload" defaultChecked={enabled.has("external_documents.upload")} /> Загрузка</label><button className="ghost compact" type="submit">Сохранить права</button></form>
            <form action={setExternalActive}><input type="hidden" name="user_id" value={client.id} /><input type="hidden" name="make_active" value={String(!client.is_active)} /><button className="text-button danger-text" type="submit">{client.is_active ? "Отключить" : "Восстановить"}</button></form>
          </article>;
        })}{!users?.length && <div className="empty-state">Представителей клиентов пока нет.</div>}
      </div></section>
    </section></main>;
}
