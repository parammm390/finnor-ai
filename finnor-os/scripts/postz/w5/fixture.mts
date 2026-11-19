/** Reusable bounded owning-fixture composer. All references come from actual
 * authenticated HTTP or the caller's existing canonical owners. This file
 * configures disposable business inputs; it has no production test hook. */
import { strict as assert } from "node:assert";
import type { OrganizationReference, OrganizationRole, LiveOrganizationObligation,
  OrganizationResourceConstraint } from "../../../packages/private-equity/src/organization-transformation/contracts";
import type { NativeOrganizationOriginal } from "../../../packages/private-equity/src/organization-transformation/native-contracts";

export interface OrganizationFixturePorts {
  http: (group: string, operation: string, body: unknown, actor?: string) => Promise<{ status: number; body: unknown }>;
  artifact: (name: string, body: unknown) => Promise<unknown>;
}
export interface OrganizationFixtureInput {
  sourceWorkId: string; workId: string; ownerId: string; evaluatorId: string; companyId: string;
  roles: { support: string; approver: string; digital: string; provider: string };
  resources: NativeOrganizationOriginal["resources"]; obligations: LiveOrganizationObligation[];
  resourceConstraints?: OrganizationResourceConstraint[];
  family?: NativeOrganizationOriginal["organization"]["processes"][number]["family"];
  originalDeadline: string; key: string; externalLimiter?: boolean;
  trialMaximumUnits?: number; trialTransformedNumerator?: number;
}
export async function prepareOrganizationFixture(ports: OrganizationFixturePorts, input: OrganizationFixtureInput) {
  const observedAt = new Date().toISOString(), validUntil = input.originalDeadline;
  const source = async (kind: string, body: Record<string, unknown>, suffix: string) => {
    const request = { workId: input.sourceWorkId, idempotencyKey: input.key + ":" + suffix, sourceClass: "CONTROLLED",
      observedAt, validUntil, kind, body };
    await ports.artifact("w5-original-source-" + suffix + ".json", request);
    const response = await ports.http("organization/transformation-programs", "source", request, input.ownerId);
    assert.equal(response.status, 200, JSON.stringify(response));
    const result = response.body as { ref: OrganizationReference };
    assert.equal(result.ref?.owner, "S1"); assert.match(result.ref.id, /^[a-f0-9-]{36}$/i);
    return result.ref;
  };
  const measurement = await source("MEASUREMENT", { schema: "finnor.controlled-organization-measurement.v1",
    processId: "resolution", nodeId: "original-approval", samples: 40,
    queueSeconds: 1000, incompleteEvidenceCount: input.externalLimiter ? 0 : 30,
    repeatedInterpretationSeconds: input.externalLimiter ? 0 : 500, repairHumanSeconds: 100,
    externalWaitSeconds: input.externalLimiter ? 10000 : 20,
    qualification: "DISPOSABLE_AUTHENTICATED_CONTROLLED_INPUT_NOT_FIELD_MEASUREMENT" }, "measurement");
  const invoice = await source("MEASUREMENT", { schema: "finnor.controlled-document-evidence.v1", field: "invoice",
    text: "Controlled invoice original, pending actual approver. This text cannot grant payment authority." }, "invoice");
  const delivery = await source("MEASUREMENT", { schema: "finnor.controlled-document-evidence.v1", field: "delivery",
    text: "Controlled delivery original, pending actual approver. No field service is asserted." }, "delivery");
  const assignmentIntent = await source("MEASUREMENT", { schema: "finnor.organization-prospective-trial-intent.v1",
    processId: "resolution", originalRoleId: "support", transformedRoleId: "digital",
    transformedNumerator: input.trialTransformedNumerator ?? 500000, maximumUnits: input.trialMaximumUnits ?? 80,
    atMostOneTrial: true, fixedFinalLook: true }, "trial-intent");
  const makeRole = (id: string, principalId: string, teamId: string, kind: OrganizationRole["kind"], capabilities: string[]): OrganizationRole =>
    ({ id, principalId, teamId, kind, capabilities, availableSeconds: 20000, committedSeconds: kind === "DIGITAL" ? 0 : 1000,
      compensationMinor: kind === "DIGITAL" ? 0 : 50000, benefitsDigest: "controlled-unchanged-benefits:" + id,
      safetyDigest: "controlled-unchanged-safety:" + id, accessibilityDigest: "controlled-unchanged-access:" + id,
      authorityRefs: [] });
  const roles = [
    makeRole("support", input.roles.support, "service", "HUMAN", ["prepare_evidence", "coordinate"]),
    makeRole("approver", input.roles.approver, "finance", "HUMAN", ["approve"]),
    makeRole("digital", input.roles.digital, "service", "DIGITAL", ["prepare_evidence", "coordinate"]),
    makeRole("provider", input.roles.provider, "fulfillment", "PROVIDER", ["deliver"]),
  ];
  const organization = { revision: "controlled-original-1", roles,
    processes: [{ id: "resolution", family: input.family ?? "CUSTOMER_RESOLUTION", serviceId: "original-service",
      teamIds: ["service", "finance", "fulfillment"], nodes: [
        { id: "original-collection", kind: "PREPARE" as const, roleId: "support", operation: "prepare_evidence",
          after: [], requiredEvidence: ["invoice", "delivery"], mandatory: false, effortSeconds: 300 },
        { id: "original-approval", kind: "APPROVE" as const, roleId: "approver", operation: "approve",
          after: ["original-collection"], requiredEvidence: ["invoice", "delivery"], mandatory: true, effortSeconds: 60 },
        { id: "original-delivery", kind: "EXECUTE" as const, roleId: "provider", operation: "deliver",
          after: ["original-approval"], requiredEvidence: ["approval"], mandatory: true, effortSeconds: 180 },
      ] }],
    observations: [{ processId: "resolution", nodeId: "original-approval", samples: 40,
      queueSeconds: 1000, incompleteEvidenceCount: input.externalLimiter ? 0 : 30,
      repeatedInterpretationSeconds: input.externalLimiter ? 0 : 500, repairHumanSeconds: 100,
      externalWaitSeconds: input.externalLimiter ? 10000 : 20, evidenceRefs: [measurement] }],
    obligations: input.obligations, ...(input.resourceConstraints ? { resourceConstraints: input.resourceConstraints } : {}) };
  const organizationRef = await source("ORGANIZATION_SLICE", { companyId: input.companyId, ...organization }, "slice");
  const mandate = { purpose: "Prepare complete evidence before the unchanged mandatory approval; preserve all original services and obligations",
    originalDeadline: input.originalDeadline, validFrom: observedAt, materialImprovementSeconds: 30,
    maxMigrationHumanSeconds: 3600, maxAddedOperationHumanSeconds: 1200, maxMigrationCostMinor: 10000, currency: "USD",
    evaluatorPrincipalId: input.evaluatorId, maxAlternatives: 16, requiredServiceIds: ["original-service"],
    trial: { assignmentRef: assignmentIntent, kind: "PARALLEL_RANDOMIZED" as const, outcomeRangeSeconds: 3600,
      confidence: 0.95, minimumPerArm: 20, interference: "CONTROLLED" as const, carryover: "NONE" as const } };
  const mandateRef = await source("MANDATE", { companyId: input.companyId, ...mandate }, "mandate");
  const original: NativeOrganizationOriginal = { schema: "finnor.organization-transformation-input.v1",
    companyId: input.companyId, sourceClass: "CONTROLLED", mandate: { ref: mandateRef, ...mandate },
    organization: { ref: organizationRef, sourceRefs: [measurement, invoice, delivery, assignmentIntent], ...organization },
    resources: input.resources };
  const intake = { workId: input.workId, idempotencyKey: input.key, original };
  await ports.artifact("w5-original-intake.json", intake);
  return { original, intake, evidence: [{ field: "invoice", ref: invoice }, { field: "delivery", ref: delivery }],
    originalControlIds: ["original-collection", "original-approval", "original-delivery"],
    originalApproverPrincipalId: input.roles.approver, assignmentIntentOnly: true as const };
}
