import { describe, expect, it } from "vitest"
import {
  DEFAULT_TENANT_WORKSPACE_CONFIG,
  WORKSPACE_CONTRACT_SHA256,
  effectiveMotionPreference,
  inspectorFieldVisible,
  normalizeWorkspaceConfig,
  orderedWorkspaceItems,
  sceneSlot,
  vocabularyLabel,
} from "./workspace-config"

describe("Private Equity tenant workspace V3", () => {
  it("uses the generated canonical surface and role contract", () => {
    expect(DEFAULT_TENANT_WORKSPACE_CONFIG.version).toBe(3)
    expect(DEFAULT_TENANT_WORKSPACE_CONFIG.enabledSurfaces).toEqual(["home", "work", "deals", "agents"])
    expect(Object.keys(DEFAULT_TENANT_WORKSPACE_CONFIG.roles)).toEqual(["owner"])
    expect(WORKSPACE_CONTRACT_SHA256).toMatch(/^[a-f0-9]{64}$/)
  })

  it("orders source-defined surfaces without inventing routes", () => {
    const items = [{ key: "agents" as const }, { key: "home" as const }, { key: "deals" as const }]
    expect(orderedWorkspaceItems(items, DEFAULT_TENANT_WORKSPACE_CONFIG, "owner").map((item) => item.key))
      .toEqual(["home", "deals", "agents"])
  })

  it("fails closed to canonical PE V3 when an old row reaches the browser", () => {
    const config = normalizeWorkspaceConfig({
      version: 1,
      enabledSurfaces: ["unregistered"],
      terminology: { home: "HQ", work: "Execution", removed: "Must not survive" },
      voiceEnabled: false,
      navigationPriority: ["agents", "removed", "home"],
      brand: { accent: "teal", radius: "soft", mark: "AC", logoAssetKey: "untrusted" },
      visibility: { policy: false, authority: true },
      roles: { removed: {} },
    })
    expect(config).toEqual(DEFAULT_TENANT_WORKSPACE_CONFIG)
  })

  it("keeps vocabulary, motion, and visibility presentation-only", () => {
    const config = {
      ...DEFAULT_TENANT_WORKSPACE_CONFIG,
      vocabulary: { ...DEFAULT_TENANT_WORKSPACE_CONFIG.vocabulary, closingItem: "Closing Gate" },
      visibility: { policy: false, authority: false },
    }
    expect(vocabularyLabel("closing_item", config)).toBe("Closing Gate")
    expect(vocabularyLabel("unregistered_object", config)).toBe("Unregistered Object")
    expect(sceneSlot("approval")).toBeNull()
    expect(effectiveMotionPreference("expressive", true)).toBe("reduced")
    expect(inspectorFieldVisible("Policy / permission", config)).toBe(false)
    expect(inspectorFieldVisible("Authority boundary", config)).toBe(false)
    expect(inspectorFieldVisible("What happened", config)).toBe(true)
  })
})
