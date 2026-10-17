import { describe, expect, it, vi } from "vitest";
import { canonicalEconomic } from "../../packages/epistemic-runtime/src/economic-attribution";
import { ownerTransportHash } from "../../packages/governed-execution/src/owner-transport";

// Failure modes are authored before the storage fix: valid hashes do not bind
// SQL principal/kind/links/time, and unhashed flags can claim protected authority.
// SQL grants and API behaviour are separately exercised by run-owner-e2e.mts.
const state = vi.hoisted(() => ({ row: null as any }));
vi.mock("@finnor/db", () => ({
  withTenantTransaction: async (_tenant: string, _options: unknown, callback: Function) => callback({}, {
    query: async (sql: string) => sql.startsWith("SELECT role")
      ? { rowCount: 1, rows: [{ role: "owner" }] }
      : { rowCount: 1, rows: [state.row] },
  }),
}));
import { readStoredEconomicRecord } from "../../packages/private-equity/src/economic-store";

const tenant = "11111111-1111-4111-8111-111111111111";
const principal = "22222222-2222-4222-8222-222222222222";
const foreign = "33333333-3333-4333-8333-333333333333";
const at = "2026-10-17T00:00:00.000Z";
const ctx: any = { auth: { tenantId: tenant, userId: principal, employeeId: principal, role: "owner" } };

function storedRow(mutate: (body: any) => void = () => undefined): any {
  const body: any = {
    kind: "SOURCE", estimandId: null, revisionOf: null, tenantId: tenant, principalId: principal,
    validAt: at, knowledgeAt: at, payload: { record: { cash: "100" }, sourceRefs: [] },
    ref: { owner: "S7", version: "s7-economic-record-v2" },
    event: {}, protectedReceipt: null, executionAuthorityGranted: false,
  };
  mutate(body);
  const { ref, event: _event, protectedReceipt: _receipt, executionAuthorityGranted: _authority, ...content } = body;
  const encoded = { schema: "finnor.s7.semantic-content.v2", canonicalPayload: canonicalEconomic(content) };
  const digest = ownerTransportHash(encoded);
  body.ref = { ...ref, id: `economic-record:${digest}`, contentDigest: digest };
  const eventBody = {
    schema: "finnor.s7.experience.v1", semanticOwner: "S7", type: "MEASUREMENT",
    tenantId: tenant, principalId: principal, revisionRef: body.ref.id, contentDigest: digest,
    detail: encoded, protectedReceipt: null, appendAuthorityGranted: false, executionAuthorityGranted: false,
  };
  body.event = { ...eventBody, eventId: `s7-event:${ownerTransportHash(eventBody)}` };
  return {
    tenant_id: tenant, principal_id: principal, record_id: body.ref.id, kind: "SOURCE",
    estimand_id: null, revision_of: null, content_digest: digest,
    valid_at: new Date(at), knowledge_at: new Date(at), body, event: structuredClone(body.event),
  };
}

const substitutions: Array<[string, (body: any) => void]> = [
  ["principal", body => { body.principalId = foreign; }],
  ["kind", body => { body.kind = "COST"; }],
  ["estimand link", body => { body.estimandId = "another-record"; }],
  ["revision link", body => { body.revisionOf = "another-record"; }],
  ["knowledge cut", body => { body.knowledgeAt = "1999-01-01T00:00:00.000Z"; }],
  ["valid time", body => { body.validAt = "1999-01-01T00:00:00.000Z"; }],
  ["protected receipt", body => { body.protectedReceipt = { claimed: "forged" }; }],
  ["execution authority", body => { body.executionAuthorityGranted = true; }],
  ["semantic owner", body => { body.ref.owner = "S8"; }],
];

describe("economic storage preimage validation", () => {
  it("reads a consistent immutable ordinary record", async () => {
    state.row = storedRow();
    await expect(readStoredEconomicRecord(ctx, state.row.record_id)).resolves.toEqual(state.row.body);
  });

  it("accepts equivalent timestamp offsets", async () => {
    state.row = storedRow(body => { body.validAt = body.knowledgeAt = "2026-10-17T05:30:00.000+05:30"; });
    await expect(readStoredEconomicRecord(ctx, state.row.record_id)).resolves.toEqual(state.row.body);
  });

  for (const [name, mutate] of substitutions) {
    it(`rejects hash-valid ${name} substitution`, async () => {
      state.row = storedRow(mutate);
      await expect(readStoredEconomicRecord(ctx, state.row.record_id)).rejects.toMatchObject({
        status: 503, code: "ECONOMIC_STORAGE_PREIMAGE_INVALID",
      });
    });
  }

  for (const [field, value] of [
    ["principalId", foreign], ["revisionRef", "another-record"], ["contentDigest", "0".repeat(64)],
    ["protectedReceipt", { claimed: "forged" }], ["executionAuthorityGranted", true],
  ] as const) {
    it(`rejects a self-consistent stored event with substituted ${field}`, async () => {
      state.row = storedRow();
      const { eventId: _id, ...body } = { ...state.row.body.event, [field]: value };
      const event = { ...body, eventId: `s7-event:${ownerTransportHash(body)}` };
      state.row.body.event = event; state.row.event = structuredClone(event);
      await expect(readStoredEconomicRecord(ctx, state.row.record_id)).rejects.toMatchObject({
        status: 503, code: "ECONOMIC_STORAGE_PREIMAGE_INVALID",
      });
    });
  }

  it("continues to reject altered payload bytes without a new content commitment", async () => {
    state.row = storedRow(); state.row.body.payload.record.cash = "1000000000";
    await expect(readStoredEconomicRecord(ctx, state.row.record_id)).rejects.toMatchObject({
      status: 503, code: "ECONOMIC_STORAGE_PREIMAGE_INVALID",
    });
  });
});
