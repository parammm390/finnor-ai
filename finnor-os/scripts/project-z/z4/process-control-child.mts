/** Public offline process equipment. No Work, DB, Auth or grant is constructed. */
import {ipcProcessGroupObserver} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/process-groups.ts';
import {runNative} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/native.ts';
const [channelId,nonce]=process.argv.slice(2);
if(!channelId||!nonce||!process.send)throw Error('Z4_OFFLINE_PROCESS_CHANNEL_REQUIRED');
const request={program:{schema:'finnor.z4.integer-program.v1',inputCount:1,inputUnits:['1'],
 registers:[{type:'i64',unit:'1'}],rounding:'EXACT_NO_CONVERSION',
 instructions:[{op:'add',dst:0,a:{reg:0},b:{input:0}}]},initial:['0'],inputs:[['1'],['2']],
 binding:'0'.repeat(64)};
await runNative('prove',request,{deadlineAt:new Date(Date.now()+60000).toISOString(),
 maxMemoryBytes:512*1024*1024,cpuSeconds:30,
 processGroup:process.argv.includes('--ordinary-parent-death')?undefined:ipcProcessGroupObserver(channelId,nonce)});
throw Error('Z4_OFFLINE_PROCESS_KILL_NOT_OBSERVED');
