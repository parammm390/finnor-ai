import type { PoolClient } from "pg";
import type { SearchRow } from "../compute-search/contracts";
import type { ProgramRow } from "../program-synthesis/store";
import { nativeDeadlineAt, type NativeControlInput, type OrchestrationPolicyCapsule } from "./contracts";
import { epistemicHash } from "../../../epistemic-runtime/src/source-precedence";
import { NATIVE_CONTINUATION_VERSION } from "./continuation-contracts";

export type NativeDependencyFacets = Record<string, string>;
export function nativeDependencyFacets(input: NativeControlInput, actual: { resource: unknown; source: unknown; rights: unknown; plan: unknown }): NativeDependencyFacets {
  return {
    METHOD: epistemicHash(input.catalogue.entries.map(entry => ({ methods: entry.methodRefs, costs: entry.unitCosts, edges: entry.prerequisiteEdges }))),
    MODEL: epistemicHash({ native: input.pins.modelRef, provider: input.pins.providerRef, fitter: NATIVE_CONTINUATION_VERSION,
      fittedRef: input.continuation?.ref ?? null }),
    PRICE: epistemicHash({ price: input.pins.priceRef, conversion: input.utility }),
    DEADLINE: epistemicHash({ original: input.binding.deadline, actualEpisode: input.episodeDeadlineAt ?? null,
      contextValidity: input.contextValidUntil ?? null, fittedValidity: input.continuation?.context.validUntil ?? null,
      expired: Date.parse(input.now) >= nativeDeadlineAt(input) }),
    RESOURCE: epistemicHash(actual.resource), SOURCE: epistemicHash({ source: input.pins.sourceRef, current: actual.source }),
    RIGHTS: epistemicHash({ original: input.binding.rightsRef, current: actual.rights }),
    RUNTIME: epistemicHash(input.pins.runtimeRef), CHECKER: epistemicHash(input.pins.checkerRef),
    WORK: epistemicHash({ work: input.binding.workId, revision: input.workInputId, digest: input.workInputDigest,
      generation: input.generation, plan: actual.plan }),
    ...(input.nativeCapability ? { LATENCY: epistemicHash({
      allowance: input.nativeCapability.stageLatencyPlanningMs, evidence: input.nativeCapability.latencyReceipts,
    }) } : {}),
  };
}
export function nativeOwnerReadFailure(error: unknown): string | null {
  return error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : null;
}
export async function invalidateNativeOwnerUnavailableTx(s: SearchRow, q: ProgramRow,
  capsule: OrchestrationPolicyCapsule | null, predicate: string, c: PoolClient): Promise<void> {
  if (!capsule) return;
  // This fingerprint attests a failed original owner read, not invented new
  // source/rights/method content or a replacement grant.
  const facets = /RIGHT|AUTHORIZ/.test(predicate) ? ["RIGHTS"] :
    /WORK|PLAN/.test(predicate) ? ["WORK"] : /SOURCE|DERIVATION|INPUT_CUT/.test(predicate) ? ["SOURCE"] :
    /PRICE|UTILITY|LOSS|CONVERSION/.test(predicate) ? ["PRICE"] : /DEADLINE|EXPIRED|HORIZON/.test(predicate) ? ["DEADLINE"] :
    /RESOURCE|RESERVATION|ALLOCATION|GRANT/.test(predicate) ? ["RESOURCE"] :
    /RUNTIME|CODE|METHOD|MODULE/.test(predicate) ? ["METHOD", "RUNTIME"] : ["OWNER_CURRENTNESS"];
  await invalidateNativeFingerprintsTx(s, q, capsule, {
    ...capsule.input.dependencyState,
    ...Object.fromEntries(facets.map(facet => [facet, epistemicHash({ status: "ORIGINAL_OWNER_READ_UNPASSED", predicate })])),
  }, c);
}
export function diffNativeDependencies(before: NativeDependencyFacets, after: NativeDependencyFacets) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .filter(facet => before[facet] !== after[facet])
    .map(facet => ({ facet, expectedDigest: before[facet] ?? null, actualDigest: after[facet] ?? null }));
}
export async function invalidateNativeFingerprintsTx(s: SearchRow, q: ProgramRow,
  capsule: OrchestrationPolicyCapsule, current: NativeDependencyFacets, c: PoolClient): Promise<boolean> {
  const { sha, stable } = await import("../evidence-execution/store");
  const digest = sha(capsule), changes = diffNativeDependencies(capsule.input.dependencyState ?? { MODEL: "LEGACY_INCOMPLETE_DEPENDENCY_SET" }, current);
  for (const change of changes) await c.query(
    `INSERT INTO finnor_os.w1_invalidations(tenant_id,principal_id,search_id,capsule_digest,dependency_key,observed_revision,body)
     VALUES($1,$2,$3,$4,$5,1,$6::jsonb) ON CONFLICT DO NOTHING`,
    [s.tenant_id, s.principal_id, s.id, digest, "native-facet:" + change.facet,
      stable({ ...change, originalEpisode: q.episode_id, originalGrant: s.request.computeGrant,
        oldArtifactsAndCostsRetained: true, originalS6IdentityPreserved: true, newGrant: false, authorityGranted: false })]);
  return changes.length > 0 || !!(await c.query("SELECT capsule_digest FROM finnor_os.w1_invalidations WHERE tenant_id=$1 AND principal_id=$2 AND capsule_digest=$3 LIMIT 1",
    [s.tenant_id, s.principal_id, digest])).rowCount;
}
