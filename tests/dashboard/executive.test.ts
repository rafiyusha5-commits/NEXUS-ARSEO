import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attention, change, dashboardMonth, DASHBOARD_TILES, shiftMonth, type DashboardTile } from "../../src/lib/dashboard/executive.ts";

describe("executive dashboard: month", () => {
  it("takes YYYY-MM, never a future month, else the current one", () => {
    assert.equal(dashboardMonth(undefined, "2026-11-28"), "2026-11-01");
    assert.equal(dashboardMonth("2026-09", "2026-11-28"), "2026-09-01");
    assert.equal(dashboardMonth("2027-01", "2026-11-28"), "2026-11-01");
    assert.equal(dashboardMonth("2026-13", "2026-11-28"), "2026-11-01");
    assert.equal(dashboardMonth("../x", "2026-11-28"), "2026-11-01");
    assert.equal(shiftMonth("2026-01-01", -1), "2025-12");
    assert.equal(shiftMonth("2026-11-01", 1), "2026-12");
  });
});

describe("executive dashboard: wording", () => {
  it("compares with the previous month only when there is a base", () => {
    assert.equal(change("110", "100"), "+10% к прошлому месяцу");
    assert.equal(change("85", "100"), "−15% к прошлому месяцу");
    assert.equal(change("100.2", "100"), "на уровне прошлого месяца");
    assert.equal(change("0", "0"), "как в прошлом месяце");
    assert.equal(change("50", "0"), null);
    assert.equal(change(null, "10"), null);
  });

  it("lists what needs attention; a failed tile is named, never read as zero", () => {
    const tiles: DashboardTile[] = [
      { tile: "cash", status: "ok", month: "2026-11-01", previous_month: "2026-10-01", incomplete: false, link: "/finance/cash",
        currencies: [], nearest: { currency: "EUR", date: "2026-12-10", week: "2026-12-07" }, receivables: true, goods: true },
      { tile: "shipments", status: "error" },
      { tile: "decisions", status: "ok", month: "2026-11-01", previous_month: "2026-10-01", incomplete: false, link: "/notifications",
        approvals: 0, price_reviews: 0, blocked_orders: 0, tasks_overdue: null, unpriced_orders: null, total: 0 },
    ];
    assert.deepEqual(attention(tiles), ["Кассовый разрыв в EUR с 10.12", "Поставки: нет данных"]);
    assert.equal(DASHBOARD_TILES.length, 7);
  });
});
