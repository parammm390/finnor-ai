import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { PeMutationContext } from "../types";
import { sha } from "../evidence-execution/store";
import { NativeCapabilityObservationSchema, NativeCapabilitySourceSchema, type NativeControlInput } from "./contracts";
import { r2MeasuredQuantity, r2Quantity, r2String } from "../../../epistemic-runtime/src/r2-rational";

export const NATIVE_CAPABILITY_SOURCE_PREFIX = "finnor.w1.native-capability.v1:";
export const REGISTERED_NATIVE_MODEL = "P1_REGISTERED_EXACT_NATIVE_NO_MODEL";
/** Read only the existing P3 configuration owner, never request/evidence text.
 * The original physical governor still owns all permits and funding checks. */
export async function readNativeCapabilityTx(ctx: PeMutationContext, c: PoolClient) {
  const row = (await c.query("SELECT source FROM finnor_os.compute_resource_policies WHERE resource_key='native:p2'")).rows[0];
  if (!row || typeof row.source !== "string" || !row.source.startsWith(NATIVE_CAPABILITY_SOURCE_PREFIX)) return null;
  if (Buffer.byteLength(row.source) > 8192) throw Error("W1_NATIVE_CAPABILITY_SOURCE_BYTE_BOUND");
  let source;
  try { source = NativeCapabilitySourceSchema.parse(JSON.parse(row.source.slice(NATIVE_CAPABILITY_SOURCE_PREFIX.length))); }
  catch { throw Error("W1_NATIVE_CAPABILITY_OWNER_SOURCE_UNSUPPORTED"); }
  if (Date.parse(source.recordedAt) > Date.now()) throw Error("W1_NATIVE_CAPABILITY_REVISION_NOT_YET_AVAILABLE");
  const receipts = [];
  for (const reference of source.latencyEvidence) {
    const attempt = (await c.query(`SELECT id,body,digest,status FROM finnor_os.p2_attempts
      WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`, [ctx.auth.tenantId,
      ctx.auth.employeeId ?? ctx.auth.userId, reference.attemptId])).rows[0];
    if (!attempt || attempt.digest !== reference.digest || sha(attempt.body) !== attempt.digest ||
        attempt.status !== "COMPLETED" || !Number.isFinite(attempt.body.w1Meter?.elapsedMs))
      throw Error("W1_NATIVE_CAPABILITY_ACTUAL_LATENCY_RECEIPT_REQUIRED");
    receipts.push({ attemptId: attempt.id, digest: attempt.digest, elapsedMs: attempt.body.w1Meter.elapsedMs });
  }
  const sourceSha256 = createHash("sha256").update(row.source).digest("hex");
  return NativeCapabilityObservationSchema.parse({ ...source,
    ref: "p3-native-capability:" + source.revision + ":" + sourceSha256, sourceSha256,
    latencyReceipts: receipts, authorityGranted: false, originalDebitsUnchanged: true });
}
/** Only attenuate. Lack of support cannot make an unavailable method available,
 * lower an original owner price or turn an observed duration into field truth. */
export function attenuateNativeCapability(input: NativeControlInput) {
  const capability = input.nativeCapability;
  if (!capability) return input;
  if (input.utility) input.utility.nativeAttemptCost = r2String(
    r2Quantity(input.utility.nativeAttemptCost).mul(r2Quantity(capability.nativeAttemptCostMultiplier)));
  for (const entry of input.catalogue.entries) {
    const remaining = entry.unitCosts.filter(cost => input.frame?.units.some(unit =>
      unit.unitId === cost.unitId && unit.status !== "COMPLETED")).length;
    const priced = input.utility && r2Quantity(input.utility.nativeAttemptCost)
      .mul(r2MeasuredQuantity(remaining)).compare(r2Quantity(input.utility.lossGap)) <= 0;
    entry.available = entry.available && capability.modelRef === REGISTERED_NATIVE_MODEL && !!priced &&
      remaining * capability.stageLatencyPlanningMs <= input.remaining.wallMs;
  }
  return input;
}
