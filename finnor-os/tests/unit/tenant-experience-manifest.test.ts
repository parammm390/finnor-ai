import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_CONFIG,
  TenantExperienceManifestV3Schema,
  WorkspaceConfigSchema,
  normalizeWorkspaceConfig,
} from "../../apps/api/lib/workspace-config";
import { convertLegacyWorkspacePresentation } from "../../scripts/release/workspace-v3-repair";

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

  it("fails closed to PE V3 at runtime instead of adapting an old row", () => {
    const parsed = normalizeWorkspaceConfig({
      version: 1,
      terminology: { home: "HQ", work: "Execution" },
      navigationPriority: ["agents", "home"],
      brand: { accent: "teal", mark: "PE" },
      roles: { untrusted: {} },
    });
    expect(parsed).toEqual(DEFAULT_WORKSPACE_CONFIG);
  });

  it("converts only neutral presentation state in the release data repair", () => {
    const parsed = convertLegacyWorkspacePresentation({
      version: 2,
      enabledSurfaces: ["home", "work", "customers", "schedule", "money", "agents"],
      terminology: { home: "HQ", work: "Execution", customers: "Homeowners" },
      vocabulary: { homeowner: "Homeowner", technician: "Technician" },
      navigationPriority: ["agents", "customers", "home"],
      brand: { accent: "teal", mark: "PE" },
      roles: { dispatcher: {}, technician: {} },
      extensions: { fieldService: true },
    });
    expect(parsed.version).toBe(3);
    expect(parsed.terminology.home).toBe("HQ");
    expect(parsed.navigationPriority).toEqual(["agents", "home", "deals", "work"]);
    expect(parsed.brand.logoAssetKey).toBe("finnor");
    expect(Object.keys(parsed.roles)).toEqual(["owner"]);
    expect(JSON.stringify(parsed)).not.toMatch(/customer|homeowner|technician|dispatcher|schedule|money|fieldService/i);
  });
});
