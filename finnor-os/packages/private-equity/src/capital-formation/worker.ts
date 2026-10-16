import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import type { JobExecutionContext } from "../../../../apps/worker/src/queue";
import type { PeMutationContext } from "../types";
import { principal } from "../decision-slice/adapters";
import {
  compileCapitalProviderIntent, dispatchDisposableCapitalProvider, reconcileCapitalProviderDeliveryTx,
  type CapitalProviderBinding, type CapitalProviderRequest,
} from "../../../tools/src/capital-provider";
import {
  CapitalFormationError, SignedEventSchema, TermsSchema, IntegerSchema, capitalDigest, canonicalCapital, requireDisposableCapitalRuntime,
} from "./contracts";
import {
  capitalTx, capitalProgramme, authorizeCapitalWork, lockCapitalWork, capitalOwnerSnapshot, checkCapitalSnapshot,
  loadCapitalEnrolments, appendCapitalSourceBatchTx, capitalTransition, enqueueCapitalJob, enqueueCapitalMonitor, readCapitalPublicationTx,
  publishCapitalTx, capitalMethod, verifyCapitalSource, originalCapitalEvents, reconcileCapitalOperationCostsTx, type CapitalProgrammeRow,
} from "./store";
import { assertCapitalActivity, capitalActivityReviewTx, capitalDisclosures, validateCapitalBudgetTx, recordCapitalEconomicNotice } from "./service";

const payloadSchema = z.object({
  tenantId: z.string().uuid(), principalId: z.string().uuid(), programmeId: z.string().uuid(),
  revision: z.number().int().positive().safe(), monitor: z.boolean().optional(),
}).strict();
async function physicalFence(ctx: PeMutationContext, execution: Readonly<JobExecutionContext>, c: PoolClient, reserveMs = 0) {
  const row = (await c.query("SELECT id FROM finnor_os.jobs WHERE id=$1 AND tenant_id=$2 AND type='run_capital_formation_v1' AND status='running' AND claim_token=$3 AND claim_fence=$4 AND protocol_version=1 AND retry_safety='durably_effect_guarded' AND lease_expires_at>clock_timestamp()+($5::int * interval '1 millisecond') FOR SHARE",
    [execution.jobId, ctx.auth.tenantId, execution.claimToken, execution.claimFence, reserveMs])).rows[0];
  if (!row) throw new CapitalFormationError("V4_PHYSICAL_JOB_FENCED");
}
async function activeFence(ctx: PeMutationContext, q: CapitalProgrammeRow, execution: Readonly<JobExecutionContext>, c: PoolClient) {
  await physicalFence(ctx, execution, c);
  if (q.active_claim_token !== execution.claimToken || Number(q.active_claim_fence) !== Number(execution.claimFence)) throw new CapitalFormationError("V4_PROGRAMME_DELIVERY_FENCED");
}
type Choice = { binding: CapitalProviderBinding; sourceRevision: number } | null;
async function selectNext(ctx: PeMutationContext, q: CapitalProgrammeRow, c: PoolClient): Promise<Choice> {
  await c.query("SELECT set_config('app.capital_original_programme_id',$1,true)", [q.programme_id]);
  const method = await capitalMethod(), actions = (await c.query<{ id: string; business_effect_id: string; payload: Record<string, any>;
    operation_state: string | null }>(`SELECT d.id::text,d.business_effect_id::text,d.payload,o.execution_state operation_state
    FROM finnor_os.domain_actions d LEFT JOIN finnor_os.external_operations o ON o.tenant_id=d.tenant_id AND o.domain_action_id=d.id
    WHERE d.tenant_id=$1 AND d.initiated_by=$2 AND d.work_id=$3 AND d.action_type='capital_provider_request'
      AND d.payload->'request'->>'programmeId'=$4 ORDER BY d.created_at,d.id LIMIT 1001`,
  [ctx.auth.tenantId, principal(ctx), q.body.workId, q.programme_id])).rows;
  if (actions.length > 1000) throw new CapitalFormationError("ORIGINAL_OPERATION_BOUND_EXCEEDED", undefined, 413);
  const pending = actions.find(a => !["reconciled", "known_failed"].includes(a.operation_state ?? ""));
  if (pending) {
    const p = pending.payload;
    IntegerSchema.parse(p.operationCostCeilingMicroUSD);
    return { binding: { tenantId: ctx.auth.tenantId, actionId: pending.id, effectId: pending.business_effect_id,
      operationKey: p.operationKey, providerOrigin: p.providerOrigin, interfaceDigest: p.interfaceDigest, request: p.request },
    sourceRevision: q.revision };
  }
  if (["STOPPED", "FAILED", "BLOCKED", "COMPLETE"].includes(q.status) || q.deadline_at.getTime() <= Date.now()
    || q.waiting_until.getTime() <= Date.now() || q.steps_spent >= q.body.maxSteps) return null;
  await lockCapitalWork(ctx, q.body, q.rights_revision, c);
  await validateCapitalBudgetTx(ctx, q.body, c);
  const { issuers, profiles } = await loadCapitalEnrolments(ctx, c), authority = q.signed_authority.body;
  const proposals = (await c.query<{ proposal_digest: string; provider_id: string; recipient_id: string; channel_id: string; content: string }>(
    `SELECT p.proposal_digest,p.provider_id::text,p.recipient_id::text,p.channel_id,v.content
     FROM finnor_os.v4_proposals p JOIN finnor_os.evidence_source_versions v ON v.id=p.evidence_version_id AND v.tenant_id=p.tenant_id
     WHERE p.tenant_id=$1 AND p.principal_id=$2 AND p.programme_id=$3 ORDER BY p.created_at,p.proposal_digest LIMIT 65`,
    [ctx.auth.tenantId, principal(ctx), q.programme_id])).rows;
  if (proposals.length > 64) throw new CapitalFormationError("NEGOTIATION_PROPOSAL_BOUND_EXCEEDED", undefined, 413);
  const proposal = proposals.find(p => !actions.some(a => a.payload.operationKey === `capital:${q.programme_id}:proposal:${p.proposal_digest}`));
  const providerId = proposal?.provider_id ?? q.body.providerIds.find(id => !actions.some(a => a.payload.request.providerEntityId === id && a.payload.request.activity === "APPROACH"));
  if (!providerId) {
    // An original authenticated counteroffer may prompt one exact bounded
    // negotiation. It is not automatically an approval, guarantee or execution.
    const source = await originalCapitalEvents(ctx, q.programme_id, c);
    const offer = [...source.events].reverse().find(e => e.body.kind === "COUNTERPROPOSAL" && e.body.terms
      && !actions.some(a => a.payload.operationKey === `capital:${q.programme_id}:counter:${e.body.termsDigest}`));
    if (!offer) return null;
    verifyCapitalSource(offer, issuers, q.body, profiles);
    const channel = authority.activities.find(a => a.activity === "NEGOTIATE" && a.actorIds.includes(principal(ctx)))?.channelIds[0];
    if (!channel) throw new CapitalFormationError("NEGOTIATION_ACTIVITY_NOT_GRANTED");
    return prepareChoice(offer.body.providerEntityId, offer.body.representativeId, channel, "NEGOTIATE", offer.body.terms,
      `capital:${q.programme_id}:counter:${offer.body.termsDigest}`);
  }
  const contacts = (await c.query<{ id: string }>(`SELECT ct.id::text FROM finnor_os.external_contacts ct
    JOIN finnor_os.external_organizations org ON org.tenant_id=ct.tenant_id AND org.id=ct.external_organization_id
    WHERE ct.tenant_id=$1 AND org.id=$2 AND ct.active AND org.active AND ct.id=ANY($3::uuid[]) ORDER BY ct.id LIMIT 2 FOR SHARE OF ct,org`,
  [ctx.auth.tenantId, providerId, authority.permittedRecipientIds])).rows;
  if (contacts.length !== 1) throw new CapitalFormationError("CURRENT_PROVIDER_REPRESENTATIVE_UNAVAILABLE");
  const channel = proposal?.channel_id ?? authority.activities.find(a => a.activity === "APPROACH" && a.actorIds.includes(principal(ctx)))?.channelIds[0];
  if (!channel) throw new CapitalFormationError("CURRENT_CHANNEL_ACTIVITY_UNAVAILABLE");
  const terms = proposal ? TermsSchema.parse(JSON.parse(proposal.content).terms) : null;
  return prepareChoice(providerId, proposal?.recipient_id ?? contacts[0]!.id, channel, proposal ? "NEGOTIATE" : "APPROACH", terms,
    proposal ? `capital:${q.programme_id}:proposal:${proposal.proposal_digest}` : `capital:${q.programme_id}:approach:${providerId}`);

  async function prepareChoice(providerId: string, recipientId: string, channel: string, activity: "APPROACH" | "NEGOTIATE",
    terms: ReturnType<typeof TermsSchema.parse> | null, operationKey: string): Promise<NonNullable<Choice>> {
    const supported = [...new Set(issuers.filter(i => !i.revoked && i.legalEntityId === providerId && i.actorId === recipientId
      && i.purposes.includes("PROVIDER")).flatMap(i => i.instruments).filter(i => profiles.some(p => q.body.domainProfileIds.includes(p.id) && p.instrument === i)))];
    if (supported.length !== 1) throw new CapitalFormationError("EXPLICIT_SINGLE_PROVIDER_INSTRUMENT_BINDING_REQUIRED");
    const profile = profiles.find(p => q.body.domainProfileIds.includes(p.id) && p.instrument === supported[0])!;
    if (profile.environment !== "DISPOSABLE" || profile.revoked || Date.parse(profile.validUntil) <= Date.now() + 5000) throw new CapitalFormationError("CURRENT_CAPITAL_PROVIDER_PROFILE_REQUIRED");
    const professionalReviewEstablished = await capitalActivityReviewTx(ctx, q.body, authority, { activity, providerId, recipientId,
      channelId: channel, instrument: supported[0] }, c);
    assertCapitalActivity(authority, q.body, { activity, providerId, recipientId, channelId: channel, actorId: principal(ctx), terms, professionalReviewEstablished });
    const disclosures = await capitalDisclosures(ctx, q.body, providerId, channel, c, false),
      price = BigInt(profile.operationCostCeilingMicroUSD);
    if (q.contacts_spent >= Math.min(q.body.contactGrant, authority.maxContacts)
      || BigInt(q.cost_ceiling_micro_usd) + price > BigInt(q.body.maxCostMicroUSD) || q.cost_unknown) throw new CapitalFormationError("ORIGINAL_CONTACT_COST_OR_UNKNOWN_GRANT_EXHAUSTED");
    const request: CapitalProviderRequest = {
      schema: "finnor.s6.capital-provider-request.v1", tenantId: ctx.auth.tenantId, principalId: principal(ctx), workId: q.body.workId,
      programmeId: q.programme_id, mandateDigest: capitalDigest(q.body), authorityDigest: capitalDigest(authority),
      providerEntityId: providerId, recipientId, channelId: channel, instrument: supported[0]!, activity,
      disclosures: disclosures.map(({ content: _privateContent, ...ref }) => ref), terms: terms as Record<string, unknown> | null, templateDigest: authority.templates[0]!,
    };
    const actionId = randomUUID(), effectId = randomUUID(), binding: CapitalProviderBinding = {
      tenantId: ctx.auth.tenantId, actionId, effectId, operationKey, providerOrigin: profile.providerInterfaceRef.id,
      interfaceDigest: profile.providerInterfaceRef.contentDigest, request,
    }, effect = compileCapitalProviderIntent(binding, new Date().toISOString());
    await c.query("INSERT INTO finnor_os.domain_actions(id,tenant_id,action_type,payload,status,work_id,initiated_by,authority_decision_id,authority_revision,summary) VALUES($1,$2,'capital_provider_request',$3::jsonb,'approved',$4,$5,$6,$7,$8)",
      [actionId, ctx.auth.tenantId, canonicalCapital({ request, operationKey, providerOrigin: binding.providerOrigin, interfaceDigest: binding.interfaceDigest,
        methodDigest: method.digest, operationCostCeilingMicroUSD: price.toString() }),
        q.body.workId, principal(ctx), q.body.approvalDecisionId, q.rights_revision, "Exact permitted disposable capital activity; no financing or funding receipt"]);
    await c.query("INSERT INTO finnor_os.business_effects(id,tenant_id,domain_action_id,semantic_hash,scope_hash,operation_class,effect,status,authorized_at) VALUES($1,$2,$3,$4,$5,'external_side_effect',$6::jsonb,'authorized',clock_timestamp())",
      [effectId, ctx.auth.tenantId, actionId, effect.semanticHash, effect.scopeHash, canonicalCapital(effect)]);
    await c.query("UPDATE finnor_os.domain_actions SET business_effect_id=$3 WHERE tenant_id=$1 AND id=$2", [ctx.auth.tenantId, actionId, effectId]);
    await c.query("UPDATE finnor_os.v4_programmes SET contacts_spent=contacts_spent+1,cost_ceiling_micro_usd=cost_ceiling_micro_usd+$4::numeric,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3",
      [ctx.auth.tenantId, principal(ctx), q.programme_id, price.toString()]);
    await capitalTransition(ctx, q.programme_id, "ORIGINAL_EFFECT_INTENT", { actionId, effectId, operationKey, requestDigest: capitalDigest(request),
      providerEntityId: providerId, activity, sourceRevision: q.revision, originalBudgetCeilingChargeMicroUSD: price.toString(),
      noRawDisclosureInEffect: true, executionAuthorityGranted: false }, c);
    return { binding, sourceRevision: q.revision };
  }
}

export async function runCapitalFormationJob(payload: Record<string, unknown>, execution?: Readonly<JobExecutionContext>): Promise<void> {
  const parsed = payloadSchema.parse(payload);
  if (!execution || execution.protocolVersion !== 1 || execution.tenantId !== parsed.tenantId || execution.retrySafety !== "durably_effect_guarded"
    || !Number.isSafeInteger(Number(execution.claimFence)) || Number(execution.claimFence) < 1) throw new CapitalFormationError("AUTHENTICATED_V4_PHYSICAL_CLAIM_REQUIRED");
  requireDisposableCapitalRuntime();
  const ctx: PeMutationContext = { auth: { tenantId: parsed.tenantId, userId: parsed.principalId, employeeId: parsed.principalId, role: "owner" } },
    attemptId = randomUUID(), started = performance.now(), cpu = process.cpuUsage(), rss = process.memoryUsage().rss;
  let claimed = false;
  try {
    const q0 = await capitalTx(ctx, c => capitalProgramme(ctx, parsed.programmeId, c, false));
    await authorizeCapitalWork(ctx, q0.body, false);
    claimed = await capitalTx(ctx, async c => {
      const q = await capitalProgramme(ctx, parsed.programmeId, c); await physicalFence(ctx, execution, c);
      if (!parsed.monitor && q.revision !== parsed.revision) return false;
      if (q.active_claim_token && q.active_claim_token !== execution.claimToken) {
        const living = (await c.query("SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND claim_token=$2 AND status='running' AND lease_expires_at>clock_timestamp()",
          [ctx.auth.tenantId, q.active_claim_token])).rows[0];
        if (living) return false;
        await capitalTransition(ctx, q.programme_id, "PRIOR_PHYSICAL_ATTEMPT_LOST", { priorToken: q.active_claim_token,
          finalPhysicalCostUnknown: true, originalEffectsAndCapacityRetained: true }, c);
      }
      if (q.steps_spent >= q.body.maxSteps) {
        await c.query("UPDATE finnor_os.v4_programmes SET status=CASE WHEN status IN('STOPPED','FAILED','COMPLETE') THEN status ELSE 'STOPPED' END,current_publication_id=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3",
          [ctx.auth.tenantId, principal(ctx), q.programme_id]);
        await capitalTransition(ctx, q.programme_id, "ORIGINAL_STEP_BUDGET_STOP", { originalObligationsRetained: true }, c); return false;
      }
      await c.query("UPDATE finnor_os.v4_programmes SET steps_spent=steps_spent+1,active_claim_token=$4,active_claim_fence=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3",
        [ctx.auth.tenantId, principal(ctx), q.programme_id, execution.claimToken, execution.claimFence]);
      await capitalTransition(ctx, q.programme_id, "PHYSICAL_ATTEMPT_STARTED", { attemptId, jobId: execution.jobId, deliveryAttemptId: execution.deliveryAttemptId,
        claimFence: String(execution.claimFence), workerId: execution.workerId, originalDeadlineAt: q.deadline_at.toISOString(), monitor: parsed.monitor === true }, c);
      return true;
    });
    if (!claimed) return;
    execution.registerHeartbeat(async () => {
      try { return await capitalTx(ctx, async c => { await physicalFence(ctx, execution, c);
        const q = await capitalProgramme(ctx, parsed.programmeId, c, false); return q.active_claim_token === null
          || q.active_claim_token === execution.claimToken && Number(q.active_claim_fence) === Number(execution.claimFence); }); }
      catch { return false; }
    });
    const choice = await capitalTx(ctx, async c => {
      const q = await capitalProgramme(ctx, parsed.programmeId, c); await activeFence(ctx, q, execution, c);
      if (parsed.monitor) return null;
      await lockCapitalWork(ctx, q.body, q.rights_revision, c, false);
      return selectNext(ctx, q, c);
    });
    if (choice) {
      const delivered = await dispatchDisposableCapitalProvider(choice.binding, async action => capitalTx(ctx, async c => {
        const current = await capitalProgramme(ctx, parsed.programmeId, c); await activeFence(ctx, current, execution, c);
        if (current.revision !== choice.sourceRevision || ["STOPPED", "FAILED", "BLOCKED", "COMPLETE"].includes(current.status)
          || current.deadline_at.getTime() <= Date.now() + 5000 || current.waiting_until.getTime() <= Date.now() + 5000) throw new CapitalFormationError("DISPATCH_CURRENT_ORIGINAL_OWNER_BOUNDARY_REVISED");
        await lockCapitalWork(ctx, current.body, current.rights_revision, c);
        await validateCapitalBudgetTx(ctx, current.body, c);
        const professionalReviewEstablished = await capitalActivityReviewTx(ctx, current.body, current.signed_authority.body, {
          activity: choice.binding.request.activity, providerId: choice.binding.request.providerEntityId,
          recipientId: choice.binding.request.recipientId, channelId: choice.binding.request.channelId, instrument: choice.binding.request.instrument }, c);
        assertCapitalActivity(current.signed_authority.body, current.body, { activity: choice.binding.request.activity,
          providerId: choice.binding.request.providerEntityId, recipientId: choice.binding.request.recipientId,
          channelId: choice.binding.request.channelId, actorId: principal(ctx), terms: choice.binding.request.terms as any, professionalReviewEstablished });
        const disclosures = await capitalDisclosures(ctx, current.body, choice.binding.request.providerEntityId, choice.binding.request.channelId, c, true);
        if (capitalDigest(disclosures.map(({ content: _private, ...ref }) => ref)) !== capitalDigest(choice.binding.request.disclosures)) throw new CapitalFormationError("EXACT_DISPATCH_DISCLOSURE_BYTES_REVISED");
        await capitalTransition(ctx, current.programme_id, "CURRENT_OWNER_DISPATCH_BOUNDARY", { actionId: choice.binding.actionId,
          effectId: choice.binding.effectId, requestDigest: capitalDigest(choice.binding.request), originalAuthorityRechecked: true }, c);
        await physicalFence(ctx, execution, c, 6000);
        if (Math.min(current.deadline_at.getTime(), current.waiting_until.getTime(), Date.parse(current.signed_authority.body.validUntil),
          ...current.body.disclosureRefs.map(d => Math.min(Date.parse(d.validUntil), Date.parse(d.retentionUntil)))) <= Date.now() + 6000) {
          throw new CapitalFormationError("ORIGINAL_DISPATCH_WINDOW_INSUFFICIENT");
        }
        return action(disclosures.map(({ evidenceVersionId, content }) => ({ evidenceVersionId, content })));
      }));
      if (!delivered.answer) {
        await capitalTx(ctx, async c => {
          const q = await capitalProgramme(ctx, parsed.programmeId, c);
          await c.query("UPDATE finnor_os.v4_programmes SET status=CASE WHEN status IN('STOPPED','FAILED','COMPLETE') THEN status ELSE 'RECONCILING' END,cost_unknown=true,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3",
            [ctx.auth.tenantId, principal(ctx), q.programme_id]);
          await capitalTransition(ctx, q.programme_id, "ORIGINAL_PROVIDER_OUTCOME_UNKNOWN", { operationId: delivered.operation.id,
            actionId: choice.binding.actionId, effectId: choice.binding.effectId, automaticMutationRetry: false, budgetAndResponsibilityRetained: true }, c);
        });
      } else {
        const response = delivered.answer;
        if (response.schema !== "finnor.capital-provider-response.v1" || response.operationId !== delivered.operation.id
          || response.requestDigest !== delivered.operation.requestHash || !Array.isArray(response.events) || response.events.length > 64) throw new CapitalFormationError("PROVIDER_ORIGINAL_OPERATION_RESPONSE_SUBSTITUTION");
        const events = response.events.map(e => SignedEventSchema.parse(e));
        await capitalTx(ctx, async (c, db) => {
          const q = await capitalProgramme(ctx, parsed.programmeId, c);
          for (const event of events) {
            if (event.body.operationId !== delivered.operation.id || event.body.operationRequestDigest !== delivered.operation.requestHash) throw new CapitalFormationError("PROVIDER_ORIGINAL_EVENT_OPERATION_SUBSTITUTION");
          }
          const { appended, enrolled } = await appendCapitalSourceBatchTx(ctx, q, events, c, db);
          const providerConfirmed = events.some(event => enrolled.issuers.some(issuer => issuer.id === event.body.issuerId
            && issuer.purposes.includes("PROVIDER") && issuer.legalEntityId === choice.binding!.request.providerEntityId
            && issuer.actorId === choice.binding!.request.recipientId));
          if (!providerConfirmed) throw new CapitalFormationError("INDEPENDENT_PROVIDER_OPERATION_CONFIRMATION_REQUIRED");
          const costResult = await reconcileCapitalOperationCostsTx(ctx, q, delivered.operation.id, c);
          if (appended) await c.query("UPDATE finnor_os.v4_programmes SET revision=revision+1,current_publication_id=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3",
            [ctx.auth.tenantId, principal(ctx), q.programme_id]);
          // Current receipt projection and native delivery reconciliation share
          // the programme lock. A later source cannot be overwritten by a stale
          // operation-local finality result in a second transaction.
          if (costResult.costsFinal) {
            await reconcileCapitalProviderDeliveryTx(db, choice.binding, { operationId: delivered.operation.id, requestDigest: delivered.operation.requestHash,
              independentEventDigests: events.map(e => capitalDigest(e)), qualification: "EXACT_APPROACH_OR_NEGOTIATION_OBSERVED_NOT_FUNDING" });
            await c.query("UPDATE finnor_os.business_effects SET status='verified',observed_at=clock_timestamp(),verification=$3::jsonb WHERE tenant_id=$1 AND id=$2",
              [ctx.auth.tenantId, choice.binding.effectId, canonicalCapital({ qualification: "INDEPENDENT_PROVIDER_ACTIVITY_OBSERVED_ONLY",
                operationId: delivered.operation.id, financingCommitment: false, fundingReceived: false })]);
            await c.query("UPDATE finnor_os.domain_actions SET status='completed' WHERE tenant_id=$1 AND id=$2", [ctx.auth.tenantId, choice.binding.actionId]);
          }
        });
      }
    }
    await capitalTx(ctx, async (c, db) => {
      const q = await capitalProgramme(ctx, parsed.programmeId, c); await activeFence(ctx, q, execution, c);
      if (!["STOPPED", "FAILED", "COMPLETE"].includes(q.status) && (q.deadline_at.getTime() <= Date.now() || q.waiting_until.getTime() <= Date.now())) {
        await c.query("UPDATE finnor_os.v4_programmes SET status='STOPPED',revision=revision+1,current_publication_id=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3",
          [ctx.auth.tenantId, principal(ctx), q.programme_id]);
        q.status = "STOPPED"; q.revision++; q.current_publication_id = null;
        await capitalTransition(ctx, q.programme_id, "ORIGINAL_WAIT_OR_DEADLINE_STOP", { originalDeadlinePreserved: true, acceptedCostsAndObligationsRetained: true }, c);
      }
      // A deadline monitor never widens activity authority. It may only retain
      // current signed facts and the original responsibilities.
      const snapshot = await capitalOwnerSnapshot(ctx, q, c), check = await checkCapitalSnapshot(snapshot);
      if (q.current_publication_id) {
        const previous = await readCapitalPublicationTx(ctx, q, c);
        if (previous?.ownerDigest === snapshot.ownerDigest && previous.check.resultDigest === check.resultDigest
          && previous.codeDigest === (await capitalMethod()).digest) return;
        const revision = q.revision + 1;
        await c.query("UPDATE finnor_os.v4_programmes SET revision=$4,current_publication_id=NULL WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3",
          [ctx.auth.tenantId, principal(ctx), q.programme_id, revision]);
        q.revision = revision; q.current_publication_id = null;
      }
      const result = await publishCapitalTx(ctx, q, snapshot, check, c, db);
      await recordCapitalEconomicNotice(ctx, result.publication, result.digest, q, c);
    });
    await capitalTx(ctx, async c => {
      const q = await capitalProgramme(ctx, parsed.programmeId, c); await activeFence(ctx, q, execution, c);
      const measured = process.cpuUsage(cpu);
      await capitalTransition(ctx, q.programme_id, "PHYSICAL_ATTEMPT_FINISHED", { attemptId, wallMs: performance.now() - started,
        cpuUserMicros: measured.user, cpuSystemMicros: measured.system, rssBeforeBytes: rss, rssAfterBytes: process.memoryUsage().rss,
        costScope: "PROCESS_INTERVAL_NOT_AGGREGATE_OS_OR_FINANCIAL_BILLING", usd: null }, c);
      if (!parsed.monitor && !q.cost_unknown && !["STOPPED", "FAILED", "BLOCKED", "COMPLETE"].includes(q.status)) {
        const next = await selectNext(ctx, q, c);
        if (next) {
          const revision = q.revision + 1;
          await c.query("UPDATE finnor_os.v4_programmes SET status='PROGRESS',revision=$4,current_publication_id=NULL WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3",
            [ctx.auth.tenantId, principal(ctx), q.programme_id, revision]);
          await enqueueCapitalJob(ctx, q.programme_id, revision, c);
        } else await enqueueCapitalMonitor(ctx, q, c);
      } else if (q.cost_unknown && q.waiting_until.getTime() > Date.now()) {
        const revision = q.revision + 1;
        await c.query("UPDATE finnor_os.v4_programmes SET revision=$4 WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3",
          [ctx.auth.tenantId, principal(ctx), q.programme_id, revision]);
        await c.query(`INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,priority,protocol_version,retry_safety,run_at)
          VALUES($1,'run_capital_formation_v1',$2::jsonb,$3,'interactive',0,1,'durably_effect_guarded',clock_timestamp()+interval '1 second') ON CONFLICT(idempotency_key) DO NOTHING`,
          [ctx.auth.tenantId, canonicalCapital({ ...parsed, revision, monitor: false }), `v4:${q.programme_id}:${revision}`]);
      }
      await c.query("UPDATE finnor_os.v4_programmes SET active_claim_token=NULL,active_claim_fence=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3",
        [ctx.auth.tenantId, principal(ctx), q.programme_id]);
    });
  } catch (error) {
    if (!claimed) throw error;
    const code = error instanceof CapitalFormationError ? error.code : "V4_OWNER_OR_RUNTIME_FAILURE";
    await capitalTx(ctx, async c => {
      const q = await capitalProgramme(ctx, parsed.programmeId, c);
      await capitalTransition(ctx, q.programme_id, "PHYSICAL_ATTEMPT_FAILED", { attemptId, code, unknownPhysicalCost: true,
        originalEffectsSourcesAndCostsRetained: true, usd: null }, c);
      if (q.active_claim_token === execution.claimToken) await c.query(`UPDATE finnor_os.v4_programmes
        SET status=CASE WHEN status IN('STOPPED','FAILED','COMPLETE') THEN status WHEN cost_unknown THEN 'RECONCILING' ELSE 'BLOCKED' END,
        active_claim_token=NULL,active_claim_fence=NULL,failure=$4::jsonb,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3`,
      [ctx.auth.tenantId, principal(ctx), q.programme_id, canonicalCapital({ code })]);
    });
    throw error;
  }
}
