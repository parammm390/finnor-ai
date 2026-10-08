import { restoreInterventionControlAdapter } from '../../../epistemic-runtime/src/intervention-control';
import { fault, hash } from './contracts';
/** Uses exact retained S3 joint coefficients/shocks. No refit or new IID shocks. */
export function simulateJointKernel(p: Record<string, any>) {
  const adapter = restoreInterventionControlAdapter(p.model, p.snapshot), horizon = p.snapshot.request.horizon;
  if (Object.keys(p.exposures).sort().join() !== adapter.exposureIds.slice().sort().join()) fault('S3_EXPOSURES_UNSUPPORTED');
  let worlds = adapter.initialWorlds;
  const trajectories = [];
  for (let period = 0; period < horizon; period++) {
    const exposure = Object.fromEntries(adapter.exposureIds.map(id => [id, p.exposures[id][period]]));
    worlds = worlds.map(w => adapter.advance(w, exposure, period));
    trajectories.push({ period, worlds: structuredClone(worlds) });
  }
  return { schema: 'finnor.p3.joint-trajectory.v1', modelRef: p.model.ref, kernelRef: p.snapshot.ref, seed: p.snapshot.request.seed, trajectories, supported: worlds.every(w => w.supported), reproducibilityTolerance: 1e-8, exactKernelDigest: hash(p.snapshot), qualification: adapter.qualification, limitations: adapter.limitations, evidenceClass: 'MODEL_RELATIVE', executionAuthorityGranted: false };
}
