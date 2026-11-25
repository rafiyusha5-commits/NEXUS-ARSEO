import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PAGE_SIZE, pageHref, pageSummary, pageWindow } from "../src/lib/pagination.ts";

// Page-by-page lists (performance measurement 25.11.2026, point 4).
describe("pageWindow", () => {
  it("reads the page from the URL and gives the rows for range(from, to)", () => {
    assert.deepEqual(pageWindow(undefined), { page: 1, size: PAGE_SIZE, from: 0, to: 99 });
    assert.deepEqual(pageWindow("3"), { page: 3, size: 100, from: 200, to: 299 });
    assert.deepEqual(pageWindow(["2", "5"], 50), { page: 2, size: 50, from: 50, to: 99 });
  });

  it("treats anything that is not a positive whole number as the first page", () => {
    for (const value of ["0", "-1", "2.5", "abc", "", "1e3", "9999999"]) assert.equal(pageWindow(value).page, 1, value);
  });
});

describe("pageHref", () => {
  it("keeps the other filters and drops the one-time notices", () => {
    assert.equal(pageHref("/finance", { shipment: "s1", page: "2", error: "x", success: "y" }, 3), "/finance?shipment=s1&page=3");
    assert.equal(pageHref("/warehouses/w1", { tab: "inventory" }, 2), "/warehouses/w1?tab=inventory&page=2");
  });

  it("gives page 1 without a page parameter", () => {
    assert.equal(pageHref("/inventory", { page: "4" }, 1), "/inventory");
    assert.equal(pageHref("/finance", { shipment: "s1", page: "2" }, 1), "/finance?shipment=s1");
  });
});

describe("pageSummary", () => {
  it("counts the shown rows and the neighbouring pages", () => {
    assert.deepEqual(pageSummary(pageWindow("2"), 250, 100), { first: 101, last: 200, total: 250, pages: 3, previous: 1, next: 3 });
    assert.deepEqual(pageSummary(pageWindow("3"), 250, 50), { first: 201, last: 250, total: 250, pages: 3, previous: 2, next: null });
    assert.deepEqual(pageSummary(pageWindow(undefined), 40, 40), { first: 1, last: 40, total: 40, pages: 1, previous: null, next: null });
  });

  it("links a page past the end back to the last page", () => {
    const summary = pageSummary(pageWindow("9"), 250, 0);
    assert.equal(summary.first, 0);
    assert.equal(summary.previous, 3);
    assert.equal(summary.next, null);
  });
});
