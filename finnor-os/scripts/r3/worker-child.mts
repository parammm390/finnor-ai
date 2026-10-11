/** Physical disposable worker driver. No fixture fault hook enters product code. */
import { createWorker } from '../../apps/worker/src/index';
import { closePool } from '@finnor/db';
const queue = createWorker(), started = performance.now(), seconds = Number(process.argv[2] ?? '120');
try {
  for (;;) {
    await queue.tick();
    if (performance.now() - started > seconds * 1000) break;
    await new Promise<void>(r => setTimeout(r, 100));
  }
} finally { await closePool() }
