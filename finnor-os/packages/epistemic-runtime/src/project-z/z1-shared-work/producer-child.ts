import { produce } from './engine.js';
import { requireZ1, type Checkpoint } from './contracts.js';

async function main(): Promise<void> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    requireZ1(size <= 134217728, 'PRODUCER_INPUT_BYTE_BOUND', 'INCOMPLETE'); chunks.push(bytes);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    request: unknown; previous?: Checkpoint; mode?: 'SHARED' | 'DIRECT';
  };
  const production = produce(input.request, { previous: input.previous, mode: input.mode });
  const usage = process.resourceUsage();
  const output = JSON.stringify({
    production,
    physical: {
      scope: 'OWNED_CHILD_PROCESS_SINCE_START_NOT_AGGREGATE_OR_ATTESTED_IMAGE',
      userCpuMicros: usage.userCPUTime, systemCpuMicros: usage.systemCPUTime,
      peakRSSBytes: usage.maxRSS * 1024, inputBytes: size, node: process.version,
      usd: null, usdStatus: 'UNKNOWN', completeProcessExitObservedByParent: false,
    },
  });
  requireZ1(Buffer.byteLength(output) <= 134217728, 'PRODUCER_OUTPUT_BYTE_BOUND', 'INCOMPLETE');
  process.stdout.write(output);
}
main().catch(() => {
  process.stderr.write('Z1_PRODUCER_PROCESS_INCOMPLETE\n');
  process.exitCode = 1;
});
