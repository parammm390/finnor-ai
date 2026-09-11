import { describe, expect, it } from "vitest";
import {
  CANONICAL_ENTITY_TYPES,
  EXECUTABLE_VERTICALS,
  OPERATIONAL_QUERY_INTENTS,
  PARTY_TYPES,
  RETIRED_WATER_ACTION_TYPES,
  RETIRED_WATER_CANONICAL_ENTITY_TYPES,
  RETIRED_WATER_JOB_TYPES,
  RETIRED_WATER_PARTY_TYPES,
  RETIRED_WATER_QUERY_INTENTS,
} from "@finnor/shared-types";
import { PE_ENTITY_TYPES } from "../../packages/private-equity/src/types";
import { activeImportEntityTypes } from "../../packages/import-engine/src/definition";
import { activeCanonicalImportWriterTypes, registerCanonicalImportWriter } from "../../packages/import-engine/src/index";
import { createSourceAdapterRegistry } from "../../packages/tools/src/source-adapters";
import { createDefaultPluginRegistry, operationalQueryIntentsForVertical } from "@finnor/orchestration";
import { ACTIVE_SCHEDULED_SCANS, createWorker } from "../../apps/worker/src/index";
import { scheduleTick } from "../../apps/worker/src/scheduler";

describe("Phase 5 executable runtime boundary", () => {
  it("composes only Core/none and Private Equity contracts", () => {
    expect(EXECUTABLE_VERTICALS).toEqual(["none", "private_equity"]);
    expect(OPERATIONAL_QUERY_INTENTS).toHaveLength(15);
    expect(OPERATIONAL_QUERY_INTENTS).toContain("attention_queue");
    expect(PARTY_TYPES).toEqual(["employee", "team", "location", "external_organization", "external_contact"]);
    expect([...CANONICAL_ENTITY_TYPES, ...PE_ENTITY_TYPES])
      .not.toEqual(expect.arrayContaining([...RETIRED_WATER_CANONICAL_ENTITY_TYPES]));
    expect(PARTY_TYPES).not.toEqual(expect.arrayContaining([...RETIRED_WATER_PARTY_TYPES]));
    expect(OPERATIONAL_QUERY_INTENTS).not.toEqual(expect.arrayContaining([...RETIRED_WATER_QUERY_INTENTS]));
  });

  it("has no retired action, worker, or scheduler registration", () => {
    const plugins = createDefaultPluginRegistry();
    for (const actionType of RETIRED_WATER_ACTION_TYPES) expect(plugins.resolve(actionType)).toBeUndefined();
    const registered = createWorker().registeredTypes();
    expect(registered).not.toEqual(expect.arrayContaining([...RETIRED_WATER_JOB_TYPES]));
    expect(ACTIVE_SCHEDULED_SCANS.map((scan) => scan.type))
      .not.toEqual(expect.arrayContaining([...RETIRED_WATER_JOB_TYPES]));
  });

  it("rejects every former scheduler type before tenant lookup or enqueue", async () => {
    for (const type of RETIRED_WATER_JOB_TYPES) {
      await expect(scheduleTick([{ type, intervalHours: 1, payload: (tenantId) => ({ tenantId }) }]))
        .rejects.toMatchObject({ code: "RETIRED_VERTICAL" });
    }
  });

  it("retains engines but exposes no uncertified Water source/import business mapper", () => {
    expect(createSourceAdapterRegistry().providers()).toEqual([]);
    expect(() => createSourceAdapterRegistry().get("ghl")).toThrow(/no active source-truth mapping/i);
    expect(activeImportEntityTypes()).toEqual([]);
    expect(activeCanonicalImportWriterTypes()).toEqual([]);
    expect(() => registerCanonicalImportWriter("customer", async () => ({
      entityType: "customer",
      entityId: "unreachable",
      action: "created",
    }))).toThrow(/retired/i);
  });

  it("rejects historical product/query selection", () => {
    expect(() => operationalQueryIntentsForVertical("water")).toThrow(/retired.*unavailable/i);
  });
});
