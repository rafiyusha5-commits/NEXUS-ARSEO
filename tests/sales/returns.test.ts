import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseReturnLines } from "../../src/lib/sales/returns.ts";

const item = "a1a1a1a1-1111-4111-8111-111111111111", batch = "b2b2b2b2-2222-4222-8222-222222222222", batch2 = "c3c3c3c3-3333-4333-8333-333333333333";

describe("customer return form", () => {
  it("reads filled lines with their reasons and skips empty ones", () => {
    assert.deepEqual(parseReturnLines([
      [`qty_${item}_${batch}`, " 1 2,5 "], [`reason_${item}_${batch}`, "damaged"],
      [`qty_${item}_${batch2}`, ""], [`reason_${item}_${batch2}`, "refused"], ["reason", "Клиент вернул"],
    ]), [{ sale_item_id: item, batch_id: batch, quantity: 12.5, reason_code: "damaged" }]);
  });

  it("defaults the reason and refuses bad input", () => {
    assert.equal(parseReturnLines([[`qty_${item}_${batch}`, "3"]])[0].reason_code, "other");
    assert.throws(() => parseReturnLines([[`qty_${item}_${batch}`, "0"]]), /больше нуля/);
    assert.throws(() => parseReturnLines([[`qty_${item}_${batch}`, "1.0001"]]), /трёх знаков/);
    assert.throws(() => parseReturnLines([[`qty_${item}_${batch}`, "2"], [`reason_${item}_${batch}`, "mood"]]), /причина/);
    assert.throws(() => parseReturnLines([["qty_x_y", "2"]]), /Некорректная позиция/);
  });
});
