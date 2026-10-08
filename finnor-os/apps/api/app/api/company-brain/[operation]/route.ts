import {
  COMPANY_BRAIN_NAMESPACES,
  CORE_BRAIN_OBJECT_TYPES,
  EPISTEMIC_BRAIN_OBJECT_TYPES,
  PE_ENTITY_TYPES,
  PE_WORLD_ROOT_TYPES,
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
  loadEnterpriseBeliefView,
  validateBeliefViewPin,
  handleDecisionSliceOperation,DecisionSliceError,M1_OPERATIONS,inM1Episode,m1TransportDeadline,readM1BodyChunk,
  parseCompanyBrainObjectRef,
  resolvePeOperatingContext,
  searchCompanyBrainProjection,
  traverseCompanyBrain,
  type CompanyBrainObjectRef,
  type PeMutationContext,
} from "@finnor/private-equity";
import { z } from "zod";
import { errorResponse, requireContext } from "../../../../lib/auth";
import {handleEvidenceOperation,EVIDENCE_OPERATIONS} from '@finnor/private-equity/src/evidence-execution/api';
import {handleComputeSearchOperation,COMPUTE_SEARCH_OPERATIONS} from '@finnor/private-equity/src/compute-search/api';
import {handleDeliberationOperation,DELIBERATION_OPERATIONS} from '@finnor/private-equity/src/deliberation/api';
import {DeliberationDeadlineError,deliberationTransportDeadline,inDeliberationDeadline} from '@finnor/private-equity/src/deliberation/deadline';
import {handleProgramOperation,PROGRAM_OPERATIONS} from '@finnor/private-equity/src/program-synthesis/api';
import {handleInterfaceOperation,INTERFACE_OPERATIONS} from '@finnor/private-equity/src/interface-synthesis/api';
import {handleContinuationOperation,CONTINUATION_OPERATIONS} from '@finnor/private-equity/src/live-recompilation/api';
import {handleProcedureOperation,PROCEDURE_OPERATIONS} from '@finnor/private-equity/src/procedure-induction/api';
import {handleCapitalProgramOperation,CAPITAL_PROGRAM_V2_OPERATIONS,capitalProgramResponseError} from '@finnor/private-equity/src/capital-program/v2-api';
import {inM3Episode,m3TransportDeadline,readM3Body} from '@finnor/private-equity/src/capital-program/v2-budget';
import {M4_OPERATIONS,handleCounterexampleOperation} from '@finnor/private-equity/src/counterexample-search/handler';
import {ChallengeError} from '@finnor/private-equity/src/counterexample-search/contracts';
import {inChallengeEpisode,transportDeadline,readChallengeBody} from '@finnor/private-equity/src/counterexample-search/budget';

export const runtime = "nodejs";

const UuidSchema = z.string().uuid();
const TimestampSchema = z.string().datetime({ offset: true });
const RootSchema = z.object({
  entityType: z.enum(PE_WORLD_ROOT_TYPES),
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
const EpistemicRefSchema = z.object({
  namespace: z.literal("epistemic"),
  owner: z.literal("@finnor/epistemic-runtime"),
  type: z.enum(EPISTEMIC_BRAIN_OBJECT_TYPES),
  id: z.string().trim().min(1).max(1024),
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
const RefSchema = z.discriminatedUnion("namespace", [PrivateEquityRefSchema, CoreRefSchema, EpistemicRefSchema, UnderwritingRefSchema, PlanningRefSchema, WorkforceRefSchema]);

const TemporalFields = { asOf: TimestampSchema.optional(), validAt: TimestampSchema.optional(), knowledgeAt: TimestampSchema.optional() };
const RootedSchema = z.object({ root: RootSchema, ...TemporalFields }).strict();
const DecisionSchema = z.object({
  id: z.string().trim().min(1).max(256), version: z.string().trim().min(1).max(128),
  evidenceUniverse: z.literal("registered_canonical_records"),
  requirements: z.array(z.object({
    id: z.string().trim().min(1).max(256), subject: z.object({ entityType: z.string().trim().min(1).max(128), entityId: UuidSchema }).strict(),
    metricKey: z.string().trim().min(1).max(256), unit: z.string().trim().min(1).max(128), currencyCode: z.string().regex(/^[A-Z]{3}$/).nullable(),
    periodStart: TimestampSchema, periodEnd: TimestampSchema, operator: z.enum(["gte", "lte", "eq"]),
    threshold: z.string().regex(/^[+-]?\d+(?:\.\d+)?$/).max(128), maximumAgeMs: z.number().finite().nonnegative().optional(),
  }).strict()).min(1).max(64),
}).strict();
const BeliefViewSchema = z.object({ root: RootSchema, validAt: TimestampSchema.optional(), knowledgeAt: TimestampSchema.optional(),
  maxClaims: z.number().int().min(1).max(1000).optional(), decisionContext: DecisionSchema.optional() }).strict();
const BeliefPinSchema = z.object({ tenantId: UuidSchema, principalId: UuidSchema, root: RootSchema, validAt: TimestampSchema, knowledgeAt: TimestampSchema,
  dependencyDigest: z.string().regex(/^[a-f0-9]{64}$/), rightsRevision: z.number().int().positive().safe(), interpretationVersion: z.string().min(1).max(128) }).strict();
const RootedRefSchema = z.object({ root: RootSchema, ref: RefSchema, ...TemporalFields }).strict();
const SearchSchema = z.object({ query: z.string().trim().max(240).default(""), root: RootSchema.optional(), ...TemporalFields, limit: z.number().int().min(1).max(100).optional() }).strict();
const TraverseSchema = z.object({
  root: RootSchema,
  ref: RefSchema,
  ...TemporalFields,
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
  if(error instanceof ChallengeError){const status=error.code==='UNAVAILABLE'?404:['STALE_INPUT','CONFLICT','CANCELLED','PENDING_M3_READER'].includes(error.code)?409:error.code==='LIMIT_EXCEEDED'?413:error.code==='INVALID_REQUEST'?400:error.code==='CONFIGURATION_REQUIRED'?503:422;return response({error:error.message,code:error.code},status);}
  if(error instanceof DeliberationDeadlineError)return response({code:'M2_LIMIT_EXCEEDED',predicate:error.message},413);
  if(error instanceof Error&&error.message==='M2_INVALID_TRANSPORT_DEADLINE')return response({code:'M2_SCHEMA_INVALID',predicate:error.message},400);
  if(error instanceof DecisionSliceError){const status=error.code==='UNAVAILABLE'?404:['STALE_INPUT','CONFLICT','CANCELLED'].includes(error.code)?409:error.code==='LIMIT_EXCEEDED'?413:error.code==='INVALID_REQUEST'?400:error.code==='CONFIGURATION_REQUIRED'?503:422;return response({error:error.message,code:error.code},status);}

  if (error instanceof z.ZodError) return response({ error: "Invalid Company Brain request", code: "INVALID_REQUEST", issues: error.issues.slice(0, 20) }, 400);
  if (error instanceof PeDomainError) {
    const status = /NOT_FOUND/.test(error.code) ? 404 : /LIMIT/.test(error.code) ? 413 : /INVALID|UNSUPPORTED/.test(error.code) ? 400 : 422;
    return response({ error: error.message, code: error.code, details: error.details }, status);
  }
  return errorResponse(error);
}

async function json(req: Request): Promise<unknown> {
  const limit = 64 * 1024;
  const length = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > limit) {
    await req.body?.cancel().catch(() => undefined);
    throw new PeDomainError("PE_BRAIN_LIMIT", "Company Brain request exceeds 64 KiB");
  }
  if (!req.body) throw new PeDomainError("PE_BRAIN_INVALID", "Company Brain request body must be JSON");
  const reader = req.body.getReader();
  const bytes = new Uint8Array(limit);
  let size = 0;
  try {
    while (true) {
      const chunk = await readM1BodyChunk(reader);
      if (chunk.done) break;
      if (chunk.value.byteLength > limit - size) {
        await reader.cancel().catch(() => undefined);
        throw new PeDomainError("PE_BRAIN_LIMIT", "Company Brain request exceeds 64 KiB");
      }
      bytes.set(chunk.value, size); size += chunk.value.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, size)));
  } catch (error) {
    if (error instanceof PeDomainError || error instanceof DecisionSliceError) throw error;
    throw new PeDomainError("PE_BRAIN_INVALID", "Company Brain request body must be JSON");
  } finally { reader.releaseLock(); }
}

function checkedRef(value: unknown): CompanyBrainObjectRef {
  const ref = parseCompanyBrainObjectRef(value);
  if (!ref) throw new PeDomainError("PE_BRAIN_INVALID_REF", "Company Brain object reference is invalid");
  return ref;
}

export async function POST(req: Request, { params }: { params: Promise<{ operation: string }> }): Promise<Response> {
  try {const route=await params;
    if(M4_OPERATIONS.has(route.operation)){
      return await inChallengeEpisode(transportDeadline(req),async()=>{
        const prepared=await Promise.allSettled([requireContext(req),readChallengeBody(req)]),
          failed=prepared.find(result=>result.status==='rejected');
        if(failed?.status==='rejected')throw failed.reason;
        const auth=(prepared[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof requireContext>>>).value,
          body=(prepared[1] as PromiseFulfilledResult<unknown>).value,
          result=await handleCounterexampleOperation({auth},route.operation,body);
        return response(result.body,result.status);
      },req.signal);
    }
    if(CAPITAL_PROGRAM_V2_OPERATIONS.has(route.operation)){
      try{return await inM3Episode(m3TransportDeadline(req),async()=>{
        const prepared=await Promise.allSettled([requireContext(req),readM3Body(req)]),
          failed=prepared.find(result=>result.status==='rejected');
        if(failed?.status==='rejected')throw failed.reason;
        const auth=(prepared[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof requireContext>>>).value,
          body=(prepared[1] as PromiseFulfilledResult<unknown>).value,
          result=await handleCapitalProgramOperation({auth},route.operation,body);
        return response(result.body,result.status);
      });}catch(error){const mapped=capitalProgramResponseError(error);return mapped?response(mapped.body,mapped.status):requestError(error);}
    }
    if(M1_OPERATIONS.has(route.operation))return await inM1Episode(m1TransportDeadline(req),()=>dispatchPost(req,route));
    if((DELIBERATION_OPERATIONS as readonly string[]).includes(route.operation))return await inDeliberationDeadline(deliberationTransportDeadline(req),()=>dispatchPost(req,route));
    return await dispatchPost(req,route);
  }catch(error){return requestError(error);}
}
async function dispatchPost(req:Request,route:{operation:string}):Promise<Response>{
  try {
    const prepared=await Promise.allSettled([requireContext(req),json(req)]);const failed=prepared.find(p=>p.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
    const auth=(prepared[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof requireContext>>>).value,body=(prepared[1] as PromiseFulfilledResult<unknown>).value;
    const ctx: PeMutationContext = { auth };
    if((CONTINUATION_OPERATIONS as readonly string[]).includes(route.operation)){const result=await handleContinuationOperation(ctx,route.operation,body);return response(result.body,result.status);}
    if ((PROCEDURE_OPERATIONS as readonly string[]).includes(route.operation)) { const result=await handleProcedureOperation(ctx,route.operation,body);return response(result.body,result.status); }
    if(M1_OPERATIONS.has(route.operation))return response(await handleDecisionSliceOperation(ctx,route.operation,body));
    if((INTERFACE_OPERATIONS as readonly string[]).includes(route.operation)){const result=await handleInterfaceOperation(ctx,route.operation,body);return response(result.body,result.status);}
    if((DELIBERATION_OPERATIONS as readonly string[]).includes(route.operation)){const result=await handleDeliberationOperation(ctx,route.operation,body);return response(result.body,result.status);}
    if((COMPUTE_SEARCH_OPERATIONS as readonly string[]).includes(route.operation)){const result=await handleComputeSearchOperation(ctx,route.operation,body);return response(result.body,result.status);}
    if((PROGRAM_OPERATIONS as readonly string[]).includes(route.operation)){const result=await handleProgramOperation(ctx,route.operation,body);return response(result.body,result.status);}
    if((EVIDENCE_OPERATIONS as readonly string[]).includes(route.operation)){const result=await handleEvidenceOperation(ctx,route.operation,body);return response(result.body,result.status);}
    switch (route.operation) {
      case "belief-view": {
        const input = BeliefViewSchema.parse(body);
        return response(await loadEnterpriseBeliefView(ctx, input));
      }
      case "belief-pin": {
        return response(await validateBeliefViewPin(ctx, BeliefPinSchema.parse(body)));
      }
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
        const projection = await loadCompanyBrainProjection(ctx, { root: input.root, asOf: input.asOf, validAt: input.validAt, knowledgeAt: input.knowledgeAt });
        return response({ results: searchCompanyBrainProjection(projection, input.query, input.limit) });
      }
      case "object": {
        const input = RootedRefSchema.parse(body); const ref = checkedRef(input.ref);
        const projection = await loadCompanyBrainProjection(ctx, input);
        const node = companyBrainObject(projection, ref);
        if (!node) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "Company Brain object was not found in the authenticated root projection");
        return response({ object: node });
      }
      case "traverse": {
        const input = TraverseSchema.parse(body); const ref = checkedRef(input.ref);
        const projection = await loadCompanyBrainProjection(ctx, input);
        return response(traverseCompanyBrain(projection, ref, input));
      }
      case "provenance": {
        const input = RootedRefSchema.parse(body); const ref = checkedRef(input.ref);
        const projection = await loadCompanyBrainProjection(ctx, input);
        return response(companyBrainProvenance(projection, ref));
      }
      case "history": {
        const input = HistorySchema.parse(body);
        return response(await companyBrainHistory(ctx, { root: input.root, ref: checkedRef(input.ref), limit: input.limit }));
      }
      case "evidence-lineage": {
        const input = RootedRefSchema.parse(body); const ref = checkedRef(input.ref);
        const projection = await loadCompanyBrainProjection(ctx, input);
        return response(companyBrainEvidenceLineage(projection, ref));
      }
      case "decision-lineage": {
        const input = RootedRefSchema.parse(body); const ref = checkedRef(input.ref);
        const projection = await loadCompanyBrainProjection(ctx, input);
        return response(companyBrainDecisionLineage(projection, ref));
      }
      case "available-actions": {
        const input = RootedRefSchema.parse(body); const ref = checkedRef(input.ref);
        const projection = await loadCompanyBrainProjection(ctx, input);
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
