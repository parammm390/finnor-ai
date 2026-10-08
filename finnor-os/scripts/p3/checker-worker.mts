import { checkCandidate } from '../../packages/private-equity/src/branch-fabric/checker';
import { armNativeParentMonitor } from '../../packages/private-equity/src/branch-fabric/supervisor';
const disarm = armNativeParentMonitor();
const chunks: Buffer[] = []; let size = 0;
for await (const raw of process.stdin) { size += raw.length; if (size > 3 * 1024 * 1024) throw Error('CHECKER_INPUT_BOUND'); chunks.push(Buffer.from(raw)); }
const request = JSON.parse(Buffer.concat(chunks).toString());
if (Object.keys(request).sort().join() !== 'candidate,input,invocationDigest') throw Error('CHECKER_REQUEST_INVALID');
process.stdout.write(JSON.stringify(checkCandidate(request.input, request.candidate, request.invocationDigest)), disarm);
