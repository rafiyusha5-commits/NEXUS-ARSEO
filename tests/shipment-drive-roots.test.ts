import { test } from "node:test";
import assert from "node:assert/strict";
import { DRIVE_ROOT, DriveReadonly } from "../src/lib/google/drive-readonly.ts";
import { FUTURE_ORDERS_DRIVE_ROOT, SHIPMENT_DRIVE_ROOT, ShipmentDriveReadonly, isShipmentDriveRoot } from "../src/lib/google/shipment-drive.ts";
import { scanFolder } from "../src/lib/google/shipment-folder.ts";

const folderMime = "application/vnd.google-apps.folder";
const archived = "Archive_shipment_123", future = "Future_shipment_123";
const archivedFile = "Archive_invoice_123", futureFile = "Future_invoice_123";
type Metadata = { id: string; name: string; mimeType: string; parents?: string[]; size?: string; version: string; modifiedTime: string; trashed?: boolean };
function fixture() {
  const records: Record<string, Metadata> = {};
  function add(id: string, parent?: string, mimeType = folderMime) {
    records[id] = { id, name: id, mimeType, parents: parent ? [parent] : [], size: "4", version: "1", modifiedTime: "2026-11-02T00:00:00Z" };
  }
  for (const root of [SHIPMENT_DRIVE_ROOT, FUTURE_ORDERS_DRIVE_ROOT, DRIVE_ROOT, "Outside_root_123"]) add(root);
  add(archived, SHIPMENT_DRIVE_ROOT); add(future, FUTURE_ORDERS_DRIVE_ROOT);
  add(archivedFile, archived, "application/pdf"); add(futureFile, future, "application/pdf");
  add("Outside_file_123", "Outside_root_123", "application/pdf");
  add("Shortcut_file_123", future, "application/vnd.google-apps.shortcut");
  const calls: string[] = [];
  let afterMedia: (() => void) | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(init?.method, "GET"); assert.equal(init.redirect, "error");
    const url = new URL(String(input)); assert.equal(url.origin, "https://www.googleapis.com");
    assert.ok(url.pathname.startsWith("/drive/v3/files")); calls.push(url.href);
    if (url.searchParams.get("alt") === "media") { afterMedia?.(); return new Response("test"); }
    if (url.pathname === "/drive/v3/files") {
      const parent = url.searchParams.get("q")?.match(/^'([\w-]+)' in parents and trashed=false$/)?.[1];
      assert.ok(parent);
      return new Response(JSON.stringify({ files: Object.values(records).filter(file => file.parents?.includes(parent) && !file.trashed) }));
    }
    const record = records[url.pathname.split("/").at(-1)!];
    return new Response(JSON.stringify(record ?? {}), { status: record ? 200 : 404 });
  };
  return { records, calls, fetcher, moveDuringDownload: (fn: () => void) => { afterMedia = fn; }, drive: new ShipmentDriveReadonly(async () => "synthetic", fetcher) };
}
const signal = () => AbortSignal.timeout(5000);

for (const [name, folder, file, root] of [["archive", archived, archivedFile, SHIPMENT_DRIVE_ROOT], ["future orders", future, futureFile, FUTURE_ORDERS_DRIVE_ROOT]]) {
  test(`${name}: resolve, complete scan and download remain GET-only inside the selected tree`, async () => {
    const h = fixture();
    assert.deepEqual((await h.drive.scopedReference(folder, signal())).ancestors, [root]);
    const files = await scanFolder(h.drive, folder, signal());
    assert.deepEqual(files.map(row => row.file_id), [file]);
    assert.equal(files[0].revision, "1");
    await h.drive.scopedReference(file, signal());
    assert.equal(await (await h.drive.download(file, signal())).blob.text(), "test");
    assert.ok(h.calls.length > 0);
  });
}
test("a readable folder outside both approved roots, shortcuts and forged ancestry are denied", async () => {
  const h = fixture();
  await assert.rejects(h.drive.scopedReference("Outside_file_123", signal()));
  await assert.rejects(h.drive.scopedReference("Shortcut_file_123", signal()));
  await h.drive.scopedReference(future, signal());
  await assert.rejects(h.drive.catalogPage({ id: "Outside_root_123", path: "", depth: 1, ancestors: [FUTURE_ORDERS_DRIVE_ROOT] }, signal()));
});
test("the selected root stays pinned, including when a file moves to the other approved root", async () => {
  const h = fixture(); await h.drive.scopedReference(futureFile, signal());
  await assert.rejects(h.drive.scopedReference(archivedFile, signal()));
  h.moveDuringDownload(() => { h.records[future].parents = [SHIPMENT_DRIVE_ROOT]; });
  await assert.rejects(h.drive.download(futureFile, signal()));
  assert.equal(h.calls.filter(url => url.includes("alt=media")).length, 1);
});
test("moving a folder outside approved roots or revoking parent access fails closed", async () => {
  for (const change of ["move", "revoke", "trash"]) {
    const h = fixture(); await h.drive.scopedReference(future, signal());
    if (change === "move") h.records[future].parents = ["Outside_root_123"];
    else if (change === "revoke") delete h.records[FUTURE_ORDERS_DRIVE_ROOT];
    else h.records[FUTURE_ORDERS_DRIVE_ROOT].trashed = true;
    await assert.rejects(scanFolder(h.drive, future, signal()));
  }
});
test("list and download cannot run before a successful live root check", async () => {
  const h = fixture();
  await assert.rejects(h.drive.catalogPage({ id: future, path: "", depth: 1, ancestors: [FUTURE_ORDERS_DRIVE_ROOT] }, signal()));
  await assert.rejects(h.drive.download(futureFile, signal()));
  assert.equal(h.calls.length, 0);
});
test("cancellation and transport errors do not trigger another root attempt", async () => {
  const h = fixture(); await assert.rejects(h.drive.scopedReference(future, AbortSignal.abort()));
  assert.equal(h.calls.length, 0);
  let attempts = 0;
  const failing = new ShipmentDriveReadonly(async () => "synthetic", async () => { attempts++; throw new TypeError("transport failed"); });
  await assert.rejects(failing.scopedReference(future, signal()), TypeError);
  assert.equal(attempts, 1);
});
test("both source roots are excluded as shipment folders; assistant archive is not widened", async () => {
  assert.equal(isShipmentDriveRoot(SHIPMENT_DRIVE_ROOT), true);
  assert.equal(isShipmentDriveRoot(FUTURE_ORDERS_DRIVE_ROOT), true);
  assert.equal(isShipmentDriveRoot(future), false);
  const h = fixture(); const archive = new DriveReadonly(async () => "synthetic", h.fetcher);
  await assert.rejects(archive.scopedReference(futureFile, signal()));
  assert.equal(DRIVE_ROOT, "1VRUVM95YlgH4hyzILnC56mq_2Dpw5adm");
});
