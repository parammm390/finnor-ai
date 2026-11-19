/** Fixed, sanitized CI projection. Private SQL, tokens, recipient ledgers and
 * full owner observations never enter this upload allowlist. A partial run
 * produces NOT_RUN predicates and a nonzero terminal result, never dummy PASS. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import type { NativeJourneyOutput } from "./owner-journey.mts";
import { INTEGRATED_PROFILE, NATIVE_CONSUMPTION_PREDICATES, NATIVE_OUTPUT_SCHEMAS,
  ORIGINAL_CUSTODY_PREDICATE } from "./profile.mts";

type Engine = keyof typeof NATIVE_OUTPUT_SCHEMAS;
export interface IntegratedScope {
  tenantId: string; principalId: string; companyId: string;
  originalServiceWorkId: string; originalServiceWorkInputId: string;
}
export interface IntegratedPredicateResult {
  id: string; status: "PASS" | "NOT_RUN"; evidencePaths: string[];
}
export interface IntegratedPublicOutput {
  engine: Engine; schema: string; tenantId: string; principalId: string; companyId: string;
  workId: string; workInputId: string; requestId: string;
  ref: { owner: string; id: string; version: string; contentDigest: string };
  consumedBy: { owner: string; evidenceSha256: string };
  privateEvidenceSha256: string;
  qualification: "CONTROLLED_NATIVE_OWNER_CONSUMPTION_NOT_FIELD_OR_FULL_COST";
  completeMonetaryCost: null; independentProtectedCustody: false;
}
export interface IntegratedOutputReceipt extends IntegratedPublicOutput {
  evidence: { path: string; sha256: string };
}
export interface IntegratedCleanup {
  status: "PASS" | "FAIL";
  steps: Array<{ name: string; status: "PASS" | "FAIL"; errorType?: string; code?: string }>;
}
export interface IntegratedNativeTerminal {
  schema: "finnor.w.integrated-native-e2e.v1";
  status: "PASS_CONTROLLED_SHARED_COMPANY_NATIVE_OWNERS" | "FAIL_CLOSED";
  startedAt: string; finishedAt: string; elapsedMs: number; exitCode: number;
  profile: typeof INTEGRATED_PROFILE; scope: IntegratedScope | null;
  outputs: IntegratedOutputReceipt[]; results: IntegratedPredicateResult[]; cleanup: IntegratedCleanup;
  completionGate: "PHASE_W_RELEASE_BLOCKED";
  admitted: false; productionActive: false; fieldValidated: false;
  fullPrdW049Satisfied: false; w050ThroughW053Satisfied: false;
}
export interface IntegratedNativeConsumption {
  schema: "finnor.w.integrated-native-consumption.v1";
  status: "PASS_NATIVE_CONSUMPTION" | "INCOMPLETE_NATIVE_CONSUMPTION";
  profileClassification: typeof INTEGRATED_PROFILE.classification;
  scope: IntegratedScope | null; outputs: IntegratedOutputReceipt[]; results: IntegratedPredicateResult[];
  originalCustody: Array<{ engine: Engine; workId: string; workInputId: string; workStatus: string;
    initialInstructionSha256: string; originalInputSha256: string }>;
  completeMonetaryCost: null; independentProtectedCustody: false;
  admitted: false; productionActive: false; fieldValidated: false;
}

export const INTEGRATED_UPLOAD_PATHS = Object.freeze([
  "integrated/profile.json", "integrated/result.json", "integrated/native-consumption.json",
  "integrated/w1/actual-native-output.json", "integrated/w2/actual-native-output.json",
  "integrated/w3/actual-native-output.json", "integrated/w4/actual-native-output.json",
  "integrated/w5/actual-native-output.json",
] as const);
const engines: Engine[] = ["W1", "W2", "W3", "W4", "W5"];
const predicateIds = [...engines.map(engine => NATIVE_CONSUMPTION_PREDICATES[engine]), ORIGINAL_CUSTODY_PREDICATE];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const opaque = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_:./-]{1,256}$/.test(value);
const cleanupNames = ["owned-worker", "recipient", "authentication", "application-pool", "database-admin", "owned-postgres"];

export function createIntegratedEvidence(input: {
  output: string; startedAt: string; started: number;
  artifact(name: string, body: unknown): Promise<unknown>;
}) {
  let scope: IntegratedScope | null = null, custodyVerified = false;
  const outputs = new Map<Engine, IntegratedOutputReceipt>();
  const originalCustody: IntegratedNativeConsumption["originalCustody"] = [];
  const results = (): IntegratedPredicateResult[] => predicateIds.map(id => {
    const engine = engines.find(engine => NATIVE_CONSUMPTION_PREDICATES[engine] === id);
    const observed = engine ? outputs.get(engine) : null;
    return { id, status: observed || !engine && custodyVerified ? "PASS" : "NOT_RUN",
      evidencePaths: observed ? [observed.evidence.path]
        : !engine && custodyVerified ? ["integrated/native-consumption.json"] : [] };
  });
  const orderedOutputs = () => engines.flatMap(engine => {
    const output = outputs.get(engine); return output ? [output] : [];
  });
  return {
    initialize: () => input.artifact("integrated/profile.json", INTEGRATED_PROFILE),
    bindScope(value: IntegratedScope) {
      assert.equal(scope, null, "W049_SCOPE_ALREADY_BOUND");
      for (const id of Object.values(value)) assert.match(id, uuid, "W049_CANONICAL_SCOPE_UUID_REQUIRED");
      scope = { ...value };
    },
    async record(output: NativeJourneyOutput) {
      assert(scope, "W049_ACTUAL_SCOPE_BEFORE_OUTPUT_REQUIRED");
      assert(Object.hasOwn(NATIVE_OUTPUT_SCHEMAS, output.engine), "W049_ENGINE_NOT_IN_FROZEN_PROFILE");
      assert(!outputs.has(output.engine), "W049_NATIVE_OUTPUT_ALREADY_RECORDED");
      assert.equal(output.schema, NATIVE_OUTPUT_SCHEMAS[output.engine]);
      assert.equal(output.tenantId, scope.tenantId); assert.equal(output.principalId, scope.principalId);
      assert.equal(output.companyId, scope.companyId);
      for (const id of [output.workId, output.workInputId, output.requestId]) assert.match(id, uuid);
      assert.equal(output.ref.owner, output.engine);
      assert(opaque(output.ref.id) && opaque(output.ref.version), "W049_OPAQUE_NATIVE_REF_REQUIRED");
      assert.match(output.ref.contentDigest, /^[a-f0-9]{64}$/);
      const privatePath = "integrated/" + output.engine.toLowerCase() + "/private-native-output.json";
      await input.artifact(privatePath, output);
      const privateBytes = await readFile(join(input.output, privatePath));
      const captured = JSON.parse(privateBytes.toString("utf8"));
      assert(captured.consumedBy && opaque(captured.consumedBy.owner), "W049_ACTUAL_NATIVE_CONSUMER_REQUIRED");
      const sanitized: IntegratedPublicOutput = {
        engine: output.engine, schema: output.schema, tenantId: output.tenantId, principalId: output.principalId,
        companyId: output.companyId, workId: output.workId, workInputId: output.workInputId, requestId: output.requestId,
        ref: { owner: output.ref.owner, id: output.ref.id, version: output.ref.version, contentDigest: output.ref.contentDigest },
        consumedBy: { owner: captured.consumedBy.owner, evidenceSha256: sha256(JSON.stringify(captured.consumedBy)) },
        privateEvidenceSha256: sha256(privateBytes),
        qualification: "CONTROLLED_NATIVE_OWNER_CONSUMPTION_NOT_FIELD_OR_FULL_COST",
        completeMonetaryCost: null, independentProtectedCustody: false,
      };
      const path = "integrated/" + output.engine.toLowerCase() + "/actual-native-output.json";
      await input.artifact(path, sanitized);
      outputs.set(output.engine, { ...sanitized, evidence: { path, sha256: sha256(await readFile(join(input.output, path))) } });
    },
    async verifyOriginalCustody(admin: pg.Client) {
      assert(scope, "W049_ACTUAL_SCOPE_BEFORE_CUSTODY_REQUIRED");
      assert.equal(outputs.size, engines.length, "W049_ALL_FIVE_ACTUAL_OUTPUTS_REQUIRED");
      assert.equal(custodyVerified, false);
      for (const output of orderedOutputs()) {
        const row = (await admin.query(`SELECT w.id,w.created_by,w.initial_instruction,w.status,i.instruction_text
          FROM finnor_os.works w JOIN finnor_os.work_inputs i
            ON i.tenant_id=w.tenant_id AND i.work_id=w.id AND i.id=$3
          JOIN finnor_os.work_entity_links l ON l.tenant_id=w.tenant_id AND l.work_id=w.id
            AND l.entity_type='external_organization' AND l.entity_id=$4
          JOIN finnor_os.external_organizations b ON b.tenant_id=l.tenant_id AND b.id=l.entity_id AND b.active
          WHERE w.tenant_id=$1 AND w.id=$2 AND w.created_by=$5`,
        [scope.tenantId, output.workId, output.workInputId, scope.companyId, scope.principalId])).rows[0];
        assert(row && typeof row.initial_instruction === "string" && typeof row.instruction_text === "string",
          "W049_ACTUAL_ORIGINAL_WORK_INPUT_AND_COMPANY_LINK_REQUIRED:" + output.engine);
        originalCustody.push({ engine: output.engine, workId: output.workId, workInputId: output.workInputId,
          workStatus: row.status, initialInstructionSha256: sha256(row.initial_instruction),
          originalInputSha256: sha256(row.instruction_text) });
      }
      custodyVerified = true;
    },
    async finalize(exitCode: number, cleanup: IntegratedCleanup): Promise<IntegratedNativeTerminal> {
      const elapsedMs = performance.now() - input.started;
      const cases = results(), publicOutputs = orderedOutputs();
      for (const output of publicOutputs) {
        assert.equal(sha256(await readFile(join(input.output, output.evidence.path))), output.evidence.sha256,
          "W049_NATIVE_OUTPUT_EVIDENCE_CHANGED");
      }
      const observedCleanup = { status: cleanup.status, steps: cleanup.steps.map(step => ({
        name: step.name, status: step.status,
        ...(step.errorType && /^[A-Za-z]{1,80}$/.test(step.errorType) ? { errorType: step.errorType } : {}),
        ...(step.code && /^[A-Z][A-Z0-9_]{0,127}$/.test(step.code) ? { code: step.code } : {}),
      })) };
      const allObserved = publicOutputs.length === engines.length && cases.every(result => result.status === "PASS");
      const cleanupPassed = cleanup.status === "PASS" && cleanup.steps.length === cleanupNames.length &&
        cleanupNames.every(name => cleanup.steps.filter(step => step.name === name && step.status === "PASS").length === 1);
      const passed = exitCode === 0 && allObserved && cleanupPassed &&
        elapsedMs < INTEGRATED_PROFILE.aggregateSeconds * 1000 + 30000;
      const consumption: IntegratedNativeConsumption = {
        schema: "finnor.w.integrated-native-consumption.v1",
        status: allObserved ? "PASS_NATIVE_CONSUMPTION" : "INCOMPLETE_NATIVE_CONSUMPTION",
        profileClassification: INTEGRATED_PROFILE.classification, scope, outputs: publicOutputs, results: cases,
        originalCustody, completeMonetaryCost: null, independentProtectedCustody: false,
        admitted: false, productionActive: false, fieldValidated: false,
      };
      await input.artifact("integrated/native-consumption.json", consumption);
      const terminal: IntegratedNativeTerminal = {
        schema: "finnor.w.integrated-native-e2e.v1",
        status: passed ? "PASS_CONTROLLED_SHARED_COMPANY_NATIVE_OWNERS" : "FAIL_CLOSED",
        startedAt: input.startedAt, finishedAt: new Date().toISOString(), elapsedMs,
        exitCode: passed ? 0 : exitCode || 1, profile: INTEGRATED_PROFILE, scope, outputs: publicOutputs, results: cases,
        cleanup: observedCleanup, completionGate: "PHASE_W_RELEASE_BLOCKED",
        admitted: false, productionActive: false, fieldValidated: false,
        fullPrdW049Satisfied: false, w050ThroughW053Satisfied: false,
      };
      await input.artifact("integrated/result.json", terminal);
      return terminal;
    },
  };
}
