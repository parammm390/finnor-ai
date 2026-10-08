import type { TenantContext } from '@finnor/shared-types';
import { readEnterpriseDurableObligation, readEnterpriseDurableObligationExecutionHandoff } from '../enterprise-obligations';
import { ownerTransportRoute } from '../../../governed-execution/src/owner-transport';
import { actor } from './store';
import { fault, hash } from './contracts';

/** This initial reviewed read is ONLY S6's existing authenticated, signed
 * execution-handoff operation. No arbitrary provider read or write is exposed. */
export async function acquireReviewedObservation(ctx: TenantContext, obligationRef: unknown, root: { entityType: string; entityId: string }) {
  const owner = { auth: ctx }, obligation = await readEnterpriseDurableObligation(owner, obligationRef);
  if (!obligation.intervention.targets.some(r => r.entityType === root.entityType && r.entityId === root.entityId)) fault('S6_READ_ROOT_UNAVAILABLE', 404);
  const route = await ownerTransportRoute({ semanticOwner: 'S6', tenantId: ctx.tenantId, principalId: actor(ctx) });
  if (!route) fault('S6_REVIEWED_READ_CAPABILITY_UNAVAILABLE', 424);
  const began = performance.now();
  // Owner resolver independently verifies signed release, exact scope,
  // rights, obligation preimage, protected history ordering and projections.
  const captured = await readEnterpriseDurableObligationExecutionHandoff(owner, { obligationRef });
  const observedAt = new Date().toISOString();
  const observation = projectReviewedObservation(captured.handoff, observedAt);
  return {
    payload: { observation },
    ownerBindings: {
      obligationRef, rightsRef: obligation.rightsRef, operation: 'S6_READ_EXECUTION_HANDOFF_V1', routeDomain: route.protectionDomain,
      reviewedRouteDigest: hash({ domain: route.protectionDomain, ledger: route.ledger, originKeys: route.originKeys, rightsRefs: route.rightsRefs }),
      release: captured.handoff.release, sourceDigest: hash(captured.handoff), signatureDigest: hash(captured.signature),
      sourceAt: captured.handoff.history.at(-1)?.receipt.appendAt ?? captured.handoff.obligationReceipt.appendAt,
      observedAt, observationDigest: hash(observation), compute: { elapsedMs: performance.now() - began, externalCalls: 1, moneyUSD: null, reconciliation: 'UNRECONCILED', sourceAttemptsChargedAgain: false },
      qualification: route.protectionDomain === 'DISPOSABLE_TEST_AUTHORITY' ? 'REVIEWED_S6_TEST_AUTHORITY_READ_NOT_PRODUCTION_ADMISSION' : 'REVIEWED_S6_SIGNED_HISTORY_READ_NO_PROVIDER_WRITE_AUTHORITY',
    },
  };
}
export function projectReviewedObservation(handoff: Record<string, any>, observedAt: string) {
  return {
    schema: 'finnor.p3.reviewed-observation.v1', semanticOwner: 'S6',
    operation: 'S6_READ_EXECUTION_HANDOFF_V1', obligationRef: handoff.obligation.ref,
    sourceDigest: hash(handoff), observedAt, knowledgeAt: handoff.history.at(-1)?.receipt.appendAt ?? handoff.obligationReceipt.appendAt,
    attempts: handoff.attempts.map((row: any) => ({ eventId: row.event.eventId, checkpointDigest: row.receipt.checkpointDigest, status: row.event.detail.status })),
    observations: handoff.observations.map((row: any) => ({ eventId: row.event.eventId, checkpointDigest: row.receipt.checkpointDigest, status: row.event.detail.status, responseDigest: row.event.detail.responseDigest ?? null })),
    settlements: handoff.settlements.map((row: any) => ({ eventId: row.event.eventId, checkpointDigest: row.receipt.checkpointDigest, ownerStatus: row.event.detail.status })),
    projection: 'HISTORICAL_SIGNED_S6_HISTORY_NOT_NEW_PROVIDER_OBSERVATION',
    attributionGranted: false, resourceReleaseGranted: false, executionAuthorityGranted: false,
    replayDispatchesExternalRequest: false,
  };
}
