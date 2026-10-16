import { z } from "zod"
import { CAPITAL_COMMITMENT_STATES, CAPITAL_PROGRAMME_STATES, CAPITAL_COMMITMENT_ID_MAX_LENGTH, CAPITAL_DIAGNOSTIC_MAX_LENGTH } from "../../../../finnor-os/packages/shared-types/src/capital-formation"
import type { CapitalFormationView } from "../../../../finnor-os/packages/shared-types/src/capital-formation"

const minor = z.string().regex(/^(0|[1-9][0-9]{0,37})$/)
// At most 512 admitted 38-digit quantities; derived totals remain exact.
const aggregateMinor = z.string().regex(/^(0|[1-9][0-9]{0,40})$/)
const text = z.string().max(512)
const diagnostic = z.string().min(1).max(CAPITAL_DIAGNOSTIC_MAX_LENGTH)
// The checker output is capped at 1 MiB; no diagnostic is an empty string.
const diagnostics = z.array(diagnostic).max(262144)
const timestamp = z.string().datetime({ offset: true })
// Validate the displayed wire projection, not professional status or financing
// truth. Those remain independently checked on the authenticated server.
export const capitalFormationView = z.object({
  schema: z.literal("finnor.capital-formation-view.v1"), programmeId: z.string().uuid(), workId: z.string().uuid(),
  root: z.object({ entityType: z.string().min(1).max(128), entityId: z.string().uuid() }).strict(),
  revision: z.number().int().positive(), status: z.enum(CAPITAL_PROGRAMME_STATES), current: z.boolean(),
  package: z.object({
    programmeId: z.string().uuid(), currency: z.string().regex(/^[A-Z]{3}$/), minorUnits: z.number().int().min(0).max(12),
    requirementMinor: minor, faceMinor: aggregateMinor, conditionalCommittedMinor: aggregateMinor, indicativeEquityMinor: aggregateMinor,
    eligibleUndrawnMinor: aggregateMinor, reservedAllocationMinor: aggregateMinor, dispatchedUnknownMinor: aggregateMinor,
    fundingReceivedMinor: aggregateMinor, financingGapMinor: aggregateMinor, presentEligibleGapMinor: aggregateMinor,
    readiness: z.enum(["INCOMPLETE", "CONDITIONALLY_COMPATIBLE", "READY_FOR_AUTHORIZED_NEXT_STEP", "FUNDING_RECEIVED"]),
    raisedPrincipalIsProfit: z.literal(false), conflicts: diagnostics,
    unresolvedClaims: diagnostics, remainingConditions: diagnostics,
    commitments: z.array(z.object({ commitmentId: z.string().min(1).max(CAPITAL_COMMITMENT_ID_MAX_LENGTH), state: z.enum(CAPITAL_COMMITMENT_STATES),
      profileId: z.string().uuid().nullable(),
      faceMinor: minor, conditionalMinor: minor, eligibleUndrawnMinor: minor, fundingReceivedMinor: aggregateMinor,
      fundingUnknownMinor: aggregateMinor, unsatisfiedConditions: z.array(text).max(64), unresolvedClaims: diagnostics,
    }).passthrough()).max(512),
  }).passthrough().nullable(),
  blockers: diagnostics, authenticatedEventCount: z.number().int().nonnegative(),
  budget: z.object({ contactsSpent: z.number().int().nonnegative(), contactLimit: z.number().int().nonnegative(),
    stepsSpent: z.number().int().nonnegative(), stepLimit: z.number().int().positive(),
    humanSecondsSpent: z.number().int().nonnegative(), humanSecondsLimit: z.number().int().nonnegative(),
    originalDeadlineAt: timestamp, waitingUntil: timestamp, costCeilingMicroUSD: aggregateMinor, maxCostMicroUSD: minor, costUnknown: z.boolean(),
  }), qualification: z.object({ engineering: z.literal("DEVELOPMENT_RUNTIME"), admission: z.literal("NOT_ESTABLISHED"),
    activation: z.literal("DISABLED"), componentGain: z.literal("NOT_EVALUATED"), fieldEconomic: z.literal("NOT_EVALUATED"),
    protectedGate: z.literal("NOT_ESTABLISHED"),
  }), executionAuthorityGranted: z.literal(false),
}).passthrough().transform(value => value as unknown as CapitalFormationView)

export function capitalDisplayDeadline(view: CapitalFormationView) {
  return Math.min(Date.parse(view.budget.originalDeadlineAt), Date.parse(view.budget.waitingUntil),
    ...view.commitments.map(c => Date.parse(c.expiresAt)))
}

export function exactCapitalAmount(minor: string, digits: number, currency: string) {
  const signless = minor.padStart(digits + 1, "0")
  const whole = digits ? signless.slice(0, -digits) : signless
  const fraction = digits ? `.${signless.slice(-digits)}` : ""
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction} ${currency}`
}
