import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export function assertDockerEndpoint(endpoint){
  assert.ok(typeof endpoint==='string'&&(/^(unix:\/\/\/|npipe:\/\/)/.test(endpoint)),'Only a local Docker socket is allowed');
}
export function assertProject(project){assert.match(project,/^nexus-(?:e2e|recovery)-[0-9a-f]{8}$/);}
export function assertContainer(name,project){assertProject(project);assert.match(name,/^supabase_[a-z_]+_nexus-(?:e2e|recovery)-[0-9a-f]{8}$/);assert.ok(name.endsWith('_'+project));}
export function assertChecksum(bytes,expected){assert.match(expected,/^[a-f0-9]{64}$/);assert.equal(sha256(bytes),expected,'Backup checksum mismatch');}
export function assertLocalApi(value){const u=new URL(value);assert.ok(['127.0.0.1','localhost'].includes(u.hostname)&&u.protocol==='http:'&&u.port==='54321'&&!u.username&&!u.password);return u;}
