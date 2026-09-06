// Phase 5: no retired vertical workflow is graph-routable, including through env.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { graphActionTypeAllowlist, DEFAULT_GRAPH_ACTION_TYPES } from "@finnor/orchestration";

describe("graphActionTypeAllowlist", () => {
  const ENV_KEY = "ORCHESTRATION_ENGINE_GRAPH_ACTION_TYPES";
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[ENV_KEY];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it("defaults to DEFAULT_GRAPH_ACTION_TYPES when the env var is unset", () => {
    delete process.env[ENV_KEY];
    expect(graphActionTypeAllowlist()).toEqual(new Set(DEFAULT_GRAPH_ACTION_TYPES));
    expect(DEFAULT_GRAPH_ACTION_TYPES).toEqual([]);
  });

  it("an explicit empty string means an explicit empty allowlist — NOT the default", () => {
    process.env[ENV_KEY] = "";
    expect(graphActionTypeAllowlist()).toEqual(new Set());
  });

  it("accepts an explicit active action and rejects retired entries", () => {
    process.env[ENV_KEY] = "open_workstream";
    expect(graphActionTypeAllowlist()).toEqual(new Set(["open_workstream"]));
    process.env[ENV_KEY] = "schedule_water_test";
    expect(() => graphActionTypeAllowlist()).toThrow(/retired Water graph action/i);
  });
});
