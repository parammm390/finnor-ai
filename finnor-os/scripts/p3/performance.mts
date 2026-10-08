/** Executes the predeclared twelve cold/warm pairs. No selective reruns. */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { inputFor, tx } from '../../packages/private-equity/src/branch-fabric/store';
import { costOnce, workUsage } from '../../packages/private-equity/src/branch-fabric/accounting';
import { cleanNativePreparation, disposeNativePreparations } from '../../packages/private-equity/src/branch-fabric/preparation';
import { hash } from '../../packages/private-equity/src/branch-fabric/contracts';
interface Support {
  owner: any; output: string; protocol: any; sources: any[];
  prepared(f: any, source: any, kind?: string): Promise<any>;
  run(f: any, p: any, hooks?: any, mode?: string): Promise<any>;
  api(f: any, operation: string, body: unknown): Promise<any>;
  queue(): any; sqlState(f: any, id: string): Promise<any>;
  save(path: string, value: unknown): Promise<void>;
  challenge(id: string, steps: string[], expected: string, fn: () => Promise<unknown>): Promise<void>;
}
const quantile = (values: number[], q: number) => {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b); return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
};
const median = (values: number[]) => {
  const sorted = values.slice().sort((a, b) => a - b), n = sorted.length;
  return n ? n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2 : null;
};
export async function runPerformance(s: Support) {
  const pairs: any[] = [], physical: any[] = [], overallStart = performance.now(), before = process.resourceUsage();
  let hardFailure: string | null = null;
  const f = s.owner, good = (r: any) => { assert(r.status >= 200 && r.status < 300, JSON.stringify(r)); return r.body; };
  await s.save('performance/pre-run.json', { frozenAt: new Date().toISOString(), sourceDigest: hash(s.sources), protocol: s.protocol,
    primaryPairs: 12, order: '3_REPETITIONS_X_4_FROZEN_INPUTS_COLD_THEN_WARM', additionalCells: 'APP_PRIVATE_CLONE_AND_VERIFIED_RESTORE',
    eligibleIsolatedAcceptedBranches: 0, scope: 'PUBLIC_H0_MECHANICS_NOT_SEALED_COMPARATIVE', modelRoute: 'REGISTERED_NATIVE_NO_MODEL_INVOCATION',
    originalCeilingsUnchanged: true });
  async function cell(cut: any, mode: string) {
    const start = performance.now();
    const executed = await s.run(f, cut, {}, mode);
    const state = await s.sqlState(f, executed.s.branchId);
    const costs = state.artifacts.filter((r: any) => r.category === 'COST');
    const record = { mode, elapsedMs: performance.now() - start, executed, state, costs,
      completedAndChecked: executed.branch.status === 'COMPLETE' && executed.branch.result?.check?.passed === true,
      isolatedAccepted: false, accountingScope: 'ALL_RETAINED_DELIVERIES_CONTROL_CHECK_STORAGE_UNKNOWN_USD' };
    physical.push(record); return record;
  }
  matched: for (let repetition = 0; repetition < 3; repetition++) for (const [index, parameters] of [
    [0, { equity: 95, leverageTenths: 35, reserve: 0 }], [1, { equity: 95, leverageTenths: 30, reserve: 0 }],
    [2, { equity: 95, leverageTenths: 30, reserve: 25 }], [3, null],
  ] as const) {
    const pairId = `perf-${repetition}-${index}`;
    await s.challenge(pairId, ['One immutable permitted input cut', 'Real signed async cold then clean-warm queue/candidate/checker',
      ...(index === 3 ? ['Private clone and verified consistent logical checkpoint recovery'] : [])],
    'Same exact numerical/full-state result and ceilings, complete cost history; no isolation/dollar/speedup upgrade', async () => {
      try {
      const source = parameters ? { kind: 'public_fixture', fixture: 'allocation-abc-v1', parameters } : {
        kind: 'financing_fixture', steps: [{ operation: 'autosave', target: 'C_01', feeCents: 2000, effectId: randomUUID() }],
      };
      const cut = await s.prepared(f, source, parameters ? 'pure' : 'application_fixture');
      const input = await inputFor(f.ctx, cut.inputId);
      const cold = await cell(cut, 'COLD_BUILD'), warm = await cell(cut, 'CLEAN_WARM_IMAGE');
      const record: any = { pairId, repetition, index, cut, inputDigest: hash(input), cold, warm, clone: null, restore: null };
      pairs.push(record); await s.save('performance/' + pairId + '.json', record);
      assert(cold.completedAndChecked && warm.completedAndChecked);
      if (parameters) assert.deepEqual(cold.executed.branch.result.result, warm.executed.branch.result.result);
      else {
        assert.deepEqual(cold.executed.branch.result.candidate.state, warm.executed.branch.result.candidate.state);
        record.clone = await cell(cut, 'PRIVATE_STATE_CLONE'); assert(record.clone.completedAndChecked);
        assert.deepEqual(record.clone.executed.branch.result.candidate.state, cold.executed.branch.result.candidate.state);
        const cp = good(await s.api(f, 'checkpoint', { branchId: cold.executed.s.branchId }));
        const start = performance.now();
        const resumed = good(await s.api(f, 'resume', { branchId: cold.executed.s.branchId, checkpointId: cp.checkpointId, idempotencyKey: randomUUID() }));
        await s.queue().tick();
        const branch = good(await s.api(f, 'read', { branchId: resumed.branchId }));
        const state = await s.sqlState(f, resumed.branchId);
        record.restore = { mode: 'VERIFIED_CHECKPOINT_RESTORE', elapsedMs: performance.now() - start, checkpoint: cp, executed: { s: resumed, branch },
          state, costs: state.artifacts.filter((r: any) => r.category === 'COST'), completedAndChecked: branch.status === 'COMPLETE' && branch.result?.check?.passed === true, isolatedAccepted: false };
        physical.push(record.restore); assert(record.restore.completedAndChecked);
        assert.deepEqual(branch.result.candidate.state, cold.executed.branch.result.candidate.state);
        assert.notEqual(branch.result.result.identity, cold.executed.branch.result.result.identity);
      }
      await s.save('performance/' + pairId + '.json', record); return record;
      } catch (e) { hardFailure = e instanceof Error ? e.message : 'PERFORMANCE_RUNTIME_FAILURE'; throw e; }
    });
    if (hardFailure) break matched;
  }
  const firstCleanup = await disposeNativePreparations();
  const extra = await s.prepared(f, { kind: 'public_fixture', fixture: 'allocation-abc-v1', parameters: { equity: 95, leverageTenths: 35, reserve: 0 } });
  const unassigned = await cleanNativePreparation(await inputFor(f.ctx, extra.inputId), 'CLEAN_WARM_IMAGE');
  await tx(f.ctx, c => costOnce(c, f.ctx, f.workId, 'benchmark-unused:' + randomUUID(), { phase: 'UNUSED_PUBLIC_WARM_PREPARATION',
    preparation: unassigned, elapsedMs: unassigned.elapsedMs, storageBytes: unassigned.publicBytes, meterStatus: 'PUBLIC_MANIFEST_ONLY_NOT_PROCESS_IMAGE' }));
  const finalCleanup = await disposeNativePreparations();
  const cleanup = { elapsedMs: firstCleanup.elapsedMs + finalCleanup.elapsedMs, cells: [...firstCleanup.cells, ...finalCleanup.cells] };
  await tx(f.ctx, c => costOnce(c, f.ctx, f.workId, 'benchmark-warm-retention:' + randomUUID(), { phase: 'PUBLIC_WARM_RETENTION_AND_CLEANUP',
    elapsedMs: cleanup.elapsedMs, cells: cleanup.cells, parentIntervalsMayOverlap: true, meterStatus: 'BYTE_TIME_OF_OWNED_PUBLIC_MANIFESTS_NO_ASSIGNED_PRIVATE_STATE' }));
  const usage = await tx(f.ctx, c => workUsage(c, f.ctx, f.workId));
  const ratios = pairs.filter(p => p.cold.completedAndChecked && p.warm.completedAndChecked).map(p => p.warm.elapsedMs / p.cold.elapsedMs);
  // Paired request resampling, fixed preregistered seed17.
  let seed = 17;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const bootstrap: number[] = [];
  if (ratios.length) for (let i = 0; i < 10000; i++) bootstrap.push(1 - median(ratios.map(() => ratios[Math.floor(random() * ratios.length)]!))!);
  const successful = physical.filter(c => c.completedAndChecked).length;
  const after = process.resourceUsage(), elapsedMs = performance.now() - overallStart;
  const summary = { schema: 'finnor.p3.performance.v1', pairs: pairs.length, physicalCells: physical.length,
    stoppingReason: hardFailure ?? 'TWELVE_FROZEN_PAIRS_COMPLETED',
    checkedNativeCells: successful, failedOrUnqualifiedCells: physical.length - successful, isolatedAcceptedBranches: 0,
    warmRatioMedian: median(ratios), pairedImprovement95: [quantile(bootstrap, .025), quantile(bootstrap, .975)],
    durationMs: { cold: { median: median(pairs.map(p => p.cold.elapsedMs)), p95: quantile(pairs.map(p => p.cold.elapsedMs), .95) },
      warm: { median: median(pairs.map(p => p.warm.elapsedMs)), p95: quantile(pairs.map(p => p.warm.elapsedMs), .95) },
      all: { min: Math.min(...physical.map(c => c.elapsedMs)), max: Math.max(...physical.map(c => c.elapsedMs)), p95: quantile(physical.map(c => c.elapsedMs), .95) } },
    developmentCheckedNativePerWallSecond: successful / (elapsedMs / 1000),
    isolatedAcceptedPerUSD: null, allCosts: usage, unusedPublicPreparation: unassigned, cleanup, elapsedMs,
    parentUsageBefore: before, parentUsageAfter: after, parentIntervalsNotSummedWithChildren: true,
    empiricalSpeedupThresholdMet: median(ratios)! <= s.protocol.warmImprovementClaimRequires.pairedMedianRatioAtMost && quantile(bootstrap, .025)! > 0,
    speedupClaim: 'NONE_PUBLIC_MANIFEST_CACHE_NOT_PROCESS_IMAGE_AND_REQUIRED_GATES_UNPASSED',
    innerSet: [], outerSet: 'UNKNOWN_ISOLATION_COST_ADMISSION_AND_SEALED_COMPARISON_CELLS_NOT_DEMONSTRATED',
    moneyUSD: null, reconciliation: 'UNRECONCILED', originalP3Gate: 'UNPASSED',
    qualification: 'DEPENDENCE_AWARE_PUBLIC_H0_MECHANICS_NOT_FINANCIAL_CAPABILITY_OR_RUNTIME_ADMISSION' };
  await s.save('performance/summary.json', summary);
}
