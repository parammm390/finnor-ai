import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, configureTenantVertical } from "@finnor/db";
import {
  FinnorOrchestrator, LLMPlanner, createDefaultPluginRegistry,
  type LLMProvider, type PlanningResult,
} from "@finnor/orchestration";
import { configureAgentProfile } from "../../packages/orchestration/src/workforce-runtime";
import { createDeal, createFund, createOpportunity, createStrategy, type PeMutationContext } from "@finnor/private-equity";
import type { CanonicalOperationalQueryRequest, ObjectiveSuccessCondition, PeWorldRootRef } from "@finnor/shared-types";
import { assertDisposableDatabaseTarget } from "../../packages/db/production-target-guard";
import { CURRENT_MIGRATION_HEAD } from "../../packages/db/migration-head";
import { startHeartbeat } from "../../apps/worker/src/heartbeat";
import { readWorkerFleetReadiness } from "../../apps/api/lib/worker-readiness";
import { browserHttpFixture } from "../../scripts/v2/browser-http-fixture.mjs";
import { operatingSelection } from "../../../src/components/centropy/world/world-context";
import { buildConstraintSet, type PlanningConstraint } from "@finnor/planning";
import { registerProvider } from "../../packages/orchestration/src/llm";

// Authoring gate: this owns the authenticated non-Deal objective regression.
// A real owner world read and the generic graph test do not exercise HTTP intake,
// accepted scope, Deal fallback, principal restoration or economic completion.
// Only the model proposal is deterministic; owners, authority, plans, queries,
// receipts and completion checks are real and no success receipt is supplied.
const SOURCE_DATABASE_URL = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
const available = await (async () => {
  if (!SOURCE_DATABASE_URL) return false;
  assertDisposableDatabaseTarget(SOURCE_DATABASE_URL, "PE objective world-scope E2E");
  const client = new pg.Client({ connectionString: SOURCE_DATABASE_URL, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); return true; } catch { return false; } finally { await client.end().catch(() => undefined); }
})();

describe.skipIf(!available)("authenticated PE objective world scope", () => {
  const tenantId = randomUUID(), foreignTenantId = randomUUID();
  const actorId = randomUUID(), otherActorId = randomUUID(), foreignActorId = randomUUID();
  const reviewFixtures = process.env.FINNOR_DOCUMENT_REVIEW_FIXTURES;
  const companyId = reviewFixtures ? "11111111-1111-4111-8111-111111111111" : randomUUID(), roleId = randomUUID();
  const runId = randomUUID();
  const evidenceDirectory = process.env.FINNOR_PE_OBJECTIVE_EVIDENCE_DIR ?? join(tmpdir(), "finnor-pe-objective-world-scope", runId);
  const observations: Array<Record<string, unknown>> = [];
  let sourceCut: Record<string, unknown>;
  const originalEnvironment = Object.fromEntries(["DATABASE_URL", "SECRETS_PROVIDER", "HEALTHCHECK_PING_URL", "RATE_LIMIT_INTAKE_PER_MINUTE", "RATE_LIMIT_PER_MINUTE", "RATE_LIMIT_IP_PER_MINUTE"].map(key => [key, process.env[key]]));
  let admin: pg.Client;
  let http: Awaited<ReturnType<typeof browserHttpFixture>>;
  let heartbeat: ReturnType<typeof startHeartbeat>;
  const heartbeatStop = new AbortController();
  let opportunity: PeWorldRootRef, fund: PeWorldRootRef, foreignFund: PeWorldRootRef;
  let incidentalDealId: string;
  const ctx: PeMutationContext = { auth: { tenantId, userId: actorId, employeeId: actorId, role: "owner" }, provenance: { sourceSystem: "integration:pe-objective-world-scope", createdBy: actorId } };

  async function record(step: string, value: unknown) {
    observations.push({ step, observedAt: new Date().toISOString(), value });
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(join(evidenceDirectory, `world-scope-${runId}.json`), JSON.stringify({
      schema: "finnor.pe-objective-world-scope-e2e.v1", runId,
      qualification: "Disposable signed local authentication, ordinary SQL role, actual HTTP routes, canonical owners and Objective runtime. Deterministic proposal source; no field-profit, browser or production-activation claim.",
      rerun: "Set DATABASE_URL to the migrated disposable admin database and FINNOR_PE_OBJECTIVE_EVIDENCE_DIR to a private directory; run vitest run tests/integration/pe-objective-world-scope.test.ts from finnor-os.",
      sourceCut, inputs: { tenantId, actorId, opportunity, fund, foreignFund, incidentalDealId }, observations,
    }, null, 2) + "\n");
  }

  function context(root: PeWorldRootRef, shape: "selected" | "focused" | "businessRoot" = "selected") {
    return {
      version: 1, capturedAt: new Date().toISOString(), source: "text",
      selectedEntities: shape === "selected" ? [root] : [], excludedEntities: [],
      ...(shape === "focused" ? { focusedEntity: root } : {}),
      ...(shape === "businessRoot" ? { businessRoot: root } : {}),
      surface: { id: "world", route: "/centropy", spatialState: "detail" }, filters: [],
    };
  }

  async function verifyFinancialExplanation(selected: boolean, mounted = false) {
    const instruction = "What are the enterprise value, equity purchase price, and total sponsor cash at entry in this synthetic FIN-01 example? Source A: FY2025 EBITDA USD 20 million. Source B: FY2025 EBITDA USD 18 million. Both are supplied, unresolved assertions for the same company and period. Apply EV/EBITDA 8.0x to each; net debt USD 60 million; transaction fees USD 5 million; all equity paid by the sponsor; no rollover, other funding, liabilities, or adjustments. Show formulas, both cases and the discrepancy. Do not choose a preferred source or treat these figures as verified company data. This is an explanation only; do not create records or execute actions.";
    const proposal = {
      status: "ready", title: "Entry valuation comparison",
      inputs: [
        { id: "a", label: "Source A EBITDA", quote: "Source A: FY2025 EBITDA USD 20 million.", literal: "USD 20 million" },
        { id: "b", label: "Source B EBITDA", quote: "Source B: FY2025 EBITDA USD 18 million.", literal: "USD 18 million" },
        { id: "multiple", label: "Entry multiple", quote: "Apply EV/EBITDA 8.0x", literal: "8.0x" },
        { id: "debt", label: "Net debt", quote: "net debt USD 60 million", literal: "USD 60 million" },
        { id: "fees", label: "Transaction fees", quote: "transaction fees USD 5 million", literal: "USD 5 million" },
      ],
      steps: [
        { id: "ev_a", label: "A enterprise value", op: "multiply", left: "a", right: "multiple" },
        { id: "eq_a", label: "A equity price", op: "subtract", left: "ev_a", right: "debt" },
        { id: "cash_a", label: "A sponsor cash", op: "add", left: "eq_a", right: "fees" },
        { id: "ev_b", label: "B enterprise value", op: "multiply", left: "b", right: "multiple" },
        { id: "eq_b", label: "B equity price", op: "subtract", left: "ev_b", right: "debt" },
        { id: "cash_b", label: "B sponsor cash", op: "add", left: "eq_b", right: "fees" },
        { id: "difference", label: "Difference in each output", op: "subtract", left: "ev_a", right: "ev_b" },
      ],
      outputs: ["ev_a", "eq_a", "cash_a", "ev_b", "eq_b", "cash_b", "difference"],
      assumptions: ["all equity paid by the sponsor", "no rollover, other funding, liabilities, or adjustments"], gaps: [],
    };
    const providerKey = `checked-explanation-${runId}`, calls: unknown[] = [];
    const prior = process.env.LLM_PROVIDER_ANSWER_TEXT;
    let markSecondProposalStarted = () => {};
    let releaseSecondProposal = () => {};
    const secondProposalStarted = new Promise<void>(resolve => { markSecondProposalStarted = resolve; });
    const secondProposalGate = new Promise<void>(resolve => { releaseSecondProposal = resolve; });
    registerProvider(providerKey, () => ({ name: providerKey, contextWindowTokens: 131072, async complete(options) {
      const request = JSON.parse(options.user); calls.push(request);
      expect(request.instruction).toBe(instruction);
      if (mounted && calls.length === 2) {
        markSecondProposalStarted();
        await secondProposalGate;
      }
      return JSON.stringify(proposal);
    } }));
    process.env.LLM_PROVIDER_ANSWER_TEXT = providerKey;
    try {
      const idempotencyKey = `checked-explanation:${randomUUID()}`;
      let body: unknown = { instruction, channel: "text", idempotencyKey, ...(selected ? { activeContext: context({ entityType: "pe_deal", entityId: incidentalDealId }) } : {}) };
      let expectedCalls = 1;
      let response: Awaited<ReturnType<typeof http.request>>;
      if (mounted) {
        const { verifyMountedFinancialExplanation } = await import("../../scripts/transformation/mounted-financial-explanation");
        const browser = await verifyMountedFinancialExplanation({
          output: evidenceDirectory, authOrigin: http.authOrigin, apiOrigin: http.origin,
          email: http.loginEmail, peerEmail: `${otherActorId}@world.test.invalid`,
          createSiblingThread: async () => {
            const created = await http.request("threads", { title: "Cancellation rehearsal" });
            expect(created.status).toBe(201);
            return created.body.thread.id as string;
          },
          instruction, secondProposalStarted, releaseSecondProposal,
        });
        body = browser.request;
        response = browser.response;
        expectedCalls = 2;
        const cancelledInstructionId = browser.cancelled.request.instructionId;
        const cancelled = await state(cancelledInstructionId);
        const cancelledEvents = (await admin.query("SELECT seq,phase FROM finnor_os.instruction_events WHERE tenant_id=$1 AND instruction_id=$2 ORDER BY seq", [tenantId, cancelledInstructionId])).rows;
        await record("mounted-financial-explanation", { browser, cancelled, cancelledEvents, transport: http.observed });
        expect(cancelled.work.status).toBe("cancelled");
        expect(cancelledEvents.map(event => event.phase)).toContain("cancelled");
        expect(cancelledEvents.map(event => event.phase)).not.toContain("completed");
      } else {
        response = await http.request("actions", body);
      }
      const current = await state(response.body.workId);
      const effects = (await admin.query("SELECT id FROM finnor_os.domain_actions WHERE tenant_id=$1 AND work_id=$2", [tenantId, response.body.workId])).rows;
      await record("checked-financial-explanation", { selected, instruction, proposal, response, current, effects, calls, independentExpected: [160000000, 100000000, 105000000, 144000000, 84000000, 89000000, 16000000] });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.answer.analysis.status).toBe("checked");
      expect(response.body.answer.analysis.calculations.map((item: { value: { numerator: string; denominator: string; unit: string } }) => item.value)).toEqual(
        [160000000, 100000000, 105000000, 144000000, 84000000, 89000000, 16000000].map(value => ({ numerator: String(value), denominator: "1", unit: "USD", formatted: expect.any(String) })),
      );
      expect(response.body.objective).toBeUndefined();
      expect(current.work.status).toBe("completed"); expect(current.loop).toBeUndefined();
      expect(current.queries).toEqual([]); expect(effects).toEqual([]); expect(calls).toHaveLength(expectedCalls);
      const thread = await http.read(`threads/${response.body.threadId}`);
      expect(thread.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", originalText: response.body.answer.spokenSummary })]));
      const replay = await http.request("actions", body);
      expect(replay.body.answer.analysis).toEqual(response.body.answer.analysis);
      expect(calls).toHaveLength(expectedCalls);
      const aggregate = await http.read(`works/${response.body.workId}`);
      expect(aggregate.body.work.work.finalOutcome.answer.analysis).toEqual(response.body.answer.analysis);
    } finally {
      releaseSecondProposal();
      if (prior === undefined) delete process.env.LLM_PROVIDER_ANSWER_TEXT; else process.env.LLM_PROVIDER_ANSWER_TEXT = prior;
    }
  }

  it.each([false, true])("delivers a checked supplied financial explanation without incidental execution, selected Deal %s", async selected => {
    await verifyFinancialExplanation(selected);
  });
  if (process.env.FINNOR_MOUNTED_FIN01 === "1") {
    it("delivers and restores original FIN-01 through the mounted workspace", () => verifyFinancialExplanation(false, true), 210_000);
  }

  const sourceProxy = process.env.FINNOR_SOURCE_PROXY_PDF;
  if (sourceProxy) {
    it("reports incomplete coverage for an original merger proxy and exports a scoped forecast comparison", async () => {
      const { bindArtifact, ingestArtifact } = await import("@finnor/artifacts");
      const bytes = await readFile(sourceProxy);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const title = "AvidXchange Holdings definitive merger proxy, August 15, 2025";
      const artifact = await ingestArtifact(ctx.auth, { title, bytes, origin: "manual_upload" });
      const anchor = artifact.ir.nodes.find(node => node.kind === "page" && node.data.page === 87);
      await record("source-proxy-ingested", { title, sha256, documentId: artifact.documentId, version: artifact.version, anchor });
      expect(artifact.version.byte_sha256).toBe(sha256);
      if (!anchor) throw new Error("Missing native proxy page 87");
      await bindArtifact(ctx.auth, artifact.documentId, {
        versionId: artifact.version.id, anchorId: anchor.id, anchorHash: anchor.hash,
        targetKind: "canonical_entity", targetEntityType: "external_organization", targetId: companyId,
      });
      const body = {
        instruction: "Identify conflicting financial figures across this deal's documents. Show both values and their sources.",
        channel: "text", idempotencyKey: randomUUID(),
        activeContext: context({ entityType: "pe_deal", entityId: incidentalDealId }, "businessRoot"),
      };
      const response = await http.request("actions", body);
      const live = await http.read(`works/${response.body.workId}`);
      await record("source-proxy-investigation", { body, response, live });
      expect(response.status).toBe(201);
      expect(live.status).toBe(200);
      expect(live.body.work.documentReview).toMatchObject({
        status: "reviewed", coverage: "partial", documentsReviewed: 0, comparableGroups: 0, findings: [],
      });
      expect(live.body.work.documentReview.gaps.join(" ")).toMatch(/registered financial table|financial tables are incomplete/);
      expect(response.body.answer.spokenSummary).toContain("No financial tables could be reviewed");

      const forecastQuestion = `Compare FY2027 Adjusted EBITDA forecasts on PDF pages 87 and 88 of "${title}" at 8x EV/EBITDA, treating $ as USD.`;
      const forecastInput = { ...body, instruction: forecastQuestion, idempotencyKey: randomUUID() };
      const forecastIntake = await http.request("actions", forecastInput);
      await record("source-proxy-forecast-intake", { input: forecastInput, response: forecastIntake });
      expect(forecastIntake.status).toBe(201);
      expect(forecastIntake.body.objective).toBeUndefined();
      const path = `works/${forecastIntake.body.workId}`;
      const forecastWork = await http.read(path);
      await record("source-proxy-forecast-owner", forecastWork);
      const forecastReview = forecastWork.body.work.documentReview;
      expect(forecastReview).toMatchObject({ documentsReviewed: 1, comparableGroups: 1, findings: [], valuation: {
        status: "calculated", forecast: { year: 2027, definition: expect.stringContaining("inclusive of forecasted public company costs") },
        entryMultiple: "8", currency: "USD", enterpriseValueSpread: "456000000", funding: { status: "requires_input" },
        cases: [
          { ebitda: "157000000", enterpriseValue: "1256000000", source: {
            vintage: "Risk-Adjusted Forecasts", versionId: artifact.version.id, sha256, anchor: { page: 88, quote: expect.stringContaining("$157") },
          }, funding: null },
          { ebitda: "214000000", enterpriseValue: "1712000000", source: {
            vintage: "February 2025 Forecasts", versionId: artifact.version.id, sha256, anchor: { page: 87, quote: expect.stringContaining("$214") },
          }, funding: null },
        ],
      } });
      expect(JSON.stringify(forecastWork.body.work.work.finalOutcome)).not.toMatch(/157000000|214000000/);
      const briefQuery = { export: "valuation-brief" };
      const brief = await http.readResponse(path, briefQuery);
      const briefText = await brief.text();
      expect(brief.status).toBe(200);
      expect(brief.headers.get("cache-control")).toContain("no-store");
      for (const value of ["FY2027", "February 2025 Forecasts", "Risk-Adjusted Forecasts", "public company costs", "USD 456,000,000",
        "USD 1,256,000,000", "USD 1,712,000,000", "page 87", "page 88", sha256]) expect(briefText).toContain(value);
      await writeFile(join(evidenceDirectory, "avidxchange-forecast-brief.md"), briefText);

      const differentBasis = await http.request("actions", {
        ...forecastInput, idempotencyKey: randomUUID(), instruction: forecastQuestion.replace("87 and 88", "86 and 87"),
      });
      expect(differentBasis.status).toBe(201);
      const unsupportedPath = `works/${differentBasis.body.workId}`;
      const unsupported = await http.read(unsupportedPath);
      expect(unsupported.body.work.documentReview.valuation).toMatchObject({ status: "requires_input", reason: expect.stringContaining("same Adjusted EBITDA definition") });
      expect(unsupported.body.work.documentReview.gaps).toContain("Adjusted EBITDA definition footnotes differ on PDF pages 86 and 87.");
      const unsupportedBrief = await http.readResponse(unsupportedPath, briefQuery);
      expect(unsupportedBrief.status).toBe(404);
      const peerBrief = await http.readResponse(path, briefQuery, "other");
      expect(peerBrief.status).toBe(404);
      const archiveSource = async () => {
        await admin.query("UPDATE finnor_os.documents SET archived_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, artifact.documentId]);
      };
      if (process.env.FINNOR_SOURCE_PROXY_MOUNTED === "1") {
        const { verifyMountedDocumentReview } = await import("../../scripts/transformation/mounted-financial-explanation");
        const browser = await verifyMountedDocumentReview({
          kind: "forecast", output: evidenceDirectory, authOrigin: http.authOrigin, apiOrigin: http.origin, email: http.loginEmail,
          archiveSource, valuationRequest: { dealId: incidentalDealId, instruction: forecastQuestion },
          spread: "USD 456,000,000", cells: ["USD 157,000,000", "USD 1,256,000,000", "USD 214,000,000", "USD 1,712,000,000"],
          vintages: ["Risk-Adjusted Forecasts · page 88", "February 2025 Forecasts · page 87"], briefText,
        });
        await record("source-proxy-forecast-mounted", browser);
      } else await archiveSource();
      const stale = await http.read(path);
      expect(stale.body.work.documentReview).toEqual({ status: "stale" });
      const staleBrief = await http.readResponse(path, briefQuery);
      expect(staleBrief.status).toBe(409);
      const actions = await admin.query("SELECT id FROM finnor_os.domain_actions WHERE tenant_id=$1 AND work_id=$2", [tenantId, forecastIntake.body.workId]);
      expect(actions.rows).toEqual([]);
      await record("source-proxy-forecast-export", { briefText, unsupported, unsupportedBrief: unsupportedBrief.status, peerBrief: peerBrief.status,
        stale, staleBrief: staleBrief.status, actions: actions.rows });
    }, 210_000);
  }

  if (reviewFixtures) {
    it("compares current document figures through a signed Investigation", async () => {
      const { bindArtifact, ingestArtifact } = await import("@finnor/artifacts");
      const artifacts: Array<{ id: string; versionId: string; sha256: string; title: string }> = [];
      for (const [title, path] of [["Management financials", "management/financials.xlsx"], ["Quality of earnings", "qoe/financials.pdf"]] as const) {
        const bytes = await readFile(join(reviewFixtures, path));
        const artifact = await ingestArtifact(ctx.auth, { title, bytes, origin: "manual_upload" });
        const anchor = artifact.ir.nodes.find(node => node.kind === "cell" || node.kind === "page");
        expect(anchor, "Source must have an actual cell or page anchor").toBeDefined();
        await bindArtifact(ctx.auth, artifact.documentId, {
          versionId: artifact.version.id, anchorId: anchor!.id, anchorHash: anchor!.hash,
          targetKind: "canonical_entity", targetEntityType: "external_organization", targetId: companyId,
        });
        artifacts.push({ id: artifact.documentId, versionId: artifact.version.id, sha256: artifact.version.byte_sha256, title });
      }
      const instruction = "Identify conflicting financial figures across this deal's documents. Show both values and their sources.";
      const body = { instruction, channel: "text", idempotencyKey: randomUUID(),
        activeContext: context({ entityType: "pe_deal", entityId: incidentalDealId }, "businessRoot") };
      const response = await http.request("actions", body);
      await record("document-review-intake", { body, artifacts, response });
      expect(response.status).toBe(201);
      expect(response.body.objective).toBeUndefined();
      expect(response.body.planned).toEqual([]);
      const workId = response.body.workId;
      const ownerWork = await state(workId);
      expect(ownerWork.work.status).toBe("completed");
      expect(ownerWork.loop).toBeUndefined();
      const live = await http.read(`works/${workId}`);
      const result = live.body.work.documentReview;
      expect(result).toMatchObject({
        status: "reviewed", coverage: "registered_sources", findings: [{
          metric: "EBITDA", periodEnd: "2025-12-31T00:00:00.000Z", currency: "USD", spread: "2000000",
          assertions: [
            { value: "18000000", source: { documentId: artifacts[1]!.id, versionId: artifacts[1]!.versionId, sha256: artifacts[1]!.sha256, anchor: { page: 1 } } },
            { value: "20000000", source: { documentId: artifacts[0]!.id, versionId: artifacts[0]!.versionId, sha256: artifacts[0]!.sha256, anchor: { sheet: "Financials", cell: "C2" } } },
          ],
        }],
      });
      const stored = JSON.stringify(live.body.work.work.finalOutcome);
      expect(stored).not.toContain("20000000");
      expect(stored).not.toContain("18000000");
      const thread = await http.read(`threads/${response.body.threadId}`);
      expect(JSON.stringify(thread.body)).not.toContain("20000000");
      const peer = await http.read(`works/${workId}`, "other");
      expect(JSON.stringify(peer.body)).not.toContain("18000000");
      expect(peer.body.work?.documentReview).toBeUndefined();
      const replay = await http.request("actions", body);
      expect(replay.body.workId).toBe(workId);
      expect(JSON.stringify(replay.body)).not.toContain("20000000");
      const mixed = await http.request("actions", { ...body, instruction: `${instruction} Draft an investment committee memo.`, idempotencyKey: randomUUID() });
      expect(mixed.status).toBe(202);
      expect(mixed.body.objective?.objectiveLoopId).toBeTruthy();

      const valuationQuestion = "What is the valuation impact of conflicting EBITDA across this deal's documents at 8x EV/EBITDA?";
      const financing = "Assume USD 60 million net debt and USD 5 million transaction fees, with all equity funded by the sponsor and no rollover or other funding.";
      const valuationInput = { ...body, instruction: `${valuationQuestion} ${financing}`, idempotencyKey: randomUUID() };
      const valuationIntake = await http.request("actions", valuationInput);
      await record("document-valuation-intake", { input: valuationInput, response: valuationIntake });
      expect(valuationIntake.status).toBe(201);
      expect(valuationIntake.body.objective).toBeUndefined();
      expect(valuationIntake.body.planned).toEqual([]);
      const valuationWorkId = valuationIntake.body.workId;
      const valuationPath = `works/${valuationWorkId}`;
      const valuationWork = await state(valuationWorkId);
      expect(valuationWork.work.status).toBe("completed");
      expect(valuationWork.loop).toBeUndefined();
      const valuationRead = await http.read(valuationPath);
      const valuation = valuationRead.body.work.documentReview.valuation;
      expect(valuation).toMatchObject({
        status: "calculated", entryMultiple: "8", currency: "USD", enterpriseValueSpread: "16000000",
        funding: { status: "calculated", netDebt: "60000000", fees: "5000000" },
        cases: [
          { ebitda: "18000000", enterpriseValue: "144000000", funding: { equityPrice: "84000000", sponsorCash: "89000000" },
            source: { versionId: artifacts[1]!.versionId, anchor: { page: 1 } } },
          { ebitda: "20000000", enterpriseValue: "160000000", funding: { equityPrice: "100000000", sponsorCash: "105000000" },
            source: { versionId: artifacts[0]!.versionId, anchor: { cell: "C2" } } },
        ],
      });
      expect(JSON.stringify(valuationRead.body.work.work.finalOutcome)).not.toMatch(/144000000|160000000|89000000|105000000/);
      const briefQuery = { export: "valuation-brief" };
      const brief = await http.readResponse(valuationPath, briefQuery);
      const briefText = await brief.text();
      expect(brief.status).toBe(200);
      expect(brief.headers.get("content-type")).toMatch(/^text\/markdown/);
      expect(brief.headers.get("content-disposition")).toContain("attachment");
      expect(brief.headers.get("cache-control")).toContain("no-store");
      for (const value of ["USD 144,000,000", "USD 160,000,000", "USD 89,000,000", "USD 105,000,000",
        "Financials!C2", "page 1", artifacts[0]!.sha256, artifacts[1]!.sha256]) expect(briefText).toContain(value);
      const briefPeer = await http.readResponse(valuationPath, briefQuery, "other");
      expect(briefPeer.status).toBe(404);
      expect(await briefPeer.text()).not.toContain("144,000,000");
      const incompleteIntake = await http.request("actions", { ...body, instruction: valuationQuestion, idempotencyKey: randomUUID() });
      expect(incompleteIntake.status).toBe(201);
      const incomplete = await http.read(`works/${incompleteIntake.body.workId}`);
      expect(incomplete.body.work.documentReview.valuation).toMatchObject({
        status: "calculated", funding: { status: "requires_input" }, cases: [{ funding: null }, { funding: null }],
      });
      const partialFundingQuestion = `${valuationQuestion} Assume USD 60 million net debt.`;
      const partialFundingIntake = await http.request("actions", {
        ...valuationInput, instruction: partialFundingQuestion, idempotencyKey: randomUUID(),
      });
      await record("document-valuation-partial-funding", { instruction: partialFundingQuestion, response: partialFundingIntake });
      expect(partialFundingIntake.status).toBe(201);
      expect(partialFundingIntake.body.objective).toBeUndefined();
      const partialFunding = await http.read(`works/${partialFundingIntake.body.workId}`);
      expect(partialFunding.body.work.documentReview.valuation).toMatchObject({
        status: "calculated", funding: { status: "requires_input" },
        cases: [{ enterpriseValue: "144000000", funding: null }, { enterpriseValue: "160000000", funding: null }],
      });
      const mixedPartial = await http.request("actions", {
        ...valuationInput, instruction: `${partialFundingQuestion} Send the brief to the Deal team.`, idempotencyKey: randomUUID(),
      });
      expect(mixedPartial.status).toBe(202);
      expect(mixedPartial.body.objective?.objectiveLoopId).toBeTruthy();
      const rejectedFunding = [];
      for (const { scenario, financingText, reason } of [
        { scenario: "currency mismatch", financingText: financing.replaceAll("USD", "EUR"), reason: "different currency" },
        { scenario: "negative equity", financingText: financing.replace("60 million", "200 million"), reason: "negative equity price" },
      ]) {
        const intake = await http.request("actions", { ...valuationInput, instruction: `${valuationQuestion} ${financingText}`, idempotencyKey: randomUUID() });
        expect(intake.status).toBe(201);
        const restored = await http.read(`works/${intake.body.workId}`);
        expect(restored.body.work.documentReview.valuation).toMatchObject({
          status: "calculated", funding: { status: "requires_input", reason: expect.stringContaining(reason) },
          cases: [{ enterpriseValue: "144000000", funding: null }, { enterpriseValue: "160000000", funding: null }],
        });
        rejectedFunding.push({ scenario, valuation: restored.body.work.documentReview.valuation });
      }
      const mixedValuation = await http.request("actions", { ...valuationInput, instruction: `${valuationInput.instruction} Send the brief to the Deal team.`, idempotencyKey: randomUUID() });
      expect(mixedValuation.status).toBe(202);
      expect(mixedValuation.body.objective?.objectiveLoopId).toBeTruthy();

      await admin.query("UPDATE finnor_os.employee_role_assignments SET active=false WHERE tenant_id=$1 AND employee_id=$2", [tenantId, actorId]);
      const revoked = await http.read(`works/${workId}`);
      expect(revoked.body.work.documentReview).toEqual({ status: "unavailable" });
      const briefRevoked = await http.readResponse(valuationPath, briefQuery);
      expect(briefRevoked.status).toBe(404);
      expect(await briefRevoked.text()).not.toContain("144,000,000");
      await admin.query("UPDATE finnor_os.employee_role_assignments SET active=true WHERE tenant_id=$1 AND employee_id=$2", [tenantId, actorId]);
      const archiveSource = async () => {
        await admin.query("UPDATE finnor_os.documents SET archived_at=now() WHERE tenant_id=$1 AND id=$2", [tenantId, artifacts[1]!.id]);
      };
      const checkedWorkIds = [workId, valuationWorkId];
      if (process.env.FINNOR_DOCUMENT_REVIEW_MOUNTED === "1") {
        const { verifyMountedDocumentReview } = await import("../../scripts/transformation/mounted-financial-explanation");
        const browser = await verifyMountedDocumentReview({
          kind: "registered", output: evidenceDirectory, authOrigin: http.authOrigin, apiOrigin: http.origin, email: http.loginEmail,
          threadId: response.body.threadId, archiveSource,
          valuationRequest: { dealId: incidentalDealId, instruction: valuationInput.instruction },
        });
        const browserWork = await state(browser.valuationWorkId);
        expect(browserWork.work.status).toBe("completed");
        expect(browserWork.loop).toBeUndefined();
        checkedWorkIds.push(browser.valuationWorkId);
        await record("document-review-mounted", browser);
      } else await archiveSource();
      const stale = await http.read(`works/${workId}`);
      expect(stale.body.work.documentReview).toEqual({ status: "stale" });
      const briefStale = await http.readResponse(valuationPath, briefQuery);
      expect(briefStale.status).toBe(409);
      expect(await briefStale.text()).not.toContain("144,000,000");
      const actions = await admin.query("SELECT id FROM finnor_os.domain_actions WHERE tenant_id=$1 AND work_id=ANY($2::uuid[])", [tenantId, checkedWorkIds]);
      expect(actions.rows).toEqual([]);
      await record("document-review-owner", { workId, ownerWork, live, peer, mixed, revoked, stale, checkedWorkIds, actions: actions.rows });
      await record("document-valuation-owner", { valuationRead, incomplete, partialFunding, mixedPartial, rejectedFunding, briefText, access: {
        peer: briefPeer.status, revoked: briefRevoked.status, stale: briefStale.status,
      } });
    }, process.env.FINNOR_DOCUMENT_REVIEW_MOUNTED === "1" ? 210_000 : 45_000);
  }

  it.each([
    "Analyze this deal. Send the findings to the deal team.",
    "What are the returns in a synthetic example? Explanation only; send the calculation to the deal team.",
    "Calculate a hypothetical valuation. Create a closing condition now.",
    `Calculate a hypothetical valuation from supplied EBITDA USD 20 million and multiple 8x, and message the calculation to ${actorId}@world.test.invalid.`,
    "Calculate a hypothetical valuation from supplied EBITDA USD 20 million and multiple 8x, and set the entry value on the deal.",
    "Calculate a hypothetical valuation from supplied EBITDA USD 20 million and multiple 8x, and cancel the pending approval.",
    `Calculate a hypothetical valuation from supplied EBITDA USD 20 million and multiple 8x. If the result is positive, send the calculation to ${actorId}@world.test.invalid.`,
    "Calculate a hypothetical valuation from supplied EBITDA USD 20 million and multiple 8x, and terminate the deal.",
    "Calculate a hypothetical valuation from supplied EBITDA USD 20 million and multiple 8x, and liquidate the holding.",
  ])("retains affirmative requested work after an explanation clause: %s", async instruction => {
    const response = await http.request("actions", { instruction, channel: "text", idempotencyKey: `explanation-effect:${randomUUID()}` });
    await record("explanation-with-requested-effect", { instruction, response });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    expect(response.body.objective?.objectiveLoopId).toBeTruthy();
    expect(response.body.answer).toBeUndefined();
  });

  it.each([
    { key: "fractional", instruction: "Calculate a hypothetical entry using supplied EBITDA EUR 0.1 million, multiple 3x, and net debt EUR 0.4 million. Explanation only.",
      inputs: ["EUR 0.1 million", "3x", "EUR 0.4 million"], steps: [{ id: "ev", label: "Enterprise value", op: "multiply", left: "i0", right: "i1" }, { id: "equity", label: "Equity price", op: "subtract", left: "ev", right: "i2" }], outputs: ["ev", "equity"], unit: "EUR" },
    { key: "margin", instruction: "Calculate EBITDA and leverage from supplied revenue USD 1.25 million, margin 12.5%, and debt USD 625000. This is a hypothetical explanation.",
      inputs: ["USD 1.25 million", "12.5%", "USD 625000"], steps: [{ id: "ebitda", label: "EBITDA", op: "multiply", left: "i0", right: "i1" }, { id: "leverage", label: "Leverage", op: "divide", left: "i2", right: "ebitda" }], outputs: ["ebitda", "leverage"], unit: null },
    { key: "recurring", instruction: "Calculate a supplied hypothetical ratio of 1 divided by 3. Explanation only.", inputs: ["1", "3"], steps: [{ id: "ratio", label: "Ratio", op: "divide", left: "i0", right: "i1" }], outputs: ["ratio"], unit: "scalar" },
    { key: "total", instruction: "What is the total in this supplied hypothetical example: USD 1.1 plus USD 2.2?", inputs: ["USD 1.1", "USD 2.2"], steps: [{ id: "total", label: "Total", op: "add", left: "i0", right: "i1" }], outputs: ["total"], unit: "USD" },
    { key: "zero", instruction: "Calculate a supplied hypothetical ratio of 1 divided by 0. Explanation only.", inputs: ["1", "0"], steps: [{ id: "ratio", label: "Ratio", op: "divide", left: "i0", right: "i1" }], outputs: ["ratio"], unit: null },
    { key: "currency", instruction: "Calculate a hypothetical sum from supplied USD 10 and EUR 20. Explanation only.", inputs: ["USD 10", "EUR 20"], steps: [{ id: "sum", label: "Sum", op: "add", left: "i0", right: "i1" }], outputs: ["sum"], unit: null },
    { key: "fabricated", instruction: "Calculate a hypothetical sum from supplied USD 10. Explanation only.", inputs: ["USD 10", "USD 20"], steps: [{ id: "sum", label: "Sum", op: "add", left: "i0", right: "i1" }], outputs: ["sum"], unit: null },
    { key: "forward", instruction: "Calculate a hypothetical ratio from supplied 1 and 3. Explanation only.", inputs: ["1", "3"], steps: [{ id: "ratio", label: "Ratio", op: "divide", left: "future", right: "i1" }], outputs: ["ratio"], unit: null },
    { key: "duplicate", instruction: "Calculate a hypothetical ratio from supplied 1 and 3. Explanation only.", inputs: ["1", "3"], steps: [{ id: "i0", label: "Ratio", op: "divide", left: "i0", right: "i1" }], outputs: ["i0"], unit: null },
    { key: "missing", instruction: "Calculate hypothetical sponsor cash from supplied EBITDA USD 10 million and multiple 8x. I have not supplied debt or fees. Explanation only.", inputs: [], steps: [], outputs: [], unit: null },
    { key: "cashflow", instruction: "What is the IRR in a synthetic example: pay USD 100 today and receive USD 120 in one year? Explanation only; do not execute any payment.", inputs: [], steps: [], outputs: [], unit: null },
    ...["USD 2", "USD 20", "20"].map(literal => ({ key: `shortened_${literal}`, instruction: "Calculate hypothetical enterprise value from supplied EBITDA USD 20 million and multiple 8x. Explanation only.", inputs: [literal, "8x"], steps: [{ id: "ev", label: "Enterprise value", op: "multiply", left: "i0", right: "i1" }], outputs: ["ev"], unit: null })),
    { key: "suffix_currency", instruction: "What is the total from supplied hypothetical amounts 10 USD and 20 EUR? Explanation only.", inputs: ["10", "20"], steps: [{ id: "sum", label: "Total", op: "add", left: "i0", right: "i1" }], outputs: ["sum"], unit: null },
    ...["percent", "per cent"].map(unit => ({ key: `spelled_${unit}`, instruction: `Calculate EBITDA from supplied hypothetical revenue USD 100 and margin 20 ${unit}. Explanation only.`, inputs: ["USD 100", "20"], steps: [{ id: "profit", label: "EBITDA", op: "multiply", left: "i0", right: "i1" }], outputs: ["profit"], unit: null })),
  ])("checks a source-bound calculation through HTTP and persistence: $key", async fixture => {
    const reference = JSON.parse(execFileSync("python3", [join(process.cwd(), "../scripts/transformation/financial-reference.py")], { encoding: "utf8" }));
    const expected = reference[fixture.key];
    const missing = fixture.key === "missing" || fixture.key === "cashflow";
    const proposal = { status: missing ? "needs_inputs" : "ready", title: "Supplied financial analysis",
      inputs: fixture.inputs.map((literal, index) => ({ id: `i${index}`, label: `Supplied input ${index + 1}`, quote: literal, literal })),
      steps: fixture.steps, outputs: fixture.outputs, assumptions: [], gaps: missing ? ["A supported method and all required financial inputs are needed."] : [] };
    const key = `financial-case-${fixture.key}-${runId}`, prior = process.env.LLM_PROVIDER_ANSWER_TEXT;
    registerProvider(key, () => ({ name: key, contextWindowTokens: 131072, async complete() { return JSON.stringify(proposal); } }));
    process.env.LLM_PROVIDER_ANSWER_TEXT = key;
    try {
      const response = await http.request("actions", { instruction: fixture.instruction, channel: "text", idempotencyKey: `${key}:${randomUUID()}` });
      const current = await state(response.body.workId);
      await record("source-bound-calculation", { fixture, independentExpected: expected ?? "no checked result", proposal, response, current });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.objective).toBeUndefined(); expect(current.loop).toBeUndefined(); expect(current.queries).toEqual([]);
      const analysis = response.body.answer.analysis;
      if (expected) {
        expect(analysis.status).toBe("checked");
        expect(analysis.calculations.map(({ value }: { value: { numerator: string; denominator: string } }) => ({ numerator: value.numerator, denominator: value.denominator }))).toEqual(expected);
        if (fixture.unit) expect(analysis.calculations.every((item: { value: { unit: string } }) => item.value.unit === fixture.unit)).toBe(true);
        if (fixture.key === "margin") expect(analysis.calculations.map((item: { value: { unit: string } }) => item.value.unit)).toEqual(["USD", "scalar"]);
      } else { expect(analysis.status).toBe("incomplete"); expect(analysis.calculations).toEqual([]); expect(analysis.gaps.length).toBeGreaterThan(0); }
      const effects = await admin.query("SELECT id FROM finnor_os.domain_actions WHERE tenant_id=$1 AND work_id=$2", [tenantId, response.body.workId]);
      expect(effects.rows).toEqual([]);
    } finally { if (prior === undefined) delete process.env.LLM_PROVIDER_ANSWER_TEXT; else process.env.LLM_PROVIDER_ANSWER_TEXT = prior; }
  });

  it("fences a supplied answer when actual cancellation queues after answer_started", async () => {
    const instructionId = randomUUID(), key = `publication-fence-${runId}`, prior = process.env.LLM_PROVIDER_ANSWER_TEXT;
    const instruction = "Calculate a supplied hypothetical ratio of 1 divided by 3. Explanation only.";
    const blocker = new pg.Client({ connectionString: SOURCE_DATABASE_URL }); await blocker.connect();
    let blocked = false;
    registerProvider(key, () => ({ name: key, contextWindowTokens: 131072, async complete() {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM finnor_os.instruction_sessions WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, instructionId]);
      blocked = true;
      return JSON.stringify({ status: "ready", title: "Ratio", inputs: [{ id: "a", label: "Numerator", quote: "1", literal: "1" }, { id: "b", label: "Denominator", quote: "3", literal: "3" }], steps: [{ id: "ratio", label: "Ratio", op: "divide", left: "a", right: "b" }], outputs: ["ratio"], assumptions: [], gaps: [] });
    } }));
    process.env.LLM_PROVIDER_ANSWER_TEXT = key;
    const responsePromise = http.request("actions", { instruction, instructionId, channel: "text", idempotencyKey: `fence:${instructionId}` });
    try {
      const deadline = Date.now() + 10000;
      let started = false;
      while (Date.now() < deadline && !started) {
        started = (await admin.query("SELECT 1 FROM finnor_os.work_events WHERE tenant_id=$1 AND work_id=$2 AND event_type='answer_started'", [tenantId, instructionId])).rowCount === 1;
        if (!started) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(blocked && started, "The actual answer must reach its publication boundary").toBe(true);
      const cancellationPromise = http.request(`instructions/${instructionId}/cancel`, {});
      let waits = 0;
      while (Date.now() < deadline && waits < 2) {
        waits = Number((await admin.query("SELECT count(*) AS count FROM pg_stat_activity WHERE wait_event_type='Lock' AND query ILIKE '%instruction_sessions%' AND datname=current_database() AND pid<>pg_backend_pid()")).rows[0].count);
        if (waits < 2) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waits, "Answer trace and cancellation must actually contend on the persisted instruction").toBeGreaterThanOrEqual(2);
      await blocker.query("COMMIT"); blocked = false;
      const [response, cancellation] = await Promise.all([responsePromise, cancellationPromise]);
      const events = (await admin.query("SELECT seq,phase,payload FROM finnor_os.instruction_events WHERE tenant_id=$1 AND instruction_id=$2 ORDER BY seq", [tenantId, instructionId])).rows;
      const current = await state(instructionId);
      await record("cancel-at-answer-publication", { instruction, response, cancellation, events, current, lockWaiters: waits });
      expect(cancellation.status).toBe(200); expect(response.body.answer).toBeUndefined();
      expect(events.some(event => event.phase === "completed")).toBe(false);
      expect(current.work.status).toBe("cancelled");
    } finally {
      if (blocked) await blocker.query("ROLLBACK").catch(() => undefined);
      await responsePromise.catch(() => undefined); await blocker.end();
      if (prior === undefined) delete process.env.LLM_PROVIDER_ANSWER_TEXT; else process.env.LLM_PROVIDER_ANSWER_TEXT = prior;
    }
  }, 30000);

  function readContract(root: PeWorldRootRef): ObjectiveSuccessCondition {
    return { version: 1, source: "explicit", mode: "all", statement: "Inspect the exact selected PE world record; this is a factual read, not a profit outcome.", criteria: [
      { kind: "no_open_execution" },
      { kind: "all_objective_effects_verified", minimumCount: 0 },
      { kind: "canonical_query", request: { intent: "pe_world_state", root }, assertion: { path: ["root", "entityId"], operator: "eq", expected: root.entityId } },
    ] };
  }

  function runtimeFor(root: PeWorldRootRef) {
    // This protocol fixture must select an actual advertised read. It cannot
    // compensate for a missing planner binding by manufacturing the request.
    const provider: LLMProvider = { name: "world-scope-proposal-fixture", contextWindowTokens: 131072, async complete(options) {
      const input = JSON.parse(options.user);
      const request = input.snapshot.availableReads.map((item: { request: Record<string, unknown> }) => item.request)
        .find((item: { intent?: string; root?: PeWorldRootRef }) => item.intent === "pe_world_state" && item.root?.entityType === root.entityType && item.root.entityId === root.entityId);
      await record("planner-advertised-reads", { expectedRoot: root, availableReads: input.snapshot.availableReads, canonicalEntities: input.snapshot.canonicalEntities });
      expect(request, "The ordinary planner must advertise the exact accepted non-Deal world read").toBeDefined();
      const criteria = input.goal.criteria as Array<{ id: string }>;
      return JSON.stringify({ candidates: [{ version: 1, candidateKey: "inspect-accepted-world-root", nodes: [
        { key: "inspect_world", kind: "query", request, supports: criteria.map(item => item.id) },
        ...criteria.map((item, index) => ({ key: `check_${index}`, kind: "check", criterionId: item.id, dependsOn: ["inspect_world"] })),
      ] }] });
    } };
    return new FinnorOrchestrator({ planner: new LLMPlanner(createDefaultPluginRegistry(), provider) });
  }

  async function state(workId: string) {
    const work = (await admin.query("SELECT id::text,status,active_context,failure FROM finnor_os.works WHERE tenant_id=$1 AND id=$2", [tenantId, workId])).rows[0];
    const input = (await admin.query("SELECT id::text,context_snapshot FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1", [tenantId, workId])).rows[0];
    const loop = (await admin.query("SELECT id::text,state,created_by::text,success_condition,max_steps,max_actions,max_queries,deadline_at,query_count FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2", [tenantId, workId])).rows[0];
    const links = (await admin.query("SELECT entity_type,entity_id::text,relationship FROM finnor_os.work_entity_links WHERE tenant_id=$1 AND work_id=$2 ORDER BY entity_type,entity_id", [tenantId, workId])).rows;
    const queries = (await admin.query("SELECT id::text,intent,status,request,result_summary FROM finnor_os.work_query_executions WHERE tenant_id=$1 AND work_id=$2 ORDER BY started_at,id", [tenantId, workId])).rows;
    const plans = (await admin.query("SELECT id::text,status,plan_graph,completion_proof FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND work_id=$2 ORDER BY revision", [tenantId, workId])).rows;
    return { work, input, loop, links, queries, plans };
  }

  async function start(root: PeWorldRootRef, options: { shape?: "selected" | "focused" | "businessRoot"; economic?: boolean } = {}) {
    const body = {
      objective: options.economic ? "Increase this fund's attributable net profit by USD 100 million, after all costs. A record read does not establish that result." : "Inspect the exact selected investment-world record and report its recorded state.",
      channel: "text", idempotencyKey: `world-scope:${randomUUID()}`, activeContext: context(root, options.shape),
      ...(!options.economic ? { successCondition: readContract(root) } : {}),
      budgets: { maxSteps: 8, maxActions: 1, maxQueries: 16, maxPlannerFailures: 1, deadlineAt: new Date(Date.now() + 120_000).toISOString() },
    };
    const result = await http.request("objectives", body);
    await record("authenticated-objective-intake", { body, result });
    expect(result.status, JSON.stringify(result.body)).toBe(202);
    expect(result.body.objective?.objectiveLoopId).toBeTruthy();
    return result.body.objective as { workId: string; objectiveLoopId: string; workInputId: string };
  }

  async function drive(objective: { workId: string; objectiveLoopId: string }, root: PeWorldRootRef) {
    const runtime = runtimeFor(root), outcomes: string[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const outcome = await runtime.runObjectiveIteration({ tenantId, ...objective });
      outcomes.push(outcome);
      if (["completed", "blocked", "failed", "cancelled", "awaiting_approval", "waiting"].includes(outcome)) break;
    }
    const current = await state(objective.workId);
    await record("objective-runtime-observation", { root, outcomes, current });
    return current;
  }

  beforeAll(async () => {
    assertDisposableDatabaseTarget(SOURCE_DATABASE_URL, "PE objective world-scope setup");
    // This E2E exercises many independent instructions against one disposable
    // tenant and one loopback IP. Preserve the production throttle; raise only
    // this fixture's ceilings so requests reach their routing assertions.
    process.env.RATE_LIMIT_INTAKE_PER_MINUTE = "1000";
    process.env.RATE_LIMIT_PER_MINUTE = "1000";
    process.env.RATE_LIMIT_IP_PER_MINUTE = "1000";
    const patch = execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    sourceCut = {
      revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: import.meta.dirname, encoding: "utf8" }).trim(),
      workingPatchSha256: createHash("sha256").update(patch).digest("hex"),
      workingPatch: `source-${runId}.patch`, node: process.version, migrationHead: CURRENT_MIGRATION_HEAD,
    };
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(join(evidenceDirectory, `source-${runId}.patch`), patch);
    const repository = join(process.cwd(), "..");
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: repository, encoding: "utf8" }).split("\0").filter(Boolean);
    const untrackedSources = [];
    for (const path of untracked) {
      const bytes = await readFile(join(repository, path));
      if (bytes.length > 2 * 1024 * 1024) throw new Error("Untracked verification source exceeds the capture bound");
      const saved = join(evidenceDirectory, `source-${runId}-untracked`, path);
      await mkdir(dirname(saved), { recursive: true }); await writeFile(saved, bytes);
      untrackedSources.push({ path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, saved });
    }
    sourceCut.untrackedSources = untrackedSources;
    admin = new pg.Client({ connectionString: SOURCE_DATABASE_URL });
    await admin.connect();
    sourceCut.postgresVersion = (await admin.query("SHOW server_version")).rows[0].server_version;
    sourceCut.postgresSettings = (await admin.query("SELECT current_setting('wal_segment_size') AS wal_segment_size,current_setting('max_wal_size') AS max_wal_size,current_setting('min_wal_size') AS min_wal_size,current_setting('fsync') AS fsync,current_setting('full_page_writes') AS full_page_writes")).rows[0];
    // Migrations create the restricted role; a fresh CI service has not enabled
    // its fixture-only login. Never depend on another test file doing this first.
    await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
    const applicationRole = (await admin.query("SELECT rolcanlogin,rolsuper,rolbypassrls FROM pg_roles WHERE rolname='finnor_app'")).rows[0];
    expect(applicationRole).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false });
    await record("disposable-application-role", applicationRole);
    expect((await admin.query("SELECT max(name COLLATE \"C\") AS head FROM finnor_os._migrations")).rows[0].head).toBe(CURRENT_MIGRATION_HEAD);
    await admin.query("SET app.test_vertical_mode='explicit'");
    await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'PE world objective'),($3,$4,'Foreign PE world objective')", [tenantId, randomUUID(), foreignTenantId, randomUUID()]);
    await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$4,$6,'owner','active','World operator'),($2,$4,$7,'owner','active','Other operator'),($3,$5,$8,'owner','active','Foreign operator')", [actorId, otherActorId, foreignActorId, tenantId, foreignTenantId, `${actorId}@world.test.invalid`, `${otherActorId}@world.test.invalid`, `${foreignActorId}@world.test.invalid`]);
    await admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,$4,'other')",
      [companyId, tenantId, randomUUID(), sourceProxy ? "AvidXchange Holdings, Inc." : "World scope company"]);
    await admin.query("INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name) VALUES($1,$2,$3,'World objective authority')", [roleId, tenantId, `world-${runId}`]);
    await admin.query("INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope) VALUES($1,$2,$3,'{\"kind\":\"tenant\"}'::jsonb)", [tenantId, actorId, roleId]);
    await admin.query("INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk,approval_required) VALUES($1,$2,'*','*','allow','high',false)", [tenantId, roleId]);
    const applicationUrl = new URL(SOURCE_DATABASE_URL); applicationUrl.username = "finnor_app"; applicationUrl.password = "finnor_app";
    await closePool(); process.env.DATABASE_URL = applicationUrl.toString(); process.env.SECRETS_PROVIDER = "env"; delete process.env.HEALTHCHECK_PING_URL;
    await configureTenantVertical({ tenantId, verticalKey: "private_equity", expectedVersion: 0, createdBy: actorId, sourceSystem: "integration:world-scope" });
    await configureTenantVertical({ tenantId: foreignTenantId, verticalKey: "private_equity", expectedVersion: 0, createdBy: foreignActorId, sourceSystem: "integration:world-scope" });
    const strategy = await createStrategy(ctx, { name: "World-scope strategy" });
    opportunity = { entityType: "pe_opportunity", entityId: String((await createOpportunity(ctx, { strategyId: String(strategy.row.id), targetOrganizationId: companyId, name: "Explicit pre-Deal opportunity" })).row.id) };
    fund = { entityType: "pe_fund", entityId: String((await createFund(ctx, { name: "Explicit investment fund", baseCurrency: "USD", vintageYear: 2026 })).row.id) };
    const foreignCtx: PeMutationContext = { auth: { tenantId: foreignTenantId, userId: foreignActorId, employeeId: foreignActorId, role: "owner" } };
    foreignFund = { entityType: "pe_fund", entityId: String((await createFund(foreignCtx, { name: "Foreign private fund", baseCurrency: "USD" })).row.id) };
    incidentalDealId = String((await createDeal(ctx, { targetOrganizationId: companyId, name: sourceProxy ? "AvidXchange forecast review" : "Unrelated sole active Deal", dealLeadEmployeeId: actorId, signedLoiAt: new Date("2026-09-01"), targetClosingAt: new Date("2026-12-01") })).row.id);
    await configureAgentProfile(tenantId, createDefaultPluginRegistry(), { key: `world-${runId}`, name: "World query worker", actor: ctx.auth, capabilityGrants: [{ kind: "query", capability: "query:pe_world_state" }, { kind: "query", capability: "query:party_context" }, { kind: "check", capability: "check:objective_success" }], autonomyLimits: { maxActions: 1, maxQueries: 11, maxReplans: 8, maxPlannerCalls: 8, maxWallClockMs: 120_000 } });
    http = await browserHttpFixture(admin, tenantId, actorId, otherActorId);
    heartbeat = startHeartbeat(1_000, heartbeatStop.signal);
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const fleet = await readWorkerFleetReadiness();
      if ((fleet.legacyCompatibleWorkers ?? 0) > 0 || fleet.computeReady) { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(ready, "Real worker heartbeat must satisfy the ordinary intake readiness guard").toBe(true);
    await record("setup", { currentMigrationHead: CURRENT_MIGRATION_HEAD, transport: "actual signed local bearer HTTP", runtimeSqlRole: "finnor_app", evidenceDirectory });
  }, 120_000);

  afterAll(async () => {
    heartbeatStop.abort();
    await heartbeat?.markDraining();
    await http?.close();
    await closePool();
    await admin?.end();
    for (const [key, value] of Object.entries(originalEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    console.log(`PE_OBJECTIVE_WORLD_SCOPE_EVIDENCE ${join(evidenceDirectory, `world-scope-${runId}.json`)}`);
  });

  it("asks for a source scope when the document comparison names no exact selected Deal or company", async () => {
    const instruction = "Identify conflicting financial figures across this deal's documents. Show both values and their sources.";
    const response = await http.request("actions", { instruction, channel: "text", idempotencyKey: randomUUID() });
    await record("document-review-missing-scope", { instruction, response });
    expect(response.status).toBe(201);
    expect(response.body.answer.spokenSummary).toBe("Select the Deal or company whose documents you want to compare.");
    expect(response.body.answer.documentReviewReceipt).toBeUndefined();
    expect(response.body.objective).toBeUndefined();
  });

  it.each([
    "Analyze this deal. Identify the 5 biggest closing risks. Rank by severity and show evidence.",
    "For every claim you just made, show its exact source, timestamp, and confidence. Separate facts from assumptions.",
    "Find the highest-impact EBITDA improvement opportunity. Quantify upside, assumptions, confidence, implementation cost, and evidence gaps.",
  ])("retains analytical instructions as durable Work instead of an unrelated party lookup: %s", async (instruction) => {
    const response = await http.request("actions", {
      instruction, channel: "text", idempotencyKey: `analysis-routing:${randomUUID()}`,
    });
    await record("analytical-instruction-intake", { instruction, response });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    expect(response.body.objective?.objectiveLoopId).toBeTruthy();
    const current = await state(response.body.workId);
    expect(current.loop.id).toBe(response.body.objective.objectiveLoopId);
    expect(current.loop.state).toBe("continue");
    expect(current.queries).toEqual([]);
  });

  it("advertises and executes the authenticated employee's exact party-context read", async () => {
    const request = { intent: "party_context", ref: { partyType: "employee", partyId: actorId } } satisfies CanonicalOperationalQueryRequest;
    const response = await http.request("objectives", {
      objective: `Inspect the canonical context of employee ${actorId}.`, channel: "text",
      idempotencyKey: `employee-context:${randomUUID()}`, activeContext: context(fund, "businessRoot"),
      successCondition: { version: 1, source: "explicit", mode: "all", statement: "Read the exact authenticated employee record; no business effect is requested.", criteria: [
        { kind: "no_open_execution" }, { kind: "all_objective_effects_verified", minimumCount: 0 },
        { kind: "canonical_query", request, assertion: { path: ["party", "ref", "partyId"], operator: "eq", expected: actorId } },
      ] },
      budgets: { maxSteps: 8, maxActions: 0, maxQueries: 12, maxPlannerFailures: 1, deadlineAt: new Date(Date.now() + 120_000).toISOString() },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    const objective = response.body.objective as { workId: string; objectiveLoopId: string };
    const provider: LLMProvider = { name: "grounded-party-query-fixture", contextWindowTokens: 131072, async complete(options) {
      const input = JSON.parse(options.user);
      const advertised = input.snapshot.availableReads.map((item: { request: Record<string, unknown> }) => item.request);
      await record("authenticated-employee-advertised-reads", { actorId, advertised });
      expect(advertised, "Copying an advertised query must retain the authenticated employee reference").toContainEqual(request);
      const criteria = input.goal.criteria as Array<{ id: string }>;
      return JSON.stringify({ candidates: [{ version: 1, candidateKey: "read-authenticated-employee", nodes: [
        { key: "read_employee", kind: "query", request, supports: criteria.map(item => item.id) },
        ...criteria.map((item, index) => ({ key: `check_${index}`, kind: "check", criterionId: item.id, dependsOn: ["read_employee"] })),
      ] }] });
    } };
    const runtime = new FinnorOrchestrator({ planner: new LLMPlanner(createDefaultPluginRegistry(), provider) });
    for (let attempt = 0; attempt < 6; attempt++) {
      const outcome = await runtime.runObjectiveIteration({ tenantId, ...objective });
      if (["completed", "blocked", "failed", "cancelled", "awaiting_approval", "waiting"].includes(outcome)) break;
    }
    const current = await state(objective.workId);
    await record("authenticated-employee-read-result", current);
    expect(current.loop.state).toBe("completed");
    expect(current.queries).toEqual(expect.arrayContaining([expect.objectContaining({ intent: "party_context", status: "succeeded", request })]));
  });

  it.each([false, true])("enforces draft-only against a send proposal with supplied constraints %s", async (suppliedConstraints) => {
    const response = await http.request("objectives", {
      objective: "Resolve every outstanding diligence request. Draft necessary follow-ups, but do not send anything.",
      channel: "text", idempotencyKey: `draft-only:${randomUUID()}`, activeContext: context(fund, "businessRoot"),
      budgets: { maxSteps: 8, maxActions: 1, maxQueries: 12, maxPlannerFailures: 1, deadlineAt: new Date(Date.now() + 120_000).toISOString() },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    const objective = response.body.objective as { workId: string; objectiveLoopId: string };
    const plans: PlanningResult[] = [];
    const provider: LLMProvider = { name: "adversarial-draft-only-fixture", contextWindowTokens: 131072, async complete(options) {
      const input = JSON.parse(options.user);
      return JSON.stringify({ candidates: [{ version: 1, candidateKey: "attempt-forbidden-send", nodes: [
        { key: "send_despite_instruction", kind: "action", actionType: "send_message", payload: { recipient: { partyType: "employee", partyId: actorId }, channel: "internal", body: "This must never be sent." }, supports: input.goal.criteria.map((item: { id: string }) => item.id) },
        ...input.goal.criteria.map((item: { id: string }, index: number) => ({ key: `check_${index}`, kind: "check", criterionId: item.id, dependsOn: ["send_despite_instruction"] })),
      ] }] });
    } };
    const delegate = new LLMPlanner(createDefaultPluginRegistry(), provider);
    const preservedDeadline: PlanningConstraint = {
      id: "independent-work-deadline", kind: "deadline", source: "work", strength: "hard", scope: { type: "plan" },
      requirement: { deadlineAt: new Date(Date.now() + 60_000).toISOString() },
      provenance: { ref: "disposable-work-deadline", hash: "independent-deadline-fixture" },
    };
    const runtime = new FinnorOrchestrator({ planner: { async plan(instruction, tenantContext, memory, options) {
      const initial = await delegate.plan(instruction, tenantContext, memory, options);
      const plan = suppliedConstraints ? await delegate.plan(instruction, tenantContext, memory, {
        ...options, constraints: buildConstraintSet({ ...initial.constraints, prohibitedCapabilities: [], constraints: [...initial.constraints.constraints, preservedDeadline] }),
      }) : initial;
      plans.push(plan); return plan;
    } } });
    for (let attempt = 0; attempt < 6; attempt++) {
      const outcome = await runtime.runObjectiveIteration({ tenantId, ...objective });
      if (["completed", "blocked", "failed", "cancelled", "awaiting_approval", "waiting"].includes(outcome)) break;
    }
    await record("draft-only-adversarial-planning", plans);
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      if (suppliedConstraints) expect(plan.constraints.constraints).toContainEqual(preservedDeadline);
      expect(plan.constraints.prohibitedCapabilities).toEqual(expect.arrayContaining(["send_message", "place_call", "notify_group", "share_document", "computer_task", "delegate_objective"]));
      expect(plan.compilation.selected).toBeNull();
      expect(plan.compilation.candidates.flatMap(candidate => candidate.violations)).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "CAPABILITY_NOT_ALLOWED", nodeKey: "send_despite_instruction" }),
      ]));
    }
    const current = await state(objective.workId);
    const effects = (await admin.query("SELECT id FROM finnor_os.domain_actions WHERE tenant_id=$1 AND work_id=$2", [tenantId, objective.workId])).rows;
    await record("draft-only-persisted-no-send", { current, effects });
    expect(effects).toEqual([]);
    expect(current.loop.success_condition.criteria).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "decision_evidence", accepted: expect.arrayContaining(["business_effect"]) }),
    ]));
  });

  it("retains an explicitly selected opportunity instead of linking the sole incidental Deal, then verifies only its accepted factual-read contract", async () => {
    // Contract: accepted pre-Deal subject survives HTTP intake and real planning.
    // Defect: generic Deal fallback silently captures unrelated non-Deal work.
    const objective = await start(opportunity);
    const accepted = await state(objective.workId);
    await record("accepted-opportunity-scope", accepted);
    expect(accepted.loop.created_by).toBe(actorId);
    expect(accepted.work.active_context.selectedEntities).toEqual([opportunity]);
    expect(accepted.links.filter(row => row.entity_type === "pe_deal")).toEqual([]);
    expect(accepted.input.context_snapshot?.selectedEntities).toEqual([opportunity]);
    const current = await drive(objective, opportunity);
    expect(current.loop.state).toBe("completed");
    expect(current.queries.some(row => row.intent === "pe_world_state" && row.status === "succeeded" && row.request.root?.entityId === opportunity.entityId)).toBe(true);
    expect(current.plans.some(row => row.completion_proof?.verified === true)).toBe(true);
    expect(current.links.filter(row => row.entity_type === "pe_deal")).toEqual([]);
  });

  it("accepts an explicit fund businessRoot without requiring a fake Deal", async () => {
    // Contract: an objective can name its business subject independently of UI focus.
    // Defect: schema strips/rejects businessRoot or later treats the fund as a Deal.
    const objective = await start(fund, { shape: "businessRoot" });
    const accepted = await state(objective.workId);
    await record("accepted-fund-business-root", accepted);
    expect(accepted.work.active_context.businessRoot).toEqual(fund);
    expect(accepted.input.context_snapshot.businessRoot).toEqual(fund);
    expect(accepted.links.filter(row => row.entity_type === "pe_deal")).toEqual([]);
    expect((await drive(objective, fund)).loop.state).toBe("completed");
  });

  it("reads the selected fund through Centropy's actual selection builder and instruction route", async () => {
    // The objective endpoint cannot prove the interactive classifier or request
    // builder. A dropped root otherwise redirects this finite read into a Deal
    // lookup or an unsupported long-running objective.
    const activeContext = { ...context(fund), ...operatingSelection(fund, null) };
    const response = await http.request("actions", {
      instruction: "Show world state for the selected fund.", channel: "text",
      idempotencyKey: randomUUID(), activeContext,
    });
    await record("centropy-selected-fund-query", { activeContext, response });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.query?.request).toEqual({ intent: "pe_world_state", root: fund });
    expect(response.body.query?.result.root).toEqual(fund);
    const current = await state(response.body.workId);
    expect(current.input.context_snapshot.businessRoot).toEqual(fund);
    expect(current.links.filter(row => row.entity_type === "pe_deal")).toEqual([]);
    expect(current.queries).toHaveLength(1);
    expect(current.queries[0].request).toEqual({ intent: "pe_world_state", root: fund });
  });

  it("refuses an unrelated focused Deal before Centropy's fast-read lane executes it", async () => {
    // A same-tenant focus is not proof of membership in the accepted fund. The
    // objective-only refusal does not cover this separate synchronous read path.
    const activeContext = { ...context(fund), ...operatingSelection(fund, {
      namespace: "private_equity", owner: "@finnor/private-equity", type: "pe_deal", id: incidentalDealId,
    }) };
    const response = await http.request("actions", {
      instruction: "Show deal closing readiness.", channel: "text",
      idempotencyKey: randomUUID(), activeContext,
    });
    await record("centropy-unrelated-deal-refusal", { activeContext, response });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.query).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain("Unrelated sole active Deal");
    const current = await state(response.body.workId);
    expect(current.loop).toBeUndefined();
    expect(current.queries).toEqual([]);
  });

  it("keeps the fund and unresolved profit outcome through Centropy's ordinary objective intake", async () => {
    const activeContext = { ...context(fund), ...operatingSelection(fund, null) };
    const response = await http.request("actions", {
      instruction: "Ensure this fund increases attributable net profit by USD 100 million after all costs.",
      channel: "text", idempotencyKey: randomUUID(), activeContext,
    });
    await record("centropy-fund-profit-intake", { activeContext, response });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    const objective = { workId: String(response.body.workId), objectiveLoopId: String(response.body.objective?.objectiveLoopId) };
    expect(response.body.objective?.objectiveLoopId).toBeTruthy();
    const current = await drive(objective, fund);
    expect(current.input.context_snapshot.businessRoot).toEqual(fund);
    expect(current.links.filter(row => row.entity_type === "pe_deal")).toEqual([]);
    expect(current.loop.state).not.toBe("completed");
    expect(current.plans.every(row => row.completion_proof?.verified !== true)).toBe(true);
  });

  it("retains an exact internal recipient alongside the fund without treating the recipient as a different investment subject", async () => {
    // Conversation resolution carries exact recipients in selectedEntities. A
    // fund's institutional graph is not the owner of employee membership; the
    // ordinary tenant/party and action-authority boundaries still own that.
    const activeContext = {
      ...context(fund),
      ...operatingSelection(fund, { namespace: "private_equity", owner: "@finnor/private-equity", type: "pe_fund", id: fund.entityId }),
      selectedEntities: [fund, { entityType: "user", entityId: otherActorId }],
    };
    const response = await http.request("actions", {
      instruction: "Ensure this fund's recorded state is inspected, then prepare an internal handoff to the selected operator.",
      channel: "text", idempotencyKey: randomUUID(), activeContext,
    });
    await record("centropy-fund-recipient-intake", { activeContext, response });
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    const current = await state(String(response.body.workId));
    expect(current.input.context_snapshot.businessRoot).toEqual(fund);
    expect(current.input.context_snapshot.selectedEntities).toContainEqual({ entityType: "user", entityId: otherActorId });
    expect(current.links.filter(row => row.entity_type === "pe_deal")).toEqual([]);
    expect(current.loop.state).not.toBe("completed");
  });

  it("does not complete a fund profit objective after reading the fund, and redirect preserves the unresolved outcome and original limits", async () => {
    // Contract: successful inspection is not an economic outcome.
    // Defect: generic decision_evidence or redirect default proves only existence.
    const objective = await start(fund, { shape: "focused", economic: true });
    const accepted = await state(objective.workId);
    const current = await drive(objective, fund);
    expect(current.queries.some(row => row.intent === "pe_world_state" && row.status === "succeeded" && row.request.root?.entityId === fund.entityId)).toBe(true);
    expect(current.loop.state).not.toBe("completed");
    expect(current.plans.every(row => row.completion_proof?.verified !== true)).toBe(true);
    const redirect = await http.request(`works/${objective.workId}/objective`, { command: "redirect", objective: "Continue increasing the same fund's attributable net profit by USD 100 million after all costs.", idempotencyKey: randomUUID() });
    await record("economic-objective-redirect", redirect);
    expect(redirect.status).toBe(202);
    const redirected = await state(objective.workId);
    expect(redirected.loop.success_condition.criteria.some((criterion: { kind: string }) => criterion.kind === "manual_verification")).toBe(true);
    for (const key of ["max_steps", "max_actions", "max_queries"]) expect(redirected.loop[key]).toBe(accepted.loop[key]);
    expect(redirected.loop.deadline_at).toEqual(accepted.loop.deadline_at);
  });

  it("rejects a foreign business root at authenticated intake without exposing its name or making an objective loop", async () => {
    // Contract: root extension retains canonical tenant isolation at the actual API.
    // Defect: newly accepted businessRoot bypasses the established context resolver.
    const response = await http.request("objectives", { objective: "Inspect this exact fund", channel: "text", activeContext: context(foreignFund, "businessRoot"), idempotencyKey: randomUUID(), successCondition: readContract(foreignFund) });
    await record("foreign-root-refusal", response);
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain("Foreign private fund");
    expect(response.body.objective?.objectiveLoopId).toBeUndefined();
    if (response.body.workId) expect((await state(response.body.workId)).loop).toBeUndefined();
  });

  it("refuses a focused Deal outside the explicitly selected fund instead of substituting its closing context", async () => {
    const response = await http.request("objectives", {
      objective: "Inspect this fund and the selected investment.", channel: "text", idempotencyKey: randomUUID(),
      activeContext: { ...context(fund, "businessRoot"), focusedEntity: { entityType: "pe_deal", entityId: incidentalDealId }, selectedEntities: [{ entityType: "pe_deal", entityId: incidentalDealId }] },
      successCondition: readContract(fund),
    });
    await record("unrelated-focus-refusal", response);
    expect(response.status).toBe(403);
    expect(response.body.objective?.objectiveLoopId).toBeUndefined();
    if (response.body.workId) {
      const current = await state(response.body.workId);
      expect(current.loop).toBeUndefined();
      expect(current.links.filter(row => row.entity_type === "pe_deal")).toEqual([]);
    }
  });

  it("rechecks current authority before a previously accepted fund objective can publish a verified read", async () => {
    const objective = await start(fund, { shape: "businessRoot" });
    const denialId = randomUUID();
    await admin.query("INSERT INTO finnor_os.role_authority_grants(id,tenant_id,role_id,capability,resource_type,effect,max_risk,approval_required) VALUES($1,$2,$3,'query:pe_world_state','pe_fund','deny','high',false)", [denialId, tenantId, roleId]);
    try {
      const current = await drive(objective, fund);
      expect(current.loop.state).not.toBe("completed");
      expect(current.work.failure?.detail?.code).toBe("operating_context_scope_denied");
      expect(current.plans.every(row => row.completion_proof?.verified !== true)).toBe(true);
      expect(current.queries.filter(row => row.intent === "pe_world_state" && row.status === "succeeded")).toEqual([]);
    } finally {
      await admin.query("DELETE FROM finnor_os.role_authority_grants WHERE tenant_id=$1 AND id=$2", [tenantId, denialId]);
    }
  });
});
