import { test } from "node:test";
import assert from "node:assert/strict";
import { readReceivingLines } from "../src/lib/shipments/receiving-lines.ts";
const id = "11111111-1111-4111-8111-111111111111";
function form(rows: Record<string, string>[] = []) {
  const f = new FormData();
  for (const row of rows) for (const [key, value] of Object.entries({ item_id:id, expected_quantity:"60", accepted_quantity:"58", damaged_quantity:"0", batch_number:"LOT-A", manufacture_date:"", expiry_date:"2028-01-19", discrepancy_reason:"Shortage 2", ...row })) f.append(key,value);
  return f;
}
test("multiple lots keep their item, amounts, leading zeroes and individual expiry", () => {
  const rows=readReceivingLines(form([{batch_number:"000007176"},{expected_quantity:"40",accepted_quantity:"40",batch_number:"000005652",expiry_date:"2027-12-21",discrepancy_reason:""}]));
  assert.equal(rows.length,2); assert.equal(rows[0].item_id,rows[1].item_id); assert.equal(rows[0].batch_number,"000007176");
  assert.equal(rows.reduce((sum,row)=>sum+row.accepted_quantity,0),98); assert.equal(rows[1].expiry_date,"2027-12-21");
});
test("empty, missing or excess fields fail instead of aligning different lots", () => {
  assert.throws(()=>readReceivingLines(form())); const f=form([{}]); f.delete("batch_number"); assert.throws(()=>readReceivingLines(f));
});
test("invalid numbers, missing quantities and invalid dates fail", () => {
  for (const value of ["", "NaN", "Infinity", "-1", "1.0001", "1e2", "0x10", "100000000000"]) assert.throws(()=>readReceivingLines(form([{accepted_quantity:value}])));
  assert.throws(()=>readReceivingLines(form([{expected_quantity:"0"}])));
  assert.throws(()=>readReceivingLines(form([{expiry_date:"2027-02-30"}])));
});
test("a fully missing lot preserves zero accepted and its expected amount", () => {
  const [row]=readReceivingLines(form([{accepted_quantity:"0",discrepancy_reason:"Not delivered"}]));
  assert.equal(row.accepted_quantity,0); assert.equal(row.expected_quantity,60); assert.equal(row.manufacture_date,null);
});
