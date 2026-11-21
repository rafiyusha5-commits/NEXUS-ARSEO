import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { differs, diffFingerprints, formatDiff, parseFingerprint } from "../../scripts/schema-diff.mts";

const hash = (char: string) => char.repeat(32);
const reference = parseFingerprint([
  `function\tpublic.a(uuid)\t${hash("a")}\t${hash("1")}`,
  `table\tpublic.t\t${hash("b")}\t${hash("2")}`,
  `policy\tpublic.t.read\t${hash("c")}\t${hash("3")}`,
  `function\tpublic.f()\t${hash("e")}\t${hash("5")}`,
].join("\n"));

describe("schema fingerprint comparison (K3)", () => {
  it("reads psql output with one or two hashes and skips the transaction lines", () => {
    const parsed = parseFingerprint(`BEGIN\r\ntable\tpublic.t\t${hash("b")}\r\n\r\nROLLBACK\r\n`);
    assert.deepEqual([...parsed], [["table public.t", { exact: hash("b"), loose: hash("b") }]]);
    assert.deepEqual(reference.get("table public.t"), { exact: hash("b"), loose: hash("2") });
  });

  it("refuses malformed, repeated or empty fingerprints", () => {
    assert.throws(() => parseFingerprint("table public.t"), /Строка 1/);
    assert.throws(() => parseFingerprint(`table\tpublic.t\t${hash("b")}\ntable\tpublic.t\t${hash("c")}`), /повторяется/);
    assert.throws(() => parseFingerprint("\n"), /пуст/);
  });

  it("finds nothing when both describe the same schema", () => {
    const diff = diffFingerprints(reference, new Map(reference));
    assert.ok(!differs(diff));
    assert.equal(formatDiff(diff, reference.size).at(-1), "Схемы совпадают. Объектов: 4.");
  });

  it("names missing, extra and changed objects, and keeps whitespace-only differences apart, without hashes", () => {
    const actual = new Map(reference);
    actual.delete("policy public.t.read");
    actual.set("function public.a(uuid)", { exact: hash("d"), loose: hash("9") });
    actual.set("function public.f()", { exact: hash("f"), loose: hash("5") });
    actual.set("function public.b()", { exact: hash("e"), loose: hash("e") });
    const diff = diffFingerprints(reference, actual);
    assert.deepEqual(diff, { missing: ["policy public.t.read"], extra: ["function public.b()"],
      changed: ["function public.a(uuid)"], whitespace: ["function public.f()"] });
    assert.ok(differs(diff));
    const text = formatDiff(diff, reference.size).join("\n");
    assert.match(text, /Нет в проверяемой базе \(есть в эталоне\): 1\n  policy public\.t\.read/);
    assert.match(text, /Отличаются только пробелы и переносы строк \(на работу не влияет\): 1\n  function public\.f\(\)/);
    assert.ok(!text.includes(hash("d")), "hashes are not printed");
  });

  it("does not count whitespace-only differences as a different schema", () => {
    const actual = new Map(reference);
    actual.set("function public.f()", { exact: hash("f"), loose: hash("5") });
    assert.ok(!differs(diffFingerprints(reference, actual)));
  });
});
