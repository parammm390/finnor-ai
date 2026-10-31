import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { PLANNER_LIVE_CASES } from '../fixtures/planner-live-cases';
import { LLMPlanner, createDefaultPluginRegistry, type LLMProvider } from '@finnor/orchestration';
const at = process.argv.indexOf('--out'); assert(at >= 0 && process.argv[at + 1], '--out required');
const output = resolve(process.argv[at + 1]!); await mkdir(output, { recursive: true });
let mode = 'valid', calls = 0;
const observations: unknown[] = [];
const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = z.object({ caseId: z.string(), options: z.object({ user: z.string() }) }).parse(JSON.parse(Buffer.concat(chunks).toString()));
    const test = PLANNER_LIVE_CASES.find(test => test.id === input.caseId); assert(test);
    calls += 1;
    const goal = z.object({ goal: z.object({ criteria: z.array(z.object({ id: z.string() })) }) }).parse(JSON.parse(input.options.user)).goal;
    const criteria = goal.criteria.map(criterion => criterion.id);
    const expected = test.expected;
    const node = expected.kind === 'query' ? { key: 'proposed', kind: 'query', request: expected.request, supports: criteria }
      : expected.kind === 'action' ? { key: 'proposed', kind: 'action', actionType: expected.actionType, payload: expected.payload, supports: criteria }
      : { key: 'proposed', kind: 'action', actionType: 'clarification_request', payload: { question: 'Which exact permitted input and human decision should be used?', missingFields: ['required_context'] }, supports: criteria };
    const value = mode === 'bad-envelope' || mode === 'one-failure' && test.id === 'open-findings'
      ? { actions: [{ action_type: 'create_invoice', payload: {} }] }
      : { candidates: [{ version: 1, candidateKey: 'fixture-proposal', nodes: [node, ...criteria.map((criterionId, index) => ({ key: 'check-' + index, kind: 'check', criterionId, dependsOn: ['proposed'] }))] }] };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ content: JSON.stringify(value) }));
  } catch (error) { response.writeHead(500).end(JSON.stringify({ error: String(error) })); }
});
try {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert(address && typeof address === 'object');
  const neverCalled: LLMProvider = { name: 'public-read-control', async complete() { throw new Error('Public research should use its existing deterministic path'); } };
  const publicRead = await new LLMPlanner(createDefaultPluginRegistry(), neverCalled).plan('Research the latest public industry benchmarks online and cite sources.',
    { tenantId: '10000000-0000-4000-8000-000000000001', userId: '10000000-0000-4000-8000-000000000002', role: 'owner' },
    { shortTerm: null, longTerm: null, semantic: [], episodic: [], patterns: null });
  assert(publicRead.compilation.selected?.graph?.nodes.some(node => node.kind === 'action' && node.actionType === 'search_web'));
  for (const selected of ['valid', 'one-failure', 'bad-envelope']) {
    mode = selected; calls = 0;
    const out = resolve(output, selected);
    const child = spawn(process.execPath, ['--import=tsx', 'scripts/evaluate-current-planner.ts', '--out', out], { env: {
      PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: 'test', LOG_LEVEL: 'silent',
      FINNOR_PLANNER_EVAL_FIXTURE: '1', PLANNER_EVAL_FIXTURE_URL: `http://127.0.0.1:${address.port}`, PLANNER_EVAL_PACE_MS: '0', LANGFUSE_ENABLED: '0',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
    const exitCode = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done); });
    await writeFile(resolve(output, selected + '.log'), log);
    assert.equal(exitCode, selected === 'valid' ? 0 : 1, log);
    const result = JSON.parse(await readFile(resolve(out, 'planner-eval.json'), 'utf8'));
    assert.equal(result.qualification, 'FIXTURE_PROVIDER_REAL_PLANNER_AND_COMPILER');
    assert.equal(calls, PLANNER_LIVE_CASES.length);
    assert.equal(result.cases.length, PLANNER_LIVE_CASES.length);
    assert.equal(result.status, selected === 'valid' ? 'PASS' : 'FAIL');
    observations.push({ selected, exitCode, calls, status: result.status, passed: result.cases.filter((test: { status: string }) => test.status === 'PASS').length });
  }
} finally {
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  await writeFile(resolve(output, 'planner-eval-e2e.json'), JSON.stringify({ observations, qualification: 'Actual CLI, current LLMPlanner and deterministic compiler through a local provider protocol adapter. Quality of a live model is not established. One bad case must fail the complete finite gate.', rerun: 'From finnor-os: node --import=tsx scripts/audits/verify-planner-eval.mts --out <external directory>' }, null, 2));
}
assert.equal(observations.length, 3); console.log(JSON.stringify({ output, observations }));
