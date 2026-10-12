// Checks the production dependencies against the advisory database and fails on anything that is not
// explicitly justified. Severity is never used to waive a finding: a moderate advisory is as blocking
// as a high one unless it is listed below with a reason. Run it locally with `pnpm audit:ci`.
import { spawnSync } from "node:child_process";

/**
 * Each entry waives exactly one advisory for one package reached by one dependency path. A new path
 * to the same package is not covered: the justification is about how that caller uses the package.
 * Keep the reasoning in docs/security-audit.md, not only here.
 */
const JUSTIFIED = [
  {
    advisory: "GHSA-w5hq-g745-h8pq",
    module: "uuid",
    paths: [".>exceljs>uuid"],
    reason:
      "Уязвим только путь v3/v5/v6 с аргументом buf. exceljs вызывает uuid лишь в " +
      "lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js и только v4 без buf, на записи расширенного " +
      "условного форматирования; проект использует exceljs на чтение, а книги формирует кодом на " +
      "PizZip и @xmldom/xmldom. Исправление — мажорная 11.x, а exceljs@4.4.0 объявляет ^8.3.0. " +
      "Обоснование и проверки: docs/security-audit.md, раздел «Зависимости».",
  },
];

// Prefer the package manager that started this script (set by `pnpm audit:ci`), then a pnpm on PATH
// (CI enables it with `corepack enable`), then corepack itself.
const commands = [
  ...(process.env.npm_execpath ? [`"${process.execPath}" "${process.env.npm_execpath}" audit --prod --json`] : []),
  "pnpm audit --prod --json",
  "corepack pnpm audit --prod --json",
];

let result;
let output = "";
const attempts = [];
for (const command of commands) {
  result = spawnSync(command, { shell: true, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  output = (result.stdout ?? "").trim();
  if (output.startsWith("{")) break;
  attempts.push(`${command} → код ${result.status}: ${(result.stderr ?? result.error?.message ?? "").trim().split(/\r?\n/)[0] || "нет вывода"}`);
}
if (!output.startsWith("{")) fail(`не удалось получить отчёт pnpm audit.\n  ${attempts.join("\n  ")}`);

let report;
try {
  report = JSON.parse(output);
} catch {
  // A registry or network problem must fail the check, never pass it quietly.
  fail(`pnpm audit вернул не JSON (код ${result.status}). Начало вывода:\n${output.slice(0, 2000)}`);
}

const advisories = Object.values(report?.advisories ?? {});
const counts = report?.metadata?.vulnerabilities ?? {};
console.log(`Проверено зависимостей: ${report?.metadata?.totalDependencies ?? "?"}. Находок: ${advisories.length}.`);

const paths = advisory => [...new Set((advisory.findings ?? []).flatMap(finding => finding.paths ?? []))].sort();
const sameSet = (left, right) => left.length === right.length && left.every((item, index) => item === right[index]);

const waived = [];
const blocking = [];
for (const advisory of advisories) {
  const found = paths(advisory);
  const entry = JUSTIFIED.find(item =>
    item.advisory === advisory.github_advisory_id && item.module === advisory.module_name && sameSet([...item.paths].sort(), found));
  if (entry) waived.push({ advisory, entry, found });
  else blocking.push({ advisory, found });
}

for (const { advisory, entry, found } of waived) {
  console.log(`\nОБОСНОВАНО  ${advisory.github_advisory_id}  ${advisory.module_name}@${(advisory.findings ?? [])[0]?.version ?? "?"}  (${advisory.severity})`);
  console.log(`  ${advisory.title}`);
  console.log(`  путь: ${found.join(", ")}`);
  console.log(`  причина: ${entry.reason}`);
}

for (const { advisory, found } of blocking) {
  console.log(`\nНЕ ДОПУЩЕНО  ${advisory.github_advisory_id ?? advisory.id}  ${advisory.module_name}  (${advisory.severity})`);
  console.log(`  ${advisory.title}`);
  console.log(`  уязвимо: ${advisory.vulnerable_versions}  исправлено: ${advisory.patched_versions}`);
  console.log(`  путь: ${found.join(", ") || "неизвестен"}`);
  console.log(`  ${advisory.url ?? ""}`);
}

const unseen = JUSTIFIED.filter(item => !waived.some(({ entry }) => entry === item));
for (const item of unseen) {
  console.log(`\nУСТАРЕЛО  исключение ${item.advisory} (${item.module}) больше не находится. Удалите его из scripts/audit-prod.mjs и из docs/security-audit.md.`);
}

if (blocking.length) {
  console.log(`\nПроверка не пройдена: новых необоснованных находок ${blocking.length}. ` +
    `По уровням: критических ${counts.critical ?? 0}, высоких ${counts.high ?? 0}, умеренных ${counts.moderate ?? 0}, низких ${counts.low ?? 0}.`);
  console.log("Обновите зависимость до исправленной версии. Если это невозможно, добавьте разобранное исключение в scripts/audit-prod.mjs и обоснование в docs/security-audit.md.");
  process.exit(1);
}

console.log(`\nПроверка пройдена: необоснованных находок нет, обоснованных исключений ${waived.length}.`);

function fail(message) {
  console.error(`Проверка зависимостей не выполнена: ${message}`);
  process.exit(1);
}
