import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { publicErrorMessage } from "@/lib/errors/public-message";
import { formatDateTime } from "@/lib/documents/labels.ts";
import { loadPermissions } from "@/lib/permissions.ts";
import { URGENT_NOTIFICATION_TYPES, notificationLink, notificationTypeLabel } from "@/lib/notifications/rules.ts";
import { markAllNotificationsReadAction, markNotificationReadAction, openNotificationAction } from "./actions";

type SearchParams = { error?: string; success?: string };
type NotificationRow = {
  id: string; type: string; title: string; body: string | null; entity_type: string | null; entity_id: string | null;
  shipment_id: string | null; is_read: boolean; read_at: string | null; created_at: string;
};

const COLUMNS = "id, type, title, body, entity_type, entity_id, shipment_id, is_read, read_at, created_at";

function NotificationItem({ item }: { item: NotificationRow }) {
  const link = notificationLink(item);
  return (
    <article className={`notification-row${item.is_read ? " notification-read" : ""}`}>
      <div className="notification-main">
        <span className={`doc-badge ${URGENT_NOTIFICATION_TYPES.has(item.type) ? "notification-urgent" : "notification-type"}`}>
          {notificationTypeLabel[item.type] ?? item.type}
        </span>
        <strong>{item.title}</strong>
        {item.body && <p>{item.body}</p>}
        <small>{formatDateTime(item.created_at)}{item.is_read && item.read_at ? ` · прочитано ${formatDateTime(item.read_at)}` : ""}</small>
      </div>
      <div className="notification-actions">
        {link && (
          <form action={openNotificationAction}>
            <input type="hidden" name="notification_id" value={item.id} />
            <button className="primary compact" type="submit">{link.label}</button>
          </form>
        )}
        {!item.is_read && (
          <form action={markNotificationReadAction}>
            <input type="hidden" name="notification_id" value={item.id} />
            <button className="ghost compact" type="submit">Прочитано</button>
          </form>
        )}
      </div>
    </article>
  );
}

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const { profile, roles, supabase } = await requireUser();

  const can = await loadPermissions(supabase, ["tasks.view", "sales.view"] as const);

  // Deadline notifications of this employee; idempotent, so a reload adds nothing. Without
  // tasks.view there are no task notifications to create, and RLS hides the existing ones.
  const { error: refreshError } = can["tasks.view"]
    ? await supabase.rpc("refresh_my_deadline_notifications")
    : { error: null };
  // Confirmed orders of this employee that can no longer ship (expired batch, shelf life below the requirement).
  if (can["sales.view"]) await supabase.rpc("refresh_my_order_notifications");
  const [{ data: unread, error }, { data: read }] = await Promise.all([
    supabase.from("notifications").select(COLUMNS).eq("is_read", false).order("created_at", { ascending: false }).limit(200),
    supabase.from("notifications").select(COLUMNS).eq("is_read", true).order("created_at", { ascending: false }).limit(50),
  ]);
  const migrationMissing = Boolean((error && /shipment_id|schema cache/.test(error.message)) || (refreshError && /refresh_my_deadline_notifications/.test(refreshError.message)));
  const unreadItems = (unread ?? []) as NotificationRow[];
  const readItems = (read ?? []) as NotificationRow[];

  return (
    <main className="app-shell">
      <AppSidebar profile={profile} roles={roles} active="notifications" />
      <section className="workspace admin-workspace">
        <header className="topbar">
          <div><p className="eyebrow">Поставки</p><h1>Уведомления</h1></div>
          <div className="topbar-actions">
            {unreadItems.length > 0 && (
              <form action={markAllNotificationsReadAction} className="notification-mark-all">
                <button className="ghost button-link" type="submit">Отметить все прочитанными</button>
              </form>
            )}
            <span className="page-count">{unreadItems.length} непрочитанных</span>
          </div>
        </header>
        {params.error && <div className="login-error admin-message">{params.error}</div>}
        {params.success && <div className="login-success admin-message">{params.success}</div>}
        {migrationMissing && (
          <div className="setup-notice">Уведомления о задачах и поставках ещё не подключены. Администратору: примените миграцию <strong>202609272200_shipment_tasks_notifications.sql</strong> (docs/tasks-notifications.md).</div>
        )}
        {error && !migrationMissing && <div className="login-error admin-message">{publicErrorMessage(error, "Не удалось загрузить уведомления.")}</div>}

        <section className="panel admin-section">
          <div className="panel-heading"><div><p className="eyebrow">Требуют внимания</p><h2>Непрочитанные</h2></div><span className="page-count">{unreadItems.length}</span></div>
          <div className="notification-list">
            {unreadItems.map((item) => <NotificationItem item={item} key={item.id} />)}
            {!unreadItems.length && !error && <div className="empty-state">Новых уведомлений нет. Здесь появятся назначенные задачи, сроки, блокировки этапов и запросы согласования.</div>}
          </div>
        </section>

        <section className="panel admin-section">
          <div className="panel-heading"><div><p className="eyebrow">История</p><h2>Прочитанные</h2></div><span className="page-count">последние {readItems.length}</span></div>
          <div className="notification-list">
            {readItems.map((item) => <NotificationItem item={item} key={item.id} />)}
            {!readItems.length && !error && <div className="empty-state">Прочитанных уведомлений пока нет.</div>}
          </div>
        </section>
      </section>
    </main>
  );
}
