import { test } from "node:test";
import assert from "node:assert/strict";
import { allocationMoney, allocationCents, parseExactAllocation } from "../../src/lib/finance/exact-allocation.ts";
const id = "ef540000-0000-4000-8000-000000000001";
function form() { const d = new FormData(); for (const k of ["request_id", "expense_id", "currency_id", "item_id"]) d.set(k,id); d.set("amount","23,45");d.set("stamp","a".repeat(64));d.set("basis_note","Verified synthetic invoice allocation"); return d; }
test("amounts stay decimal strings; cents sum without float loss", () => { assert.equal(allocationMoney("23,4"),"23.40");assert.equal(allocationCents("0.1")+allocationCents("0.2"),BigInt(30));assert.equal(parseExactAllocation(form()).p_lines[0].amount,"23.45"); });
test("ambiguous, negative, scientific, overprecision and unbounded amounts are rejected", () => { for (const a of ["", "1 000", "1,000.00", "-1", "NaN", "1e2", "1.001", "1000000000000"]) assert.throws(()=>allocationMoney(a)); });
test("reject duplicate items, missing amounts and oversized arrays", () => { const d=form();d.append("item_id",id);d.append("amount","0");assert.throws(()=>parseExactAllocation(d));d.delete("amount");assert.throws(()=>parseExactAllocation(d)); });
test("reason, review stamp and identifiers are mandatory", () => { for(const [k,v] of [["basis_note","x"],["stamp",""],["expense_id","bad"],["source_document_id","bad"]]) {const d=form();d.set(k,v);assert.throws(()=>parseExactAllocation(d));} });
