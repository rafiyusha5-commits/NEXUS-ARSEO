/**
 * Runs `pnpm audit --prod --json` and applies the policy from audit-policy.mts. Run it with
 * `pnpm run audit:ci`; CI runs the same command. The decision itself lives in audit-policy.mts and is
 * covered by tests/scripts/audit-policy.test.ts.
 */
import { spawnSync } from "node:child_process";
import { evaluateAudit, type AuditRun } from "./audit-policy.mts";

// Prefer the package manager that started this script (set by `pnpm run audit:ci`), then a pnpm on
// PATH (CI enables it with `corepack enable`), then corepack itself.
const COMMANDS = [
  ...(process.env.npm_execpath ? [`"${process.execPath}" "${process.env.npm_execpath}" audit --prod --json`] : []),
  "pnpm audit --prod --json",
  "corepack pnpm audit --prod --json",
];

const MISSING = /not recognized|not found|no such file|cannot find|ENOENT/i;

/**
 * Finds a working package manager and returns its result as data. A candidate is skipped only when
 * the command itself could not be started; a pnpm that ran and failed is returned as is, so the
 * policy — not this function — decides what the failure means.
 */
function runAudit(): AuditRun {
  const attempts: string[] = [];
  for (const command of COMMANDS) {
    const result = spawnSync(command, { shell: true, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    const stdout = (result.stdout ?? "").trim();
    const stderr = (result.stderr ?? "").trim();
    const unavailable = !stdout && (result.error !== undefined || MISSING.test(stderr));
    if (unavailable) {
      attempts.push(`${command} → ${result.error?.message ?? stderr.split(/\r?\n/)[0] ?? `код ${String(result.status)}`}`);
      continue;
    }
    return { stdout, stderr, status: result.status, signal: result.signal ?? null, spawnError: null };
  }
  return { stdout: "", status: null, spawnError: `не найден pnpm.\n  ${attempts.join("\n  ")}` };
}

const verdict = evaluateAudit(runAudit());
for (const line of verdict.lines) console[verdict.ok ? "log" : "error"](line);
process.exit(verdict.ok ? 0 : 1);
