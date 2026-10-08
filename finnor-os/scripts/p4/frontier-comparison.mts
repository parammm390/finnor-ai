/** Actual public tool-equipped comparator. Protocol/failure model predates this harness. */
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import {
  createDeal, createInvestmentCase, createUnderwritingModel,
  createUnderwritingModelVersion, createUnderwritingRun, explainUnderwritingOutput,
} from '@finnor/private-equity';

const MODEL = 'gemini-3.1-pro-preview';
const ROUTE = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const hash = (v: unknown) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const noArgs = z.object({}).strict();
const queryArg = z.object({ queryId: z.string().uuid() }).strict();
const witnessArg = queryArg.extend({ output: z.enum(['equity', 'leverage']) }).strict();
const programArg = z.object({ programJson: z.string().max(32768) }).strict();
const parameters = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'OBJECT', properties, required });
const TOOLS = [
  { name: 'list_permissioned_handles', description: 'Read actual current rights-bound canonical EV, debt and EBITDA source handles for this exact task root. Returns bounded schemas, coverage and owner-version identities.', parameters: parameters() },
  { name: 'execute_reusable_financial_procedure', description: 'Execute the shared prepared finite native equity=EV-debt and leverage=debt/EBITDA procedure through the real authenticated API, durable queue and source checks. Returns a query/derivation/Work reference; follow with witnesses and consumer.', parameters: parameters() },
  { name: 'execute_derivation_ir', description: 'Execute your finite trusted FINNOR derivation IR through the same real owner-bound API and native queue. Input is JSON for schema finnor.derivation-ir.v1, nodes and outputs. Source inputIds EV/debt/EBITDA; source, unique, subtract, ratio are supported. No SQL, shell, paths, network or host code.', parameters: parameters({ programJson: { type: 'STRING', description: 'Finite JSON IR. Material output names must be equity and leverage.' } }, ['programJson']) },
  { name: 'run_completed_s_underwriting', description: 'Run the actual existing completed-S exact numerical underwriting procedure on the same immutable public EvidenceVersion. This optional tool retains its legacy timestamp qualification; it alone cannot satisfy the new source-witness and same-Work derivation predicate.', parameters: parameters() },
  { name: 'inspect_witness', description: 'Retrieve actual current canonical source version/field locators, transformation and independent checks for one material output in a query created in this task.', parameters: parameters({ queryId: { type: 'STRING' }, output: { type: 'STRING', enum: ['equity', 'leverage'] } }, ['queryId', 'output']) },
  { name: 'consume_current_derivation', description: 'Consume this task current TESTED equity/leverage derivation as typed DERIVED_VALUE inputs in the existing immutable underwriting model, persisting the same Work and provenance. Does not copy prose values.', parameters: parameters({ queryId: { type: 'STRING' } }, ['queryId']) },
];

export async function frontierComparison(e: any) {
  const folder = join(e.evidence, 'frontier');
  await mkdir(folder, { recursive: true });
  const protocolPath = join(e.repo, 'scope-pm/phase-01-p4-evidence-execution/scope-evidence/frontier-supplement-protocol.json');
  const protocolBytes = await readFile(protocolPath);
  const started = performance.now(), startedAt = new Date().toISOString();
  const attempts: any[] = [], pairs: any[] = [], nativeEvents: any[] = [];
  const report: any = {
    schema: 'finnor.p4.actual-frontier-comparison.v1', startedAt, route: ROUTE,
    model: MODEL, catalogVersion: '3.1-pro-preview-01-2026', actualResponseVersions: [],
    protocolSha256: hash(protocolBytes.toString()), toolManifestSha256: hash(TOOLS), tools: TOOLS,
    corpus: e.fixture, corpusSha256: hash(e.fixture), oracle: e.expected,
    oracleProvenance: 'Fixed original public A/B/C constants; never included in model prompts.',
    attempts, pairs, nativeEvents, totalUSD: null, costStatus: 'PARTIAL_PROVIDER_USAGE_FULL_COST_UNAVAILABLE',
    qualification: 'Public dependent six-pair model-orchestration diagnostic. Common native tools, no independent sealed room or admission authority. No total-dollar or capability superiority.',
    governingGate: 'UNPASSED', comparison: 'INCONCLUSIVE', imageAttestation: null,
  };
  const save = async () => {
    report.durationMs = performance.now() - started;
    const priced = attempts.filter(a => a.quotedProviderGenerationUSD !== undefined);
    report.providerPricedAttempts = priced.length;
    report.providerUnknownAttempts = attempts.length - priced.length;
    report.quotedProviderGenerationUSD = priced.length ? priced.reduce((sum, a) => sum + a.quotedProviderGenerationUSD, 0) : null;
    report.quoteIsCompleteCost = false;
    report.unknownCostScopes = ['unreported provider usage/pending liabilities', 'API/DB/native tools', 'aggregate memory', 'human', 'bootstrap/preparation', 'historical reusable preparation', 'maintenance', 'data/integration'];
    await writeFile(join(folder, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  };
  const preparationStarted = performance.now(), prepared: Record<string, any> = {};
  for (const name of ['A', 'B', 'C']) {
    const deal = await createDeal(e.ctx, { targetOrganizationId: e.companies[name], name: 'P4 frontier ' + name, dealLeadEmployeeId: e.actor, signedLoiAt: new Date(e.periodStart), targetClosingAt: new Date('2027-01-01') });
    const c = await createInvestmentCase(e.ctx, { dealId: String(deal.row.id), title: 'Public equipped model comparison' });
    const investmentCaseId = String(c.row.id);
    const semantics = { entityType: 'external_organization', entityId: e.companies[name], unit: 'currency', currencyCode: 'USD', periodStart: e.periodStart, periodEnd: e.periodEnd, frequency: 'annual', calendar: 'OWNER_RECORDED', consolidation: 'OWNER_SUBJECT_ONLY', instrument: 'UNSPECIFIED', scale: '1', sign: 'AS_RECORDED' };
    const m = await createUnderwritingModel(e.ctx, { investmentCaseId, modelKey: 'p4-frontier-consumer', name: 'Existing exact P4 consumer' });
    const nodes = ['equity', 'leverage'].flatMap(id => {
      const unit = id === 'equity' ? 'money' : 'multiple';
      const common = { valueType: 'decimal', unit, shape: 'scalar', ...(id === 'equity' ? { currency: 'USD' } : {}) };
      return [ { id, kind: 'input', dependencies: [], ...common, required: true, allowedTruthClasses: ['DERIVED_VALUE'], evidenceSemantics: id === 'equity' ? semantics : { ...semantics, unit: 'multiple', currencyCode: null } }, { id: id + '_out', kind: 'output', dependencies: [id], sourceNodeId: id, ...common } ];
    });
    const v = await createUnderwritingModelVersion(e.ctx, { modelId: String(m.id), definition: { schemaVersion: 'underwriting-model-ir.v1', modelKey: 'p4-frontier-consumer', modelVersion: '1', financialConventionVersion: 'finnor-pe-lbo/1.0.0', minimumEngineVersion: 'finnor-underwriting-engine/1.0.0', periodDefinition: { frequency: 'annual', forecastStart: '2026-01-01', count: 1 }, nodes, circularBlocks: [] } } as any);
    const legacyModel = await createUnderwritingModel(e.ctx, { investmentCaseId, modelKey: 'p4-frontier-incumbent', name: 'Reusable completed-S procedure' });
    const legacyInputs = [['ev', 'EV'], ['debt', 'debt'], ['ebitda', 'EBITDA']].map(([id, metric]) => ({ id, kind: 'input', dependencies: [], valueType: 'decimal', unit: 'money', currency: 'USD', shape: 'scalar', required: true, source: { kind: 'evidence_version', evidenceVersionId: e.sourceRef.evidenceVersionId, valuePath: name + '.' + metric } }));
    const expressions = [['equity', 'subtract', 'ev', 'debt', 'money'], ['leverage', 'divide', 'debt', 'ebitda', 'ratio']].flatMap(([id, op, left, right, unit]) => [
      { id: id + '_calc', kind: 'expression', dependencies: [left, right], valueType: 'decimal', unit, ...(unit === 'money' ? { currency: 'USD' } : {}), shape: 'scalar', expression: { op, args: [{ op: 'ref', nodeId: left }, { op: 'ref', nodeId: right }] } },
      { id, kind: 'output', dependencies: [id + '_calc'], sourceNodeId: id + '_calc', valueType: 'decimal', unit, ...(unit === 'money' ? { currency: 'USD' } : {}), shape: 'scalar' },
    ]);
    const lv = await createUnderwritingModelVersion(e.ctx, { modelId: String(legacyModel.id), definition: { schemaVersion: 'underwriting-model-ir.v1', modelKey: 'p4-frontier-incumbent', modelVersion: '1', financialConventionVersion: 'finnor-pe-lbo/1.0.0', minimumEngineVersion: 'finnor-underwriting-engine/1.0.0', periodDefinition: { frequency: 'annual', forecastStart: '2026-01-01', count: 1 }, nodes: [...legacyInputs, ...expressions], circularBlocks: [] } } as any);
    prepared[name] = { investmentCaseId, modelVersionId: String(v.id), legacyVersionId: String(lv.id) };
  }
  report.preparationMs = performance.now() - preparationStarted;
  report.prepared = prepared;

  function verify(name: string, state: any) {
    assert(state.completed, 'REAL_DERIVATION_REQUIRED');
    const done = state.completed;
    assert.equal(done.status, 'TESTED');
    assert.equal(done.derivation.coverage.status, 'COMPLETE_SELECTED_UNIVERSE');
    for (const key of ['equity', 'leverage']) {
      assert.equal(done.derivation.result.outputs[key].value, e.expected[name][key]);
      assert.equal(done.derivation.result.outputs[key].truthClass, 'DERIVED_VALUE');
      assert(state.witnesses[key], 'ACTUAL_WITNESS_READ_REQUIRED');
      assert.equal(state.witnesses[key].body.queryId, done.queryId);
      assert.equal(state.witnesses[key].body.derivationId, done.derivation.id);
      assert(state.witnesses[key].body.witnesses.length > 0);
      assert.equal(state.used.result.outputs[key + '_out'].value, e.expected[name][key]);
      assert.equal(state.used.inputSnapshot.values[key].truthClass, 'DERIVED_VALUE');
      assert(state.used.inputSnapshot.values[key].provenance.some((p: any) => p.kind === 'evidence_derivation' && p.id === done.derivation.id));
    }
    assert(done.derivation.independentChecks.every((c: any) => c.status === 'PASS'));
    assert.equal(state.used.workId, done.workId);
    return { exact: true, witnesses: true, currentChecks: true, actualConsumer: true, sameWork: true };
  }
  await e.test('frontier-acceptance-rejects-prose-only', { suppliedProse: 'A equity50 leverage3.5' }, 'actual comparator verifier refuses supplied answer without real derivation, witnesses and consumer', async () => {
    assert.throws(() => verify('A', { answer: 'A equity50 leverage3.5' }), /REAL_DERIVATION_REQUIRED/);
    return { rejected: true, predicate: 'REAL_DERIVATION_REQUIRED', providerResponse: false };
  });

  function session(name: string) {
    const state: any = { queries: new Map(), witnesses: {}, completed: null, used: null };
    const own = (id: string) => { const q = state.queries.get(id); assert(q, 'TASK_QUERY_SCOPE_REQUIRED'); return q; };
    async function execute(fn: string, raw: unknown) {
      assert(performance.now() - started < 3600000, 'SHARED_EPISODE_WALL_EXCEEDED');
      const t = performance.now(), cpu = process.cpuUsage();
      const item: any = { name, function: fn, arguments: raw, startedAt: new Date().toISOString() };
      nativeEvents.push(item);
      try {
        let out: any;
        if (fn === 'list_permissioned_handles') {
          noArgs.parse(raw); out = { handles: await e.handles(name) };
        } else if (fn === 'execute_reusable_financial_procedure' || fn === 'execute_derivation_ir') {
          let program: any = e.program;
          if (fn === 'execute_derivation_ir') program = JSON.parse(programArg.parse(raw).programJson); else noArgs.parse(raw);
          const submitted = await e.submit(name, { program });
          const done = await e.finish(submitted);
          state.queries.set(done.queryId, done); state.completed = done;
          out = { queryId: done.queryId, derivationId: done.derivation?.id, workId: done.workId, status: done.status, result: done.derivation?.result, checks: done.derivation?.independentChecks, coverage: done.derivation?.coverage };
          item.fullNativeDerivation = done;
        } else if (fn === 'run_completed_s_underwriting') {
          noArgs.parse(raw); const c = prepared[name]!;
          const run = await createUnderwritingRun(e.ctx, { investmentCaseId: c.investmentCaseId, modelVersionId: c.legacyVersionId, worldAt: new Date().toISOString(), idempotencyKey: randomUUID() });
          const explanation = await explainUnderwritingOutput(e.ctx, String(run.id), 'equity');
          out = { runId: run.id, result: run.result, inputSnapshot: run.inputSnapshot, explanation, qualification: 'LEGACY_TIMESTAMP_ONLY_NOT_FULL_P4_CURRENTNESS' };
        } else if (fn === 'inspect_witness') {
          const args = witnessArg.parse(raw); own(args.queryId);
          const w = await e.api('evidence-witness', args); assert.equal(w.status, 200, JSON.stringify(w));
          state.witnesses[args.output] = w; out = w.body;
        } else if (fn === 'consume_current_derivation') {
          const args = queryArg.parse(raw), done = own(args.queryId); assert.equal(done.status, 'TESTED');
          const c = prepared[name]!;
          const used = await e.api('evidence-consume', { investmentCaseId: c.investmentCaseId, modelVersionId: c.modelVersionId, worldAt: e.validAt, idempotencyKey: randomUUID(), bindings: { equity: { derivationId: done.derivation.id, output: 'equity' }, leverage: { derivationId: done.derivation.id, output: 'leverage' } } });
          assert.equal(used.status, 200, JSON.stringify(used)); state.used = used.body;
          const row = (await e.admin.query('SELECT work_id::text FROM finnor_os.underwriting_runs WHERE id=$1', [state.used.id])).rows[0];
          assert.equal(row.work_id, done.workId); item.persistedWork = row;
          out = { runId: state.used.id, workId: state.used.workId, result: state.used.result, inputSnapshot: state.used.inputSnapshot };
        } else throw Error('UNREGISTERED_NATIVE_FUNCTION');
        item.result = out; item.status = 'COMPLETED'; return out;
      } catch (error) {
        item.status = 'REFUSED'; item.error = String((error as Error).message);
        return { refused: true, predicate: item.error };
      } finally {
        const delta = process.cpuUsage(cpu); item.wallMs = performance.now() - t;
        item.parentCpuMicros = delta.user + delta.system; item.parentRssBytes = process.memoryUsage().rss;
        item.totalUSD = null; await save();
      }
    }
    return { state, execute };
  }

  const keySource = process.env.FINNOR_P4_GEMINI_ENV_FILE ?? '/Users/paramdave/FINNOR/.env.local';
  const envText = await readFile(keySource, 'utf8');
  let key = process.env.GEMINI_API_KEY ?? envText.match(/^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.+)\s*$/m)?.[1]?.trim();
  if (key && ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'")))) key = key.slice(1, -1);
  assert(key, 'EXISTING_GEMINI_CREDENTIAL_UNAVAILABLE');
  const redact = (v: string) => v.split(key!).join('[REDACTED]');
  let externalBlock: any = null;
  const direct = async (name: string) => {
    const t = performance.now(), s = session(name);
    await s.execute('list_permissioned_handles', {});
    await s.execute('execute_reusable_financial_procedure', {});
    const queryId = s.state.completed?.queryId;
    for (const output of ['equity', 'leverage']) await s.execute('inspect_witness', { queryId, output });
    await s.execute('consume_current_derivation', { queryId });
    const checked = verify(name, s.state);
    return { status: 'PASS_LOCAL_PUBLIC_TASK', wallMs: performance.now() - t, checked, derivation: s.state.completed, witnesses: s.state.witnesses, consumer: s.state.used, totalUSD: null };
  };

  for (let trial = 0; trial < 2; trial++) for (const name of ['A', 'B', 'C']) {
    assert(performance.now() - started < 3600000, 'SHARED_EPISODE_WALL_EXCEEDED');
    const pair: any = { name, trial: trial ? 'amortized-task' : 'cold-task' }; pairs.push(pair);
    if (trial) pair.direct = await direct(name);
    if (externalBlock) pair.model = { status: 'NOT_RUN_EXTERNAL', reason: externalBlock };
    else {
      const t = performance.now(), s = session(name);
      const contents: any[] = [{ role: 'user', parts: [{ text: `Public task ${name}. Exact root: ${JSON.stringify(e.root(name))}. Annual period ${e.periodStart} to ${e.periodEnd}; USD, scale1, AS_RECORDED, OWNER_RECORDED calendar, OWNER_SUBJECT_ONLY consolidation, UNSPECIFIED instrument. Calculate equity=EV-debt and leverage=debt/EBITDA with exact trusted native execution, inspect both material witnesses, then consume into the existing underwriting model in the same Work. Use tools; a prose answer does not complete the task. Source handles expose bounded schemas and current coverage, not the whole room. The shared reusable procedure is available; alternatively propose a finite IR. Registered reusable plan: ${JSON.stringify(e.program)}. No expected answers are supplied. Preserve global coverage limitations and DERIVED_VALUE qualification.` }] }];
      pair.model = { status: 'INCOMPLETE', attempts: [], toolCalls: 0 };
      for (let call = 0; call < 8; call++) {
        assert(attempts.length < 48, 'GLOBAL_PROVIDER_CALL_BOUND');
        const remainingWallMs = 3600000 - (performance.now() - started);
        assert(remainingWallMs > 0, 'SHARED_EPISODE_WALL_EXCEEDED');
        const request = { contents, tools: [{ functionDeclarations: TOOLS }], generationConfig: { temperature: 1, maxOutputTokens: 8192 }, toolConfig: { functionCallingConfig: { mode: 'AUTO' } } };
        const bytes = JSON.stringify(request); assert(Buffer.byteLength(bytes) <= 131072, 'PROVIDER_REQUEST_BYTE_BOUND');
        const a: any = { id: randomUUID(), name, trial: pair.trial, call, route: ROUTE, requestedModel: MODEL, startedAt: new Date().toISOString(), requestSha256: hash(bytes), requestBytes: Buffer.byteLength(bytes), nativeCredentialForwarded: false, totalUSD: null };
        attempts.push(a); pair.model.attempts.push(a.id);
        await writeFile(join(folder, 'request-' + a.id + '.json'), bytes + '\n');
        const at = performance.now();
        try {
          const response = await fetch(ROUTE, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key! }, body: bytes, signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(120000, remainingWallMs)))) });
          a.httpStatus = response.status;
          const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
          assert(reader, 'PROVIDER_RESPONSE_BODY_MISSING');
          for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 2097152) { await reader.cancel(); throw Error('PROVIDER_RESPONSE_BYTE_BOUND'); } chunks.push(part.value); }
          const raw = redact(Buffer.concat(chunks).toString('utf8'));
          a.responseSha256 = hash(raw); a.responseBytes = size;
          await writeFile(join(folder, 'response-' + a.id + '.json'), raw + '\n');
          a.providerResponseWallMs = performance.now() - at;
          const body = JSON.parse(raw); a.modelVersion = body.modelVersion ?? null;
          a.usageMetadata = body.usageMetadata ?? null; a.responseId = body.responseId ?? null;
          if (a.modelVersion && !report.actualResponseVersions.includes(a.modelVersion)) report.actualResponseVersions.push(a.modelVersion);
          if (a.usageMetadata) {
            const u = a.usageMetadata;
            if (Number.isFinite(u.promptTokenCount) && Number.isFinite(u.candidatesTokenCount)) a.quotedProviderGenerationUSD = (u.promptTokenCount * 2 + (u.candidatesTokenCount + (u.thoughtsTokenCount ?? 0)) * 12) / 1000000;
          }
          if (!response.ok) {
            a.status = 'PROVIDER_REFUSED'; a.error = body.error ?? body;
            if ([401, 402, 403, 404, 429].includes(response.status)) {
              externalBlock = { httpStatus: response.status, attemptId: a.id, reason: 'ACTUAL_GENERATION_ROUTE_REFUSED', error: a.error };
              pair.model.status = 'REFUSED_EXTERNAL'; pair.model.reason = externalBlock;
            } else {
              pair.model.error = { httpStatus: response.status, error: a.error, qualification: 'Request/server failure retained; not an auth/plan/quota qualification.' };
            }
            break;
          }
          const candidate = body.candidates?.[0]; a.finishReason = candidate?.finishReason ?? null;
          assert(candidate?.content?.parts, 'ACTUAL_MODEL_CONTENT_MISSING');
          // Preserve every original part and its thoughtSignature verbatim for provider continuation.
          contents.push(candidate.content);
          const calls = candidate.content.parts.flatMap((part: any) => part.functionCall ? [part.functionCall] : []);
          a.status = 'RESPONDED'; a.functionCalls = calls;
          if (!calls.length) { pair.model.finalText = candidate.content.parts.filter((part: any) => part.text).map((part: any) => part.text).join('\n'); break; }
          assert(pair.model.toolCalls + calls.length <= 64, 'TASK_NATIVE_FUNCTION_CALL_BOUND');
          const responses = [];
          for (const fc of calls) {
            pair.model.toolCalls++;
            const result = await s.execute(fc.name, fc.args ?? {});
            responses.push({ functionResponse: { name: fc.name, ...(fc.id ? { id: fc.id } : {}), response: { result } } });
          }
          contents.push({ role: 'user', parts: responses });
          if (s.state.completed && s.state.used && s.state.witnesses.equity && s.state.witnesses.leverage) break;
        } catch (error) {
          a.status = 'ATTEMPT_FAILED_OR_UPSTREAM_UNKNOWN'; a.error = redact(String((error as Error).message)); pair.model.error = a.error; break;
        } finally {
          a.wallMs = performance.now() - at;
          if (pair.model.firstProviderResponseMs === undefined && a.providerResponseWallMs !== undefined) pair.model.firstProviderResponseMs = a.providerResponseWallMs;
          await save();
        }
      }
      pair.model.wallMs = performance.now() - t;
      if (!externalBlock) {
        try { pair.model.checked = verify(name, s.state); pair.model.status = 'PASS_LOCAL_PUBLIC_TASK'; pair.model.derivation = s.state.completed; pair.model.witnesses = s.state.witnesses; pair.model.consumer = s.state.used; }
        catch (error) { pair.model.status = 'FAILED_MATERIAL_ACCEPTANCE'; pair.model.acceptanceError = String((error as Error).message); }
      }
    }
    if (!trial) pair.direct = await direct(name);
    await save();
  }
  report.status = externalBlock ? 'BLOCKED_EXTERNAL_PROVIDER' : pairs.every(p => p.model.status === 'PASS_LOCAL_PUBLIC_TASK') ? 'PASS_LOCAL_PUBLIC_TASKS' : 'FAILED_PUBLIC_MODEL_TASKS';
  report.externalBlock = externalBlock;
  report.completedModelTasks = pairs.filter(p => p.model.status === 'PASS_LOCAL_PUBLIC_TASK').length;
  report.completedDirectTasks = pairs.filter(p => p.direct.status === 'PASS_LOCAL_PUBLIC_TASK').length;
  report.firstResponseFloor = pairs.map(p => ({ name: p.name, trial: p.trial, modelMs: p.model.firstProviderResponseMs ?? null, modelWithin30s: p.model.firstProviderResponseMs === undefined ? null : p.model.firstProviderResponseMs <= 30000 }));
  await save();
  return report;
}
