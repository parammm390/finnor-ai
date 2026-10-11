import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { observeExactCreatedRequest } from "../../../packages/private-equity/src/program-synthesis/request-observer";

// Independent canonical postcondition: existence, a completed action, or an S5
// charge alone is insufficient. Each frozen field must survive the PE mutation.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const expected = {
  tenantId: id(1), requestId: id(2), dealId: id(3), workstreamId: id(4),
  requestedFromDealPartyId: id(5), owner: { partyType: "employee", partyId: id(6) },
  requestText: "Send the signed schedule", requestedAt: "2026-10-11T10:00:00.000Z",
  dueAt: "2026-10-12T10:00:00.000Z", requiresAcceptedDeliverable: true,
  originalDeadline: "2026-10-13T10:00:00.000Z",
};
const canonical = {
  tenant_id: expected.tenantId, id: expected.requestId, deal_id: expected.dealId,
  workstream_id: expected.workstreamId,
  requested_from_deal_party_id: expected.requestedFromDealPartyId,
  owner_party_type: expected.owner.partyType, owner_party_id: expected.owner.partyId,
  request_text: expected.requestText, requested_at: new Date(expected.requestedAt),
  due_at: new Date(expected.dueAt), requires_accepted_deliverable: true,
  state: "open", acknowledged_at: null, fulfilled_at: null, cancelled_at: null,
  archived_at: null, created_at: new Date("2026-10-11T10:01:00.000Z"),
};
assert.equal(observeExactCreatedRequest(expected, canonical).observed, true);
for (const key of Object.keys(canonical).filter(key => key !== "created_at") as Array<keyof typeof canonical>) {
  const changed = { ...canonical, [key]: key === "requires_accepted_deliverable"
    ? false : key === "due_at" || key === "requested_at"
      ? new Date("2026-10-14T10:00:00.000Z") : key.endsWith("_at")
        ? new Date("2026-10-11T12:00:00.000Z") : "different" };
  assert.equal(observeExactCreatedRequest(expected, changed).observed, false, key);
}
assert.equal(observeExactCreatedRequest(expected, null).observed, false);
assert.equal(observeExactCreatedRequest(expected, {
  ...canonical, created_at: new Date("2026-10-14T10:00:00.000Z"),
}).observed, false, "actual creation after the original deadline cannot be backdated");
assert.equal(observeExactCreatedRequest({ ...expected, originalDeadline: "2026-10-11T09:00:00.000Z" }, canonical).observed, false);
const sql = readFileSync(fileURLToPath(new URL("../../../packages/db/migrations/0174_x1_native_continuation.sql", import.meta.url)), "utf8");
assert.match(sql, /'OBSERVED'/);
assert.match(sql, /run_x1_institution_continuation_v1/);
console.log("Request postcondition rejects every field mutation and absent or late rows");
