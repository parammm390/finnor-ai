import { assertCapabilitySourceClosure } from './source-closure';
/** Signed native campaign runner. This process has proposer/read privileges only. */
import { z } from 'zod';
import { verify } from 'node:crypto';
import { canonical } from '../../governed-execution/src/protocol';
import { privateFile } from './journal';
import { RevisionBodySchema, RefSchema, digest, byteDigest, fault, type Signed } from './contracts';
import { prepareNativeCapabilityRevisions, readNativeCapabilitySearchAllocation } from './proposer';
import { closePool } from '../../db/index';
const Text = z.string().min(1).max(4096);
const PolicySchema = z.object({ schema: z.literal('finnor.s8.proposer-policy.v1'), tenantId: Text, principalId: Text, domain: z.literal('DISPOSABLE_TEST_AUTHORITY'), template: RevisionBodySchema, assessmentRef: RefSchema, allocationRef: RefSchema, limitations: z.array(z.object({ kind: z.enum(['SEARCH_EXHAUSTED', 'HIGH_COST', 'FORGETTING', 'UNKNOWN_OUTCOME']), evidenceRef: RefSchema }).strict()).min(1).max(64), maximumCandidates: z.number().int().min(1).max(8), reservedCostPerAttempt: z.number().finite().min(0), endpoint: Text, tokenPath: Text, tokenHash: z.string().regex(/^[a-f0-9]{64}$/), validAfter: z.string().datetime({ offset: true }), validUntil: z.string().datetime({ offset: true }) }).strict();
const config = process.env.FINNOR_S8_PROPOSER_CONFIG, root = process.env.FINNOR_S8_PROPOSER_ROOT;
if (!config || !root)
    fault('S8_SIGNED_NATIVE_PROPOSER_CONFIGURATION_REQUIRED', 503);
const signed = JSON.parse((await privateFile(config)).toString()) as Signed<unknown>, p = PolicySchema.parse(signed.body);
if (!verify(null, Buffer.from(canonical(p)), root, Buffer.from(signed.signature, 'base64')) || Date.now() < Date.parse(p.validAfter) || Date.now() >= Date.parse(p.validUntil) || p.template.tenantId !== p.tenantId || p.template.principalId !== p.principalId)
    fault('S8_NATIVE_PROPOSER_POLICY_BINDING', 403);
await assertCapabilitySourceClosure(p.template.dependencies);
const token = await privateFile(p.tokenPath, 4096);
if (byteDigest(token) !== p.tokenHash)
    fault('S8_NATIVE_PROPOSER_TOKEN_SUBSTITUTION');
const url = new URL(p.endpoint);
if (url.origin !== p.endpoint || url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
    fault('S8_NATIVE_PROPOSER_ENDPOINT');
const ctx: any = { auth: { tenantId: p.tenantId, userId: p.principalId, employeeId: p.principalId, role: 'owner' } };
async function command(operation: string, body: unknown) {
    const requestId = 'native-campaign:' + digest(p) + ':' + operation + ':' + digest(body);
    const response = await fetch(p.endpoint + '/command', { method: 'POST', headers: { authorization: 'Bearer ' + token.toString(), 'content-type': 'application/json' }, body: canonical({ requestId, operation, body }), redirect: 'error', signal: AbortSignal.timeout(45000) });
    if (!response.body)
        fault('S8_NATIVE_PROPOSER_EMPTY_RESPONSE');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        for (;;) {
            const part = await reader.read();
            if (part.done)
                break;
            bytes += part.value.length;
            if (bytes > 2 * 1024 * 1024)
                fault('S8_NATIVE_PROPOSER_RESPONSE_BOUND');
            chunks.push(part.value);
        }
    }
    finally {
        await reader.cancel();
    }
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!response.ok)
        fault(value.code ?? 'S8_NATIVE_PROPOSER_DENIED', response.status);
    return value;
}
try {
    const prepared = await prepareNativeCapabilityRevisions(ctx, { template: p.template, assessmentRef: p.assessmentRef, limitations: p.limitations, maximumCandidates: p.maximumCandidates });
    const allocation = await readNativeCapabilitySearchAllocation(ctx, p.allocationRef), attempts = [];
    for (const revision of prepared.revisions) {
        await command('PROPOSE', revision);
        // Current native S5 owner is re-read for each run; a revoked or modified
        // reservation cannot become a fresh unaccounted search allocation.
        await readNativeCapabilitySearchAllocation(ctx, p.allocationRef);
        const result = await command('RUN_SEARCH', { revisionRef: revision.ref, allocationRef: allocation.allocationRef, problemRef: allocation.problemRef, reservedCost: p.reservedCostPerAttempt });
        attempts.push({ revisionRef: revision.ref, result });
    }
    process.stdout.write(canonical({ schema: 'finnor.s8.native-campaign-result.v1', campaignDigest: digest(p), experienceCutDigest: prepared.history.cutDigest, experienceRefs: prepared.history.refs, futureKnowledgeExcluded: prepared.history.futureKnowledgeExcluded, historyQualification: prepared.history.qualification, allocation, attempts, costs: 'UNKNOWN_UNTIL_INDEPENDENT_BILLING', independentAdmissionGranted: false, activationGranted: false }) + '\n');
}
finally {
    await closePool();
}
