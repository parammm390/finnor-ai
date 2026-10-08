import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash, LIMITS } from '../../packages/private-equity/src/branch-fabric/contracts';
import { runProgramme } from '../../packages/private-equity/src/branch-fabric/programmes';
import { armNativeParentMonitor } from '../../packages/private-equity/src/branch-fabric/supervisor';
const disarm = armNativeParentMonitor();
const chunks: Buffer[] = []; let length = 0;
for await (const raw of process.stdin) { const b = Buffer.from(raw); length += b.length; if (length > LIMITS.bytes) throw Error('WORKER_INPUT_BOUND'); chunks.push(b); }
const invocation = JSON.parse(Buffer.concat(chunks).toString());
if (Object.keys(invocation).sort().join() !== 'input,invocationDigest' || invocation.invocationDigest !== hash(invocation.input)) throw Error('WORKER_INVOCATION_INVALID');
const directory = await mkdtemp(join(process.env.FINNOR_P3_STATE ?? tmpdir(), 'p3-cell-'));
const candidate = await runProgramme(invocation.input, invocation.invocationDigest, directory);
const bytes = JSON.stringify(candidate);
if (Buffer.byteLength(bytes) > LIMITS.bytes) throw Error('WORKER_OUTPUT_BOUND');
process.stdout.write(bytes, disarm);
