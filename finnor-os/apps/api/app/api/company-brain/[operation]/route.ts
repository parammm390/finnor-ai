import {
  COMPANY_BRAIN_NAMESPACES,
  CORE_BRAIN_OBJECT_TYPES,
  PE_ENTITY_TYPES,
  PLANNING_BRAIN_OBJECT_TYPES,
  UNDERWRITING_BRAIN_OBJECT_TYPES,
  WORKFORCE_BRAIN_OBJECT_TYPES,
  PeDomainError,
  companyBrainDecisionLineage,
  companyBrainEvidenceLineage,
  companyBrainHistory,
  companyBrainObject,
  companyBrainProvenance,
  listCompanyBrainRoots,
  loadCompanyBrainProjection,
  parseCompanyBrainObjectRef,
  resolvePeOperatingContext,
  searchCompanyBrainProjection,
  traverseCompanyBrain,
  type CompanyBrainObjectRef,
  type PeMutationContext,
} from "@finnor/private-equity";
import { z } from "zod";
import { errorResponse, requireContext } from "../../../../lib/auth";

export const runtime = "nodejs";

const UuidSchema = z.string().uuid();
const TimestampSchema = z.string().datetime({ offset: true });
const RootSchema = z.object({
  entityType: z.enum(["pe_strategy", "pe_opportunity", "pe_deal"]),
  entityId: UuidSchema,
}).strict();

const PrivateEquityRefSchema = z.object({
  namespace: z.literal(COMPANY_BRAIN_NAMESPACES[0]),
  owner: z.literal("@finnor/private-equity"),
  type: z.enum(PE_ENTITY_TYPES),
  id: UuidSchema,
  revisionId: z.string().trim().min(1).max(256).optional(),
}).strict();
const CoreRefSchema = z.object({
  namespace: z.literal("core"),
  owner: z.enum(["@finnor/db", "@finnor/read-models"]),
  type: z.enum(CORE_BRAIN_OBJECT_TYPES),
  id: z.string().trim().min(1).max(512),
  revisionId: z.string().trim().min(1).max(512).optional(),
}).strict();
const UnderwritingRefSchema = z.object({
  namespace: z.literal("underwriting"),
  owner: z.literal("@finnor/private-equity"),
  type: z.enum(UNDERWRITING_BRAIN_OBJECT_TYPES),
  id: UuidSchema,
  revisionId: z.string().trim().min(1).max(256).optional(),
}).strict();
const PlanningRefSchema = z.object({
  namespace: z.literal("planning"),
  owner: z.literal("@finnor/db"),
  type: z.enum(PLANNING_BRAIN_OBJECT_TYPES),
  id: z.string().trim().min(1).max(512),
  revisionId: z.string().trim().min(1).max(512).optional(),
}).strict();
const WorkforceRefSchema = z.object({
  namespace: z.literal("workforce"),
  owner: z.enum(["@finnor/db", "@finnor/read-models"]),
  type: z.enum(WORKFORCE_BRAIN_OBJECT_TYPES),
  id: UuidSchema,
  revisionId: z.string().trim().min(1).max(256).optional(),
}).strict();
const RefSchema = z.discriminatedUnion("namespace", [PrivateEquityRefSchema, CoreRefSchema, UnderwritingRefSchema, PlanningRefSchema, WorkforceRefSchema]);

const RootedSchema = z.object({ root: RootSchema, asOf: TimestampSchema.optional() }).strict();
const RootedRefSchema = z.object({ root: RootSchema, ref: RefSchema, asOf: TimestampSchema.optional() }).strict();
const SearchSchema = z.object({ query: z.string().trim().max(240).default(""), root: RootSchema.optional(), asOf: TimestampSchema.optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
const TraverseSchema = z.object({
  root: RootSchema,
  ref: RefSchema,
  asOf: TimestampSchema.optional(),
  depth: z.number().int().min(0).max(4).optional(),
  limit: z.number().int().min(1).max(250).optional(),
  direction: z.enum(["outbound", "inbound", "both"]).optional(),
}).strict();
const HistorySchema = z.object({ root: RootSchema, ref: RefSchema, limit: z.number().int().min(1).max(100).optional() }).strict();
const ContextSchema = z.object({
  root: RootSchema.nullable(),
  selectedObject: RefSchema.nullable(),
  workId: UuidSchema.nullable(),
}).strict();

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "private, no-store" } });
}

function requestError(error: unknown): Response {
  if (error instanceof z.ZodError) return response({ error: "Invalid Company Brain request", code: "INVALID_REQUEST", issues: error.issues.slice(0, 20) }, 400);
  if (error instanceof PeDomainError) {
    const status = /NOT_FOUND/.test(error.code) ? 404 : /LIMIT/.test(error.code) ? 413 : /INVALID|UNSUPPORTED/.test(error.code) ? 400 : 422;
    return response({ error: error.message, code: error.code, details: error.details }, status);
  }
  return errorResponse(error);
}

async function json(req: Request): Promise<unknown> {
  const length = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > 64 * 1024) throw new PeDomainError("PE_BRAIN_LIMIT", "Company Brain request exceeds 64 KiB");
  return req.json().catch(() => { throw new PeDomainError("PE_BRAIN_INVALID", "Company Brain request body must be JSON"); });
}

function checkedRef(value: unknown): CompanyBrainObjectRef {
  const ref = parseCompanyBrainObjectRef(value);
  if (!ref) throw new PeDomainError("PE_BRAIN_INVALID_REF", "Company Brain object reference is invalid");
  return ref;
}

export async function POST(req: Request, { params }: { params: Promise<{ operation: string }> }): Promise<Response> {
  try {
    const [auth, body, route] = await Promise.all([requireContext(req), json(req), params]);
    const ctx: PeMutationContext = { auth };
    switch (route.operation) {
      case "roots": {
        const input = SearchSchema.pick({ query: true, limit: true }).parse(body);
        return response({ results: await listCompanyBrainRoots(ctx, input) });
      }
      case "projection": {
        const input = RootedSchema.parse(body);
        return response(await loadCompanyBrainProjection(ctx, input));
      }
      case "search": {
        const input = SearchSchema.parse(body);
        if (!input.root) return response({ results: await listCompanyBrainRoots(ctx, { query: input.query, limit: input.limit }) });
        const projection = await loadCompanyBrainProjection(ctx, { root: input.root, asOf: input.asOf });
        return response({ results: searchCompanyBrainProjection(projection, input.query, input.limit) });
      }
      case "object": {
        const input = RootedRefSchema.parse(body); const ref = checkedRef(input.ref);
        const projection = await loadCompanyBrainProjection(ctx, { root: input.root, asOf: input.asOf });
        const node = companyBrainObject(projection, ref);
        if (!node) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "Company Brain object was not found in the authenticated root projection");
        return response({ object: node });
      }
      case "traverse": {
        const input = TraverseSchema.parse(body); const ref = checkedRef(input.ref);
        const projection = await loadCompanyBrainProjection(ctx, { root: input.root, asOf: input.asOf });
        return response(traverseCompanyBrain(projection, ref, input));
      }
      case "provenance": {
        const input = RootedRefSchema.parse(body); const ref = checkedRef(input.ref);
        const projection = await loadCompanyBrainProjection(ctx, { root: input.root, asOf: input.asOf });
        return response(companyBrainProvenance(projection, ref));
      }
      case "history": {
        const input = HistorySchema.parse(body);
        return response(await companyBrainHistory(ctx, { root: input.root, ref: checkedRef(input.ref), limit: input.limit }));
      }
      case "evidence-lineage": {
        const input = RootedRefSchema.parse(body); const ref = checkedRef(input.ref);
        const projection = await loadCompanyBrainProjection(ctx, { root: input.root, asOf: input.asOf });
        return response(companyBrainEvidenceLineage(projection, ref));
      }
      case "decision-lineage": {
        const input = RootedRefSchema.parse(body); const ref = checkedRef(input.ref);
        const projection = await loadCompanyBrainProjection(ctx, { root: input.root, asOf: input.asOf });
        return response(companyBrainDecisionLineage(projection, ref));
      }
      case "available-actions": {
        const input = RootedRefSchema.parse(body); const ref = checkedRef(input.ref);
        const projection = await loadCompanyBrainProjection(ctx, { root: input.root, asOf: input.asOf });
        const node = companyBrainObject(projection, ref);
        if (!node) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "Company Brain object was not found in the authenticated root projection");
        return response({ ref: node.ref, actions: node.availableActions, authorization: "evaluated_at_execution" });
      }
      case "context": {
        const input = ContextSchema.parse(body);
        if (!input.root) {
          return response({ context: resolvePeOperatingContext(null, { root: null, selectedObject: input.selectedObject ? checkedRef(input.selectedObject) : null, workId: input.workId }) });
        }
        const projection = await loadCompanyBrainProjection(ctx, { root: input.root });
        const selectedObject = input.selectedObject ? checkedRef(input.selectedObject) : null;
        return response({ context: resolvePeOperatingContext(projection, { root: input.root, selectedObject, workId: input.workId }) });
      }
      default:
        return response({ error: "Unknown Company Brain operation", code: "NOT_FOUND" }, 404);
    }
  } catch (error) {
    return requestError(error);
  }
}
