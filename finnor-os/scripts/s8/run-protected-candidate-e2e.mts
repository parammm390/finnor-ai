/** Actual compiled, separately launched S6 review candidate; no field authority. */
import { strict as assert } from 'node:assert';
import { generateKeyPairSync, randomBytes, randomUUID, sign, verify } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createEconomicLedger } from '../s7/ledger-fixture.mjs';
import { requiredCapabilitySourcePaths } from '../../packages/capability-evolution/src/source-closure';
import { canonical } from '../../packages/governed-execution/src/protocol';
import { digest, byteDigest, makeRef } from '../../packages/capability-evolution/src/contracts';

const candidate = resolve(process.env.FINNOR_S8_PROTECTED_CANDIDATE ?? '../scope-8/protected-integration-candidate-scoped-events');
const out = resolve(process.env.FINNOR_S8_EVIDENCE_DIR ?? '../scope-8/scope-evidence/protected-integration');
await mkdir(out, { recursive: true });
const manifestPath = join(candidate, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.equal(manifest.status, 'UNSIGNED_NOT_INSTALLED_NOT_DEPLOYED_NOT_ADMITTED');
for (const file of manifest.files) assert.equal(byteDigest(await readFile(join(candidate, file.path))), file.sha256);
for (const [name, sha] of Object.entries(manifest.baseProtectedSourceDigests)) assert.equal(byteDigest(await readFile('packages/governed-execution/src/' + name)), sha);
const directory = join(candidate, 'install/finnor-os/packages/governed-execution/src');
const sourcePaths = [...requiredCapabilitySourcePaths, resolve('scripts/s8/run-protected-candidate-e2e.mts'), resolve('scripts/s7/ledger-fixture.mts'), manifestPath, ...manifest.files.map((f: any) => join(candidate, f.path))];
const snapshot = () => Promise.all([...new Set(sourcePaths)].map(async path => ({ path, sha256: byteDigest(await readFile(path)) })));
const before = await snapshot(), results: any[] = [], startedAt = new Date().toISOString();
async function save(extra: any = {}) { await writeFile(join(out, 'results.json'), JSON.stringify({ schema: 'finnor.s8.protected-candidate-e2e.v1', startedAt, before, results, ...extra, qualification: 'REAL_COMPILED_S6_REVIEW_OVERLAY_WITH_DISPOSABLE_AUTHORITY_ONLY_NO_PRODUCTION_INSTALLATION_SCIENTIFIC_ADMISSION_OR_FIELD_CANARY', rerun: 'FINNOR_S8_PROTECTED_CANDIDATE=<compiled-review-dir> FINNOR_S8_EVIDENCE_DIR=<new-dir> node --import=tsx scripts/s8/run-protected-candidate-e2e.mts' }, null, 2) + '\n'); }
async function check(id: string, fn: () => Promise<any>) { try { results.push({ id, status: 'PASS', observed: await fn() }); } catch (error) { results.push({ id, status: 'FAIL', error: String(error), stack: (error as Error).stack }); } console.log(JSON.stringify({ id, status: results.at(-1).status, error: results.at(-1).error })); await save(); }
const tenant = randomUUID(), principal = randomUUID(), issuer = generateKeyPairSync('ed25519'), issuerPublic = issuer.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privateRoot = await mkdtemp(join(tmpdir(), 'finnor-s8-review-e2e-')), controlledSource = join(privateRoot, 'pinned-method-dependency.json');
const originalSource = canonical({ immutableReviewDependency: true }); await writeFile(controlledSource, originalSource, { mode: 0o600 });
const sourcePins = await Promise.all([...requiredCapabilitySourcePaths, controlledSource].map(async path => ({ path, sha256: byteDigest(await readFile(path)) })));
const journal = generateKeyPairSync('ed25519'), journalPublic = journal.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const journalKeys = [{ policyDigest: digest('DISPOSABLE_S8_RUNTIME_REVIEW_CONTROL'), tenantId: tenant, principalId: principal, rightsRef: 'generated-owner-rights', publicKey: journalPublic, validAfter: new Date(Date.now() - 60000).toISOString(), validUntil: new Date(Date.now() + 3600000).toISOString(), revoked: false }];
const evaluator = generateKeyPairSync('ed25519'), evaluatorId = randomUUID(), evaluatorPublic = evaluator.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const evaluatorKeys = [{ id: 'review-evaluator', principalId: evaluatorId, publicKey: evaluatorPublic, validAfter: new Date(Date.now() - 60000).toISOString(), validUntil: new Date(Date.now() + 3600000).toISOString(), revoked: false }];
const extensions = { capabilityJournalKeys: journalKeys, capabilityEvaluatorKeys: evaluatorKeys, capabilityRevisionContract: 'S8_CAPABILITY_EVENTS_V1', capabilityMethodContract: 'S5_FINITE_ALLOCATION_V1', methodAdmissionPublicKey: issuerPublic, capabilitySourcePins: sourcePins };
let ledger: Awaited<ReturnType<typeof createEconomicLedger>> | null = null;
try {
    ledger = await createEconomicLedger(tenant, principal, randomUUID(), { capabilityLifecycle: true, compiledSubstrate: { sourceDirectory: directory, policyExtensions: extensions } });
    const rights = ledger.rights, now = new Date().toISOString(), policyDigest = digest('DISPOSABLE_S8_RUNTIME_REVIEW_CONTROL');
    function event(sequence: number, operation: string, entryDigest: string, previousEntryDigest: string | null, parentId: string | null) {
        const entryBody = { sequence, previous: previousEntryDigest, policyDigest, requestId: 'review-entry:' + sequence + ':' + entryDigest, requestDigest: digest({ sequence, operation }), actorId: 'SIGNED_ORDINARY_LIFECYCLE', operation, body: { recordSeed: entryDigest, episodeId: 'generated-review-method-episode' }, result: { executionAuthorityGranted: false }, knowledgeAt: now };
        const entryHash = digest(entryBody), entry = sequence ? { ...entryBody, digest: entryHash, signature: sign(null, Buffer.from(canonical({ ...entryBody, digest: entryHash })), journal.privateKey).toString('base64') } : null;
        const entryRef = entry ? makeRef('capability-lifecycle-entry', entry) : null;
        if (entry) entryDigest = entryHash;
        const checkpoint = { schema: 'finnor.s8.lifecycle-checkpoint.v1', policyDigest, sequence, entryDigest, previousDigest: previousEntryDigest }, ref = { owner: 'S8', id: 'capability-checkpoint:' + policyDigest + ':' + sequence, version: 's8-capability-v1', contentDigest: digest(checkpoint) };
        const detail = { schema: 'finnor.s8.lifecycle-entry.v1', policyDigest, entrySequence: sequence, entryDigest, previousEntryDigest, entryRef, operation, actorId: 'SIGNED_ORDINARY_LIFECYCLE', requestDigest: digest({ sequence, operation }), sourceEpisodeId: 'generated-review-method-episode', executionAuthorityGranted: false, economicCreditGranted: false };
        const body = { schema: 'finnor.s8.experience.v1', type: operation === 'AUTHORITY_PROBE' ? 'RECOVERY' : operation === 'PROPOSE' ? 'PROPOSAL' : 'USE', semanticOwner: 'S8', tenantId: tenant, principalId: principal, rightsRef: rights, episodeId: 's8-runtime:' + policyDigest, revisionRef: ref.id, contentDigest: digest(detail), validAt: now, knowledgeAt: now, detail, preparedParentRefs: parentId ? [parentId] : [], causalParents: parentId ? [parentId] : [], dependencyRefs: entryRef ? [entryRef.id] : [], provenanceRefs: [], freshnessRefs: [], horizon: 'H0', uncertainty: 'MECHANICAL_EVENT_HISTORY_NOT_ECONOMIC_VALUE', protectedReceipt: null, appendAuthorityGranted: false, executionAuthorityGranted: false };
        return { ref, checkpoint, entry, entryRef, event: { ...body, eventId: 's8-event:' + digest(body) } };
    }
    const genesis = event(0, 'AUTHORITY_PROBE', digest('probe'), null, null), first = event(1, 'PROPOSE', digest('first-journal-entry'), null, genesis.event.eventId);
    let genesisReceipt: any, firstReceipt: any;
    await check('compiled-S6-typed-S8-append-readback-concurrent-retry-and-physical-restart', async () => {
        await ledger!.publish({ ...genesis.ref, content: genesis.checkpoint });
        const accepted = await ledger!.appendCapability({ event: genesis.event, parents: [], references: [] }); assert.equal(accepted.status, 200, JSON.stringify(accepted)); genesisReceipt = accepted.body.receipt;
        await ledger!.publish({ ...first.ref, content: first.checkpoint });
        await ledger!.publish({ ...first.entryRef!, content: first.entry! });
        const input = { event: first.event, parents: [genesisReceipt], references: [] }, race = await Promise.all(Array.from({ length: 8 }, () => ledger!.appendCapability(input)));
        race.forEach(r => assert.equal(r.status, 200)); firstReceipt = race[0]!.body.receipt; race.forEach(r => assert.deepEqual(r.body.receipt, firstReceipt));
        const read = await ledger!.readCapabilityEvent(first.event.eventId); assert.deepEqual(read.body.event, first.event); assert.equal(read.body.receipt.semanticOwner, 'S8'); assert.equal(read.body.receipt.eventDigest, digest(first.event));
        await ledger!.stop(); await ledger!.start(); const replay = await ledger!.appendCapability(input); assert.deepEqual(replay.body.receipt, firstReceipt);
        return { input, raceReceipts: race.map(r => r.body.receipt), read, restartedReceipt: replay.body.receipt, productionProtectionEstablished: false };
    });
    await check('typed-S8-digest-order-checkpoint-and-authority-substitution-refuse', async () => {
        const denials = [];
        for (const kind of ['ORDER_GAP', 'CHECKPOINT_SUBSTITUTION', 'EXECUTION_AUTHORITY', 'JOURNAL_SIGNATURE']) {
            const row = event({ ORDER_GAP: 3, CHECKPOINT_SUBSTITUTION: 4, EXECUTION_AUTHORITY: 5, JOURNAL_SIGNATURE: 6 }[kind as 'ORDER_GAP'], 'USE', digest(kind), first.event.detail.entryDigest, first.event.eventId);
            if (kind === 'JOURNAL_SIGNATURE') { row.entry!.signature = sign(null, Buffer.from('INVALID_JOURNAL_SIGNATURE_CONTROL'), generateKeyPairSync('ed25519').privateKey).toString('base64'); row.entryRef = makeRef('capability-lifecycle-entry', row.entry!); row.event.detail.entryRef = row.entryRef; row.event.dependencyRefs = [row.entryRef.id]; row.event.contentDigest = digest(row.event.detail); }
            if (kind === 'CHECKPOINT_SUBSTITUTION') row.checkpoint.entryDigest = digest('unrelated-checkpoint');
            if (kind === 'EXECUTION_AUTHORITY') { (row.event as any).executionAuthorityGranted = true; const { eventId, ...body } = row.event; row.event.eventId = 's8-event:' + digest(body); }
            const ref = { ...row.ref, contentDigest: digest(row.checkpoint) }; row.event.revisionRef = ref.id; const { eventId, ...body } = row.event; row.event.eventId = 's8-event:' + digest(body);
            await ledger!.publish({ ...ref, content: row.checkpoint });
            await ledger!.publish({ ...row.entryRef!, content: row.entry! }); const r = await ledger!.appendCapability({ event: row.event, parents: [firstReceipt], references: [] });
            assert.equal(r.body.error, { ORDER_GAP: 'CAPABILITY_EVENT_CHAIN_INVALID', CHECKPOINT_SUBSTITUTION: 'CAPABILITY_EVENT_CHECKPOINT_BINDING_INVALID', EXECUTION_AUTHORITY: 'CAPABILITY_EVENT_AUTHORITY_INVALID', JOURNAL_SIGNATURE: 'CAPABILITY_JOURNAL_SIGNATURE_INVALID' }[kind as 'ORDER_GAP']); denials.push({ kind, r });
        }
        return denials;
    });
    await check('same-runtime-sequence-alternative-events-refuse-before-and-after-restart', async () => {
        const row = event(2, 'USE', digest('one-consecutive-use'), first.event.detail.entryDigest, first.event.eventId);
        await ledger!.publish({ ...row.ref, content: row.checkpoint });
        await ledger!.publish({ ...row.entryRef!, content: row.entry! });
        const alternate = structuredClone(row.event); alternate.uncertainty = 'ALTERNATIVE_VALID_METADATA';
        const { eventId, ...body } = alternate; alternate.eventId = 's8-event:' + digest(body);
        const inputs = [row.event, alternate].map(event => ({ event, parents: [firstReceipt], references: [] }));
        const race = await Promise.all(inputs.map(input => ledger!.appendCapability(input)));
        assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
        const losing = race.findIndex(r => r.status === 409); assert.equal(race[losing]!.body.error, 'CAPABILITY_EVENT_SEQUENCE_IMMUTABLE');
        await ledger!.stop(); await ledger!.start();
        const retried = await ledger!.appendCapability(inputs[losing]); assert.equal(retried.body.error, 'CAPABILITY_EVENT_SEQUENCE_IMMUTABLE');
        return { race, retried, losingEventId: inputs[losing]!.event.eventId };
    });
    await check('foreign-runtime-cannot-reuse-an-enrolled-journal-policy-and-key', async () => {
        const foreignTenant = randomUUID(), foreignPrincipal = randomUUID(), foreign = await createEconomicLedger(foreignTenant, foreignPrincipal, randomUUID(), { capabilityLifecycle: true, compiledSubstrate: { sourceDirectory: directory, policyExtensions: extensions } });
        try {
            const altered = { ...genesis.event, tenantId: foreignTenant, principalId: foreignPrincipal };
            const { eventId, ...body } = altered; altered.eventId = 's8-event:' + digest(body);
            await foreign.publish({ ...genesis.ref, content: genesis.checkpoint });
            const denied = await foreign.appendCapability({ event: altered, parents: [], references: [] });
            assert.equal(denied.body.error, 'CAPABILITY_JOURNAL_AUTHORITY_UNAVAILABLE');
            const missing = await foreign.readCapabilityEvent(altered.eventId); assert.equal(missing.body.error, 'EVENT_NOT_FOUND');
            return { denied, missing, sameJournalPolicyDigest: policyDigest, distinctAuthenticatedTenant: foreignTenant };
        } finally { await foreign.stop(); }
    });
    const body = { schema: 'finnor.capability-revision.v1', tenantId: tenant, principalId: principal, episodeId: 'generated-reviewed-method-control', parents: [], owningInterface: 's5-joint-finite-v1', payload: { schema: 'finnor.s8.allocation-method.v1', algorithm: 'BRANCH_BOUND_EXACT', order: 'VALUE_IMPACT', incumbent: 'FIRST_FEASIBLE', maxPolicies: 8, maximumNodes: 511 }, dependencies: sourcePins, runtime: { node: process.version, platform: process.platform, architecture: process.arch }, experience: { refs: [makeRef('generated-training-control', {})], knowledgeCut: now, trainingCompanies: [], dependenceGroups: [], qualification: 'AUTHENTICATED_OWNER_HISTORY_NO_CAUSAL_REWARD_ASSUMED' }, intendedImprovement: 'GENERATED_STATE_SETUP_ONLY', domain: { owner: 'S5', interface: 's5-joint-finite-v1', maxPolicies: 8, maxPeriods: 8, maxScenarios: 8, strata: ['coupled'], rightsRef: rights, validAfter: new Date(Date.now() - 10000).toISOString(), validUntil: new Date(Date.now() + 3600000).toISOString() }, envelope: { maxAttempts: 8, maxNodes: 511, maxWallMs: 30000, maxHumanSeconds: 900, maxCost: 10, maxDecisionLoss: 5, maxUses: 20 }, proposedAt: now };
    const revisionRef = makeRef('capability-revision', body), evaluation = { schema: 'finnor.s8.evaluation-summary.v1', revisionRef, disposition: 'BENEFICIAL', qualification: 'GENERATIVE_H1', reasons: ['GENERATED_SIGNED_BINDING_CONTROL_NOT_FUTURE_VALUE'] }, evaluationRef = makeRef('capability-evaluation', evaluation), admissionBody = { revisionRef, evaluationRef, payloadDigest: digest(body.payload), dependencyDigest: digest(sourcePins), domain: body.domain, executionAuthorityGranted: false, horizon: 'H1', evaluatorId }, admission = { body: admissionBody, keyId: 'review-evaluator', signature: sign(null, Buffer.from(canonical(admissionBody)), evaluator.privateKey).toString('base64') }, admissionRef = makeRef('capability-admission', admission);
    for (const [ref, content] of [[revisionRef, body], [evaluationRef, evaluation], [admissionRef, admission]] as any[]) await ledger.publish({ ...ref, content });
    const claim = { schema: 'finnor.s8.s5-method-admission.v1', domain: 'DISPOSABLE_TEST_AUTHORITY', tenantId: tenant, principalId: principal, rightsRef: rights, revisionRef, evaluationRef, admissionRef, payloadDigest: digest(body.payload), dependencyDigest: digest(sourcePins), runtimeDigest: digest(body.runtime), validityDomainDigest: digest(body.domain), resourceEnvelopeDigest: digest(body.envelope), validAfter: body.domain.validAfter, validUntil: body.domain.validUntil, executionAuthorityGranted: false };
    const signed = (statement: any, key = issuer.privateKey) => ({ body: statement, signature: sign(null, Buffer.from(canonical(statement)), key).toString('base64') });
    await check('independent-method-root-exact-accepted-bytes-and-fresh-signed-nonce', async () => {
        const input = { revisionRef, methodAdmission: signed(claim), nonce: randomBytes(32).toString('hex') }, r = await ledger!.verifyCapabilityMethod(input); assert.equal(r.status, 200, JSON.stringify(r));
        const { signature, ...assessment } = r.body.assessment; assert.equal(verify(null, Buffer.from(canonical(assessment)), ledger!.publicKey, Buffer.from(signature, 'base64')), true); assert.equal(assessment.nonce, input.nonce); assert.equal(assessment.executionAuthorityGranted, false); assert.equal(assessment.domain, 'DISPOSABLE_TEST_AUTHORITY');
        const role = await ledger!.call('/verify-capability-method', input); assert.equal(role.body.error, 'CAPABILITY_METHOD_VERIFICATION_NOT_AUTHORIZED');
        return { input, r, wrongRole: role, qualification: 'MECHANICAL_SIGNATURE_BINDINGS_ONLY_NO_REAL_METHOD_BENEFIT' };
    });
    await check('method-signature-scope-expiry-source-and-missing-evidence-substitution-refuse', async () => {
        const forgedAdmission = { ...admission, signature: sign(null, Buffer.from(canonical(admissionBody)), generateKeyPairSync('ed25519').privateKey).toString('base64') }, forgedAdmissionRef = makeRef('capability-admission', forgedAdmission);
        await ledger!.publish({ ...forgedAdmissionRef, content: forgedAdmission });
        const cases = [
            { name: 'FORGED_EVALUATOR_WITH_VALID_METHOD_ISSUER', methodAdmission: signed({ ...claim, admissionRef: forgedAdmissionRef }), code: 'CAPABILITY_EVALUATOR_SIGNATURE_INVALID' },
            { name: 'FORGED_ISSUER', methodAdmission: signed(claim, generateKeyPairSync('ed25519').privateKey), code: 'INDEPENDENT_CAPABILITY_METHOD_SIGNATURE_INVALID' },
            { name: 'FOREIGN_TENANT', methodAdmission: signed({ ...claim, tenantId: randomUUID() }), code: 'CAPABILITY_METHOD_SCOPE_INVALID' },
            { name: 'EXPIRED', methodAdmission: signed({ ...claim, validUntil: new Date(Date.now() - 1).toISOString() }), code: 'CAPABILITY_METHOD_EXPIRED_OR_NOT_YET_VALID' },
            { name: 'PAYLOAD_DIGEST', methodAdmission: signed({ ...claim, payloadDigest: digest('unscored') }), code: 'CAPABILITY_METHOD_PAYLOAD_OR_ENVIRONMENT_CHANGED' },
            { name: 'MISSING_EVIDENCE', methodAdmission: signed({ ...claim, evaluationRef: makeRef('capability-evaluation', { uncommitted: true }) }), code: 'CAPABILITY_ACCEPTED_REFERENCE_UNAVAILABLE' },
            { name: 'EXECUTION_AUTHORITY', methodAdmission: signed({ ...claim, executionAuthorityGranted: true }), code: 'CAPABILITY_METHOD_SCOPE_INVALID' }
        ];
        const denials = [];
        for (const row of cases) { const r = await ledger!.verifyCapabilityMethod({ revisionRef, methodAdmission: row.methodAdmission, nonce: randomBytes(32).toString('hex') }); assert.equal(r.body.error, row.code, JSON.stringify(r)); denials.push({ name: row.name, r }); }
        await writeFile(controlledSource, canonical({ substituted: true }), { mode: 0o600 });
        const changed = await ledger!.verifyCapabilityMethod({ revisionRef, methodAdmission: signed(claim), nonce: randomBytes(32).toString('hex') }); assert.equal(changed.body.error, 'CAPABILITY_METHOD_SOURCE_CHANGED'); await writeFile(controlledSource, originalSource, { mode: 0o600 });
        return { denials, changedSource: changed };
    });
    await check('new-compiled-code-without-signed-policy-enablement-retains-legacy-refusal', async () => {
        const disabled = await createEconomicLedger(tenant, principal, randomUUID(), { capabilityLifecycle: true, compiledSubstrate: { sourceDirectory: directory, policyExtensions: {} } });
        try { await disabled.publish({ ...genesis.ref, content: genesis.checkpoint }); const event = await disabled.appendCapability({ event: genesis.event, parents: [], references: [] }), method = await disabled.verifyCapabilityMethod({ revisionRef, methodAdmission: signed(claim), nonce: randomBytes(32).toString('hex') }); assert.equal(event.body.error, 'UNSUPPORTED_PREPARED_EVENT'); assert.equal(method.body.error, 'CAPABILITY_METHOD_CONTRACT_UNADMITTED'); return { event, method }; } finally { await disabled.stop(); }
    });
} finally { await ledger?.stop(); }
const after = await snapshot(), unchanged = digest(before) === digest(after); await save({ after, sourcesUnchanged: unchanged, node: process.version, compiledWithoutTypeScriptRuntimeLoader: true, liveProtectedSourcesUnchanged: true });
console.log(JSON.stringify({ out, passed: results.filter(r => r.status === 'PASS').length, failed: results.filter(r => r.status === 'FAIL').length, sourcesUnchanged: unchanged })); process.exit(results.some(r => r.status === 'FAIL') || !unchanged ? 1 : 0);
