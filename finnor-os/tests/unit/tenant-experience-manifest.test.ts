import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_CONFIG,
  TenantExperienceManifestV3Schema,
  WorkspaceConfigSchema,
} from "../../apps/api/lib/workspace-config";

describe("Private Equity tenant experience manifest v3", () => {
  it("has only active surfaces and the owner role", () => {
    const parsed = WorkspaceConfigSchema.parse(DEFAULT_WORKSPACE_CONFIG);
    expect(parsed.version).toBe(3);
    expect(parsed.enabledSurfaces).toEqual(["home", "work", "deals", "agents"]);
    expect(Object.keys(parsed.roles)).toEqual(["owner"]);
    expect(parsed.roles.owner.ready.primaryProjection).toBe("deal");
    expect(JSON.stringify(parsed)).not.toMatch(/customer|schedule|inventory|technician|dispatcher/i);
  });

  it("rejects removed surfaces, roles, metrics, and arbitrary extensions", () => {
    const cases: unknown[] = [];
    const surface = structuredClone(DEFAULT_WORKSPACE_CONFIG) as any;
    surface.enabledSurfaces = ["home", "work", "customers", "agents"];
    cases.push(surface);
    const role = structuredClone(DEFAULT_WORKSPACE_CONFIG) as any;
    role.roles.dispatcher = role.roles.owner;
    cases.push(role);
    const metric = structuredClone(DEFAULT_WORKSPACE_CONFIG) as any;
    metric.roles.owner.ready.pulseMetrics = ["collected_usd"];
    cases.push(metric);
    const extension = structuredClone(DEFAULT_WORKSPACE_CONFIG) as any;
    extension.extensions.arbitrary = {};
    cases.push(extension);
    for (const candidate of cases) expect(TenantExperienceManifestV3Schema.safeParse(candidate).success).toBe(false);
  });
});
