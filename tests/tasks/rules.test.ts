import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  TASK_STATUSES,
  type TaskActor,
  allowedStatusChanges,
  canChangeDue,
  canChangeStatus,
  canReassign,
  deadlineState,
  isDueSoon,
  isOverdue,
  isoToLocalInput,
  localInputToIso,
  parseTaskView,
  statusActionLabel,
} from "../../src/lib/tasks/rules.ts";

const assignee: TaskActor = { isAssignee: true, isCreator: false, canManage: false };
const creator: TaskActor = { isAssignee: false, isCreator: true, canManage: false };
const manager: TaskActor = { isAssignee: false, isCreator: false, canManage: true };
const stranger: TaskActor = { isAssignee: false, isCreator: false, canManage: false };
const NOW = new Date("2026-09-27T10:00:00Z");
const hours = (value: number) => new Date(NOW.getTime() + value * 3_600_000).toISOString();

describe("task status rules", () => {
  it("lets the assignee start, complete and pause the task", () => {
    assert.deepEqual(allowedStatusChanges("open", assignee), ["in_progress", "done"]);
    assert.deepEqual(allowedStatusChanges("in_progress", assignee), ["open", "done"]);
    assert.deepEqual(allowedStatusChanges("done", assignee), [], "the assignee can not reopen");
    assert.equal(canChangeStatus("open", "cancelled", assignee), false, "the assignee does not cancel");
  });

  it("lets managers cancel and reopen, creators only cancel", () => {
    assert.deepEqual(allowedStatusChanges("open", manager), ["cancelled"]);
    assert.deepEqual(allowedStatusChanges("done", manager), ["open"]);
    assert.deepEqual(allowedStatusChanges("cancelled", manager), ["open"]);
    assert.equal(canChangeStatus("open", "in_progress", manager), false, "a manager does not start someone else's task");
    assert.deepEqual(allowedStatusChanges("in_progress", creator), ["cancelled"]);
    assert.deepEqual(allowedStatusChanges("done", creator), []);
  });

  it("gives other employees nothing", () => {
    for (const status of TASK_STATUSES) assert.deepEqual(allowedStatusChanges(status, stranger), [], status);
  });

  it("combines the roles of an assignee who is also a manager", () => {
    assert.deepEqual(allowedStatusChanges("open", { isAssignee: true, isCreator: true, canManage: true }), ["in_progress", "done", "cancelled"]);
  });

  it("matches public.set_task_status() in the migration", () => {
    const sql = readFileSync(new URL("../../supabase/migrations/202609272200_shipment_tasks_notifications.sql", import.meta.url), "utf8");
    const body = sql.slice(sql.indexOf("function public.set_task_status"), sql.indexOf("function public.reassign_task"));
    const rules = [...body.matchAll(/\((\(v_manager or v_task\.created_by = v_actor\)|v_assignee|v_manager) and v_task\.status (?:= '(\w+)'|in \(([^)]*)\)) and p_status = '(\w+)'\)/g)]
      .map((match) => ({
        who: match[1],
        from: match[2] ? [match[2]] : match[3].split(",").map((value) => value.trim().replace(/'/g, "")),
        to: match[4],
      }));
    assert.equal(rules.length, 5, "five transitions in the SQL function");
    const actors: TaskActor[] = [];
    for (const isAssignee of [false, true]) for (const isCreator of [false, true]) for (const canManage of [false, true]) actors.push({ isAssignee, isCreator, canManage });
    for (const actor of actors) {
      for (const from of TASK_STATUSES) {
        for (const to of TASK_STATUSES) {
          const sqlAllows = rules.some((rule) => rule.from.includes(from) && rule.to === to && (
            rule.who === "v_assignee" ? actor.isAssignee : rule.who === "v_manager" ? actor.canManage : actor.canManage || actor.isCreator));
          assert.equal(canChangeStatus(from, to, actor), sqlAllows, `${JSON.stringify(actor)} ${from} → ${to}`);
        }
      }
    }
  });

  it("allows reassignment and due changes to managers of active tasks", () => {
    assert.equal(canReassign("open", manager), true);
    assert.equal(canReassign("in_progress", manager), true);
    assert.equal(canReassign("done", manager), false);
    assert.equal(canReassign("open", assignee), false);
    assert.equal(canChangeDue("cancelled", manager), false);
  });

  it("names the buttons", () => {
    assert.equal(statusActionLabel("open", "in_progress"), "Начать");
    assert.equal(statusActionLabel("in_progress", "done"), "Завершить");
    assert.equal(statusActionLabel("in_progress", "open"), "Вернуть в очередь");
    assert.equal(statusActionLabel("done", "open"), "Возобновить");
  });
});

describe("deadlines", () => {
  it("treats open and in-progress tasks past their due time as overdue", () => {
    assert.equal(isOverdue({ status: "open", due_at: hours(-1) }, NOW), true);
    assert.equal(isOverdue({ status: "in_progress", due_at: hours(-0.01) }, NOW), true);
    assert.equal(isOverdue({ status: "open", due_at: NOW.toISOString() }, NOW), true, "due exactly now");
    assert.equal(isOverdue({ status: "open", due_at: hours(1) }, NOW), false);
  });

  it("never marks finished tasks or tasks without a due date", () => {
    assert.equal(isOverdue({ status: "done", due_at: hours(-5) }, NOW), false);
    assert.equal(isOverdue({ status: "cancelled", due_at: hours(-5) }, NOW), false);
    assert.equal(isOverdue({ status: "open", due_at: null }, NOW), false);
  });

  it("detects approaching deadlines within 24 hours", () => {
    assert.equal(isDueSoon({ status: "open", due_at: hours(23) }, NOW), true);
    assert.equal(isDueSoon({ status: "open", due_at: hours(25) }, NOW), false);
    assert.equal(isDueSoon({ status: "open", due_at: hours(-1) }, NOW), false, "overdue is not due soon");
    assert.equal(isDueSoon({ status: "open", due_at: hours(5) }, NOW, 4), false, "custom window");
  });

  it("summarises the deadline state", () => {
    assert.equal(deadlineState({ status: "open", due_at: hours(-1) }, NOW), "overdue");
    assert.equal(deadlineState({ status: "open", due_at: hours(2) }, NOW), "due_soon");
    assert.equal(deadlineState({ status: "in_progress", due_at: hours(72) }, NOW), "on_time");
    assert.equal(deadlineState({ status: "open", due_at: null }, NOW), "none");
    assert.equal(deadlineState({ status: "done", due_at: hours(-1) }, NOW), "closed");
  });
});

describe("filters and time input", () => {
  it("defaults to my tasks", () => {
    assert.equal(parseTaskView(undefined), "mine");
    assert.equal(parseTaskView("overdue"), "overdue");
    assert.equal(parseTaskView("everything"), "mine");
  });

  it("reads datetime-local input as Kazakhstan time (UTC+5)", () => {
    assert.equal(localInputToIso("2026-10-01T14:30"), "2026-10-01T09:30:00.000Z");
    assert.equal(localInputToIso("2026-01-01T02:00"), "2025-12-31T21:00:00.000Z", "crosses midnight and the year");
    assert.equal(localInputToIso("2026-02-30T10:00"), null, "no 30 February");
    assert.equal(localInputToIso("2026-10-01T24:00"), null);
    assert.equal(localInputToIso("01.10.2026 14:30"), null);
    assert.equal(localInputToIso(""), null);
  });

  it("writes ISO values back for the input", () => {
    assert.equal(isoToLocalInput("2026-10-01T09:30:00.000Z"), "2026-10-01T14:30");
    assert.equal(isoToLocalInput(localInputToIso("2026-12-31T23:59")), "2026-12-31T23:59");
    assert.equal(isoToLocalInput(null), "");
    assert.equal(isoToLocalInput("not a date"), "");
  });
});
