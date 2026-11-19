/** W4-only controlled S1/S3 authoring. Generic S5 fixtures are unchanged. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createMetricSeries, attachCanonicalEvidenceToWorld, type PeMutationContext } from "@finnor/private-equity";
import { createEvidenceSource } from "@finnor/memory";
import { allocationRef } from "@finnor/epistemic-runtime";
import { canonical } from "../../packages/private-equity/src/demand-to-business/contracts";
import { ownerFixtureReference as ref } from "../s5/owner-fixture.mjs";

export async function prepareCommercialMeasurementFixtures(e: {
  tenant: string; principal: string; root: { entityType: "external_organization"; entityId: string };
  namespace: string; admin: { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> };
  ok: (group: string, operation: string, body: unknown) => Promise<any>;
  artifact: (name: string, value: unknown) => Promise<unknown>; checkBound: () => void;
}) {
  e.checkBound();
  const startedAt = new Date().toISOString(), started = performance.now();
  const python = process.env.FINNOR_S3_PYTHON;
  assert(python, "W4_CONTROLLED_PRODUCER_PINNED_PYTHON_REQUIRED");
  const sourcePaths = ["controlled-measurement-design.json", "controlled-measurements.py", "check-controlled-measurements.py"];
  const sourcePins = await Promise.all(sourcePaths.map(async name => {
    const path = join(import.meta.dirname, name), bytes = await readFile(path);
    return { name, path, sha256: createHash("sha256").update(bytes).digest("hex") };
  }));
  const generated = spawnSync(python, ["-I", "-B", sourcePins[1]!.path], {
    encoding: "utf8", timeout: 20000, maxBuffer: 2 * 1024 ** 2 });
  await e.artifact(e.namespace + "/controlled-producer-observation.json", {
    schema: "finnor.w4.controlled-producer-observation.v1", startedAt, sourcePins,
    exitCode: generated.status, signal: generated.signal, rawStdoutUtf8: generated.stdout,
    stderr: generated.stderr?.slice(0, 2048) ?? null, spawnError: (generated.error as NodeJS.ErrnoException | undefined)?.code ?? null,
    nativeCalls: 0, fieldValidated: false });
  assert.equal(generated.status, 0, "W4_CONTROLLED_MEASUREMENT_PRODUCER_FAILED");
  assert.equal(generated.signal, null);
  const packet = JSON.parse(generated.stdout);
  assert.equal(packet.producerSha256, sourcePins[1]!.sha256);
  assert.equal(packet.designSha256, sourcePins[0]!.sha256);
  const checked = spawnSync(python, ["-I", "-B", sourcePins[2]!.path], {
    input: generated.stdout, encoding: "utf8", timeout: 20000, maxBuffer: 1024 ** 2 });
  await e.artifact(e.namespace + "/controlled-independent-check.json", {
    sourcePins, exitCode: checked.status, signal: checked.signal, rawStdoutUtf8: checked.stdout,
    stderr: checked.stderr?.slice(0, 2048) ?? null, spawnError: (checked.error as NodeJS.ErrnoException | undefined)?.code ?? null,
    qualificationCredit: false });
  assert.equal(checked.status, 0, "W4_CONTROLLED_MEASUREMENT_INDEPENDENT_CHECK_FAILED");
  assert.equal(checked.signal, null);
  const check = JSON.parse(checked.stdout);
  assert.equal(check.status, "CHECKED_SUPPORTED_CONTROLLED_INPUT");
  assert.equal(check.packetSha256, createHash("sha256").update(generated.stdout).digest("hex"));
  assert.equal(packet.design.profileId, "w4-controlled-commercial-service-v1");
  const day = 86400000, begin = new Date(Date.now() - 128 * day).toISOString();
  const preparation = { startedAt, elapsedMs: performance.now() - started, sourcePins,
    packetSha256: check.packetSha256, check, nativeCalls: 0, externalCalls: 0,
    cost: "ACTUAL_LOCAL_PREPARATION_UNMETERED_NOT_ZERO", fieldValidated: false,
    sourceClass: "CONTROLLED_SIMULATOR_INTERVENTIONS_NOT_FIELD_OR_NATIVE_DELIVERY" };
  await e.artifact(e.namespace + "/controlled-measurement-preparation.json", preparation);
  e.checkBound();
  return {
    fixture: async (name: string, horizon: number, dimensions: any[], options: {
      existing: { tenant: string; principal: string; root: { entityType: string; entityId: string } };
      metricKeyPrefix: string; exposureUnit: string; operation: string; context: string; expiresAt: string;
    }) => {
      e.checkBound();
      assert.equal(horizon, 1); assert.equal(options.metricKeyPrefix, name);
      assert(/^[a-z][a-z0-9-]{1,95}$/.test(name));
      assert.deepEqual(options.existing, { tenant: e.tenant, principal: e.principal, root: e.root });
      assert.equal(options.operation, packet.design.operation); assert.equal(options.context, packet.design.context);
      assert(Object.hasOwn(packet.channels, options.exposureUnit), "W4_ACTUAL_PRODUCER_UNIT_REQUIRED");
      const channel = packet.channels[options.exposureUnit];
      assert.equal(channel.unit, options.exposureUnit); assert.equal(channel.operation, options.operation);
      const validUntil = options.expiresAt; assert(Date.parse(validUntil) > Date.now(), "ORIGINAL_FIXTURE_DEADLINE_EXHAUSTED");
      const current = (await e.admin.query(`SELECT 1 FROM finnor_os.users u
        JOIN finnor_os.external_organizations o ON o.tenant_id=u.tenant_id
        WHERE u.tenant_id=$1 AND u.id=$2 AND u.status='active' AND u.role='owner' AND o.id=$3 AND o.active
          AND EXISTS(SELECT 1 FROM finnor_os.tenant_vertical_assignments v
            WHERE v.tenant_id=u.tenant_id AND v.vertical_key='private_equity' AND v.effective_from<=clock_timestamp())`,
      [e.tenant, e.principal, e.root.entityId])).rows[0];
      assert(current, "W4_EXISTING_CANONICAL_FIXTURE_IDENTITIES_REQUIRED");
      const ctx = { auth: { tenantId: e.tenant, userId: e.principal, employeeId: e.principal, role: "owner" } } as PeMutationContext;
      const method = { schema: "finnor.w4.controlled-measurement-method.v1", profileId: packet.design.profileId,
        design: packet.design, sourcePins, unit: channel.unit, operation: channel.operation,
        fields: packet.design.units[channel.unit], sourceClass: preparation.sourceClass };
      const methodDigest = allocationRef("SUPPLIED", "w4-controlled-measurement-method", method).contentDigest;
      const methodRef = { owner: "SUPPLIED", id: "w4-controlled-measurement-method:" + methodDigest,
        version: "w4-controlled-commercial-v1", contentDigest: methodDigest };
      const sourceBody = { schema: "finnor.w4.controlled-measurement-source.v1",
        scope: { tenantId: e.tenant, principalId: e.principal, root: e.root, fixture: name },
        method, methodRef, packetSha256: check.packetSha256, independentCheck: check,
        observations: channel.rows, actualSimulatorTrace: channel.trace,
        timeSemantics: packet.timeSemantics, fieldValidated: false, nativeDeliveryEstablished: false };
      const content = canonical(sourceBody), digest = createHash("sha256").update(content).digest("hex");
      const source = (await createEvidenceSource(e.tenant, {
        sourceKey: "w4-controlled-measurements:" + name + ":" + randomUUID(), sourceType: "pe_document_claim",
        title: "Controlled simulated commercial measurements, not field observations" })).id;
      const version = randomUUID();
      await e.admin.query(`INSERT INTO finnor_os.evidence_source_versions
        (id,source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of,retrieved_at,created_at)
        VALUES($1,$2,'tenant',$3,1,$4,$5,$6::jsonb,$7,clock_timestamp(),clock_timestamp())`,
      [version, source, e.tenant, digest, content, JSON.stringify({ worldRoot: e.root, claims: [{
        propositionId: "w4-controlled-measurements", predicate: "reported",
        value: { methodRef, sourceContentSha256: digest, producerPacketSha256: check.packetSha256,
          classification: preparation.sourceClass, unit: channel.unit, operation: channel.operation },
      }] }), begin]);
      const series: Record<string, string> = {};
      for (const id of ["outcome", "price"]) {
        const metric = await createMetricSeries(ctx, { subjectType: "external_organization", subjectId: e.root.entityId,
          metricKey: name + "-" + id, name: id, unit: id === "outcome" ? "normalized-value" : channel.unit, frequency: "daily" });
        series[id] = String(metric.row.id);
        await attachCanonicalEvidenceToWorld(ctx, { worldRoot: e.root,
          entity: { entityType: "pe_metric_series", entityId: series[id]! },
          evidenceSourceId: source, evidenceVersionId: version, relationship: "supports" });
        for (const row of channel.rows) {
          const at = new Date(Date.parse(begin) + row.period * day).toISOString();
          const measured = id === "outcome" ? channel.trace[row.period].reportedOutcomeDecimal : String(row.exposures.price);
          await e.admin.query(`INSERT INTO finnor_os.pe_metric_observations
            (id,tenant_id,metric_series_id,period_start,period_end,value_type,value_numeric,evidence_source_id,evidence_version_id,source_system,created_by)
            VALUES($1,$2,$3,$4,$5,'number',$6,$7,$8,'w4:controlled-simulator-measurement-v1',$9)`,
          [randomUUID(), e.tenant, series[id], at, new Date(Date.parse(at) + day).toISOString(), measured, source, version, e.principal]);
        }
      }
      const request = { schema: "finnor.s3.fit-request.v1", modelKey: name, episodeId: "s5-" + name, roots: [e.root],
        stateVariables: [{ id: "outcome", root: e.root, seriesId: series.outcome, unit: "normalized-value", range: [-6, 6], role: "ENTERPRISE_STATE" }],
        exposures: [{ id: "price", root: e.root, seriesId: series.price, unit: channel.unit, operation: channel.operation,
          measurement: { status: "MEASURED_ACTUAL", methodRef, qualification: "SUPPLIED_OWNER_MEASUREMENT_UNVERIFIED" } }],
        time: { startAt: begin, endAt: new Date(Date.parse(begin) + 128 * day).toISOString(), periodMs: day,
          trainingThrough: new Date(Date.parse(begin) + 96 * day).toISOString() },
        validity: { validUntil, maxBeliefAgeMs: 3600000, regimes: ["operating"], contexts: [options.context], maximumHorizon: 24 },
        measurementPolicy: { selection: "COMPLETE_RECORDED_GRID_ASSUMED", missingness: "NONE", instrumentError: "ASSUMED_NEGLIGIBLE" },
        mechanisms: [{ id: "registered", meaning: "Generated conditional response only", origin: "SUPPLIED_HYPOTHESIS",
          assumptions: ["SEQUENTIAL_EXCHANGEABILITY", "POSITIVITY", "CONSISTENCY", "MEASUREMENT", "SELECTION",
            "INTERFERENCE", "STATIONARITY", "FUNCTIONAL_FORM", "ACTOR_INFORMATION"].map(category => ({
            id: category, category, status: "DECLARED", meaning: "Generated fixture assumption", evidenceRefs: [ref(category)],
          })), equations: [{ variableId: "outcome", features: [{ kind: "CONSTANT" }, { kind: "EXPOSURE", id: "price", lag: 0 }] }],
          counterparties: [] }], numerical: { bootstrapDraws: 64, blockLength: 4, seed: 20261002 } };
      const fitted = await e.ok("interventions", "fit", { request });
      assert.equal(fitted.status, "FITTED", JSON.stringify(fitted));
      const now = new Date(Date.now() - 1).toISOString();
      const body: any = { schema: "finnor.economic-mandate.v1", tenantId: e.tenant, principalId: e.principal,
        episodeId: request.episodeId, knowledgeAt: now, validUntil, businessOwnerRef: ref(e.principal, "BUSINESS_OWNER"),
        rightsRef: "s5-owner-rights", utilityRef: ref("supplied-joint-net-utility", "BUSINESS_OWNER"),
        horizon: { startAt: request.time.endAt, periodMs: day, periods: horizon },
        utility: { unit: "USD", accountingConventionRef: ref("declared-complete-cost-net-utility", "BUSINESS_OWNER"),
          periodTerms: [{ variableId: "outcome", unit: "normalized-value", coefficient: 100 }],
          discountFactors: Array(horizon + 1).fill(1), terminalTerms: [],
          tail: { status: "SUPPLIED_COMPLETE_FINITE_HORIZON", terminalLiability: 0, ref: ref("finite-tail", "BUSINESS_OWNER") } },
        risk: { kind: "HARD_WORST_PATH_UTILITY_FLOOR", minimumUtility: -1000 },
        ambiguity: { kind: "ROBUST_FIXED_JOINT_SCENARIOS", authorizationRef: ref("common-paths-no-probabilities", "BUSINESS_OWNER") },
        resources: { dimensions: dimensions.map(d => ({ ...d,
          resourceClass: d.resourceClass ?? (d.id === "cash" ? "CASH" : "OPERATIONAL_CAPACITY") })), couplings: [] },
        search: { maxExpansions: 50000, deadlineMs: 30000, maxWorlds: 512, maxPolicyNodes: 50000, maxHumanSeconds: 900 },
        scoring: { normalization: 100, maxRegret: 0.05 }, authorization: { basis: "AUTHENTICATED_OWNER_ASSERTION_UNADMITTED", protectedReceipt: null } };
      body.utilityRef = { ...body.utilityRef, contentDigest: allocationRef("BUSINESS_OWNER", "utility", body.utility).contentDigest };
      const mandate = { ...body, ref: allocationRef("BUSINESS_OWNER", "mandate", body, "economic-mandate-v1") };
      const fixture = { name, tenant: e.tenant, principal: e.principal, root: e.root, ctx, policies: [] as any[],
        labels: {} as Record<string, string>, resources: [] as any[], additionalExposures: [],
        context: options.context, model: fitted.model, series, mandate };
      await e.artifact(name + "/scientific-input.json", { request, rows: channel.rows, fitted, mandate,
        methodRef, source, version, sourceContentSha256: digest, preparation });
      e.checkBound(); return fixture;
    },
  };
}
