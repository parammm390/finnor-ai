/** Fixed entry activated only by an exact authentic P4 join. No DB or broker imports. */
import { hash, LIMITS } from '../../packages/private-equity/src/branch-fabric/contracts';
import { armNativeParentMonitor } from '../../packages/private-equity/src/branch-fabric/supervisor';
const disarm = armNativeParentMonitor(), chunks: Buffer[] = []; let size = 0;
for await (const raw of process.stdin) { size += raw.length; if (size > LIMITS.bytes) throw Error('P4_CELL_INPUT_BOUND'); chunks.push(Buffer.from(raw)); }
const request = JSON.parse(Buffer.concat(chunks).toString());
if (Object.keys(request).sort().join() !== 'input,invocationDigest' || request.invocationDigest !== hash(request.input) || request.input.programme.id !== 'p4-finite') throw Error('P4_CELL_INVOCATION_INVALID');
const moduleUrl = new URL('../../packages/private-equity/src/evidence-execution/operators.ts', import.meta.url).href;
const { runNativeProgram } = await import(moduleUrl);
const p = request.input.payload;
const native = runNativeProgram({ program: p.program, sources: p.sources, maxRows: 1000, maxBytes: LIMITS.bytes });
const candidate = { schema: 'finnor.branch-candidate.v1', invocationDigest: request.invocationDigest,
  result: { schema: 'finnor.p3.p4-replay.v1', derivationId: p.derivationId, native, output: native.outputs[p.output], executionAuthorityGranted: false }, state: null };
const bytes = JSON.stringify(candidate); if (Buffer.byteLength(bytes) > LIMITS.bytes) throw Error('P4_CELL_OUTPUT_BOUND');
process.stdout.write(bytes, disarm);
