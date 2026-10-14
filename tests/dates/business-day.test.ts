import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { businessToday } from "../../src/lib/dates/business-day.ts";

describe("business day", () => {
  it("is the Kazakhstan date while UTC is still on the previous day", () => {
    assert.equal(businessToday(new Date("2026-10-13T19:00:00Z")), "2026-10-14");
    assert.equal(businessToday(new Date("2026-10-13T18:59:59Z")), "2026-10-13");
    assert.equal(businessToday(new Date("2026-12-31T19:30:00Z")), "2027-01-01");
  });
});
