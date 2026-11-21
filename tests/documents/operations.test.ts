import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  type DocumentGateway,
  type DocumentPermissions,
  type OperationDeps,
  type UploadedFile,
  STORAGE_NOT_CONFIGURED_MESSAGE,
  addDocumentVersion,
  archiveDocument,
  createDocumentDownloadUrl,
  registerDocumentWithFile,
} from "../../src/lib/documents/operations.ts";
import type { DocumentMetadata } from "../../src/lib/documents/rules.ts";

const TYPE_ID = "7d4e2f10-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const DOC_ID = "3f1c2a9e-4b7d-4c1e-9a2b-5d6e7f8a9b0c";
const SHIPMENT_ID = "c0000000-0000-4000-8000-000000000001";
const HEX = "0123456789abcdef0123456789abcdef";
const FILE_HASH = "1".repeat(64);

const allow = (overrides: Partial<DocumentPermissions> = {}): DocumentPermissions => ({
  view: true, create: true, update: true, approve: true, archive: true, manage_types: false, manage_requirements: false, share_external: false, ...overrides,
});

type Call = { name: string; args: unknown[] };

function fakeGateway(options: {
  permissions?: DocumentPermissions;
  document?: { archived: boolean; checksums: string[] } | null;
  existingChecksum?: string;
  duplicateCheckFails?: boolean;
  uploadFailure?: { message: string; statusCode?: string | number };
  registerError?: string;
  insertError?: string;
  archiveError?: string;
} = {}) {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]) => calls.push({ name, args });
  const gateway: DocumentGateway = {
    async permissions() { record("permissions"); return options.permissions ?? allow(); },
    async findDocumentWithChecksum(checksum) {
      record("findDocumentWithChecksum", checksum);
      if (options.duplicateCheckFails) throw new Error("DUPLICATE_CHECK_FAILED");
      return checksum === options.existingChecksum ? { id: DOC_ID, title: "Инвойс INV-1" } : null;
    },
    async getDocumentState(id) {
      record("getDocumentState", id);
      return options.document === undefined ? { archived: false, checksums: [] } : options.document;
    },
    async uploadFile(path, bytes, contentType) { record("uploadFile", path, bytes, contentType); return options.uploadFailure ?? null; },
    async removeFile(path) { record("removeFile", path); },
    async registerDocument(input) { record("registerDocument", input); return options.registerError ?? null; },
    async insertVersion(input) { record("insertVersion", input); return options.insertError ?? null; },
    async archiveDocument(id, reason) { record("archiveDocument", id, reason); return options.archiveError ?? null; },
    async getVersionFile(id, versionId) {
      record("getVersionFile", id, versionId);
      return { path: `documents/${id}/${HEX}-a.pdf`, filename: "Инвойс.pdf", versionNumber: 2 };
    },
    async createSignedUrl(path, ttl, name) { record("createSignedUrl", path, ttl, name); return "https://storage.example/signed?token=t"; },
    async recordDownload(id, version) { record("recordDownload", id, version); },
  };
  const called = (name: string) => calls.filter((call) => call.name === name);
  return { gateway, calls, called };
}

const deps: OperationDeps = {
  newDocumentId: () => DOC_ID,
  randomHex: () => HEX,
  sha256Hex: async () => FILE_HASH,
};

const pdfFile = (name = "Инвойс 1.pdf", content = "%PDF-1.7 test"): UploadedFile => {
  const data = new TextEncoder().encode(content);
  return { name, size: data.byteLength, type: "application/pdf", bytes: async () => data };
};

const metadata = (overrides: Partial<DocumentMetadata> = {}): DocumentMetadata => ({
  document_type_id: TYPE_ID,
  title: "  Инвойс поставщика  ",
  document_number: "INV-1",
  description: null,
  document_date: "2026-09-01",
  valid_until: null,
  language: "ru",
  currency_id: null,
  amount: null,
  ...overrides,
});

const shipmentLink = [{ entity_type: "shipment" as const, entity_id: SHIPMENT_ID, link_role: "primary" as const }];

describe("registering a document", () => {
  let fake: ReturnType<typeof fakeGateway>;
  beforeEach(() => { fake = fakeGateway(); });

  it("uploads to a server-built path and registers the document with its links", async () => {
    const result = await registerDocumentWithFile(fake.gateway, deps, metadata(), shipmentLink, pdfFile());
    assert.deepEqual(result, { ok: true, value: DOC_ID });
    const [upload] = fake.called("uploadFile");
    assert.equal(upload.args[0], `documents/${DOC_ID}/${HEX}-Invoys-1.pdf`);
    assert.equal(upload.args[2], "application/pdf");
    const [register] = fake.called("registerDocument");
    const input = register.args[0] as Record<string, unknown>;
    assert.equal(input.storage_path, upload.args[0], "the database receives exactly the uploaded path");
    assert.equal(input.original_filename, "Инвойс 1.pdf", "original name is kept for display");
    assert.equal(input.title, "Инвойс поставщика");
    assert.deepEqual(input.links, shipmentLink);
  });

  it("does nothing without documents.create", async () => {
    const denied = fakeGateway({ permissions: allow({ create: false }) });
    const result = await registerDocumentWithFile(denied.gateway, deps, metadata(), [], pdfFile());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "forbidden");
    assert.equal(denied.called("uploadFile").length, 0);
    assert.equal(denied.called("registerDocument").length, 0);
  });

  it("rejects a disallowed or disguised file before uploading", async () => {
    const exe = await registerDocumentWithFile(fake.gateway, deps, metadata(), [], pdfFile("tool.exe", "MZ"));
    const fakePdf = await registerDocumentWithFile(fake.gateway, deps, metadata(), [], pdfFile("scan.pdf", "not a pdf"));
    assert.equal(exe.ok, false);
    assert.equal(fakePdf.ok, false);
    assert.equal(fake.called("uploadFile").length, 0);
  });

  it("rejects invalid metadata before uploading", async () => {
    const noTitle = await registerDocumentWithFile(fake.gateway, deps, metadata({ title: "   " }), [], pdfFile());
    const amountWithoutCurrency = await registerDocumentWithFile(fake.gateway, deps, metadata({ amount: 100 }), [], pdfFile());
    const expiresBeforeIssue = await registerDocumentWithFile(
      fake.gateway, deps, metadata({ document_date: "2026-09-10", valid_until: "2026-09-01" }), [], pdfFile(),
    );
    const badLink = await registerDocumentWithFile(
      fake.gateway, deps, metadata(), [{ entity_type: "batch" as never, entity_id: SHIPMENT_ID, link_role: "related" }], pdfFile(),
    );
    for (const result of [noTitle, amountWithoutCurrency, expiresBeforeIssue, badLink]) {
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, "invalid");
    }
    assert.equal(fake.called("uploadFile").length, 0);
  });

  it("refuses a file that is already registered and points to the existing document", async () => {
    const duplicate = fakeGateway({ existingChecksum: FILE_HASH });
    const result = await registerDocumentWithFile(duplicate.gateway, deps, metadata(), [], pdfFile());
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "duplicate");
      assert.match(result.error, /INV-1/);
    }
    assert.equal(duplicate.called("uploadFile").length, 0);
  });

  it("stops instead of registering a possible duplicate when the duplicate check fails", async () => {
    const broken = fakeGateway({ duplicateCheckFails: true });
    const result = await registerDocumentWithFile(broken.gateway, deps, metadata(), [], pdfFile());
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "failed");
      assert.match(result.error, /загружался ли этот файл раньше/);
    }
    assert.equal(broken.called("uploadFile").length, 0);
    assert.equal(broken.called("registerDocument").length, 0);
  });

  it("explains a missing bucket to the administrator and does not register", async () => {
    const missing = fakeGateway({ uploadFailure: { message: "Bucket not found", statusCode: "404" } });
    const result = await registerDocumentWithFile(missing.gateway, deps, metadata(), [], pdfFile());
    assert.deepEqual(result, { ok: false, code: "storage_unavailable", error: STORAGE_NOT_CONFIGURED_MESSAGE });
    assert.equal(missing.called("registerDocument").length, 0);
  });

  it("removes the uploaded file when the database rejects the registration", async () => {
    const rejected = fakeGateway({ registerError: "Связанный объект не найден или недоступен" });
    const result = await registerDocumentWithFile(rejected.gateway, deps, metadata(), shipmentLink, pdfFile());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "Документ не зарегистрирован. Повторите попытку");
    const [upload] = rejected.called("uploadFile");
    const [removal] = rejected.called("removeFile");
    assert.equal(removal?.args[0], upload.args[0]);
  });
});

describe("adding a version", () => {
  it("uploads into the same document folder and stores the comment", async () => {
    const fake = fakeGateway({ document: { archived: false, checksums: ["9".repeat(64)] } });
    const result = await addDocumentVersion(fake.gateway, deps, DOC_ID, pdfFile("v2.pdf"), " Исправлена сумма ");
    assert.equal(result.ok, true);
    const [insert] = fake.called("insertVersion");
    const input = insert.args[0] as Record<string, unknown>;
    assert.equal(input.document_id, DOC_ID);
    assert.match(String(input.storage_path), new RegExp(`^documents/${DOC_ID}/`));
    assert.equal(input.comment, "Исправлена сумма");
  });

  it("requires documents.update", async () => {
    const fake = fakeGateway({ permissions: allow({ update: false }) });
    const result = await addDocumentVersion(fake.gateway, deps, DOC_ID, pdfFile(), null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "forbidden");
    assert.equal(fake.called("uploadFile").length, 0);
  });

  it("refuses new versions of an archived document", async () => {
    const fake = fakeGateway({ document: { archived: true, checksums: [] } });
    const result = await addDocumentVersion(fake.gateway, deps, DOC_ID, pdfFile(), null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "archived");
    assert.equal(fake.called("uploadFile").length, 0);
  });

  it("refuses to add the same file twice", async () => {
    const fake = fakeGateway({ document: { archived: false, checksums: [FILE_HASH] } });
    const result = await addDocumentVersion(fake.gateway, deps, DOC_ID, pdfFile(), null);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "duplicate");
  });

  it("reports a missing document and removes the file when saving fails", async () => {
    const missing = fakeGateway({ document: null });
    const notFound = await addDocumentVersion(missing.gateway, deps, DOC_ID, pdfFile(), null);
    assert.equal(notFound.ok, false);

    const failing = fakeGateway({ insertError: "Документ в архиве: новые версии запрещены" });
    const result = await addDocumentVersion(failing.gateway, deps, DOC_ID, pdfFile(), null);
    assert.equal(result.ok, false);
    assert.equal(failing.called("removeFile").length, 1);
  });
});

describe("archiving", () => {
  it("requires documents.archive", async () => {
    const fake = fakeGateway({ permissions: allow({ archive: false }) });
    const result = await archiveDocument(fake.gateway, DOC_ID, "Дубликат");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "forbidden");
    assert.equal(fake.called("archiveDocument").length, 0);
  });

  it("requires a reason", async () => {
    const fake = fakeGateway();
    const result = await archiveDocument(fake.gateway, DOC_ID, "  ");
    assert.equal(result.ok, false);
    assert.equal(fake.called("archiveDocument").length, 0);
  });

  it("archives with the trimmed reason and never deletes", async () => {
    const fake = fakeGateway();
    const result = await archiveDocument(fake.gateway, DOC_ID, "  Заменён новым  ");
    assert.equal(result.ok, true);
    assert.deepEqual(fake.called("archiveDocument")[0].args, [DOC_ID, "Заменён новым"]);
    assert.equal(fake.called("removeFile").length, 0);
  });

  it("does not expose database errors to the user", async () => {
    const fake = fakeGateway({ archiveError: "Документ не найден или уже находится в архиве" });
    const result = await archiveDocument(fake.gateway, DOC_ID, "Повторно");
    assert.deepEqual(result, { ok: false, code: "failed", error: "Документ не перенесён в архив. Повторите попытку" });
  });
});

describe("downloading", () => {
  it("issues a short-lived signed URL and records the download", async () => {
    const fake = fakeGateway();
    const result = await createDocumentDownloadUrl(fake.gateway, DOC_ID, null);
    assert.equal(result.ok, true);
    const [signed] = fake.called("createSignedUrl");
    assert.ok((signed.args[1] as number) <= 300, "signed URL must be short-lived");
    assert.equal(signed.args[2], "Инвойс.pdf");
    assert.deepEqual(fake.called("recordDownload")[0].args, [DOC_ID, 2]);
  });

  it("requires documents.view and valid identifiers", async () => {
    const denied = fakeGateway({ permissions: allow({ view: false }) });
    const result = await createDocumentDownloadUrl(denied.gateway, DOC_ID, null);
    assert.equal(result.ok, false);
    assert.equal(denied.called("createSignedUrl").length, 0);

    const fake = fakeGateway();
    const invalid = await createDocumentDownloadUrl(fake.gateway, "../etc", null);
    assert.equal(invalid.ok, false);
    assert.equal(fake.called("getVersionFile").length, 0);
  });
});
