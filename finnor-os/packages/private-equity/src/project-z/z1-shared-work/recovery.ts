import type { JobExecutionContext } from '../../../../../apps/worker/src/queue';
import { requireZ1 } from '../../../../epistemic-runtime/src/project-z/z1-shared-work/contracts.js';
import { developmentOnly } from './native-contracts.js';

/** An IPC-only rendezvous for the guarded disposable physical E2E. It neither
 * substitutes a native port nor changes a claim, resource or stored artifact.
 * Normal workers have no IPC channel and do not enter this branch. */
export async function nativeRecoveryBoundary(
  boundary: 'CLAIM' | 'CHECKPOINT' | 'DELIVERY', claim: Readonly<JobExecutionContext>, requestId: string,
): Promise<void> {
  if (process.env.FINNOR_Z1_RECOVERY_BOUNDARY !== boundary) return;
  developmentOnly();
  requireZ1(/^[a-f0-9]{64}$/.test(process.env.FINNOR_Z1_RECOVERY_NONCE ?? '') && process.send &&
    process.env.FINNOR_Z1_RECOVERY_REQUEST === requestId, 'Z1_OWNED_PHYSICAL_RECOVERY_CHANNEL_REQUIRED');
  await new Promise<void>((resolve, reject) => process.send!({
    schema: 'finnor.z1.owned-physical-boundary.v1', boundary, requestId,
    nonce: process.env.FINNOR_Z1_RECOVERY_NONCE, pid: process.pid, jobId: claim.jobId,
    deliveryAttemptId: claim.deliveryAttemptId, claimFence: claim.claimFence,
  }, error => error ? reject(new Error('Z1_PHYSICAL_BOUNDARY_CHANNEL_LOST')) : resolve()));
  // The driver must observe the committed boundary and SIGKILL this exact owned
  // PID. A lost driver instead fails within the existing original wall allowance.
  await new Promise<never>((_resolve, reject) => setTimeout(() =>
    reject(new Error('Z1_PHYSICAL_RECOVERY_NOT_OBSERVED')), 3000));
}
