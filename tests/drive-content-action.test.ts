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
import { isShipmentDriveRoot } from "../src/lib/google/shipment-drive.ts";
const code = ts.transpileModule(readFileSync(new URL("../src/app/shipments/drive-folder-actions.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
for (const mode of ["ok", "moved", "changed", "denied", "database-refused", "forged-checksum", "storage-denied", "preview-ok", "preview-forged-checksum", "preview-storage-denied"] as const) {
  test(`link-only action ${mode}: both byte streams, current membership, no Storage write`, async () => {
    const shipment = randomUUID(), document = randomUUID(), version = randomUUID();
    const folder = "Synthetic_folder";
    const bytes = new TextEncoder().encode("%PDF-1.4 synthetic");
    let reads = 0, calls = 0, downloads = 0;
    const query = (data: unknown) => ({ select() { return this; }, eq() { return this; }, is() { return this; }, neq() { return this; }, single: async () => ({ data }), maybeSingle: async () => ({ data }), limit: async () => ({ data: [data] }) });
    const supabase = {
      from: (table: string) => query(table === "document_versions" ? { id: version, document_id: document, version_number: 1,
        storage_bucket: files.DOCUMENT_BUCKET, storage_path: "synthetic/path.pdf", file_size_bytes: bytes.length } : { id: shipment, current_version: 1 }),
      storage: { from: () => ({
        download: async () => mode.includes("storage-denied") ? { error: { message: "private SQL must not leak" } }
          : { data: new Blob([mode.includes("forged-checksum") ? new Uint8Array(bytes.length) : bytes]) },
        upload: () => { throw Error("Storage write forbidden"); }, remove: () => { throw Error("Storage deletion forbidden"); },
      }) },
    };
    const db = { from: (name: string) => query(name === "shipment_drive_folders" ? { folder_id: folder }
      : { file_id: "Synthetic_file", present: true, revision: "3" }),
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name === "begin_shipment_drive_operation") return { data: { action: "run", attempt: 1 } };
        if (name === "record_shipment_drive_operation") return { data: null };
        calls++; assert.equal(name, mode.startsWith("preview-") ? "check_shipment_drive_content" : "link_shipment_drive_document");
        assert.equal(args.p_checksum, createHash("sha256").update(bytes).digest("hex"));
        if (mode.startsWith("preview-")) assert.deepEqual(Array.from(args.p_verified_versions as string[]), mode === "preview-ok" ? [version] : []);
        else assert.equal(args.p_version_id, version);
        return mode === "database-refused" ? { error: { message: "private SQL must not leak" } } : { data: document };
      } };
    const deps: Record<string, unknown> = {
      "@/lib/agent/shipment-workflow": workflow,
      "node:crypto": { createHash, randomUUID }, "next/cache": { revalidatePath() {} },
      "next/navigation": { redirect: (url: string) => { throw Error(url); } },
      "@/lib/auth/access": { requireUser: async () => ({ supabase }) },
      "@/lib/permissions": { loadPermissions: async (_: unknown, names: string[]) => Object.fromEntries(names.map(n => [n, mode !== "denied"])) },
      "@/lib/documents/rules": { isUuid }, "@/lib/documents/files": files,
      "@/lib/documents/processing-status": processingStatus,
      "@/lib/google/shipment-gateway": { shipmentDriveGateway: async () => db },
      "@/lib/google/shipment-folder": { insideFolder },
      "@/lib/google/shipment-drive": { isShipmentDriveRoot },
      "@/lib/google/drive-server": { shipmentDrive: () => ({
        scopedReference: async () => { reads++; return { ancestors: reads > 1 && mode === "moved" ? [] : [folder], version: reads > 1 && mode === "changed" ? "4" : "3" }; },
        download: async () => { downloads++; return { blob: new Blob([bytes]), filename: "invoice.pdf" }; },
      }) },
    };
    const exports: { linkShipmentDriveDocument?: (f: FormData) => Promise<void>; checkShipmentDriveContent?: (f: FormData) => Promise<void> } = {};
    runInNewContext(code, { exports, require: (name: string) => { assert.ok(name in deps); return deps[name]; }, AbortSignal, Uint8Array, Error });
    const form = new FormData();
    for (const [k, v] of Object.entries({ shipment_id: shipment, file_id: "Synthetic_file", revision: "3", document_id: document, version_id: version, confirm: "yes" })) form.set(k, v);
    await assert.rejects((mode.startsWith("preview-") ? exports.checkShipmentDriveContent! : exports.linkShipmentDriveDocument!)(form), e => {
      assert.ok(e instanceof Error);
      assert.equal(e.message.includes("private SQL"), false);
      assert.equal(e.message.includes("success="), ["ok", "preview-ok", "preview-forged-checksum"].includes(mode));
      return true;
    });
    assert.equal(calls, ["ok", "database-refused", "preview-ok", "preview-forged-checksum"].includes(mode) ? 1 : 0);
    assert.equal(downloads, mode === "denied" ? 0 : 1);
  });
}
