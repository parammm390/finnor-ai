import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AllocationResource } from '@finnor/shared-types';
import { boundedJSON, digest, requireZ1 } from './contracts.js';
import { Z1_PORTFOLIO } from './portfolio-population.js';

export const PORTFOLIO_STREAM = Object.freeze({
  schema: 'finnor.s5.z1.occupation-stream.v1', frameBytes: 65536, fetchFrames: 64, pageBytes: 8388608,
});
const text = z.string().min(1).max(256), hex = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().safe().nonnegative();
const reference = z.object({ owner: text, id: text, version: text, contentDigest: hex }).strict();
const scope = z.object({ tenantId: z.string().uuid(), principalId: z.string().uuid(),
  transactionId: z.string().regex(/^[0-9]{1,20}$/), rightsRevision: z.string().regex(/^[0-9]{1,20}$/) }).strict();
const counts = z.object({ resources: integer.max(16), reservations: integer.max(1256),
  originals: integer.max(1000), other: integer.max(256), envelopes: integer.max(8096), items: integer.max(9368) }).strict();
const manifest = z.object({ kind: z.literal('MANIFEST'), schema: z.literal(PORTFOLIO_STREAM.schema),
  scope, fence: hex, counts, membersDigest: hex, selectedResourceIds: z.array(text).max(16),
  settlement: z.literal('UNKNOWN_UNINSPECTED') }).strict();
const data = z.object({ kind: z.literal('DATA'), fence: hex, sequence: integer,
  payloadText: z.string().min(1).max(PORTFOLIO_STREAM.frameBytes), payloadDigest: hex }).strict();
const seal = z.object({ kind: z.literal('SEAL'), fence: hex, sequence: integer,
  counts, membersDigest: hex }).strict();
const frame = z.discriminatedUnion('kind', [manifest, data, seal]);
const resourceRecord = z.object({ tag: z.literal('RESOURCE'), resourceId: text, reference,
  horizonDigest: hex, kind: text, unit: text }).strict();
const reservationRecord = z.object({ tag: z.literal('RESERVATION'), reservationRef: reference,
  certificateRef: reference.nullable(), demandRef: reference.nullable(), originalKey: hex.nullable(),
  population: z.enum(['ORIGINAL', 'OTHER']), revision: integer, envelopeCount: integer.max(16),
  status: z.enum(['RESERVED', 'CONSUMPTION_PENDING', 'UNKNOWN_OUTCOME', 'PARTIALLY_RECONCILED', 'SETTLED_RETAINED']) }).strict();
const envelopeRecord = z.object({ tag: z.literal('ENVELOPE'), reservationId: text, ordinal: integer.max(16),
  resourceId: text, kind: text, unit: text, horizonDigest: hex, envelopeDigest: hex,
  quantityCount: integer, opaque: z.boolean(), valid: z.boolean(),
  quantities: z.array(z.string().max(16)).max(65).nullable(),
  minimumQuantities: z.array(z.string().max(16)).max(65).nullable() }).strict();
const record = z.discriminatedUnion('tag', [resourceRecord, reservationRecord, envelopeRecord]);
export type PortfolioStreamScope = z.infer<typeof scope>;
type Manifest = z.infer<typeof manifest>;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const ordered = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b)) < 0;
const nonnegative = (value: string) => {
  requireZ1(/^(?:0|[1-9][0-9]{0,15})$/.test(value), 'Z1_S5_NONNEGATIVE_INTEGER_OCCUPATION_REQUIRED', 'INCOMPLETE');
  return BigInt(value);
};

/** A capacity projection, not a replacement reservation or S6 settlement.
 * No capacity is returned before the complete manifest, members and seal agree. */
export class OriginalPortfolioStream {
  private manifest: Manifest | null = null;
  private sealed = false;
  private members = createHash('sha256');
  private sequence = 0;
  private observed = { resources: 0, reservations: 0, originals: 0, other: 0, envelopes: 0, items: 0 };
  private resourcesSeen = new Set<string>();
  private reservationsSeen = new Set<string>();
  private originalsSeen = new Set<string>();
  private lastResource: string | null = null;
  private lastReservation: string | null = null;
  private current: { header: z.infer<typeof reservationRecord>; read: number; resources: Set<string> } | null = null;
  private selected = new Map<string, { resource: AllocationResource; requested: string; use: bigint[] }>();
  constructor(private expectedScope: PortfolioStreamScope, resources: readonly AllocationResource[],
    requested: Readonly<Record<string, string>>) {
    requireZ1(scope.safeParse(expectedScope).success && resources.length > 0 && resources.length <= Z1_PORTFOLIO.resources &&
      new Set(resources.map(r => r.resourceId)).size === resources.length &&
      digest(Object.keys(requested).sort()) === digest(resources.map(r => r.resourceId).sort()),
    'Z1_NATIVE_PORTFOLIO_SELECTION_REQUIRED', 'INCOMPLETE');
    for (const resource of resources) {
      const length = resource.horizon.periods + 1;
      requireZ1(Number.isSafeInteger(length) && length >= 2 && length <= Z1_PORTFOLIO.periods + 1 &&
        ['CUMULATIVE_EXPENDITURE', 'OCCUPANCY'].includes(resource.kind) &&
        resource.existingUse.length === length && resource.availability.length === length,
      'Z1_S5_COMPLETE_RESOURCE_PERIODS_REQUIRED', 'INCOMPLETE');
      nonnegative(requested[resource.resourceId]!);
      this.selected.set(resource.resourceId, { resource, requested: requested[resource.resourceId]!,
        use: resource.existingUse.map(nonnegative) });
    }
  }
  private completeReservation() {
    requireZ1(!this.current || this.current.read === this.current.header.envelopeCount,
      'Z1_PORTFOLIO_TRUNCATED_RESERVATION', 'INCOMPLETE');
  }
  accept(value: unknown): void {
    boundedJSON(value, PORTFOLIO_STREAM.frameBytes);
    const parsed = frame.safeParse(value);
    requireZ1(parsed.success && !this.sealed, 'Z1_PORTFOLIO_FRAME_REQUIRED', 'INCOMPLETE');
    const item = parsed.data;
    if (item.kind === 'MANIFEST') {
      requireZ1(!this.manifest && digest(item.scope) === digest(this.expectedScope) &&
        item.fence === digest(item.scope) &&
        digest(item.selectedResourceIds) === digest([...this.selected.keys()].sort()) &&
        item.counts.reservations === item.counts.originals + item.counts.other &&
        item.counts.items === item.counts.resources + item.counts.reservations + item.counts.envelopes,
      'Z1_PORTFOLIO_MANIFEST_SCOPE_OR_COUNTS', 'INCOMPLETE');
      this.manifest = item; return;
    }
    requireZ1(this.manifest && item.fence === this.manifest.fence && item.sequence === ++this.sequence,
      'Z1_PORTFOLIO_SNAPSHOT_OR_SEQUENCE_CHANGED', 'INCOMPLETE');
    if (item.kind === 'SEAL') {
      this.completeReservation();
      requireZ1(digest(item.counts) === digest(this.manifest.counts) &&
        digest(this.observed) === digest(this.manifest.counts) && item.membersDigest === this.manifest.membersDigest &&
        this.members.digest('hex') === item.membersDigest &&
        [...this.selected.keys()].every(id => this.resourcesSeen.has(id)),
      'Z1_PORTFOLIO_INCOMPLETE_OR_CHANGED', 'INCOMPLETE');
      this.sealed = true; return;
    }
    requireZ1(this.observed.items < this.manifest.counts.items && sha(item.payloadText) === item.payloadDigest,
      'Z1_PORTFOLIO_MEMBER_DIGEST_CHANGED', 'INCOMPLETE');
    let payload: unknown;
    try { payload = JSON.parse(item.payloadText); } catch { payload = null; }
    const decoded = record.safeParse(payload);
    requireZ1(decoded.success, 'Z1_PORTFOLIO_MEMBER_REQUIRED', 'INCOMPLETE');
    const member = decoded.data;
    this.members.update(item.payloadDigest); this.observed.items++;
    if (member.tag === 'RESOURCE') {
      requireZ1(this.observed.resources < this.manifest.counts.resources &&
        !this.current && !this.reservationsSeen.size && !this.resourcesSeen.has(member.resourceId) &&
        (!this.lastResource || ordered(this.lastResource, member.resourceId)),
      'Z1_PORTFOLIO_RESOURCE_ORDER_OR_DUPLICATE', 'INCOMPLETE');
      const selected = this.selected.get(member.resourceId);
      if (selected) requireZ1(digest(member.reference) === digest(selected.resource.ref) &&
        member.kind === selected.resource.kind && member.unit === selected.resource.unit &&
        member.horizonDigest === digest(selected.resource.horizon),
      'Z1_PORTFOLIO_RESOURCE_HEAD_CHANGED', 'INCOMPLETE');
      this.lastResource = member.resourceId; this.resourcesSeen.add(member.resourceId); this.observed.resources++; return;
    }
    if (member.tag === 'RESERVATION') {
      this.completeReservation();
      const ref = member.reservationRef, certificate = member.certificateRef;
      const native = ref.owner === 'S5' && ref.version === 'z1-native-owner-v1' &&
        ref.id === `z1-original-budget:${ref.contentDigest}` && certificate?.owner === 'S5' &&
        certificate.version === ref.version && certificate.id === `z1-original-certificate:${certificate.contentDigest}`;
      requireZ1(this.observed.reservations < this.manifest.counts.reservations &&
        this.observed.resources === this.manifest.counts.resources &&
        !this.reservationsSeen.has(ref.id) && (!this.lastReservation || ordered(this.lastReservation, ref.id)) &&
        (member.population === 'ORIGINAL' ? native && member.originalKey && !member.demandRef && member.envelopeCount === 4 :
          !native && !ref.id.startsWith('z1-original-budget:') && !member.originalKey &&
          Boolean(member.certificateRef) !== Boolean(member.demandRef)),
      'Z1_PORTFOLIO_ORIGINAL_OR_MEMBERSHIP_CHANGED', 'INCOMPLETE');
      if (member.population === 'ORIGINAL') {
        requireZ1(!this.originalsSeen.has(member.originalKey!), 'Z1_PORTFOLIO_DUPLICATE_ORIGINAL', 'INCOMPLETE');
        this.originalsSeen.add(member.originalKey!); this.observed.originals++;
      } else this.observed.other++;
      this.observed.reservations++; this.reservationsSeen.add(ref.id); this.lastReservation = ref.id;
      this.current = { header: member, read: 0, resources: new Set() }; return;
    }
    requireZ1(this.current && member.reservationId === this.current.header.reservationRef.id &&
      member.ordinal === this.current.read + 1 && this.current.read < this.current.header.envelopeCount && member.valid,
    'Z1_PORTFOLIO_ENVELOPE_ORDER_OR_INVALID', 'INCOMPLETE');
    if (this.current.header.population === 'ORIGINAL') {
      requireZ1(!this.current.resources.has(member.resourceId), 'Z1_PORTFOLIO_DUPLICATE_ORIGINAL_RESOURCE', 'INCOMPLETE');
      this.current.resources.add(member.resourceId);
    }
    this.current.read++; this.observed.envelopes++;
    const selected = this.selected.get(member.resourceId);
    requireZ1(member.opaque === !selected && (selected || member.quantities === null && member.minimumQuantities === null),
      'Z1_PORTFOLIO_OPAQUE_SELECTION_CHANGED', 'INCOMPLETE');
    if (!selected) return; // Retained and committed opaque witness, never zero occupation for a selected resource.
    const { resource, use } = selected;
    requireZ1(member.horizonDigest === digest(resource.horizon) && member.kind === resource.kind &&
      member.unit === resource.unit && member.quantityCount === use.length &&
      member.quantities?.length === use.length && member.minimumQuantities?.length === use.length,
    'Z1_S5_COMPLETE_SHARED_HORIZON_REQUIRED', 'INCOMPLETE');
    for (let period = 0; period < use.length; period++) {
      const quantity = nonnegative(member.quantities[period]!), minimum = nonnegative(member.minimumQuantities[period]!);
      requireZ1(minimum <= quantity, 'Z1_S5_INVALID_OCCUPATION_INTERVAL', 'INCOMPLETE');
      use[period] = use[period]! + quantity;
    }
  }
  finish() {
    requireZ1(this.sealed && this.manifest, 'Z1_PORTFOLIO_TERMINAL_SEAL_REQUIRED', 'INCOMPLETE');
    const capacity: Record<string, { resourceId: string; requested: string; occupation: string[]; semantics: string }> = Object.create(null);
    for (const [id, { resource, requested, use }] of this.selected) {
      const request = nonnegative(requested), margin = nonnegative(resource.safetyMargin), occupation: string[] = [];
      let prefix = 0n;
      for (let period = 0; period < use.length; period++) {
        prefix = resource.kind === 'OCCUPANCY' ? use[period]! : prefix + use[period]!;
        const available = resource.availability[period]!;
        requireZ1(available.amount !== null && available.basis === 'REPORTED_AVAILABLE',
          'Z1_S5_AVAILABLE_CAPACITY_UNKNOWN', 'INCOMPLETE');
        requireZ1(prefix + request <= nonnegative(available.amount) - margin, 'Z1_SHARED_S5_RESOURCE_EXHAUSTED', 'INCOMPLETE');
        occupation.push(prefix.toString());
      }
      capacity[id] = { resourceId: id, requested, occupation,
        semantics: resource.kind === 'OCCUPANCY' ? 'PER_PERIOD_OCCUPANCY' : 'CUMULATIVE_PREFIX' };
    }
    const receipt = { schema: PORTFOLIO_STREAM.schema, scope: this.manifest.scope, counts: this.observed,
      membersDigest: this.manifest.membersDigest, selectedResourceIds: [...this.selected.keys()].sort(),
      settlement: 'UNKNOWN_UNINSPECTED', capacity };
    boundedJSON(receipt, PORTFOLIO_STREAM.pageBytes);
    return { ...receipt, snapshotDigest: digest(receipt) };
  }
}
