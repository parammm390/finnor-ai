import type { DigitalInstitutionProfile } from "./contracts";
import { institutionDigest as hash } from "./canonical-json";

export type InstitutionResourceDemand = {
  schema: "finnor.x1.institution-resource-demand.v1"; semanticOwner: "S5";
  tenantId: string; workId: string; principalId: string; institutionId: string;
  programmeDigest: string; responsibilityIdentities: string[]; originalDeadline: string;
  lines: { resourceClass: "COMPUTE" | "HUMAN_ATTENTION"; unit: "request" | "seconds"; quantity: string }[];
  demandDigest: string; parentReservationRef: null;
  chargeScope?: { kind: "ORIGINAL_WORK_EPISODE"; episodeId: string };
  qualification: "DECLARED_ACCOUNTING_NOT_FUNDING"; executionAuthorityGranted: false;
};
export function buildInstitutionResourceDemand(input: {
  tenantId: string; workId: string; principalId: string; institutionId: string;
  programmeDigest: string; responsibilityIdentities: string[];
  computeRequests: number; humanSeconds: number; originalDeadline: string; profile: DigitalInstitutionProfile;
  chargeScope?: InstitutionResourceDemand["chargeScope"];
}): InstitutionResourceDemand {
  if (!Number.isSafeInteger(input.computeRequests) || input.computeRequests < 0
    || !Number.isSafeInteger(input.humanSeconds) || input.humanSeconds < 0
    || input.humanSeconds > input.profile.bounds.episodeHumanSeconds
    || !input.responsibilityIdentities.length
    || input.responsibilityIdentities.length > input.profile.bounds.derivedObligations
    || new Set(input.responsibilityIdentities).size !== input.responsibilityIdentities.length) {
    throw new Error("X1_DEMAND_BOUND");
  }
  const body = {
    schema: "finnor.x1.institution-resource-demand.v1" as const, semanticOwner: "S5" as const,
    tenantId: input.tenantId, workId: input.workId, principalId: input.principalId,
    institutionId: input.institutionId, programmeDigest: input.programmeDigest,
    responsibilityIdentities: [...input.responsibilityIdentities].sort(),
    originalDeadline: input.originalDeadline,
    lines: [
      { resourceClass: "COMPUTE" as const, unit: "request" as const, quantity: String(input.computeRequests) },
      { resourceClass: "HUMAN_ATTENTION" as const, unit: "seconds" as const, quantity: String(input.humanSeconds) },
    ],
    parentReservationRef: null, qualification: "DECLARED_ACCOUNTING_NOT_FUNDING" as const,
    ...(input.chargeScope ? { chargeScope: input.chargeScope } : {}),
    executionAuthorityGranted: false as const,
  };
  return { ...body, demandDigest: hash(body) };
}
type Envelope = { resourceId: string; unit: string; kind: string; quantities: string[] };
type Charge = { chargeKey: string; requestDigest: string; phase: string; ordinal: number; units: number; resourceId: string; unit: string };
export type InstitutionChargeRequest = { responsibilityIdentity: string;
  phase: "EXECUTION" | "RECOVERY" | "HUMAN" | "ACQUISITION" | "CHECK" | "COMPILE" | "PREPARATION" | "CONTROL" | "LIFECYCLE";
  ordinal: number; units: number;physicalInvocationId?:string };
type Request = InstitutionChargeRequest;
type Result = { status: "REFUSED"; reason: string } | { status: "REPLAY"; chargeKey: string }
  | { status: "PLANNED"; chargeKey: string; requestDigest: string; resourceId: string; unit: string; usedAfter: string };
export function planInstitutionDemandCharge(input: {
  demand: InstitutionResourceDemand; envelope: Envelope[] | null; existingCharges: Charge[]; request: Request;
}): Result {
  const { demand, envelope, existingCharges, request } = input;
  if (!demand.responsibilityIdentities.includes(request.responsibilityIdentity)
      && !(demand.chargeScope?.kind === "ORIGINAL_WORK_EPISODE"
        && /^x1-obligation:[a-f0-9]{64}$/.test(request.responsibilityIdentity)))
    return { status: "REFUSED", reason: "X1_CHARGE_RESPONSIBILITY_FOREIGN" };
  const physicalPhase=['PREPARATION','CONTROL','LIFECYCLE'].includes(request.phase);
  if(physicalPhase&&(!demand.chargeScope||request.ordinal!==1
    ||!request.physicalInvocationId||! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.physicalInvocationId))
    ||!physicalPhase&&request.physicalInvocationId!==undefined)
    return {status:'REFUSED',reason:'X1_ACTUAL_PHYSICAL_CHARGE_IDENTITY_REQUIRED'};
  if (!["EXECUTION", "RECOVERY", "HUMAN", "ACQUISITION", "CHECK", "COMPILE", "PREPARATION", "CONTROL", "LIFECYCLE"].includes(request.phase)
      || !Number.isSafeInteger(request.ordinal) || request.ordinal < 1
      || request.ordinal > (demand.chargeScope ? request.phase==='RECOVERY'?1024:128 : 64))
    return { status: "REFUSED", reason: "X1_CHARGE_PHASE_OR_ORDINAL_INVALID" };
  if (!Number.isSafeInteger(request.units) || request.units < 1 || request.units > 100000)
    return { status: "REFUSED", reason: "X1_CHARGE_UNITS_INVALID" };
  if (!envelope) return { status: "REFUSED", reason: "X1_DEMAND_UNFUNDED" };
  const chargeKey = `x1-charge:${hash([demand.demandDigest, request.responsibilityIdentity,
    request.phase, physicalPhase?request.physicalInvocationId:request.ordinal])}`;
  const requestDigest = hash(["institution-charge-request-v1", demand.demandDigest,
    request.responsibilityIdentity, request.phase, physicalPhase?request.physicalInvocationId:request.ordinal, request.units]);
  const previous = existingCharges.find((charge) => charge.chargeKey === chargeKey);
  if (previous) return previous.requestDigest === requestDigest
    ? { status: "REPLAY", chargeKey }
    : { status: "REFUSED", reason: "X1_CHARGE_REPLAY_CONFLICT" };
  const resourceClass = request.phase === "HUMAN" ? "HUMAN_ATTENTION" : "COMPUTE";
  const unit = request.phase === "HUMAN" ? "seconds" : "request";
  const matches = envelope.filter((line) => line.unit === unit && line.kind === "CUMULATIVE_EXPENDITURE");
  if (matches.length !== 1 || !demand.lines.some((line) => line.resourceClass === resourceClass && line.unit === unit))
    return { status: "REFUSED", reason: "X1_CHARGE_CLASS_UNFUNDED" };
  const resource = matches[0]!;
  if (!resource.quantities.length || resource.quantities.some((value) => !/^(0|[1-9]\d*)$/.test(value)))
    return { status: "REFUSED", reason: "X1_CHARGE_CLASS_UNFUNDED" };
  const limit = resource.quantities.reduce((a, b) => BigInt(a) > BigInt(b) ? a : b, "0");
  const used = existingCharges.filter((charge) => charge.resourceId === resource.resourceId && charge.unit === unit)
    .reduce((sum, charge) => sum + BigInt(charge.units), 0n);
  const usedAfter = used + BigInt(request.units);
  if (usedAfter > BigInt(limit)) return { status: "REFUSED", reason: "X1_CHARGE_BUDGET_EXHAUSTED" };
  return { status: "PLANNED", chargeKey, requestDigest,
    resourceId: resource.resourceId, unit, usedAfter: String(usedAfter) };
}
