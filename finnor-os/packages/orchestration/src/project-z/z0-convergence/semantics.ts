import { z } from "zod";
import { x2Fault } from "@finnor/private-equity/src/application-semantics/contracts";

export const CONVERGENCE_VERSION = "institution-runtime-convergence-v1";
const uuid = z.string().uuid();
const work = { workId: uuid };
export const NativeObservationSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("harness_program_v1"), ...work, programId: uuid }).strict(),
  z.object({ intent: z.literal("economic_programme_v1"), ...work, programmeId: uuid }).strict(),
  z.object({ intent: z.literal("confidential_economic_computation_v1"), ...work }).strict(),
  z.object({ intent: z.literal("execution_proof_capsule_v1"), ...work }).strict(),
  z.object({ intent: z.literal("primary_diligence_v1"), ...work }).strict(),
]);
export type NativeObservation = z.infer<typeof NativeObservationSchema>;
export function isOriginalWorkObservation(value: { intent: string }): value is NativeObservation {
  return ["harness_program_v1", "economic_programme_v1", "confidential_economic_computation_v1", "execution_proof_capsule_v1", "primary_diligence_v1"].includes(value.intent);
}
export function nativeObservationRequest(input: unknown, envelope: unknown) {
  const request = NativeObservationSchema.safeParse(input);
  const context = z.object({ workId: uuid, workInputId: uuid.optional() }).strict().safeParse(envelope);
  if (!request.success || !context.success || request.data.workId !== context.data.workId) {
    x2Fault("Z0_NATIVE_EXACT_ORIGINAL_WORK_REQUIRED", 403);
  }
  return { request: request.data, ...context.data };
}

export const InstitutionApplicationSelectorSchema = z.object({
  compilerRequestId: uuid, programId: uuid,
  responsibilityIdentity: z.string().regex(/^x1-obligation:[a-f0-9]{64}$/),
}).strict();
export type InstitutionApplicationSelector = z.infer<typeof InstitutionApplicationSelectorSchema>;

export function exactUnits(value: unknown): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) x2Fault("Z0_EXACT_ORIGINAL_UNITS_REQUIRED");
    return BigInt(value);
  }
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(value)) x2Fault("Z0_EXACT_ORIGINAL_UNITS_REQUIRED");
  return BigInt(value);
}
type Envelope = { resourceId: string; unit: string; quantities: string[] };
type Charge = { resourceId: string; unit: string; units: unknown };
type Demand = { resourceId: string; unit: string; amount: string };
export function remainingInstitutionBudget(envelopes: Envelope[], charges: Charge[], demand: Demand[]) {
  if (!envelopes.length || envelopes.length > 16 || demand.length < 1 || demand.length > 2
    || new Set(envelopes.map(line => line.resourceId)).size !== envelopes.length
    || new Set(demand.map(line => line.resourceId)).size !== demand.length
    || !demand.some(line => line.unit === "request")) x2Fault("Z0_ORIGINAL_RESOURCE_DOMAIN");
  const totals = new Map<string, { unit: string; limit: bigint; used: bigint }>();
  for (const line of envelopes) {
    if (!line.quantities.length || !["request", "seconds"].includes(line.unit)) x2Fault("Z0_ORIGINAL_RESOURCE_DOMAIN");
    totals.set(line.resourceId, { unit: line.unit,
      limit: line.quantities.reduce((sum, value) => sum + exactUnits(value), 0n), used: 0n });
  }
  for (const charge of charges) {
    const total = totals.get(charge.resourceId);
    if (!total || total.unit !== charge.unit) x2Fault("Z0_ORIGINAL_CHARGE_RESOURCE_CHANGED");
    total.used += exactUnits(charge.units);
    if (total.used > total.limit) x2Fault("Z0_ORIGINAL_BUDGET_EXHAUSTED");
  }
  return demand.map(line => {
    const total = totals.get(line.resourceId), ceiling = exactUnits(line.amount);
    if (!total || total.unit !== line.unit || ceiling < 1n
      || ceiling > (line.unit === "seconds" ? 900n : 2048n)) x2Fault("Z0_ORIGINAL_RESOURCE_DOMAIN");
    const remaining = total.limit - total.used;
    if (ceiling > remaining) x2Fault("Z0_ORIGINAL_BUDGET_EXHAUSTED");
    return { resourceId: line.resourceId, unit: line.unit, limit: total.limit.toString(),
      used: total.used.toString(), remaining: remaining.toString(), ceiling: ceiling.toString() };
  });
}
export function assertInheritedDeadline(input: {
  requestedDeadlineAt: string; originalDeadlineAt: string; wallDeadlineAt: string;
  responsibilityDeadlineAt: string; programmeDeadlineAt: string; nowMs: number;
}) {
  const dates = [input.requestedDeadlineAt, input.originalDeadlineAt, input.wallDeadlineAt,
    input.responsibilityDeadlineAt, input.programmeDeadlineAt].map(value => {
    if (!z.string().datetime({ offset: true }).safeParse(value).success) x2Fault("Z0_ORIGINAL_DEADLINE_REQUIRED");
    return Date.parse(value);
  });
  if (!Number.isFinite(input.nowMs) || dates.some(value => !Number.isFinite(value) || value <= input.nowMs)
    || dates.some(value => dates[0]! > value)) x2Fault("Z0_ORIGINAL_DEADLINE_EXHAUSTED_OR_EXTENDED");
  return new Date(dates[0]!).toISOString();
}
export function assertInheritedCharge(input: {
  parentLimit: unknown; parentUsed: unknown; childLimit: unknown; childUsed: unknown;
  units: number; phase: string; recovery: boolean;
}) {
  if (!Number.isSafeInteger(input.units) || input.units < 1 || input.units > 2048
    || input.recovery && input.phase !== "RECOVERY") x2Fault("Z0_ORIGINAL_CHARGE_DOMAIN");
  const parentUsedAfter = exactUnits(input.parentUsed) + BigInt(input.units);
  const childUsedAfter = exactUnits(input.childUsed) + BigInt(input.units);
  if (parentUsedAfter > exactUnits(input.parentLimit) || childUsedAfter > exactUnits(input.childLimit)) {
    x2Fault("Z0_ORIGINAL_BUDGET_EXHAUSTED");
  }
  return { parentUsedAfter: parentUsedAfter.toString(), childUsedAfter: childUsedAfter.toString() };
}
