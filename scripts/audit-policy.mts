/**
 * Decides whether the result of `pnpm audit --prod --json` may pass. Kept apart from the command that
 * produces it, so the decision is tested with recorded reports instead of a live registry.
 *
 * The rule: anything that cannot be read with certainty fails the check. A registry error, a killed
 * process, output that is not the expected report, an advisory without the fields the decision relies
 * on, counters that disagree with the advisories — all of them fail, because a silent pass would hide
 * a real vulnerability. Severity never waives a finding, and whole severity levels are never ignored.
 */

export type Severity = "info" | "low" | "moderate" | "high" | "critical";
export const SEVERITIES: readonly Severity[] = ["info", "low", "moderate", "high", "critical"];

/**
 * Waives exactly one advisory for one package reached by one dependency path. Another path to the
 * same package is not covered: the justification is about how that caller uses the package.
 * Keep the reasoning in docs/security-audit.md, not only here.
 */
export type Justification = { advisory: string; module: string; paths: readonly string[]; reason: string };

export const JUSTIFIED: readonly Justification[] = [
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

/** Raw result of running the audit command. `status` is null when the process never ran or was killed. */
export type AuditRun = {
  stdout: string;
  stderr?: string;
  status: number | null;
  signal?: string | null;
  spawnError?: string | null;
};

export type Verdict = { ok: boolean; lines: readonly string[] };

type Advisory = {
  advisory: string;
  module: string;
  severity: Severity;
  title: string;
  url: string;
  vulnerable: string;
  patched: string;
  version: string;
  paths: string[];
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isSeverity = (value: unknown): value is Severity => SEVERITIES.includes(value as Severity);
const firstLine = (text: string | undefined) => (text ?? "").trim().split(/\r?\n/)[0] ?? "";
const short = (text: string, limit = 400) => (text.length > limit ? `${text.slice(0, limit)}…` : text);

function unreadable(...lines: string[]): Verdict {
  return { ok: false, lines: ["Проверка зависимостей не выполнена: отчёт нельзя прочитать с уверенностью.", ...lines.map(line => `  ${line}`)] };
}

/** Reads one advisory, or explains what is missing. Fields used for the decision are all required. */
function readAdvisory(key: string, raw: unknown): { advisory: Advisory } | { error: string } {
  if (!isObject(raw)) return { error: `находка ${key}: ожидался объект, получено ${Array.isArray(raw) ? "массив" : typeof raw}` };
  const missing: string[] = [];
  const text = (field: string): string => {
    const value = raw[field];
    if (!isText(value)) {
      missing.push(field);
      return "";
    }
    return value;
  };
  const advisory = text("github_advisory_id");
  const packageName = text("module_name");
  const title = text("title");
  const url = text("url");
  const vulnerable = text("vulnerable_versions");
  const patched = text("patched_versions");

  if (!isSeverity(raw.severity)) missing.push(`severity (ожидалось одно из ${SEVERITIES.join(", ")})`);

  const paths: string[] = [];
  let version = "";
  if (!Array.isArray(raw.findings) || raw.findings.length === 0) missing.push("findings (непустой массив)");
  else {
    for (const [index, finding] of raw.findings.entries()) {
      if (!isObject(finding)) {
        missing.push(`findings[${index}] (объект)`);
        continue;
      }
      if (!isText(finding.version)) missing.push(`findings[${index}].version`);
      else if (!version) version = finding.version;
      if (!Array.isArray(finding.paths) || finding.paths.length === 0 || !finding.paths.every(isText)) {
        missing.push(`findings[${index}].paths (непустой массив строк)`);
        continue;
      }
      paths.push(...(finding.paths as string[]));
    }
  }

  if (missing.length) return { error: `находка ${key}: отсутствуют или некорректны поля — ${missing.join(", ")}` };
  return {
    advisory: { advisory, module: packageName, severity: raw.severity as Severity, title, url, vulnerable, patched, version, paths: [...new Set(paths)].sort() },
  };
}

function registryError(value: unknown): string {
  if (isText(value)) return short(value);
  if (isObject(value)) {
    const parts = ["code", "summary", "message", "detail"]
      .map(field => (isText(value[field]) ? `${field}: ${value[field] as string}` : null))
      .filter((part): part is string => part !== null);
    if (parts.length) return short(parts.join("; "));
  }
  return short(JSON.stringify(value) ?? "неизвестная ошибка");
}

export function evaluateAudit(run: AuditRun, justified: readonly Justification[] = JUSTIFIED): Verdict {
  // The command itself must have completed. A non-zero exit code alone is not a failure: pnpm also
  // returns a non-zero code when it finds the advisory that is justified below.
  if (isText(run.spawnError)) return unreadable(`не удалось запустить pnpm audit: ${run.spawnError}`);
  if (isText(run.signal)) return unreadable(`процесс pnpm audit прерван сигналом ${run.signal}`);
  if (run.status === null || run.status === undefined) return unreadable("процесс pnpm audit не вернул код завершения");

  const output = (run.stdout ?? "").trim();
  if (!output) {
    return unreadable(`pnpm audit не вернул отчёт (код ${run.status}).`, `вывод ошибки: ${firstLine(run.stderr) || "пусто"}`);
  }

  let report: unknown;
  try {
    report = JSON.parse(output);
  } catch {
    return unreadable(`вывод pnpm audit не является JSON (код ${run.status}).`, `начало вывода: ${short(output, 300)}`);
  }
  if (!isObject(report)) return unreadable(`отчёт pnpm audit не является объектом JSON (код ${run.status}).`);

  // The registry refuses or fails in exactly this shape; without this check the report below would
  // look like a report with no vulnerabilities.
  if (report.error !== undefined && report.error !== null) {
    return unreadable(`pnpm audit вернул ошибку вместо отчёта (код ${run.status}).`, registryError(report.error));
  }

  if (!isObject(report.advisories)) {
    return unreadable(
      `в отчёте нет раздела advisories (код ${run.status}): неизвестная структура отчёта.`,
      `ключи отчёта: ${Object.keys(report).join(", ") || "нет"}`,
    );
  }
  if (!isObject(report.metadata) || !isObject(report.metadata.vulnerabilities)) {
    return unreadable(`в отчёте нет раздела metadata.vulnerabilities (код ${run.status}): неизвестная структура отчёта.`);
  }
  const counters = report.metadata.vulnerabilities;
  const badCounters = SEVERITIES.filter(severity => !isCount(counters[severity]));
  if (badCounters.length) {
    return unreadable(`счётчики metadata.vulnerabilities некорректны: ${badCounters.join(", ")}.`);
  }
  if (report.metadata.totalDependencies !== undefined && !isCount(report.metadata.totalDependencies)) {
    return unreadable("metadata.totalDependencies не является числом.");
  }

  const advisories: Advisory[] = [];
  const problems: string[] = [];
  for (const [key, raw] of Object.entries(report.advisories)) {
    const parsed = readAdvisory(key, raw);
    if ("error" in parsed) problems.push(parsed.error);
    else advisories.push(parsed.advisory);
  }
  if (problems.length) return unreadable("отчёт содержит находки, которые нельзя разобрать:", ...problems);

  // Counters must describe the advisories we actually processed; otherwise the report is partial and
  // a finding could be missing from the list we judge.
  const counted = Object.fromEntries(SEVERITIES.map(severity => [severity, advisories.filter(item => item.severity === severity).length])) as Record<Severity, number>;
  const mismatch = SEVERITIES.filter(severity => counted[severity] !== counters[severity]);
  if (mismatch.length) {
    return unreadable(
      "счётчики отчёта не совпадают с разобранными находками:",
      ...mismatch.map(severity => `${severity}: в metadata ${String(counters[severity])}, разобрано ${counted[severity]}`),
    );
  }

  // pnpm exits non-zero when it reports vulnerabilities and zero when it reports none. Any other
  // combination means the report does not describe what the command actually did.
  if (advisories.length === 0 && run.status !== 0) {
    return unreadable(`pnpm audit вернул код ${run.status}, но находок в отчёте нет: запуск не удался или отчёт неполный.`, `вывод ошибки: ${firstLine(run.stderr) || "пусто"}`);
  }
  if (advisories.length > 0 && run.status === 0) {
    return unreadable(`pnpm audit вернул код 0 при ${advisories.length} находках в отчёте.`);
  }

  const lines: string[] = [
    `Проверено зависимостей: ${isCount(report.metadata.totalDependencies) ? report.metadata.totalDependencies : "?"}. Находок: ${advisories.length}.`,
  ];

  const waived: { advisory: Advisory; entry: Justification }[] = [];
  const blocking: Advisory[] = [];
  for (const advisory of advisories) {
    const entry = justified.find(item =>
      item.advisory === advisory.advisory &&
      item.module === advisory.module &&
      item.paths.length === advisory.paths.length &&
      [...item.paths].sort().every((path, index) => path === advisory.paths[index]));
    if (entry) waived.push({ advisory, entry });
    else blocking.push(advisory);
  }

  for (const { advisory, entry } of waived) {
    lines.push(`\nОБОСНОВАНО  ${advisory.advisory}  ${advisory.module}@${advisory.version}  (${advisory.severity})`);
    lines.push(`  ${advisory.title}`);
    lines.push(`  путь: ${advisory.paths.join(", ")}`);
    lines.push(`  причина: ${entry.reason}`);
  }

  for (const advisory of blocking) {
    lines.push(`\nНЕ ДОПУЩЕНО  ${advisory.advisory}  ${advisory.module}@${advisory.version}  (${advisory.severity})`);
    lines.push(`  ${advisory.title}`);
    lines.push(`  уязвимо: ${advisory.vulnerable}  исправлено: ${advisory.patched}`);
    lines.push(`  путь: ${advisory.paths.join(", ")}`);
    lines.push(`  ${advisory.url}`);
  }

  for (const entry of justified.filter(item => !waived.some(({ entry: used }) => used === item))) {
    lines.push(`\nУСТАРЕЛО  исключение ${entry.advisory} (${entry.module}) больше не находится. Удалите его из scripts/audit-policy.mts и из docs/security-audit.md.`);
  }

  if (blocking.length) {
    lines.push(`\nПроверка не пройдена: необоснованных находок ${blocking.length}. По уровням в отчёте: ` +
      SEVERITIES.map(severity => `${severity} ${String(counters[severity])}`).join(", ") + ".");
    lines.push("Обновите зависимость до исправленной версии. Если это невозможно, добавьте разобранное исключение в scripts/audit-policy.mts и обоснование в docs/security-audit.md.");
    return { ok: false, lines };
  }

  lines.push(`\nПроверка пройдена: необоснованных находок нет, обоснованных исключений ${waived.length}.`);
  return { ok: true, lines };
}
