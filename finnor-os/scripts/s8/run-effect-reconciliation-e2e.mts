/** Original S8 shadow use → native S5/S4/S6 effect → protected readback →
 * native S7 → durable S8 H0 reconciliation. No scientific admission or value. */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { requiredCapabilitySourcePaths } from '../../packages/capability-evolution/src/source-closure';
import { CapabilityEvolution } from '../../packages/capability-evolution/src/lifecycle';
import { canonical } from '../../packages/governed-execution/src/protocol';
import { byteDigest, digest, makeRef } from '../../packages/capability-evolution/src/contracts';
import { createNativeOwnerDatabase } from '../s7/native-owner-database.mjs';
import { createEconomicLedger } from '../s7/ledger-fixture.mjs';
import { economicFixture } from '../s7/economic-fixtures.mjs';
import { createUpstreamFixtureSupport } from '../s5/owner-fixture.mjs';
import { createCapabilityLifecycle } from './lifecycle-fixture.mjs';
import { admitGeneratedLifecycleControl } from './generated-admission-fixture.mjs';
import { proveGovernedDispatch } from '../s6/governed-dispatch-proof.mjs';
const out = resolve(process.env.FINNOR_S8_EVIDENCE_DIR ?? '../scope-8/scope-evidence/effect-reconciliation');
await mkdir(out, { recursive: true });
const sourcePaths = [...new Set([...requiredCapabilitySourcePaths, ...[
    'scripts/s8/run-effect-reconciliation-e2e.mts', 'scripts/s8/generated-admission-fixture.mts', 'scripts/s8/lifecycle-fixture.mts',
    'scripts/s6/governed-dispatch-proof.mts', 'scripts/s7/native-owner-database.mts', 'scripts/s7/ledger-fixture.mts',
    'scripts/s7/economic-fixtures.mts', 'scripts/s5/owner-fixture.mts', 'scripts/s3/reference.py', 'scripts/s5/reference.py',
    'packages/epistemic-runtime/src/allocation-solver.py', 'packages/governed-execution/src/owner-delivery-store.ts',
    'packages/private-equity/src/obligation-contracts.ts', 'packages/private-equity/src/enterprise-beliefs.ts',
    'packages/governed-execution/src/ledger.ts', 'packages/governed-execution/src/ledger-server.mts',
    'packages/governed-execution/src/request-verifier.ts', 'packages/governed-execution/src/adapter-contract.ts',
    'packages/governed-execution/src/dispatch-broker.ts', 'packages/governed-execution/src/broker-io.ts',
].map(p => resolve(p))])];
const snapshot = () => Promise.all(sourcePaths.map(async path => ({ path, sha256: byteDigest(await readFile(path)) })));
const before = await snapshot(), startedAt = new Date().toISOString(), results: any[] = [], calls: any[] = [];
const artifact = async (name: string, value: any) => { const path = join(out, name); await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2) + '\n'); return path; };
const save = (extra: any = {}) => artifact('results.json', { schema: 'finnor.s8.physical-reconciliation-e2e.v1', startedAt, results, calls, before, node: process.version, ...extra,
    qualification: 'REAL_NATIVE_OWNERS_AND_LOCAL_TLS_PHYSICAL_H0; GENERATED_SIGNED_SHADOW_SETUP; NO_CANDIDATE_EFFECT_OR_CAUSAL_VALUE_OR_H2_OR_PRODUCTION_AUTHORITY',
    rerun: 'FINNOR_S3_PYTHON=<pinned> FINNOR_S5_PYTHON=<pinned> FINNOR_S8_EVIDENCE_DIR=<new-dir> node --import=tsx scripts/s8/run-effect-reconciliation-e2e.mts' });
process.env.FINNOR_S3_MODEL_STORE = join(out, 'ordinary-models'); process.env.FINNOR_S4_POLICY_STORE = join(out, 'ordinary-policies');
const db = await createNativeOwnerDatabase();
let ledger: any, service: any, lifecycle: CapabilityEvolution | null = null;
try {
    const allocationRoute = await import('../../apps/api/app/api/allocations/[operation]/route'), s4Route = await import('../../apps/api/app/api/policies/[operation]/route'), s6Route = await import('../../apps/api/app/api/obligations/[operation]/route');
    const api = async (f: any, operation: string, body: any, handler = allocationRoute.POST) => { const response = await handler(new Request('http://localhost/api/owners/' + operation, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tenant-id': f.tenant, 'x-user-id': f.principal }, body: JSON.stringify(body) }), { params: Promise.resolve({ operation }) }); const answer = { status: response.status, body: await response.json() as any }; calls.push({ ownerOperation: operation, ...answer }); return answer; };
    const success = (answer: any) => { assert.equal(answer.status, 200, JSON.stringify(answer)); return answer.body; };
    const generated = spawnSync(process.env.FINNOR_S3_PYTHON!, ['scripts/s3/reference.py'], { input: JSON.stringify({ operation: 'equivalent' }), encoding: 'utf8', timeout: 30000 }); assert.equal(generated.status, 0, generated.stderr);
    const day = 86400000, upstream = createUpstreamFixtureSupport({ admin: () => db.admin, generatedRows: JSON.parse(generated.stdout).rows, begin: new Date(Math.floor(Date.now() / day) * day - 128 * day).toISOString(), day, fixtures: {}, api, artifact });
    const f = await upstream.fixture('s8-physical-' + randomUUID().slice(0, 8), 2, [{ id: 'cash', unit: 'USD', capacity: 100, totalLimit: 100 }, { id: 'execution', unit: 'request', capacity: 200, totalLimit: 200, resourceClass: 'COMPUTE' }, { id: 'human', unit: 'seconds', capacity: 4, totalLimit: 4, resourceClass: 'HUMAN_ATTENTION' }]);
    const policy = await upstream.policy(f, 'price', { cash: 25, execution: 130, human: 4 });
    await upstream.resource(f, 'cash', 'USD', 'STOCK', ['100', '100', '100']); await upstream.resource(f, 'execution', 'request', 'CUMULATIVE_EXPENDITURE', ['200', '200', '200']); await upstream.resource(f, 'human', 'seconds', 'CUMULATIVE_EXPENDITURE', ['4', '4', '4']);
    const evaluator = randomUUID(), promoter = randomUUID();
    service = await createCapabilityLifecycle({ tenant: f.tenant, principal: f.principal, evaluator, promoter, rightsRef: f.mandate.rightsRef, sourcePins: before.filter(p => !p.path.includes('/scripts/')) });
    ledger = await createEconomicLedger(f.tenant, f.principal, randomUUID(), { rightsRef: f.mandate.rightsRef, capabilityLifecycle: true, nativeAllocation: true, financialPrincipal: evaluator });
    const owner = await import('../../packages/private-equity/src/enterprise-allocation'), economic = await import('../../packages/private-equity/src/enterprise-economic-attribution'), delivery = await import('../../packages/governed-execution/src/owner-delivery-store');
    const baseline = success(await api(f, 'clear', upstream.clearing(f, { price: ['100'] }))); assert.equal(baseline.status, 'FEASIBLE');
    const baselineIssued = await owner.readEnterpriseAllocation(f.ctx, baseline.certificate.ref);
    await ledger.publish({ ...baselineIssued.certificate.ref, content: (({ ref, ...body }: any) => body)(baselineIssued.certificate) });
    const exp = { schema: 'finnor.s7.generated-experience.v1', tenantId: f.tenant, principalId: f.principal, knowledgeAt: new Date().toISOString(), cases: [{ outcome: 'UNKNOWN', cost: null }], qualification: 'GENERATED_SIGNED_SETUP_ONLY' }, expRef = { owner: 'S7', id: 'physical-setup:' + digest(exp), version: 'generated-v1', contentDigest: digest(exp) };
    await ledger.publish({ ...expRef, content: exp });
    const body = { schema: 'finnor.capability-revision.v1', tenantId: f.tenant, principalId: f.principal, episodeId: 'physical-reconciliation-control', parents: [], owningInterface: 's5-joint-finite-v1', payload: { schema: 'finnor.s8.allocation-method.v1', algorithm: 'ENUMERATE_EXACT', order: 'CANONICAL', incumbent: 'FIRST_FEASIBLE', maxPolicies: 8, maximumNodes: 511 }, dependencies: service.policy.sourcePins, runtime: { node: process.version, platform: process.platform, architecture: process.arch }, experience: { refs: [expRef], knowledgeCut: new Date().toISOString(), trainingCompanies: ['generated-training'], dependenceGroups: ['generated-training-group'], qualification: 'AUTHENTICATED_OWNER_HISTORY_NO_CAUSAL_REWARD_ASSUMED' }, intendedImprovement: 'Exact finite method; generated setup admits only the SHADOW reconciliation mechanics', domain: { owner: 'S5', interface: 's5-joint-finite-v1', maxPolicies: 8, maxPeriods: 8, maxScenarios: 8, strata: ['coupled', 'prior-regime'], rightsRef: f.mandate.rightsRef, validAfter: service.after, validUntil: service.until }, envelope: { maxAttempts: 8, maxNodes: 511, maxWallMs: 30000, maxHumanSeconds: 900, maxCost: 10, maxDecisionLoss: 0, maxUses: 20 }, proposedAt: new Date().toISOString() }, revision = { ...body, ref: makeRef('capability-revision', body) };
    await service.start();
    const command = async (actor: string, operation: string, commandBody: any, requestId = 'physical:' + randomUUID()) => {
        let answer: any;
        if (lifecycle) { try { answer = { status: 200, body: await lifecycle.command(service.tokens[actor], { requestId, operation, body: commandBody }) }; } catch (e: any) { answer = { status: e.status ?? 409, body: { code: e.code, message: e.message } }; } }
        else { const response = await fetch(service.endpoint() + '/command', { method: 'POST', headers: { authorization: 'Bearer ' + service.tokens[actor], 'content-type': 'application/json' }, body: canonical({ requestId, operation, body: commandBody }), signal: AbortSignal.timeout(15000) }); answer = { status: response.status, body: await response.json() as any }; }
        calls.push({ actor, operation, requestId, status: answer.status, code: answer.body.code ?? null }); return answer;
    };
    success(await command('proposer', 'PROPOSE', revision));
    success(await command('proposer', 'ATTEMPT', { revisionRef: revision.ref, kind: 'SEARCH', status: 'SUCCEEDED', reservedCost: 1, actualCost: 1, allocationRef: baseline.certificate.ref, modelIdentity: null, modelComputeRef: null, outputDigest: digest(revision.payload), error: null }));
    const read = success(await command('reader', 'READ', {})), costRefs: any[] = [];
    const publishCost = async (content: any) => { const ref = { owner: 'FINANCIAL_SOURCE', id: 'physical-cost:' + digest(content), version: 'generated-cost-v1', contentDigest: digest(content) }; await ledger.publish({ ...ref, content }); costRefs.push(ref); };
    await publishCost({ schema: 'finnor.s8.independent-attempt-cost.v1', tenantId: f.tenant, episodeId: revision.episodeId, currency: 'USD', attemptId: read.attempts[0].attemptId, amount: [1, 1], basis: 'REGISTERED_GENERATIVE_MODEL', knowledgeAt: new Date().toISOString() });
    for (const category of ['search', 'training', 'evaluation', 'human', 'computeData', 'integration', 'maintenance', 'recovery', 'deployment']) await publishCost({ schema: 'finnor.s8.independent-lifecycle-cost.v1', tenantId: f.tenant, episodeId: revision.episodeId, currency: 'USD', category, amount: category === 'search' ? [1, 1] : [0, 0], basis: 'REGISTERED_GENERATIVE_MODEL', knowledgeAt: new Date().toISOString() });
    await admitGeneratedLifecycleControl({ revision, wave: 'physical-mechanics', service, command, attempts: read.attempts, costRefs, searchCost: 1 });
    success(await command('promoter', 'ACTIVATE', service.signed({ revisionRef: revision.ref, expectedGeneration: 0, predecessorRef: null, mode: 'SHADOW', maxDecisionLoss: 0, maxCost: 10, maxUses: 20, validUntil: service.until, evidenceRefs: [] }, 'promoter')));
    await owner.releaseEnterpriseAllocation(f.ctx, { allocationRef: baseline.certificate.ref, idempotencyKey: 'untouched-baseline-release' });
    const tokenPath = join(service.root, 'consumer.token'), configPath = join(service.root, 'consumer.json'); await writeFile(tokenPath, service.tokens.consumer, { mode: 0o600 });
    const consumerPolicy = { schema: 'finnor.s8.consumer-policy.v1', domain: 'DISPOSABLE_TEST_AUTHORITY', tenantId: f.tenant, principalId: f.principal, rightsRef: f.mandate.rightsRef, endpoint: service.endpoint(), tokenPath, tokenHash: byteDigest(service.tokens.consumer), stratum: 'coupled', reservedCost: 1, maxDecisionLoss: 0, validAfter: service.after, validUntil: service.until, timeoutMs: 10000 };
    await writeFile(configPath, canonical(service.signed(consumerPolicy, 'release')), { mode: 0o600 }); process.env.FINNOR_S8_CONSUMER_CONFIG = configPath; process.env.FINNOR_S8_CONSUMER_ROOT = service.pub('release');
    const allocated = success(await api(f, 'clear', upstream.clearing(f, { price: ['100'] }))); assert.equal(allocated.status, 'FEASIBLE');
    delete process.env.FINNOR_S8_CONSUMER_CONFIG; delete process.env.FINNOR_S8_CONSUMER_ROOT;
    const issued = await owner.readEnterpriseAllocation(f.ctx, allocated.certificate.ref), lease = issued.certificate.compute.usage.backend.capabilityLease as any; assert(lease); assert.equal(lease.mode, 'SHADOW'); assert.notEqual(issued.certificate.compute.actualRoute, 'S8_ADMITTED_ALLOCATION_METHOD');
    const selected = success(await api(f, 'handoff', { policyRef: policy.ref, allocationRef: issued.certificate.ref, decision: upstream.decision(f, issued.certificate.ref) }, s4Route.POST));
    const obligation = success(await api(f, 'prepare', { preparationRef: selected.preparationRef, allocationRef: selected.allocationRef, consumptionRef: selected.consumptionRef }, s6Route.POST));
    const question = await economic.registerEnterpriseOutcomeEstimand(f.ctx, { estimand: economicFixture(8, 0, 15).input.estimand, rightsRef: f.mandate.rightsRef, mode: 'RETROSPECTIVE', idempotencyKey: 'physical-question' });
    const oldTransport = JSON.parse(await readFile(process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG!, 'utf8')).policy, historicalOriginKeys = oldTransport.routes.find((r: any) => r.semanticOwner === 'S5' && r.purpose === 'OWNER').originKeys;
    const ownerRoute = oldTransport.routes.find((r: any) => r.semanticOwner === 'S8' && r.purpose === 'OWNER'); assert(ownerRoute);
    await service.stop();
    const proof = await proveGovernedDispatch(f, obligation, api, db.admin, artifact, false, undefined, false, { ownerRoute, historicalOriginKeys, references: [issued.problem, issued.certificate].map(({ ref, ...content }: any) => ({ ...ref, content })), afterSettlement: async context => {
        lifecycle = await CapabilityEvolution.open(service.configPath, service.pub('release'));
        const beforeReconciliation = success(await command('reader', 'READ', {})); assert.equal(beforeReconciliation.uses.length, 1); assert.equal(beforeReconciliation.uses[0].useId, lease.useId);
        success(await command('promoter', 'REVOKE', service.signed({ revisionRef: revision.ref, expectedGeneration: 1, predecessorRef: null, reason: 'REVOKE_WITH_ORIGINAL_EFFECT_RESPONSIBILITY_RETAINED' }, 'promoter')));
        const publishOutcome = async (record: any, label: string) => { const created = await economic.appendEnterpriseEconomicRecord(f.ctx, { kind: 'EXPOSURE', estimandRefId: question.record.ref.id, record, sourceRefs: [issued.certificate.ref, obligation.ref], validAt: new Date().toISOString(), idempotencyKey: label }); const report = await delivery.deliverOwnerTransportBatch({ semanticOwner: 'S7', tenantId: f.tenant, principalId: f.principal }, { limit: 32 }); const resolved = await economic.readEnterpriseEconomicRecord(f.ctx, { id: created.record.ref.id, protectedReadback: true }); assert('protectedReadback' in resolved && resolved.protectedReadback); return { created, report, resolved }; };
        const outcomeBody = { schema: 'finnor.s8.use-effect-outcome.v1', useId: lease.useId, revisionRef: revision.ref, inputDigest: lease.inputDigest, outcome: 'VERIFIED', allocationRef: issued.certificate.ref, obligationRef: obligation.ref, settlementEventId: context.settlementEventId, effectRef: obligation.effectRef, horizon: 'H0', causalCreditGranted: false, candidateExposure: false };
        const unknown = await publishOutcome({ ...outcomeBody, outcome: 'UNKNOWN' }, 'physical-unknown'); success(await command('consumer', 'RECONCILE', { useId: lease.useId, outcome: 'UNKNOWN', evidenceRef: unknown.created.record.ref }));
        const verified = await publishOutcome(outcomeBody, 'physical-verified'), executionLineage = { allocationRef: issued.certificate.ref, obligationRef: obligation.ref, settlementEventId: context.settlementEventId }, request = { useId: lease.useId, outcome: 'VERIFIED', evidenceRef: verified.created.record.ref, priorEvidenceRef: unknown.created.record.ref, executionLineage };
        for (const [field, changed] of [['inputDigest', digest('substituted-input')], ['candidateExposure', true], ['effectRef', { ...obligation.effectRef, semanticHash: '0'.repeat(64) }]] as const) {
            const wrong = await publishOutcome({ ...outcomeBody, [field]: changed }, 'physical-substitution-' + field); const refused = await command('consumer', 'RECONCILE', { ...request, evidenceRef: wrong.created.record.ref }); assert.equal(refused.body.code, 'S8_EFFECT_S7_USE_OR_EXPOSURE_SUBSTITUTION', JSON.stringify(refused));
        }
        const requestId = 'physical-exact-reconciliation', qualified = success(await command('consumer', 'RECONCILE', request, requestId)); assert.equal(qualified.effectLineage.horizon, 'H0'); assert.equal(qualified.effectLineage.candidateExposure, false); assert.equal(qualified.effectLineage.exposure, 'SHADOW_INCUMBENT_DECISION_METHOD'); assert.equal(qualified.causalCreditGranted, false); assert.equal(qualified.liabilityBudgetReleased, false); assert.equal(qualified.effectLineage.costs.status, 'UNMETERED'); assert.equal(qualified.effectLineage.ownerLossDispositionQualified, false);
        assert.deepEqual(success(await command('consumer', 'RECONCILE', request, requestId)), qualified);
        const afterPhysical = success(await command('reader', 'READ', {})); assert.deepEqual(afterPhysical.accounting, beforeReconciliation.accounting); assert.equal(afterPhysical.active, null); assert.equal(afterPhysical.uses[0].reconciliations.length, 2);
        const successorTarget = { ...service.policy, maxTotalCost: 101 }, tooSmall = { ...successorTarget, maxTotalCost: 1 };
        const requestHandoff = (target: any) => service.signed({ runtimeHandoff: true, expectedGeneration: afterPhysical.generation, successorPolicyDigest: CapabilityEvolution.handoffTargetDigest(target), successorPolicy: target, reason: 'TRANSFER_ORIGINAL_EFFECT_DUTIES_WITHOUT_ACTIVATION_OR_BUDGET_RESET' }, 'promoter');
        const boundedRefusal = await command('promoter', 'HANDOFF', requestHandoff(tooSmall)); assert.equal(boundedRefusal.body.code, 'S8_HANDOFF_SUCCESSOR_DOMAIN_OR_ENVELOPE');
        const handoffId = 'physical-policy-handoff', handoffRequest = requestHandoff(successorTarget), handoff = success(await command('promoter', 'HANDOFF', handoffRequest, handoffId));
        assert.deepEqual(success(await command('promoter', 'HANDOFF', handoffRequest, handoffId)), handoff);
        const stoppedWriter = await command('consumer', 'RECONCILE', { useId: lease.useId, outcome: 'UNKNOWN', evidenceRef: unknown.created.record.ref, priorEvidenceRef: verified.created.record.ref }); assert.equal(stoppedWriter.body.code, 'S8_RUNTIME_RESPONSIBILITY_TRANSFERRED');
        const finalPredecessor = success(await command('reader', 'READ', {})); assert.equal(finalPredecessor.responsibilityContinuity.transferred, true); assert.deepEqual(finalPredecessor.accounting, afterPhysical.accounting);
        const oldConfig = JSON.parse(await readFile(service.configPath, 'utf8')), successorPolicy = { ...successorTarget, responsibilityHandoff: { reference: handoff.ref, previousSignedPolicy: oldConfig.signedPolicy, previousReleaseRoot: service.pub('release') } };
        const successorConfigPath = join(service.root, 'successor-config.json'), writeSuccessor = async (name: string, policyBody: any) => { const path = join(service.root, name + '.json'); await writeFile(path, canonical({ ...oldConfig, directory: join(service.root, name + '-journal'), signedPolicy: service.signed(policyBody, 'release') }), { mode: 0o600 }); return path; };
        await lifecycle!.close(); lifecycle = null;
        const omittedHandoff = await writeSuccessor('omitted-handoff', successorTarget); await assert.rejects(() => CapabilityEvolution.open(omittedHandoff, service.pub('release')), (error: any) => error.code === 'S8_POLICY_RESPONSIBILITY_HANDOFF_REQUIRED');
        const changedTarget = await writeSuccessor('changed-target', { ...successorPolicy, maxTotalCost: 102 }); await assert.rejects(() => CapabilityEvolution.open(changedTarget, service.pub('release')), (error: any) => error.code === 'S8_HANDOFF_TARGET_OR_IDENTITY_SUBSTITUTION');
        const foreignTarget = await writeSuccessor('foreign-target', { ...successorPolicy, rightsRef: 'foreign-rights' }); await assert.rejects(() => CapabilityEvolution.open(foreignTarget, service.pub('release')), (error: any) => error.code === 'S8_HANDOFF_PREDECESSOR_POLICY_OR_SCOPE_INVALID');
        await writeFile(successorConfigPath, canonical({ ...oldConfig, directory: join(service.root, 'successor-journal'), signedPolicy: service.signed(successorPolicy, 'release') }), { mode: 0o600 });
        lifecycle = await CapabilityEvolution.open(successorConfigPath, service.pub('release'));
        const inherited = success(await command('reader', 'READ', {})); assert.equal(inherited.responsibilityContinuity.inheritedHandoff.id, handoff.ref.id); assert.equal(inherited.active, null); assert.deepEqual(inherited.accounting, afterPhysical.accounting); assert.deepEqual(inherited.uses, afterPhysical.uses); assert.deepEqual(inherited.attempts, afterPhysical.attempts);
        const oldUse = await command('consumer', 'RECHECK', { useId: lease.useId, revisionRef: lease.revisionRef, inputDigest: lease.inputDigest }); assert.equal(oldUse.body.code, 'S8_REVISION_NOT_FOUND');
        const adverse = await publishOutcome({ ...outcomeBody, outcome: 'UNKNOWN' }, 'physical-later-adverse'), failed = await publishOutcome({ ...outcomeBody, outcome: 'FAILED' }, 'physical-later-failed');
        const updates = await Promise.all([command('consumer', 'RECONCILE', { useId: lease.useId, outcome: 'UNKNOWN', evidenceRef: adverse.created.record.ref, priorEvidenceRef: verified.created.record.ref }), command('consumer', 'RECONCILE', { useId: lease.useId, outcome: 'FAILED', evidenceRef: failed.created.record.ref, priorEvidenceRef: verified.created.record.ref })]); assert.equal(updates.filter(r => r.status === 200).length, 1); assert.equal(updates.find(r => r.status !== 200)!.body.code, 'S8_RECONCILIATION_PRIOR_EVIDENCE_BINDING');
        const later = success(await command('reader', 'READ', {})); assert.equal(later.uses[0].outcome, 'UNKNOWN'); assert.deepEqual(later.uses[0].effectLineage, qualified.effectLineage); assert.equal(later.uses[0].reconciliations.length, 3); assert.deepEqual(later.accounting, beforeReconciliation.accounting);
        await lifecycle!.close(); lifecycle = null;
        await writeFile(join(service.root, 'original-retired-config.json'), canonical(oldConfig), { mode: 0o600 });
        await writeFile(service.configPath, await readFile(successorConfigPath), { mode: 0o600 }); await service.start(); const restored = success(await command('reader', 'READ', {})); assert.deepEqual(restored, later);
        const historicalReplay = await command('consumer', 'RECONCILE', request, 'successor-cannot-replay-old-transition'); assert.equal(historicalReplay.body.code, 'S8_RECONCILIATION_PRIOR_EVIDENCE_BINDING'); assert.equal(context.requests.filter((r: any) => r.method === 'PATCH').length, 1);
        const result = { originalLease: lease, originalObligation: obligation.ref, unknown: unknown.created.record.ref, verified: verified.created.record.ref, qualified, updates, boundedRefusal, handoff, stoppedWriter, finalPredecessor, inherited, oldUse, historicalReplay, beforeReconciliation, afterPhysical, later, restored, physicalPatches: 1, noNewEffectOrRelease: true };
        results.push({ id: 'original-shadow-use-native-physical-h0-reconciliation-after-revocation-and-signed-policy-handoff-with-adverse-history-and-restart', status: 'PASS', observed: result }); await artifact('s8-effect-lineage.json', result); await service.stop(); return result;
    } });
    assert('history' in proof && 'qualification' in proof);
    results.push({ id: 'canonical-native-execution-lost-response-sigkill-readback-s5-settlement-and-no-duplicate-effect', status: 'PASS', observed: { requests: proof.requests, history: proof.history, sourceDigests: proof.sourceDigests, qualification: proof.qualification } });
    const after = await snapshot(); assert.deepEqual(after, before); await save({ after, finishedAt: new Date().toISOString(), database: { port: db.port, migrations: db.migrations }, status: 'PASS' }); console.log(JSON.stringify({ status: 'PASS', cases: results.length, artifact: join(out, 'results.json') }));
} catch (e: any) { results.push({ id: 'physical-reconciliation-run', status: 'FAIL', error: { message: e.message, stack: e.stack, code: e.code } }); await save({ after: await snapshot(), finishedAt: new Date().toISOString(), status: 'FAIL' }); throw e; }
finally { await (lifecycle as CapabilityEvolution | null)?.close(); await service?.stop(); await ledger?.stop(); await db.stop(); }
