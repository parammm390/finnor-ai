import type { PoolClient } from 'pg';
import type { ExperimentRef } from '@finnor/shared-types';
import type { R3Submit } from '../../../epistemic-runtime/src/incentive-rule-synthesis/contracts';
import { r3Digest } from '../../../epistemic-runtime/src/incentive-rule-synthesis/launcher';
import { readCapitalProgram } from '../capital-program/v2-api';
import { m3Query } from '../capital-program/v2-store';
import { assertDependencies, tx } from '../evidence-execution/store';
import type { WorkBinding } from '../decision-slice/contracts';
import type { PeMutationContext } from '../types';

export type R3ProgramTarget = NonNullable<R3Submit['programTarget']>;
const same = (a: unknown, b: unknown) => r3Digest(a) === r3Digest(b);

/** A new report extension of an actual published candidate; no R2 meaning changes. */
export async function resolveR3ProgramTarget(ctx: PeMutationContext, target: R3ProgramTarget,
  work: WorkBinding, policyRef: ExperimentRef) {
  const current = await readCapitalProgram(ctx, target.queryId), program = current.program;
  const candidate = program?.candidates.find(c => c.semanticDigest === target.candidateDigest);
  if (!program || !['TESTED', 'PARTIAL'].includes(current.status) || current.workId !== work.id ||
    !same(program.ref, target.programRef) || !same(program.envelope.work,
      { id: work.id, inputId: work.inputId, inputDigest: work.inputDigest }) ||
    !candidate || candidate.disposition !== 'CHECKED_MODEL_RELATIVE' || !candidate.finitePolicyComplete ||
    !same(candidate.policyRef, target.policyRef) || !same(target.policyRef, policyRef))
    throw Error('R3_ACTUAL_CURRENT_M3_CANDIDATE_AND_S4_POLICY_REQUIRED');
  const query = await m3Query(ctx, target.queryId);
  // R3 independently checks the complete original S5 registry, reservations and
  // S6 unresolved liabilities. A new R3 reservation is not a mutation of an old
  // M3 proof. All other original programme/source dependencies remain pinned.
  const dependencies = query.acceptance.dependencies.filter(d =>
    !['m3:s5-complete', 'm3:s6-effects'].includes(d.key));
  await assertDependencies(ctx, dependencies);
  await assertR3ProgramTarget(ctx, target, work);
  return dependencies;
}

export async function assertR3ProgramTarget(ctx: PeMutationContext, target: R3ProgramTarget,
  work: WorkBinding, client?: PoolClient, lock = false) {
  const check = async (c: PoolClient) => {
    const q = await m3Query(ctx, target.queryId, c, lock);
    // A new R3 reservation/effect correctly invalidates the older M3 S5/S6
    // certificate. This extension retains its immutable construction input;
    // R3's original owners independently recheck all resources/liabilities.
    // Every other dependency remains exact, including later changes after
    // the older query has already been invalidated. Cancellation never passes.
    const replacedResourceCertificate = q.status === 'INVALIDATED' && q.failure?.code === 'DEPENDENCY_REVISED' &&
      ['m3:s5-complete', 'm3:s6-effects'].includes(q.failure.requirement);
    if ((!['TESTED', 'PARTIAL'].includes(q.status) && !replacedResourceCertificate) || q.work_id !== work.id ||
      q.work_input_id !== work.inputId || q.work_input_digest !== work.inputDigest ||
      q.result_digest !== target.programRef.contentDigest)
      throw Error('R3_ORIGINAL_M3_CANDIDATE_PUBLICATION_CHANGED');
    await assertDependencies(ctx, q.acceptance.dependencies.filter(d =>
      !['m3:s5-complete', 'm3:s6-effects'].includes(d.key)), c, lock);
    const publication = (await c.query(
      // The original publication is immutable and the API has SELECT only.
      // Hold the mutable query row above; locking this publication would demand
      // an UPDATE grant that its original owner deliberately does not provide.
      'SELECT result_digest FROM finnor_os.m3_publications WHERE tenant_id=$1 AND principal_id=$2 AND query_id=$3 AND result_digest=$4 LIMIT 1',
      [q.tenant_id, q.principal_id, q.id, target.programRef.contentDigest])).rows[0];
    if (publication?.result_digest !== target.programRef.contentDigest)
      throw Error('R3_EXACT_M3_PUBLICATION_REQUIRED');
  };
  if (client) await check(client); else await tx(ctx, check, !lock);
}
