import test from "node:test";
import assert from "node:assert/strict";
import { checkpointProblems, type Checkpoint } from "./pilot/historical-contract.ts";
const valid = (): Checkpoint[] => [
  { stage: "received", stock: { piece: 147 }, reserved: 0, movements: 3, receipt_count: 2 },
  { stage: "reserved", stock: { piece: 147 }, reserved: 70, movements: 3, receipt_count: 2 },
  { stage: "transferred", stock: { piece: 147 }, reserved: 70, movements: 5, receipt_count: 2 },
  { stage: "shipped", stock: { piece: 77 }, reserved: 0, movements: 7, receipt_count: 2 },
  { stage: "returned", stock: { piece: 77, box: 1 }, reserved: 0, movements: 8, receipt_count: 2 },
  { stage: "closed", stock: { piece: 77, box: 1 }, reserved: 0, movements: 8, receipt_count: 2 },
];
test("historical checkpoints retain separate units, returned box and zero final reserve", () => {
  assert.deepEqual(checkpointProblems(valid()), []);
});
test("missing checkpoints are not a complete historical run", () => {
  assert.notDeepEqual(checkpointProblems(valid().slice(1)), []);
});
test("double issue, double receipt, lost return and damage counted as stock are detected", () => {
  for (const edit of [
    (r: Checkpoint[]) => { r[3].movements += 2; },
    (r: Checkpoint[]) => { r[0].receipt_count++; },
    (r: Checkpoint[]) => { delete r[5].stock.box; },
    (r: Checkpoint[]) => { r[0].stock.piece = 148; },
    (r: Checkpoint[]) => { r[5].reserved = 70; },
  ]) {
    const rows = valid(); edit(rows);
    assert.notDeepEqual(checkpointProblems(rows), []);
  }
});
