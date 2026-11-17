/** Native HTTP/consent/owner-read challenge, registered before the repair.
 * The production projector is never called directly from this proof. */
import { strict as assert } from "node:assert";
import type { ServiceCost, SourceRef } from "../../../packages/private-equity/src/real-world-service/contracts";

type Term = { instanceId: string; providerId: string; termsDigest: string };
export async function runNativeLiabilityChallenge(c: {
  requestId: string; parentAllocation: unknown; originalDeadlineAt: string;
  currentTerms: readonly Term[]; primaryProviderId: string;
  read: () => Promise<any>;
  reportCost: (term: Term, cost: ServiceCost) => Promise<SourceRef>;
  withdrawOriginal: (term: Term) => Promise<unknown>;
  recipientPatchCount: () => number;
  run: (id: string, input: unknown, expected: unknown, action: () => Promise<unknown>) => Promise<unknown>;
}) {
  const term = c.currentTerms[0];
  assert(term, "W3_LIABILITY_CURRENT_BACKUP_TERMS_REQUIRED");
  let view = await c.read();
  assert.equal(view.projection.operationallyComplete, true);
  const instance = view.projection.instances.find((i: any) => i.instanceId === term.instanceId);
  const primary = instance.commitments.find((p: any) =>
    p.providerId === c.primaryProviderId && p.state === "CONFIRMED_CANCELLED_WITH_RESIDUALS");
  const residual: ServiceCost | undefined = primary?.residualCosts.find((cost: ServiceCost) =>
    cost.amount !== null && ["ACCRUED", "CASH"].includes(cost.basis));
  assert(primary && residual, "W3_LIABILITY_ACTUAL_PRIMARY_RESIDUAL_REQUIRED");
  assert.notEqual(primary.providerId, term.providerId);
  const originalTerm: Term = { instanceId: term.instanceId, providerId: primary.providerId, termsDigest: primary.termsDigest };
  const unknown: ServiceCost = { id: residual.id, category: "RESCUE", amount: null, basis: "UNKNOWN", evidence: [],
    reason: "CONTROLLED distinct backup exposure; no authenticated actual money price or payment asserted." };
  const patches = c.recipientPatchCount();
  const current = async () => {
    view = await c.read();
    assert.deepEqual(view.budgets.allocationRef, c.parentAllocation);
    assert.equal(view.originalDeadlineAt, c.originalDeadlineAt);
    assert.equal(view.program.assignmentCount, 1);
    assert.equal(c.recipientPatchCount(), patches, "W3_COST_OBSERVATION_MUST_NOT_DISPATCH");
    const projected = view.projection.instances.find((i: any) => i.instanceId === term.instanceId);
    assert(projected.originalFailures.length > 0);
    assert.equal(projected.financiallyReconciled, false);
    assert.equal(view.projection.financiallyReconciled, false);
    return projected;
  };
  const retained = (projected: any) => {
    const costs: ServiceCost[] = projected.costs.filter((cost: ServiceCost) => cost.id === residual.id);
    assert.equal(costs.length, 2, "W3_LOCAL_COST_ID_MUST_NOT_COLLAPSE_DISTINCT_COMMITMENTS");
    assert(costs.some(cost => cost.category === unknown.category && cost.basis === "UNKNOWN" && cost.amount === null),
      "W3_DISTINCT_BACKUP_UNKNOWN_COST_MUST_REMAIN");
    assert(costs.some(cost => cost.category === residual.category && cost.basis === residual.basis
      && cost.amount?.currency === residual.amount?.currency && cost.amount?.minor === residual.amount?.minor),
    "W3_ORIGINAL_PRIMARY_RESIDUAL_MUST_REMAIN");
    return costs;
  };
  await c.run("W039-qualified-cost-id-collision-retains-original-and-backup",
    { requestId: c.requestId, originalTerm, currentTerm: term, originalResidual: residual, backupCost: unknown },
    { qualifiedCostsWithSameLocalId: 2, backupUnknownRetained: true, nativePatches: 0 }, async () => {
      const source = await c.reportCost(term, unknown);
      const projected = await current();
      return { source, costs: retained(projected), instanceFinanciallyReconciled: projected.financiallyReconciled };
    });
  await c.run("W039-exact-repeated-cost-coordinate-is-not-double-counted",
    { currentTerm: term, repeatedExactCost: unknown },
    { qualifiedCostsWithSameLocalId: 2, spuriousCostConflict: false }, async () => {
      const repeatedSource = await c.reportCost(term, unknown);
      const projected = await current();
      assert(!projected.contradictions.includes("CONFLICTING_ORIGINAL_COSTS"));
      return { repeatedSource, costs: retained(projected), contradictions: projected.contradictions };
    });
  const historicalCost: ServiceCost = { id: "controlled-historical-" + term.instanceId, category: "RESIDUAL_LIABILITY",
    amount: null, basis: "UNKNOWN", evidence: [],
    reason: "CONTROLLED original-term exposure; changing provider or withdrawing consent does not settle this liability." };
  let historicalSource: SourceRef | undefined;
  await c.run("W039-old-term-cost-outside-current-selection-remains",
    { originalTerm, currentTerm: term, originalTermCost: historicalCost },
    { oldTermUnknownRetained: true, financialReconciliation: false }, async () => {
      historicalSource = await c.reportCost(originalTerm, historicalCost);
      const projected = await current();
      retained(projected);
      assert(projected.costs.some((cost: ServiceCost) =>
        cost.id === historicalCost.id && cost.basis === "UNKNOWN" && cost.amount === null));
      return { source: historicalSource, historicalCost: projected.costs.filter((cost: ServiceCost) => cost.id === historicalCost.id) };
    });
  const conflict: ServiceCost = { id: "controlled-conflict-" + term.instanceId, category: "COORDINATION",
    amount: { currency: "USD", minor: "1" }, basis: "ACCRUED", evidence: [],
    reason: "Conflicting CONTROLLED reports, not authenticated actual billing or pricing." };
  await c.run("W039-qualified-cost-conflict-blocks-instance-reconciliation",
    { currentTerm: term, conflictingOriginalCosts: [conflict, { ...conflict, amount: { currency: "USD", minor: "2" } }] },
    { instanceConflict: true, globalConflictRetained: true, financialReconciliation: false }, async () => {
      const first = await c.reportCost(term, conflict);
      const second = await c.reportCost(term, { ...conflict, amount: { currency: "USD", minor: "2" } });
      const projected = await current();
      retained(projected);
      assert(projected.contradictions.includes("CONFLICTING_ORIGINAL_COSTS"));
      assert(view.projection.unknownCostCategories.includes("CONFLICTING_ORIGINAL_COSTS"));
      return { originals: [first, second], contradictions: projected.contradictions,
        globalUnknownCostCategories: view.projection.unknownCostCategories };
    });
  await c.run("W039-primary-consent-withdrawal-retains-qualified-cost-history",
    { originalTerm, currentTerm: term, originalResidual: residual, backupCost: unknown, originalTermCost: historicalCost },
    { historicalResidualRetained: true, withdrawnCostRetained: true, distinctUnknownRetained: true, financialReconciliation: false }, async () => {
      const withdrawal = await c.withdrawOriginal(originalTerm);
      const projected = await current();
      const original = projected.commitments.find((p: any) =>
        p.providerId === originalTerm.providerId && p.termsDigest === originalTerm.termsDigest);
      assert.equal(original.state, "CONFIRMED_CANCELLED_WITH_RESIDUALS");
      assert(historicalSource);
      assert(!projected.observations.some((ref: SourceRef) => ref.sourceId === historicalSource!.sourceId));
      assert(projected.costs.some((cost: ServiceCost) =>
        cost.id === historicalCost.id && cost.basis === "UNKNOWN" && cost.amount === null));
      return { withdrawal, originalTerm, costs: retained(projected), historicalCostSource: historicalSource,
        contradictions: projected.contradictions };
    });
}
