/** Called ONLY by the original S8 lifecycle dispatch after its genuine signed
 * policy, actor role, scope and source closure checks. No new identity or grant.
 * The original S8 service commits/signs the result using its existing custody. */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenantTransaction, acquireComputeResourceLeases, releaseComputeResourceLeases } from "@finnor/db";
import type { PeMutationContext } from "../../types";
import { chargeInstitutionDemand } from "../../allocation-store";
import { readOwnerTransportReference } from "../../../../governed-execution/src/owner-transport";
import { digest, ordinaryDevelopment, RefSchema } from "./contracts";
import type { NativeS8Assertion } from "./native-s8";
import { checkedCurrent } from "./consumer";
import { assertOwnerCutTx } from "./owners";
import { checkedRequestTx, transaction, assertDeliveryTx, assertComputeLeasesTx } from "./store";
import { independentlyCheckInstitution } from "./process";
import { recordCostTx } from "./artifact";
import { REPOSITORY } from "./source";
const Fence = z.object({ tenantId: z.string().uuid(), protocolVersion: z.literal(1), jobId: z.string().uuid(),
  claimToken: z.string().uuid(), claimFence: z.number().int().safe().positive(), deliveryAttemptId: z.string().uuid() }).strict();
const Command = z.object({ tenantId: z.string().uuid(), principalId: z.string().uuid(), requestId: z.string().uuid(),
  physical: Fence.nullable().optional(), nativeReference: RefSchema.optional() }).strict();
export interface OriginalS8Authority {
  tenantId: string; principalId: string; rightsRef: string; domain: string; validUntil: string;
  lifecyclePolicyDigest: string; sourcePins: { path: string; sha256: string }[];
}
async function current(authority: OriginalS8Authority, raw: unknown) {
  ordinaryDevelopment();
  const body = Command.parse(raw);
  if (authority.domain !== "DISPOSABLE_TEST_AUTHORITY" || authority.tenantId !== body.tenantId
    || authority.principalId !== body.principalId || Date.parse(authority.validUntil) <= Date.now())
    throw Error("Z5_ORIGINAL_S8_AUTHORITY_SCOPE_REQUIRED");
  const auth = await withTenantTransaction(body.tenantId, { userId: body.principalId, readOnly: true }, async (_db, c) => {
    const user = (await c.query<{ id: string; role: PeMutationContext["auth"]["role"] }>(
      "SELECT id,role FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 AND status='active' AND role='owner'",
      [body.tenantId, body.principalId])).rows[0];
    if (!user) throw Error("Z5_ORIGINAL_S8_REAL_ACTIVE_DELEGATED_OWNER_REQUIRED");
    return { tenantId: body.tenantId, userId: user.id, employeeId: user.id, role: user.role };
  });
  const ctx = { auth }, retained = await checkedCurrent(ctx, body.requestId);
  if (retained.cut.rightsRef !== authority.rightsRef || retained.row.deadline_at.getTime() > Date.parse(authority.validUntil))
    throw Error("Z5_ORIGINAL_S8_RIGHTS_AND_DEADLINE_REQUIRED");
  if (!retained.build.files.every(f => authority.sourcePins.some(pin =>
    path.resolve(pin.path) === path.join(REPOSITORY, f.path) && pin.sha256 === f.sha256)))
    throw Error("Z5_ORIGINAL_S8_EXACT_PHASE_SOURCE_CLOSURE_REQUIRED");
  return { body, ctx, retained };
}
export async function evaluateInstitutionFromOriginalS8(authority: OriginalS8Authority, raw: unknown): Promise<NativeS8Assertion> {
  const { body, ctx, retained } = await current(authority, raw), { row, cut, profile, build, artifact } = retained;
  const invocation = randomUUID(), checker = build.files.find(f => f.path.endsWith("/z5-institution-linker/checker.py"))!;
  const leases = await acquireComputeResourceLeases({ tenantId: row.tenant_id,
    resourceKeys: ["native:z5-institution-linker"], requiredResourceKeys: ["native:z5-institution-linker"],
    workloadClass: "INTERACTIVE", ownerId: "original-s8:z5:" + invocation });
  try {
    const funding = await chargeInstitutionDemand(ctx, row.request.parentReservation, {
      responsibilityIdentity: row.request.responsibilityIdentity, phase: "LIFECYCLE", ordinal: 1, units: 1, physicalInvocationId: invocation });
    await transaction(ctx, async c => {
      const actual = await checkedRequestTx(ctx, c, row);
      if (body.physical) await assertDeliveryTx(ctx, c, actual, body.physical);
      await assertOwnerCutTx(ctx, c, actual.request, profile, cut);
      await assertComputeLeasesTx(ctx, c, leases);
      await recordCostTx(ctx, c, actual, invocation, "CLAIM", { stageOwner: "ORIGINAL_S8", chargeRef: funding.charge.ref,
        originalS8PolicyDigest: authority.lifecyclePolicyDigest, state: "CHECK_PENDING_UNKNOWN_IF_INTERRUPTED" });
    });
    const check = await independentlyCheckInstitution(row.input, artifact.certificate, checker.sha256, undefined, row.deadline_at.getTime());
    return await transaction(ctx, async c => {
      const actual = await checkedRequestTx(ctx, c, row);
      if (body.physical) await assertDeliveryTx(ctx, c, actual, body.physical);
      await assertOwnerCutTx(ctx, c, actual.request, profile, cut);
      await assertComputeLeasesTx(ctx, c, leases);
      await recordCostTx(ctx, c, actual, invocation, "ACCEPT", { stageOwner: "ORIGINAL_S8",
        checkerOperations: check.operations, claimDigest: check.claimDigest, chargeRef: funding.charge.ref });
      return { schema: "finnor.s8.z5-original-composition-check.v1", tenantId: row.tenant_id, principalId: row.principal_id,
        workId: row.work_id, requestId: row.id, generation: row.generation, artifactDigest: row.artifact_digest!,
        inputDigest: digest(row.input), sourceDigest: build.sourceDigest, liveDigest: cut.liveDigest, ownerCutDigest: digest(cut),
        rightsRevision: cut.rightsRevision, rightsRef: cut.rightsRef, originalDeadline: row.request.originalDeadline,
        lifecyclePolicyDigest: authority.lifecyclePolicyDigest, checkerSha256: checker.sha256, check, domain: "ORDINARY_DEVELOPMENT",
        protectedAdmission: false, productionActivated: false, executionAuthorityGranted: false };
    });
  } finally { await releaseComputeResourceLeases(leases, "Z5_ORIGINAL_S8_CHECK_FINISHED_OR_REFUSED"); }
}
export async function currentInstitutionFromOriginalS8(authority: OriginalS8Authority, raw: unknown) {
  const { body, ctx, retained } = await current(authority, raw), { row, cut, artifact, build, profile } = retained;
  if (!body.nativeReference || body.nativeReference.owner !== "S8") throw Error("Z5_ORIGINAL_S8_REFERENCE_REQUIRED");
  const accepted = await readOwnerTransportReference({ semanticOwner: "S8", tenantId: row.tenant_id, principalId: row.principal_id }, body.nativeReference.id);
  const { content, ...ref } = accepted.reference, assertion = content as NativeS8Assertion;
  if (digest(ref) !== digest(body.nativeReference) || digest(assertion) !== ref.contentDigest
    || assertion.schema !== "finnor.s8.z5-original-composition-check.v1" || assertion.requestId !== row.id
    || assertion.tenantId !== row.tenant_id || assertion.principalId !== row.principal_id || assertion.workId !== row.work_id
    || assertion.generation !== row.generation || assertion.artifactDigest !== row.artifact_digest
    || assertion.inputDigest !== digest(row.input) || assertion.sourceDigest !== build.sourceDigest
    || assertion.ownerCutDigest !== digest(cut) || assertion.rightsRevision !== cut.rightsRevision || assertion.rightsRef !== cut.rightsRef
    || assertion.originalDeadline !== row.request.originalDeadline || assertion.lifecyclePolicyDigest !== authority.lifecyclePolicyDigest
    || assertion.checkerSha256 !== build.files.find(f => f.path.endsWith("/z5-institution-linker/checker.py"))?.sha256
    || assertion.check.claimDigest !== artifact.payload.check.claimDigest || assertion.check.checked !== true
    || assertion.protectedAdmission !== false || assertion.executionAuthorityGranted !== false || assertion.productionActivated !== false)
    throw Error("Z5_ORIGINAL_S8_REFERENCE_NOT_CURRENT");
  await transaction(ctx, async c => {
    const actual = await checkedRequestTx(ctx, c, row);
    await assertOwnerCutTx(ctx, c, actual.request, profile, cut);
  });
  return { current: true, assertion, nativeReference: ref };
}
