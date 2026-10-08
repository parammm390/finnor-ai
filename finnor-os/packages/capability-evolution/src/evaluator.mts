import { assertCapabilitySourceClosure } from './source-closure';
/** Independently configured evaluator entry point. Candidate IR has no access
 * to this configuration, sealed reference answers, tokens or signing keys. */
import { z } from 'zod';
import { sign, createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { canonical } from '../../governed-execution/src/protocol';
import { resolveEconomicOwnerReference } from '../../governed-execution/src/owner-transport';
import { produceAllocationCandidate } from '../../epistemic-runtime/src/allocation-producer';
import { verifyCanonicalAllocation } from '../../epistemic-runtime/src/allocation-checker';
import { privateFile } from './journal';
import { parseRevision, ProtocolSchema, RefSchema, LifecycleCostSchema, AllocationMethodSchema, digest, byteDigest, fault, type Signed } from './contracts';
import { AdmissionCaseSchema, summarizeAdmission, type ScoredCase } from './evaluation';
import { runAllocationMethodProcess } from './search-process';
const Text = z.string().min(1).max(4096), PolicySchema = z.object({ schema: z.literal('finnor.s8.evaluator-policy.v1'), tenantId: Text, principalId: Text, evaluatorId: Text, keyId: Text, publicKey: Text, keyPath: Text, serviceEndpoint: Text, serviceTokenPath: Text, serviceTokenHash: z.string().regex(/^[a-f0-9]{64}$/), revision: z.unknown(), protocol: ProtocolSchema, sealedCasesRef: RefSchema, permittedDataIssuerIds: z.array(Text).min(1).max(16), costs: LifecycleCostSchema, attemptsDigest: z.string().regex(/^[a-f0-9]{64}$/), failedCandidates: z.number().int().min(0), baselines: z.array(z.object({ id: Text, kind: z.enum(['NATIVE_S5_HIGHS', 'FINITE_METHOD']), payload: AllocationMethodSchema.nullable() }).strict()).min(3).max(32), validAfter: z.string().datetime({ offset: true }), validUntil: z.string().datetime({ offset: true }), sourcePins: z.array(z.object({ path: Text, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(64) }).strict();
const configPath = process.env.FINNOR_S8_EVALUATOR_CONFIG, root = process.env.FINNOR_S8_EVALUATOR_ROOT;
if (!configPath || !root)
    fault('S8_INDEPENDENT_EVALUATOR_CONFIGURATION_REQUIRED', 503);
if (process.env.FINNOR_S8_CONSUMER_CONFIG)
    fault('S8_FIXED_BASELINE_HAS_MUTABLE_CAPABILITY_ROUTE', 503);
const signedConfig = JSON.parse((await privateFile(configPath)).toString()) as Signed<unknown>, p = PolicySchema.parse(signedConfig.body), r = parseRevision(p.revision);
if (!verify(null, Buffer.from(canonical(p)), root, Buffer.from(signedConfig.signature, 'base64')) || Date.now() < Date.parse(p.validAfter) || Date.now() >= Date.parse(p.validUntil) || p.evaluatorId === r.principalId || p.protocol.evaluatorId !== p.evaluatorId || digest(p.protocol.revisionRef) !== digest(r.ref) || p.tenantId !== r.tenantId || p.principalId !== r.principalId)
    fault('S8_INDEPENDENT_EVALUATOR_AUTHORITY_BINDING', 403);
await assertCapabilitySourceClosure(p.sourcePins);
for (const pin of p.sourcePins) {
    const fd = await open(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const st = await fd.stat();
        if (!st.isFile() || st.size > 16 * 1024 * 1024 || byteDigest(await fd.readFile()) !== pin.sha256)
            fault('S8_EVALUATOR_SOURCE_PIN_CHANGED');
    }
    finally {
        await fd.close();
    }
}
if (digest(p.sourcePins) !== p.protocol.harnessDigest || p.baselines.length !== p.protocol.baselines.length || p.baselines.some(b => !p.protocol.baselines.some(v => v.id === b.id && v.payloadDigest === digest(b.kind === 'FINITE_METHOD' ? b.payload : { route: 'NATIVE_S5_HIGHS', sourcePins: p.sourcePins }) && v.dependencyDigest === digest(p.sourcePins) && v.resourceEnvelopeDigest === digest(r.envelope))))
    fault('S8_EVALUATOR_BASELINE_OR_HARNESS_SUBSTITUTION');
const key = createPrivateKey(await privateFile(p.keyPath));
if (key.asymmetricKeyType !== 'ed25519' || createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString() !== p.publicKey)
    fault('S8_EVALUATOR_SIGNER_SUBSTITUTION', 403);
const token = await privateFile(p.serviceTokenPath, 4096);
if (byteDigest(token) !== p.serviceTokenHash)
    fault('S8_EVALUATOR_SERVICE_TOKEN_CHANGED', 403);
const url = new URL(p.serviceEndpoint);
if (url.origin !== p.serviceEndpoint || url.username || url.password || !['https:', 'http:'].includes(url.protocol) || url.protocol === 'http:' && !['127.0.0.1', '[::1]'].includes(url.hostname))
    fault('S8_EVALUATOR_ENDPOINT_UNSUPPORTED');
const seal = (body: any) => ({ body, keyId: p.keyId, signature: sign(null, Buffer.from(canonical(body)), key).toString('base64') });
async function command(operation: string, body: any) {
    const requestId = 'evaluator:' + operation + ':' + digest(body), res = await fetch(p.serviceEndpoint + '/command', { method: 'POST', headers: { authorization: 'Bearer ' + token.toString(), 'content-type': 'application/json' }, body: canonical({ operation, body, requestId }), redirect: 'error', signal: AbortSignal.timeout(30000) });
    const data = await res.json() as any;
    if (!res.ok)
        fault(data.code ?? 'S8_EVALUATOR_LIFECYCLE_DENIED', res.status);
    return data;
}
await command('REGISTER', seal(p.protocol));
const sealed = await resolveEconomicOwnerReference({ semanticOwner: 'S8', tenantId: p.tenantId, principalId: p.principalId }, p.sealedCasesRef, { purpose: 'CONSUMER', rightsRef: r.domain.rightsRef, allowedPrincipalIds: p.permittedDataIssuerIds });
if (sealed.receipt.sealed !== true)
    fault('S8_ADMISSION_DATA_NOT_SEALED');
const bundle = z.object({ schema: z.literal('finnor.s8.sealed-admission-cases.v1'), scoringAssetsDigest: z.string(), splitDigest: z.string(), cases: z.array(AdmissionCaseSchema).min(1).max(4096) }).strict().parse(sealed.reference.content);
if (bundle.scoringAssetsDigest !== p.protocol.scoringAssetsDigest || bundle.splitDigest !== p.protocol.splitDigest || bundle.cases.length !== p.protocol.caseCommitments.length || bundle.cases.some(c => !p.protocol.caseCommitments.includes(digest(c))))
    fault('S8_SEALED_EVALUATION_MANIFEST_SUBSTITUTION');
const rows: ScoredCase[] = [];
for (const c of bundle.cases) {
    if (Date.parse(c.knowledgeAt) < Date.parse(p.protocol.chronologicalStart) || Date.parse(c.knowledgeAt) > Date.parse(p.protocol.chronologicalEnd))
        fault('S8_EVALUATION_CHRONOLOGY_INVALID');
    if (c.reference.optimum === null)
        fault('S8_EXACT_REFERENCE_ORACLE_UNRESOLVED', 503);
    const problem = c.problem as any;
    if (problem.tenantId !== p.tenantId || problem.principalId !== p.principalId || problem.mandate.rightsRef !== r.domain.rightsRef || problem.methodVersion !== r.domain.interface || problem.policies.length > r.domain.maxPolicies || problem.mandate.horizon.periods > r.domain.maxPeriods || problem.jointModel.scenarios.length > r.domain.maxScenarios || problem.mandate.search.maxExpansions > r.envelope.maxNodes || problem.mandate.search.deadlineMs > r.envelope.maxWallMs)
        fault('S8_EVALUATOR_CASE_AUTHORITY_OR_RESOURCE_DOMAIN');
    const measure = async (payload: any) => {
        try {
            const result = await runAllocationMethodProcess(problem, payload, { deadlineAt: performance.now() + problem.mandate.search.deadlineMs, maxExpansions: problem.mandate.search.maxExpansions });
            return { correct: result.complete && result.objective === c.reference.optimum && result.check?.feasible === true, failure: result.complete ? null : 'REGISTERED_SEARCH_EXHAUSTED' };
        }
        catch {
            return { correct: false, failure: 'CANDIDATE_RUNTIME_FAILURE' };
        }
    };
    const candidate = await measure(r.payload), metrics = (correct: boolean) => ({ ...c.reference.metrics, correctness: correct ? 1 : 0, regret: correct ? c.reference.metrics.regret : 1, decisionValue: correct ? c.reference.metrics.decisionValue : [c.reference.metrics.decisionValue[1] - p.protocol.scoreRange, c.reference.metrics.decisionValue[1] - p.protocol.scoreRange] as [
            number,
            number
        ] });
    const baselines: ScoredCase['baselines'] = {};
    for (const b of p.baselines) {
        if (b.kind === 'FINITE_METHOD') {
            if (!b.payload)
                fault('S8_BASELINE_PAYLOAD_MISSING');
            baselines[b.id] = metrics((await measure(b.payload)).correct);
        }
        else {
            const fixed = await produceAllocationCandidate(problem, performance.now() + problem.mandate.search.deadlineMs), checked = fixed.selectedPolicyIds === null ? null : verifyCanonicalAllocation(problem, fixed.selectedPolicyIds);
            if (fixed.compute.backend.sourceDigests.some(pin => !p.sourcePins.some(expected => expected.path === pin.path && expected.sha256 === pin.sha256)))
                fault('S8_NATIVE_BASELINE_DEPENDENCY_CLOSURE_UNPINNED');
            baselines[b.id] = metrics(checked?.feasible === true && checked.objective === c.reference.optimum);
        }
    }
    rows.push({ caseCommitment: digest(c), company: c.company, dependenceGroup: c.dependenceGroup, stratum: c.stratum, priorDomain: c.priorDomain, candidate: metrics(candidate.correct), baselines, failure: candidate.failure });
}
const report = summarizeAdmission(p.protocol, rows, p.costs, p.attemptsDigest, p.failedCandidates), result = await command('EVALUATE', seal(report));
// Preregistered aggregate disclosure only. Individual cases, reference answers,
// provider/evaluator credentials and keys never enter ordinary result artifacts.
process.stdout.write(canonical({ schema: 'finnor.s8.evaluator-result.v1', report, evaluationRef: result.ref, sealedManifestRef: p.sealedCasesRef, protectedReferenceDomain: sealed.protectionDomain, productionIndependenceEstablished: false, independenceQualification: 'DATA_ACCESS_AND_SIGNER_AUTHENTICATED; EVALUATOR_RUNTIME_OS_KEY_PRIVILEGE_AND_DISCLOSURE_SUBSTRATE_REQUIRE_INDEPENDENT_RELEASE_EVIDENCE', methodAdmissionGranted: false }) + '\n');
