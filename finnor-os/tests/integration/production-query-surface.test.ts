import { ACTION_HARDENING_SPEC } from "../../scripts/release/action-hardening-spec";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CORE_OPERATIONAL_QUERY_INTENTS,
  CONFIDENTIAL_OPERATIONAL_QUERY_INTENTS,
  PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS,
  PROGRAM_OPERATIONAL_QUERY_INTENTS,
  RETIRED_WATER_JOB_TYPES,
} from "@finnor/shared-types";
import { executeHarnessProgramQuery } from "../../packages/private-equity/src/program-synthesis/operational-query";
import {
  scanExecutableText,
  verifyPeDomainBoundary,
  verifyQuerySurfaceCoverage,
} from "../../scripts/release/verify-pe-domain-boundary";

const nativeIntents = [...PROGRAM_OPERATIONAL_QUERY_INTENTS, ...CONFIDENTIAL_OPERATIONAL_QUERY_INTENTS];

const publicIntents = [...CORE_OPERATIONAL_QUERY_INTENTS, ...PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS];

async function openApi() {
  return JSON.parse(await readFile(new URL("../../openapi.json", import.meta.url), "utf8"));
}

const evidenceDirectory = process.env.FINNOR_PRODUCTION_PREFLIGHT_EVIDENCE_DIR
  ? Promise.resolve(process.env.FINNOR_PRODUCTION_PREFLIGHT_EVIDENCE_DIR)
  : mkdtemp(join(tmpdir(), "finnor-production-query-"));

async function retainEvidence(name: string, inputs: unknown, observed: unknown) {
  const directory = await evidenceDirectory;
  await mkdir(directory, { recursive: true });
  const contract = await readFile(new URL("../../openapi.json", import.meta.url));
  await writeFile(join(directory, `${name}.json`), JSON.stringify({
    schema: "finnor.production-query-surface-proof.v1",
    scenario: name,
    inputs,
    steps: ["Load committed OpenAPI", "Execute the real production query boundary or native refusal", "Assert original authority and public-surface invariants"],
    observed,
    openApiSha256: createHash("sha256").update(contract).digest("hex"),
    rerun: "npm --prefix finnor-os test -- --run tests/integration/production-query-surface.test.ts",
  }, null, 2) + "\n");
}

describe("production query surface and native-only authority boundary", () => {
  it("declares every path variable as a required typed parameter", async () => {
    const contract = await openApi();
    const observed: Array<{ path: string; method: string; variables: string[] }> = [];
    for (const [path, item] of Object.entries(contract.paths) as Array<[string, any]>) {
      const variables = [...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]!);
      for (const [method, operation] of Object.entries(item) as Array<[string, any]>) {
        if (!["get", "post", "patch", "put", "delete"].includes(method)) continue;
        const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])];
        for (const name of variables) expect(parameters, `${method} ${path}: ${name}`).toEqual(expect.arrayContaining([
          expect.objectContaining({ name, in: "path", required: true, schema: expect.objectContaining({ type: "string" }) }),
        ]));
        observed.push({ path, method, variables });
      }
    }
    await retainEvidence("required-path-parameters", { contract: "committed OpenAPI" }, observed);
  });
  it("runs the complete production boundary against the generated public contract", async () => {
    const result = await verifyPeDomainBoundary();
    expect(result).toMatchObject({
      negativeControl: true,
      actions: ACTION_HARDENING_SPEC.length,
      publicQueries: publicIntents.length,
      nativeQueries: nativeIntents.length,
    });
    expect(verifyQuerySurfaceCoverage(await openApi())).toEqual([]);
    await retainEvidence("complete-boundary", { publicIntents, nativeIntents }, result);
  });

  it("rejects a missing public query branch and accidental native-only exposure", async () => {
    const contract = await openApi();
    const schema = contract.paths["/api/queries"].post.requestBody.content["application/json"].schema;
    const unionKey = schema.oneOf ? "oneOf" : "anyOf";
    const removed = structuredClone(contract);
    removed.paths["/api/queries"].post.requestBody.content["application/json"].schema[unionKey] =
      schema[unionKey].filter((branch: any) => branch.properties?.intent?.const !== publicIntents[0]);
    expect(verifyQuerySurfaceCoverage(removed)).toContain(`OpenAPI is missing public query intent ${publicIntents[0]}`);
    for (const intent of nativeIntents) {
      const exposed = structuredClone(contract);
      exposed.paths["/api/queries"].post.requestBody.content["application/json"].schema[unionKey].push({
        type: "object", properties: { intent: { const: intent } },
      });
      expect(verifyQuerySurfaceCoverage(exposed)).toContain(`OpenAPI exposes native-only query intent ${intent}`);
    }
    await retainEvidence("surface-negative-controls", {
      removedPublicIntent: publicIntents[0],
      injectedNativeIntents: nativeIntents,
    }, { missingPublicRejected: true, exposedNativeRejected: true });
  });

  it("preserves pre-accounting refusal without authenticated exact-original-Work binding", async () => {
    const request = { intent: PROGRAM_OPERATIONAL_QUERY_INTENTS[0], programId: randomUUID(), workId: randomUUID() };
    await expect(executeHarnessProgramQuery(randomUUID(), request, { workId: request.workId }))
      .rejects.toThrow("HARNESS_AUTHENTICATED_EXACT_WORK_BINDING_REQUIRED");
    expect(scanExecutableText("negative-control.ts", `queue.register("${RETIRED_WATER_JOB_TYPES[0]}", handler);`))
      .toEqual([{ file: "negative-control.ts", line: 1, token: RETIRED_WATER_JOB_TYPES[0] }]);
    await retainEvidence("native-authority-refusal", { request, authenticatedPrincipal: false, originalWorkInput: false }, {
      predicate: "HARNESS_AUTHENTICATED_EXACT_WORK_BINDING_REQUIRED",
      refusedBeforeAccounting: true,
      retiredExecutableRejected: true,
    });
  });
});
