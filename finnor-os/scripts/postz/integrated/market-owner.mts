/** W4's actual owner composer, on the existing canonical business. Its native
 * grammar and independently consented controlled participants are unchanged. */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import type { IntegratedOwnerPorts, NativeJourneyOutput } from "./owner-journey.mts";
import type { NativeGrowthJourneyContext } from "../../w4/native-growth-journey.mts";

export async function runMarketOwner(ports: IntegratedOwnerPorts, setup: Pick<NativeGrowthJourneyContext,
  "actors" | "native" | "recipient" | "pump">): Promise<NativeJourneyOutput> {
  ports.checkBound();
  const key = "w4-shared-" + randomUUID();
  await ports.artifact("integrated/w4/original.json", {
    companyId: ports.companyId, originalServiceWorkId: ports.serviceWorkId,
    expected: { nativeOperations: ["OFFER", "DELIVER", "COLLECT"], originalIdentityReadback: true,
      deliveredUnits: 1, collectedMinor: "1", recognizedMinor: "1", currency: "USD",
      s7ProfitQualified: false, fieldValidated: false, completeMonetaryCost: null },
    sourceClass: "CONTROLLED_SYNTHETIC_PARTICIPANTS_NOT_GENUINE_MARKET_DEMAND",
  });
  const intake = await ports.http("demand-to-business", "intake", { companyId: ports.companyId, idempotencyKey: key,
    instruction: "On this original company, test one supported adjacent software-record transformation. Preserve the original service obligations and independently observe consent, delivery, collection and accounting. No genuine market, cash, profit or physical service is asserted.",
  }, ports.owner);
  assert.equal(intake.status, 200, JSON.stringify(intake));
  const work = { workId: intake.body.workId as string, workInputId: intake.body.workInputId as string };
  assert(work.workId && work.workInputId); assert.notEqual(work.workId, ports.serviceWorkId);
  const { createNativeGrowthJourney } = await import("../../w4/native-growth-journey.mts");
  const journey = createNativeGrowthJourney({
    ...setup, tenant: ports.tenant, owner: ports.owner, companyId: ports.companyId, work,
    namespace: key, admin: ports.admin, http: ports.http,
    ok: async (group, operation, body, actor = ports.owner) => {
      const response = await ports.http(group, operation, body, actor);
      assert.equal(response.status, 200, JSON.stringify(response)); return response.body;
    },
    artifact: (name, body) => ports.artifact("integrated/w4/private/" + name, body),
    checkBound: ports.checkBound,
  });
  const observed = await journey.run(), current = observed.final;
  assert.equal(current.check.disposition, "CHECKED_DEVELOPMENT");
  assert.equal(current.projection.counts.delivered, 1);
  assert.equal(current.projection.accounting.collectedMinor, "1");
  assert.equal(current.projection.accounting.recognizedMinor, "1");
  assert.equal(current.projection.s7ProfitQualified, false); assert.equal(current.projection.fieldValidated, false);
  for (const operation of ["OFFER", "DELIVER", "COLLECT"]) assert(current.nativeEffects.some((effect: any) =>
    effect.kind === operation && effect.state === "VERIFIED" && effect.originalIdentityReadback === true),
  "W049_ACTUAL_W4_ORIGINAL_IDENTITY_CONSUMPTION_REQUIRED:" + operation);
  const row = (await ports.admin.query(`SELECT q.*,a.body,a.body_digest,a.check_result,w.status work_status
    FROM finnor_os.w4_business_requests q JOIN finnor_os.w4_business_artifacts a
      ON a.tenant_id=q.tenant_id AND a.id=q.artifact_id
    JOIN finnor_os.works w ON w.tenant_id=q.tenant_id AND w.id=q.work_id
    WHERE q.tenant_id=$1 AND q.principal_id=$2 AND q.id=$3`,
  [ports.tenant, ports.owner, observed.requestId])).rows[0];
  assert(row, "W049_W4_ACTUAL_DURABLE_ARTIFACT_REQUIRED");
  assert.equal(row.work_id, work.workId); assert.equal(row.work_input_id, work.workInputId);
  assert.equal(row.company_id, ports.companyId);
  assert.equal(row.body_digest, current.artifactDigest); assert.deepEqual(row.body, current.program);
  assert.equal(row.original_deadline.toISOString(), observed.input.originalDeadlineAt);
  const economics = (await ports.admin.query(`SELECT kind,body FROM finnor_os.s7_economic_records
    WHERE tenant_id=$1 AND body->'payload'->>'workId'=$2 ORDER BY knowledge_at,record_id`,
  [ports.tenant, work.workId])).rows;
  assert(economics.some(record => record.kind === "COMPUTE"));
  assert(economics.some(record => record.kind === "MEASUREMENT"));
  const foreign = await ports.http("demand-to-business", "read", { workId: work.workId }, ports.foreign);
  assert.equal(foreign.status, 404);
  const result: NativeJourneyOutput = {
    engine: "W4", schema: current.program.schema, tenantId: ports.tenant, principalId: ports.owner, companyId: ports.companyId,
    ...work, requestId: observed.requestId,
    ref: { owner: "W4", id: observed.requestId, version: current.program.schema, contentDigest: row.body_digest },
    consumedBy: { owner: "NATIVE_DEMAND_TO_BUSINESS_RUNTIME", nativeEffects: current.nativeEffects,
      independentCheck: row.check_result, projection: current.projection },
    evidence: { original: observed.input, obligations: observed.obligations, current, economics,
      originalDeadline: observed.input.originalDeadlineAt, workStatus: row.work_status,
      completeMonetaryCost: null, independentProtectedCustody: false, fieldValidated: false },
  };
  await ports.artifact("integrated/w4/private-native-output.json", result);
  return result;
}
