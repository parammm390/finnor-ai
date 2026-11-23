import type { PoolClient } from "pg";
import type { ExperimentRef } from "@finnor/shared-types";
import type { PeMutationContext } from "../../types";
import { persistEconomicRecordTx } from "../../economic-store";
import { PRODUCT_LOCK, CONSUMER_VERSION, canonical, digest, type Artifact, type Build, type Certificate,
  type IndependentCheck, type SessionRow } from "./contracts";
import { reference } from "./store";
export async function recordCostTx(ctx: PeMutationContext, c: PoolClient, row: SessionRow, physicalId: string,
  stage: "CLAIM" | "COMPUTE" | "ACCEPT" | "REPLACEMENT" | "REFUSAL", details: Record<string, unknown>) {
  const result = await persistEconomicRecordTx(ctx, {
    kind: "COMPUTE", rightsRef: row.cut.rightsRef, idempotencyKey: `z5:${row.id}:${physicalId}:${stage}`,
    estimandId: row.cut.estimandRef.id, validAt: new Date().toISOString(), horizon: "H0",
    uncertainty: "MATERIAL_EXTRACTION_CHECKING_INTEGRATION_INSTALL_HUMAN_AND_INTERRUPTED_COST_GAPS",
    dependencies: [row.request.assignmentRef, row.request.parentReservation, ...row.cut.originalObligationRefs],
    semanticRequestDigest: digest({ requestId: row.id, physicalId, stage, details }),
    payload: { schema: "finnor.z5.full-cost-record.v1", workId: row.work_id, episodeId: row.work_id,
      requestId: row.id, originalAssignment: row.request.assignmentRef, stage, physicalId, ...details,
      costs: { money: null, humanSeconds: null, providerBilling: null, financialReleaseSufficient: false },
      accounting: "OBSERVED_PHYSICAL_INTERVAL_AND_ORIGINAL_S5_DEBIT_NOT_BILLING",
      gaps: ["UNMETERED_MONEY_HUMAN_EXTRACTION_INTEGRATION_INSTALL_RECOVERY", "INTERRUPTED_TAIL_UNKNOWN_UNTIL_TERMINAL_RECORD"],
      originalDeadline: row.request.originalDeadline, reservationRef: row.request.parentReservation,
      unresolvedObligationRefs: row.cut.originalObligationRefs, newAllowance: false, financialCreditGranted: false },
  }, c);
  return result.record.ref as ExperimentRef;
}
export function buildArtifact(row: SessionRow, certificate: Certificate, check: IndependentCheck, build: Build,
  chargeRef: ExperimentRef, costRef: ExperimentRef): Artifact {
  const checker = build.files.find(f => f.path.endsWith("/z5-institution-linker/checker.py"));
  if (!checker || check.inputDigest !== digest(row.input) || certificate.inputDigest !== check.inputDigest)
    throw Error("Z5_ARTIFACT_ORIGINAL_CHECK_BINDING");
  const payload = { requestId: row.id, generation: row.generation, input: row.input, certificate, check,
    ownerCut: row.cut, originalRequest: row.request, producerBuild: build };
  const immutableArtifactDigest = digest(payload);
  const envelope: Artifact["envelope"] = {
    schemaVersion: "finnor.project-z.logical-envelope.v1", phase: "Z5", principalOutputType: "InstitutionCompositionCertificate",
    immutableArtifactDigest, productLockDigest: PRODUCT_LOCK, sourceCommit: build.sourceCommit, sourceTree: build.sourceTree,
    producerBuildIdentity: build, originalTenant: row.tenant_id, principal: row.principal_id,
    Work: { id: row.work_id, inputId: row.work_input_id, inputDigest: row.work_input_digest, root: row.root },
    mandate: row.request.mandateRef, assignment: row.request.assignmentRef, parentReservation: row.request.parentReservation,
    originalDeadline: row.request.originalDeadline, remainingBudgetReference: row.request.parentReservation,
    unresolvedObligationReferences: row.cut.originalObligationRefs, inputSemanticsAndRevisionReferences: [row.profile_ref],
    rightsAndPermittedUseFingerprint: digest({ rightsRevision: row.rights_revision, dependencies: row.cut.dependencies, root: row.root }),
    supportedDomain: "FINITE_EXACT_FIXED_KERNELS_WITH_DECLARED_CURRENT_NATIVE_EXTRACTION_NOT_WHOLE_CODE",
    unsupportedConditions: ["ARBITRARY_TYPESCRIPT_SQL_PROVIDER_CORRESPONDENCE", "NEW_COMPONENT_SYNTHESIS", "INEVITABLE_OR_RECURRING_LIVENESS", "MAXIMAL_CONTEXT"],
    claimAndEvidenceClasses: ["deterministic", "partial", "blocked-external"],
    checkerIdentityAndResultReferences: { checkerSha256: checker.sha256, result: check },
    currentnessDependencies: row.cut,
    securityAndConfidentialityProfile: { childCredentials: "REMOVED", network: "NO_NETWORK_CODE_OR_INPUT_CAPABILITY_NOT_OS_NETWORK_SANDBOX",
      filesystem: "PINNED_TRUSTED_SOURCE_AND_STDIO_ONLY_NOT_ADVERSARIAL_CODE_SANDBOX",
      producerHeapMiB: 384, childRssLimitMiB: 640, checkerAddressSpaceMiB: 512,
      childWallMs: 35000, checkerCpuSeconds: 35, privateObservations: "ORIGINAL_LAWFUL_OWNER_ONLY_PUBLIC_CONTEXT_OFFERS_UNIFORM" },
    ownerConsumerContractVersion: CONSUMER_VERSION, costAndResourceReceiptReferences: [chargeRef, costRef],
    gaps: ["PROTECTED_COMPONENT_ADMISSION_AND_NATIVE_WHOLE_CODE_CORRESPONDENCE_NOT_ESTABLISHED",
      "MATERIAL_MONEY_HUMAN_AND_FIELD_COSTS_UNMETERED", "NO_EQUIPPED_INCREMENT_OR_FINANCIAL_100X"],
    reconstructionReference: "finnor-os/scripts/project-z/z5/reconstruct.mjs",
  };
  const content = { schema: "finnor.z5.native-artifact.v1" as const, payload, envelope, certificate };
  return { ...content, ref: reference("S4", "institution-composition-certificate", JSON.parse(canonical(content))) };
}
