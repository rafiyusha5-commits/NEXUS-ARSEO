// Task status rules, deadlines and filters. The database (public.set_task_status and the
// other task RPCs of migration 202609272200) enforces the same rules; this module only
// decides which controls to show.

export const TASK_STATUSES = ["open", "in_progress", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const taskStatusLabel: Record<TaskStatus, string> = {
  open: "Открыта",
  in_progress: "В работе",
  done: "Завершена",
  cancelled: "Отменена",
};

export const taskPriorityLabel: Record<TaskPriority, string> = {
  low: "Низкий",
  normal: "Обычный",
  high: "Высокий",
  urgent: "Срочный",
};

// Who looks at the task: its assignee, its creator, a manager (tasks.manage).
export type TaskActor = { isAssignee: boolean; isCreator: boolean; canManage: boolean };

export const isActiveStatus = (status: string): boolean => status === "open" || status === "in_progress";

// Same transitions as public.set_task_status():
//   assignee: open → in_progress, open/in_progress → done, in_progress → open;
//   manager or creator: open/in_progress → cancelled; manager: done/cancelled → open.
export function canChangeStatus(from: string, to: string, actor: TaskActor): boolean {
  if (actor.isAssignee) {
    if (from === "open" && to === "in_progress") return true;
    if (isActiveStatus(from) && to === "done") return true;
    if (from === "in_progress" && to === "open") return true;
  }
  if ((actor.canManage || actor.isCreator) && isActiveStatus(from) && to === "cancelled") return true;
  if (actor.canManage && (from === "done" || from === "cancelled") && to === "open") return true;
  return false;
}

export function allowedStatusChanges(from: string, actor: TaskActor): TaskStatus[] {
  return TASK_STATUSES.filter((to) => to !== from && canChangeStatus(from, to, actor));
}

// Button caption for a transition.
export function statusActionLabel(from: string, to: TaskStatus): string {
  if (to === "in_progress") return "Начать";
  if (to === "done") return "Завершить";
  if (to === "cancelled") return "Отменить";
  return from === "in_progress" ? "Вернуть в очередь" : "Возобновить";
}

// Reassignment and due-date changes: managers only, and only while the task is active.
export const canReassign = (status: string, actor: TaskActor): boolean => actor.canManage && isActiveStatus(status);
export const canChangeDue = canReassign;

type Deadline = { status: string; due_at: string | null };
export const DUE_SOON_HOURS = 24;

// Overdue = still open or in progress and the due time has passed.
export function isOverdue(task: Deadline, now: Date = new Date()): boolean {
  if (!task.due_at || !isActiveStatus(task.status)) return false;
  return Date.parse(task.due_at) <= now.getTime();
}

export function isDueSoon(task: Deadline, now: Date = new Date(), hours = DUE_SOON_HOURS): boolean {
  if (!task.due_at || !isActiveStatus(task.status)) return false;
  const due = Date.parse(task.due_at);
  return due > now.getTime() && due <= now.getTime() + hours * 3_600_000;
}

export type DeadlineState = "none" | "on_time" | "due_soon" | "overdue" | "closed";

export function deadlineState(task: Deadline, now: Date = new Date()): DeadlineState {
  if (!isActiveStatus(task.status)) return "closed";
  if (!task.due_at) return "none";
  if (isOverdue(task, now)) return "overdue";
  return isDueSoon(task, now) ? "due_soon" : "on_time";
}

export const TASK_VIEWS = ["mine", "all", "open", "overdue", "done"] as const;
export type TaskView = (typeof TASK_VIEWS)[number];
export const taskViewLabel: Record<TaskView, string> = {
  mine: "Мои",
  all: "Все",
  open: "Открытые",
  overdue: "Просроченные",
  done: "Завершённые",
};

export function parseTaskView(value: string | undefined): TaskView {
  return (TASK_VIEWS as readonly string[]).includes(value ?? "") ? (value as TaskView) : "mine";
}

export const emptyTaskMessage: Record<TaskView, string> = {
  mine: "У вас нет задач. Новые задачи появятся здесь, как только их назначат.",
  all: "Задач пока нет.",
  open: "Открытых задач нет.",
  overdue: "Просроченных задач нет — всё в срок.",
  done: "Завершённых задач пока нет.",
};

// ARSEO works in Kazakhstan time (UTC+5, no daylight saving time).
export const TIME_ZONE = "Asia/Qyzylorda";
const OFFSET_MS = 5 * 3_600_000;

// "2026-10-01T14:30" from <input type="datetime-local"> in local time -> ISO in UTC.
export function localInputToIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const utc = Date.UTC(year, month - 1, day, hour, minute) - OFFSET_MS;
  const check = new Date(utc + OFFSET_MS);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59) {
    return null;
  }
  return new Date(utc).toISOString();
}

// ISO -> value for <input type="datetime-local"> in local time.
export function isoToLocalInput(value: string | null | undefined): string {
  if (!value) return "";
  const time = Date.parse(value);
  return Number.isNaN(time) ? "" : new Date(time + OFFSET_MS).toISOString().slice(0, 16);
}
