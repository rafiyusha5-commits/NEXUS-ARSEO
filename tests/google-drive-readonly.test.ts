import assert from "node:assert/strict";
import { it } from "node:test";
import { DriveReadonly, DRIVE_ROOT, driveTerms, safeFilename } from "../src/lib/google/drive-readonly.ts";
const FOLDER = "application/vnd.google-apps.folder";
const folder = "Belgian_folder_123"; const fileId = "Declaration_file_123";
function fixture(options: { outside?: boolean; large?: boolean; pages?: boolean } = {}) {
  const calls: URL[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url);
    assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error");
    assert.equal(url.origin, "https://www.googleapis.com");
    if (url.pathname.endsWith("/files")) {
      const q = url.searchParams.get("q");
      assert.ok([`'${DRIVE_ROOT}' in parents and trashed=false`, `'${folder}' in parents and trashed=false`].includes(q!));
      const files = q?.includes(DRIVE_ROOT) ? [{ id: folder, name: "Belgian", mimeType: FOLDER }, { id: "Shortcut_file_123", name: "secret", mimeType: "application/vnd.google-apps.shortcut" }]
        : [{ id: fileId, name: "ДС Belgian.pdf", mimeType: "application/pdf", size: options.large ? "99999999" : "4" }];
      return Response.json({ files, ...(options.pages && q?.includes(folder) && !url.searchParams.has("pageToken") ? { nextPageToken: "page2" } : {}) });
    }
    if (url.searchParams.get("alt") === "media") return new Response(new Uint8Array([1, 2, 3, 4]));
    const id = url.pathname.split("/").at(-1);
    assert.ok([DRIVE_ROOT, folder, fileId].includes(id!));
    return Response.json({ id, name: id === fileId ? "ДС Belgian.pdf" : "Belgian", mimeType: id === fileId ? "application/pdf" : FOLDER,
      parents: id === fileId ? [options.outside ? "Unapproved_folder_123" : folder] : [DRIVE_ROOT], size: options.large ? "99999999" : "4" });
  };
  return { drive: new DriveReadonly(async () => "test", fetcher), calls };
}
it("finds the declaration in nested approved folders, accepts Belgain and declaration synonyms, GET only", async () => {
  const h = fixture(); const result = await h.drive.search("найди декларацию соответствия Belgain", AbortSignal.timeout(1000));
  assert.equal(result.files[0].id, fileId); assert.equal(result.total, 1); assert.equal(result.truncated, false);
  assert.deepEqual(driveTerms("декларация Belgain"), ["дс", "belgian"]);
});
it("downloads a verified file with its original filename, no remote write or shortcut traversal", async () => {
  const h = fixture(); const file = await h.drive.download(fileId, AbortSignal.timeout(1000));
  assert.equal(file.filename, "ДС Belgian.pdf"); assert.equal(file.blob.size, 4);
  assert.ok(!h.calls.some(url => url.pathname.includes("Shortcut")));
});
it("unknown IDs never cause reads of unrelated metadata", async () => {
  const h = fixture(); await assert.rejects(h.drive.file("Outside_file_123", AbortSignal.timeout(1000)));
  assert.ok(h.calls.every(url => !url.pathname.includes("Outside")));
});
it("a file moved outside the approved tree is withheld and its new parent is never read", async () => {
  const h = fixture({ outside: true }); await assert.rejects(h.drive.download(fileId, AbortSignal.timeout(1000)));
  assert.ok(!h.calls.some(url => url.searchParams.get("alt") === "media" || url.pathname.includes("Unapproved")));
});
it("oversize files fail before download; invalid IDs, URL injection and traversal are refused", async () => {
  const h = fixture({ large: true }); await assert.rejects(h.drive.download(fileId, AbortSignal.timeout(1000)));
  assert.ok(!h.calls.some(url => url.searchParams.get("alt") === "media"));
  await assert.rejects(h.drive.file("../secret", AbortSignal.timeout(1000))); assert.equal(safeFilename('a/../b\r\n.pdf'), "a_.._b__.pdf");
});
it("folder listing follows pagination and retains the approved parent query", async () => {
  const h = fixture({ pages: true }); await h.drive.search("Belgian", AbortSignal.timeout(1000));
  assert.ok(h.calls.some(url => url.searchParams.get("pageToken") === "page2"));
});
