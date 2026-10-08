/** P7 may inspect an invalidated historical use to request fresh computation.
 * This port never treats those bytes as current or executable. */
import type { PoolClient } from 'pg';
import type { PeMutationContext } from '../types';
import { assertProgramCurrent, type ProgramRow } from '../program-synthesis/store';
import { principal, sha } from '../evidence-execution/store';
import { requireProcedureMode } from './admission';
import { capsuleDependencyKey } from './lifecycle';
import type { ProcedureUse } from './use-contracts';

export async function assertProcedureContinuationIntake(
  ctx: PeMutationContext, q: ProgramRow, c: PoolClient, lock: boolean,
) {
  const { procedure: use, ...request } = q.request as typeof q.request & { procedure?: ProcedureUse };
  if (!use) return assertProgramCurrent(ctx, q, c, lock);
  requireProcedureMode(use);
  // All existing source rights, Work, plan, compiler and schema checks still
  // run. Only the historical capsule's CURRENT-use check is inapplicable.
  await assertProgramCurrent(ctx, { ...q, request }, c, lock);
  const head = (await c.query<{ body: any; digest: string }>(
    `SELECT body,digest FROM finnor_os.p1_programs
     WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 AND id=$4`,
    [q.tenant_id, principal(ctx), q.id, q.head_id],
  )).rows[0];
  if (!head || sha(head.body) !== head.digest) throw Error('P6_CONTINUATION_PRIOR_PREIMAGE_REQUIRED');
  // P7 separately requires an authentic changed dependency and locks its
  // observed revision vector. A transferred head must contain this use key.
  if (head.body.semanticBindings.some((v: any) => v.producer === 'P6') &&
    !head.body.dependencies.some((d: any) =>
      d.key === capsuleDependencyKey(principal(ctx), use.capsuleId)))
    throw Error('P6_CONTINUATION_USE_DEPENDENCY_REQUIRED');
}
