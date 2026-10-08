/** Disposable proof driver for the real queue/controller. Never an API option. */
import { assertDisposableDatabaseTarget } from '../../packages/db/production-target-guard';
import { closePool } from '@finnor/db';
import { branchQueue } from '../../packages/private-equity/src/branch-fabric/worker';

if (process.env.NODE_ENV !== 'test' || process.env.FINNOR_P3_DISPOSABLE_CONTROLLER_PROOF !== '1') throw Error('DISPOSABLE_CONTROLLER_PROOF_REQUIRED');
assertDisposableDatabaseTarget(process.env.DATABASE_URL, 'P3 controller crash proof');
const boundary = process.argv[2] ?? '';
if (!['BEFORE_INTENT', 'AFTER_INTENT', 'EXECUTION_PROCESS_STARTED', 'BEFORE_CHECK', 'CHECKER_PROCESS_STARTED', 'AFTER_BLOB_BEFORE_POINTER', 'AFTER_POINTER_BEFORE_ACK', 'NONE'].includes(boundary)) throw Error('FIXED_CRASH_BOUNDARY_REQUIRED');
const began = performance.now(), startedAt = new Date().toISOString();
const observed = new Set<string>();
process.stdout.write(JSON.stringify({ event: 'P3_CONTROLLER_MODULE_READY', controllerPid: process.pid,
  startedAt, boundary }) + '\n');
const queue = branchQueue({ boundary: async (name, detail) => {
  if (!observed.has(name)) {
    observed.add(name);
    process.stdout.write(JSON.stringify({ event: 'P3_CONTROLLER_BOUNDARY_OBSERVED', name,
      controllerPid: process.pid, startedAt, elapsedMs: performance.now() - began,
      branchId: detail.branchId, attemptId: detail.attemptId, resultId: detail.resultId,
      observedGeneration: detail.observedGeneration, expectedGeneration: detail.expectedGeneration,
      observedEpoch: detail.observedEpoch, expectedEpoch: detail.expectedEpoch }) + '\n');
  }
  if (name !== boundary) return;
  // Only this newly created controller is terminated. The independent harness
  // observes SQL and native process groups, then invokes actual queue recovery.
  process.stdout.write(JSON.stringify({ boundary, controllerPid: process.pid, ...detail }) + '\n', () => process.kill(process.pid, 'SIGKILL'));
  await new Promise<void>(() => {});
} });
try { await queue.tick(); } finally { await closePool(); }
