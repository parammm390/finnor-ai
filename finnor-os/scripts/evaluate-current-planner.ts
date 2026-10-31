/** Finite current-plan evaluation; proposes and compiles, never executes effects. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { LLMPlanner, createDefaultPluginRegistry, isPurposeConfigured, resolveProviderForPurpose, type LLMProvider, type PlanningResult } from '@finnor/orchestration';
import { buildGoalSpec } from '@finnor/planning';
import type { MemorySnapshot, OperatingContext } from '@finnor/shared-types';
import { PLANNER_EVAL_IDS as ids, PLANNER_LIVE_CASES, type PlannerLiveCase } from './fixtures/planner-live-cases';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const at = process.argv.indexOf('--out');
const output = resolve(at >= 0 ? process.argv[at + 1] ?? '' : process.env.PLANNER_EVAL_EVIDENCE_DIR ?? 'planner-eval-evidence');
const paceMs = z.coerce.number().int().min(0).max(60_000).parse(process.env.PLANNER_EVAL_PACE_MS ?? '4000');
const fixtureUrl = process.env.PLANNER_EVAL_FIXTURE_URL;
if (fixtureUrl) {
  const url = new URL(fixtureUrl);
  assert(process.env.NODE_ENV === 'test' && process.env.FINNOR_PLANNER_EVAL_FIXTURE === '1' && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && !url.username && !url.password, 'Provider fixtures require an explicit disposable loopback environment');
}
const qualification = fixtureUrl ? 'FIXTURE_PROVIDER_REAL_PLANNER_AND_COMPILER' : 'LIVE_PROVIDER_FINITE_PLAN_ONLY_NO_EFFECTS';
const registry = createDefaultPluginRegistry();
const emptyMemory: MemorySnapshot = { shortTerm: null, longTerm: null, semantic: [], episodic: [], patterns: null };

function context(): OperatingContext {
  const now = new Date().toISOString();
  return {
    version: 1, assembledAt: now, truthPrecedence: ['CANONICAL', 'WORK', 'PROFILE', 'SESSION', 'MEMORY', 'WEB'],
    tenant: { id: ids.tenant, companyName: 'Synthetic Atlas Sponsor', timezone: 'UTC', vertical: { tenantId: ids.tenant, verticalKey: 'private_equity', version: 1, effectiveFrom: now, sourceSystem: 'offline-evaluation-fixture', sourceRef: null },
      profile: { industry: 'private equity', niche: null, description: null, primaryGeographies: [], foundedYear: null, idealCustomerProfile: {}, businessFacts: {}, comparisonDefaults: {}, updatedAt: now } },
    employee: { userId: ids.employee, employeeId: ids.employee, displayName: 'Synthetic evaluator', role: 'owner', authorityRoles: ['owner'], profile: { title: null, profileFacts: {}, updatedAt: now } },
    activeWork: null,
    companyDirectory: { employee: null, teams: [], locations: [], reporting: { manager: null, reports: [], backups: [], assistants: [] }, currentWork: [], currentTasks: [], authorityRoles: [], referencedParties: [], sourceTables: [] },
    identityAccess: { communicationIdentities: [], applicationAccounts: [], authProfiles: [] },
    referencedEntities: [{ entityType: 'pe_deal', entityId: ids.deal }, { entityType: 'pe_workstream', entityId: ids.workstream }],
    canonicalSummaries: [], epistemicWarnings: [], memory: { conversation: null, semantic: [], episodic: [] }, integrationHealth: {},
    authority: { principal: ids.employee, employeeId: ids.employee, revision: 1, roles: ['owner'] }, sources: [], health: { status: 'complete', missing: [], errors: [] },
  };
}
function includes(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return actual === expected;
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => includes(actual[index], value));
  const wanted = z.record(z.string(), z.unknown()).parse(expected), received = z.record(z.string(), z.unknown()).safeParse(actual);
  return received.success && Object.entries(wanted).every(([key, value]) => includes(received.data[key], value));
}
function score(test: PlannerLiveCase, result: PlanningResult): boolean {
  const graph = result.compilation.selected?.graph;
  if (!graph) return false;
  const material = graph.nodes.filter(node => node.kind !== 'check');
  if (material.length === 0) return false;
  const expected = test.expected;
  if (expected.kind === 'safe_response') return material.every(node => node.kind === 'query' || node.kind === 'action' && node.actionType === 'clarification_request');
  if (expected.kind === 'query') return material.every(node => node.kind === 'query') && material.some(node => node.kind === 'query' && includes(node.request, expected.request));
  return material.every(node => node.kind === 'action' && node.actionType === expected.actionType || node.kind === 'query')
    && material.some(node => node.kind === 'action' && node.actionType === expected.actionType && includes(node.payload, expected.payload));
}

async function main(): Promise<void> {
  await mkdir(output, { recursive: true });
  assert.equal(PLANNER_LIVE_CASES.length, 41, 'The reviewed finite corpus must be complete');
  const cases: { id: string; instruction: string; expected: PlannerLiveCase['expected']; status: 'PASS' | 'FAIL' | 'ERROR'; providerCalls: number; result?: PlanningResult; error?: string }[] = [];
  const sources = await Promise.all(['finnor-os/scripts/evaluate-current-planner.ts', 'finnor-os/scripts/fixtures/planner-live-cases.ts', 'finnor-os/packages/orchestration/src/planner.ts', 'finnor-os/packages/planning/src/compiler.ts'].map(async path => ({ path, sha256: createHash('sha256').update(await readFile(resolve(root, path))).digest('hex') })));
  const save = async () => {
    const status = cases.length === PLANNER_LIVE_CASES.length && cases.every(test => test.status === 'PASS' && test.providerCalls > 0) ? 'PASS' : 'FAIL';
    await writeFile(resolve(output, 'planner-eval.json'), JSON.stringify({ schema: 'finnor.planner-live-eval.v1', generatedAt: new Date().toISOString(), qualification, status, sources, paceMs, cases,
      steps: ['Use the complete current PE/Core corpus', 'Call the configured proposer for each case', 'Run actual LLMPlanner normalization and deterministic compiler', 'Compare selected graph behavior and exact required payloads with independent labeled expectations', 'Fail on any rejected, wrong, missing or errored case'],
      limits: 'Synthetic operating context; offline compilation uses no live tenant grounding or policy database. No effect execution, protected admission, provider truth or economic performance is certified. Fixture results validate the harness only, never live model quality.',
      rerun: 'Set an explicit configured LLM_PROVIDER_PLANNING route and its provider credentials; npm run eval:planner:live -- --out <directory>. Exact corpus and source pins are recorded. Fixture mode requires NODE_ENV=test, FINNOR_PLANNER_EVAL_FIXTURE=1 and a loopback PLANNER_EVAL_FIXTURE_URL.' }, null, 2));
    return status;
  };
  if (!fixtureUrl && !isPurposeConfigured('planning', 'text')) {
    await save(); throw new Error('No configured planning provider; live evaluation was not run');
  }
  const liveProvider = fixtureUrl ? null : resolveProviderForPurpose('planning', 'text');
  for (const test of PLANNER_LIVE_CASES) {
    let calls = 0;
    const provider: LLMProvider = {
      name: liveProvider?.name ?? 'disposable-evaluation-provider',
      async complete(options) {
        calls += 1;
        if (liveProvider) return liveProvider.complete({ ...options, tenantId: undefined });
        const response = await fetch(fixtureUrl!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ caseId: test.id, options }), redirect: 'error', signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error('Provider fixture returned HTTP ' + response.status);
        return z.object({ content: z.string().max(1_000_000) }).parse(await response.json()).content;
      },
    };
    try {
      const goalSpec = buildGoalSpec({ objective: test.instruction, successCondition: { source: 'explicit', criteria: [{ kind: 'manual_verification', reason: 'Evaluate this proposal against the instruction; no effect is executed by this harness.' }] } });
      const result = await new LLMPlanner(registry, provider).plan(test.instruction, { tenantId: ids.tenant, userId: ids.employee, employeeId: ids.employee, role: 'owner' }, emptyMemory,
        { operatingContext: context(), goalSpec, optimizationReplay: true, deadlineMs: 60_000 });
      cases.push({ ...test, status: calls > 0 && score(test, result) ? 'PASS' : 'FAIL', providerCalls: calls, result });
    } catch (error) { cases.push({ ...test, status: 'ERROR', providerCalls: calls, error: error instanceof Error ? error.name : 'Unknown provider error' }); }
    await save();
    console.log(JSON.stringify({ id: test.id, status: cases.at(-1)?.status, providerCalls: calls }));
    if (paceMs > 0 && test !== PLANNER_LIVE_CASES.at(-1)) await delay(paceMs);
  }
  const status = await save();
  console.log(JSON.stringify({ output, qualification, status, passed: cases.filter(test => test.status === 'PASS').length, total: cases.length }));
  if (status !== 'PASS') process.exitCode = 1;
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Planner evaluation failed'); process.exitCode = 1; });
