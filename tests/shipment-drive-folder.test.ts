import { test } from "node:test";
import assert from "node:assert/strict";
import { folderId, insideFolder, scanFolder, sourceState } from "../src/lib/google/shipment-folder.ts";
import { DriveReadonly, DRIVE_ROOT } from "../src/lib/google/drive-readonly.ts";

const folder = "Shipment_folder_123";
const file = { id: "Shipment_file_123", name: "invoice.pdf", path: "invoice.pdf", mimeType: "application/pdf", modifiedTime: "2026-10-19T00:00:00Z", version: "42", ancestors: [folder, DRIVE_ROOT] };
test("folder input cannot become arbitrary network URL", () => {
  assert.equal(folderId(`https://drive.google.com/drive/folders/${folder}?usp=sharing`), folder);
  for (const input of ["https://evil.example/drive/folders/Shipment_folder_123", "http://drive.google.com/drive/folders/Shipment_folder_123", "https://drive.google.com@evil.example/drive/folders/Shipment_folder_123", "https://drive.google.com/file/d/Shipment_file_123/view", "' or true"]) assert.throws(() => folderId(input));
});
test("recursive scan paginates, ignores shortcuts and preserves source revision", async () => {
  const pages: string[] = [];
  const result = await scanFolder({
    scopedReference: async () => ({ id: folder, name: "Shipment", path: "", mimeType: "application/vnd.google-apps.folder", ancestors: [DRIVE_ROOT] }),
    catalogPage: async input => {
      pages.push(`${input.id}:${input.page}`);
      if (input.page) return { files: [{ ...file, id: "Shipment_file_456" }], nextPage: "" };
      return { files: [file, { ...file, id: "Shipment_shortcut", mimeType: "application/vnd.google-apps.shortcut" }], nextPage: "second" };
    },
  }, folder, new AbortController().signal);
  assert.equal(pages.length, 2); assert.equal(result.length, 2); assert.equal(result[0].revision, "42");
});
test("scan fails instead of publishing truncated, duplicate or unversioned evidence", async () => {
  const root = async () => ({ id: folder, name: "Shipment", path: "", mimeType: "application/vnd.google-apps.folder", ancestors: [DRIVE_ROOT] });
  for (const files of [[file, file], [{ ...file, version: undefined }], Array.from({ length: 501 }, (_, i) => ({ ...file, id: `Shipment_file_${i}` }))]) {
    await assert.rejects(scanFolder({ scopedReference: root, catalogPage: async () => ({ files, nextPage: "" }) }, folder, new AbortController().signal));
  }
});
test("changed or moved files cannot be imported against old preview", () => {
  insideFolder(file, folder, "42");
  assert.throws(() => insideFolder(file, folder, "41"));
  assert.throws(() => insideFolder({ ...file, ancestors: [DRIVE_ROOT] }, folder, "42"));
  assert.match(sourceState({ present: true, revision: "43", imported_revision: "42" }), /не заменён/);
  assert.match(sourceState({ present: false, revision: "42", imported_revision: "42" }), /сохранён/);
});
test("scoped reader is GET only, refuses another tree and shortcuts; archive root unchanged", async () => {
  const calls: string[] = [];
  const customRoot = "Approved_shipments_2026";
  const metadata: Record<string, unknown> = {
    [customRoot]: { id: customRoot, name: "Approved", mimeType: "application/vnd.google-apps.folder" },
    [folder]: { id: folder, name: "Shipment", mimeType: "application/vnd.google-apps.folder", parents: [customRoot] },
    [file.id]: { ...file, parents: [folder] },
    "Outside_file_123": { ...file, id: "Outside_file_123", parents: ["Outside_root_123"] },
    "Outside_root_123": { id: "Outside_root_123", name: "Outside", mimeType: "application/vnd.google-apps.folder", parents: [] },
    "Shortcut_file_123": { ...file, id: "Shortcut_file_123", mimeType: "application/vnd.google-apps.shortcut", parents: [folder] },
  };
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(init?.method, "GET"); assert.equal(init.redirect, "error");
    const url = new URL(String(input)); calls.push(url.pathname);
    const id = url.pathname.split("/").at(-1)!;
    return new Response(JSON.stringify(metadata[id] ?? {}));
  };
  const drive = new DriveReadonly(async () => "synthetic", fetcher, customRoot);
  assert.deepEqual((await drive.scopedReference(file.id, new AbortController().signal)).ancestors, [folder, customRoot]);
  await assert.rejects(drive.scopedReference("Outside_file_123", new AbortController().signal));
  await assert.rejects(drive.scopedReference("Shortcut_file_123", new AbortController().signal));
  assert.ok(calls.length); assert.equal(DRIVE_ROOT, "1VRUVM95YlgH4hyzILnC56mq_2Dpw5adm");
});
