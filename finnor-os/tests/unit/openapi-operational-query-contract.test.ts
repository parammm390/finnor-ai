import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type JsonSchema = {
  anyOf?: Array<{
    properties?: Record<string, unknown>;
    additionalProperties?: boolean;
  }>;
  allOf?: unknown[];
};

const openapi = JSON.parse(readFileSync(join(process.cwd(), "openapi.json"), "utf8")) as {
  paths: {
    "/api/queries": {
      post: {
        requestBody: { content: { "application/json": { schema: JsonSchema } } };
      };
    };
  };
};

describe("generated operational-query OpenAPI contract", () => {
  it("composes Work metadata into each strict intent branch", () => {
    const schema = openapi.paths["/api/queries"].post.requestBody.content["application/json"].schema;
    expect(schema.allOf).toBeUndefined();
    expect(schema.anyOf).toHaveLength(16);

    for (const branch of schema.anyOf ?? []) {
      expect(branch.additionalProperties).toBe(false);
      expect(branch.properties).toEqual(expect.objectContaining({
        intent: expect.any(Object),
        workId: expect.any(Object),
        executionKey: expect.any(Object),
        idempotencyKey: expect.any(Object),
      }));
      expect(branch.properties).not.toHaveProperty("workInputId");
    }
  });

  it("documents the final public fields on their canonical branches", () => {
    const branches = openapi.paths["/api/queries"].post.requestBody.content["application/json"].schema.anyOf ?? [];
    const byIntent = new Map(branches.map((branch) => [
      (branch.properties?.intent as { const?: string } | undefined)?.const,
      branch.properties ?? {},
    ]));
    expect([...byIntent.keys()].sort()).toEqual([
      "agent_activity",
      "attention_queue",
      "closing_readiness",
      "company_context",
      "critical_dependencies",
      "deal_context",
      "deal_workstreams",
      "open_deal_risks",
      "open_findings",
      "open_requests",
      "party_context",
      "party_lookup",
      "pe_world_state",
      "team_roster",
      "work_list",
      "workforce_status",
    ]);
    expect(byIntent.get("agent_activity")).toEqual(expect.objectContaining({ localDateRange: expect.any(Object) }));
    expect(byIntent.get("workforce_status")).toEqual(expect.objectContaining({ page: expect.any(Object) }));
    expect(byIntent.get("work_list")).toEqual(expect.objectContaining({
      openOnly: expect.any(Object),
      recordId: expect.any(Object),
      // workId is the durable Work attachment metadata, not the query filter.
      workId: expect.any(Object),
    }));
    expect(byIntent.get("attention_queue")).toEqual(expect.objectContaining({
      page: expect.any(Object),
      workId: expect.any(Object),
      executionKey: expect.any(Object),
      idempotencyKey: expect.any(Object),
    }));
    expect(byIntent.get("attention_queue")).not.toEqual(expect.objectContaining({
      employeeId: expect.anything(),
      tenantId: expect.anything(),
    }));
    expect(byIntent.get("company_context")).toEqual(expect.objectContaining({ anchor: expect.any(Object), query: expect.any(Object) }));
    expect(byIntent.get("party_lookup")).toEqual(expect.objectContaining({ ref: expect.any(Object), query: expect.any(Object) }));
    expect(byIntent.get("party_context")).toEqual(expect.objectContaining({ ref: expect.any(Object), query: expect.any(Object) }));
    expect(byIntent.get("team_roster")).toEqual(expect.objectContaining({ teamRef: expect.any(Object), query: expect.any(Object) }));
    expect(byIntent.get("deal_context")).toEqual(expect.objectContaining({ dealId: expect.any(Object), page: expect.any(Object) }));
    expect(byIntent.get("closing_readiness")).toEqual(expect.objectContaining({ dealId: expect.any(Object), page: expect.any(Object) }));
    expect(byIntent.get("pe_world_state")).toEqual(expect.objectContaining({ root: expect.any(Object), at: expect.any(Object) }));
  });
});
