import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { notificationLink, notificationTypeLabel, unreadBadge } from "../../src/lib/notifications/rules.ts";

const TASK = "11111111-1111-4111-8111-111111111111";
const SHIPMENT = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";

describe("notification links", () => {
  it("links tasks, stages, shipments, documents and customer orders", () => {
    assert.deepEqual(notificationLink({ entity_type: "task", entity_id: TASK, shipment_id: SHIPMENT }), { href: `/tasks?task=${TASK}`, label: "Открыть задачу" });
    assert.deepEqual(notificationLink({ entity_type: "shipment_stage_run", entity_id: RUN, shipment_id: SHIPMENT }),
      { href: `/shipments/${SHIPMENT}#stage-${RUN}`, label: "Открыть этап" });
    assert.deepEqual(notificationLink({ entity_type: "shipment", entity_id: SHIPMENT, shipment_id: SHIPMENT }), { href: `/shipments/${SHIPMENT}`, label: "Открыть поставку" });
    assert.deepEqual(notificationLink({ entity_type: "document", entity_id: TASK, shipment_id: null }), { href: `/documents/${TASK}`, label: "Открыть документ" });
    assert.deepEqual(notificationLink({ entity_type: "sale", entity_id: TASK, shipment_id: null }), { href: `/sales/${TASK}?tab=shipping`, label: "Открыть заказ" });
    assert.equal(notificationLink({ entity_type: "sale", entity_id: "../admin", shipment_id: null }), null);
    assert.deepEqual(notificationLink({ entity_type: "shipment_document_check", entity_id: SHIPMENT, shipment_id: SHIPMENT }),
      { href: `/shipments/${SHIPMENT}?tab=documents#document-check`, label: "Открыть «Сверку»" });
    assert.deepEqual(notificationLink({ entity_type: "shelf_life_control", entity_id: null, shipment_id: null }), { href: "/inventory/shelf-life", label: "Открыть «Контроль ОСГ»" });
  });

  it("falls back to the shipment and to no link", () => {
    assert.equal(notificationLink({ entity_type: "shipment_stage_run", entity_id: RUN, shipment_id: null }), null);
    assert.deepEqual(notificationLink({ entity_type: "unknown", entity_id: TASK, shipment_id: SHIPMENT })?.href, `/shipments/${SHIPMENT}`);
    assert.equal(notificationLink({ entity_type: null, entity_id: null, shipment_id: null }), null);
  });

  it("never builds a link from anything but ids", () => {
    assert.equal(notificationLink({ entity_type: "task", entity_id: "//evil.example", shipment_id: null }), null);
    assert.equal(notificationLink({ entity_type: "shipment", entity_id: "../admin", shipment_id: "javascript:alert(1)" }), null);
  });
});

describe("labels and badge", () => {
  it("has a label for every type allowed by the database", () => {
    const sql = readFileSync(new URL("../../supabase/migrations/202609272200_shipment_tasks_notifications.sql", import.meta.url), "utf8");
    const check = sql.slice(sql.indexOf("add constraint notifications_type_check"), sql.indexOf("-- The same event is stored once"));
    const types = [...check.matchAll(/'(\w+)'/g)].map((match) => match[1]);
    assert.ok(types.includes("task_assigned") && types.includes("stage_blocked"));
    for (const type of types) assert.ok(notificationTypeLabel[type], type);
  });

  it("caps the unread counter", () => {
    assert.equal(unreadBadge(0), null);
    assert.equal(unreadBadge(-1), null);
    assert.equal(unreadBadge(7), "7");
    assert.equal(unreadBadge(100), "99+");
    assert.equal(unreadBadge(Number.NaN), null);
  });
});
