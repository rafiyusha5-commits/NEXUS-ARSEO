import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_DOCUMENT_FILE_SIZE_BYTES,
  buildDocumentStoragePath,
  checkDocumentFile,
  isDocumentStoragePath,
  matchesFileSignature,
  normalizeFileName,
} from "../../src/lib/documents/files.ts";

const DOC_ID = "3f1c2a9e-4b7d-4c1e-9a2b-5d6e7f8a9b0c";
const HEX = "0123456789abcdef0123456789abcdef";
const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

describe("allowed file types", () => {
  it("accepts every business format with its canonical MIME type", () => {
    const cases: Array<[string, string, string]> = [
      ["invoice.pdf", "application/pdf", "application/pdf"],
      ["packing.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["old.xls", "application/vnd.ms-excel", "application/vnd.ms-excel"],
      ["stock.csv", "text/csv", "text/csv"],
      ["letter.docx", "", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["photo.JPG", "image/jpeg", "image/jpeg"],
      ["photo.jpeg", "image/jpeg", "image/jpeg"],
      ["scan.png", "image/png", "image/png"],
    ];
    for (const [name, reported, canonical] of cases) {
      const result = checkDocumentFile({ name, size: 10, type: reported });
      assert.equal(result.ok, true, name);
      if (result.ok) assert.equal(result.mimeType, canonical, name);
    }
  });

  it("accepts CSV reported by Windows browsers as Excel", () => {
    assert.equal(checkDocumentFile({ name: "rows.csv", size: 5, type: "application/vnd.ms-excel" }).ok, true);
  });

  it("rejects executable, markup and archive formats", () => {
    for (const name of ["setup.exe", "page.html", "image.svg", "archive.zip", "macro.xlsm", "script.js", "noextension"]) {
      assert.equal(checkDocumentFile({ name, size: 10, type: "" }).ok, false, name);
    }
  });

  it("uses the last extension, so a disguised executable is rejected", () => {
    assert.equal(checkDocumentFile({ name: "invoice.pdf.exe", size: 10, type: "" }).ok, false);
  });

  it("rejects a browser type that contradicts the extension", () => {
    const result = checkDocumentFile({ name: "invoice.pdf", size: 10, type: "text/html" });
    assert.equal(result.ok, false);
  });

  it("checks real file content, not only the name", () => {
    const pdf = text("%PDF-1.7\n");
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0);
    const zip = bytes(0x50, 0x4b, 0x03, 0x04, 0x14);
    assert.equal(matchesFileSignature("pdf", pdf), true);
    assert.equal(matchesFileSignature("pdf", png), false, "PNG renamed to .pdf");
    assert.equal(matchesFileSignature("png", png), true);
    assert.equal(matchesFileSignature("xlsx", zip), true);
    assert.equal(matchesFileSignature("docx", pdf), false);
    assert.equal(matchesFileSignature("jpg", bytes(0xff, 0xd8, 0xff, 0xe0)), true);
    assert.equal(matchesFileSignature("xls", bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)), true);
    assert.equal(matchesFileSignature("csv", text("sku;qty\nA-1;10\n")), true);
    assert.equal(matchesFileSignature("csv", bytes(0x4d, 0x5a, 0x00, 0x90)), false, "binary data renamed to .csv");
    assert.equal(matchesFileSignature("exe", pdf), false);
  });
});

describe("file size", () => {
  it("rejects empty files", () => {
    assert.equal(checkDocumentFile({ name: "a.pdf", size: 0, type: "application/pdf" }).ok, false);
  });

  it("accepts a file of exactly the maximum size", () => {
    assert.equal(checkDocumentFile({ name: "a.pdf", size: MAX_DOCUMENT_FILE_SIZE_BYTES, type: "application/pdf" }).ok, true);
  });

  it("rejects a file one byte over the maximum", () => {
    const result = checkDocumentFile({ name: "a.pdf", size: MAX_DOCUMENT_FILE_SIZE_BYTES + 1, type: "application/pdf" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /4 МБ/);
  });

  it("keeps the limit below the Vercel request body limit", () => {
    assert.ok(MAX_DOCUMENT_FILE_SIZE_BYTES <= 4.5 * 1000 * 1000);
  });
});

describe("file name normalization", () => {
  it("transliterates Russian and Kazakh names and keeps the extension", () => {
    assert.equal(normalizeFileName("Инвойс №15 от 01.09.pdf"), "Invoys-No15-ot-01.09.pdf");
    assert.equal(normalizeFileName("Қазақша құжат.DOCX"), "Qazaqsha-quzhat.docx");
  });

  it("drops directories, so traversal sequences cannot reach the path", () => {
    for (const name of ["../../etc/passwd.pdf", "..\\..\\windows\\win.ini.pdf", "/abs/path/file.pdf"]) {
      const result = normalizeFileName(name);
      assert.doesNotMatch(result, /[\\/]/, name);
      assert.doesNotMatch(result, /\.\./, name);
    }
  });

  it("never starts with a dot and collapses separators", () => {
    assert.equal(normalizeFileName(".hidden..file.pdf"), "hidden-file.pdf");
  });

  it("falls back to a neutral name when nothing usable remains", () => {
    assert.equal(normalizeFileName("????.pdf"), "document.pdf");
    assert.equal(normalizeFileName(""), "document");
  });

  it("limits the length", () => {
    const result = normalizeFileName(`${"a".repeat(500)}.xlsx`);
    assert.ok(result.length <= 120);
    assert.ok(result.endsWith(".xlsx"));
  });
});

describe("storage path", () => {
  it("builds the path from the document id, a random part and the safe name", () => {
    const path = buildDocumentStoragePath(DOC_ID, "invoice.pdf", HEX);
    assert.equal(path, `documents/${DOC_ID}/${HEX}-invoice.pdf`);
    assert.equal(isDocumentStoragePath(path, DOC_ID), true);
  });

  it("refuses unsafe inputs instead of building a path", () => {
    assert.throws(() => buildDocumentStoragePath("../other", "a.pdf", HEX));
    assert.throws(() => buildDocumentStoragePath(DOC_ID, "../a.pdf", HEX));
    assert.throws(() => buildDocumentStoragePath(DOC_ID, "a.pdf", "not-random"));
  });

  it("rejects paths of other documents or outside the documents folder", () => {
    const other = "11111111-2222-4333-8444-555555555555";
    assert.equal(isDocumentStoragePath(`documents/${other}/${HEX}-a.pdf`, DOC_ID), false);
    assert.equal(isDocumentStoragePath(`public/${DOC_ID}/${HEX}-a.pdf`), false);
    assert.equal(isDocumentStoragePath(`documents/${DOC_ID}/${HEX}-../../a.pdf`), false);
    assert.equal(isDocumentStoragePath(`documents/${DOC_ID}/a.pdf`), false);
  });
});
