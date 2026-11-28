import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { PDFDocument } from "pdf-lib";
import { renderLabelsPdf } from "../../src/lib/scan/labels-pdf.ts";
import { scanHref } from "../../src/lib/scan/href.ts";

const fonts = async () => ({ regular: new Uint8Array(await readFile("public/fonts/ubuntu-regular.ttf")), bold: new Uint8Array(await readFile("public/fonts/ubuntu-bold.ttf")) });
const label = (n: number) => ({ code: `NX-0000000${n % 10}`, title: `A-0${n}`, subtitle: "Алматы · storage" });

describe("labels PDF", () => {
  it("A4: 24 labels a sheet; thermal: one label a page; copies repeat each label", async () => {
    const a4 = await PDFDocument.load(await renderLabelsPdf(Array.from({ length: 13 }, (_, i) => label(i)), "a4", 2, await fonts()));
    assert.equal(a4.getPageCount(), 2, "26 labels: two sheets");
    assert.equal(Math.round(a4.getPage(0).getWidth()), 595);
    const thermal = await PDFDocument.load(await renderLabelsPdf([label(1), label(2)], "thermal", 3, await fonts()));
    assert.equal(thermal.getPageCount(), 6);
    assert.equal(Math.round(thermal.getPage(0).getWidth() / 72 * 25.4), 58);
  });
});

describe("scan address", () => {
  it("passes a GS1 code as its parts, a plain code as it is, a broken GS1 code with its error", () => {
    assert.equal(scanHref("(01)04601234567893(10)LOT-77(17)270531(37)24", "camera"),
      "/m/scan?via=camera&code=04601234567893&batch=LOT-77&expiry=2027-05-31&qty=24");
    assert.equal(scanHref(" NX-7KQ2M9TA ", "scanner"), "/m/scan?via=scanner&code=NX-7KQ2M9TA");
    assert.equal(scanHref("(01)04601234567890", "manual"), "/m/scan?via=manual&code=%2801%2904601234567890&gs1_error=bad_gtin");
  });
});
