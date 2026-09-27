import { AppSidebar } from "@/components/app-sidebar";
import { requireAccessManager } from "@/lib/auth/access";

type AuditRow = {
  id: number;
  actor_user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

const actionLabels: Record<string, string> = {
  insert: "Создание",
  update: "Изменение",
  delete: "Удаление",
  create: "Создание",
  assign: "Назначение",
  revoke: "Отзыв",
};

export default async function AuditPage() {
  const { profile, roles, supabase } = await requireAccessManager();
  const { data: events, error } = await supabase
    .from("audit_log")
    .select("id, actor_user_id, action, entity_type, entity_id, metadata, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  const rows = (events ?? []) as AuditRow[];
  const actorIds = [...new Set(rows.map((row) => row.actor_user_id).filter(Boolean))] as string[];
  const { data: actors } = actorIds.length
    ? await supabase.from("profiles").select("id, full_name").in("id", actorIds)
    : { data: [] as { id: string; full_name: string }[] };
  const actorNames = new Map((actors ?? []).map((actor) => [actor.id, actor.full_name]));

  return (
    <main className="app-shell">
      <AppSidebar profile={profile} roles={roles} active="audit" />
      <section className="workspace admin-workspace">
        <header className="topbar">
          <div><p className="eyebrow">Безопасность и история</p><h1>Журнал действий</h1></div>
          <span className="page-count">Последние {rows.length} событий</span>
        </header>
        {error && <div className="login-error admin-message">Не удалось загрузить журнал: {error.message}</div>}
        <section className="panel admin-section">
          <div className="audit-list">
            {rows.length === 0 && <p className="empty-state">Записей пока нет. Новые изменения прав и профилей появятся здесь автоматически.</p>}
            {rows.map((event) => (
              <article className="audit-row" key={event.id}>
                <span className="audit-icon">{event.action === "delete" ? "−" : event.action === "update" ? "↻" : "+"}</span>
                <div><strong>{actionLabels[event.action] ?? event.action}</strong><small>{event.entity_type}{event.entity_id ? ` · ${event.entity_id.slice(0, 8)}` : ""}</small></div>
                <div className="audit-actor"><strong>{event.actor_user_id ? actorNames.get(event.actor_user_id) ?? "Пользователь" : "Система"}</strong><small>{new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Qyzylorda" }).format(new Date(event.created_at))}</small></div>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
