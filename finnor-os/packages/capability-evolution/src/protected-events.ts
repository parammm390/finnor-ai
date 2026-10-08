/** Ordinary lifecycle outbox. S6 alone admits, orders and receipts the events. */
import { digest, fault, makeRef, S8_VERSION } from './contracts';
import type { JournalEntry } from './journal';
import { ownerTransportRoute, signOwnerDeliveryOrigin, deliverOwnerTransportIntent, readOwnerTransportEvent } from '../../governed-execution/src/owner-transport';

interface EventPolicy {
    tenantId: string;
    principalId: string;
    rightsRef: string;
    domain: 'DISPOSABLE_TEST_AUTHORITY' | 'REVIEWED_PROTECTED_DOMAIN';
    validAfter: string;
    protectedEvents: { contract: 'S8_CAPABILITY_EVENTS_V1'; maxRecoveryEvents: number };
}
const kinds: Record<string, string> = { PROPOSE: 'PROPOSAL', ATTEMPT: 'SEARCH', RUN_SEARCH: 'SEARCH', REGISTER: 'REGISTRATION', EVALUATE: 'EVALUATION', ADMIT: 'ADMISSION', ACTIVATE: 'ACTIVATION', REVOKE: 'REVOCATION', USE: 'USE', RECONCILE: 'RECONCILIATION', JOURNAL_RECOVERY: 'RECOVERY', AUTHORITY_PROBE: 'RECOVERY' };
export class ProtectedCapabilityEvents {
    private rows: Array<{ event: any; checkpoint: any; checkpointRef: any; entry: JournalEntry | null }> = [];
    private confirmed = -1;
    private tail: any = null;
    constructor(private policy: EventPolicy, readonly policyDigest: string) { }
    private identity() { return { semanticOwner: 'S8', tenantId: this.policy.tenantId, principalId: this.policy.principalId }; }
    private prepare(entry: JournalEntry | null) {
        const sequence = entry?.sequence ?? 0, previous = this.rows.at(-1)?.event.eventId ?? null;
        const genesis = { schema: 'finnor.s8.lifecycle-genesis.v1', policyDigest: this.policyDigest };
        const entryRef = entry ? makeRef('capability-lifecycle-entry', entry) : null;
        const checkpoint = { schema: 'finnor.s8.lifecycle-checkpoint.v1', policyDigest: this.policyDigest, sequence, entryDigest: entry?.digest ?? digest(genesis), previousDigest: entry?.previous ?? null };
        const checkpointRef = { owner: 'S8', id: `capability-checkpoint:${this.policyDigest}:${sequence}`, version: S8_VERSION, contentDigest: digest(checkpoint) };
        const operation = entry?.operation ?? 'AUTHORITY_PROBE', time = entry?.knowledgeAt ?? this.policy.validAfter;
        const detail = { schema: 'finnor.s8.lifecycle-entry.v1', policyDigest: this.policyDigest, entrySequence: sequence, entryDigest: checkpoint.entryDigest, previousEntryDigest: checkpoint.previousDigest, entryRef, operation, actorId: entry?.actorId ?? 'SIGNED_POLICY_BOOTSTRAP', requestDigest: entry?.requestDigest ?? digest(genesis), sourceEpisodeId: entry?.body?.episodeId ?? 's8-runtime:' + this.policyDigest, executionAuthorityGranted: false, economicCreditGranted: false };
        if (!kinds[operation]) fault('S8_PROTECTED_EVENT_OPERATION_UNSUPPORTED', 503);
        const body = { schema: 'finnor.s8.experience.v1', type: kinds[operation], semanticOwner: 'S8', tenantId: this.policy.tenantId, principalId: this.policy.principalId, rightsRef: this.policy.rightsRef, episodeId: 's8-runtime:' + this.policyDigest, revisionRef: checkpointRef.id, contentDigest: digest(detail), validAt: time, knowledgeAt: time, detail, preparedParentRefs: previous ? [previous] : [], causalParents: previous ? [previous] : [], dependencyRefs: entryRef ? [entryRef.id] : [], provenanceRefs: [], freshnessRefs: [], horizon: 'H0', uncertainty: 'AUTHENTICATED_LIFECYCLE_HISTORY_NO_CAUSAL_OR_VALUE_CREDIT', protectedReceipt: null, appendAuthorityGranted: false, executionAuthorityGranted: false };
        return { event: { ...body, eventId: 's8-event:' + digest(body) }, checkpoint, checkpointRef, entry };
    }
    private async deliver(kind: 'REFERENCE' | 'EVENT', identity: string, payload: any) {
        const scope = this.identity(), route = await ownerTransportRoute(scope);
        if (!route || route.protectionDomain !== this.policy.domain) fault('S8_PROTECTED_EVENT_ROUTE_UNAVAILABLE', 503);
        const signed = await signOwnerDeliveryOrigin(route, { ...scope, kind, identity, payload });
        return deliverOwnerTransportIntent(scope, signed.envelope, signed.signature);
    }
    private async read(row: typeof this.rows[number]) {
        try {
            const accepted = await readOwnerTransportEvent(this.identity(), row.event.eventId);
            if (digest(accepted.event) !== digest(row.event)) fault('S8_PROTECTED_EVENT_SUBSTITUTION', 503);
            return accepted;
        } catch (error) {
            if ((error as any)?.code === 'EVENT_NOT_FOUND') return null;
            throw error;
        }
    }
    /** One cached local chain; at most the signed number of remote gap probes. */
    async recover(entries: JournalEntry[]) {
        if (!this.rows.length) this.rows.push(this.prepare(null));
        if (entries.length + 1 < this.rows.length) fault('S8_PROTECTED_EVENT_LOCAL_ROLLBACK', 503);
        for (let index = this.rows.length - 1; index < entries.length; index++) {
            const entry = entries[index]!;
            if (entry.sequence !== index + 1 || entry.policyDigest !== this.policyDigest) fault('S8_PROTECTED_EVENT_JOURNAL_BINDING_INVALID', 503);
            this.rows.push(this.prepare(entry));
        }
        if (this.confirmed === -1) {
            let probes = 0;
            for (let index = this.rows.length - 1; index >= 0; index--) {
                if (++probes > this.policy.protectedEvents.maxRecoveryEvents) fault('S8_PROTECTED_EVENT_RECOVERY_BOUND', 503);
                const accepted = await this.read(this.rows[index]!);
                if (accepted) { this.confirmed = index; this.tail = accepted; break; }
            }
        } else {
            const accepted = await this.read(this.rows[this.confirmed]!);
            if (!accepted) fault('S8_ACKNOWLEDGED_PROTECTED_EVENT_MISSING', 503);
            this.tail = accepted;
        }
        const missing = this.rows.length - this.confirmed - 1;
        if (missing > this.policy.protectedEvents.maxRecoveryEvents) fault('S8_PROTECTED_EVENT_RECOVERY_BOUND', 503);
        for (let index = this.confirmed + 1; index < this.rows.length; index++) {
            const row = this.rows[index]!;
            await this.deliver('REFERENCE', row.checkpointRef.id, { reference: { ...row.checkpointRef, content: row.checkpoint }, rightsRefs: [this.policy.rightsRef] });
            if (row.entry) {
                const ref = makeRef('capability-lifecycle-entry', row.entry);
                await this.deliver('REFERENCE', ref.id, { reference: { ...ref, content: row.entry }, rightsRefs: [this.policy.rightsRef] });
            }
            await this.deliver('EVENT', row.event.eventId, { event: row.event, references: [] });
            const accepted = await this.read(row);
            if (!accepted) fault('S8_PROTECTED_EVENT_ACKNOWLEDGEMENT_MISSING', 503);
            this.confirmed = index; this.tail = accepted;
        }
        return this.snapshot();
    }
    snapshot() { return { contract: this.policy.protectedEvents.contract, publishedSequence: this.confirmed, eventId: this.tail?.event.eventId ?? null, receipt: this.tail?.receipt ?? null, executionAuthorityGranted: false }; }
}
