// No URLs, database names, backup inputs, credentials or existing project targets accepted.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
if(process.argv.length!==2)throw new Error('Recovery drill takes no arguments; existing infrastructure is forbidden');
const result=spawnSync(process.execPath,[fileURLToPath(new URL('./test-historical-browser.mjs',import.meta.url)),'--recovery'],{stdio:'inherit',windowsHide:true});
if(result.error||result.status!==0)throw result.error??new Error(`Recovery drill failed (${result.status})`);
