import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { PDFDocument } from "pdf-lib";
import { countSheetSections, renderCountSheetPdf } from "../../src/lib/inventory/count-pdf.ts";
import { countedTotals, reviewRows, type CountEntry, type CountReview, type CountSheet } from "../../src/lib/inventory/counts.ts";

const L1 = "11111111-1111-4111-8111-111111111111";
const L2 = "22222222-2222-4222-8222-222222222222";
const P1 = "33333333-3333-4333-8333-333333333333";
const B1 = "44444444-4444-4444-8444-444444444444";
const entry = (patch: Partial<CountEntry>): CountEntry => ({
  id: crypto.randomUUID(), round: 1, location_id: L1, location: "A-01", product_id: P1, sku: "P1", product: "Печенье", batch_id: B1, batch: "B1",
  expiry_date: null, uom: "piece", quantity: "1", note: null, counted_by: "A", counted_at: "2026-11-28T05:00:00Z", supersedes_entry_id: null,
  superseded: false, ...patch,
});
const sheet = (patch: Partial<CountSheet> = {}): CountSheet => ({
  id: crypto.randomUUID(), number: "ИНВ-000001", status: "counting", kind: "partial", blind: true, note: null, warehouse_id: L1, warehouse: "Алматы",
  responsible: null, created_at: "", started_at: null, review_at: null, posted_at: null, cancelled_at: null, cancellation_reason: null,
  tolerance_pieces: "0", adjustment_document_id: null, adjustment_document: null, round: 1, can_manage: true, can_record: true, can_approve: false,
  scope: [], locations: [{ id: L1, code: "A-01", zone: "storage" }, { id: L2, code: "A-02", zone: "storage" }], no_location: false,
  entries: [], recount: null, book: null, ...patch,
});

describe("inventory counts: records", () => {
  it("records of one line add up; a corrected record no longer counts; rounds apart", () => {
    const totals = countedTotals([entry({ quantity: "60", superseded: true }), entry({ quantity: "58" }), entry({ quantity: "30", counted_by: "B" }),
      entry({ quantity: "5", uom: "box" }), entry({ quantity: "88", round: 2 })], 1);
    assert.deepEqual(totals.map(total => [total.entry.uom, total.quantity, total.records]), [["piece", 88, 2], ["box", 5, 1]]);
  });
});

describe("inventory counts: printed sheet", () => {
  it("a blind count prints empty rows per location, never the book", () => {
    const sections = countSheetSections(sheet({ book: [{ location_id: L1, location: "A-01", product_id: P1, sku: "P1", product: "Печенье",
      batch_id: B1, batch: "B1", expiry_date: null, uom: "piece", quantity: "100" }] }));
    assert.deepEqual(sections.map(section => section.title), ["Место A-01", "Место A-02"]);
    assert.ok(sections.every(section => section.rows.length === 0 && section.blankRows > 0 && !section.columns.includes("Учёт")));
  });

  it("an open count prints the book with an empty column; the recount prints its lines and who must not count them", () => {
    const open = countSheetSections(sheet({ blind: false, book: [{ location_id: L1, location: "A-01", product_id: P1, sku: "P1", product: "Печенье",
      batch_id: B1, batch: "B1", expiry_date: "2027-06-01", uom: "piece", quantity: "100" }] }));
    assert.deepEqual(open[0].rows, [["P1 Печенье", "B1", "2027-06-01", "шт.", "100", ""]]);
    const recount = countSheetSections(sheet({ status: "recount", round: 2, recount: [{ location_id: L1, location: "A-01", product_id: P1, sku: "P1",
      product: "Печенье", batch_id: null, batch: null, uom: "box", done: false, first_counters: ["Counter A", "Counter B"] }] }));
    assert.deepEqual(recount[0].rows, [["A-01", "P1 Печенье", "не определена", "кор.", "", "Counter A, Counter B"]]);
  });

  it("renders a PDF with the bundled Cyrillic font", async () => {
    const fonts = { regular: new Uint8Array(await readFile("public/fonts/ubuntu-regular.ttf")), bold: new Uint8Array(await readFile("public/fonts/ubuntu-bold.ttf")) };
    const bytes = await renderCountSheetPdf(sheet(), fonts);
    const pdf = await PDFDocument.load(bytes);
    assert.ok(pdf.getPageCount() >= 1);
    assert.equal(pdf.getTitle(), "Инвентаризация ИНВ-000001");
  });
});

describe("inventory counts: XLSX report", () => {
  const review = (cost: boolean): CountReview => ({
    number: "ИНВ-000001", status: "review", cost, can_approve: true, digest: "d",
    totals: { lines: 2, matches: 1, shortages: 1, surpluses: 0, unknown: 0, shortage_pieces: "12", surplus_pieces: "0",
      shortage_kzt: cost ? "12000.00" : null, surplus_kzt: cost ? "0" : null, no_cost_lines: cost ? 0 : null, problems: 0 },
    lines: [{ id: "x", location_id: L1, location: "A-01", product_id: P1, sku: "P1", product: "Печенье", batch_id: B1, batch: "B1", expiry_date: null,
      uom: "piece", book: "100", reserved: "0", counted: "88", recount: "88", final: "88", difference: "-12", difference_pieces: "-12", kind: "shortage",
      other_location: false, needs_recount: true, reason_code: "count_shortage", reason: "Недостача при пересчёте", pair_line_id: null,
      assigned_batch_id: null, assigned_batch: null, ignored: false, decided_by: null, decided_at: null, difference_kzt: cost ? "-12000.00" : null,
      problem: null, orders: null, batches: null }],
    by_reason: [{ reason_code: "count_shortage", reason: "Недостача при пересчёте", lines: 1, pieces: "12", kzt: cost ? "12000.00" : null }],
    by_location: [{ location_id: L1, location: "A-01", lines: 1, shortage_pieces: "12", surplus_pieces: "0", shortage_kzt: cost ? "12000.00" : null, surplus_kzt: null }],
    reasons: [],
  });

  it("has money columns only with the purchase prices", () => {
    const withCost = reviewRows({ number: "ИНВ-000001", warehouse: "Алматы", status: "review" }, review(true));
    assert.ok(withCost.some(row => row.includes("Разница, KZT")) && withCost.some(row => row.includes(-12000)));
    const without = reviewRows({ number: "ИНВ-000001", warehouse: "Алматы", status: "review" }, review(false));
    const text = JSON.stringify(without);
    assert.ok(!text.includes("KZT") && !text.includes("12000"), "no money anywhere");
    assert.match(text, /суммы в деньгах не показываются/);
    assert.ok(without.some(row => row[0] === "A-01" && row.includes(-12) && row.includes("Недостача при пересчёте")));
  });
});
