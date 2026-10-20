// One entry point. A nonzero result is intentional while the requested contract is unmet.
// This must never report the partial SQL/component coverage as full browser E2E.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { checkpointProblems } from '../tests/pilot/historical-contract.ts';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.length > 2) throw new Error('No database URLs or external endpoints accepted');
const playwright = process.env.NEXUS_TEST_PLAYWRIGHT || 'playwright';
function run(script, args = []) {
  const result = spawnSync(process.execPath, [resolve(root, script), ...args], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error || new Error(`${script} failed (${result.status})`);
}
run('scripts/test-shipment-pilot.mjs', ['--historical']);
run('scripts/test-historical-report-ui.mjs', [playwright]);
run('scripts/test-evidence-outcome-ui.mjs', [playwright, resolve(root, 'test-results/historical')]);
const capture = JSON.parse(readFileSync(resolve(root, 'test-results/historical/capture.json'), 'utf8'));
const problems = checkpointProblems(capture.checkpoints);
if (problems.length) throw new Error(problems.join('; '));
const limitations = [
  'Operations are exercised through existing SQL RPCs, NOT through authenticated Nexus forms.',
  'Drive/OCR registration/review browser flow, two-tab writes and full UI-to-DB checkpoints remain unimplemented.',
  'Packing/declaration imports are not part of this inherited pilot (invoice and two CMRs only).',
];
const defects = [];
if (!capture.costDiagnostic.owner_rule_satisfied) defects.push({
  code: 'PAID_SHORTFALL_COST_REDISTRIBUTION',
  expected: 10, actual: capture.costDiagnostic.actual_unit_cost,
  scenario: '100 paid at 10 EUR, 98 received; goods_cost=1000 allocated and marked paid',
});
const report = { fullBrowserE2E: false, defects, limitations, checkpoints: capture.checkpoints, backend: capture.backend };
writeFileSync(resolve(root, 'test-results/historical/readiness.json'), JSON.stringify(report, null, 2));
console.table(capture.checkpoints.map(r => ({ stage: r.stage, stock: JSON.stringify(r.stock), reserved: r.reserved, movements: r.movements })));
console.error('NOT ACCEPTED: full historical browser contract is incomplete.', JSON.stringify({ defects, limitations }, null, 2));
process.exitCode = 2;
