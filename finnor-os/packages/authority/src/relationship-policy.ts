import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenantTransaction } from "@finnor/db";
import { RelationshipPolicySchema, type RelationshipPolicy, type VReference } from "@finnor/shared-types";
import { canonical, digest } from "../../governed-execution/src/canonical";

export interface ContactIntent {
  id: string; tenant_id: string; principal_id: string; work_id: string; programme_owner: string;
  programme_id: string; candidate_id: string; company_id: string; counterparty_id: string;
  action_id: string; member_key: string; channel: string; subject_keys: string[];
  activity_binding: Record<string, unknown>; payload: Record<string, unknown>; payload_digest: string;
  terms_digest: string; terms_revision: number; kind: string; policy_id: string; policy_revision: number;
  status: string; possible_egress_at: Date | null; created_at: Date;
}
export const relationshipLock = (c: PoolClient, tenantId: string) => c.query(
  "SELECT pg_advisory_xact_lock(hashtextextended($1,6))", [`s6-relationships:${tenantId}`]);

/** Read the whole connected identity component. Alias corrections cannot reset
 * earlier contact counts or remove the original suppression record. */
export async function relationshipSubjects(c: PoolClient, tenantId: string, seeds: string[]): Promise<string[]> {
  const rows = (await c.query<{ subject: string }>(`WITH RECURSIVE subjects(subject) AS (
    SELECT unnest($2::text[]) UNION
    SELECT CASE WHEN a.subject_key=s.subject THEN a.canonical_key ELSE a.subject_key END
    FROM subjects s JOIN finnor_os.s6_relationship_aliases a ON a.tenant_id=$1
      AND (a.subject_key=s.subject OR a.canonical_key=s.subject)
  ) SELECT subject FROM subjects ORDER BY subject LIMIT 257`, [tenantId, seeds])).rows;
  if (rows.length > 256) throw Error("S6_RELATIONSHIP_IDENTITY_CLOSURE_BOUND");
  return rows.map(row => row.subject);
}
export const endpointSubject = (tenantId: string, endpoint: string) => `endpoint:${digest(`${tenantId}:${endpoint.trim().toLowerCase()}`)}`;
export async function currentRelationshipPolicies(c: PoolClient, tenantId: string, channel: string): Promise<RelationshipPolicy[]> {
  const rows = (await c.query(`SELECT v.body FROM finnor_os.primary_governance_versions v
    JOIN finnor_os.primary_governance_heads h USING(tenant_id,id,revision)
    WHERE v.tenant_id=$1 AND v.schema_name='finnor.relationship-policy.v1' AND h.state='CURRENT'
      AND v.body->>'channel'=$2 ORDER BY v.id LIMIT 33 FOR SHARE OF h`, [tenantId, channel])).rows;
  if (rows.length > 32) throw Error("S6_SHARED_RELATIONSHIP_POLICY_BOUND");
  const policies = rows.map(row => RelationshipPolicySchema.parse(row.body));
  if (policies.some(p => Date.now() < Date.parse(p.validFrom) || Date.now() >= Date.parse(p.expiresAt))) throw Error("S6_RELATIONSHIP_POLICY_EXPIRED");
  return policies;
}
export async function checkRelationshipSuppression(c: PoolClient, tenantId: string,
  input: { companyId: string; personId: string; endpoint?: string }) {
  const subjects = await relationshipSubjects(c, tenantId, [
    `company:${input.companyId}`, `person:${input.personId}`,
    ...(input.endpoint ? [endpointSubject(tenantId, input.endpoint)] : []),
  ]);
  const suppression = (await c.query(`SELECT id FROM finnor_os.s6_relationship_events
    WHERE tenant_id=$1 AND kind IN('REFUSAL','OPT_OUT','WITHDRAWAL') AND subject_keys&&$2::text[] LIMIT 1`,
  [tenantId, subjects])).rows[0];
  if (suppression) throw Error("S6_FIRM_WIDE_CONTACT_SUPPRESSED");
  return subjects;
}
export async function checkRelationshipContact(c: PoolClient, tenantId: string, intent: ContactIntent, endpoint?: string) {
  const subjects = await checkRelationshipSuppression(c, tenantId, {
    companyId: intent.company_id, personId: intent.counterparty_id, endpoint,
  });
  const held = (await c.query<ContactIntent>(`SELECT * FROM finnor_os.s6_contact_intents
    WHERE tenant_id=$1 AND channel=$2 AND status<>'CANCELLED_BEFORE_DISPATCH' AND id<>$3
    ORDER BY created_at LIMIT 65537`, [tenantId, intent.channel, intent.id])).rows;
  if (held.length > 65536) throw Error("S6_CONTACT_ACCOUNTING_COVERAGE_BOUND");
  const related = held.filter(row => row.subject_keys.some(key => subjects.includes(key)));
  const companySubjects = await relationshipSubjects(c, tenantId, [`company:${intent.company_id}`]);
  const personSubjects = await relationshipSubjects(c, tenantId, [
    `person:${intent.counterparty_id}`, ...(endpoint ? [endpointSubject(tenantId, endpoint)] : []),
  ]);
  for (const policy of await currentRelationshipPolicies(c, tenantId, intent.channel)) {
    if (held.length >= policy.totalMaximumContacts ||
        held.filter(row => row.subject_keys.some(key => companySubjects.includes(key))).length >= policy.companyMaximumContacts ||
        held.filter(row => row.subject_keys.some(key => personSubjects.includes(key))).length >= policy.personMaximumContacts) throw Error("S6_ORIGINAL_SHARED_CONTACT_CAP_EXHAUSTED");
    const last = related.map(row => row.possible_egress_at?.getTime() ?? row.created_at.getTime()).sort((a, b) => b - a)[0];
    if (last !== undefined && Date.now() - last < policy.minimumSpacingMs) throw Error("S6_ORIGINAL_CONTACT_SPACING_WAIT");
  }
  for (const other of related.filter(row => row.programme_id !== intent.programme_id || row.programme_owner !== intent.programme_owner)) {
    const live = other.programme_owner === "V1"
      ? (await c.query(`SELECT id FROM finnor_os.v1_programmes WHERE tenant_id=$1 AND id=$2
          AND status IN('PROGRESS','WAITING','RECONCILING') AND cancellation_requested_at IS NULL`,
        [tenantId, other.programme_id])).rows[0]
      : ["INTENDED", "AUTHORIZED", "POSSIBLE_EGRESS", "UNKNOWN"].includes(other.status);
    if (live) throw Error("S6_DUPLICATE_OR_CONTRADICTORY_WORK_CONTACT");
  }
  return subjects;
}
export async function suppressRelationship(c: PoolClient, input: {
  tenantId: string; companyId: string; personId: string; kind: "REFUSAL" | "OPT_OUT" | "WITHDRAWAL";
  sourceRef: VReference; observedAt: string;
}) {
  await relationshipLock(c, input.tenantId);
  const person = (await c.query("SELECT business_email FROM finnor_os.external_contacts WHERE tenant_id=$1 AND id=$2",
    [input.tenantId, input.personId])).rows[0];
  const history = (await c.query<{ subject_keys: string[] }>(`SELECT subject_keys FROM finnor_os.s6_contact_intents
    WHERE tenant_id=$1 AND (company_id=$2 OR counterparty_id=$3) LIMIT 65537`,
  [input.tenantId, input.companyId, input.personId])).rows;
  if (history.length > 65536) throw Error("S6_SUPPRESSION_CONTACT_HISTORY_COVERAGE_BOUND");
  const subjects = await relationshipSubjects(c, input.tenantId, [`company:${input.companyId}`, `person:${input.personId}`,
    ...(person?.business_email ? [endpointSubject(input.tenantId, person.business_email)] : []), ...history.flatMap(row => row.subject_keys)]);
  await c.query(`INSERT INTO finnor_os.s6_relationship_events(tenant_id,subject_keys,kind,source_ref,observed_at)
    VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(tenant_id,kind,source_ref) DO NOTHING`,
  [input.tenantId, subjects, input.kind, canonical(input.sourceRef), input.observedAt]);
  await c.query(`UPDATE finnor_os.s6_contact_intents SET status='CANCELLED_BEFORE_DISPATCH'
    WHERE tenant_id=$1 AND subject_keys&&$2::text[] AND status IN('INTENDED','AUTHORIZED')`,
  [input.tenantId, subjects]);
}

/** Shared last physical boundary. The possible-egress record is committed before
 * IO. A second serialized fence spans IO, so refusal cannot commit between the
 * final suppression check and provider entry. Process death keeps the first fact. */
export async function withRelationshipDispatch<T>(input: {
  tenantId: string; actorId: string; actionId: string; memberKey?: string;
  companyId: string; personId: string; channel: string; endpoint: string;
  validate: (c: PoolClient) => Promise<void>; dispatch: () => Promise<T>;
}): Promise<T> {
  const scoped = <R>(fn: (c: PoolClient) => Promise<R>) => withTenantTransaction(
    input.tenantId, { userId: input.actorId }, (_db, c) => fn(c));
  let intentId: string | null = null;
  await scoped(async c => {
    await relationshipLock(c, input.tenantId);
    await checkRelationshipSuppression(c, input.tenantId, input);
    const policies = await currentRelationshipPolicies(c, input.tenantId, input.channel);
    const existing = (await c.query<ContactIntent>(`SELECT * FROM finnor_os.s6_contact_intents
      WHERE tenant_id=$1 AND action_id=$2 AND (member_key=$3 OR member_key='primary')
      ORDER BY member_key LIMIT 1 FOR UPDATE`, [input.tenantId, input.actionId, input.memberKey ?? "primary"])).rows[0];
    if (!policies.length && !existing) return;
    await input.validate(c);
    let intent = existing;
    if (!intent) {
      const policy = policies[0]!;
      const action = (await c.query("SELECT work_id,payload FROM finnor_os.domain_actions WHERE tenant_id=$1 AND id=$2", [input.tenantId, input.actionId])).rows[0];
      if (!action?.work_id) throw Error("S6_SHARED_CONTACT_CANONICAL_WORK_REQUIRED");
      intent = { id: randomUUID(), tenant_id: input.tenantId, principal_id: input.actorId, work_id: action.work_id,
        programme_owner: "S6", programme_id: action.work_id, candidate_id: input.personId, company_id: input.companyId,
        counterparty_id: input.personId, action_id: input.actionId, member_key: input.memberKey ?? "primary",
        channel: input.channel, subject_keys: [], activity_binding: { kind: "OTHER_GOVERNED_EXACT_COMMUNICATION" },
        payload: action.payload, payload_digest: digest(action.payload), terms_digest: digest(action.payload), terms_revision: 1,
        kind: "OTHER_GOVERNED_EXACT_COMMUNICATION", policy_id: policy.profileId, policy_revision: policy.revision,
        status: "AUTHORIZED", possible_egress_at: null, created_at: new Date() };
      await c.query(`INSERT INTO finnor_os.s6_contact_intents(tenant_id,id,principal_id,work_id,programme_owner,programme_id,
        candidate_id,company_id,counterparty_id,action_id,member_key,channel,activity_binding,payload,payload_digest,
        terms_digest,terms_revision,kind,policy_id,policy_revision,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17,$18,$19,$20,$21)`,
      [intent.tenant_id,intent.id,intent.principal_id,intent.work_id,intent.programme_owner,intent.programme_id,intent.candidate_id,
        intent.company_id,intent.counterparty_id,intent.action_id,intent.member_key,intent.channel,canonical(intent.activity_binding),
        canonical(intent.payload),intent.payload_digest,intent.terms_digest,intent.terms_revision,intent.kind,intent.policy_id,intent.policy_revision,intent.status]);
    }
    if (!["INTENDED", "AUTHORIZED"].includes(intent.status)) throw Error("S6_ORIGINAL_CONTACT_RECONCILE_BEFORE_REDISPATCH");
    if (intent.company_id !== input.companyId || intent.counterparty_id !== input.personId || intent.channel !== input.channel) throw Error("S6_CONTACT_IDENTITY_CHANGED");
    const subjects = await checkRelationshipContact(c, input.tenantId, intent, input.endpoint);
    await c.query("UPDATE finnor_os.s6_contact_intents SET subject_keys=$3,status='POSSIBLE_EGRESS',possible_egress_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [input.tenantId, intent.id, subjects]);
    intentId = intent.id;
  });
  if (!intentId) return scoped(async c => {
    await relationshipLock(c, input.tenantId);
    await checkRelationshipSuppression(c, input.tenantId, input);
    if ((await currentRelationshipPolicies(c, input.tenantId, input.channel)).length)
      throw Error("S6_RELATIONSHIP_POLICY_CHANGED_BEFORE_DISPATCH");
    await input.validate(c);
    return input.dispatch();
  });
  return scoped(async c => {
    await relationshipLock(c, input.tenantId); await input.validate(c);
    const intent = (await c.query<ContactIntent>("SELECT * FROM finnor_os.s6_contact_intents WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [input.tenantId, intentId])).rows[0]!;
    await checkRelationshipContact(c, input.tenantId, intent, input.endpoint);
    const result = await input.dispatch();
    await c.query("UPDATE finnor_os.s6_contact_intents SET status='ACKNOWLEDGED',acknowledged_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [input.tenantId, intentId]);
    return result;
  });
}
