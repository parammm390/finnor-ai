import { requiredCapabilitySourcePaths } from '../../packages/capability-evolution/src/source-closure';
import { createCapabilityLifecycle } from './lifecycle-fixture.mjs';
/** Preregistered real S8/S6 process contract. Disposable signatures prove mechanics. */
import { strict as assert } from 'node:assert';
import { createServer, request as httpRequest } from 'node:http';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { canonical } from '../../packages/governed-execution/src/protocol';
import { createEconomicLedger } from '../s7/ledger-fixture.mjs';
import { digest, byteDigest, makeRef, type EvaluationProtocol, type CapabilityRevisionBody, type LifecycleCost } from '../../packages/capability-evolution/src/contracts';
import { summarizeAdmission, type ScoredCase } from '../../packages/capability-evolution/src/evaluation';
import { produceAllocationCandidate } from '../../packages/epistemic-runtime/src/allocation-producer';
import { verifyCapabilityMethod, verifyCapabilityLeaseMethod } from '../../packages/capability-evolution/src/protected-method';
const out = resolve(process.env.FINNOR_S8_EVIDENCE_DIR ?? '../scope-8/scope-evidence/lifecycle-initial');
await mkdir(out, { recursive: true });
const startedAt = new Date().toISOString(), results: any[] = [], calls: any[] = [];
const sourceFiles = (await readdir('packages/capability-evolution/src')).filter(n => /\.(ts|mts)$/.test(n)).map(n => resolve('packages/capability-evolution/src', n)).concat(['packages/epistemic-runtime/src/allocation-producer.ts', 'packages/private-equity/src/enterprise-allocation.ts', 'scripts/s7/ledger-fixture.mts', 'scripts/s8/run-capability-e2e.mts', 'scripts/s8/lifecycle-fixture.mts', 'packages/epistemic-runtime/src/allocation-solver.py', 'packages/epistemic-runtime/src/allocation-checker.ts', 'packages/epistemic-runtime/src/allocation-verifier.ts', 'packages/epistemic-runtime/src/allocation-verifier-worker.mjs', 'packages/epistemic-runtime/src/allocation-contracts.ts', 'packages/epistemic-runtime/src/control-contracts.ts', 'packages/epistemic-runtime/src/source-precedence.ts', 'packages/epistemic-runtime/src/experiment-numerics.ts', 'packages/db/migrations/0148_portfolio_resource_clearing.sql', 'packages/db/migration-head.ts', 'packages/shared-types/src/allocation.ts', 'packages/private-equity/src/allocation-store.ts', 'package-lock.json'].map(p => resolve(p)));
const protectedCandidate = process.env.FINNOR_S8_PROTECTED_CANDIDATE ? resolve(process.env.FINNOR_S8_PROTECTED_CANDIDATE) : null;
let compiledSubstrate: { sourceDirectory: string; policyExtensions: Record<string, unknown> } | undefined;
if (protectedCandidate) {
    const manifestPath = join(protectedCandidate, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.status, 'UNSIGNED_NOT_INSTALLED_NOT_DEPLOYED_NOT_ADMITTED');
    for (const file of manifest.files) assert.equal(byteDigest(await readFile(join(protectedCandidate, file.path))), file.sha256);
    for (const [name, sha] of Object.entries(manifest.baseProtectedSourceDigests)) assert.equal(byteDigest(await readFile('packages/governed-execution/src/' + name)), sha);
    sourceFiles.push(manifestPath, ...manifest.files.map((file: any) => join(protectedCandidate, file.path)));
    compiledSubstrate = { sourceDirectory: join(protectedCandidate, 'install/finnor-os/packages/governed-execution/src'), policyExtensions: {} };
}
const snapshot = () => Promise.all([...new Set([...sourceFiles, ...requiredCapabilitySourcePaths])].map(async (path) => ({ path, sha256: byteDigest(await readFile(path)) }))), before = await snapshot();
const nativePath = process.env.FINNOR_S8_NATIVE_OWNER_EVIDENCE, native = nativePath ? JSON.parse(await readFile(nativePath, 'utf8')) : null;
const tenant = native?.issued.problem.tenantId ?? randomUUID(), principal = native?.issued.problem.principalId ?? randomUUID(), evaluator = randomUUID(), promoter = randomUUID(), rights = native?.issued.problem.mandate.rightsRef ?? 'generated-owner-rights';
const service = await createCapabilityLifecycle({ tenant, principal, evaluator, promoter, rightsRef: rights, sourcePins: before.filter(s => !s.path.includes('/scripts/') && (!protectedCandidate || !s.path.startsWith(protectedCandidate))), ...(compiledSubstrate ? { protectedEvents: { contract: 'S8_CAPABILITY_EVENTS_V1', maxRecoveryEvents: 64 } } : {}) });
let proxyEndpoint: string | undefined, dropAppend = false, proxyLedgerEndpoint = '';
let methodResponseMode: 'PASS' | 'PASS_THEN_REPLAY' | 'REPLAY' | 'INVALID_SIGNATURE' | 'UNADMITTED_RELEASE' = 'PASS', cachedMethodResponse = '';
const methodRequests: any[] = [], methodIssuer = generateKeyPairSync('ed25519'), methodAdmissions = new Map<string, any>();
const proxy = compiledSubstrate ? createServer((incoming, outgoing) => {
    if (dropAppend && incoming.url === '/append') { outgoing.writeHead(503, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify({ error: 'INJECTED_APPEND_OUTAGE' })); return; }
    if (incoming.url === '/verify-capability-method') {
        let bytes = '';
        incoming.on('data', b => { bytes += b; });
        incoming.on('end', () => {
            const input = JSON.parse(bytes), observed = { revisionRef: input.revisionRef, nonce: input.nonce, mode: methodResponseMode, requestDigest: digest(input), responseNonce: null as string | null, status: 0 };
            methodRequests.push(observed);
            const reply = (status: number, body: string) => {
                const parsed = JSON.parse(body); observed.status = status; observed.responseNonce = parsed.assessment?.nonce ?? null;
                outgoing.writeHead(status, { 'content-type': 'application/json' }); outgoing.end(body);
            };
            if (methodResponseMode === 'REPLAY') { reply(200, cachedMethodResponse); return; }
            const target = httpRequest(proxyLedgerEndpoint + incoming.url, { method: incoming.method, headers: incoming.headers }, response => {
                let received = ''; response.on('data', b => { received += b; }); response.on('end', () => {
                    if (response.statusCode === 200) {
                        cachedMethodResponse = received;
                        if (methodResponseMode === 'PASS_THEN_REPLAY') methodResponseMode = 'REPLAY';
                        else if (methodResponseMode !== 'PASS') {
                            const changed = JSON.parse(received);
                            if (methodResponseMode === 'INVALID_SIGNATURE') changed.assessment.signature = Buffer.alloc(64).toString('base64');
                            else changed.assessment.releaseId = 'unadmitted-response-release';
                            received = canonical(changed);
                        }
                    }
                    reply(response.statusCode!, received);
                });
            });
            target.on('error', () => reply(503, canonical({ error: 'INJECTED_LEDGER_OUTAGE' }))); target.end(bytes);
        });
        return;
    }
    const target = httpRequest(proxyLedgerEndpoint + incoming.url, { method: incoming.method, headers: incoming.headers }, response => { outgoing.writeHead(response.statusCode!, response.headers); response.pipe(outgoing); });
    target.on('error', () => { outgoing.writeHead(503, { 'content-type': 'application/json' }); outgoing.end(JSON.stringify({ error: 'INJECTED_LEDGER_OUTAGE' })); });
    incoming.pipe(target);
}) : null;
if (proxy) { await new Promise<void>(ok => proxy.listen(0, '127.0.0.1', ok)); proxyEndpoint = 'http://127.0.0.1:' + (proxy.address() as any).port; }
if (compiledSubstrate) compiledSubstrate.policyExtensions = { capabilityRevisionContract: 'S8_CAPABILITY_EVENTS_V1', capabilityJournalKeys: [{ policyDigest: digest(service.policy), tenantId: tenant, principalId: principal, rightsRef: rights, publicKey: service.pub('journal'), validAfter: service.after, validUntil: service.until, revoked: false }], capabilityMethodContract: 'S5_FINITE_ALLOCATION_V1', methodAdmissionPublicKey: methodIssuer.publicKey.export({ type: 'spki', format: 'pem' }).toString(), capabilityEvaluatorKeys: service.policy.evaluatorKeys, capabilitySourcePins: service.policy.sourcePins };
const ledger = await createEconomicLedger(tenant, principal, randomUUID(), { capabilityLifecycle: true, sealedEvaluation: true, financialPrincipal: evaluator, rightsRef: rights, ...(compiledSubstrate ? { compiledSubstrate, transportEndpoint: proxyEndpoint } : {}) });
proxyLedgerEndpoint = ledger.endpoint();
const { root, keys, pub, signed, tokens, after, until, policy, start, stop } = service;
let endpoint = '';
async function boot() { await start(); endpoint = service.endpoint(); }
async function call(role: string, operation: string, body: any, requestId = operation + ':' + randomUUID()) { const response = await fetch(endpoint + '/command', { method: 'POST', headers: { authorization: 'Bearer ' + tokens[role], 'content-type': 'application/json' }, body: canonical({ requestId, operation, body }), signal: AbortSignal.timeout(10000) }), result = { status: response.status, body: await response.json() as any }; calls.push({ role, operation, requestId, status: result.status, code: result.body.code ?? null }); return result; }
const success = (r: any) => { assert.equal(r.status, 200, JSON.stringify(r)); return r.body; };
async function save() { await writeFile(join(out, 'results.json'), JSON.stringify({ schema: 'finnor.s8.lifecycle-e2e.v1', startedAt, results, calls, methodRequests, before, node: process.version, qualification: 'DISPOSABLE_TEST_AUTHORITY_S6_AND_S8_PROCESSES_SOFTWARE_CONDITIONAL_SIGNATURE_MECHANICS_ONLY; GENERATED_SCORING_CONTROLS_NOT_INDEPENDENT_FIELD_ADMISSION', rerun: 'FINNOR_S8_PROTECTED_CANDIDATE=<optional-review-dir> FINNOR_S8_NATIVE_OWNER_EVIDENCE=<optional-fresh-S5-owner-file> FINNOR_S8_EVIDENCE_DIR=<fresh-dir> node --import=tsx scripts/s8/run-capability-e2e.mts' }, null, 2) + '\n'); }
async function challenge(id: string, fn: () => Promise<any>) {
    try {
        results.push({ id, status: 'PASS', observed: await fn() });
    }
    catch (error) {
        results.push({ id, status: 'FAIL', error: String(error) });
    }
    console.log(JSON.stringify({ id, status: results.at(-1).status, error: results.at(-1).error }));
    await save();
}
const experienceBody = { schema: 'finnor.s7.generated-experience.v1', tenantId: tenant, principalId: principal, knowledgeAt: new Date(Date.now() - 30000).toISOString(), cases: [{ outcome: 'FAILED', cost: 2 }, { outcome: 'DECLINED', cost: 1 }, { outcome: 'UNKNOWN', cost: null }, { outcome: 'CENSORED', cost: 3 }, { outcome: 'HUMAN_CORRECTION', cost: 1 }], qualification: 'GENERATED_NO_CAUSAL_CREDIT' }, experienceRef = { owner: 'S7', id: 'generated-experience:' + digest(experienceBody), version: 'generated-v1', contentDigest: digest(experienceBody) };
const allocationBody = native ? (({ ref, ...body }: any) => body)(native.issued.certificate) : { schema: 'finnor.allocation-certificate.v1', tenantId: tenant, principalId: principal, validUntil: until, qualification: 'GENERATED_S5_ENVELOPE_CONTROL_NO_NATIVE_RESERVATION' }, allocationRef = native?.issued.certificate.ref ?? { owner: 'S5', id: 'generated-allocation:' + digest(allocationBody), version: 'generated-v1', contentDigest: digest(allocationBody) };
await ledger.publish({ ...experienceRef, content: experienceBody });
await ledger.publish({ ...allocationRef, content: allocationBody });
function revision(algorithm: 'ENUMERATE_EXACT' | 'BRANCH_BOUND_EXACT', parents: any[] = []) { const body: CapabilityRevisionBody = { schema: 'finnor.capability-revision.v1', tenantId: tenant, principalId: principal, episodeId: 's8-lifecycle-software-control', parents, owningInterface: 's5-joint-finite-v1', payload: { schema: 'finnor.s8.allocation-method.v1', algorithm, order: 'VALUE_IMPACT', incumbent: 'EMPTY_THEN_SEARCH', maxPolicies: 8, maximumNodes: 511 }, dependencies: policy.sourcePins, runtime: { node: process.version, platform: process.platform, architecture: process.arch }, experience: { refs: [experienceRef], knowledgeCut: new Date().toISOString(), trainingCompanies: ['training-company'], dependenceGroups: ['training-group'], qualification: 'AUTHENTICATED_OWNER_HISTORY_NO_CAUSAL_REWARD_ASSUMED' }, intendedImprovement: 'Exact reusable objective bound under fixed allocation search resources; improvement requires independent evaluation', domain: { owner: 'S5', interface: 's5-joint-finite-v1', maxPolicies: 8, maxPeriods: 8, maxScenarios: 8, strata: ['coupled', 'prior-regime'], rightsRef: ledger.rights, validAfter: after, validUntil: until }, envelope: { maxAttempts: 8, maxNodes: 511, maxWallMs: 30000, maxHumanSeconds: 900, maxCost: 10, maxDecisionLoss: 5, maxUses: 20 }, proposedAt: new Date().toISOString() }; return { ...body, ref: makeRef('capability-revision', body) }; }
const base = revision('ENUMERATE_EXACT');
let first: any, next: any, firstUse: any;
const firstUseRequestId = 'first-pinned-use:' + randomUUID();
let nativeExtraUses = 0;
await writeFile(join(out, 'ordinary-input.json'), JSON.stringify({ base, experienceRef, allocationRef, sourcePins: policy.sourcePins }, null, 2) + '\n');
const costs: LifecycleCost = { search: [0, 0], training: [0, 0], evaluation: [0, 0], human: [0, 0], computeData: [0, 0], integration: [0, 0], maintenance: [0, 0], recovery: [0, 0], deployment: [0, 0], costRefs: [], currency: 'USD', basis: 'REGISTERED_GENERATIVE_MODEL' };
async function costEvidence(attempts: any[]) {
    const costRefs = [];
    for (const attempt of attempts) {
        const content = { schema: 'finnor.s8.independent-attempt-cost.v1', tenantId: tenant, episodeId: attempt.episodeId, currency: 'USD', attemptId: attempt.attemptId, amount: [1, 1], basis: 'REGISTERED_GENERATIVE_MODEL', knowledgeAt: new Date().toISOString() }, ref = { owner: 'FINANCIAL_SOURCE', id: 'generated-attempt-cost:' + digest(content), version: 'generated-cost-v1', contentDigest: digest(content) };
        await ledger.publish({ ...ref, content });
        costRefs.push(ref);
    }
    for (const category of ['search', 'training', 'evaluation', 'human', 'computeData', 'integration', 'maintenance', 'recovery', 'deployment']) {
        const content = { schema: 'finnor.s8.independent-lifecycle-cost.v1', tenantId: tenant, episodeId: attempts[0].episodeId, currency: 'USD', category, amount: category === 'search' ? [attempts.length, attempts.length] : [0, 0], basis: 'REGISTERED_GENERATIVE_MODEL', knowledgeAt: new Date().toISOString() }, ref = { owner: 'FINANCIAL_SOURCE', id: 'generated-lifecycle-cost:' + digest(content), version: 'generated-cost-v1', contentDigest: digest(content) };
        await ledger.publish({ ...ref, content });
        costRefs.push(ref);
    }
    return { ...costs, search: [attempts.length, attempts.length] as [
            number,
            number
        ], costRefs };
}
function protocol(r: any, wave: string) { const groups = Array.from({ length: 1024 }, (_, i) => wave + ':group:' + i), companies = groups.map(g => g + ':company'), commitments = groups.map(g => digest({ g, wave })); const p: EvaluationProtocol = { schema: 'finnor.s8.evaluation-protocol.v1', tenantId: tenant, principalId: principal, revisionRef: r.ref, evaluatorId: evaluator, registeredAt: new Date().toISOString(), trainingCutoff: r.experience.knowledgeCut, domain: r.domain, caseCommitments: commitments, companies, dependenceGroups: groups, chronologicalStart: new Date(Date.parse(r.experience.knowledgeCut) + 1).toISOString(), chronologicalEnd: new Date().toISOString(), strata: r.domain.strata, priorDomains: ['prior-regime'], baselines: ['INCUMBENT', 'STRONG_FIXED', 'INDEPENDENT_EVOLUTION'].map(kind => ({ id: kind, kind: kind as any, payloadDigest: digest(kind), dependencyDigest: digest(policy.sourcePins), resourceEnvelopeDigest: digest(r.envelope) })), scoringAssetsDigest: digest('generated-signature-control'), harnessDigest: digest(before), splitDigest: digest(groups), oracle: 'EXACT_CANONICAL_REFERENCE', materialGain: 0.1, scoreRange: 12, confidence: 0.95, maxSubmissions: 8, maxWaves: 4, minIndependentGroups: 1024, floors: { correctness: 0.95, regret: 0.05, calibrationError: 0.02, safetyViolations: 0, maxEpisodeCost: 100, maxHumanSeconds: 900 }, feedback: 'FINAL_AGGREGATE_ONLY_ONE_USE', horizon: 'H1', costAllocation: 'COMPLETE_INCURRED_COST_NO_SPECULATIVE_REUSE' }; return p; }
async function attempt(r: any, status = 'SUCCEEDED') { return success(await call('proposer', 'ATTEMPT', { revisionRef: r.ref, kind: status === 'FAILED' ? 'FAILURE' : 'SEARCH', status, reservedCost: 1, actualCost: status === 'FAILED' ? null : 1, allocationRef, modelIdentity: null, modelComputeRef: null, outputDigest: digest(r.payload), error: status === 'FAILED' ? 'CONTROL_RETAINED_FAILURE' : null })); }
function controlRows(p: EvaluationProtocol): ScoredCase[] {
    const metrics = { correctness: 1, regret: 0, calibrationError: 0, safetyViolations: 0, episodeCost: 0, humanSeconds: 0, decisionValue: [10, 10] as [
            number,
            number
        ] }, rows: ScoredCase[] = p.caseCommitments.map((c, i) => ({ caseCommitment: c, company: p.companies[i]!, dependenceGroup: p.dependenceGroups[i]!, stratum: i % 2 ? 'prior-regime' : 'coupled', priorDomain: i % 2 ? 'prior-regime' : null, candidate: metrics, baselines: Object.fromEntries(p.baselines.map(b => [b.id, { ...metrics, decisionValue: [0, 0] }])), failure: null }));
    return rows;
}
async function admit(r: any, wave: string) {
    await attempt(r);
    const p = protocol(r, wave), registered = success(await call('evaluator', 'REGISTER', signed(p, 'evaluator'))), read = success(await call('reader', 'READ', {})), attempts = read.attempts.filter((a: any) => a.episodeId === r.episodeId);
    const rows = controlRows(p);
    const admittedCosts = await costEvidence(attempts);
    const report = summarizeAdmission(p, rows, admittedCosts, digest(attempts), attempts.filter((a: any) => a.status === 'FAILED').length);
    const observedBillingControl = summarizeAdmission(p, rows, { ...admittedCosts, basis: 'OBSERVED_COMPLETE' }, digest(attempts), attempts.filter((a: any) => a.status === 'FAILED').length);
    assert.equal(observedBillingControl.qualification, 'GENERATIVE_H1');
    assert.deepEqual(observedBillingControl.gain, report.gain);
    assert.equal(report.disposition, 'BENEFICIAL');
    const evaluated = success(await call('evaluator', 'EVALUATE', signed(report, 'evaluator'))), body = { revisionRef: r.ref, evaluationRef: evaluated.ref, payloadDigest: digest(r.payload), dependencyDigest: digest(r.dependencies), domain: r.domain, executionAuthorityGranted: false, horizon: 'H1', evaluatorId: evaluator };
    const substitution = await call('evaluator', 'ADMIT', signed({ ...body, payloadDigest: digest('unscored-payload') }, 'evaluator'));
    assert.equal(substitution.body.code, 'S8_ADMISSION_BINDING_OR_GAIN_INVALID');
    const admitted = success(await call('evaluator', 'ADMIT', signed(body, 'evaluator')));
    if (compiledSubstrate) enrollMethod(r, evaluated.ref, admitted.ref);
    return { r, p, report, observedBillingControl, registered, evaluated, substitution, admitted, qualification: 'GENERATED_AUTHORITY_CONTROL_NOT_METHOD_BENEFIT_EVIDENCE' };
}
function enrollMethod(r: any, evaluationRef: any, admissionRef: any) {
    const body = { schema: 'finnor.s8.s5-method-admission.v1', domain: policy.domain, tenantId: tenant, principalId: principal, rightsRef: rights, revisionRef: r.ref, evaluationRef, admissionRef, payloadDigest: digest(r.payload), dependencyDigest: digest(r.dependencies), runtimeDigest: digest(r.runtime), validityDomainDigest: digest(r.domain), resourceEnvelopeDigest: digest(r.envelope), validAfter: r.domain.validAfter, validUntil: r.domain.validUntil, executionAuthorityGranted: false };
    methodAdmissions.set(r.ref.id, { body, signature: sign(null, Buffer.from(canonical(body)), methodIssuer.privateKey).toString('base64') });
}
async function activate(admitted: any, generation: number, predecessor: any, mode = 'SHADOW') { return call('promoter', 'ACTIVATE', signed({ revisionRef: admitted.r.ref, expectedGeneration: generation, predecessorRef: predecessor, mode, maxDecisionLoss: 0, maxCost: 10, maxUses: 20, validUntil: until, evidenceRefs: [], ...(compiledSubstrate ? { methodAdmission: methodAdmissions.get(admitted.r.ref.id) } : {}) }, 'promoter')); }
function useBody() { return { tenantId: tenant, principalId: principal, rightsRef: ledger.rights, owner: 'S5', interface: 's5-joint-finite-v1', stratum: 'coupled', policyCount: 3, periods: 2, scenarios: 1, inputDigest: digest('ordinary-allocation-input'), reservedCost: 1, maxDecisionLoss: 0 }; }
try {
    await boot();
    if (compiledSubstrate) await challenge('actual-lifecycle-protected-genesis-exact-independent-readback', async () => {
        const read = success(await call('reader', 'READ', {})); assert.equal(read.protectedHistory.publishedSequence, 0);
        const accepted = await ledger.readCapabilityEvent(read.protectedHistory.eventId); assert.equal(accepted.status, 200);
        assert.deepEqual(accepted.body.receipt, read.protectedHistory.receipt); assert.equal(accepted.body.event.detail.entrySequence, 0);
        return { protectedHistory: read.protectedHistory, accepted, productionProtectedRelease: false };
    });
    await challenge('real-sealed-evaluator-role-denial-and-authorized-readback', async () => { const content = { schema: 'registered-sealed-control', answers: ['PRIVATE_TARGET_CONTROL'], seed: randomUUID() }, ref = { owner: 'S7', id: 'sealed:' + digest(content), version: 'test-sealed-v1', contentDigest: digest(content) }; await ledger.sealed!.publish({ ...ref, content }); const denied = await ledger.sealed!.read(ref.id, false), accepted = await ledger.sealed!.read(ref.id, true); assert.equal(denied.status, 403); assert.equal(denied.body.error, 'EVALUATOR_OR_RIGHTS_NOT_AUTHORIZED'); assert.equal(accepted.status, 200); assert.equal(digest(accepted.body.reference.content), ref.contentDigest); return { ref, denied, authorizedContentDigest: digest(accepted.body.reference.content), sealedPayloadNotPublished: true, productionOSIsolationEstablished: false }; });
    await challenge('content-identity-rights-hindsight-and-proposer-self-grading', async () => { const substitution = structuredClone(base); substitution.payload.maximumNodes--; const changed = await call('proposer', 'PROPOSE', substitution); assert.equal(changed.body.code, 'REVISION_CONTENT_IDENTITY_MISMATCH'); const proposed = success(await call('proposer', 'PROPOSE', base)); const self = await call('proposer', 'EVALUATE', {}); assert.equal(self.status, 403); assert.equal(self.body.code, 'S8_OPERATION_NOT_AUTHORIZED'); const evil = revision('ENUMERATE_EXACT'); evil.tenantId = randomUUID(); const { ref, ...body } = evil; evil.ref = makeRef('capability-revision', body); const cross = await call('proposer', 'PROPOSE', evil); assert.equal(cross.body.code, 'S8_TENANT_OR_OWNER_MISMATCH'); const hindsight = revision('ENUMERATE_EXACT'), { ref: ignored, ...past } = hindsight; past.experience.knowledgeCut = new Date(Date.now() - 60000).toISOString(); const hindsightDenied = await call('proposer', 'PROPOSE', { ...past, ref: makeRef('capability-revision', past) }); assert.equal(hindsightDenied.body.code, 'S8_HINDSIGHT_EXPERIENCE'); return { proposed: proposed.ref, changed, self, cross, hindsightDenied, experienceStatuses: experienceBody.cases.map(c => c.outcome) }; });
    await challenge('preregistered-shadow-admission-and-physical-history', async () => { first = await admit(base, 'wave-one'); const live = await activate(first, 0, null, 'CANARY'); assert.equal(live.body.code, 'S8_ACTIVATION_ENVELOPE_OR_EVIDENCE_INVALID'); const activated = success(await activate(first, 0, null)); firstUse = success(await call('consumer', 'USE', useBody(), firstUseRequestId)); assert.equal(firstUse.lease.revisionRef.id, base.ref.id); assert.equal(firstUse.lease.mode, 'SHADOW'); return { report: first.report, observedBillingDoesNotQualifyProspectiveValue: first.observedBillingControl, activated, firstUse, liveDenied: live, qualification: first.qualification }; });
    if (native)
        await challenge('actual-s5-producer-invokes-pinned-shadow-payload', async () => {
            const tokenPath = join(root, 'consumer.token'), consumerPath = join(root, 'consumer.json');
            await writeFile(tokenPath, tokens.consumer!, { mode: 0o600 });
            const config = { schema: 'finnor.s8.consumer-policy.v1', domain: 'DISPOSABLE_TEST_AUTHORITY', tenantId: tenant, principalId: principal, rightsRef: ledger.rights, endpoint, tokenPath, tokenHash: byteDigest(tokens.consumer!), stratum: 'coupled', reservedCost: 0, maxDecisionLoss: 0, validAfter: after, validUntil: until, timeoutMs: 5000 };
            await writeFile(consumerPath, canonical(signed(config, 'release')), { mode: 0o600 });
            process.env.FINNOR_S8_CONSUMER_CONFIG = consumerPath;
            process.env.FINNOR_S8_CONSUMER_ROOT = pub('release');
            try {
                const produced = await produceAllocationCandidate(native.issued.problem, performance.now() + 30000);
                assert.equal(produced.status, 'FEASIBLE');
                assert.deepEqual(produced.selectedPolicyIds!.sort(), native.issued.certificate.check.selectedPolicyIds.slice().sort());
                const lease = produced.compute.usage.backend.capabilityLease as any, shadow = produced.compute.usage.backend.capabilityShadow as any;
                assert.equal(lease.revisionRef.id, base.ref.id);
                assert.equal(lease.mode, 'SHADOW');
                assert.equal(shadow.objective, '32');
                assert.equal(shadow.complete, true);
                assert.equal((produced.compute.usage.backend.capabilityShadowCurrentness as any).current, true);
                if (compiledSubstrate) assert.deepEqual(lease.methodAdmission, methodAdmissions.get(base.ref.id));
                nativeExtraUses++;
                await writeFile(join(out, 'actual-s5-shadow.json'), JSON.stringify({ nativeSourceEvidence: nativePath, nativeProblemRef: native.issued.problem.ref, originalCertificateRef: native.issued.certificate.ref, produced, qualification: 'ACTUAL_S5_PRODUCER_CURRENT_NATIVE_GENERATED_INPUT_SHADOW; NO_S8_INFLUENCE_ON_REAL_ALLOCATION' }, null, 2) + '\n');
                return { artifact: 'actual-s5-shadow.json', leaseRef: lease.revisionRef, shadowObjective: shadow.objective, incumbentPreserved: true };
            }
            finally {
                delete process.env.FINNOR_S8_CONSUMER_CONFIG;
                delete process.env.FINNOR_S8_CONSUMER_ROOT;
            }
        });
    if (compiledSubstrate) await challenge('fresh-method-client-proof-and-genuine-response-replay-denial', async () => {
        const method = methodAdmissions.get(base.ref.id), verifyMethod = () => verifyCapabilityMethod({ revision: base, evaluationRef: first.evaluated.ref, admissionRef: first.admitted.ref, methodAdmission: method, protectionDomain: 'DISPOSABLE_TEST_AUTHORITY' });
        const verifyLease = () => verifyCapabilityLeaseMethod({ tenantId: tenant, principalId: principal, rightsRef: rights, protectionDomain: 'DISPOSABLE_TEST_AUTHORITY', lease: firstUse.lease });
        const positive = await verifyLease(), beforeReplay = success(await call('reader', 'READ', {})), denials = [];
        assert.equal(positive.executionAuthorityGranted, false);
        const malformedMethod = { ...method, signature: Buffer.alloc(64).toString('base64') };
        const forged = await call('promoter', 'ACTIVATE', signed({ revisionRef: base.ref, expectedGeneration: 1, predecessorRef: base.ref, mode: 'SHADOW', maxDecisionLoss: 0, maxCost: 10, maxUses: 20, validUntil: until, evidenceRefs: [], methodAdmission: malformedMethod }, 'promoter'));
        assert.equal(forged.body.code, 'INDEPENDENT_CAPABILITY_METHOD_SIGNATURE_INVALID');
        try {
            methodResponseMode = 'REPLAY';
            for (const [operation, body, requestId] of [
                ['USE', useBody(), 'replayed-proof-new-use:' + randomUUID()],
                ['USE', useBody(), firstUseRequestId],
                ['RECHECK', { useId: firstUse.lease.useId, inputDigest: firstUse.lease.inputDigest, revisionRef: base.ref }, 'replayed-proof-recheck:' + randomUUID()]
            ] as const) {
                const denied = await call('consumer', operation, body, requestId); assert.equal(denied.body.code, 'CAPABILITY_METHOD_RESPONSE_BINDING_INVALID'); denials.push({ operation, requestId, denied });
            }
            await assert.rejects(verifyLease, /CAPABILITY_METHOD_RESPONSE_BINDING_INVALID/);
            methodResponseMode = 'INVALID_SIGNATURE'; await assert.rejects(verifyMethod, /CAPABILITY_METHOD_RESPONSE_SIGNATURE_INVALID/);
            methodResponseMode = 'UNADMITTED_RELEASE'; await assert.rejects(verifyMethod, /CAPABILITY_METHOD_RELEASE_UNADMITTED/);
        } finally { methodResponseMode = 'PASS'; }
        const afterReplay = success(await call('reader', 'READ', {}));
        assert.deepEqual(afterReplay.accounting, beforeReplay.accounting); assert.equal(afterReplay.page.sequence, beforeReplay.page.sequence); assert.equal(afterReplay.generation, beforeReplay.generation);
        const retry = success(await call('consumer', 'USE', useBody(), firstUseRequestId)); assert.deepEqual(retry, firstUse);
        let actualConsumerDenial: any = null;
        if (native) {
            process.env.FINNOR_S8_CONSUMER_CONFIG = join(root, 'consumer.json'); process.env.FINNOR_S8_CONSUMER_ROOT = pub('release');
            try {
                methodResponseMode = 'PASS_THEN_REPLAY';
                const produced = await produceAllocationCandidate(native.issued.problem, performance.now() + 30000);
                assert.equal(produced.status, 'NUMERICAL_FAILURE'); assert(produced.reasons.includes('CAPABILITY_METHOD_RESPONSE_BINDING_INVALID')); assert.equal(produced.compute.actualRoute, 'NOT_INVOKED'); assert.equal(produced.selectedPolicyIds, null);
                nativeExtraUses++;
                methodResponseMode = 'PASS';
                const retained = success(await call('reader', 'READ', {}));
                assert.equal(retained.accounting.useCount, afterReplay.accounting.useCount + 1); assert.deepEqual(retained.accounting.totalCost, afterReplay.accounting.totalCost); assert.equal(retained.uses.at(-1).status, 'PINNED_PENDING');
                actualConsumerDenial = { produced, retainedAccounting: retained.accounting, retainedUse: retained.uses.at(-1), consequenceNotInvoked: true };
            } finally { methodResponseMode = 'PASS'; delete process.env.FINNOR_S8_CONSUMER_CONFIG; delete process.env.FINNOR_S8_CONSUMER_ROOT; }
        }
        return { positive, forged, denials, beforeAccounting: beforeReplay.accounting, afterAccounting: afterReplay.accounting, retry, actualConsumerDenial, independentReadOnlyTransport: true, qualification: 'REAL_SIGNED_S6_PROOF_AND_ACTUAL_CONSUMER_MECHANICS_ONLY_NOT_INDEPENDENT_GAIN_OR_FIELD_CANARY' };
    });
    await challenge('cost-failure-accounting-frozen-search-and-spent-holdout', async () => { const r = revision('BRANCH_BOUND_EXACT', [base.ref]); success(await call('proposer', 'PROPOSE', r)); await attempt(r, 'FAILED'); await attempt(r); const reused = { ...first.p, revisionRef: r.ref, registeredAt: new Date().toISOString() }; const denied = await call('evaluator', 'REGISTER', signed(reused, 'evaluator')); assert.equal(denied.body.code, 'S8_PREREGISTRATION_SPLIT_OR_BASELINE_INVALID'); const read = success(await call('reader', 'READ', {})); assert.equal(read.attempts.filter((v: any) => v.status === 'FAILED').length, 1); assert.equal(read.accounting.totalCost, 4); next = { r }; return { denied, accounting: read.accounting, failedAttempts: read.attempts.filter((a: any) => a.status === 'FAILED') }; });
    await challenge('competing-activation-revocation-rollback-retained-liability', async () => {
        assert(next);
        const r = next.r;
        const p = protocol(r, 'wave-two'), registered = success(await call('evaluator', 'REGISTER', signed(p, 'evaluator'))), read = success(await call('reader', 'READ', {})), attempts = read.attempts.filter((v: any) => v.episodeId === r.episodeId);
        const resolvedCosts = await costEvidence(attempts);
        const report = summarizeAdmission(p, controlRows(p), resolvedCosts, digest(attempts), 1);
        assert.equal(report.disposition, 'BENEFICIAL');
        const attacks = [{ report, signer: 'promoter', expected: 'INDEPENDENT_SIGNATURE_OR_AUTHORITY_INVALID' }, { report: { ...report, failedCandidates: 0 }, signer: 'evaluator', expected: 'S8_SUPPRESSED_FAILED_SEARCH' }, { report: { ...report, costs: { ...report.costs, costRefs: report.costs.costRefs.filter((ref: any, i: number) => i !== 1) } }, signer: 'evaluator', expected: 'S8_OMITTED_FAILED_OR_UNKNOWN_SEARCH_COST' }, { report: { ...report, costs: { ...report.costs, maintenance: null } }, signer: 'evaluator', expected: 'S8_UNSOURCED_LIFECYCLE_COST_CATEGORY' }, { report: { ...report, gain: [0, 0] }, signer: 'evaluator', expected: 'S8_FALSE_FUTURE_GAIN' }], denials = [];
        for (const attack of attacks) {
            const denied = await call('evaluator', 'EVALUATE', signed(attack.report, attack.signer));
            assert.equal(denied.body.code, attack.expected);
            denials.push(denied);
        }
        success(await call('evaluator', 'EVALUATE', signed(report, 'evaluator')));
        const admissionResult = success(await call('evaluator', 'ADMIT', signed({ revisionRef: r.ref, evaluationRef: makeRef('capability-evaluation', report), payloadDigest: digest(r.payload), dependencyDigest: digest(r.dependencies), domain: r.domain, executionAuthorityGranted: false, horizon: 'H1', evaluatorId: evaluator }, 'evaluator')));
        if (compiledSubstrate) enrollMethod(r, makeRef('capability-evaluation', report), admissionResult.ref);
        const requests = await Promise.all(Array.from({ length: 8 }, () => activate({ r }, 1, base.ref)));
        assert.equal(requests.filter(v => v.status === 200).length, 1);
        assert(requests.some(v => v.body.code === 'S8_QUEUE_BOUND'));
        const oversized = await call('consumer', 'USE', { ...useBody(), reservedCost: 11 });
        assert.equal(oversized.body.code, 'S8_CUMULATIVE_CANARY_LOSS_OR_RESOURCE_BOUND');
        const outOfDomain = await call('consumer', 'USE', { ...useBody(), policyCount: 9 });
        assert.equal(outOfDomain.body.code, 'S8_USE_DOMAIN_OR_RIGHTS_INVALID');
        const selfRollback = await call('promoter', 'REVOKE', signed({ revisionRef: r.ref, expectedGeneration: 2, predecessorRef: r.ref, reason: 'INVALID_SELF_PREDECESSOR' }, 'promoter'));
        assert.equal(selfRollback.body.code, 'S8_ROLLBACK_PREDECESSOR_LINEAGE_INVALID');
        const nextUse = success(await call('consumer', 'USE', useBody()));
        let rollbackProofDenied: any = null;
        if (compiledSubstrate) {
            try {
                methodResponseMode = 'REPLAY';
                rollbackProofDenied = await call('promoter', 'REVOKE', signed({ revisionRef: r.ref, expectedGeneration: 2, predecessorRef: base.ref, reason: 'STALE_PROOF_CANNOT_RESTORE' }, 'promoter'));
                assert.equal(rollbackProofDenied.body.code, 'CAPABILITY_METHOD_RESPONSE_BINDING_INVALID');
                assert.equal(success(await call('reader', 'READ', {})).generation, 2);
            } finally { methodResponseMode = 'PASS'; }
        }
        const revoked = success(await call('promoter', 'REVOKE', signed({ revisionRef: r.ref, expectedGeneration: 2, predecessorRef: base.ref, reason: 'REGISTERED_ADVERSE_EVIDENCE_CONTROL' }, 'promoter')));
        const stale = await call('consumer', 'RECHECK', { useId: nextUse.lease.useId, inputDigest: nextUse.lease.inputDigest, revisionRef: r.ref });
        assert.equal(stale.body.code, 'S8_REVISION_UNADMITTED_REVOKED_OR_EXPIRED');
        const restored = success(await call('consumer', 'USE', useBody()));
        assert.equal(restored.lease.revisionRef.id, base.ref.id);
        let nativeRestoration: any = null;
        if (native) {
            process.env.FINNOR_S8_CONSUMER_CONFIG = join(root, 'consumer.json');
            process.env.FINNOR_S8_CONSUMER_ROOT = pub('release');
            try {
                const produced = await produceAllocationCandidate(native.issued.problem, performance.now() + 30000);
                assert.equal(produced.status, 'FEASIBLE');
                const lease = produced.compute.usage.backend.capabilityLease as any, shadow = produced.compute.usage.backend.capabilityShadow as any;
                assert.equal(lease.revisionRef.id, base.ref.id);
                assert.equal(lease.generation, 3);
                assert.equal(shadow.complete, true);
                assert.equal((produced.compute.usage.backend.capabilityShadowCurrentness as any).current, true);
                assert.equal(shadow.objective, '32');
                assert.deepEqual(produced.selectedPolicyIds!.slice().sort(), native.issued.certificate.check.selectedPolicyIds.slice().sort());
                nativeExtraUses++;
                nativeRestoration = { produced, qualifiedPredecessorRef: base.ref, revokedRevisionRef: r.ref, qualification: 'ACTUAL_NATIVE_S5_PRODUCER_USES_RESTORED_PINNED_SHADOW; IRREVERSIBLE_FIELD_EFFECTS_NOT_TESTED' };
                await writeFile(join(out, 'actual-s5-restored-shadow.json'), JSON.stringify(nativeRestoration, null, 2) + '\n');
            }
            finally {
                delete process.env.FINNOR_S8_CONSUMER_CONFIG;
                delete process.env.FINNOR_S8_CONSUMER_ROOT;
            }
        }
        const history = success(await call('reader', 'READ', {}));
        assert.equal(history.uses.length, 3 + nativeExtraUses);
        assert.equal(history.uses.filter((v: any) => v.status === 'PINNED_PENDING').length, 3 + nativeExtraUses);
        return { nativeRestoration, denials, oversized, outOfDomain, selfRollback, rollbackProofDenied, activationRaceStatuses: requests.map(v => v.status), revoked, stale, restored, accounting: history.accounting, uses: history.uses };
    });
    if (native)
        await challenge('sealed-independent-evaluator-process-unknown-gain-and-forgetting-rejection', async () => {
            const observed = [];
            const evaluatorKeyPath = join(root, 'evaluator.pem'), evaluatorTokenPath = join(root, 'evaluator.token');
            await writeFile(evaluatorKeyPath, keys.evaluator!.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
            await writeFile(evaluatorTokenPath, tokens.evaluator!, { mode: 0o600 });
            for (const exhausted of [false, true]) {
                const initial = revision('BRANCH_BOUND_EXACT'), { ref: ignored, ...body } = initial;
                body.episodeId = 'actual-evaluator-software-control:' + String(exhausted);
                body.envelope.maxNodes = native.issued.problem.mandate.search.maxExpansions;
                body.payload.maximumNodes = exhausted ? 1 : 511;
                const r = { ...body, ref: makeRef('capability-revision', body) };
                success(await call('proposer', 'PROPOSE', r));
                await attempt(r);
                const read = success(await call('reader', 'READ', {})), attempts = read.attempts.filter((a: any) => a.episodeId === r.episodeId);
                const metrics = { correctness: 1, regret: 0, calibrationError: 0, safetyViolations: 0, episodeCost: 0, humanSeconds: 0, decisionValue: [32, 32] as [
                        number,
                        number
                    ] };
                const cases = Array.from({ length: 4 }, (_, i) => ({ id: r.episodeId + ':case:' + i, company: r.episodeId + ':generated-control-company:' + i, dependenceGroup: r.episodeId + ':generated-control-group:' + i, knowledgeAt: new Date(Date.parse(r.experience.knowledgeCut) + 1).toISOString(), stratum: i % 2 ? 'prior-regime' : 'coupled', priorDomain: i % 2 ? 'prior-regime' : null, problem: native.issued.problem, reference: { oracleDigest: digest(native.independent ?? native.reference ?? native), optimum: '32', metrics, baselineMetrics: {} } }));
                const sourcePins = policy.sourcePins;
                const baselineMethods = [{ id: 'INCUMBENT', kind: 'FINITE_METHOD', payload: { ...base.payload, algorithm: 'ENUMERATE_EXACT', maximumNodes: body.envelope.maxNodes } }, { id: 'STRONG_FIXED', kind: 'NATIVE_S5_HIGHS', payload: null }, { id: 'INDEPENDENT_EVOLUTION', kind: 'FINITE_METHOD', payload: { ...base.payload, algorithm: 'BRANCH_BOUND_EXACT', order: 'CANONICAL', maximumNodes: body.envelope.maxNodes } }];
                const p = { ...protocol(r, 'actual-evaluator:' + String(exhausted)), caseCommitments: cases.map(digest), companies: cases.map(c => c.company), dependenceGroups: cases.map(c => c.dependenceGroup), minIndependentGroups: 2, harnessDigest: digest(sourcePins), baselines: baselineMethods.map((b, i) => ({ id: b.id, kind: ['INCUMBENT', 'STRONG_FIXED', 'INDEPENDENT_EVOLUTION'][i] as any, payloadDigest: digest(b.kind === 'FINITE_METHOD' ? b.payload : { route: 'NATIVE_S5_HIGHS', sourcePins }), dependencyDigest: digest(sourcePins), resourceEnvelopeDigest: digest(r.envelope) })) };
                const bundle = { schema: 'finnor.s8.sealed-admission-cases.v1', scoringAssetsDigest: p.scoringAssetsDigest, splitDigest: p.splitDigest, cases }, sealedCasesRef = { owner: 'S7', id: 'sealed-admission:' + digest(bundle), version: 'generated-native-software-control-v1', contentDigest: digest(bundle) };
                await ledger.sealed!.publish({ ...sealedCasesRef, content: bundle });
                const evaluatorPolicy = { schema: 'finnor.s8.evaluator-policy.v1', tenantId: tenant, principalId: principal, evaluatorId: evaluator, keyId: 'evaluator', publicKey: pub('evaluator'), keyPath: evaluatorKeyPath, serviceEndpoint: endpoint, serviceTokenPath: evaluatorTokenPath, serviceTokenHash: byteDigest(tokens.evaluator!), revision: r, protocol: p, sealedCasesRef, permittedDataIssuerIds: [principal], costs: Object.fromEntries([...Object.keys(costs).filter(k => !['costRefs', 'currency', 'basis'].includes(k)).map(k => [k, null]), ['costRefs', []], ['currency', 'USD'], ['basis', 'UNKNOWN']]), attemptsDigest: digest(attempts), failedCandidates: 0, baselines: baselineMethods, validAfter: after, validUntil: until, sourcePins };
                const evaluatorPath = join(root, 'evaluator-' + String(exhausted) + '.json');
                await writeFile(evaluatorPath, canonical(signed(evaluatorPolicy, 'release')), { mode: 0o600 });
                const execution = await new Promise<{
                    status: number | null;
                    stdout: string;
                    stderr: string;
                }>((resolve, reject) => {
                    const worker = spawn(process.execPath, ['--import=tsx', 'packages/capability-evolution/src/evaluator.mts'], { env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, FINNOR_S5_PYTHON: process.env.FINNOR_S5_PYTHON, FINNOR_S3_PYTHON: process.env.FINNOR_S3_PYTHON, FINNOR_S8_EVALUATOR_CONFIG: evaluatorPath, FINNOR_S8_EVALUATOR_ROOT: pub('release'), FINNOR_S6_OWNER_TRANSPORT_CONFIG: ledger.evaluatorTransportPath!, FINNOR_S6_OWNER_TRANSPORT_ROOT: ledger.transportRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
                    let stdout = '', stderr = '';
                    const timer = setTimeout(() => worker.kill('SIGKILL'), 90000);
                    worker.stdout!.on('data', b => {
                        stdout += b;
                        if (Buffer.byteLength(stdout) > 2 * 1024 * 1024)
                            worker.kill('SIGKILL');
                    });
                    worker.stderr!.on('data', b => {
                        stderr += b;
                        if (Buffer.byteLength(stderr) > 2 * 1024 * 1024)
                            worker.kill('SIGKILL');
                    });
                    worker.once('error', reject);
                    worker.once('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
                });
                assert.equal(execution.status, 0, execution.stderr);
                const result = JSON.parse(execution.stdout);
                assert.equal(result.report.disposition, exhausted ? 'REJECTED' : 'INCONCLUSIVE');
                assert.equal(result.report.gain, null);
                assert.equal(result.productionIndependenceEstablished, false);
                assert.equal(result.methodAdmissionGranted, false);
                assert.equal(result.report.priorDomainsPassed, !exhausted);
                assert.equal(execution.stdout.includes('"problem"'), false);
                assert.equal(execution.stdout.includes('"optimum"'), false);
                const denied = await call('evaluator', 'ADMIT', signed({ revisionRef: r.ref, evaluationRef: result.evaluationRef, payloadDigest: digest(r.payload), dependencyDigest: digest(r.dependencies), domain: r.domain, executionAuthorityGranted: false, horizon: 'H1', evaluatorId: evaluator }, 'evaluator'));
                assert.equal(denied.body.code, 'S8_ADMISSION_BINDING_OR_GAIN_INVALID');
                observed.push({ exhausted, result, admissionDenied: denied, referenceOptimum: 32, qualification: 'REAL_SEALED_ROLE_AND_WORKER_EXECUTION_ON_REPEATED_NATIVE_GENERATED_INPUT; COMPANY_LABELS_DO_NOT_ESTABLISH_INDEPENDENT_TRIALS' });
            }
            return { observed, noPositiveFutureValueClaim: true };
        });
    if (native)
        await challenge('managed-native-search-durable-start-distinct-attempts-and-crash-recovery', async () => {
            const { ref: problemRef, ...problemContent } = native.issued.problem;
            await ledger.publish({ ...problemRef, content: problemContent });
            const initial = revision('BRANCH_BOUND_EXACT'), { ref: ignored, ...body } = initial;
            body.episodeId = 'managed-search-software-control';
            const r = { ...body, ref: makeRef('capability-revision', body) };
            success(await call('proposer', 'PROPOSE', r));
            const before = success(await call('reader', 'READ', {})), input = { revisionRef: r.ref, allocationRef, problemRef, reservedCost: 1 };
            const first = success(await call('proposer', 'RUN_SEARCH', input, 'managed-completed-search'));
            assert.equal(first.result.objective, '32');
            assert.equal(first.result.complete, true);
            assert.equal(first.completion.status, 'SUCCEEDED');
            assert.equal(first.completion.actualCost, null);
            const computeRead = await ledger.call('/references/' + encodeURIComponent(first.computeRef.id));
            assert.equal(computeRead.status, 200);
            assert.equal(digest(computeRead.body.reference.content), first.computeRef.contentDigest);
            assert.equal(computeRead.body.reference.content.schema, 'finnor.model-compute-invocation.v1');
            assert.equal(computeRead.body.reference.content.semanticOwner, 'S8');
            assert.equal(computeRead.body.reference.content.cost.money, null);
            assert.equal(computeRead.body.reference.content.admission.status, 'BLOCKED_EXTERNAL');
            const retry = success(await call('proposer', 'RUN_SEARCH', input, 'managed-completed-search'));
            assert.deepEqual(retry, first);
            const pending = call('proposer', 'RUN_SEARCH', input, 'managed-interrupted-search').catch(error => ({ error: String(error) }));
            let witnessed = false;
            const deadline = Date.now() + 10000;
            while (Date.now() < deadline) {
                const history = (await readFile(join(root, 'journal/history.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
                if (history.some(e => e.operation === 'ATTEMPT' && e.result.managedRun?.requestId === 'managed-interrupted-search')) {
                    witnessed = true;
                    break;
                }
                await new Promise(ok => setTimeout(ok, 3));
            }
            assert.equal(witnessed, true, 'Pending search did not persist before execution');
            await stop();
            const interrupted = await pending;
            await boot();
            const recovered = success(await call('proposer', 'RUN_SEARCH', input, 'managed-interrupted-search'));
            assert.equal(recovered.completion.status, 'UNKNOWN');
            assert.equal(recovered.automaticRetry, false);
            assert.equal(recovered.reservationRetained, true);
            const read = success(await call('reader', 'READ', {})), attempts = read.attempts.filter((a: any) => a.episodeId === r.episodeId);
            assert.equal(attempts.length, 2);
            assert.equal(new Set(attempts.map((a: any) => a.attemptId)).size, 2);
            assert.equal(attempts[0].status, 'SUCCEEDED');
            assert.equal(attempts[1].status, 'UNKNOWN');
            assert.equal(read.accounting.totalCost, before.accounting.totalCost + 2);
            assert(attempts.every((a: any) => a.actualCost === null));
            return { problemRef, allocationRef, computeRead, first, retry, interrupted, recovered, attempts, accounting: read.accounting, qualification: 'CURRENT_NATIVE_MATHEMATICAL_CERTIFICATE_SNAPSHOT_AND_REAL_CHILD_EXECUTION; NO_PROTECTED_LIVE_ALLOCATION_OR_BILLING_CLAIM' };
        });
    await challenge('physical-sigkill-restart-idempotent-current-consumer', async () => { const body = useBody(), id = 'durable-use-retry', original = success(await call('consumer', 'USE', body, id)); await stop(); await boot(); const replay = success(await call('consumer', 'USE', body, id)); assert.deepEqual(replay, original); const changed = await call('consumer', 'USE', { ...body, inputDigest: digest('substituted') }, id); assert.equal(changed.body.code, 'S8_IDEMPOTENCY_SUBSTITUTION'); const read = success(await call('reader', 'READ', {})); assert.equal(read.active, base.ref.id); assert.equal(read.uses.length, 4 + nativeExtraUses); return { original, replay, changed, active: read.active, accounting: read.accounting, historyCount: read.history.length }; });
    await challenge('uncertain-reconciliation-preserves-signed-history-and-budget', async () => {
        const before = success(await call('reader', 'READ', {}));
        const unsupported = await call('consumer', 'RECONCILE', { useId: firstUse.lease.useId, outcome: 'VERIFIED', evidenceRef: experienceRef });
        assert.equal(unsupported.body.code, 'S8_NATIVE_S7_USE_LINEAGE_UNAVAILABLE');
        const reconciled = success(await call('consumer', 'RECONCILE', { useId: firstUse.lease.useId, outcome: 'UNKNOWN', evidenceRef: experienceRef }));
        const after = success(await call('reader', 'READ', {}));
        assert.deepEqual(after.accounting, before.accounting);
        assert.equal(after.uses.find((u: any) => u.useId === firstUse.lease.useId).status, 'RECONCILED');
        await stop();
        await boot();
        const restarted = success(await call('reader', 'READ', {}));
        assert.deepEqual(restarted.accounting, after.accounting);
        assert.equal(restarted.uses.find((u: any) => u.useId === firstUse.lease.useId).outcome, 'UNKNOWN');
        return { unsupported, reconciled, accounting: restarted.accounting, uncertainOutcomeRetained: true };
    });
    await challenge('equivalent-key-encoding-and-ambiguous-authority-identities-refuse', async () => {
        await stop(); const original = await readFile(service.configPath), denials = [];
        for (const kind of ['EQUIVALENT_KEY', 'DUPLICATE_ACTOR', 'DUPLICATE_EVALUATOR_ID']) {
            const altered = structuredClone(policy);
            if (kind === 'EQUIVALENT_KEY') altered.promotionKeys[0]!.publicKey = pub('evaluator') + '\n';
            if (kind === 'DUPLICATE_ACTOR') altered.actors[1]!.id = altered.actors[0]!.id;
            if (kind === 'DUPLICATE_EVALUATOR_ID') altered.evaluatorKeys.push({ ...altered.evaluatorKeys[0]! });
            const config = JSON.parse(original.toString()); config.signedPolicy = signed(altered, 'release');
            await writeFile(service.configPath, JSON.stringify(config), { mode: 0o600 });
            let denied = ''; try { await boot(); } catch (error) { denied = String(error); }
            assert.match(denied, kind === 'EQUIVALENT_KEY' ? /S8_AUTHORITY_NOT_SEPARATED/ : /S8_AMBIGUOUS_AUTHORITY_IDENTITY/); denials.push({ kind, denied });
        }
        await writeFile(service.configPath, original, { mode: 0o600 }); await boot();
        const read = success(await call('reader', 'READ', {})); assert.equal(read.active, base.ref.id);
        return { denials, restoredActiveRef: read.active, originalHistoryPreserved: true };
    });
    await challenge('signed-release-cannot-omit-required-loaded-search-dependency', async () => {
        await stop();
        const original = await readFile(service.configPath), config = JSON.parse(original.toString()), omitted = { ...policy, sourcePins: policy.sourcePins.filter((pin: any) => !pin.path.endsWith('/capability-evolution/src/search.ts')) };
        config.signedPolicy = signed(omitted, 'release');
        await writeFile(service.configPath, JSON.stringify(config), { mode: 0o600 });
        let code = '';
        try {
            await boot();
        }
        catch (error) {
            code = String(error);
        }
        assert.match(code, /S8_LOADED_DEPENDENCY_CLOSURE_MISSING_OR_CHANGED/);
        await writeFile(service.configPath, original, { mode: 0o600 });
        await boot();
        const read = success(await call('reader', 'READ', {}));
        assert.equal(read.active, base.ref.id);
        return { denied: 'S8_LOADED_DEPENDENCY_CLOSURE_MISSING_OR_CHANGED', activeAfterExactReleaseRestore: read.active, loadedBytesNotModified: true };
    });
    await challenge('torn-unaccepted-tail-recovers-only-against-protected-checkpoints', async () => {
        const path = join(root, 'journal/history.jsonl'), before = success(await call('reader', 'READ', {}));
        await stop();
        const original = await readFile(path), fragment = Buffer.from('{"sequence":');
        await writeFile(path, Buffer.concat([original, fragment]), { mode: 0o600 });
        await boot();
        const after = success(await call('reader', 'READ', {}));
        assert.deepEqual(after.accounting, before.accounting);
        assert.equal(after.active, before.active);
        assert.equal(after.history.at(-1).operation, 'JOURNAL_RECOVERY');
        assert(after.history.length === before.history.length + 1);
        const physical = await readFile(path, 'utf8'), entries = physical.split('\n').filter(Boolean).map(line => JSON.parse(line)), recovery = entries.at(-1);
        assert.equal(recovery.body.discardedUnacceptedTail.sha256, byteDigest(fragment));
        assert.equal(recovery.body.discardedUnacceptedTail.bytes, fragment.length);
        const protectedRead = await ledger.call('/references/' + encodeURIComponent(recovery.result.ref.id));
        assert.equal(protectedRead.status, 200);
        assert.equal(digest(protectedRead.body.reference.content), recovery.result.ref.contentDigest);
        return { recoveryRef: recovery.result.ref, protectedRead, retainedAccounting: after.accounting, active: after.active, discardedBytes: fragment.length, committedTruncationStillTestedSeparately: true };
    });
    await challenge('live-journal-tamper-and-protected-truncation-denial', async () => {
        const path = join(root, 'journal/history.jsonl'), original = await readFile(path), lines = original.toString().split('\n').filter(Boolean), truncated = lines.slice(0, -1).join('\n') + '\n';
        await writeFile(path, truncated, { mode: 0o600 });
        const live = await call('reader', 'READ', {});
        assert.equal(live.body.code, 'S8_LIVE_JOURNAL_TRUNCATION_OR_GROWTH');
        await stop();
        let denied = '';
        try {
            await boot();
        }
        catch (error) {
            denied = String(error);
        }
        assert.match(denied, /S8_JOURNAL_ROLLBACK_DETECTED/);
        await writeFile(path, original, { mode: 0o600 });
        await boot();
        const restored = success(await call('reader', 'READ', {}));
        assert.equal(restored.active, base.ref.id);
        assert.equal(restored.uses.length, 4 + nativeExtraUses);
        return { live, restartDenial: 'S8_JOURNAL_ROLLBACK_DETECTED', restoredAccounting: restored.accounting, protectedS6HistoryPreserved: true, ordinaryStorageTamperNotAnOSIsolationClaim: true };
    });
    await challenge('bounded-current-use-retention-and-consistent-paged-readback', async () => {
        const initial = success(await call('reader', 'READ', {})), current = initial.revisions.find((r: any) => r.ref.id === initial.active), used = initial.uses.filter((u: any) => u.revisionRef.id === initial.active).length;
        for (let i = used; i < current.activation.maxUses; i++)
            success(await call('consumer', 'USE', { ...useBody(), reservedCost: 0 }));
        const denied = await call('consumer', 'USE', { ...useBody(), reservedCost: 0 });
        assert.equal(denied.body.code, 'S8_CUMULATIVE_CANARY_LOSS_OR_RESOURCE_BOUND');
        const full = success(await call('reader', 'READ', {}));
        assert.equal(full.uses.filter((u: any) => u.revisionRef.id === full.active).length, current.activation.maxUses);
        let offset = 0, sequence: number | undefined;
        const seen = { history: [] as any[], attempts: [] as any[], uses: [] as any[], revisions: [] as any[] };
        do {
            const page = success(await call('reader', 'READ', { offset, limit: 7, ...(sequence !== undefined ? { atSequence: sequence } : {}) }));
            sequence ??= page.page.sequence;
            assert.equal(page.page.sequence, sequence);
            for (const key of Object.keys(seen) as Array<keyof typeof seen>) {
                assert(page[key].length <= 7);
                seen[key].push(...page[key]);
            }
            if (page.page.nextOffset === null)
                break;
            offset = page.page.nextOffset;
        } while (true);
        assert.equal(digest(seen.history), digest(full.history));
        assert.equal(digest(seen.attempts), digest(full.attempts));
        assert.equal(digest(seen.uses), digest(full.uses));
        const oldSequence = sequence!;
        success(await call('consumer', 'RECONCILE', { useId: full.uses.find((u: any) => u.status === 'PINNED_PENDING').useId, outcome: 'CENSORED', evidenceRef: experienceRef }));
        const stale = await call('reader', 'READ', { offset: 0, limit: 7, atSequence: oldSequence });
        assert.equal(stale.body.code, 'S8_READ_SNAPSHOT_CHANGED');
        return { denied, stale, counts: full.counts, sourceSequence: sequence, perRevisionUseBound: current.activation.maxUses, accounting: full.accounting, allHistoryPagesVerified: true, qualification: 'OBSERVED_DISPOSABLE_WORKLOAD_AND_ENVELOPE_BOUND; NOT_MAXIMAL_100000_ENTRY_THROUGHPUT_OR_HARD_OS_QUOTA' };
    });
    if (compiledSubstrate) await challenge('durable-transition-outbox-outage-retry-and-physical-double-restart', async () => {
        const before = success(await call('reader', 'READ', {})), r = revision('BRANCH_BOUND_EXACT', [base.ref]), requestId = 'outbox-outage:' + randomUUID();
        dropAppend = true;
        const failed = await call('proposer', 'PROPOSE', r, requestId); assert.equal(failed.body.code, 'INJECTED_APPEND_OUTAGE');
        const path = join(root, 'journal/history.jsonl'), committed = (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
        assert.equal(committed.length, before.counts.history + 1); assert.equal(committed.at(-1).requestId, requestId);
        const blocked = await call('reader', 'READ', {}); assert.equal(blocked.body.code, 'INJECTED_APPEND_OUTAGE');
        assert.equal((await readFile(path, 'utf8')).split('\n').filter(Boolean).length, committed.length);
        await stop(); await ledger.stop(); await ledger.start(); proxyLedgerEndpoint = ledger.endpoint(); dropAppend = false; await boot();
        const recovered = success(await call('reader', 'READ', {})); assert.equal(recovered.protectedHistory.publishedSequence, committed.length);
        assert.deepEqual(recovered.accounting, before.accounting); assert.equal(recovered.counts.history, committed.length);
        const accepted = await ledger.readCapabilityEvent(recovered.protectedHistory.eventId); assert.equal(accepted.status, 200);
        assert.equal(accepted.body.event.detail.entryDigest, committed.at(-1).digest);
        const entryRef = accepted.body.event.detail.entryRef, stored = await ledger.call('/references/' + encodeURIComponent(entryRef.id));
        assert.deepEqual(stored.body.reference.content, committed.at(-1)); assert.equal(digest(stored.body.reference.content), entryRef.contentDigest);
        const retried = success(await call('proposer', 'PROPOSE', r, requestId)); assert.deepEqual(retried, committed.at(-1).result);
        const final = success(await call('reader', 'READ', {})); assert.equal(final.counts.history, committed.length); assert.deepEqual(final.protectedHistory.receipt, recovered.protectedHistory.receipt);
        return { failed, blocked, recovered: recovered.protectedHistory, accepted, journalEntryRef: entryRef, retried, transitionCount: committed.length, accounting: recovered.accounting, originalSignedEntryReadbackVerified: true, executionAuthorityGranted: false };
    });
}
finally {
    await stop();
    await ledger.stop();
    if (proxy) await new Promise<void>(ok => proxy.close(() => ok()));
}
const afterSnapshot = await snapshot(), unchanged = digest(before) === digest(afterSnapshot);
await save();
const result = JSON.parse(await readFile(join(out, 'results.json'), 'utf8'));
await writeFile(join(out, 'results.json'), JSON.stringify({ ...result, after: afterSnapshot, sourcesUnchanged: unchanged }, null, 2) + '\n');
process.exitCode = results.some(r => r.status === 'FAIL') || !unchanged ? 1 : 0;
console.log(JSON.stringify({ out, passed: results.filter(r => r.status === 'PASS').length, failed: results.filter(r => r.status === 'FAIL').length, sourcesUnchanged: unchanged }));
