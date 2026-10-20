import { assertSignature, digest, type AuthorityKey } from "../../../capability-evolution/src/contracts";
import { QualificationProtocol, QualificationTrustPolicy, SignedQualificationProtocol,
  SignedOracleLedger, SignedObservationPacket, LifecycleCostPacket } from "./contracts";
import { scoreEnvironment } from "./scoring";
import type { z } from "zod";

type Profile = { bounds: { sourceInstances: number }; sourceClasses: Array<{ id: string; protocols: string[] }> };
type Protocol = z.infer<typeof QualificationProtocol>;
type Packet = z.infer<typeof SignedObservationPacket>["body"];
const dayMs = 86400000;
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
function past(at: string, predicate: string) {
  if (!Number.isFinite(Date.parse(at)) || Date.parse(at) > Date.now()) throw Error(predicate);
}
function sign(value: any, keys: AuthorityKey[], actor: string) { assertSignature(value, keys, actor); }

export function validateQualificationRegistration(input: { protocol: unknown; trustPolicy: unknown; profile: Profile }) {
  const signed = SignedQualificationProtocol.parse(input.protocol), p = signed.body;
  const policy = QualificationTrustPolicy.parse(input.trustPolicy);
  if (p.profileDigest !== digest(input.profile) || policy.profileDigest !== p.profileDigest
      || Date.parse(policy.policyValidUntil) <= Date.now()
      || p.candidatePrincipalId === p.custodianPrincipalId || p.candidatePrincipalId === p.observerPrincipalId
      || policy.custodianKeys.some(key => key.principalId === p.candidatePrincipalId)
      || policy.observerKeys.some(key => key.principalId === p.candidatePrincipalId)
      || p.envelopes.setup.maxCostUsd > 10000 || p.envelopes.setup.maxHumanSeconds > 80 * 3600)
    throw Error("X1_QUALIFICATION_CUSTODY_OR_PROFILE_UNAVAILABLE");
  sign(signed, policy.custodianKeys, p.custodianPrincipalId);
  past(p.registeredAt, "X1_QUALIFICATION_REGISTRATION_IN_FUTURE");
  if (Date.parse(p.registeredAt) > Date.parse(p.candidateExposureAt)
      || new Set(p.environments.map(e => e.id)).size !== 10
      || new Set(p.environments.map(e => e.unseenCustodyCommitment)).size !== 10)
    throw Error("X1_QUALIFICATION_POPULATION_OR_EXPOSURE_CHANGED");
  for (const e of p.environments) {
    if (e.systems.length > input.profile.bounds.sourceInstances
        || new Set(e.systems.map(s => s.id)).size !== e.systems.length
        || new Set(e.systems.map(s => s.sourceClass)).size < 8
        || new Set(e.systems.map(s => s.applicationFingerprint)).size < 8
        || e.systems.some(s => !input.profile.sourceClasses.some(c => c.id === s.sourceClass && c.protocols.includes(s.protocol))))
      throw Error("X1_QUALIFICATION_EIGHT_HETEROGENEOUS_CLASSES_REQUIRED");
  }
  return { protocol: p, policy, protocolDigest: digest(p), custodyPolicyDigest: digest(policy),
    custodyBasis: "EXTERNALLY_AUTHORIZED_EXISTING_POLICY_AND_SIGNED_COMMITMENTS", authorityGranted: false };
}

function horizons(packet: Packet, p: Protocol) {
  const gaps: string[] = [];
  const replayMs = Date.parse(packet.replay.replicaEnd) - Date.parse(packet.replay.replicaStart);
  if (replayMs < 30 * dayMs || !packet.replay.completeExpectedEventCoverage) gaps.push("X1_FULL_30_DAY_REPLAY_PENDING");
  const segments = [...packet.live.segments].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  if (new Set(segments.map(s => s.id)).size !== segments.length) throw Error("X1_LIVE_CLOCK_SEGMENT_DUPLICATE");
  let end: number | null = null, elapsedLiveMs = 0;
  for (const segment of segments) {
    const start = Date.parse(segment.startedAt), stopped = Date.parse(segment.endedAt);
    if (stopped < start || stopped > Date.parse(packet.observedAt) || start < Date.parse(p.candidateExposureAt)
        || Math.abs(stopped - start - segment.monotonicElapsedMs) > 1000)
      throw Error("X1_LIVE_CLOCK_MEASUREMENT_INVALID");
    if (!segment.independentlyObservedUnattended) gaps.push("X1_UNATTENDED_LIVE_OBSERVATION_UNAVAILABLE");
    if (end !== null && (start < end || start - end > 1000)) gaps.push("X1_LIVE_CLOCK_COVERAGE_GAP");
    elapsedLiveMs += segment.monotonicElapsedMs; end = stopped;
  }
  if (elapsedLiveMs < 7 * dayMs) gaps.push("X1_SEPARATE_7_ELAPSED_LIVE_DAYS_PENDING");
  return { replayMs, elapsedLiveMs, gaps, passed: gaps.length === 0 };
}

function costs(p: Protocol, latest: Packet[], lifecycle: z.infer<typeof LifecycleCostPacket>["body"] | null) {
  const gaps: string[] = [], violations: string[] = [];
  const phases = Object.entries(p.envelopes).map(([phase, envelope]) => {
    const measurements = phase === "setup" || phase === "validation" ? lifecycle ? [lifecycle[phase]] : []
      : latest.map(packet => packet.resources[phase as "replay" | "soak"]);
    const total = (key: "moneyUsd" | "humanSeconds" | "aggregatePeakMemoryBytes") =>
      measurements.length && measurements.every(m => m[key] !== null)
        ? measurements.reduce((sum, m) => sum + m[key]!, 0) : null;
    const moneyUsd = total("moneyUsd"), humanSeconds = total("humanSeconds");
    // Across potentially concurrent environments, sum of independently measured
    // peaks is a conservative upper bound; it is not an observed aggregate peak.
    const peakUpperBoundBytes = total("aggregatePeakMemoryBytes");
    const acquisitionCalls = measurements.reduce((sum, m) => sum + m.acquisitionCalls, 0);
    const nativeDeliveries = measurements.reduce((sum, m) => sum + m.nativeDeliveries, 0);
    const wallSeconds = measurements.reduce((sum, m) => sum + m.wallSeconds, 0);
    if (!measurements.length || moneyUsd === null || humanSeconds === null || peakUpperBoundBytes === null
        || measurements.some(m => !m.completeLifecycleCoverage || !m.costReceiptDigests.length))
      gaps.push(`X1_${phase.toUpperCase()}_COST_COVERAGE_UNKNOWN`);
    if (moneyUsd !== null && moneyUsd > envelope.maxCostUsd || humanSeconds !== null && humanSeconds > envelope.maxHumanSeconds
        || peakUpperBoundBytes !== null && peakUpperBoundBytes > envelope.maxAggregatePeakMemoryBytes
        || acquisitionCalls > envelope.maxAcquisitionCalls || nativeDeliveries > envelope.maxNativeDeliveries
        || wallSeconds > envelope.maxWallSeconds) violations.push(`X1_${phase.toUpperCase()}_REGISTERED_ENVELOPE_EXCEEDED`);
    return { phase, envelopeRef: envelope.ref, moneyUsd, humanSeconds, peakUpperBoundBytes,
      peakBasis: "CONSERVATIVE_SUM_OF_INDEPENDENT_ENVIRONMENT_PEAKS_NOT_AGGREGATE_MEASUREMENT",
      acquisitionCalls, nativeDeliveries, wallSeconds, receiptDigests: measurements.flatMap(m => m.costReceiptDigests) };
  });
  const episodeIds = new Set<string>();
  for (const packet of latest) for (const e of packet.originalEpisodes) {
    if (episodeIds.has(e.id)) throw Error("X1_QUALIFICATION_ORIGINAL_EPISODE_DUPLICATE");
    episodeIds.add(e.id);
    if ([e.moneyUsd, e.humanSeconds, e.aggregatePeakMemoryBytes, e.initialResponseMs, e.wallMs].some(x => x === null))
      gaps.push(`X1_EPISODE_COST_OR_RESOURCE_UNKNOWN:${e.id}`);
    if (e.moneyUsd !== null && e.moneyUsd > 100 || e.humanSeconds !== null && e.humanSeconds > 900
        || e.aggregatePeakMemoryBytes !== null && e.aggregatePeakMemoryBytes > 16 * 1024 ** 3
        || e.initialResponseMs !== null && e.initialResponseMs > 30000 || e.wallMs !== null && e.wallMs > 3600000)
      violations.push(`X1_INHERITED_ORIGINAL_EPISODE_ENVELOPE_EXCEEDED:${e.id}`);
  }
  return { phases, gaps, violations, complete: gaps.length === 0 && violations.length === 0,
    fullFinancialOrOperationalCapacityEstablished: false };
}

/** Bounded, independently administered assessment. Protected credentials,
 * test services and observations come from their existing owners. */
export function assessInstitutionQualification(input: { protocol: unknown; trustPolicy: unknown; profile: Profile;
  oracles: unknown[]; observationPackets: unknown[]; lifecycleCostPacket?: unknown }) {
  const registered = validateQualificationRegistration(input), { protocol: p, policy } = registered;
  if (input.oracles.length !== 10 || input.observationPackets.length > 10000)
    throw Error("X1_FULL_QUALIFICATION_POPULATION_OR_PACKET_BOUND");
  const oracles = input.oracles.map(value => SignedOracleLedger.parse(value));
  const packets = input.observationPackets.map(value => SignedObservationPacket.parse(value));
  const latest: Packet[] = [], environments = [], gaps: string[] = [];
  const retainedViolations = new Set<string>();
  if (new Set(oracles.map(o => o.body.environmentId)).size !== 10) throw Error("X1_PROTECTED_ORACLE_ENVIRONMENT_DUPLICATE");
  for (const environment of p.environments) {
    const oracle = oracles.find(o => o.body.environmentId === environment.id);
    if (!oracle) throw Error("X1_PROTECTED_ORACLE_MISSING");
    sign(oracle, policy.custodianKeys, p.custodianPrincipalId);
    if (oracle.body.protocolId !== p.id || digest(oracle.body) !== environment.oracleDigest
        || oracle.body.unseenCustodyCommitment !== environment.unseenCustodyCommitment
        || oracle.body.replayJournalCommitment !== environment.replayJournalCommitment
        || Date.parse(oracle.body.frozenAt) > Date.parse(p.candidateExposureAt))
      throw Error("X1_PROTECTED_ORACLE_COMMITMENT_OR_EXPOSURE_CHANGED");
    const chain = packets.filter(packet => packet.body.environmentId === environment.id).sort((a, b) => a.body.revision - b.body.revision);
    let previous: Packet | null = null, previousDigest: string | null = null;
    for (const packet of chain) {
      const body = packet.body;
      sign(packet, policy.observerKeys, p.observerPrincipalId);
      past(body.observedAt, "X1_OBSERVATION_TIMESTAMP_IN_FUTURE");
      if (body.protocolId !== p.id || body.observerPrincipalId !== p.observerPrincipalId
          || !same(body.candidateCut, p.candidateCut) || body.previousPacketDigest !== previousDigest
          || body.revision !== (previous?.revision ?? 0) + 1 || body.replay.journalCommitment !== environment.replayJournalCommitment
          || Date.parse(body.observedAt) < Date.parse(p.candidateExposureAt)
          || previous && Date.parse(body.observedAt) < Date.parse(previous.observedAt))
        throw Error("X1_OBSERVER_SOURCE_OR_HISTORY_CHAIN_CHANGED");
      if (previous) for (const phase of ["replay", "soak"] as const) {
        const old = previous.resources[phase], now = body.resources[phase];
        if (now.acquisitionCalls < old.acquisitionCalls || now.nativeDeliveries < old.nativeDeliveries
            || now.wallSeconds < old.wallSeconds || old.moneyUsd !== null && (now.moneyUsd === null || now.moneyUsd < old.moneyUsd)
            || old.humanSeconds !== null && (now.humanSeconds === null || now.humanSeconds < old.humanSeconds)
            || old.aggregatePeakMemoryBytes !== null && (now.aggregatePeakMemoryBytes === null
              || now.aggregatePeakMemoryBytes < old.aggregatePeakMemoryBytes)
            || old.costReceiptDigests.some(ref => !now.costReceiptDigests.includes(ref))
            || previous.observed[phase].violations.some(v => !body.observed[phase].violations.includes(v)))
          throw Error("X1_ORIGINAL_QUALIFICATION_COST_OR_VIOLATION_RESET");
        for (const population of ["mappings", "obligations"] as const) {
          const currentClaims = new Map<string, number>();
          for (const item of body.observed[phase][population]) currentClaims.set(digest(item), (currentClaims.get(digest(item)) ?? 0) + 1);
          for (const item of previous.observed[phase][population]) {
            const key = digest(item), remaining = currentClaims.get(key) ?? 0;
            if (!remaining) throw Error("X1_ORIGINAL_MATERIAL_CLAIM_HISTORY_OMITTED");
            currentClaims.set(key, remaining - 1);
          }
        }
        const currentSegments = new Set(body.live.segments.map(segment => digest(segment)));
        if (previous.live.segments.some(segment => !currentSegments.has(digest(segment))))
          throw Error("X1_ORIGINAL_LIVE_CLOCK_HISTORY_OMITTED");
      }
      if (previous) for (const old of previous.originalEpisodes) {
        const now = body.originalEpisodes.find(e => e.id === old.id);
        if (!now || now.originalGrantDigest !== old.originalGrantDigest || now.originalDeadline !== old.originalDeadline
            || old.receipts.some(ref => !now.receipts.includes(ref))
            || (["moneyUsd", "humanSeconds", "aggregatePeakMemoryBytes", "initialResponseMs", "wallMs"] as const)
              .some(key => old[key] !== null && (now[key] === null || now[key]! < old[key]!)))
          throw Error("X1_ORIGINAL_EPISODE_COST_GRANT_OR_DEADLINE_RESET");
      }
      for (const phase of ["replay", "soak"] as const) {
        const historical = scoreEnvironment(oracle.body.expected[phase], body.observed[phase]);
        for (const identity of historical.falseCompletions)
          retainedViolations.add(`X1_FALSE_COMPLETION:${environment.id}:${phase}:${identity}`);
        for (const violation of historical.violations)
          retainedViolations.add(`X1_OBSERVED_VIOLATION:${environment.id}:${phase}:${violation}`);
      }
      for (const violation of costs(p, [body], null).violations)
        retainedViolations.add(`${environment.id}:${violation}`);
      previous = body; previousDigest = digest(body);
    }
    if (!previous) { gaps.push(`X1_INDEPENDENT_OBSERVATION_PENDING:${environment.id}`); continue; }
    latest.push(previous);
    const score = { replay: scoreEnvironment(oracle.body.expected.replay, previous.observed.replay),
      soak: scoreEnvironment(oracle.body.expected.soak, previous.observed.soak) };
    const clock = horizons(previous, p);
    if (!previous.expectedAndObservedPopulationComplete) gaps.push(`X1_OBSERVATION_POPULATION_INCOMPLETE:${environment.id}`);
    environments.push({ environmentId: environment.id, oracleDigest: environment.oracleDigest,
      packetDigest: previousDigest, score, clock,
      passed: score.replay.performancePassed && score.soak.performancePassed && clock.passed && previous.expectedAndObservedPopulationComplete });
  }
  if (packets.some(packet => !p.environments.some(e => e.id === packet.body.environmentId)))
    throw Error("X1_OBSERVATION_ENVIRONMENT_NOT_REGISTERED");
  let lifecycle = null;
  if (input.lifecycleCostPacket) {
    const packet = LifecycleCostPacket.parse(input.lifecycleCostPacket);
    sign(packet, policy.observerKeys, p.observerPrincipalId);
    past(packet.body.observedAt, "X1_LIFECYCLE_COST_TIMESTAMP_IN_FUTURE");
    if (packet.body.protocolId !== p.id || packet.body.allocationConventionDigest !== p.allocationConventionDigest)
      throw Error("X1_LIFECYCLE_COST_ALLOCATION_CHANGED");
    lifecycle = packet.body;
  }
  const resourceCosts = costs(p, latest, lifecycle);
  const registeredGatesPassed = environments.length === 10 && environments.every(e => e.passed)
    && gaps.length === 0 && resourceCosts.complete && retainedViolations.size === 0;
  return { schema: "finnor.x1.qualification-assessment.v1", protocolDigest: registered.protocolDigest,
    custodyPolicyDigest: registered.custodyPolicyDigest, environments, gaps, resourceCosts,
    retainedHistoricalViolations: [...retainedViolations].sort(),
    registeredGatesPassed, disposition: registeredGatesPassed ? "SUPPORTED_BY_REGISTERED_INDEPENDENT_OBSERVATIONS"
      : environments.some(e => e.clock.passed && (!e.score.replay.performancePassed || !e.score.soak.performancePassed)
        || e.score.replay.violations.length || e.score.soak.violations.length
        || e.score.replay.falseCompletions.length || e.score.soak.falseCompletions.length)
        || resourceCosts.violations.length || retainedViolations.size ? "REFUSED" : "INCOMPLETE",
    classification: registeredGatesPassed ? "EMPIRICALLY_VERIFIED" : "PARTIAL",
    authorityGranted: false, s8AdmissionIssued: false, productionActive: false,
    operational100xEstablished: false, financial100xOrH2Established: false,
    custodyBasis: registered.custodyBasis, noPooledCompletionPercentage: true };
}
