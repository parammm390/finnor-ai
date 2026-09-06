// voice_confirm_request job: no live call was active when the gate fired, so place an
// outbound Vapi call to the OWNER, read the draft, and let the end-of-call webhook
// parse the spoken yes/no. The action stays pending until that decision arrives.

import { domainActions, users, withTenant } from "@finnor/db";
import { placeVapiCall } from "@finnor/tools";
import { resolveCredentialContext } from "@finnor/security";
import type { JobHandler } from "../queue";
import { eligibleApproversForAction } from "@finnor/authority";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

export const voiceConfirmRequest: JobHandler = async (payload) => {
  const tenantId = String(payload.tenantId ?? "");
  const actionId = String(payload.actionId ?? "");
  const script = String(payload.script ?? "");
  if (!tenantId || !actionId || !script) throw new Error("voice_confirm_request requires tenantId, actionId, script");

  // Only call if the action is still pending — a console click may have beaten us.
  const [row] = await withTenant(tenantId, (db) => db.select({ status: domainActions.status }).from(domainActions).where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.id, actionId))).limit(1));
  if (!row || row.status !== "pending") return; // already decided — nothing to speak
  const eligibleIds = await eligibleApproversForAction(tenantId, actionId);
  const [approver] = eligibleIds.length > 0 ? await withTenant(tenantId, (db) => db.select({ id: users.id, phoneNumber: users.phoneNumber }).from(users).where(and(eq(users.tenantId, tenantId), inArray(users.id, eligibleIds), eq(users.status, "active"), isNotNull(users.phoneNumber))).limit(1)) : [];
  if (!approver?.phoneNumber || approver.phoneNumber === "PLACEHOLDER_NEEDS_REAL_VALUE") throw new Error("No currently authorized approver has a verified employee phone number");

  const result = await placeVapiCall({
    tenantId,
    destinationNumber: approver.phoneNumber,
    firstMessage: `Hi, this is Finnor with something that needs your approval. ${script}`,
    metadata: { pendingActionId: actionId, tenantId, approverEmployeeId: approver.id },
  }, await resolveCredentialContext(tenantId, "system:approval-request", "vapi", "voice_confirmation", { channel: "voice" }));
  if (!result.ok) throw new Error(result.error ?? "Vapi call failed");
};
