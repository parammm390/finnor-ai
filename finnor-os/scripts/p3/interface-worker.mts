import {parseProgrammeInterface} from '../../packages/private-equity/src/program-synthesis/interface-contracts';
import {bindModule} from '../../packages/private-equity/src/interface-synthesis/runtime';
import {armNativeParentMonitor} from '../../packages/private-equity/src/branch-fabric/supervisor';
const disarm=armNativeParentMonitor(),chunks:Buffer[]=[];let bytes=0;
for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>32768)throw Error('P5_PROGRAMME_WORKER_INPUT_BOUND');chunks.push(Buffer.from(chunk));}
const module=parseProgrammeInterface(JSON.parse(Buffer.concat(chunks).toString()));
const adapter=await bindModule(module.body.generated,module.body.operation,'ADAPTER'),observer=await bindModule(module.body.generated,module.body.operation,'OBSERVER');
const output=JSON.stringify({moduleDigest:module.ref.contentDigest,adapter,observer,effectAuthority:false,protectedEligible:false});
if(Buffer.byteLength(output)>131072)throw Error('P5_PROGRAMME_WORKER_OUTPUT_BOUND');
process.stdout.write(output,disarm);
