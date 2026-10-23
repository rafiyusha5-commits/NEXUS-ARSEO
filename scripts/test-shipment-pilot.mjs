// PostgreSQL 16 only; disposable container, no network, no ports, no env files.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { checkPilotReport } from '../tests/pilot/report.check.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const name = `nexus-pilot-${randomUUID()}`;
const allSql = process.argv.includes('--all-sql');
const historical = process.argv.includes('--historical');
assert.ok(process.argv.slice(2).every(arg => ['--all-sql', '--historical'].includes(arg)), 'Only --all-sql/--historical are supported; remote database arguments are forbidden');
function docker(args, input) {
  const r = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180000 });
  if (r.error || r.status !== 0) throw new Error(`${args.slice(0, 3).join(' ')}: ${r.error?.message ?? r.stderr}`);
  return r.stdout;
}
const psql = text => docker(['exec', '-i', name, 'psql', '-X', '-qAt', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], text);
let created = false;
try {
  docker(['run', '--pull=never', '--detach', '--name', name, '--network=none',
    '--tmpfs', '/var/lib/postgresql/data:rw', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', allSql ? 'nexus-db-test:pg16-node24' : 'postgres:16']);
  created = true;
  docker(['exec', name, 'sh', '-c', 'for i in $(seq 1 30); do pg_isready -U postgres >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1']);
  const version = psql('show server_version_num;').trim();
  assert.ok(Number(version) >= 160000 && Number(version) < 170000, `PostgreSQL 16 required, got ${version}`);
  if (allSql) {
    docker(['exec', name, 'mkdir', '/pilot']);
    // Copy only SQL and the existing test runner, never .env, keys or user files.
    docker(['cp', resolve(root, 'supabase'), `${name}:/pilot/supabase`]);
    docker(['exec', name, 'mkdir', '-p', '/pilot/tests/recovery']);
    docker(['cp', resolve(root, 'tests/recovery/schema.sql'), `${name}:/pilot/tests/recovery/schema.sql`]);
    docker(['exec', name, 'mkdir', '/pilot/scripts']);
    docker(['exec', name, 'mkdir', '/pilot/docs']);
    docker(['cp', resolve(root, 'docs/reference-import.example.json'), `${name}:/pilot/docs/reference-import.example.json`]);
    docker(['cp', resolve(root, 'scripts/test-db.sh'), `${name}:/pilot/scripts/test-db.sh`]);
    for (const file of readdirSync(resolve(root, 'scripts')).filter(n => /^test-.*\.mjs$/.test(n))) {
      docker(['cp', resolve(root, 'scripts', file), `${name}:/pilot/scripts/${file}`]);
    }
    docker(['exec', name, 'node', '--version']);
    // Windows checkout may use CRLF; normalize only the disposable container copy.
    docker(['exec', name, 'sed', '-i', 's/\r$//', '/pilot/scripts/test-db.sh']);
    console.log(docker(['exec', name, 'bash', '/pilot/scripts/test-db.sh']));
    console.log(`PASS complete test:db script on PostgreSQL ${version}`);
  }
  psql("set timezone='UTC';" + readFileSync(resolve(root, 'supabase/tests/supabase_stub.sql'), 'utf8'));
  const migrations = readdirSync(resolve(root, 'supabase/migrations')).filter(n => n.endsWith('.sql')).sort();
  psql(migrations.map(file => `\n\\echo migration:${file}\n` + readFileSync(resolve(root, 'supabase/migrations', file), 'utf8')).join('\n'));
  console.log(`PASS PostgreSQL ${version}: ${migrations.length} migrations`);
  // This runner sends SQL on stdin, so psql cannot resolve \ir relative to a file.
  // Inline only the known test-only adapter; never resolve arbitrary include paths.
  const test = readFileSync(resolve(root, 'supabase/tests/shipment_pilot_e2e.test.sql'), 'utf8')
    .replace(/^\\ir fixtures\/finish_current_ocr\.sql\r?$/m,
      () => readFileSync(resolve(root, 'supabase/tests/fixtures/finish_current_ocr.sql'), 'utf8'));
  const results = [];
  let capture;
  for (let run = 1; run <= 2; run++) {
    const output = psql(test);
    const line = output.split('\n').find(x => x.startsWith('PILOT_RESULT='));
    assert.ok(line, 'SQL must emit a result');
    const result = JSON.parse(line.slice('PILOT_RESULT='.length));
    const report = output.split('\n').find(x => x.startsWith('PILOT_REPORT='));
    assert.ok(report, 'database report snapshot is required');
    await checkPilotReport(JSON.parse(report.slice('PILOT_REPORT='.length)));
    capture = { backend: `PostgreSQL ${version}`, result, report: JSON.parse(report.slice('PILOT_REPORT='.length)),
      checkpoints: output.split('\n').filter(x => x.startsWith('PILOT_CHECKPOINT=')).map(x => JSON.parse(x.slice('PILOT_CHECKPOINT='.length))) };
    results.push(result);
    console.log(`PASS pilot run ${run}: ${JSON.stringify(result)}`);
  }
  assert.deepEqual(results[0], results[1], 'repeat execution must have identical business totals');
  assert.equal(psql("select count(*) from public.products where internal_sku like 'PILOT-E2E-%';").trim(), '0', 'transaction rollback leaves no fixture');
  console.log('PASS repeatability and rollback; no real services used');
  if (historical) {
    const diagnostic = psql(readFileSync(resolve(root, 'supabase/tests/diagnostics/historical_paid_shortfall.sql'), 'utf8'));
    const cost = diagnostic.split('\n').find(x => x.startsWith('HISTORICAL_COST='));
    assert.ok(cost, 'Cost diagnostic output is required');
    capture.costDiagnostic = JSON.parse(cost.slice('HISTORICAL_COST='.length));
    mkdirSync(resolve(root, 'test-results/historical'), { recursive: true });
    writeFileSync(resolve(root, 'test-results/historical/capture.json'), JSON.stringify(capture, null, 2));
    console.log(`DIAGNOSTIC (not acceptance): ${cost}`);
  }
} finally {
  if (created) docker(['rm', '--force', name]); // Exact UUID container created by this run only.
}
