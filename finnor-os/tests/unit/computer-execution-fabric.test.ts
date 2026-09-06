import { describe, expect, it, vi } from "vitest";
import {
  ComputerBroker,
  ComputerOriginError,
  ComputerProviderError,
  SteelProvider,
  assertAllowedUrl,
  authorizedEffectHash,
  deriveComputerOriginPolicy,
  effectsExactlyEqual,
  observationVerifiesEffect,
  readOnlyRequestWouldMutate,
  redactComputerValue,
  safePageUrl,
  type ComputerProvider,
} from "@finnor/computer";
import { computerTaskPlugin, ComputerTaskSchema } from "../../packages/domain-plugins/computer-task/index";
import { createDefaultPluginRegistry } from "../../packages/orchestration/src/plugin-registry";
import { LLMPlanner } from "../../packages/orchestration/src/planner";
import { COMPUTER_ACTION_HARDENING_SPEC, TOTAL_ACTION_COUNT } from "../../scripts/release/action-hardening-spec";

const readTask = {
  application: "diligence_portal",
  authProfileRef: "diligence-readonly",
  task: "Find the current status for diligence record DD-48",
  target: { kind: "diligence_record", identifier: "DD-48" },
  mode: "READ_ONLY" as const,
  successCriteria: ["The record is identified and its current evidence status is observed"],
};

const effect = {
  operation: "update_diligence_note",
  target: { kind: "diligence_record", identifier: "DD-48" },
  changes: { note: "Counsel review requested" },
};

describe("computer_task planner contract", () => {
  it("exposes one business action and no browser primitives", () => {
    expect(ComputerTaskSchema.parse(readTask)).toEqual(readTask);
    expect(computerTaskPlugin.actionTypes).toEqual(["computer_task"]);
    const plannerSpec = createDefaultPluginRegistry().payloadSpecJson().split("\n").find((line) => line.startsWith("computer_task:"));
    expect(plannerSpec).toContain("application*");
    expect(plannerSpec).toContain("authorizedEffect?");
    for (const primitive of ["click", "type", "navigate", "screenshot", "mouse_move", "execute_js"]) {
      expect(computerTaskPlugin.actionTypes).not.toContain(primitive);
    }
  });

  it("requires an exact write envelope and forbids one for read-only", () => {
    expect(ComputerTaskSchema.safeParse({ ...readTask, authorizedEffect: effect }).success).toBe(false);
    expect(ComputerTaskSchema.safeParse({ ...readTask, mode: "WRITE" }).success).toBe(false);
    expect(ComputerTaskSchema.safeParse({ ...readTask, mode: "WRITE", authorizedEffect: effect }).success).toBe(true);
    expect(ComputerTaskSchema.safeParse({ ...readTask, mode: "WRITE", authorizedEffect: { ...effect, target: { ...effect.target, identifier: "WS-49" } } }).success).toBe(false);
  });

  it("registers one computer action in the active fixed catalog", () => {
    const registry = createDefaultPluginRegistry();
    expect(registry.actionTypes()).toHaveLength(TOTAL_ACTION_COUNT);
    expect(registry.resolve("computer_task")?.name).toBe("computer-task");
    expect(COMPUTER_ACTION_HARDENING_SPEC).toEqual([expect.objectContaining({ actionType: "computer_task", approvalFloor: "POLICY", receipt: true })]);
  });

  it("keeps native/API execution ahead of computer use and ambiguity ahead of provisioning", () => {
    const registry = createDefaultPluginRegistry();
    const planner = new LLMPlanner(registry, { name: "unused", async complete() { return '{"actions":[]}'; } });
    const prompt = (planner as unknown as { systemPrompt(): string }).systemPrompt();
    expect(prompt).toContain("Use computer_task only when no reliable canonical/native/API capability can complete the task");
    expect(prompt).toContain("a governed auth profile is available");
    expect(prompt).toContain("Never invent identifiers");
    expect(ComputerTaskSchema.safeParse({ ...readTask, target: undefined }).success).toBe(false);
  });
});

describe("provider-neutral broker and Steel adapter", () => {
  it("negotiates only providers with every required capability", () => {
    const provider = { name: "fake", capabilities: new Set(["cloud_session", "structured_page"]) } as unknown as ComputerProvider;
    const broker = new ComputerBroker();
    broker.register(provider);
    expect(broker.negotiate("fake", ["cloud_session"])).toBe(provider);
    expect(() => broker.negotiate("fake", ["screenshot"])).toThrow(ComputerProviderError);
    expect(() => broker.negotiate("missing", [])).toThrow(/unavailable/);
  });

  it("maps the verified Steel 0.18 session lifecycle without leaking SDK shapes", async () => {
    const create = vi.fn().mockResolvedValue({ id: "session-1", websocketUrl: "wss://connect.steel.dev?session=session-1", sessionViewerUrl: "https://viewer.steel.dev/session-1", creditsUsed: 0 });
    const release = vi.fn().mockResolvedValue({ success: true });
    const route = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const browser = { contexts: () => [{ route, pages: () => [] }], close };
    const provider = new SteelProvider({
      apiKey: "in-memory-test-key",
      client: { sessions: { create, release, retrieve: vi.fn(), liveDetails: vi.fn(), computer: vi.fn(), files: { list: vi.fn(), download: vi.fn() } } } as never,
      connectOverCDP: vi.fn().mockResolvedValue(browser),
    });
    const session = await provider.createSession({
      tenantId: "tenant-a",
      runId: "run-a",
      auth: { profileId: "credential-sensitive-profile" },
      mode: "READ_ONLY",
      origins: { homeUrl: "https://diligence.example/records", allowedOrigins: ["https://diligence.example"], authOrigins: [] },
      limits: { maxSteps: 5, timeoutMs: 60_000, maxProviderCredits: 2, maxScreenshots: 1, maxArtifacts: 2, maxDownloadBytes: 1024, maxUploadBytes: 0, maxOutputBytes: 4096 },
    });
    expect(session).toEqual({ sessionRef: "session-1", cdpUrl: expect.any(String), liveViewUrl: expect.any(String), executionMode: "READ_ONLY", downloadLimitBytes: 1024 });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ profileId: "credential-sensitive-profile", persistProfile: false, timeout: 60_000, debugConfig: { interactive: false, systemCursor: true } }));
    await provider.release(session);
    expect(close).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith("session-1");
  });
});

describe("origin, effect, evidence, and redaction boundaries", () => {
  it("derives origins only from governed configuration and lets restrictions narrow", () => {
    const policy = deriveComputerOriginPolicy(
      { homeUrl: "https://diligence.example/records", allowedOrigins: ["https://diligence.example", "https://cdn.example"], authOrigins: ["https://login.example"] },
      { allowedOrigins: ["https://diligence.example"], allowedAuthOrigins: ["https://login.example"] },
    );
    expect(policy.allowedOrigins).toEqual(["https://diligence.example"]);
    expect(assertAllowedUrl("https://login.example/sso/callback?code=hidden", policy)).toContain("login.example");
    expect(() => assertAllowedUrl("https://evil.example/redirect", policy)).toThrow(ComputerOriginError);
    expect(safePageUrl("https://diligence.example/record?id=secret#fragment")).toBe("https://diligence.example/record");
  });

  it("compares semantic effects exactly, including every changed field", () => {
    expect(effectsExactlyEqual(effect, { ...effect, changes: { note: "Counsel review requested" } })).toBe(true);
    expect(effectsExactlyEqual(effect, { ...effect, changes: { note: "Counsel review requested", priority: true } })).toBe(false);
    expect(authorizedEffectHash(effect)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("blocks non-idempotent application traffic in read-only mode without relying on labels", () => {
    const origins = { homeUrl: "https://diligence.example", allowedOrigins: ["https://diligence.example"], authOrigins: [] };
    expect(readOnlyRequestWouldMutate("READ_ONLY", "POST", "fetch", "https://diligence.example/records/DD-48", origins)).toBe(true);
    expect(readOnlyRequestWouldMutate("READ_ONLY", "GET", "document", "https://diligence.example/records/DD-48", origins)).toBe(false);
    expect(readOnlyRequestWouldMutate("WRITE", "POST", "fetch", "https://diligence.example/records/DD-48", origins)).toBe(false);
  });

  it("requires literal post-state evidence for a write", () => {
    expect(observationVerifiesEffect({ url: "https://diligence.example/records/DD-48", title: "Diligence DD-48", text: "Note: Counsel review requested", elements: [], openPageUrls: [] }, effect)).toBe(true);
    expect(observationVerifiesEffect({ url: "https://diligence.example/records/DD-48", title: "Diligence DD-48", text: "Saved", elements: [], openPageUrls: [] }, effect)).toBe(false);
  });

  it("redacts secret-shaped state and sensitive values before persistence", () => {
    expect(redactComputerValue({ apiKey: "key", cookie: "session", nested: { result: "safe", note: "contains-private-value", authorization: "Bearer should-be-hidden" }, tokenText: "Bearer abcdefghijklmnopqrstuvwxyz" }, ["private-value"])).toEqual({
      apiKey: "[REDACTED]",
      cookie: "[REDACTED]",
      nested: { result: "safe", note: "[REDACTED]", authorization: "[REDACTED]" },
      tokenText: "[REDACTED]",
    });
  });
});
