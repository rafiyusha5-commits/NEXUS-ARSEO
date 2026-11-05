import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JUSTIFIED, evaluateAudit, type AuditRun } from "../../scripts/audit-policy.mts";

// The justified exception is read from the policy itself, so these tests follow it if it ever changes.
const [exception] = JUSTIFIED;
const JUSTIFIED_PATH = exception.paths[0];

type Json = Record<string, unknown>;

const advisory = (overrides: Json = {}, paths: readonly string[] = [JUSTIFIED_PATH]): Json => ({
  github_advisory_id: exception.advisory,
  module_name: exception.module,
  severity: "moderate",
  title: "uuid: Missing buffer bounds check in v3/v5/v6 when buf is provided",
  url: `https://github.com/advisories/${exception.advisory}`,
  vulnerable_versions: "<11.1.1",
  patched_versions: ">=11.1.1",
  findings: [{ version: "8.3.2", paths: [...paths] }],
  ...overrides,
});

const report = (advisories: Json = {}, counts: Json = {}): Json => ({
  advisories,
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, ...counts },
    dependencies: 129,
    totalDependencies: 207,
  },
});

const run = (body: unknown, status: number | null, extra: Partial<AuditRun> = {}): AuditRun =>
  ({ stdout: typeof body === "string" ? body : JSON.stringify(body), status, ...extra });

const text = (value: AuditRun) => evaluateAudit(value).lines.join("\n");

describe("the dependency audit passes only a report it can read in full", () => {
  it("accepts a report with no findings", () => {
    const verdict = evaluateAudit(run(report(), 0));
    assert.equal(verdict.ok, true);
    assert.match(verdict.lines.join("\n"), /Находок: 0/);
    // The list of exceptions must not rot: an exception that no longer matches is reported.
    assert.match(verdict.lines.join("\n"), /УСТАРЕЛО/);
  });

  it("accepts the one justified finding, although pnpm exits non-zero for it", () => {
    const verdict = evaluateAudit(run(report({ 1119441: advisory() }, { moderate: 1 }), 1));
    assert.equal(verdict.ok, true);
    const printed = verdict.lines.join("\n");
    assert.match(printed, /ОБОСНОВАНО\s+GHSA-w5hq-g745-h8pq\s+uuid@8\.3\.2/);
    assert.match(printed, /обоснованных исключений 1/);
    assert.doesNotMatch(printed, /НЕ ДОПУЩЕНО/);
    assert.match(printed, /УСТАРЕЛО.*GHSA-g3hv-75wg-m249/);
  });
});

describe("a report that cannot be trusted fails the check", () => {
  it("fails on a registry error returned as JSON instead of a report", () => {
    // Reproduces the defect: {"error": …} with exit code 1 used to be read as "no vulnerabilities".
    const verdict = evaluateAudit(run({ error: { code: "ERR_PNPM_AUDIT_BAD_RESPONSE", summary: "registry unavailable" } }, 1));
    assert.equal(verdict.ok, false);
    const printed = verdict.lines.join("\n");
    assert.match(printed, /вернул ошибку вместо отчёта/);
    assert.match(printed, /ERR_PNPM_AUDIT_BAD_RESPONSE/);
    assert.match(printed, /registry unavailable/);
    assert.doesNotMatch(printed, /Проверка пройдена/);
  });

  it("fails on an error given as a plain string or an empty object", () => {
    assert.equal(evaluateAudit(run({ error: "ENOTFOUND registry.npmjs.org" }, 1)).ok, false);
    assert.match(text(run({ error: "ENOTFOUND registry.npmjs.org" }, 1)), /ENOTFOUND/);
    assert.equal(evaluateAudit(run({ error: {} }, 1)).ok, false);
  });

  it("fails on output that is not JSON, is empty, or is not an object", () => {
    assert.match(text(run("ERR_PNPM_NO_LOCKFILE  Cannot audit", 1)), /не является JSON/);
    assert.match(text(run("", 1, { stderr: "ERR_PNPM_FETCH_401  Unauthorized\nsecond line" })), /не вернул отчёт/);
    assert.match(text(run("", 1, { stderr: "ERR_PNPM_FETCH_401  Unauthorized" })), /ERR_PNPM_FETCH_401/);
    assert.match(text(run([], 1)), /не является объектом JSON/);
    for (const value of [run("ERR", 1), run("", 1), run([], 1)]) assert.equal(evaluateAudit(value).ok, false);
  });

  it("fails when the process was interrupted or never ran", () => {
    assert.match(text({ stdout: "", status: null, spawnError: "spawn pnpm ENOENT" }), /не удалось запустить pnpm audit/);
    assert.match(text({ stdout: "", status: null, signal: "SIGKILL" }), /прерван сигналом SIGKILL/);
    assert.match(text({ stdout: JSON.stringify(report()), status: null }), /не вернул код завершения/);
    for (const value of [
      { stdout: "", status: null, spawnError: "spawn pnpm ENOENT" },
      { stdout: "", status: null, signal: "SIGKILL" },
      { stdout: JSON.stringify(report()), status: null },
    ] satisfies AuditRun[]) assert.equal(evaluateAudit(value).ok, false);
  });

  it("fails on an unknown report structure", () => {
    assert.match(text(run({ metadata: { vulnerabilities: {} } }, 0)), /нет раздела advisories/);
    assert.match(text(run({ advisories: {} }, 0)), /нет раздела metadata\.vulnerabilities/);
    assert.match(text(run({ advisories: {}, metadata: {} }, 0)), /нет раздела metadata\.vulnerabilities/);
    assert.match(text(run({ advisories: [], metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } } }, 0)), /нет раздела advisories/);
    assert.match(text(run({ advisories: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: "1", critical: 0 } } }, 0)), /счётчики metadata\.vulnerabilities некорректны: high/);
    assert.match(text(run({ ...report(), metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 }, totalDependencies: "много" } }, 0)), /totalDependencies не является числом/);
  });

  it("fails when a finding misses a field the decision relies on", () => {
    const without = (field: string) => {
      const broken = advisory();
      delete broken[field];
      return text(run(report({ 1119441: broken }, { moderate: 1 }), 1));
    };
    assert.match(without("module_name"), /отсутствуют или некорректны поля — module_name/);
    assert.match(without("github_advisory_id"), /github_advisory_id/);
    assert.match(without("patched_versions"), /patched_versions/);
    assert.match(without("findings"), /findings \(непустой массив\)/);
    assert.match(without("severity"), /severity \(ожидалось одно из/);
    assert.match(text(run(report({ 1119441: advisory({ severity: "spicy" }) }, { moderate: 1 }), 1)), /severity \(ожидалось одно из/);
    assert.match(text(run(report({ 1119441: advisory({ findings: [] }) }, { moderate: 1 }), 1)), /findings \(непустой массив\)/);
    assert.match(text(run(report({ 1119441: advisory({ findings: [{ version: "8.3.2", paths: [] }] }) }, { moderate: 1 }), 1)), /findings\[0\]\.paths/);
    assert.match(text(run(report({ 1119441: advisory({ findings: [{ paths: [JUSTIFIED_PATH] }] }) }, { moderate: 1 }), 1)), /findings\[0\]\.version/);
    assert.match(text(run(report({ 1119441: "не объект" }, { moderate: 1 }), 1)), /ожидался объект/);
    // Nothing of the above may be reported as a pass.
    assert.equal(evaluateAudit(run(report({ 1119441: advisory({ findings: [] }) }, { moderate: 1 }), 1)).ok, false);
  });

  it("fails when the counters disagree with the findings it parsed", () => {
    assert.match(text(run(report({ 1119441: advisory() }, { moderate: 2 }), 1)), /в metadata 2, разобрано 1/);
    assert.match(text(run(report({ 1119441: advisory() }, { high: 1, moderate: 1 }), 1)), /high: в metadata 1, разобрано 0/);
    assert.match(text(run(report({}, { critical: 3 }), 1)), /critical: в metadata 3, разобрано 0/);
    assert.equal(evaluateAudit(run(report({ 1119441: advisory() }, { moderate: 2 }), 1)).ok, false);
  });

  it("fails when the exit code and the report contradict each other", () => {
    assert.match(text(run(report(), 1, { stderr: "ERR_PNPM_META_FETCH_FAIL" })), /вернул код 1, но находок в отчёте нет/);
    assert.match(text(run(report(), 1, { stderr: "ERR_PNPM_META_FETCH_FAIL" })), /ERR_PNPM_META_FETCH_FAIL/);
    assert.match(text(run(report({ 1119441: advisory() }, { moderate: 1 }), 0)), /вернул код 0 при 1 находках/);
    assert.equal(evaluateAudit(run(report(), 1)).ok, false);
    assert.equal(evaluateAudit(run(report({ 1119441: advisory() }, { moderate: 1 }), 0)).ok, false);
  });
});

describe("only the exact justified finding is waived", () => {
  for (const [id, severity] of [
    ["GHSA-2464-fhr4-w9xw", "critical"],
    ["GHSA-673q-mjm6-r5xr", "critical"],
    ["GHSA-p3m5-59mp-jv5r", "high"],
  ]) {
    it(`blocks ${id} even alongside the justified ExcelJS finding`, () => {
      const nextFinding = advisory({
        github_advisory_id: id,
        module_name: "next",
        severity,
        title: "Next.js security regression fixture",
        url: `https://github.com/advisories/${id}`,
        vulnerable_versions: ">=16.0.0 <=16.4.0",
        patched_versions: ">=16.4.1",
        findings: [{ version: "16.3.8", paths: [".>next"] }],
      });
      const verdict = evaluateAudit(run(report({ uuid: advisory(), next: nextFinding }, {
        moderate: 1, [severity]: 1,
      }), 1));
      assert.equal(verdict.ok, false);
      assert.match(verdict.lines.join("\n"), new RegExp(`НЕ ДОПУЩЕНО\\s+${id}\\s+next@16\\.3\\.8`));
      assert.doesNotMatch(verdict.lines.join("\n"), /Проверка пройдена/);
    });
  }

  it("blocks an advisory that is not justified at all", () => {
    const other = advisory({
      github_advisory_id: "GHSA-aaaa-bbbb-cccc",
      module_name: "left-pad",
      severity: "high",
      title: "left-pad: remote code execution",
      url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
    }, [".>left-pad"]);
    const verdict = evaluateAudit(run(report({ 2000001: other }, { high: 1 }), 1));
    assert.equal(verdict.ok, false);
    const printed = verdict.lines.join("\n");
    assert.match(printed, /НЕ ДОПУЩЕНО\s+GHSA-aaaa-bbbb-cccc\s+left-pad/);
    assert.match(printed, /необоснованных находок 1/);
    assert.doesNotMatch(printed, /Проверка пройдена/);
  });

  it("blocks a moderate advisory: severity never waives a finding", () => {
    const moderate = advisory({ github_advisory_id: "GHSA-dddd-eeee-ffff", module_name: "pako", severity: "moderate" }, [".>pizzip>pako"]);
    assert.equal(evaluateAudit(run(report({ 2000002: moderate }, { moderate: 1 }), 1)).ok, false);
  });

  it("blocks the justified advisory when it arrives by another path", () => {
    for (const paths of [[".>read-excel-file>uuid"], [JUSTIFIED_PATH, ".>read-excel-file>uuid"], [".>exceljs>something>uuid"]]) {
      const verdict = evaluateAudit(run(report({ 1119441: advisory({}, paths) }, { moderate: 1 }), 1));
      assert.equal(verdict.ok, false, `путь ${paths.join(" + ")} не должен считаться обоснованным`);
      assert.match(verdict.lines.join("\n"), /НЕ ДОПУЩЕНО/);
    }
  });

  it("blocks the justified identifier when it belongs to another package", () => {
    const verdict = evaluateAudit(run(report({ 1119441: advisory({ module_name: "uuid-fork" }, [JUSTIFIED_PATH]) }, { moderate: 1 }), 1));
    assert.equal(verdict.ok, false);
  });

  it("blocks another advisory in the same package by the justified path", () => {
    const verdict = evaluateAudit(run(report({ 1119442: advisory({ github_advisory_id: "GHSA-9999-8888-7777" }) }, { moderate: 1 }), 1));
    assert.equal(verdict.ok, false);
    assert.match(verdict.lines.join("\n"), /НЕ ДОПУЩЕНО\s+GHSA-9999-8888-7777/);
  });

  it("blocks a new advisory reported next to the justified one", () => {
    const verdict = evaluateAudit(run(report({
      1119441: advisory(),
      2000003: advisory({ github_advisory_id: "GHSA-1111-2222-3333", module_name: "tar-fs", severity: "critical" }, [".>tar-fs"]),
    }, { moderate: 1, critical: 1 }), 1));
    assert.equal(verdict.ok, false);
    const printed = verdict.lines.join("\n");
    assert.match(printed, /ОБОСНОВАНО\s+GHSA-w5hq-g745-h8pq/);
    assert.match(printed, /НЕ ДОПУЩЕНО\s+GHSA-1111-2222-3333/);
  });
});


describe("version-bound minimatch advisory evidence", () => {
  const entry = JUSTIFIED.find(item => item.module === "minimatch")!;
  const finding = (version = "3.1.5", paths: readonly string[] = entry.paths) => advisory({
    github_advisory_id: entry.advisory, module_name: entry.module,
    findings: [{ version, paths: [...paths] }],
  });
  it("accepts only the examined version and exact dependency paths", () => {
    assert.equal(evaluateAudit(run(report({ mm: finding() }, { moderate: 1 }), 1)).ok, true);
    const actual = finding(); actual.findings = [
      {version:"3.1.5",paths:entry.paths.filter(path => !path.includes("readdir-glob"))},
      {version:"5.1.9",paths:entry.paths.filter(path => path.includes("readdir-glob"))},
    ];
    assert.equal(evaluateAudit(run(report({ mm: actual }, { moderate: 1 }), 1)).ok, true);
    for (const version of ["3.1.4", "3.1.6", "10.2.6", "11.0.0"]) {
      assert.equal(evaluateAudit(run(report({ mm: finding(version) }, { moderate: 1 }), 1)).ok, false);
    }
    assert.equal(evaluateAudit(run(report({ mm: finding("3.1.5", [...entry.paths, ".>minimatch"]) }, { moderate: 1 }), 1)).ok, false);
    assert.equal(evaluateAudit(run(report({ mm: finding("3.1.5", entry.paths.slice(1)) }, { moderate: 1 }), 1)).ok, false);
  });
  it("checks every finding version, including a second version with the same path", () => {
    const mixed = finding();
    mixed.findings = [{ version: "3.1.5", paths: entry.paths }, { version: "10.2.6", paths: entry.paths }];
    assert.equal(evaluateAudit(run(report({ mm: mixed }, { moderate: 1 }), 1)).ok, false);
  });
  it("still blocks a different advisory in the same examined dependency", () => {
    const other = finding(); other.github_advisory_id = "GHSA-aaaa-bbbb-cccc";
    assert.equal(evaluateAudit(run(report({ mm: other }, { moderate: 1 }), 1)).ok, false);
  });
});
