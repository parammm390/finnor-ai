import assert from "node:assert/strict";
import { z } from "zod";
import type { AllocationResource, AllocationResourceInput, BeliefViewPin, ExperimentRef } from "@finnor/shared-types";
import { AllocationOperationSchemas, AllocationResourceInputSchema, sameAllocationRef } from "../../../packages/epistemic-runtime/src/allocation-contracts";
import { ExperimentRefSchema } from "../../../packages/epistemic-runtime/src/experiments";
import type { IntegratedOwnerPorts } from "./owner-journey.mts";

export interface SharedAllocationFixture {
  begin: string;
  rightsRef: string;
  horizon: AllocationResource["horizon"];
}

const resourceSchema = AllocationResourceInputSchema.extend({
  ref: ExperimentRefSchema, revision: z.number().int().positive(), priorRef: ExperimentRefSchema.nullable(),
});
const portfolioSchema = z.object({ resources: z.array(resourceSchema).min(1).max(16) });

export function completeSharedAllocation(input: unknown, snapshot: unknown) {
  const original = AllocationOperationSchemas.clear.parse(input);
  const { resources } = portfolioSchema.parse(snapshot);
  assert(original.resourceRefs.every(ref => resources.some(row => sameAllocationRef(row.ref, ref))),
    "W049_ORIGINAL_ALLOCATION_RESOURCE_REF_MUST_REMAIN_CURRENT");
  return { ...original, resourceRefs: resources.map(row => row.ref) };
}

export type ResourceDeclaration = Pick<AllocationResourceInput, "resourceId" | "resourceClass" | "unit" | "kind" | "permittedRoots"> & {
  capacity: string;
};

export interface SharedCapacityBasis { sourceRef: ExperimentRef; pin: BeliefViewPin }

export async function readSharedCapacityBasis(http: IntegratedOwnerPorts["http"], fixture: SharedAllocationFixture,
  owner: string, root: BeliefViewPin["root"], sourceRef: ExperimentRef): Promise<SharedCapacityBasis> {
  const belief = await http("company-brain", "belief-view", { root, validAt: fixture.horizon.startAt }, owner);
  assert.equal(belief.status, 200, "W049_SIGNED_SHARED_RESOURCE_SOURCE_REQUIRED");
  const view = z.object({ pin: AllocationResourceInputSchema.shape.beliefPins.element,
    rights: z.object({ ref: z.string() }),
    coverage: z.object({ canonicalStatus: z.literal("COMPLETE"), truncated: z.literal(false) }),
    claims: z.array(z.object({ ownerRef: z.object({ id: z.string(), entityType: z.string() }) })),
  }).parse(belief.body);
  assert.equal(view.rights.ref, fixture.rightsRef, "W049_SHARED_RESOURCE_AUTHORITY_CHANGED");
  assert(view.claims.some(claim => claim.ownerRef.entityType === "evidence_source_version" &&
    claim.ownerRef.id === sourceRef.id), "W049_SHARED_CAPACITY_SOURCE_NOT_VISIBLE");
  return { sourceRef, pin: view.pin };
}

export async function declareSharedResources(
  http: IntegratedOwnerPorts["http"], fixture: SharedAllocationFixture, basis: SharedCapacityBasis,
  scope: { tenant: string; owner: string; companyId: string }, declarations: readonly ResourceDeclaration[],
) {
  const { ownerFixtureReference } = await import("../../s5/owner-fixture.mts");
  const validUntil = new Date(Date.parse(fixture.horizon.startAt) + 7_200_000).toISOString();
  const resources = new Map<string, AllocationResource>();
  for (const { capacity, ...declaration } of declarations) {
    assert(!resources.has(declaration.resourceId), "W049_DUPLICATE_SHARED_RESOURCE_DECLARATION");
    const input: AllocationResourceInput = {
      ...declaration, schema: "finnor.allocation-resource.v1", tenantId: scope.tenant,
      ownerRef: ownerFixtureReference(scope.owner, "BUSINESS_OWNER"), legalEntityRef: ownerFixtureReference(scope.companyId, "S1"),
      scopeRef: ownerFixtureReference(declaration.resourceId, "BUSINESS_OWNER"),
      sourceRef: basis.sourceRef,
      rightsRef: fixture.rightsRef, horizon: fixture.horizon, currency: declaration.unit === "USD" ? "USD" : null,
      asOf: basis.pin.knowledgeAt, knowledgeAt: basis.pin.knowledgeAt, validUntil, beliefPins: [basis.pin],
      availability: [capacity, capacity].map(amount => ({ amount, basis: "REPORTED_AVAILABLE" })),
      existingUse: ["0", "0"], safetyMargin: "0", covenants: [], revoked: false,
      qualification: "AUTHENTICATED_OWNER_ASSERTION_UNADMITTED",
    };
    const registered = await http("allocations", "resource", { resource: input }, scope.owner);
    assert.equal(registered.status, 200, "W049_SHARED_RESOURCE_REGISTRATION_FAILED:" + declaration.resourceId);
    const row = resourceSchema.parse(registered.body);
    const { ref: _ref, revision, priorRef, ...body } = row;
    assert.equal(revision, 1);
    assert.equal(priorRef, null);
    assert(sameAllocationRef(input, body), "W049_SHARED_RESOURCE_INPUT_CHANGED");
    resources.set(row.resourceId, row);
  }
  return resources;
}
