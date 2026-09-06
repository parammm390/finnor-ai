import { describe, expect, it } from "vitest";
import { parseImportDefinition } from "@finnor/import-engine";

describe("Phase-5 import boundary", () => {
  it.each(["customer", "lead", "appointment", "invoice", "technician"])(
    "rejects the retired %s import entity before any rows are processed",
    (entity) => {
      expect(() => parseImportDefinition({
        version: 1,
        name: "retired-definition",
        entity,
        source: { kind: "csv" },
        fields: {},
      })).toThrow(/water product vertical is retired/i);
    },
  );
});
