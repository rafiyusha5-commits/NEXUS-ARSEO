import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { businessToday, businessDaysRemaining, calendarDaysBetween } from "../../src/lib/dates/business-day.ts";

describe("business day", () => {
  it("is the Kazakhstan date while UTC is still on the previous day", () => {
    assert.equal(businessToday(new Date("2026-10-13T19:00:00Z")), "2026-10-14");
    assert.equal(businessToday(new Date("2026-10-13T18:59:59Z")), "2026-10-13");
    assert.equal(businessToday(new Date("2026-12-31T19:30:00Z")), "2027-01-01");
  });
  it("uses the same expiry day on UTC and Kazakhstan hosts", () => {
    assert.equal(businessDaysRemaining("2026-10-14", new Date("2026-10-13T21:00:00Z")), 0);
    assert.equal(businessDaysRemaining("2026-10-13", new Date("2026-10-13T21:00:00Z")), -1);
    assert.equal(calendarDaysBetween("2026-10-01", "2026-10-14"), 13);
  });
});
