import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calculate, day, lastEligible, shelfPct, type Supply } from "../../src/lib/replenishment/calculate.ts";
import { fixture } from "./fixture.ts";
function stock(change: Partial<Supply> = {}): Supply {
  return { id: "B", productId: "P", warehouseId: "AST", batch: "LOT", quantity: 100, expiry: "2028-01-01", manufactured: null, availableOn: "2026-11-08", kind: "stock", purpose: "kz", city: null, usable: true, conversionKnown: true, ...change };
}
describe("KZ replenishment", () => {
  it("keeps cities separate and rounds purchase to boxes", () => {
    const f = fixture(); f.supplies = [stock()]; const r = calculate(f);
    assert.equal(r.lines[0].purchase, 40); assert.equal(r.lines[1].purchase, 70);
    assert.equal(r.horizonEnd, "2026-11-21");
  });
  it("export stock never reduces Kazakhstan need", () => {
    const f = fixture(); f.supplies = [stock({ purpose: "export", quantity: 10000 })];
    const r = calculate(f); assert.equal(r.lines[0].purchase, 140); assert.equal(r.lines[0].excludedExport, 10000); assert.equal(r.transfers.length, 0);
  });
  it("unknown purpose blocks proposal and never becomes available implicitly", () => {
    const f = fixture(); f.supplies = [stock({ purpose: "unknown" })];
    const r = calculate(f); assert.equal(r.lines[0].purchase, 140); assert.ok(r.lines[0].blockers.some(x => x.includes("назначением")));
  });
  it("a donor keeps its demand; proposed transfers are not confirmed supply", () => {
    const f = fixture(); f.supplies = [stock({ quantity: 200 })]; const r = calculate(f);
    assert.equal(r.transfers[0].quantity, 60); assert.equal(r.transfers[0].to, "almaty");
    assert.equal(r.lines[1].purchase, 70); assert.equal(r.lines[1].afterTransfers, 10);
  });
  it("Aktobe pool is used at most once", () => {
    const f = fixture(); f.supplies = [stock({ warehouseId: "ACT", quantity: 100 })]; const r = calculate(f);
    assert.equal(r.transfers.reduce((n, x) => n + x.quantity, 0), 100);
    assert.equal(r.lines.reduce((n, x) => n + x.purchase, 0), 210);
  });
  it("stock allocated to another city does not feed the physical city's forecast", () => {
    const f = fixture(); f.supplies = [stock({ city: "almaty", quantity: 50 })]; const r = calculate(f);
    assert.equal(r.lines[0].usable, 0); assert.equal(r.transfers[0].to, "almaty"); assert.equal(r.transfers[0].quantity, 50);
  });
  it("export allocation and KZ allocation may split the same physical batch", () => {
    const f = fixture(); f.supplies = [stock({ id: "B:kz", warehouseId: "ACT", quantity: 50 }), stock({ id: "B:export", warehouseId: "ACT", quantity: 50, purpose: "export" })];
    assert.equal(calculate(f).transfers.reduce((n, x) => n + x.quantity, 0), 50);
  });
  it("deduplicates identical inbound but rejects conflicting copies", () => {
    const f = fixture(); const s = stock({ kind: "inbound", city: "astana" }); f.supplies = [s, s]; assert.equal(calculate(f).lines[0].inbound, 100);
    f.supplies = [s, { ...s, quantity: 99 }]; assert.throws(() => calculate(f), /Противоречащие/);
  });
  it("late inbound does not hide an earlier shortage", () => {
    const f = fixture(); f.supplies = [stock({ kind: "inbound", city: "astana", availableOn: "2026-11-18", quantity: 1000 })];
    const r = calculate(f).lines[0]; assert.equal(r.firstShortage, "2026-11-08"); assert.equal(r.inbound, 40); assert.equal(r.purchase, 100);
  });
  it("stock and inbound are excluded when blocked, unknown units or missing expiry", () => {
    for (const change of [{ usable: false }, { conversionKnown: false }, { expiry: null }] as Partial<Supply>[]) {
      const f = fixture(); f.supplies = [stock(change)]; assert.equal(calculate(f).lines[0].purchase, 140);
    }
  });
  it("new SKU without history must be explicitly decided, including a zero", () => {
    const f = fixture(); f.settings.overrides = []; assert.ok(calculate(f).lines.every(l => l.blockers.some(b => b.includes("стартовый"))));
    f.settings.overrides = [{ productId: "P", city: "astana", daily: 0, reason: "Не вводим в Астане" }]; assert.equal(calculate(f).lines[0].blockers.length, 0);
  });
  it("uses daily history without treating a partial month as a full month", () => {
    const f = fixture(); f.settings.overrides = []; f.sales = [{ id: "sale", productId: "P", city: "astana", customerId: "C", date: "2026-11-03", quantity: 70, requiredPct: 80 }];
    const r = calculate(f); assert.equal(r.lines[0].daily, 10); assert.equal(r.lines[0].demand, 140);
  });
  it("deduplicates history IDs and excludes today from training", () => {
    const f = fixture(); f.settings.overrides = [];
    const sale = { id: "S", productId: "P", city: "astana" as const, customerId: "C", date: "2026-11-03", quantity: 70, requiredPct: 80 };
    f.sales = [sale, sale, { ...sale, id: "today", date: "2026-11-08", quantity: 1000 }]; assert.equal(calculate(f).lines[0].daily, 10);
  });
  it("subtracts reserved demand and reserved stock once; known unreserved orders are a floor", () => {
    const f = fixture(); f.supplies = [stock({ quantity: 40 })]; f.commitments = [{ productId: "P", city: "astana", quantity: 60, reserved: 60 }];
    assert.equal(calculate(f).lines[0].purchase, 40);
    f.commitments = [{ productId: "P", city: "astana", quantity: 300, reserved: 60 }]; assert.equal(calculate(f).lines[0].purchase, 200);
  });
  it("customer requirements, not a global 30%, control eligible stock", () => {
    const f = fixture(); f.sales = [{ id: "S", productId: "P", city: "astana", customerId: "C", date: "2026-11-03", quantity: 70, requiredPct: 90 }];
    f.supplies = [stock({ expiry: "2027-01-01" })]; assert.equal(calculate(f).lines[0].purchase, 140); assert.equal(calculate(f).risks[0].level, "critical");
  });
  it("honours a stricter new customer in open unreserved orders", () => {
    const f = fixture(); f.supplies = [stock({ expiry: "2027-02-01", quantity: 140 })];
    f.commitments = [{ productId: "P", city: "astana", quantity: 140, reserved: 0, requiredPct: 90 }];
    assert.equal(calculate(f).lines[0].usable, 0);
    assert.equal(calculate(f).lines[0].purchase, 140);
  });
  it("strict and relaxed customer channels do not share the same deadline", () => {
    const f = fixture(); f.sales = [90, 10].map((pct, i) => ({ id: String(i), productId: "P", city: "astana", customerId: String(i), date: "2026-11-03", quantity: 35, requiredPct: pct }));
    f.supplies = [stock({ expiry: "2027-02-01", quantity: 140 })]; assert.equal(calculate(f).lines[0].usable, 70);
  });
  it("expired stock with unknown total life still raises a critical warning", () => {
    const f = fixture(); f.products[0].shelfDays = null; f.supplies = [stock({ expiry: "2026-11-07" })];
    assert.equal(calculate(f).risks[0].level, "critical"); assert.equal(calculate(f).risks[0].quantity, 100);
  });
  it("unknown shelf life remains unknown", () => {
    const f = fixture(); f.products[0].shelfDays = null; f.supplies = [stock()]; assert.equal(calculate(f).risks[0].level, "unknown");
  });
  it("matches rounded sales OSG boundary, including 0 and 100 percent", () => {
    const s = stock({ manufactured: "2026-01-01", expiry: "2027-01-01" }); const p = fixture().products[0];
    for (const pct of [0, 33.33, 67.76, 80, 99.99, 100]) {
      const d = lastEligible(s, p, pct)!;
      assert.ok(shelfPct(s, p.shelfDays, d)! >= pct);
      assert.ok(d === day(s.expiry!) || shelfPct(s, p.shelfDays, d + 1)! < pct);
    }
  });
  it("does not propose transfers that arrive after the eligibility deadline", () => {
    const f = fixture(); f.settings.transferDays = 20; f.supplies = [stock({ warehouseId: "ACT", quantity: 1000 })]; assert.equal(calculate(f).transfers.length, 0);
  });
  it("does not propose breaking a stock unit when the source is held in boxes", () => {
    const f = fixture(); f.supplies = [stock({ warehouseId: "ACT", quantity: 95, step: 20 })];
    const r = calculate(f); assert.ok(r.transfers.length > 0);
    assert.ok(r.transfers.every(t => t.quantity % 20 === 0));
    assert.ok(r.transfers.reduce((n, t) => n + t.quantity, 0) <= 80);
  });
  it("variance changes safety stock; there is no universal percentage", () => {
    const f = fixture(); f.settings.serviceZ = 1.65; f.sales = [{ id: "S", productId: "P", city: "astana", customerId: "C", date: "2026-11-03", quantity: 70, requiredPct: 80 }];
    assert.ok(calculate(f).lines[0].safety > 0); assert.equal(calculate(f).lines[1].safety, 0);
  });
  it("invalid and ambiguous input fails closed", () => {
    const f = fixture(); f.settings.overrides.push({ ...f.settings.overrides[0] }); assert.throws(() => calculate(f), /ручной спрос/);
    assert.throws(() => day("2026-02-30"));
    f.settings.overrides = []; f.settings.astana = "ACT"; assert.throws(() => calculate(f), /три разных/);
  });
  it("is deterministic and leaves its input unchanged", () => {
    const f = fixture(), before = structuredClone(f); assert.deepEqual(calculate(f), calculate(f)); assert.deepEqual(f, before);
  });
});
