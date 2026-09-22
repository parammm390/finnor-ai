import {
  PeDomainError,
  closedWorldClaimPermitted,
  createBenchmark,
  createDebtFacility,
  createFund,
  createMetricSeries,
  createPortfolioHolding,
  createSecurity,
  createVehicle,
  linkDebtFacilityLender,
  linkFundVehicle,
  linkStrategyMandate,
  recordBenchmarkObservation,
  recordCompanyHierarchy,
  recordCompanyPartyRole,
  recordExit,
  recordFactCoverage,
  recordIdentityResolution,
  recordMetricObservation,
  recordOutcome,
  recordOwnershipInterest,
  resolveIdentityAsKnown,
  restateBenchmarkObservation,
  restateMetricObservation,
  reviseFactCoverage,
  reviseOwnershipInterest,
  transitionFund,
  transitionVehicle,
  type PeMutationContext,
} from "@finnor/private-equity";
import { z } from "zod";
import { errorResponse, requireContext } from "../../../../lib/auth";
import { PeDigitalTwinRequestSchema } from "../../../../lib/pe-digital-twin";

export const runtime = "nodejs";

const dt = (value: string): Date => new Date(value);
const maybeDate = (value?: string): Date | undefined => value === undefined ? undefined : dt(value);

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "private, no-store" } });
}

function requestError(error: unknown): Response {
  if (error instanceof z.ZodError) return response({ error: "Invalid PE Digital Twin request", code: "INVALID_REQUEST", issues: error.issues.slice(0, 20) }, 400);
  if (error instanceof PeDomainError) {
    const status = /NOT_FOUND/.test(error.code) ? 404 : /STALE|CONFLICT/.test(error.code) ? 409 : /INVALID|UNSUPPORTED/.test(error.code) ? 400 : 422;
    return response({ error: error.message, code: error.code, details: error.details }, status);
  }
  return errorResponse(error);
}

export async function POST(req: Request): Promise<Response> {
  try {
    const length = Number(req.headers.get("content-length") ?? 0);
    if (Number.isFinite(length) && length > 256 * 1024) throw new PeDomainError("PE_INVALID_INPUT", "PE Digital Twin request exceeds 256 KiB");
    const [auth, raw] = await Promise.all([requireContext(req), req.json()]);
    const input = PeDigitalTwinRequestSchema.parse(raw);
    const ctx: PeMutationContext = { auth, provenance: { sourceSystem: "api:pe-digital-twin", createdBy: auth.userId } };
    switch (input.operation) {
      case "create-fund": return response(await createFund(ctx, { ...input, validFrom: maybeDate(input.validFrom), validTo: maybeDate(input.validTo) }), 201);
      case "transition-fund": return response(await transitionFund(ctx, input));
      case "create-vehicle": return response(await createVehicle(ctx, { ...input, validFrom: maybeDate(input.validFrom), validTo: maybeDate(input.validTo) }), 201);
      case "transition-vehicle": return response(await transitionVehicle(ctx, input));
      case "link-fund-vehicle": return response(await linkFundVehicle(ctx, { ...input, validFrom: dt(input.validFrom), validTo: maybeDate(input.validTo) }), 201);
      case "link-strategy-mandate": return response(await linkStrategyMandate(ctx, { ...input, validFrom: dt(input.validFrom), validTo: maybeDate(input.validTo) }), 201);
      case "create-portfolio-holding": return response(await createPortfolioHolding(ctx, input), 201);
      case "record-company-hierarchy": return response(await recordCompanyHierarchy(ctx, { ...input, validFrom: dt(input.validFrom), validTo: maybeDate(input.validTo) }), 201);
      case "record-company-party-role": return response(await recordCompanyPartyRole(ctx, { ...input, validFrom: dt(input.validFrom), validTo: maybeDate(input.validTo) }), 201);
      case "create-security": return response(await createSecurity(ctx, { ...input, validFrom: dt(input.validFrom), validTo: maybeDate(input.validTo) }), 201);
      case "create-debt-facility": return response(await createDebtFacility(ctx, { ...input, validFrom: dt(input.validFrom), validTo: maybeDate(input.validTo) }), 201);
      case "link-debt-facility-lender": return response(await linkDebtFacilityLender(ctx, { ...input, validFrom: dt(input.validFrom), validTo: maybeDate(input.validTo) }), 201);
      case "record-ownership": return response(await recordOwnershipInterest(ctx, { ...input, validFrom: dt(input.validFrom), validTo: maybeDate(input.validTo) }), 201);
      case "revise-ownership": return response(await reviseOwnershipInterest(ctx, {
        priorInterestId: input.priorInterestId, expectedVersion: input.expectedVersion, validFrom: dt(input.validFrom),
        replacement: { ...input.replacement, validTo: maybeDate(input.replacement.validTo) },
      }), 201);
      case "create-benchmark": return response(await createBenchmark(ctx, input), 201);
      case "create-metric-series": return response(await createMetricSeries(ctx, input), 201);
      case "record-metric-observation": return response(await recordMetricObservation(ctx, { ...input, periodStart: dt(input.periodStart), periodEnd: dt(input.periodEnd) }), 201);
      case "restate-metric-observation": return response(await restateMetricObservation(ctx, input), 201);
      case "record-benchmark-observation": return response(await recordBenchmarkObservation(ctx, { ...input, periodStart: dt(input.periodStart), periodEnd: dt(input.periodEnd) }), 201);
      case "restate-benchmark-observation": return response(await restateBenchmarkObservation(ctx, input), 201);
      case "record-outcome": return response(await recordOutcome(ctx, { ...input, observedAt: dt(input.observedAt), validFrom: dt(input.validFrom), validTo: maybeDate(input.validTo) }), 201);
      case "record-exit": return response(await recordExit(ctx, {
        ...input, observedAt: dt(input.observedAt), announcedAt: maybeDate(input.announcedAt), signedAt: maybeDate(input.signedAt),
        closedAt: maybeDate(input.closedAt), cancelledAt: maybeDate(input.cancelledAt),
      }), 201);
      case "record-fact-coverage": return response(await recordFactCoverage(ctx, { ...input, validFrom: dt(input.validFrom), validTo: maybeDate(input.validTo) }), 201);
      case "revise-fact-coverage": return response(await reviseFactCoverage(ctx, input), 201);
      case "record-identity-resolution": return response(await recordIdentityResolution(ctx, {
        ...input, validFrom: maybeDate(input.validFrom), validTo: maybeDate(input.validTo), observedAt: maybeDate(input.observedAt),
      }), 201);
      case "resolve-identity-as-known": return response(await resolveIdentityAsKnown(ctx, { sourceLinkId: input.sourceLinkId, validAt: dt(input.validAt), knowledgeAt: dt(input.knowledgeAt) }));
      case "closed-world-claim": return response(await closedWorldClaimPermitted(ctx, { ...input, validAt: dt(input.validAt), knowledgeAt: maybeDate(input.knowledgeAt) }));
    }
  } catch (error) {
    return requestError(error);
  }
}
