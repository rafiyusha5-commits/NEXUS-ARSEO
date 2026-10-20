import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileSource, type ReconciliationSource, type VisibleDocument } from "../src/lib/google/folder-reconciliation.ts";
const source: ReconciliationSource = { file_id: "Synthetic_file", name: "invoice.pdf", path: "Import/invoice.pdf", present: true, revision: "2", imported_document_id: null, imported_revision: null };
const doc: VisibleDocument = { id: "doc", title: "invoice.pdf", filename: "invoice.pdf", type: "Инвойс", versionId: "v2", version: 2, status: "approved", checksum: "a".repeat(64) };
const reconcile = (s: ReconciliationSource, docs = [doc], ids = new Set<string>()) => reconcileSource(s, docs, ids);
test("name does not establish duplicate; digest must belong to current Drive revision", () => {
  assert.equal(reconcile(source).state, "possible");
  assert.equal(reconcile({ ...source, checked_revision: "1", checked_checksum: doc.checksum }).state, "possible");
  assert.equal(reconcile({ ...source, checked_revision: "2", checked_checksum: doc.checksum }).state, "exact");
  assert.equal(reconcile({ ...source, checked_revision: "2", checked_checksum: "b".repeat(64) }).state, "possible");
});
test("identical bytes across subfolders match; translations with different bytes do not", () => {
  for (const path of ["Import/copy.pdf", "Продажа клиенту/copy.pdf"]) {
    assert.equal(reconcile({ ...source, path, name: "copy.pdf", checked_revision: "2", checked_checksum: doc.checksum }).state, "exact");
    assert.equal(reconcile({ ...source, path, name: "translation.pdf", checked_revision: "2", checked_checksum: "b".repeat(64) }).state, "new");
  }
});
test("hidden/unlinked receipts cannot disclose documents, old revision or hashes", () => {
  const privateSource = { ...source, imported_document_id: "hidden", imported_revision: "1", checked_checksum: doc.checksum, checked_revision: "2" };
  const result = reconcile(privateSource, []);
  assert.equal(result.state, "new");
  assert.equal(result.imported_document_id, null);
  assert.equal(result.imported_revision, null);
  assert.equal(JSON.stringify(result).includes("hidden"), false);
  assert.equal(JSON.stringify(result).includes("checksum"), false);
});
test("linked, changed, missing and unsupported are distinct", () => {
  const linked = { ...source, imported_document_id: doc.id, imported_revision: "2" };
  assert.equal(reconcile(linked, [doc], new Set([doc.id])).state, "linked");
  assert.equal(reconcile({ ...linked, revision: "3" }, [doc], new Set([doc.id])).state, "changed");
  assert.equal(reconcile({ ...linked, present: false }, [doc], new Set([doc.id])).state, "missing");
  assert.equal(reconcile({ ...source, name: "archive.zip" }).state, "unsupported");
});
