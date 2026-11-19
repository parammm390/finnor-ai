/** Read an already approved qualification. Never manufacture or renew one. */
import { z } from "zod";
import { digest, fault, RefSchema, sameRef, type CapabilityRef } from "../../capability-evolution/src/contracts";
import { canonicalDeploymentQualificationSchema } from "../../capability-evolution/src/specialist-publication-authority";
import { assertVerifiedEnrollment, immutable, integer, primarySchema,
  type VerifiedEnrollment } from "../../capability-evolution/src/specialist-publication-protocol";
import { readOwnerTransportReference } from "./owner-transport";
const text = z.string().min(1).max(4096), hex = z.string().regex(/^[a-f0-9]{64}$/);
const range = z.object({ lower: integer, upper: integer }).strict().refine(v => BigInt(v.lower) < BigInt(v.upper));
export const originalClockQualificationSchema = z.object({
  schema: z.literal("finnor.specialist.actual-original-clock-qualification.v1"),
  enrollmentScopeDigest: hex, sourceClosureDigest: hex, runtimeDigest: hex, primary: primarySchema,
  hostPolicyDigest: hex, witnessDirectory: text, clockAuthorityKeyId: text, bootId: z.string().uuid(),
  clockNamespaceDevice: integer, clockNamespaceInode: integer,
  nativeSamplerPath: text, nativeSamplerSha256: hex,
  qualifiedUtcCoverage: range, qualifiedMonotonicCoverage: range,
  utcErrorMicros: integer, dbErrorMicros: integer,
  driftPartsPerBillion: integer.refine(value => BigInt(value) < 1000000000n),
  qualificationBasis: z.literal("CONTINUOUS_ORIGINAL_CLOCK_RELATION"),
  evidenceRefs: z.array(RefSchema).min(1).max(64),
}).strict();
export type OriginalClockQualification = z.infer<typeof originalClockQualificationSchema>;
export async function readOriginalClockQualification(enrollment: VerifiedEnrollment, rawRef: CapabilityRef) {
  assertVerifiedEnrollment(enrollment);
  const ref = immutable(RefSchema.parse(rawRef)), e = enrollment.body,
    context = { semanticOwner: "S8" as const, tenantId: e.tenantId, principalId: e.principalId };
  const found = await readOwnerTransportReference(context, e.qualifiedDeploymentRef.id),
    deployment = canonicalDeploymentQualificationSchema.parse(found.reference.content),
    { qualifiedDeploymentRef: _qualifiedDeployment, ...scope } = e;
  if (!found.receipt || !sameRef(found.reference, e.qualifiedDeploymentRef)
    || digest(found.reference.content) !== e.qualifiedDeploymentRef.contentDigest
    || deployment.enrollmentScopeDigest !== digest(scope) || deployment.sourceClosureDigest !== e.sourceClosureDigest
    || deployment.runtimeDigest !== e.runtimeDigest || digest(deployment.primary) !== digest(e.primary)
    || !deployment.witnessQualificationRefs.some(approved => sameRef(approved, ref)))
    fault("SPECIALIST_CLOCK_GENUINE_DEPLOYMENT_QUALIFICATION_REQUIRED", 503);
  const record = await readOwnerTransportReference(context, ref.id),
    q = originalClockQualificationSchema.parse(record.reference.content);
  if (!record.receipt || !sameRef(record.reference, ref) || digest(record.reference.content) !== ref.contentDigest
    || q.enrollmentScopeDigest !== digest(scope) || q.sourceClosureDigest !== e.sourceClosureDigest
    || q.runtimeDigest !== e.runtimeDigest || digest(q.primary) !== digest(e.primary))
    fault("SPECIALIST_CLOCK_GENUINE_CONTINUOUS_QUALIFICATION_REQUIRED", 503);
  for (const evidenceRef of q.evidenceRefs) {
    const evidence = await readOwnerTransportReference(context, evidenceRef.id);
    if (!evidence.receipt || !sameRef(evidence.reference, evidenceRef)
      || digest(evidence.reference.content) !== evidenceRef.contentDigest)
      fault("SPECIALIST_CLOCK_QUALIFICATION_EVIDENCE_REQUIRED", 503);
  }
  return immutable({ body: q, reference: ref });
}
