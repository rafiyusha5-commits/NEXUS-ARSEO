import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { formatDateTime } from "@/lib/documents/labels.ts";
import { publicErrorMessage } from "@/lib/errors/public-message";
import { loadPermissions } from "@/lib/permissions.ts";
import {
  TASK_PRIORITIES,
  TASK_VIEWS,
  type TaskActor,
  type TaskView,
  allowedStatusChanges,
  canChangeDue,
  canReassign,
  deadlineState,
  emptyTaskMessage,
  isoToLocalInput,
  parseTaskView,
  statusActionLabel,
  taskPriorityLabel,
  taskStatusLabel,
  taskViewLabel,
} from "@/lib/tasks/rules.ts";
import { changeTaskDueAction, createTaskAction, reassignTaskAction, setTaskStatusAction } from "./actions";

type SearchParams = { view?: string; shipment?: string; task?: string; error?: string; success?: string };
type Named = { full_name: string } | { full_name: string }[] | null;
type TaskRow = {
  id: string; title: string; description: string | null; priority: string; status: string; due_at: string | null;
  started_at: string | null; completed_at: string | null; assignee_user_id: string; created_by: string | null;
  shipment_id: string | null; stage_run_id: string | null;
  assignee: Named; creator: Named;
  shipment: { id: string; shipment_number: string } | { id: string; shipment_number: string }[] | null;
  stage_run: { id: string; stage: { name: Record<string, string> } | { name: Record<string, string> }[] | null } | { id: string; stage: unknown }[] | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERMISSIONS = ["tasks.view", "tasks.create", "tasks.manage", "shipments.view"] as const;
const one = <T,>(value: T | T[] | null | undefined): T | undefined => (Array.isArray(value) ? value[0] : value ?? undefined);
const stageName = (run: TaskRow["stage_run"]) => {
  const stage = one(one(run as { stage: { name: Record<string, string> } | { name: Record<string, string> }[] | null } | null)?.stage);
  return stage?.name?.ru ?? stage?.name?.en ?? null;
};
const deadlineBadge: Record<string, { label: string; className: string } | null> = {
  overdue: { label: "Просрочена", className: "task-badge-overdue" },
  due_soon: { label: "Скоро срок", className: "task-badge-soon" },
  on_time: null, none: null, closed: null,
};

function tasksHref(view: TaskView, shipment: string) {
  const params = new URLSearchParams({ view });
  if (shipment) params.set("shipment", shipment);
  return `/tasks?${params}`;
}

export default async function TasksPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const { profile, roles, supabase } = await requireUser();
  const can = await loadPermissions(supabase, PERMISSIONS);
  const view = parseTaskView(params.view);
  const shipmentFilter = UUID.test(params.shipment ?? "") ? params.shipment! : "";
  const taskFilter = UUID.test(params.task ?? "") ? params.task! : "";
  const returnTo = taskFilter ? `/tasks?task=${taskFilter}` : tasksHref(view, shipmentFilter);

  // Without tasks.view (for example, a personal deny override) nothing about tasks is loaded.
  // RLS enforces the same rule; this only avoids pointless requests and empty lists.
  if (!can["tasks.view"]) {
    return (
      <main className="app-shell">
        <AppSidebar profile={profile} roles={roles} active="tasks" />
        <section className="workspace admin-workspace">
          <header className="topbar"><div><p className="eyebrow">Поставки</p><h1>Мои задачи</h1></div></header>
          <section className="panel admin-section">
            <div className="empty-state">Нет доступа к задачам. Обратитесь к администратору, чтобы получить право «Задачи: просмотр».</div>
          </section>
        </section>
      </main>
    );
  }

  // Deadline notifications of this employee; idempotent, so a reload adds nothing.
  await supabase.rpc("refresh_my_deadline_notifications");

  const now = new Date();
  let query = supabase
    .from("tasks")
    .select("id, title, description, priority, status, due_at, started_at, completed_at, assignee_user_id, created_by, shipment_id, stage_run_id, assignee:profiles!tasks_assignee_user_id_fkey(full_name), creator:profiles!tasks_created_by_fkey(full_name), shipment:shipments!tasks_shipment_id_fkey(id, shipment_number), stage_run:shipment_stage_runs!tasks_stage_run_id_fkey(id, stage:shipment_stages(name))")
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(300);
  if (taskFilter) query = query.eq("id", taskFilter);
  else {
    if (view === "mine") query = query.eq("assignee_user_id", profile.id);
    if (view === "open") query = query.in("status", ["open", "in_progress"]);
    if (view === "overdue") query = query.in("status", ["open", "in_progress"]).lt("due_at", now.toISOString());
    if (view === "done") query = query.eq("status", "done");
    if (shipmentFilter) query = query.eq("shipment_id", shipmentFilter);
  }
  const { data, error } = await query;
  const tasks = (data ?? []) as unknown as TaskRow[];
  const migrationMissing = Boolean(error && /shipment_id|stage_run_id|relationship|schema cache/.test(error.message));

  const [{ data: shipments }, { data: employees }, { data: stageRuns }] = await Promise.all([
    can["shipments.view"]
      ? supabase.from("shipments").select("id, shipment_number").order("created_at", { ascending: false }).limit(200)
      : Promise.resolve({ data: [] as { id: string; shipment_number: string }[] }),
    can["tasks.manage"]
      ? supabase.from("profiles").select("id, full_name").eq("is_active", true).eq("user_type", "employee").order("full_name").limit(500)
      : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
    can["shipments.view"] && shipmentFilter
      ? supabase.from("shipment_stage_runs").select("id, stage:shipment_stages(name, sequence_order)").eq("shipment_id", shipmentFilter).order("stage(sequence_order)")
      : Promise.resolve({ data: [] as { id: string; stage: unknown }[] }),
  ]);
  const filteredShipment = shipments?.find((item) => item.id === shipmentFilter);

  return (
    <main className="app-shell">
      <AppSidebar profile={profile} roles={roles} active="tasks" />
      <section className="workspace admin-workspace">
        <header className="topbar">
          <div><p className="eyebrow">Поставки</p><h1>Мои задачи</h1></div>
          <div className="topbar-actions">
            {can["tasks.create"] && !migrationMissing && <a className="primary button-link" href="#create">+ Новая задача</a>}
            <span className="page-count">{tasks.length} в выборке</span>
          </div>
        </header>
        {params.error && <div className="login-error admin-message">{params.error}</div>}
        {params.success && <div className="login-success admin-message">{params.success}</div>}
        {migrationMissing && (
          <div className="setup-notice">Задачи поставок ещё не подключены. Администратору: примените миграцию <strong>202609272200_shipment_tasks_notifications.sql</strong> (docs/tasks-notifications.md).</div>
        )}

        {!migrationMissing && (
          <section className="panel admin-section">
            <div className="panel-heading">
              <div><p className="eyebrow">Фильтры</p><h2>{taskFilter ? "Задача" : filteredShipment ? `Поставка ${filteredShipment.shipment_number}` : taskViewLabel[view]}</h2></div>
              {(taskFilter || shipmentFilter) && <Link className="text-button" href={tasksHref(view, "")}>Сбросить фильтр</Link>}
            </div>
            <nav className="task-tabs" aria-label="Фильтр задач">
              {TASK_VIEWS.map((item) => (
                <Link className={!taskFilter && item === view ? "active" : ""} href={tasksHref(item, shipmentFilter)} key={item}>{taskViewLabel[item]}</Link>
              ))}
            </nav>
            {can["shipments.view"] && (
              <form className="task-shipment-filter" method="get">
                <input type="hidden" name="view" value={view} />
                <label>Поставка
                  <select name="shipment" defaultValue={shipmentFilter}>
                    <option value="">Все поставки</option>
                    {(shipments ?? []).map((item) => <option value={item.id} key={item.id}>{item.shipment_number}</option>)}
                  </select>
                </label>
                <button className="ghost compact" type="submit">Показать</button>
              </form>
            )}
            {error && <div className="login-error admin-message">{publicErrorMessage(error, "Не удалось загрузить задачи.")}</div>}

            <div className="task-list">
              {tasks.map((task) => {
                const actor: TaskActor = {
                  isAssignee: task.assignee_user_id === profile.id,
                  isCreator: task.created_by === profile.id,
                  canManage: can["tasks.manage"],
                };
                const shipment = one(task.shipment);
                const stage = stageName(task.stage_run);
                const badge = deadlineBadge[deadlineState(task, now)];
                const transitions = allowedStatusChanges(task.status, actor);
                return (
                  <article className={`task-row task-status-${task.status}`} key={task.id} id={`task-${task.id}`}>
                    <div className="task-main">
                      <strong>{task.title}</strong>
                      {task.description && <p>{task.description}</p>}
                      <small>
                        {shipment ? <Link href={`/shipments/${shipment.id}`}>Поставка {shipment.shipment_number}</Link> : "Без поставки"}
                        {stage && shipment && <> · <Link href={`/shipments/${shipment.id}#stage-${task.stage_run_id}`}>этап «{stage}»</Link></>}
                      </small>
                    </div>
                    <div className="task-meta">
                      <span><small>Исполнитель</small>{one(task.assignee)?.full_name ?? "—"}{actor.isAssignee ? " (вы)" : ""}</span>
                      <span><small>Срок</small>{task.due_at ? formatDateTime(task.due_at) : "без срока"}{badge && <em className={`doc-badge ${badge.className}`}>{badge.label}</em>}</span>
                      <span><small>Приоритет</small><em className={`doc-badge task-priority-${task.priority}`}>{taskPriorityLabel[task.priority as keyof typeof taskPriorityLabel] ?? task.priority}</em></span>
                      <span><small>Статус</small><em className={`doc-badge task-badge-${task.status}`}>{taskStatusLabel[task.status as keyof typeof taskStatusLabel] ?? task.status}</em></span>
                    </div>
                    {(transitions.length > 0 || canReassign(task.status, actor)) && (
                      <div className="task-actions">
                        {transitions.map((to) => (
                          <form action={setTaskStatusAction} key={to}>
                            <input type="hidden" name="task_id" value={task.id} />
                            <input type="hidden" name="status" value={to} />
                            <input type="hidden" name="return_to" value={returnTo} />
                            <button className={to === "done" || to === "in_progress" ? "primary compact" : "ghost compact"} type="submit">{statusActionLabel(task.status, to)}</button>
                          </form>
                        ))}
                        {canReassign(task.status, actor) && (
                          <details className="task-manage">
                            <summary>Исполнитель и срок</summary>
                            <form action={reassignTaskAction} className="doc-subform">
                              <input type="hidden" name="task_id" value={task.id} />
                              <input type="hidden" name="return_to" value={returnTo} />
                              <label>Новый исполнитель
                                <select name="assignee_user_id" required defaultValue="">
                                  <option value="" disabled>Выберите сотрудника</option>
                                  {(employees ?? []).filter((person) => person.id !== task.assignee_user_id).map((person) => (
                                    <option value={person.id} key={person.id}>{person.full_name}</option>
                                  ))}
                                </select>
                              </label>
                              <button className="ghost compact" type="submit">Переназначить</button>
                            </form>
                            {canChangeDue(task.status, actor) && (
                              <form action={changeTaskDueAction} className="doc-subform">
                                <input type="hidden" name="task_id" value={task.id} />
                                <input type="hidden" name="return_to" value={returnTo} />
                                <label>Срок (время Казахстана)<input type="datetime-local" name="due_at" defaultValue={isoToLocalInput(task.due_at)} /></label>
                                <button className="ghost compact" type="submit">Изменить срок</button>
                              </form>
                            )}
                          </details>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
              {!tasks.length && !error && (
                <div className="empty-state">
                  {taskFilter ? "Задача не найдена или у вас нет к ней доступа." : shipmentFilter ? "По этой поставке задач нет." : emptyTaskMessage[view]}
                </div>
              )}
            </div>
          </section>
        )}

        {can["tasks.create"] && !migrationMissing && (
          <section className="panel admin-section" id="create">
            <div className="panel-heading"><div><p className="eyebrow">Новая задача</p><h2>Поставить задачу</h2></div></div>
            <form action={createTaskAction} className="doc-form">
              <input type="hidden" name="return_to" value={returnTo} />
              <label className="doc-form-wide">Название<input name="title" required maxLength={200} placeholder="Например: получить CMR от перевозчика" /></label>
              {can["tasks.manage"] ? (
                <label>Исполнитель
                  <select name="assignee_user_id" defaultValue={profile.id}>
                    {(employees ?? []).map((person) => <option value={person.id} key={person.id}>{person.full_name}{person.id === profile.id ? " (вы)" : ""}</option>)}
                  </select>
                </label>
              ) : (
                <label>Исполнитель<input value={`${profile.full_name} (вы)`} disabled /></label>
              )}
              <label>Приоритет
                <select name="priority" defaultValue="normal">
                  {TASK_PRIORITIES.map((priority) => <option value={priority} key={priority}>{taskPriorityLabel[priority]}</option>)}
                </select>
              </label>
              <label>Срок (время Казахстана)<input type="datetime-local" name="due_at" /></label>
              {can["shipments.view"] && (
                shipmentFilter ? (
                  <>
                    <input type="hidden" name="shipment_id" value={shipmentFilter} />
                    <label>Этап поставки {filteredShipment?.shipment_number ?? ""}
                      <select name="stage_run_id" defaultValue="">
                        <option value="">Вся поставка</option>
                        {((stageRuns ?? []) as { id: string; stage: unknown }[]).map((run) => {
                          const stage = one(run.stage as { name: Record<string, string>; sequence_order: number } | { name: Record<string, string>; sequence_order: number }[] | null);
                          return <option value={run.id} key={run.id}>{stage ? `${stage.sequence_order}. ${stage.name?.ru ?? stage.name?.en ?? ""}` : run.id}</option>;
                        })}
                      </select>
                    </label>
                  </>
                ) : (
                  <label>Поставка
                    <select name="shipment_id" defaultValue="">
                      <option value="">Без поставки</option>
                      {(shipments ?? []).map((item) => <option value={item.id} key={item.id}>{item.shipment_number}</option>)}
                    </select>
                  </label>
                )
              )}
              <label className="doc-form-full">Описание<textarea name="description" maxLength={2000} rows={2} /></label>
              <button className="primary" type="submit">Создать задачу</button>
              <p className="form-help doc-form-full">
                {can["tasks.manage"]
                  ? "Исполнитель получит уведомление. Чтобы привязать задачу к этапу, сначала выберите поставку в фильтре выше."
                  : "Вы можете ставить задачи себе. Назначать задачи другим сотрудникам могут руководители."}
              </p>
            </form>
          </section>
        )}
      </section>
    </main>
  );
}
