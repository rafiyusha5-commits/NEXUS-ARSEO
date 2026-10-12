// PostgreSQL 16 only; disposable container, no network, no ports, no env files.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { checkPilotReport } from '../tests/pilot/report.check.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const name = `nexus-pilot-${randomUUID()}`;
assert.ok(process.argv.slice(2).every(arg => arg === '--all-sql'), 'Only --all-sql is supported; remote database arguments are forbidden');
function docker(args, input) {
  const r = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 180000 });
  if (r.error || r.status !== 0) throw new Error(`${args.slice(0, 3).join(' ')}: ${r.error?.message ?? r.stderr}`);
  return r.stdout;
}
const psql = text => docker(['exec', '-i', name, 'psql', '-X', '-qAt', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], text);
let created = false;
try {
  docker(['run', '--pull=never', '--detach', '--name', name, '--network=none',
    '--tmpfs', '/var/lib/postgresql/data:rw', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:16']);
  created = true;
  docker(['exec', name, 'sh', '-c', 'for i in $(seq 1 30); do pg_isready -U postgres >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1']);
  const version = psql('show server_version_num;').trim();
  assert.ok(Number(version) >= 160000 && Number(version) < 170000, `PostgreSQL 16 required, got ${version}`);
  if (process.argv.includes('--all-sql')) {
    docker(['exec', name, 'mkdir', '/pilot']);
    // Copy only SQL and the existing test runner, never .env, keys or user files.
    docker(['cp', resolve(root, 'supabase'), `${name}:/pilot/supabase`]);
    docker(['exec', name, 'mkdir', '/pilot/scripts']);
    docker(['exec', name, 'mkdir', '/pilot/docs']);
    docker(['cp', resolve(root, 'docs/reference-import.example.json'), `${name}:/pilot/docs/reference-import.example.json`]);
    docker(['cp', resolve(root, 'scripts/test-db.sh'), `${name}:/pilot/scripts/test-db.sh`]);
    // Windows checkout may use CRLF; normalize only the disposable container copy.
    docker(['exec', name, 'sed', '-i', 's/\r$//', '/pilot/scripts/test-db.sh']);
    console.log(docker(['exec', name, 'bash', '/pilot/scripts/test-db.sh']));
    console.log(`PASS complete test:db script on PostgreSQL ${version}`);
  }
  psql("set timezone='UTC';" + readFileSync(resolve(root, 'supabase/tests/supabase_stub.sql'), 'utf8'));
  const migrations = readdirSync(resolve(root, 'supabase/migrations')).filter(n => n.endsWith('.sql')).sort();
  psql(migrations.map(file => `\n\\echo migration:${file}\n` + readFileSync(resolve(root, 'supabase/migrations', file), 'utf8')).join('\n'));
  console.log(`PASS PostgreSQL ${version}: ${migrations.length} migrations`);
  const test = readFileSync(resolve(root, 'supabase/tests/shipment_pilot_e2e.test.sql'), 'utf8');
  const results = [];
  for (let run = 1; run <= 2; run++) {
    const output = psql(test);
    const line = output.split('\n').find(x => x.startsWith('PILOT_RESULT='));
    assert.ok(line, 'SQL must emit a result');
    const result = JSON.parse(line.slice('PILOT_RESULT='.length));
    const report = output.split('\n').find(x => x.startsWith('PILOT_REPORT='));
    assert.ok(report, 'database report snapshot is required');
    await checkPilotReport(JSON.parse(report.slice('PILOT_REPORT='.length)));
    results.push(result);
    console.log(`PASS pilot run ${run}: ${JSON.stringify(result)}`);
  }
  assert.deepEqual(results[0], results[1], 'repeat execution must have identical business totals');
  assert.equal(psql("select count(*) from public.products where internal_sku like 'PILOT-E2E-%';").trim(), '0', 'transaction rollback leaves no fixture');
  console.log('PASS repeatability and rollback; no real services used');
} finally {
  if (created) docker(['rm', '--force', name]); // Exact UUID container created by this run only.
}
