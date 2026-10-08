/** Fixed pure method runner: bounded IR, no credentials or arbitrary programme. */
import { runAllocationMethod } from './search';
import { canonical } from '../../governed-execution/src/protocol';
let size = 0;
const chunks: Buffer[] = [];
for await (const raw of process.stdin) {
    const chunk = Buffer.from(raw);
    size += chunk.length;
    if (size > 8 * 1024 * 1024)
        throw Error('S8_WORKER_INPUT_BOUND');
    chunks.push(chunk);
}
const input = JSON.parse(Buffer.concat(chunks).toString());
if (!input || Object.keys(input).sort().join(',') !== 'maxExpansions,payload,problem,wallMs' || !Number.isInteger(input.wallMs) || input.wallMs < 1 || input.wallMs > 30000)
    throw Error('S8_WORKER_REQUEST_INVALID');
const result = runAllocationMethod(input.problem, input.payload, { deadlineAt: performance.now() + input.wallMs, maxExpansions: input.maxExpansions });
const encoded = canonical(result);
if (Buffer.byteLength(encoded) > 2 * 1024 * 1024)
    throw Error('S8_WORKER_OUTPUT_BOUND');
process.stdout.write(encoded);
