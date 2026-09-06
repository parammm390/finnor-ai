import { describe, expect, it } from "vitest";
import { createSourceAdapterRegistry, IntegrationError } from "@finnor/tools";

describe("Phase-5 source adapter composition", () => {
  it("registers no legacy provider-to-business mappings", () => {
    const registry = createSourceAdapterRegistry();
    expect(registry.providers()).toEqual([]);
    for (const provider of ["ghl", "quickbooks", "stripe"]) {
      expect(() => registry.get(provider)).toThrow(IntegrationError);
      expect(() => registry.get(provider)).toThrow(/no active source-truth mapping/i);
    }
  });
});
