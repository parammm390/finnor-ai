/** The parent's one original S6 proof invocation. No source construction,
 * resource declaration, replacement obligation or terminal-state repair lives
 * here. The live consumer receives only frozen public original receipts. */
import { strict as assert } from "node:assert";
import type pg from "pg";
import { organizationDigest } from "../../../packages/private-equity/src/organization-transformation/compiler";
import { proveGovernedDispatch } from "../../s6/governed-dispatch-proof.mts";
import { createSharedOrganizationLiveConsumer, type OrganizationBeforeTerminalParent,
  type OrganizationBeforeTerminalReady, type OrganizationLiveInput, type OrganizationLivePorts } from "./live-consumer.mjs";

interface SharedNativeInput {
  admin: pg.Client;
  live: OrganizationLiveInput;
  mapping: { field: string; recordPrefix: string; dose: number; operation: string; unit: string };
  /** Close the parent's extra native reads, including failed helper exits. */
  onLivePhaseEnded(): void;
}
type BeforeNegative = NonNullable<NonNullable<Parameters<typeof proveGovernedDispatch>[8]>["beforeFinalStorageNegative"]>;

/** Called once by the actual parent, after all original resources/Works and
 * this never-dispatched dependency have been declared, before its sole S6
 * invocation. The mandatory callback writes the real fifth record and custody
 * while every owner/budget transport is still healthy. */
export async function runSharedOrganizationNative(ports: OrganizationLivePorts, input: SharedNativeInput,
  parentBeforeTerminal: OrganizationBeforeTerminalParent) {
  ports.checkBound();
  const original = input.live.originalS6, workId = original.workLineage?.workId;
  assert(workId, "W5_SHARED_NATIVE_ORIGINAL_WORK_REQUIRED");
  const fixture = { tenant: input.live.tenantId, principal: input.live.fixture.ownerId,
    root: { entityType: "external_organization", entityId: input.live.fixture.companyId } };
  const rows = (await input.admin.query(`SELECT o.body,d.id action_id,d.work_id,d.status action_status,
    e.id effect_id,e.semantic_hash,e.status effect_status,st.status consumption_status,r.status reservation_status,
    (SELECT count(*)::int FROM finnor_os.s5_governed_resource_charges ch
      WHERE ch.tenant_id=o.tenant_id AND ch.reservation_id=$3) charge_count
    FROM finnor_os.s6_obligation_origins o
    LEFT JOIN finnor_os.domain_actions d ON d.tenant_id=o.tenant_id AND d.id=o.domain_action_id
    LEFT JOIN finnor_os.business_effects e ON e.tenant_id=o.tenant_id AND e.id=o.effect_id
    LEFT JOIN finnor_os.s5_consumption_states st ON st.tenant_id=o.tenant_id AND st.consumption_id=o.consumption_id
    LEFT JOIN finnor_os.s5_reservations r ON r.tenant_id=o.tenant_id AND r.reservation_id=$3
    WHERE o.tenant_id=$1 AND o.obligation_id=$2 LIMIT 2`,
  [fixture.tenant, original.ref.id, original.reservationRef.id])).rows;
  ports.checkBound();
  assert.equal(rows.length, 1, "W5_ONE_GENUINE_ORIGINAL_S6_ORIGIN_REQUIRED");
  const preflight = rows[0];
  assert.equal(organizationDigest(preflight.body), organizationDigest(original));
  assert.equal(preflight.action_id, original.domainActionId); assert.equal(preflight.work_id, workId);
  assert.equal(preflight.effect_id, original.effectRef.id); assert.equal(preflight.semantic_hash, original.effectRef.semanticHash);
  assert.equal(preflight.action_status, "draft", "W5_MUST_NOT_REPLAY_A_PRIOR_NATIVE_EFFECT");
  assert.equal(preflight.effect_status, "compiled", "W5_MUST_NOT_REPLAY_A_PRIOR_NATIVE_EFFECT");
  assert.equal(preflight.consumption_status, "INTENDED_PENDING_S6");
  assert.equal(typeof preflight.reservation_status, "string");
  assert.notEqual(preflight.reservation_status, "RELEASED");
  assert.equal(preflight.charge_count, 0, "W5_MUST_NOT_RESUBMIT_A_PRIOR_S6_EPISODE");
  await ports.artifact("w5-shared-original-never-dispatched-preflight.json", {
    originalObligationRef: original.ref, originalWorkId: workId, preflight,
    qualification: "ACTUAL_ORIGINAL_NATIVE_STATE_NOT_DISPATCH_OR_COST_AUTHORITY" });

  const custody: { pending?: Readonly<OrganizationBeforeTerminalReady> } = {};
  const liveConsumer = await createSharedOrganizationLiveConsumer(ports, input.live, async (ready, receipts) => {
    await parentBeforeTerminal(ready, receipts);
    custody.pending = ready;
  });
  let livePhaseClosed = false;
  const closeNativePhase = () => {
    if (!livePhaseClosed) { livePhaseClosed = true; input.onLivePhaseEnded(); }
  };
  // The helper requires Promise<void>. Await the real one-shot consumer and
  // capture its pending result through the completed parent callback, no cast.
  const beforeFinalStorageNegative: BeforeNegative = async receipts => {
    try { await liveConsumer(receipts); }
    finally { closeNativePhase(); }
  };
  const ownerCall = (operation: string, body: unknown) =>
    ports.request("POST", "obligations", operation, body, fixture.principal);
  const api = async (_fixture: unknown, operation: string, body: unknown) =>
    ports.request("POST", operation === "settle" ? "allocations" : "obligations", operation, body, fixture.principal);
  ports.checkBound();
  let proof: Awaited<ReturnType<typeof proveGovernedDispatch>>;
  try {
    proof = await proveGovernedDispatch(fixture, original, api, input.admin,
      (name: string, body: unknown) => ports.artifact("s6-original/" + name, body),
      false, undefined, false, { ownerCall, mapping: input.mapping,
        sharedCompany: { companyId: fixture.root.entityId, originalWorkId: workId }, beforeFinalStorageNegative });
  } finally {
    // The helper can fail before hook entry and still run its own cleanup.
    closeNativePhase();
  }

  // The original malformed charge is now permanent and all helper cleanup
  // completed. No SQL, HTTP, worker tick or budget read is allowed below here.
  ports.checkBound();
  const pending = custody.pending;
  assert(pending, "W5_ACTUAL_LIVE_FIFTH_AND_CUSTODY_CALLBACK_MUST_COMPLETE");
  assert.equal(pending.status, "PENDING_S6_TERMINAL_NEGATIVE");
  const result = { schema: "finnor.w5.shared-native-result.v1",
    status: "CONTROLLED_NATIVE_CONSUMPTION_AND_ORIGINAL_TERMINAL_NEGATIVE_COMPLETED",
    beforeTerminal: pending, originalS6Proof: proof, postTerminalNativeOperations: 0,
    fullW5Qualification: false, scientificAdmission: false, fieldBenefitEstablished: false };
  await ports.artifact("w5-shared-native-result.json", result);
  ports.checkBound();
  return result;
}
