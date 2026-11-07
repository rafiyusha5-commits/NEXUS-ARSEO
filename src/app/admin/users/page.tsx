import { PendingSubmitButton } from "@/components/pending-submit-button";
import { WorkflowHelp } from "@/components/workflow-help";
import { AppSidebar } from "@/components/app-sidebar";
import { requireAccessManager } from "@/lib/auth/access";
import { assignRole, inviteUser, removeRole, setUserActive } from "./actions";

type UserRoleRow = {
  role_id: string;
  app_roles: { id: string; code: string; name: string }[];
};

type UserRow = {
  id: string;
  full_name: string;
  email: string | null;
  job_title: string | null;
  is_active: boolean;
  user_roles: UserRoleRow[];
};

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { profile, roles: currentRoles, supabase } = await requireAccessManager();
  const params = await searchParams;
  const [{ data: users, error: usersError }, { data: roles, error: rolesError }] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, full_name, email, job_title, is_active, user_roles!user_roles_user_id_fkey(role_id, app_roles(id, code, name))")
      .eq("user_type", "employee")
      .order("full_name"),
    supabase.from("app_roles").select("id, code, name, is_enabled").eq("audience", "internal").order("name"),
  ]);
  const schemaReady = !usersError && !rolesError;

  return (
    <main className="app-shell">
      <AppSidebar profile={profile} roles={currentRoles} active="users" />
      <section className="workspace admin-workspace">
        <header className="topbar">
          <div><p className="eyebrow">Доступ</p><h1>Пользователи</h1></div>
          <span className="page-count">{users?.length ?? 0} сотрудников</span>
        </header>
    <WorkflowHelp section="access"/>

        {params.error && <div className="login-error admin-message">{params.error}</div>}
        {params.success && <div className="login-success admin-message">{params.success}</div>}
        {!schemaReady && (
          <div className="setup-notice">
            Сначала примените миграцию <strong>202609270001_phase0_access_control.sql</strong> в Supabase.
          </div>
        )}

        <section className="panel admin-section">
          <div className="panel-heading">
            <div><p className="eyebrow">Новая учётная запись</p><h2>Пригласить сотрудника</h2></div>
          </div>
          <form action={inviteUser} className="admin-form-grid">
            <label>ФИО<input name="full_name" required placeholder="Имя сотрудника" /></label>
            <label>Корпоративная почта<input name="email" type="email" required placeholder="name@arseo.kz" /></label>
            <label>Должность<input name="job_title" placeholder="Должность" /></label>
            <label>Роль
              <select name="role_id" required defaultValue="">
                <option value="" disabled>Выберите роль</option>
                {(roles ?? []).filter((role) => role.is_enabled).map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
              </select>
            </label>
            <PendingSubmitButton pendingText="Выполняем…" className="primary" type="submit" disabled={!schemaReady}>Отправить приглашение</PendingSubmitButton>
          </form>
          <p className="form-help">Пароль задаёт сам сотрудник по ссылке из письма. Администратор пароль не видит.</p>
        </section>

        <section className="panel admin-section">
          <div className="panel-heading"><div><p className="eyebrow">Команда ARSEO</p><h2>Учётные записи и роли</h2></div></div>
          <div className="user-list">
            {((users ?? []) as UserRow[]).map((employee) => {
              const assigned = employee.user_roles.flatMap((item) => item.app_roles ?? []);
              const available = (roles ?? []).filter((role) => role.is_enabled && !assigned.some((item) => item.id === role.id));
              return (
                <article className="user-card" key={employee.id}>
                  <div className="user-main">
                    <span className={`user-state ${employee.is_active ? "is-active" : "is-disabled"}`} />
                    <div><strong>{employee.full_name}</strong><small>{employee.email ?? "Почта появится после миграции"} · {employee.job_title ?? "Должность не указана"}</small></div>
                  </div>
                  <div className="role-chips">
                    {assigned.map((role) => (
                      <form action={removeRole} key={role.id}>
                        <input type="hidden" name="user_id" value={employee.id} />
                        <input type="hidden" name="role_id" value={role.id} />
                        <PendingSubmitButton pendingText="Выполняем…" className="role-chip" type="submit" title="Снять роль">{role.name} ×</PendingSubmitButton>
                      </form>
                    ))}
                  </div>
                  <div className="user-actions">
                    {available.length > 0 && (
                      <form action={assignRole} className="inline-form">
                        <input type="hidden" name="user_id" value={employee.id} />
                        <select name="role_id" defaultValue=""><option value="" disabled>Добавить роль</option>{available.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select>
                        <PendingSubmitButton pendingText="Выполняем…" className="ghost compact" type="submit">Назначить</PendingSubmitButton>
                      </form>
                    )}
                    <form action={setUserActive}>
                      <input type="hidden" name="user_id" value={employee.id} />
                      <input type="hidden" name="make_active" value={String(!employee.is_active)} />
                      <PendingSubmitButton pendingText="Выполняем…" className="text-button danger-text" type="submit">{employee.is_active ? "Отключить" : "Восстановить"}</PendingSubmitButton>
                    </form>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      </section>
    </main>
  );
}
