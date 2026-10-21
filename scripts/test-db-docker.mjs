// Disposable PostgreSQL 16. No env files, URLs, exposed ports or external services.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const name = `nexus-fulfillment-${randomUUID()}`;
function docker(args) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 240000, maxBuffer: 32 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`${r.error?.message ?? ''}\n${r.stdout?.slice(-5000)}\n${r.stderr?.slice(-5000)}`);
  return r.stdout;
}
let created = false;
try {
  docker(['run', '--pull=never', '--detach', '--name', name, '--network=none', '--tmpfs', '/var/lib/postgresql/data:rw', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'nexus-db-test:pg16-node24']);
  created = true;
  docker(['exec', name, 'sh', '-c', 'for i in $(seq 1 30); do pg_isready -U postgres >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1']);
  const version = docker(['exec', name, 'psql', '-XAt', '-U', 'postgres', '-c', 'show server_version_num']).trim();
  if (Number(version) < 160000 || Number(version) >= 170000) throw new Error('PostgreSQL 16 required');
  docker(['exec', name, 'mkdir', '-p', '/pilot/scripts', '/pilot/docs', '/pilot/tests/recovery']);
  docker(['cp', resolve(root, 'supabase'), `${name}:/pilot/supabase`]);
  docker(['cp', resolve(root, 'tests/recovery/schema.sql'), `${name}:/pilot/tests/recovery/schema.sql`]);
  docker(['cp', resolve(root, 'scripts/test-db.sh'), `${name}:/pilot/scripts/test-db.sh`]);
  for (const file of readdirSync(resolve(root, 'scripts')).filter(n => /^test-.*\.mjs$/.test(n))) {
    docker(['cp', resolve(root, 'scripts', file), `${name}:/pilot/scripts/${file}`]);
  }
  docker(['exec', name, 'node', '--version']);
  docker(['cp', resolve(root, 'docs/reference-import.example.json'), `${name}:/pilot/docs/reference-import.example.json`]);
  docker(['exec', name, 'sed', '-i', 's/\r$//', '/pilot/scripts/test-db.sh']);
  console.log(`PostgreSQL ${version}, network=none`);
  console.log(docker(['exec', name, 'bash', '/pilot/scripts/test-db.sh']));
} finally {
  if (created) docker(['rm', '--force', name]);
}
