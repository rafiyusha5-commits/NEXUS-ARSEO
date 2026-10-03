import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UploadedFile } from "../../src/lib/documents/operations.ts";
import {
  type TemplateGateway,
  type TemplatePermissions,
  addTemplateVersion,
  createTemplateDownloadUrl,
  registerTemplateWithFile,
} from "../../src/lib/templates/operations.ts";
import {
  availableTemplateActions,
  buildTemplateStoragePath,
  editResetsApproval,
  isTemplateStoragePath,
  parseTemplateVariables,
  schemaToVariables,
  variablesToText,
} from "../../src/lib/templates/rules.ts";

const TEMPLATE_ID = "a1000000-0000-4000-8000-000000000001";
const TYPE_ID = "70000000-0000-4000-8000-000000000001";
const HEX = "0123456789abcdef0123456789abcdef";
const HASH = "1".repeat(64);

describe("template fields for substitution", () => {
  it("parses one field per line with optional labels", () => {
    const result = parseTemplateVariables("product_name — Наименование\ngtin: GTIN\n\nshelf_life");
    assert.deepEqual(result, {
      ok: true,
      variables: [
        { key: "product_name", label: "Наименование" },
        { key: "gtin", label: "GTIN" },
        { key: "shelf_life", label: "shelf_life" },
      ],
    });
  });

  it("rejects invalid or repeated keys", () => {
    assert.equal(parseTemplateVariables("Название товара").ok, false, "keys are Latin identifiers");
    assert.equal(parseTemplateVariables("1abc").ok, false);
    assert.equal(parseTemplateVariables("gtin\nGTIN").ok, false, "keys are case-insensitive");
  });

  it("round-trips through the stored schema", () => {
    const parsed = parseTemplateVariables("product_name — Наименование\ngtin");
    assert.ok(parsed.ok);
    if (parsed.ok) {
      const restored = schemaToVariables({ fields: parsed.variables });
      assert.equal(variablesToText(restored), "product_name — Наименование\ngtin");
    }
    assert.deepEqual(schemaToVariables(null), []);
    assert.deepEqual(schemaToVariables({ fields: "bad" }), []);
  });
});

describe("template approval rules", () => {
  const base = { document_type_id: TYPE_ID, language: "ru", flow_direction: "input", counterparty_id: null, variables: [{ key: "gtin", label: "GTIN" }] };

  it("keeps the approval for cosmetic changes and drops it for substantive ones", () => {
    assert.equal(editResetsApproval("approved", base, { ...base }), false);
    assert.equal(editResetsApproval("approved", base, { ...base, language: "kk" }), true);
    assert.equal(editResetsApproval("approved", base, { ...base, flow_direction: "output" }), true);
    assert.equal(editResetsApproval("approved", base, { ...base, variables: [] }), true);
    assert.equal(editResetsApproval("draft", base, { ...base, language: "kk" }), false, "drafts have no approval to lose");
  });

  it("offers approval only for a draft with a file", () => {
    const can = { update: true, upload: true, approve: true, change_status: true, archive: true, export: true };
    assert.ok(availableTemplateActions({ status: "draft", is_active: true, current_version: 1 }, can).includes("approve"));
    assert.ok(!availableTemplateActions({ status: "approved", is_active: true, current_version: 1 }, can).includes("approve"));
    assert.ok(!availableTemplateActions({ status: "draft", is_active: true, current_version: 0 }, can).includes("approve"));
    assert.deepEqual(availableTemplateActions({ status: "archived", is_active: false, current_version: 2 }, can), ["download"]);
  });
});

describe("template storage path", () => {
  it("is built from the template id and a random part, under templates/", () => {
    const path = buildTemplateStoragePath(TEMPLATE_ID, "Карта ввода.docx", HEX);
    assert.equal(path, `templates/${TEMPLATE_ID}/${HEX}-Karta-vvoda.docx`);
    assert.equal(isTemplateStoragePath(path, TEMPLATE_ID), true);
  });

  it("cannot point to documents or other templates", () => {
    assert.throws(() => buildTemplateStoragePath("../documents", "a.docx", HEX));
    assert.equal(isTemplateStoragePath(`documents/${TEMPLATE_ID}/${HEX}-a.docx`), false);
    assert.equal(isTemplateStoragePath(`templates/${TEMPLATE_ID}/${HEX}-a.docx`, "a1000000-0000-4000-8000-000000000002"), false);
  });
});

function fakeGateway(options: { can?: Partial<TemplatePermissions>; state?: { archived: boolean; checksums: string[] } | null; registerError?: string } = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const can: TemplatePermissions = {
    view: true, create: true, update: true, upload: true, archive: true, approve: true, change_status: true, export: true, generate: true, generate_prices: true, ...options.can,
  };
  const gateway: TemplateGateway = {
    async permissions() { return can; },
    async getTemplateState() { return options.state === undefined ? { archived: false, checksums: [] } : options.state; },
    async uploadFile(...args) { calls.push({ name: "uploadFile", args }); return null; },
    async removeFile(...args) { calls.push({ name: "removeFile", args }); },
    async registerTemplate(...args) { calls.push({ name: "registerTemplate", args }); return options.registerError ?? null; },
    async insertVersion(...args) { calls.push({ name: "insertVersion", args }); return null; },
    async getVersionFile() { return { path: `templates/${TEMPLATE_ID}/${HEX}-a.docx`, filename: "Карта.docx", versionNumber: 3 }; },
    async createSignedUrl(...args) { calls.push({ name: "createSignedUrl", args }); return "https://storage.example/signed"; },
    async recordDownload(...args) { calls.push({ name: "recordDownload", args }); },
  };
  return { gateway, called: (name: string) => calls.filter((call) => call.name === name) };
}

const deps = { newId: () => TEMPLATE_ID, randomHex: () => HEX, sha256Hex: async () => HASH };
const docx = (name = "Карта ввода.docx"): UploadedFile => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
  return { name, size: bytes.byteLength, type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: async () => bytes };
};
const metadata = { document_type_id: TYPE_ID, name: " Карта ввода сети ", language: "ru", flow_direction: "input", purpose: null, counterparty_id: null, variables: [{ key: "gtin", label: "GTIN" }] };

describe("template operations", () => {
  it("registers a template with a server-built path and the parsed fields", async () => {
    const fake = fakeGateway();
    const result = await registerTemplateWithFile(fake.gateway, deps, metadata, docx());
    assert.deepEqual(result, { ok: true, value: TEMPLATE_ID });
    const input = fake.called("registerTemplate")[0].args[0] as Record<string, unknown>;
    assert.equal(input.storage_path, `templates/${TEMPLATE_ID}/${HEX}-Karta-vvoda.docx`);
    assert.equal(input.name, "Карта ввода сети");
    assert.equal(input.flow_direction, "input");
    assert.deepEqual(input.variables_schema, { fields: [{ key: "gtin", label: "GTIN" }] });
  });

  it("refuses without templates.create, before uploading", async () => {
    const fake = fakeGateway({ can: { create: false } });
    const result = await registerTemplateWithFile(fake.gateway, deps, metadata, docx());
    assert.equal(result.ok, false);
    assert.equal(fake.called("uploadFile").length, 0);
  });

  it("removes the uploaded file when the database rejects the template", async () => {
    const fake = fakeGateway({ registerError: "duplicate key value violates unique constraint" });
    const result = await registerTemplateWithFile(fake.gateway, deps, metadata, docx());
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "Шаблон не создан. Повторите попытку");
    assert.equal(fake.called("removeFile").length, 1);
  });

  it("uploads a new version only with templates.upload, for an active template, once per file", async () => {
    assert.equal((await addTemplateVersion(fakeGateway({ can: { upload: false } }).gateway, deps, TEMPLATE_ID, docx(), null)).ok, false);
    assert.equal((await addTemplateVersion(fakeGateway({ state: { archived: true, checksums: [] } }).gateway, deps, TEMPLATE_ID, docx(), null)).ok, false);
    assert.equal((await addTemplateVersion(fakeGateway({ state: { archived: false, checksums: [HASH] } }).gateway, deps, TEMPLATE_ID, docx(), null)).ok, false);
    const fake = fakeGateway();
    const result = await addTemplateVersion(fake.gateway, deps, TEMPLATE_ID, docx("v2.docx"), " Новые поля ");
    assert.equal(result.ok, true);
    const input = fake.called("insertVersion")[0].args[0] as Record<string, unknown>;
    assert.equal(input.comment, "Новые поля");
  });

  it("downloads through a short-lived signed URL and records it, only with templates.export", async () => {
    const denied = fakeGateway({ can: { export: false } });
    assert.equal((await createTemplateDownloadUrl(denied.gateway, TEMPLATE_ID, null)).ok, false);
    assert.equal(denied.called("createSignedUrl").length, 0);

    const fake = fakeGateway();
    const result = await createTemplateDownloadUrl(fake.gateway, TEMPLATE_ID, null);
    assert.equal(result.ok, true);
    assert.ok((fake.called("createSignedUrl")[0].args[1] as number) <= 300);
    assert.deepEqual(fake.called("recordDownload")[0].args, [TEMPLATE_ID, 3]);
  });
});
