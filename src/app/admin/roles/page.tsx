import { AppSidebar } from "@/components/app-sidebar";
import { requireAccessManager } from "@/lib/auth/access";
import { setRoleEnabled, setRolePermission } from "./actions";

type RoleRow = { id: string; code: string; name: string; description: string | null; is_enabled: boolean };
type PermissionRow = { id: string; code: string; name: string; module: string };
type GrantRow = { role_id: string; permission_id: string; granted: boolean };

export default async function RolesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { profile, roles: currentRoles, supabase } = await requireAccessManager();
  const params = await searchParams;
  const [{ data: roles }, { data: permissions }, { data: grants }] = await Promise.all([
    supabase.from("app_roles").select("id, code, name, description, is_enabled").order("name"),
    supabase.from("permissions").select("id, code, name, module").order("module").order("code"),
    supabase.from("role_permissions").select("role_id, permission_id, granted"),
  ]);
  const grantKeys = new Set(
    ((grants ?? []) as GrantRow[])
      .filter((grant) => grant.granted)
      .map((grant) => `${grant.role_id}:${grant.permission_id}`),
  );

  return (
    <main className="app-shell">
      <AppSidebar profile={profile} roles={currentRoles} active="roles" />
      <section className="workspace admin-workspace">
        <header className="topbar">
          <div><p className="eyebrow">Фаза 0 · Контроль доступа</p><h1>Роли и права</h1></div>
          <span className="page-count">{roles?.length ?? 0} ролей · {permissions?.length ?? 0} прав</span>
        </header>
        {params.error && <div className="login-error admin-message">{params.error}</div>}
        {params.success && <div className="login-success admin-message">{params.success}</div>}

        <section className="panel admin-section permission-panel">
          <div className="panel-heading"><div><p className="eyebrow">Матрица</p><h2>Права по умолчанию</h2></div></div>
          <p className="form-help">Нажатие на ячейку сразу выдаёт или отзывает право. Все изменения записываются в журнал.</p>
          <div className="permission-table-wrap">
            <table className="permission-table">
              <thead><tr><th>Роль</th>{((permissions ?? []) as PermissionRow[]).map((permission) => <th key={permission.id} title={permission.name}>{permission.code}</th>)}<th>Статус</th></tr></thead>
              <tbody>
                {((roles ?? []) as RoleRow[]).map((role) => (
                  <tr className={role.is_enabled ? "" : "disabled-row"} key={role.id}>
                    <th><strong>{role.name}</strong><small>{role.code}</small></th>
                    {((permissions ?? []) as PermissionRow[]).map((permission) => {
                      const granted = grantKeys.has(`${role.id}:${permission.id}`);
                      return (
                        <td key={permission.id}>
                          <form action={setRolePermission}>
                            <input type="hidden" name="role_id" value={role.id} />
                            <input type="hidden" name="permission_id" value={permission.id} />
                            <input type="hidden" name="grant" value={String(!granted)} />
                            <button className={`permission-toggle ${granted ? "granted" : "denied"}`} type="submit" aria-label={`${granted ? "Отозвать" : "Выдать"} ${permission.name} для ${role.name}`}>{granted ? "✓" : "—"}</button>
                          </form>
                        </td>
                      );
                    })}
                    <td>
                      <form action={setRoleEnabled}>
                        <input type="hidden" name="role_id" value={role.id} />
                        <input type="hidden" name="role_code" value={role.code} />
                        <input type="hidden" name="enabled" value={String(!role.is_enabled)} />
                        <button className={`role-status ${role.is_enabled ? "on" : "off"}`} type="submit">{role.is_enabled ? "Включена" : "Отключена"}</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </section>
    </main>
  );
}
