import { admitGeneratedLifecycleControl } from './generated-admission-fixture.mjs';
import { requiredCapabilitySourcePaths } from '../../packages/capability-evolution/src/source-closure';
/** Real native S1/S3/S4/S5/S7 SQL → signed proposer CLI → S8/S6 process. */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createNativeOwnerDatabase } from '../s7/native-owner-database.mjs';
import { createEconomicLedger } from '../s7/ledger-fixture.mjs';
import { economicFixture } from '../s7/economic-fixtures.mjs';
import { createUpstreamFixtureSupport } from '../s5/owner-fixture.mjs';
import { createCapabilityLifecycle } from './lifecycle-fixture.mjs';
import { canonical } from '../../packages/governed-execution/src/protocol';
import { byteDigest, digest, RefSchema, makeRef } from '../../packages/capability-evolution/src/contracts';
import type { OutcomeEstimand } from '../../packages/shared-types/src/economic-attribution';
const out = resolve(process.env.FINNOR_S8_EVIDENCE_DIR ?? '../scope-8/scope-evidence/native-campaign');
await mkdir(out, { recursive: true });
const sources = [...(await readdir('packages/capability-evolution/src')).filter(n => /\.(ts|mts)$/.test(n)).map(n => 'packages/capability-evolution/src/' + n), ...['allocation-producer.ts', 'allocation-solver.py', 'allocation-checker.ts', 'allocation-verifier.ts', 'allocation-verifier-worker.mjs', 'allocation-contracts.ts', 'control-contracts.ts', 'source-precedence.ts', 'experiment-numerics.ts'].map(n => 'packages/epistemic-runtime/src/' + n), ...['enterprise-allocation.ts', 'allocation-store.ts', 'enterprise-economic-attribution.ts', 'economic-store.ts', 'enterprise-economic-consumers.ts'].map(n => 'packages/private-equity/src/' + n), 'packages/governed-execution/src/owner-transport.ts', 'packages/governed-execution/src/owner-delivery-store.ts', 'packages/db/index.ts', 'packages/db/migrations/0148_portfolio_resource_clearing.sql', 'packages/db/migration-head.ts', 'packages/shared-types/src/allocation.ts', 'scripts/s8/run-native-campaign-e2e.mts', 'scripts/s8/lifecycle-fixture.mts', 'scripts/s8/generated-admission-fixture.mts', 'scripts/s7/native-owner-database.mts', 'scripts/s7/ledger-fixture.mts', 'scripts/s5/owner-fixture.mts', 'scripts/s5/reference.py', 'package-lock.json'];
const protectedCandidate = process.env.FINNOR_S8_PROTECTED_CANDIDATE ? resolve(process.env.FINNOR_S8_PROTECTED_CANDIDATE) : null;
let compiledDirectory: string | undefined;
if (protectedCandidate) {
    const manifestPath = join(protectedCandidate, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.status, 'UNSIGNED_NOT_INSTALLED_NOT_DEPLOYED_NOT_ADMITTED');
    for (const file of manifest.files) assert.equal(byteDigest(await readFile(join(protectedCandidate, file.path))), file.sha256);
    for (const [name, sha] of Object.entries(manifest.baseProtectedSourceDigests)) assert.equal(byteDigest(await readFile('packages/governed-execution/src/' + name)), sha);
    sources.push(manifestPath, ...manifest.files.map((file: any) => join(protectedCandidate, file.path)));
    compiledDirectory = join(protectedCandidate, 'install/finnor-os/packages/governed-execution/src');
}
const snapshot = () => Promise.all([...new Set([...sources.map(path => resolve(path)), ...requiredCapabilitySourcePaths])].map(async (path) => ({ path: resolve(path), sha256: byteDigest(await readFile(path)) }))), before = await snapshot(), startedAt = new Date().toISOString(), results: any[] = [];
async function save(extra: any = {}) { await writeFile(join(out, 'results.json'), JSON.stringify({ schema: 'finnor.s8.native-campaign-e2e.v1', startedAt, results, before, ...extra, qualification: 'GENERATED_OWNER_INPUTS_REAL_NATIVE_SQL_S5_RESERVATION_S7_HISTORY_SIGNED_PROPOSER_AND_BOUNDED_S8_COMPUTATION; NO_INDEPENDENT_TRANSFER_OR_LIVE_METHOD_OR_H2', rerun: 'FINNOR_S3_PYTHON=<pinned> FINNOR_S5_PYTHON=<pinned> FINNOR_S8_EVIDENCE_DIR=<new-dir> node --import=tsx scripts/s8/run-native-campaign-e2e.mts' }, null, 2) + '\n'); }
process.env.FINNOR_S3_MODEL_STORE = join(out, 'ordinary-models');
process.env.FINNOR_S4_POLICY_STORE = join(out, 'ordinary-policies');
const database = await createNativeOwnerDatabase(), evaluator = randomUUID(), promoter = randomUUID();
let ledger: any = null, service: any = null;
try {
    const allocationRoute = await import('../../apps/api/app/api/allocations/[operation]/route');
    const api = async (f: any, operation: string, body: any, handler = allocationRoute.POST) => { const response = await handler(new Request('http://localhost/api/allocations/' + operation, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tenant-id': f.tenant, 'x-user-id': f.principal, 'x-user-role': 'owner' }, body: JSON.stringify(body) }), { params: Promise.resolve({ operation }) }); return { status: response.status, body: await response.json() }; };
    const generated = spawnSync(process.env.FINNOR_S3_PYTHON!, ['scripts/s3/reference.py'], { input: JSON.stringify({ operation: 'equivalent' }), encoding: 'utf8', timeout: 30000 });
    assert.equal(generated.status, 0, generated.stderr);
    const day = 86400000, begin = new Date(Math.floor(Date.now() / day) * day - 128 * day).toISOString(), upstream = createUpstreamFixtureSupport({ admin: () => database.admin, generatedRows: JSON.parse(generated.stdout).rows, begin, day, fixtures: {}, api, artifact: async (name: string, value: any) => { const path = join(out, name); await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2) + '\n'); return path; } });
    const f = await upstream.fixture('native-s8-campaign', 1, [{ id: 'cash', unit: 'USD', capacity: 100, totalLimit: 100 }]);
    for (const label of ['A', 'B', 'C'])
        await upstream.policy(f, label, { cash: 10 });
    await upstream.resource(f, 'cash', 'USD', 'STOCK', ['100', '100']);
    service = await createCapabilityLifecycle({ tenant: f.tenant, principal: f.principal, evaluator, promoter, rightsRef: f.mandate.rightsRef, sourcePins: before.filter(pin => !pin.path.includes('/scripts/') && (!protectedCandidate || !pin.path.startsWith(protectedCandidate))), ...(compiledDirectory ? { protectedEvents: { contract: 'S8_CAPABILITY_EVENTS_V1', maxRecoveryEvents: 64 } } : {}) });
    ledger = await createEconomicLedger(f.tenant, f.principal, randomUUID(), { rightsRef: f.mandate.rightsRef, capabilityLifecycle: true, nativeAllocation: true, financialPrincipal: evaluator, ...(compiledDirectory ? { compiledSubstrate: { sourceDirectory: compiledDirectory, policyExtensions: { capabilityRevisionContract: 'S8_CAPABILITY_EVENTS_V1', capabilityJournalKeys: [{ policyDigest: digest(service.policy), tenantId: f.tenant, principalId: f.principal, rightsRef: f.mandate.rightsRef, publicKey: service.pub('journal'), validAfter: service.after, validUntil: service.until, revoked: false }] } } } : {}) });
    const request = upstream.clearing(f, { A: ['1'], B: ['2'], C: ['4'] }), cleared = await api(f, 'clear', request);
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.status, 'FEASIBLE');
    assert.equal(cleared.body.certificate.optimization.incumbent, '7');
    const owner = await import('../../packages/private-equity/src/enterprise-allocation'), issued = await owner.readEnterpriseAllocation(f.ctx, cleared.body.certificate.ref), economic = await import('../../packages/private-equity/src/enterprise-economic-attribution');
    const financial = economicFixture(8, -30, 15), registered = await economic.registerEnterpriseOutcomeEstimand(f.ctx, { estimand: financial.input.estimand, rightsRef: f.mandate.rightsRef, mode: 'RETROSPECTIVE', idempotencyKey: 'campaign-history' });
    financial.input.accounting.forEach((row: any) => row.estimandRef = registered.record.ref);
    const assessment = await economic.assessEnterpriseEconomicAttribution(f.ctx, { estimandId: registered.record.ref.id, lookAt: financial.input.lookAt, assignments: financial.input.assignments, accounting: financial.input.accounting, idempotencyKey: 'campaign-assessment', computeCost: { amount: null, pricebookRef: null, meteringRef: null } });
    const delivery = await import('../../packages/governed-execution/src/owner-delivery-store'), deliveries = [];
    for (const semanticOwner of ['S5', 'S7'])
        deliveries.push({ semanticOwner, report: await delivery.deliverOwnerTransportBatch({ semanticOwner, tenantId: f.tenant, principalId: f.principal }, { limit: 32 }) });
    // Some prepared event dependencies have no protected publication in this
    // generated fixture. Their actual retained failures remain in the artifact.
    for (const ref of [issued.problem.ref, issued.certificate.ref, registered.record.ref, assessment.record.ref]) {
        const read = await ledger.call('/references/' + encodeURIComponent(ref.id));
        assert.equal(read.status, 200, JSON.stringify(read));
        assert.equal(digest(read.body.reference.content), ref.contentDigest);
    }

    await service.start();
    const template = { schema: 'finnor.capability-revision.v1', tenantId: f.tenant, principalId: f.principal, episodeId: 'native-joined-S8-campaign', parents: [], owningInterface: 's5-joint-finite-v1', payload: { schema: 'finnor.s8.allocation-method.v1', algorithm: 'ENUMERATE_EXACT', order: 'CANONICAL', incumbent: 'FIRST_FEASIBLE', maxPolicies: 8, maximumNodes: 511 }, dependencies: service.policy.sourcePins, runtime: { node: process.version, platform: process.platform, architecture: process.arch }, experience: { refs: [assessment.record.ref], knowledgeCut: new Date().toISOString(), trainingCompanies: ['generated-native-company'], dependenceGroups: [], qualification: 'AUTHENTICATED_OWNER_HISTORY_NO_CAUSAL_REWARD_ASSUMED' }, intendedImprovement: 'Original finite objective bounds; requires independent future evidence', domain: { owner: 'S5', interface: 's5-joint-finite-v1', maxPolicies: 8, maxPeriods: 8, maxScenarios: 8, strata: ['coupled', 'prior-regime'], rightsRef: f.mandate.rightsRef, validAfter: service.after, validUntil: service.until }, envelope: { maxAttempts: 8, maxNodes: 511, maxWallMs: 30000, maxHumanSeconds: 900, maxCost: 10, maxDecisionLoss: 0, maxUses: 20 }, proposedAt: new Date().toISOString() };
    const tokenPath = join(service.root, 'proposer.token'), configPath = join(service.root, 'proposer.json');
    await writeFile(tokenPath, service.tokens.proposer, { mode: 0o600 });
    const policy = { schema: 'finnor.s8.proposer-policy.v1', tenantId: f.tenant, principalId: f.principal, domain: 'DISPOSABLE_TEST_AUTHORITY', template, assessmentRef: assessment.record.ref, allocationRef: issued.certificate.ref, limitations: [{ kind: 'UNKNOWN_OUTCOME', evidenceRef: assessment.record.ref }], maximumCandidates: 8, reservedCostPerAttempt: 1, endpoint: service.endpoint(), tokenPath, tokenHash: byteDigest(service.tokens.proposer), validAfter: service.after, validUntil: service.until };
    await writeFile(configPath, canonical(service.signed(policy, 'release')), { mode: 0o600 });
    async function run() {
        return new Promise<any>((ok, fail) => {
            const child = spawn(process.execPath, ['--import=tsx', 'packages/capability-evolution/src/campaign.mts'], { env: { NODE_ENV: 'test', PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, DATABASE_URL: process.env.DATABASE_URL, FINNOR_S3_MODEL_STORE: process.env.FINNOR_S3_MODEL_STORE, FINNOR_S4_POLICY_STORE: process.env.FINNOR_S4_POLICY_STORE, FINNOR_S8_PROPOSER_CONFIG: configPath, FINNOR_S8_PROPOSER_ROOT: service.pub('release'), FINNOR_S6_OWNER_TRANSPORT_CONFIG: process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG, FINNOR_S6_OWNER_TRANSPORT_ROOT: process.env.FINNOR_S6_OWNER_TRANSPORT_ROOT }, stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '', stderr = '';
            const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
            child.stdout!.on('data', b => {
                stdout += b;
                if (Buffer.byteLength(stdout) > 8 * 1024 * 1024)
                    child.kill('SIGKILL');
            });
            child.stderr!.on('data', b => {
                stderr += b;
                if (Buffer.byteLength(stderr) > 65536)
                    child.kill('SIGKILL');
            });
            child.once('error', fail);
            child.once('close', code => {
                clearTimeout(timer);
                if (code !== 0)
                    return fail(Error('NATIVE_CAMPAIGN_EXIT:' + code + ':' + stderr));
                try {
                    ok(JSON.parse(stdout));
                }
                catch (error) {
                    fail(error);
                }
            });
        });
    }
    const campaign = await run();
    assert.equal(campaign.attempts.length, 8);
    assert(campaign.attempts.every((a: any) => a.result.result.complete && a.result.result.objective === '7'));
    assert.equal(campaign.independentAdmissionGranted, false);
    assert.equal(campaign.activationGranted, false);
    assert.equal(campaign.costs, 'UNKNOWN_UNTIL_INDEPENDENT_BILLING');
    assert(campaign.experienceRefs.some((ref: any) => ref.id === registered.record.ref.id));
    const retry = await run();
    assert.deepEqual(retry, campaign);
    const response = await fetch(service.endpoint() + '/command', { method: 'POST', headers: { authorization: 'Bearer ' + service.tokens.reader, 'content-type': 'application/json' }, body: canonical({ requestId: 'native-campaign-read', operation: 'READ', body: {} }) }), read = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(read.attempts.length, 8);
    assert.equal(read.accounting.totalCost, 8);
    assert.equal(read.active, null);
    assert.equal(read.revisions.length, 8);
    if (compiledDirectory) {
        assert.equal(read.protectedHistory.publishedSequence, read.counts.history);
        const accepted = await ledger.readCapabilityEvent(read.protectedHistory.eventId); assert.equal(accepted.status, 200);
        assert.deepEqual(accepted.body.receipt, read.protectedHistory.receipt);
        assert.equal(accepted.body.event.detail.operation, 'RUN_SEARCH');
        const entryRef = accepted.body.event.detail.entryRef, original = await ledger.call('/references/' + encodeURIComponent(entryRef.id));
        assert.equal(original.status, 200); assert.equal(original.body.reference.content.result.attemptId, read.attempts.at(-1).attemptId);
        await writeFile(join(out, 'native-protected-search-history.json'), JSON.stringify({ accepted, original, protectedHistory: read.protectedHistory, protectedSearchFunding: false, actualHardOSQuota: false, qualification: 'ACTUAL_NATIVE_S5_S7_SEARCH_LIFECYCLE_MECHANICALLY_RECEIPTED_BY_COMPILED_REVIEW_S6_WITH_DISPOSABLE_AUTHORITY' }, null, 2) + '\n');
    }
    const validation = await owner.validateEnterpriseAllocation(f.ctx, issued.certificate.ref);
    assert.equal(validation.status, 'CURRENT');
    const role = await database.db.withTenantTransaction(f.tenant, { userId: f.principal, readOnly: true }, async (_db, c) => (await c.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]);
    assert.equal(role.rolsuper, false);
    assert.equal(role.rolbypassrls, false);
    const obligations = (await database.admin.query('SELECT count(*)::int n FROM finnor_os.s5_consumptions WHERE tenant_id=$1', [f.tenant])).rows[0];
    assert.equal(obligations.n, 0);
    results.push({ id: 'native-history-allocation-signed-cli-accounted-search-and-idempotent-retry', status: 'PASS', observed: { campaign, retry, read, validation, deliveries, assessmentRef: assessment.record.ref, accountingQualification: (assessment.record.payload.assessment as {
                completeCosts: boolean;
            }).completeCosts, protectedEpisodeCompletenessEstablished: false, ordinaryRole: role, noEffectsOrLiveMethod: true, consumptions: obligations.n } });
    // Generated signed state setup reaches the actual native use/currentness
    // boundary. It is not evidence of independently beneficial methods.
    async function command(actor: string, operation: string, body: any, requestId = 'native-currentness:' + randomUUID()) {
        const response = await fetch(service.endpoint() + '/command', { method: 'POST', headers: { authorization: 'Bearer ' + service.tokens[actor], 'content-type': 'application/json' }, body: canonical({ requestId, operation, body }) });
        return { status: response.status, body: await response.json() as any };
    }
    const success = (r: any) => { assert.equal(r.status, 200, JSON.stringify(r)); return r.body; };
    const costRefs: Array<{ owner: string; id: string; version: string; contentDigest: string }> = [];
    for (const attempt of read.attempts) {
        const content = { schema: 'finnor.s8.independent-attempt-cost.v1', tenantId: f.tenant, episodeId: template.episodeId, currency: 'USD', attemptId: attempt.attemptId, amount: [1, 1], basis: 'REGISTERED_GENERATIVE_MODEL', knowledgeAt: new Date().toISOString() };
        const ref = { owner: 'FINANCIAL_SOURCE', id: 'currentness-attempt:' + digest(content), version: 'generated-control-v1', contentDigest: digest(content) };
        await ledger.publish({ ...ref, content }); costRefs.push(ref);
    }
    const categories = ['search', 'training', 'evaluation', 'human', 'computeData', 'integration', 'maintenance', 'recovery', 'deployment'];
    for (const category of categories) {
        const content = { schema: 'finnor.s8.independent-lifecycle-cost.v1', tenantId: f.tenant, episodeId: template.episodeId, currency: 'USD', category, amount: category === 'search' ? [8, 8] : [0, 0], basis: 'REGISTERED_GENERATIVE_MODEL', knowledgeAt: new Date().toISOString() };
        const ref = { owner: 'FINANCIAL_SOURCE', id: 'currentness-phase:' + digest(content), version: 'generated-control-v1', contentDigest: digest(content) };
        await ledger.publish({ ...ref, content }); costRefs.push(ref);
    }
    async function nativeRevision(ref: any) {
        const answer = await ledger.call('/references/' + encodeURIComponent(ref.id)); assert.equal(answer.status, 200);
        return { ...answer.body.reference.content, ref };
    }
    const evaluatedState = (r: any, wave: string, admit = true) => admitGeneratedLifecycleControl({ revision: r, wave, service, command, attempts: read.attempts, costRefs, searchCost: 8, admit });
    const predecessor = await nativeRevision(campaign.attempts[0].revisionRef);
    await evaluatedState(predecessor, 'native-currentness-base');
    const activation = (r: any, generation: number, prior: any) => service.signed({ revisionRef: r.ref, expectedGeneration: generation, predecessorRef: prior, mode: 'SHADOW', maxDecisionLoss: 0, maxCost: 10, maxUses: 20, validUntil: service.until, evidenceRefs: [] }, 'promoter');
    success(await command('promoter', 'ACTIVATE', activation(predecessor, 0, null)));
    const originalChild = await nativeRevision(campaign.attempts[1].revisionRef), { ref: ignoredChild, ...childBody } = originalChild;
    childBody.parents = [predecessor.ref];
    const child = { ...childBody, ref: makeRef('capability-revision', childBody) };
    success(await command('proposer', 'PROPOSE', child)); await evaluatedState(child, 'native-currentness-child');
    // Rehearse the actual native canary joins in SHADOW. All independent source
    // bodies below are generated controls; no scientific benefit is claimed.
    const assignmentOwner = await import('../../packages/private-equity/src/enterprise-economic-assignments');
    const economicEngine = await import('../../packages/epistemic-runtime/src/economic-attribution');
    const canaryEstimand = structuredClone(economicFixture(8, 0, 15).input.estimand) as OutcomeEstimand;
    const prefix = 'native-canary-' + randomUUID();
    for (const ref of economicEngine.collectEconomicRefs(canaryEstimand)) {
        const id = ref.id; const rename = (value: any) => { if (value && typeof value === 'object') { if (value.id === id && value.contentDigest) value.id = prefix + ':' + id; for (const child of Object.values(value)) rename(child); } }; rename(canaryEstimand);
    }
    const now = Date.now();
    canaryEstimand.registeredAt = new Date(now).toISOString(); canaryEstimand.assignmentAt = new Date(now + 15000).toISOString();
    canaryEstimand.outcomeAccessNotBefore = new Date(now + 45000).toISOString(); canaryEstimand.endpointAt = new Date(now + 180000).toISOString();
    canaryEstimand.horizonMonths = 1; canaryEstimand.analysis.registeredLooks = [canaryEstimand.endpointAt]; canaryEstimand.discountSchedule = [{ at: canaryEstimand.endpointAt, factor: '1' }];
    if (canaryEstimand.assignment.kind !== 'INDEPENDENT_CLUSTER_RANDOMIZATION') throw Error('Rehearsal requires the existing randomized owner fixture.');
    canaryEstimand.assignment.probabilities = { bau: '0.05', finnor: '0.95' };
    canaryEstimand.analysis.minimumProbability = '0.05';
    // The native S7 resolver requires explicit issuer enrollment for foreign
    // financial/valuation principals, including generated source controls.
    const valuerPrincipal = ledger.policy.owners.find((o: any) => o.owner === 'INDEPENDENT_VALUER').principalId;
    canaryEstimand.valuationProtocol.authorityRefs = [{ owner: 'FINANCIAL_SOURCE', id: evaluator, version: 'generated-control-v1', contentDigest: digest(evaluator) }, { owner: 'INDEPENDENT_VALUER', id: valuerPrincipal, version: 'generated-control-v1', contentDigest: digest(valuerPrincipal) }];
    const nativeController = canaryEstimand.controllers.find(c => c.role === 'FINNOR')!;
    nativeController.programmeRef = issued.problem.policies[0]!.ref; nativeController.policyRefs = issued.problem.policies.map(policy => policy.ref); nativeController.adaptationRuleRef = child.ref;
    canaryEstimand.allocationRef = issued.reservation!.ref;
    const nativeRefs = [child.ref, issued.reservation!.ref, ...nativeController.policyRefs];
    for (const policy of issued.problem.policies) { const { ref, ...content } = policy; await ledger.publish({ ...ref, content }); }
    for (const ref of economicEngine.collectEconomicRefs(canaryEstimand)) {
        if (nativeRefs.some(native => digest(native) === digest(ref)) || ref.id === canaryEstimand.assignment.protocolRef.id) continue;
        const content = digest(ref) === digest(canaryEstimand.mandateRef)
            ? { schema: 'finnor.economic-mandate.v1', tenantId: f.tenant, principalId: f.principal, rightsRef: f.mandate.rightsRef, economicProgrammeAssignment: true, validUntil: new Date(Date.parse(canaryEstimand.endpointAt) - 1000).toISOString(), sourceOrigin: 'GENERATED_CHALLENGE' }
            : canaryEstimand.valuationProtocol.authorityRefs.some(a => digest(a) === digest(ref)) ? { schema: 'finnor.independent-valuation-authority.v1', principalId: ref.id, sourceOrigin: 'GENERATED_CHALLENGE', independent: true }
            : { schema: 'finnor.generated-source.v1', id: ref.id, sourceOrigin: 'GENERATED_CHALLENGE', independent: true };
        const update = (value: any) => { if (value && typeof value === 'object') { if (value.id === ref.id && value.contentDigest) value.contentDigest = digest(content); for (const child of Object.values(value)) update(child); } }; update(canaryEstimand);
        await ledger.publish({ ...ref, contentDigest: digest(content), content });
    }
    const canaryProtocol = await assignmentOwner.registerEnterpriseEconomicAssignmentProtocol(f.ctx, { protocol: { schema: 'finnor.s2.economic-assignment-protocol.v1', key: prefix, mandateRef: canaryEstimand.mandateRef, populationRef: canaryEstimand.populationRef, clusterIds: canaryEstimand.clusters.map(c => c.id), controllerIds: canaryEstimand.controllers.map(c => c.id), probabilityUnits: { bau: 50000, finnor: 950000 }, assignmentNotBefore: canaryEstimand.assignmentAt, outcomeAccessNotBefore: canaryEstimand.outcomeAccessNotBefore, randomization: 'INDEPENDENT_CRYPTO_CATEGORICAL_V1' }, rightsRef: f.mandate.rightsRef });
    await delivery.deliverOwnerTransportBatch({ semanticOwner: 'S2', tenantId: f.tenant, principalId: f.principal }, { limit: 32 });
    canaryEstimand.assignment.protocolRef = canaryProtocol.record.ref;
    const canaryQuestion = await economic.registerEnterpriseOutcomeEstimand(f.ctx, { estimand: canaryEstimand, rightsRef: f.mandate.rightsRef, mode: 'PROSPECTIVE', idempotencyKey: prefix });
    await delivery.deliverOwnerTransportBatch({ semanticOwner: 'S7', tenantId: f.tenant, principalId: f.principal }, { limit: 32 });
    const canaryPlan = { schema: 'finnor.s8.native-canary-plan.v1', estimandRef: canaryQuestion.record.ref, protocolRef: canaryProtocol.record.ref, fundingAllocationRef: issued.certificate.ref, fundingReservationRef: issued.reservation!.ref, controllerId: 'finnor', reservedCostPerUse: 1, maxPendingUses: 2, stopAt: new Date(Date.parse(canaryEstimand.endpointAt) - 1000).toISOString(), stopOnUncertainOutcome: true, stopOnAdverseNotice: true, maximumUsesPerCluster: 1 };
    await writeFile(join(out, 'native-canary-inputs.json'), JSON.stringify({ plan: canaryPlan, question: canaryQuestion.record, protocol: canaryProtocol.record, fundingCertificateRef: issued.certificate.ref, fundingReservationRef: issued.reservation!.ref, sourceGaps: (canaryQuestion.record.payload.sourceCut as any[]).filter(c => c.status !== 'RESOLVED_AUTHENTICATED'), qualification: 'GENERATED_SHADOW_REHEARSAL_INPUTS_NO_FIELD_AUTHORITY' }, null, 2) + '\n');
    const planActivation = (plan: any) => service.signed({ ...activation(child, 1, predecessor.ref).body, validUntil: canaryPlan.stopAt, canaryPlan: plan }, 'promoter');
    const falseReservation = await command('promoter', 'ACTIVATE', planActivation({ ...canaryPlan, fundingReservationRef: issued.certificate.ref }));
    assert.equal(falseReservation.body.code, 'S8_CANARY_PREREGISTRATION_BINDING', JSON.stringify(falseReservation));
    const mandateExceeded = await command('promoter', 'ACTIVATE', planActivation({ ...canaryPlan, stopAt: canaryEstimand.endpointAt }));
    assert.equal(mandateExceeded.body.code, 'S8_CANARY_ASSIGNMENT_MANDATE_EXPIRED_OR_EXCEEDED', JSON.stringify(mandateExceeded));
    success(await command('promoter', 'ACTIVATE', planActivation(canaryPlan)));
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(canaryEstimand.assignmentAt) - Date.now() + 10)));
    const assignments = await assignmentOwner.assignEnterpriseEconomicProgramme(f.ctx, { estimandId: canaryQuestion.record.ref.id, protocolId: canaryProtocol.record.ref.id, idempotencyKey: prefix });
    await delivery.deliverOwnerTransportBatch({ semanticOwner: 'S2', tenantId: f.tenant, principalId: f.principal }, { limit: 32 });
    const assignedClusters = assignments.record.assignments!.filter(a => a.controllerId === 'finnor');
    assert(assignedClusters.length >= 3, 'Actual S2 random draw did not produce three rehearsal clusters; do not resample.');
    const otherTenant = randomUUID(), otherPrincipal = randomUUID();
    await database.admin.query('INSERT INTO finnor_os.tenants(id,name) VALUES($1,$2)', [otherTenant, 'Canary isolation control']);
    await database.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')", [otherPrincipal, otherTenant, otherPrincipal + '@generated.invalid']);
    let foreignRead: any;
    try { await assignmentOwner.readEnterpriseEconomicAssignmentRecord({ auth: { tenantId: otherTenant, userId: otherPrincipal, employeeId: otherPrincipal, role: 'owner' } }, assignments.record.ref); throw Error('Foreign native assignment unexpectedly readable'); }
    catch (error) { assert.equal((error as any).code, 'ECONOMIC_ASSIGNMENT_CONTEXT_UNAVAILABLE'); foreignRead = { code: (error as any).code, status: (error as any).status, tenantId: otherTenant, principalId: otherPrincipal }; }
    const canaryBinding = (a: typeof assignedClusters[number]) => ({ assignmentGroupRef: assignments.record.ref, assignmentRef: a.assignmentRef, clusterId: a.clusterId, policyRefs: issued.problem.policies.map(policy => policy.ref), mandateRef: issued.problem.mandate.ref });
    const pending = await nativeRevision(campaign.attempts[2].revisionRef), pendingAdmission = await evaluatedState(pending, 'native-currentness-pending', false);
    const bindingDenials = [];
    for (const kind of ['OMITTED_NATIVE_BINDING', 'CHANGED_HISTORY_DIGEST']) {
        const { ref: ignored, ...body } = structuredClone(predecessor);
        if (kind === 'OMITTED_NATIVE_BINDING') { delete body.experience.ownerAssessmentRef; delete body.experience.historyCutDigest; }
        else body.experience.historyCutDigest = digest('substituted-native-cut');
        const denied = await command('proposer', 'PROPOSE', { ...body, ref: makeRef('capability-revision', body) });
        assert.equal(denied.body.code, kind === 'OMITTED_NATIVE_BINDING' ? 'S8_NATIVE_HISTORY_CURRENTNESS_BINDING_REQUIRED' : 'S8_NATIVE_HISTORY_CUT_OR_RIGHTS_CHANGED');
        bindingDenials.push({ kind, denied });
    }
    const useBody = { tenantId: f.tenant, principalId: f.principal, rightsRef: f.mandate.rightsRef, owner: 'S5', interface: 's5-joint-finite-v1', stratum: 'coupled', policyCount: 3, periods: 1, scenarios: 1, inputDigest: digest(issued.problem), reservedCost: 1, maxDecisionLoss: 0, canaryBinding: canaryBinding(assignedClusters[0]!) };
    const forgedGroupBody = { ...assignments.record.content, generatedLookalike: true }, forgedGroupRef = { owner: 'S2', id: 'economic-assignment:' + digest(forgedGroupBody), version: 's2-economic-assignment-v1', contentDigest: digest(forgedGroupBody) };
    await ledger.publish({ ...forgedGroupRef, content: forgedGroupBody });
    const forgedGroup = await command('consumer', 'USE', { ...useBody, canaryBinding: { ...useBody.canaryBinding, assignmentGroupRef: forgedGroupRef } });
    assert.equal(forgedGroup.body.code, 'ECONOMIC_ASSIGNMENT_CONTEXT_UNAVAILABLE', JSON.stringify(forgedGroup));
    const wrongDraw = await command('consumer', 'USE', { ...useBody, canaryBinding: { ...useBody.canaryBinding, assignmentRef: assignedClusters[1]!.assignmentRef } });
    assert.equal(wrongDraw.body.code, 'S8_CANARY_NATIVE_ASSIGNMENT_OR_INPUT_BINDING', JSON.stringify(wrongDraw));
    const consumer = await import('../../packages/capability-evolution/src/consumer');
    const consumerTokenPath = join(service.root, 'canary-consumer.token'), consumerConfigPath = join(service.root, 'canary-consumer.json');
    await writeFile(consumerTokenPath, service.tokens.consumer, { mode: 0o600 });
    const { policyRefs: omittedPolicies, mandateRef: omittedMandate, ...consumerAssignment } = useBody.canaryBinding;
    const consumerPolicy = { schema: 'finnor.s8.consumer-policy.v1', domain: 'DISPOSABLE_TEST_AUTHORITY', tenantId: f.tenant, principalId: f.principal, rightsRef: f.mandate.rightsRef, endpoint: service.endpoint(), tokenPath: consumerTokenPath, tokenHash: byteDigest(service.tokens.consumer), stratum: 'coupled', reservedCost: 1, maxDecisionLoss: 0, canaryAssignment: consumerAssignment, validAfter: service.after, validUntil: canaryPlan.stopAt, timeoutMs: 10000 };
    await writeFile(consumerConfigPath, canonical(service.signed(consumerPolicy, 'release')), { mode: 0o600 });
    process.env.FINNOR_S8_CONSUMER_CONFIG = consumerConfigPath; process.env.FINNOR_S8_CONSUMER_ROOT = service.pub('release');
    const actualConsumerLease = await consumer.acquireAllocationCapability(issued.problem); assert(actualConsumerLease);
    const readAfterConsumer = success(await command('reader', 'READ', {})), useRequestId = readAfterConsumer.history.filter((h: any) => h.operation === 'USE').at(-1).requestId;
    const use = success(await command('consumer', 'USE', useBody, useRequestId)); assert.deepEqual(use.lease, actualConsumerLease);
    const secondUseBody = { ...useBody, canaryBinding: canaryBinding(assignedClusters[1]!) }, secondUseRequestId = prefix + ':second-use';
    const secondUse = success(await command('consumer', 'USE', secondUseBody, secondUseRequestId));
    assert.deepEqual(use.lease.canary, { plan: canaryPlan, binding: useBody.canaryBinding });
    assert.deepEqual(success(await command('consumer', 'USE', useBody, useRequestId)), use);
    success(await command('consumer', 'RECHECK', { useId: use.lease.useId, revisionRef: child.ref, inputDigest: useBody.inputDigest }));
    assert.equal(await consumer.recheckAllocationCapability(issued.problem, actualConsumerLease), true);
    const pendingStop = await command('consumer', 'USE', { ...useBody, canaryBinding: canaryBinding(assignedClusters[2]!) });
    assert.equal(pendingStop.body.code, 'S8_CANARY_PENDING_EXPOSURE_STOP', JSON.stringify(pendingStop));
    await service.stop(); await service.start();
    await writeFile(consumerConfigPath, canonical(service.signed({ ...consumerPolicy, endpoint: service.endpoint() }, 'release')), { mode: 0o600 });
    assert.equal(await consumer.recheckAllocationCapability(issued.problem, actualConsumerLease), true);
    assert.deepEqual(success(await command('consumer', 'USE', useBody, useRequestId)), use);
    const pendingAfterRestart = await command('consumer', 'USE', { ...useBody, canaryBinding: canaryBinding(assignedClusters[2]!) });
    assert.equal(pendingAfterRestart.body.code, 'S8_CANARY_PENDING_EXPOSURE_STOP');
    const firstUncertain = await economic.appendEnterpriseEconomicRecord(f.ctx, { kind: 'EXPOSURE', estimandRefId: canaryQuestion.record.ref.id, record: { useId: use.lease.useId, revisionRef: child.ref, inputDigest: useBody.inputDigest, assignmentRef: useBody.canaryBinding.assignmentRef, clusterId: useBody.canaryBinding.clusterId, outcome: 'UNKNOWN' }, sourceRefs: [use.ref, child.ref, useBody.canaryBinding.assignmentRef], validAt: new Date().toISOString(), idempotencyKey: prefix + ':first-unknown' });
    await delivery.deliverOwnerTransportBatch({ semanticOwner: 'S7', tenantId: f.tenant, principalId: f.principal }, { limit: 32 });
    const firstReconciliation = success(await command('consumer', 'RECONCILE', { useId: use.lease.useId, outcome: 'UNKNOWN', evidenceRef: firstUncertain.record.ref })); assert.equal(firstReconciliation.liabilityBudgetReleased, false);
    const unknownStop = await command('consumer', 'USE', { ...useBody, canaryBinding: canaryBinding(assignedClusters[2]!) });
    assert.equal(unknownStop.body.code, 'S8_CANARY_UNCERTAIN_OUTCOME_STOP', JSON.stringify(unknownStop));
    const canaryNotice = await economic.appendEnterpriseEconomicRecord(f.ctx, { kind: 'COST', estimandRefId: canaryQuestion.record.ref.id, record: { amount: '25', category: 'HUMAN', reason: 'Unresolved canary invoice' }, sourceRefs: [], validAt: new Date().toISOString(), idempotencyKey: prefix + ':canary-cost' });
    await delivery.deliverOwnerTransportBatch({ semanticOwner: 'S7', tenantId: f.tenant, principalId: f.principal }, { limit: 32 });
    const canaryStops = [];
    for (const [operation, body, id] of [['USE', secondUseBody, secondUseRequestId], ['USE', { ...useBody, canaryBinding: canaryBinding(assignedClusters[2]!) }, prefix + ':stopped-new-use'], ['RECHECK', { useId: secondUse.lease.useId, revisionRef: child.ref, inputDigest: useBody.inputDigest }, prefix + ':stopped-recheck']] as const) {
        const denied = await command('consumer', operation, body, id); assert.equal(denied.body.code, 'S8_CANARY_ADVERSE_NOTICE_STOP', JSON.stringify(denied)); canaryStops.push(denied);
    }
    results.push({ id: 'native-canary-plan-S2-assignment-S4-policy-S5-consumer-funding-and-stops-across-restart', status: 'PASS', observed: { canaryPlan, canaryQuestion: canaryQuestion.record, canaryProtocol: canaryProtocol.record, assignments: assignments.record, foreignRead, falseReservation, mandateExceeded, forgedGroup, wrongDraw, actualConsumerLease, use, secondUse, pendingStop, pendingAfterRestart, firstUncertain: firstUncertain.record, firstReconciliation, unknownStop, canaryNotice: canaryNotice.record, canaryStops, qualification: 'ACTUAL_NATIVE_OWNER_BINDINGS_IN_SHADOW_WITH_GENERATED_SOURCES_NO_FIELD_PERMISSION_OR_LOSS_GUARANTEE' } });
    const beforeNotice = success(await command('reader', 'READ', {}));
    const note = await economic.appendEnterpriseEconomicRecord(f.ctx, { kind: 'COST', estimandRefId: registered.record.ref.id, record: { amount: '25', category: 'HUMAN', reason: 'Late unresolved invoice after native capability cut' }, sourceRefs: [], validAt: financial.input.lookAt, idempotencyKey: 'native-capability-late-cost' });
    await delivery.deliverOwnerTransportBatch({ semanticOwner: 'S7', tenantId: f.tenant, principalId: f.principal }, { limit: 32 });
    const stopChecks = [];
    for (const [actor, operation, body, id] of [
        ['consumer', 'USE', useBody, 'native-use-after-late-cost'],
        ['consumer', 'USE', useBody, useRequestId],
        ['consumer', 'RECHECK', { useId: use.lease.useId, revisionRef: child.ref, inputDigest: useBody.inputDigest }, 'native-recheck-after-cost'],
        ['evaluator', 'ADMIT', service.signed(pendingAdmission, 'evaluator'), 'native-admit-after-cost'],
        ['promoter', 'ACTIVATE', activation(predecessor, 2, child.ref), 'native-activate-after-cost'],
        ['promoter', 'REVOKE', service.signed({ revisionRef: child.ref, expectedGeneration: 2, predecessorRef: predecessor.ref, reason: 'Restore must not bypass adverse native history' }, 'promoter'), 'native-restore-after-cost']
    ] as any[]) {
        const denied = await command(actor, operation, body, id); assert.equal(denied.body.code, 'S8_NATIVE_EXPERIENCE_REASSESSMENT_REQUIRED', JSON.stringify(denied)); stopChecks.push({ actor, operation, denied });
    }
    const afterNotice = success(await command('reader', 'READ', {})); assert.deepEqual(afterNotice.accounting, beforeNotice.accounting); assert.equal(afterNotice.generation, beforeNotice.generation); assert.deepEqual(afterNotice.uses, beforeNotice.uses);
    await service.stop(); await service.start();
    const afterRestart = await command('consumer', 'USE', useBody, useRequestId); assert.equal(afterRestart.body.code, 'S8_NATIVE_EXPERIENCE_REASSESSMENT_REQUIRED');
    const revoked = success(await command('promoter', 'REVOKE', service.signed({ revisionRef: child.ref, expectedGeneration: 2, predecessorRef: null, reason: 'Stop without restoring stale predecessor' }, 'promoter')));
    const final = success(await command('reader', 'READ', {})); assert.equal(final.active, null); assert.deepEqual(final.accounting, beforeNotice.accounting); assert.deepEqual(final.uses, beforeNotice.uses);
    results.push({ id: 'native-late-S7-cost-blocks-admit-activation-use-retry-recheck-and-stale-restoration-across-crash', status: 'PASS', observed: { predecessorRef: predecessor.ref, childRef: child.ref, nativeHistoryCutDigest: predecessor.experience.historyCutDigest, noticeRef: note.record.ref, bindingDenials, beforeNotice, stopChecks, afterNotice, afterRestart, revoked, final, qualification: 'REAL_NATIVE_HISTORY_CURRENTNESS_WITH_GENERATED_SIGNED_STATE_SETUP_NO_INDEPENDENT_GAIN_OR_FIELD_CANARY' } });
    const uncertainRecord = { useId: secondUse.lease.useId, revisionRef: child.ref, inputDigest: useBody.inputDigest, assignmentRef: secondUseBody.canaryBinding.assignmentRef, clusterId: secondUseBody.canaryBinding.clusterId, outcome: 'UNKNOWN' };
    const wrongOutcome = await economic.appendEnterpriseEconomicRecord(f.ctx, { kind: 'EXPOSURE', estimandRefId: canaryQuestion.record.ref.id, record: { ...uncertainRecord, inputDigest: digest('foreign-input') }, sourceRefs: [secondUse.ref, child.ref, secondUseBody.canaryBinding.assignmentRef], validAt: new Date().toISOString(), idempotencyKey: prefix + ':wrong-outcome' });
    const uncertain = await economic.appendEnterpriseEconomicRecord(f.ctx, { kind: 'EXPOSURE', estimandRefId: canaryQuestion.record.ref.id, record: uncertainRecord, sourceRefs: [secondUse.ref, child.ref, secondUseBody.canaryBinding.assignmentRef], validAt: new Date().toISOString(), idempotencyKey: prefix + ':unknown-outcome' });
    await delivery.deliverOwnerTransportBatch({ semanticOwner: 'S7', tenantId: f.tenant, principalId: f.principal }, { limit: 32 });
    const substitutedOutcome = await command('consumer', 'RECONCILE', { useId: secondUse.lease.useId, outcome: 'UNKNOWN', evidenceRef: wrongOutcome.record.ref });
    assert.equal(substitutedOutcome.body.code, 'S8_CANARY_OUTCOME_USE_LINEAGE_SUBSTITUTION');
    const reconciled = success(await command('consumer', 'RECONCILE', { useId: secondUse.lease.useId, outcome: 'UNKNOWN', evidenceRef: uncertain.record.ref }));
    assert.equal(reconciled.liabilityBudgetReleased, false);
    await service.stop(); await service.start();
    const retained = success(await command('reader', 'READ', {})); assert.deepEqual(retained.accounting, final.accounting); assert.equal(retained.active, null);
    for (const original of [use, secondUse]) { const retainedUse = retained.uses.find((u: any) => u.useId === original.lease.useId); assert.equal(retainedUse.outcome, 'UNKNOWN'); assert.equal(retainedUse.status, 'RECONCILED'); }
    results.push({ id: 'native-S7-uncertain-use-lineage-reconciles-revoked-work-with-retained-liability', status: 'PASS', observed: { uncertain: uncertain.record, wrongOutcome: wrongOutcome.record, substitutedOutcome, reconciled, retained, qualification: 'AUTHENTICATED_REPORTED_UNKNOWN_NATIVE_S7_LINEAGE_NO_PHYSICAL_VERIFICATION_OR_CAUSAL_CREDIT' } });

}
catch (error) {
    results.push({ id: 'native-campaign-contract', status: 'FAIL', error: String(error), stack: (error as Error).stack });
}
finally {
    await service?.stop();
    await ledger?.stop();
    await database.stop();
}
const after = await snapshot(), unchanged = digest(before) === digest(after);
await save({ after, sourcesUnchanged: unchanged, node: process.version });
console.log(JSON.stringify({ out, passed: results.filter(r => r.status === 'PASS').length, failed: results.filter(r => r.status === 'FAIL').length, sourcesUnchanged: unchanged }));
process.exit(results.some(r => r.status === 'FAIL') || !unchanged ? 1 : 0);
