import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  CARD_STATUSES,
  availableCardActions,
  canCreateNewVersion,
  canTransition,
  isCardEditable,
  parseDecimal,
  validateCardHeader,
  validateCardItem,
} from "../../src/lib/listing-cards/rules.ts";

const PRODUCT = "f1000000-0000-4000-8000-000000000001";
const OTHER_PRODUCT = "f1000000-0000-4000-8000-000000000002";
const CURRENCY = "c0000000-0000-4000-8000-0000000000aa";
const CUSTOMER = "f0000000-0000-4000-8000-000000000001";
const all = { create: true, update: true, archive: true, approve: true, change_status: true };
const none = { create: false, update: false, archive: false, approve: false, change_status: false };
const item = (overrides = {}) => ({
  product_id: PRODUCT,
  required_quantity: 12,
  uom: "box",
  customer_sku: null,
  price: null,
  currency_id: null,
  comment: null,
  ...overrides,
});

describe("card status graph", () => {
  it("moves draft → submitted → decision, and approved → superseded only", () => {
    assert.equal(canTransition("draft", "submitted"), true);
    assert.equal(canTransition("submitted", "approved_by_customer"), true);
    assert.equal(canTransition("submitted", "rejected_by_customer"), true);
    assert.equal(canTransition("approved_by_customer", "superseded"), true);
  });

  it("never reopens a decided, cancelled or superseded card", () => {
    for (const from of ["approved_by_customer", "rejected_by_customer", "cancelled", "superseded"]) {
      assert.equal(canTransition(from, "draft"), false, from);
      assert.equal(canTransition(from, "submitted"), false, from);
    }
    assert.equal(canTransition("draft", "approved_by_customer"), false, "no approval without sending");
    assert.equal(canTransition("draft", "unknown"), false);
  });

  it("matches the transitions enforced by the database trigger", () => {
    const sql = readFileSync(
      new URL("../../supabase/migrations/202609271600_document_templates_listing_cards.sql", import.meta.url),
      "utf8",
    );
    const guard = sql.slice(sql.indexOf("function private.guard_listing_card_update"), sql.indexOf("drop trigger if exists guard_listing_card_update"));
    const allowed = new Set<string>();
    for (const match of guard.matchAll(/old\.status = '(\w+)' and new\.status (?:in \(([^)]*)\)|= '(\w+)')/g)) {
      const targets = match[2] ? match[2].split(",").map((value) => value.trim().replace(/'/g, "")) : [match[3]];
      for (const target of targets) allowed.add(`${match[1]}→${target}`);
    }
    assert.ok(allowed.size > 0, "transitions found in the migration");
    for (const from of CARD_STATUSES) {
      for (const to of CARD_STATUSES) {
        assert.equal(canTransition(from, to), allowed.has(`${from}→${to}`), `${from} → ${to}`);
      }
    }
  });
});

describe("editing and versions", () => {
  it("allows editing only drafts", () => {
    assert.equal(isCardEditable("draft"), true);
    for (const status of ["submitted", "approved_by_customer", "rejected_by_customer", "cancelled", "superseded"]) {
      assert.equal(isCardEditable(status), false, status);
    }
  });

  it("creates a new version only from the latest final version", () => {
    assert.equal(canCreateNewVersion("approved_by_customer", false), true);
    assert.equal(canCreateNewVersion("rejected_by_customer", false), true);
    assert.equal(canCreateNewVersion("cancelled", false), true, "a cancelled latest version must not block the chain");
    assert.equal(canCreateNewVersion("approved_by_customer", true), false, "only one successor");
    assert.equal(canCreateNewVersion("draft", false), false, "edit the draft instead");
    assert.equal(canCreateNewVersion("submitted", false), false);
    assert.equal(canCreateNewVersion("superseded", false), false);
  });

  it("offers actions by status and permission", () => {
    assert.deepEqual(availableCardActions({ status: "draft", itemCount: 0, hasSuccessor: false }, all), ["edit", "add_item", "cancel"]);
    assert.deepEqual(availableCardActions({ status: "draft", itemCount: 2, hasSuccessor: false }, all), ["edit", "add_item", "submit", "cancel"]);
    assert.deepEqual(availableCardActions({ status: "submitted", itemCount: 2, hasSuccessor: false }, all), ["decide", "cancel"]);
    assert.deepEqual(availableCardActions({ status: "approved_by_customer", itemCount: 2, hasSuccessor: false }, all), ["new_version"]);
    assert.deepEqual(availableCardActions({ status: "approved_by_customer", itemCount: 2, hasSuccessor: true }, all), []);
    assert.deepEqual(availableCardActions({ status: "draft", itemCount: 2, hasSuccessor: false }, none), []);
    assert.deepEqual(
      availableCardActions({ status: "submitted", itemCount: 2, hasSuccessor: false }, { ...none, approve: true }),
      ["decide"],
      "the commercial director decides without editing rights",
    );
  });
});

describe("card items", () => {
  it("accepts a complete item", () => {
    assert.equal(validateCardItem(item({ customer_sku: "SKU-1", price: 1500.5, currency_id: CURRENCY })), null);
  });

  it("requires a positive quantity with at most three decimals", () => {
    assert.notEqual(validateCardItem(item({ required_quantity: 0 })), null);
    assert.notEqual(validateCardItem(item({ required_quantity: -5 })), null);
    assert.notEqual(validateCardItem(item({ required_quantity: Number.NaN })), null);
    assert.notEqual(validateCardItem(item({ required_quantity: 1.2345 })), null);
    assert.equal(validateCardItem(item({ required_quantity: 1.125 })), null);
  });

  it("requires a currency together with a price and rejects negative prices", () => {
    assert.match(validateCardItem(item({ price: 10 })) ?? "", /валюту/);
    assert.notEqual(validateCardItem(item({ price: -1, currency_id: CURRENCY })), null);
    assert.equal(validateCardItem(item({ price: 0, currency_id: CURRENCY })), null, "free goods are allowed");
  });

  it("rejects a product already on the card and unknown units", () => {
    assert.notEqual(validateCardItem(item(), [PRODUCT.toUpperCase()]), null);
    assert.equal(validateCardItem(item(), [OTHER_PRODUCT]), null);
    assert.notEqual(validateCardItem(item({ uom: "truck" })), null, "a truck is not a listing unit");
    assert.notEqual(validateCardItem(item({ product_id: "not-a-uuid" })), null);
  });

  it("limits the customer article and comment", () => {
    assert.notEqual(validateCardItem(item({ customer_sku: "   " })), null);
    assert.notEqual(validateCardItem(item({ customer_sku: "x".repeat(101) })), null);
    assert.notEqual(validateCardItem(item({ comment: "x".repeat(1001) })), null);
  });
});

describe("card header and number input", () => {
  it("requires a card type and a customer", () => {
    const header = { card_type: "input", customer_id: CUSTOMER, template_id: null, title: null, effective_date: "2026-10-15", notes: null };
    assert.equal(validateCardHeader(header), null);
    assert.notEqual(validateCardHeader({ ...header, card_type: "transfer" }), null);
    assert.notEqual(validateCardHeader({ ...header, customer_id: "" }), null);
    assert.notEqual(validateCardHeader({ ...header, effective_date: "15.10.2026" }), null);
  });

  it("parses decimals typed with spaces and commas", () => {
    assert.equal(parseDecimal("1 200,5"), 1200.5);
    assert.equal(parseDecimal("48"), 48);
    assert.equal(parseDecimal(""), null);
    assert.ok(Number.isNaN(parseDecimal("12abc") as number));
  });
});
