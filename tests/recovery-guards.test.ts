import test from 'node:test';
import assert from 'node:assert/strict';
// Test-only JS utilities, no runtime dependencies or application changes.
import {assertDockerEndpoint,assertProject,assertContainer,assertChecksum,assertLocalApi,storageMount,sha256,waitForHealthyServices} from './recovery/guards.mjs';
test('recovery rejects remote Docker, database URLs and foreign container targets',()=>{
  for(const value of ['tcp://127.0.0.1:2375','ssh://host','https://docker.example',''])assert.throws(()=>assertDockerEndpoint(value));
  assertDockerEndpoint('unix:///var/run/docker.sock');assertDockerEndpoint('npipe:////./pipe/docker_engine');
  for(const name of ['main','production','supabase','nexus-e2e-../x'])assert.throws(()=>assertProject(name));
  assertProject('nexus-recovery-abcd1234');
  assert.throws(()=>assertContainer('supabase_db_nexus-e2e-abcd1234','nexus-e2e-11111111'));
  assert.throws(()=>assertContainer('owner_database','nexus-e2e-abcd1234'));
  assertContainer('supabase_db_nexus-e2e-abcd1234','nexus-e2e-abcd1234');
});
test('recovery never accepts a remote API or credentials in a URL',()=>{
  for(const url of ['https://project.supabase.co','http://localhost:54322','http://user:pass@localhost:54321','http://127.0.0.1.evil:54321'])assert.throws(()=>assertLocalApi(url));
  assertLocalApi('http://127.0.0.1:54321');
});
test('archive verification rejects corruption and missing checksums',()=>{
  const data=Buffer.from('SYNTHETIC BACKUP');const checksum=sha256(data);
  assertChecksum(data,checksum);assert.throws(()=>assertChecksum(Buffer.from('corrupt'),checksum));
  assert.throws(()=>assertChecksum(data,''));
});
test('Storage archive only uses the pinned CLI dedicated local file volume',()=>{
  const project='nexus-e2e-abcd1234';
  const mount={Destination:'/mnt',Type:'volume',Name:`supabase_storage_${project}`,Source:'/docker/volumes/synthetic'};
  const info={Config:{Env:['STORAGE_BACKEND=file','FILE_STORAGE_BACKEND_PATH=/mnt']},Mounts:[mount]};
  assert.deepEqual(storageMount(info,project),mount);
  assert.throws(()=>storageMount({...info,Mounts:[{...mount,Name:'owner-storage'}]},project));
  assert.throws(()=>storageMount({...info,Mounts:[{...mount,Type:'bind'}]},project));
  assert.throws(()=>storageMount({...info,Config:{Env:['STORAGE_BACKEND=s3']}},project));
});

test('restored Auth readiness does not bypass a still-starting Storage service',async()=>{
  let reads=0,waits=0;
  await waitForHealthyServices(()=>{reads++;return [
    {Name:'auth',State:{Status:'running',Health:{Status:'healthy'}}},
    {Name:'storage',State:{Status:'running',Health:{Status:reads===1?'starting':'healthy'}}},
  ];},{attempts:3,pause:async()=>{waits++;}});
  assert.equal(reads,2);assert.equal(waits,1);
});

test('restore readiness refuses stopped, missing and persistently unhealthy services',async()=>{
  await assert.rejects(()=>waitForHealthyServices(()=>[]),/No restored services/);
  await assert.rejects(()=>waitForHealthyServices(()=>[{Name:'storage',State:{Status:'exited'}}]),/Restored service stopped/);
  let reads=0;
  await assert.rejects(()=>waitForHealthyServices(()=>{reads++;return [{Name:'storage',State:{Status:'running',Health:{Status:'unhealthy'}}}];},
    {attempts:2,pause:async()=>{}}),/did not become healthy/);
  assert.equal(reads,2);
});
