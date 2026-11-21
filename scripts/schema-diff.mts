/**
 * Compares two schema fingerprints made by supabase/tools/schema-fingerprint.sql (audit 2026-11-11, K3): for example a
 * production database against a reference built by scripts/schema-reference.sh (every migration once, in order).
 * Prints object names only, never definitions or data.
 *
 *   node --disable-warning=ExperimentalWarning scripts/schema-diff.mts <reference.tsv> <actual.tsv>
 *
 * Exit code 0 when nothing differs except whitespace, 1 when objects differ, 2 on a malformed file.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Per object: the hash of its definition and the hash with all whitespace removed. */
export type Fingerprint = Map<string, { exact: string; loose: string }>;
/** whitespace: only spaces and line breaks differ (a definition applied from a differently formatted file). */
export type SchemaDiff = { missing: string[]; extra: string[]; changed: string[]; whitespace: string[] };

const LINE = /^([a-z]+)\t([^\t]+)\t([0-9a-f]{32})(?:\t([0-9a-f]{32}))?$/;

/** Reads "kind<TAB>name<TAB>md5[<TAB>md5]" lines; the key is "kind name". Blank lines are skipped, others refused. */
export function parseFingerprint(text: string): Fingerprint {
  const result: Fingerprint = new Map();
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim() || line === "BEGIN" || line === "ROLLBACK") return;
    const match = LINE.exec(line);
    if (!match) throw new Error(`Строка ${index + 1}: не похожа на строку снимка схемы`);
    const key = `${match[1]} ${match[2]}`;
    if (result.has(key)) throw new Error(`Строка ${index + 1}: объект ${key} повторяется`);
    result.set(key, { exact: match[3], loose: match[4] ?? match[3] });
  });
  if (!result.size) throw new Error("Снимок схемы пуст");
  return result;
}

/** What the actual schema lacks, has in addition, or has with another definition, compared with the reference. */
export function diffFingerprints(reference: Fingerprint, actual: Fingerprint): SchemaDiff {
  const missing: string[] = [], extra: string[] = [], changed: string[] = [], whitespace: string[] = [];
  for (const [key, hash] of reference) {
    const other = actual.get(key);
    if (!other) missing.push(key);
    else if (other.exact === hash.exact) continue;
    else if (other.loose === hash.loose) whitespace.push(key);
    else changed.push(key);
  }
  for (const key of actual.keys()) if (!reference.has(key)) extra.push(key);
  const order = (a: string, b: string) => a.localeCompare(b, "en");
  return { missing: missing.sort(order), extra: extra.sort(order), changed: changed.sort(order), whitespace: whitespace.sort(order) };
}

export const differs = (diff: SchemaDiff) => diff.missing.length + diff.extra.length + diff.changed.length > 0;

export function formatDiff(diff: SchemaDiff, total: number): string[] {
  const lines: string[] = [];
  const section = (title: string, items: string[]) => {
    if (!items.length) return;
    lines.push(`${title}: ${items.length}`);
    for (const item of items) lines.push(`  ${item}`);
  };
  section("Нет в проверяемой базе (есть в эталоне)", diff.missing);
  section("Лишнее в проверяемой базе (нет в эталоне)", diff.extra);
  section("Отличается определение", diff.changed);
  section("Отличаются только пробелы и переносы строк (на работу не влияет)", diff.whitespace);
  lines.push(differs(diff) ? `Схемы различаются. Объектов в эталоне: ${total}.` : `Схемы совпадают. Объектов: ${total}.`);
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [referencePath, actualPath] = process.argv.slice(2);
  if (!referencePath || !actualPath) {
    console.error("Использование: scripts/schema-diff.mts <эталон.tsv> <проверяемая.tsv>");
    process.exit(2);
  }
  try {
    const reference = parseFingerprint(readFileSync(referencePath, "utf8"));
    const diff = diffFingerprints(reference, parseFingerprint(readFileSync(actualPath, "utf8")));
    for (const line of formatDiff(diff, reference.size)) console.log(line);
    process.exit(differs(diff) ? 1 : 0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
