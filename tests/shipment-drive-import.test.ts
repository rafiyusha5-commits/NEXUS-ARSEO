import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as files from "../src/lib/documents/files.ts";
import { insideFolder } from "../src/lib/google/shipment-folder.ts";
import { isUuid } from "../src/lib/documents/rules.ts";
import * as processingStatus from "../src/lib/documents/processing-status.ts";
import * as workflow from "../src/lib/agent/shipment-workflow.ts";

// Execute the real action with I/O replaced; file validation and Storage path rules stay real.
const action = ts.transpileModule(readFileSync(new URL("../src/app/shipments/drive-folder-actions.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const cases = [
  ...["Invoice.pdf", "Despatch note.pdf", "ДТ Поставка 19.03.2026.pdf", "Заявка на перевозку.docx", "a".repeat(150) + ".pdf"].map(filename => ({ filename, fault: "" })),
  ...["timeout", "stream", "storage", "lost-response", "lost-response-moved", "revoked", "forged", "after-download", "after-storage", "changed-during-download"].map(fault => ({ filename: "Synthetic.pdf", fault })),
];
for (const { filename, fault } of cases) {
  test(`Drive action ${fault || "success"}: ${filename.slice(0, 50)}`, async () => {
    const shipment = randomUUID(), existing = randomUUID(), type = randomUUID();
    const bytes = new TextEncoder().encode(filename.endsWith("docx") ? "PK\x03\x04test" : "%PDF-1.4\ntest");
    const source: { file_id: string; revision: string; present: boolean; imported_document_id: string | null; imported_revision: string | null } = { file_id: "Drive_file_123456", revision: "7", present: true, imported_document_id: null, imported_revision: null };
    const folder = "Drive_folder_123456";
    const uploaded: string[] = [], removed: string[] = [];
    let registrations = 0;
    let moved = false;
    let referenceCalls = 0, injectFault = true;
    const query = (data: unknown) => ({ select() { return this; }, eq() { return this; }, is() { return this; }, neq() { return this; }, single: async () => ({ data }), maybeSingle: async () => ({ data }), limit: async () => ({ data: [data] }) });
    const storage = {
      download: async () => ({ data: new Blob([fault === "forged" ? new Uint8Array(bytes.length) : bytes]) }),
      upload: async (path: string, actual: Uint8Array) => { assert.ok(files.isDocumentStoragePath(path)); assert.deepEqual(actual, bytes); uploaded.push(path); return { error: fault === "storage" ? { message: "SYNTH_SECRET provider detail" } : null }; },
      remove: async (paths: string[]) => { removed.push(...paths); return { error: null }; },
    };
    const supabase = { from: (table: string) => query(table === "document_versions" ? {
      id: randomUUID(), document_id: existing, version_number: 1, storage_bucket: files.DOCUMENT_BUCKET,
      storage_path: "synthetic/existing.pdf", file_size_bytes: bytes.length,
    } : { id: shipment, current_version: 1 }), storage: { from: () => storage } };
    const db = {
      from: (table: string) => query(table === "shipment_drive_folders" ? { folder_id: folder } : source),
      rpc: async (name: string, params: Record<string, unknown>) => {
        if (name === "begin_shipment_drive_operation") return { data: { action: "run", attempt: 1 }, error: null };
        if (name === "record_shipment_drive_operation") return { data: null, error: null };
        assert.equal(name, "import_shipment_drive_file"); registrations++;
        assert.equal(params.p_filename, filename, "original name is preserved for display");
        assert.equal(params.p_checksum, createHash("sha256").update(bytes).digest("hex"));
        assert.equal(params.p_storage_path, uploaded.at(-1));
        assert.equal(params.p_type_id, type);
        if (fault === "revoked") return { data: null, error: { code: "42501", message: "SYNTH_SECRET denied" } };
        if (fault.startsWith("lost-response")) { source.imported_document_id = existing; source.imported_revision = source.revision; return { data: null, error: { message: "SYNTH_SECRET response lost" } }; }
        return { data: existing, error: null };
      },
    };
    const dependencies: Record<string, unknown> = {
      "@/lib/agent/shipment-workflow": workflow,
      "node:crypto": { createHash, randomUUID }, "next/cache": { revalidatePath() {} },
      "next/navigation": { redirect: (url: string) => { throw new Error(url); } },
      "@/lib/auth/access": { requireUser: async () => ({ supabase }) },
      "@/lib/permissions": { loadPermissions: async (_: unknown, names: string[]) => Object.fromEntries(names.map(n => [n, true])) },
      "@/lib/documents/rules": { isUuid }, "@/lib/documents/files": files,
      "@/lib/documents/processing-status": processingStatus,
      "@/lib/google/shipment-gateway": { shipmentDriveGateway: async () => db },
      "@/lib/google/shipment-folder": { insideFolder },
      "@/lib/google/drive-server": { shipmentDrive: () => ({
        scopedReference: async () => {
          referenceCalls++;
          if (injectFault && ((fault === "after-download" && referenceCalls === 2) || (fault === "after-storage" && referenceCalls === 3)))
            throw new Error("SYNTH_SECRET interrupted");
          return { ancestors: moved ? [] : [folder], version: injectFault && fault === "changed-during-download" && referenceCalls >= 2 ? "8" : source.revision };
        },
        download: async () => {
          if (fault === "timeout") throw new Error("SYNTH_SECRET timeout before download");
          return { blob: fault === "stream" ? { size: bytes.length, arrayBuffer: async () => { throw new Error("SYNTH_SECRET broken stream"); } } : new Blob([bytes]), filename };
        },
      }) },
    };
    const exports: { importShipmentDriveFile?: (form: FormData) => Promise<void> } = {};
    runInNewContext(action, { exports, require: (name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, AbortSignal, Uint8Array, Error });
    const form = new FormData();
    for (const [key, value] of Object.entries({ shipment_id: shipment, document_type_id: type, file_id: source.file_id, revision: source.revision, confirm: "yes" })) form.set(key, value);
    await assert.rejects(exports.importShipmentDriveFile!(form), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes("SYNTH_SECRET"), false);
      assert.equal(error.message.includes("success="), !fault);
      return true;
    });
    assert.equal(registrations, ["timeout", "stream", "storage", "forged", "after-download", "after-storage", "changed-during-download"].includes(fault) ? 0 : 1);
    assert.equal(uploaded.length, ["timeout", "stream", "forged", "after-download", "changed-during-download"].includes(fault) ? 0 : 1);
    assert.deepEqual(removed, fault ? [] : uploaded, "never delete a possibly registered staging file");
    if (["after-download", "after-storage", "changed-during-download"].includes(fault)) {
      const retained = [...uploaded];
      injectFault = false; referenceCalls = 0;
      if (fault === "changed-during-download") {
        // Model the explicit folder rescan before retrying with the new revision.
        source.revision = "8"; form.set("revision", "8");
      }
      // Explicit employee retry after source availability is restored. No automatic retry.
      await assert.rejects(exports.importShipmentDriveFile!(form), error => {
        assert.ok(error instanceof Error); assert.ok(error.message.includes("success=")); return true;
      });
      assert.equal(registrations, 1);
      assert.equal(uploaded.length, retained.length + 1);
      for (const path of retained) assert.equal(removed.includes(path), false, "uncertain upload remains private for reconciliation");
    }
    if (fault.startsWith("lost-response")) {
      moved = fault === "lost-response-moved";
      await assert.rejects(exports.importShipmentDriveFile!(form), error => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes("success="), !moved, "a receipt must not bypass current source membership");
        if (!moved) assert.ok(decodeURIComponent(error.message).includes("квитанция импорта найдена"));
        return true;
      });
      assert.equal(registrations, 1, "retry reuses the saved source receipt, not a second registration");
      assert.equal(uploaded.length, 1, "retry does not upload another temporary object");
    }
  });
}
