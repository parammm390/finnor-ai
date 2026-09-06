// voice_notify_failure job: speak the specific failure diagnosis to the owner
// ("your CRM key isn't working — want to give me a working one?"), in addition to
// the audit entry and the blocked queue card. Best-effort: if the owner can't be
// reached, the queue card is still there.

import { getPool } from "@finnor/db";
import { placeVapiCall } from "@finnor/tools";
import { resolveCredentialContext } from "@finnor/security";
import type { JobHandler } from "../queue";

export const voiceNotifyFailure: JobHandler = async (payload) => {
  const tenantId = String(payload.tenantId ?? "");
  const script = String(payload.script ?? "");
  if (!tenantId || !script) throw new Error("voice_notify_failure requires tenantId and script");

  const { rows } = await getPool().query(`SELECT owner_phone FROM tenants WHERE id = $1`, [tenantId]);
  const ownerPhone = rows[0]?.owner_phone as string | null | undefined;
  if (!ownerPhone || ownerPhone === "PLACEHOLDER_NEEDS_REAL_VALUE") {
    throw new Error("Tenant owner_phone is not set — cannot speak the failure diagnosis");
  }
  const result = await placeVapiCall({
    tenantId,
    destinationNumber: ownerPhone,
    firstMessage: script,
    metadata: { notification: "integration_failure", tenantId },
  }, await resolveCredentialContext(tenantId, "system:integration-failure", "vapi", "integration_failure", { channel: "voice" }));
  if (!result.ok) throw new Error(result.error ?? "Vapi call failed");
};
