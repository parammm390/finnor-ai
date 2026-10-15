/** Finite review-boundary E2Es. Actual installed bearer API, canonical owners,
 * physical worker and runner-administered development actors, not S8 custody. */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { capitalDigest, canonicalCapital } from "../../packages/private-equity/src/capital-formation/contracts";
import { capitalTx, capitalProgramme, capitalOwnerSnapshot, readCapitalPublicationTx } from "../../packages/private-equity/src/capital-formation/store";
import { revisions } from "../../packages/private-equity/src/evidence-execution/store";
import { capitalFormationView } from "../../../src/components/centropy/canvas/capital-formation-view";

export async function runCapitalBoundaryProofs(t: {
  repo: string; python: string; admin: any; support: any;
  fixture(name: string, options?: any): Promise<any>;
  cb(f: any, operation: string, body: any): Promise<any>;
  http(f: any, path: string, body: any): Promise<any>;
  current(f: any, predicate: (v: any) => boolean, maximum?: number): Promise<any>;
  check(id: string, predicate: string, run: () => Promise<any>): Promise<void>;
  artifact(name: string, value: any): Promise<any>;
  stopWorker(): Promise<void>; startWorker(): Promise<void>; killWorker(): Promise<void>; dispose(f: any): void;
}) {
  const ok = (r: any) => { assert([200, 201, 202].includes(r.status), JSON.stringify(r)); return r.body; };
  const read = async (f: any) => ok(await t.cb(f, "capital-formation-read", { programmeId: f.mandate.programmeId }));
  const submit = async (f: any) => ok(await t.cb(f, "capital-formation-submit", f.request));
  const stop = async (f: any) => { const v = await read(f); return ok(await t.cb(f, "capital-formation-cancel", {
    programmeId: f.mandate.programmeId, expectedRevision: v.revision, reason: "Finite boundary proof stop; original duties retained",
  })); };
  const snapshot = (f: any) => capitalTx(f.ctx, async c => capitalOwnerSnapshot(f.ctx, await capitalProgramme(f.ctx, f.mandate.programmeId, c), c));
  const publication = (f: any) => capitalTx(f.ctx, async c => readCapitalPublicationTx(f.ctx, await capitalProgramme(f.ctx, f.mandate.programmeId, c), c));
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  const sourceReady = (f: any) => t.current(f, v => v.current && v.package?.conditionalCommittedMinor === "8000000000"
    && v.package?.indicativeEquityMinor === "4000000000" && v.status === "WAITING");
  async function human(f: any, terms: any, receiptId = randomUUID()) {
    const proposalDigest = capitalDigest({ terms, recipientId: terms.representativeId, channelId: "capital-disposable-http-v1" });
    const now = Date.now(), meter = f.domainActors[terms.instrument].meter;
    return meter.rpc("SIGN", { schema: "finnor.s7.capital-human-meter.v1", receiptId, issuerId: meter.public.id,
      tenantId: f.tenant, principalId: f.principal, programmeId: f.mandate.programmeId, proposalDigest,
      startedAt: new Date(now - 2000).toISOString(), finishedAt: new Date(now - 1000).toISOString(),
      seconds: 1, costMicroUSD: "0", costFinal: true });
  }
  async function propose(f: any, terms: any, expectedRevision: number, receipt?: any) {
    return t.cb(f, "capital-formation-proposal", { programmeId: f.mandate.programmeId, expectedRevision, terms,
      recipientId: terms.representativeId, channelId: "capital-disposable-http-v1", humanReceipt: receipt ?? await human(f, terms) });
  }
  async function state(f: any) {
    return (await t.admin.query(`SELECT p.status,p.revision,p.contacts_spent,p.steps_spent,p.human_seconds_spent,
      p.cost_ceiling_micro_usd,p.deadline_at,p.waiting_until,
      (SELECT count(*)::int FROM finnor_os.v4_proposals x WHERE x.tenant_id=p.tenant_id AND x.programme_id=p.programme_id) proposals,
      (SELECT count(*)::int FROM finnor_os.evidence_source_versions x WHERE x.tenant_id=p.tenant_id) evidence_versions,
      (SELECT count(*)::int FROM finnor_os.jobs x WHERE x.tenant_id=p.tenant_id) jobs
      FROM finnor_os.v4_programmes p WHERE p.tenant_id=$1 AND p.programme_id=$2`, [f.tenant, f.mandate.programmeId])).rows[0];
  }
  await t.check("H_E_STOP_AND_WRITE_BOUNDS", "Actual signed proposal replay, 65th write and stopped-programme boundary preserve original charges/history", async () => {
    const f = await t.fixture("bounded-proposals"); await submit(f); await sourceReady(f); await t.stopWorker();
    const original = await snapshot(f), base = structuredClone(original.events.find(e => e.body.kind === "COMMITMENT_EXECUTED")!.body.terms!);
    let revision = (await read(f)).revision;
    const requests: any[] = [], localHumanReceiptId = randomUUID(),
      equity = structuredClone(original.events.find(e => e.body.instrument === "TRANSACTION_CO_INVESTMENT_EQUITY" && e.body.terms)!.body.terms!);
    for (let n = 0; n < 64; n++) {
      const basis = n === 1 ? equity : base;
      const terms = { ...basis, amount: { ...basis.amount, amountMinor: String(BigInt(basis.amount.amountMinor) + BigInt(n + 1)) } };
      const receipt = await human(f, terms, n < 2 ? localHumanReceiptId : randomUUID()), result = await propose(f, terms, revision, receipt);
      assert.equal(result.status, 202, JSON.stringify(result)); revision = result.body.revision;
      if (n === 0) {
        const before = await state(f), replay = await propose(f, terms, revision, receipt);
        assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.deepEqual(await state(f), before);
      }
      requests.push({ terms, receipt, result });
    }
    const next = { ...base, amount: { ...base.amount, amountMinor: "8000000100" } };
    const before = await state(f), overflow = await propose(f, next, revision);
    assert.equal(overflow.status, 413); assert.equal(overflow.body.code, "ORIGINAL_PROPOSAL_OR_HUMAN_RECEIPT_BOUND_EXCEEDED");
    assert.deepEqual(await state(f), before); assert.equal(before.proposals, 64); assert.equal(before.human_seconds_spent, 64);
    const stopped = await stop(f), terminal = await state(f), afterStop = await propose(f, next, stopped.revision);
    assert.equal(afterStop.status, 409); assert.equal(afterStop.body.code, "ORIGINAL_EPISODE_STOPPED_OR_EXHAUSTED");
    assert.deepEqual(await state(f), terminal);
    await t.artifact("boundaries/stop-and-bounds.json", { originalInput: f.request, requests, before, overflow, stopped, afterStop, terminal,
      physicalQueuePausedDuringWriteAdmission: true, unmeteredRealEngineeringTimeNotQualified: true });
    await t.startWorker(); t.dispose(f);
    return { acceptedDistinctProposals: 64, replayCharged: false, overflowWriteCharged: false, stoppedReopened: false, originalDeadlinePreserved: true };
  });
  await t.check("D_CONCURRENT_SIBLING_GRANTS", "Concurrent exact mandates share one native S5 grant without aggregate replenishment", async () => {
    const f = await t.fixture("sibling-grants"); await t.stopWorker();
    const requests: any[] = [];
    for (let n = 0; n < 3; n++) {
      const programmeId = randomUUID(), disclosure = { ...f.mandate.disclosureRefs[0], programmeId };
      await t.admin.query(`INSERT INTO finnor_os.s1_capital_disclosures(tenant_id,principal_id,programme_id,work_id,evidence_version_id,source_id,body,content_digest,valid_until,retention_until)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`, [f.tenant, f.principal, programmeId, f.workId, f.disclosure.versionId,
        f.disclosure.sourceId, canonicalCapital(disclosure), capitalDigest(disclosure), disclosure.validUntil, disclosure.retentionUntil]);
      const mandate = structuredClone(f.mandate);
      mandate.programmeId = programmeId; mandate.approvalDecisionId = randomUUID(); mandate.disclosureRefs = [disclosure];
      mandate.contactGrant = 4; mandate.maxSteps = 16; mandate.maxHumanSeconds = 450; mandate.maxCostMicroUSD = "50000000";
      mandate.sourceRevisionVector = (await revisions(f.ctx, mandate.sourceRevisionVector.map((r: any) =>
        r.key.startsWith("v4-disclosure:") ? `v4-disclosure:${programmeId}:${f.disclosure.versionId}` : r.key))).map(({ key, revision }) => ({ key, revision }));
      const approval = await f.authorityActor.rpc("SIGN", { schema: "finnor.s4.capital-approval.v1", tenantId: f.tenant,
        principalId: f.principal, programmeId, mandateDigest: capitalDigest(mandate), authorityDigest: capitalDigest(f.request.authority.body) });
      const rights = (await t.admin.query("SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$1", [f.tenant])).rows[0].revision;
      await t.admin.query(`INSERT INTO finnor_os.authority_decisions(id,tenant_id,employee_id,work_id,operation,capability,resource_type,resource_id,risk,outcome,reason_code,authority_revision,evidence)
        VALUES($1,$2,$3,$4,'approval','capital:financing-mandate','financing_programme',$5,'high','allowed','exact_development_sibling_grant',$6,$7::jsonb)`,
      [mandate.approvalDecisionId, f.tenant, f.principal, f.workId, programmeId, rights, JSON.stringify({ capitalApproval: { ...approval, issuerId: f.authorityIssuer.id } })]);
      requests.push({ mandate, authority: f.request.authority, idempotencyKey: "sibling-" + n });
    }
    const responses = await Promise.all(requests.map(request => t.cb(f, "capital-formation-submit", request)));
    assert.equal(responses.filter(r => r.status === 202).length, 2, JSON.stringify(responses));
    assert.equal(responses.filter(r => r.body.code === "ORIGINAL_S5_GRANT_DOES_NOT_COVER_FINANCING_EPISODE").length, 1);
    const accepted = (await t.admin.query("SELECT body FROM finnor_os.s4_financing_mandates WHERE tenant_id=$1", [f.tenant])).rows;
    assert.equal(accepted.length, 2); assert.equal(accepted.reduce((sum: number, r: any) => sum + r.body.contactGrant, 0), 8);
    const revisionsBefore = (await t.admin.query("SELECT programme_id,revision,status FROM finnor_os.v4_programmes WHERE tenant_id=$1 ORDER BY programme_id", [f.tenant])).rows;
    await t.admin.query("UPDATE finnor_os.s1_capital_disclosures SET revision=revision+1 WHERE tenant_id=$1 AND programme_id=$2", [f.tenant, accepted[0].body.programmeId]);
    const unaffected = (await t.admin.query("SELECT programme_id,revision,status FROM finnor_os.v4_programmes WHERE tenant_id=$1 AND programme_id=$2",
      [f.tenant, accepted[1].body.programmeId])).rows[0];
    assert.deepEqual(unaffected, revisionsBefore.find((r: any) => r.programme_id === accepted[1].body.programmeId));
    for (const r of accepted) await stop({ ...f, mandate: r.body });
    await t.artifact("boundaries/concurrent-sibling-grants.json", { originalNativeGrant: f.mandate.budgetGrantRef, requests, responses, accepted,
      sameOriginalWorkId: f.workId, revisionsBefore, unaffected, noPhysicalApproachDuringAdmission: true });
    await t.startWorker(); t.dispose(f);
    return { concurrentCandidates: 3, accepted: 2, rejected: 1, aggregateContacts: 8, originalS5Grant: f.mandate.budgetGrantRef.contentDigest };
  });
  await t.check("D_SCOPED_SOURCES_AND_CYCLES", "Equal issuer-local identities retain exact provenance, whole-graph cycles suppress real current S5 capacity and S7 retains scoped duties", async () => {
    const f = await t.fixture("scoped-cycles", { issuerLocalIds: true, additionalTranche: true, allowedGuarantee: true, shadowDebtProfile: true }); await submit(f); await sourceReady(f); await t.stopWorker();
    const initial = await snapshot(f), published = (await publication(f))!, debt = published.artifacts.find(a => a.terms.instrument === "CORPORATE_DEBT")!;
    assert.equal(debt.envelope.source_refs.length, 3); assert.equal(debt.envelope.cost_receipts.length, 3);
    const selectedDebt = f.profiles.find((p: any) => p.instrument === "CORPORATE_DEBT");
    assert.equal(initial.profiles[0]!.id, f.shadowProfile.id);
    assert.equal(published.package.commitments.find(c => c.commitmentId === debt.commitmentId)!.profileId, selectedDebt.id);
    assert.equal(debt.envelope.domain_profile_ref, selectedDebt.id);
    assert.equal(debt.instrument_profile_and_offering_authority.profileId, selectedDebt.id);
    const expectedIssuers = Object.values(f.domainActors.CORPORATE_DEBT).filter((a: any) => ["identity", "provider", "professional"].includes(a.role)).map((a: any) => a.public.id).sort();
    assert.deepEqual(debt.envelope.source_refs.map(r => r.issuerId).sort(), expectedIssuers);
    const bases = ["CORPORATE_DEBT", "CORPORATE_DEBT", "TRANSACTION_CO_INVESTMENT_EQUITY"].map(instrument =>
      initial.events.find(e => e.body.instrument === instrument && e.body.terms)!.body.terms!);
    const terms = bases.map((base, n) => ({ ...structuredClone(base), commitmentIdentity: n === 0 ? "x".repeat(500) : "cycle-" + n,
      instrumentIdentity: randomUUID(), facilityId: base.instrument === "CORPORATE_DEBT" ? randomUUID() : null,
      securityId: base.instrument !== "CORPORATE_DEBT" ? randomUUID() : null, amount: { ...base.amount, amountMinor: "4000000000" },
      trancheId: n === 1 ? "secondary" : "principal",
      capacityResourceIds: ["cycle-capacity-" + n], executionDigest: capitalDigest("Independent hypothetical executed cycle document " + n),
      conditions: [], materialObligations: [{ id: "repayment", meaning: "Distinct original duty for cycle-" + n, accountingDestination: "ENTITY_LIABILITY" }] })) as any[];
    const identities = terms.map(term => `${term.providerEntityId}:${term.instrument}:${term.commitmentIdentity}`);
    for (let n = 0; n < terms.length; n++) terms[n].conditions = [{ id: "dependency", predicate: "Exact independent financing prerequisite",
      kind: "PROFESSIONAL", material: true, responsibleActorId: terms[n].representativeId,
      interpretation: "Exact financing dependency declared by the original professional source",
      requiredIssuerIds: [f.domainActors[terms[n].instrument].professional.public.id],
      dependencyCommitmentIds: [identities[(n + 1) % 3]], waiverActorIds: [], expiry: terms[n].expiresAt }];
    async function originalEvents(term: any, withIdentity: boolean) {
      const actors = f.domainActors[term.instrument], context = { programmeId: f.mandate.programmeId, providerEntityId: term.providerEntityId,
        representativeId: term.representativeId, instrument: term.instrument, commitmentIdentity: term.commitmentIdentity, terms: term };
      const sent = [];
      if (withIdentity) sent.push(await actors.identity.rpc("EVENT", { kind: "IDENTITY_CONFIRMED", context, extra: {
        identity: initial.events.find(e => e.body.instrument === term.instrument && e.body.identity)!.body.identity,
        cost: { receiptId: "identity:" + capitalDigest(term.commitmentIdentity), microUSD: "0", final: true },
      } }));
      sent.push(await actors.provider.rpc("EVENT", { kind: "COMMITMENT_EXECUTED", context, extra: { terms: term,
        cost: { receiptId: "execution:" + capitalDigest(term.commitmentIdentity), microUSD: "0", final: true } } }));
      sent.push(await actors.professional.rpc("EVENT", { kind: "PROFESSIONAL_DETERMINATION", context, extra: { determination: {
        operativeStatus: "EFFECTIVE", termsDigest: capitalDigest(term), materialConditionIds: term.conditions.map((c: any) => c.id),
        unsatisfiedConditionIds: [], interpretation: "Original hypothetical exact executed terms and condition inventory, not a field opinion",
        legalBasisDigest: f.profiles.find((p: any) => p.instrument === term.instrument).legalBasisDigest,
        executionEstablished: true, issuerAuthorityEstablished: true, offeringActivityEstablished: true, liabilitiesComplete: true,
      }, cost: { receiptId: "professional:" + capitalDigest(term.commitmentIdentity), microUSD: "0", final: true } } }));
      for (const event of sent) ok(await t.cb(f, "capital-formation-event", { programmeId: f.mandate.programmeId, event }));
      return sent;
    }
    const sourceEvents = [];
    const resources = [];
    for (const term of terms) {
      sourceEvents.push(...await originalEvents(term, true));
      resources.push(await t.support.resource(f.ownerFixture, term.capacityResourceIds[0], "USD", "STOCK", ["40000000", "40000000"], undefined, [], {
        resourceClass: term.instrument === "CORPORATE_DEBT" ? "BORROWING_HEADROOM" : "COMMITTED_CAPITAL",
        sourceRef: { owner: "ORIGINAL_PROVIDER_SOURCE", id: term.instrumentIdentity, version: "development-v1", contentDigest: capitalDigest(term) },
      }));
    }
    await t.startWorker();
    const circular = await t.current(f, v => v.current && v.package?.conflicts.includes("CIRCULAR_FINANCING_DEPENDENCY"));
    assert.equal(circular.package.eligibleUndrawnMinor, "0");
    assert(identities[0]!.length > 512);
    assert.equal(capitalFormationView.parse(circular).package!.commitments.find(c => c.commitmentId === identities[0])!.commitmentId, identities[0]);
    const cyclicSnapshot = await snapshot(f);
    const oracle = spawnSync(t.python, [join(t.repo, "finnor-os/scripts/v4/reference.py")], {
      input: canonicalCapital(cyclicSnapshot), encoding: "utf8", timeout: 10000,
    });
    assert.equal(oracle.status, 0, oracle.stderr); assert.equal(JSON.parse(oracle.stdout).circularFinancingDetected, true);
    await t.stopWorker();
    const corrected = { ...terms[2], conditions: [], executionDigest: capitalDigest("Original independently signed acyclic correction") };
    sourceEvents.push(...await originalEvents(corrected, false));
    const { ref, revision: _revision, priorRef: _prior, ...resource } = resources[2];
    ok(await t.http(f, "allocations/resource", { resource: { ...resource, sourceRef: { ...resource.sourceRef, contentDigest: capitalDigest(corrected) } }, expectedRef: ref }));
    await t.startWorker();
    const acyclic = await t.current(f, v => v.current && v.package?.eligibleUndrawnMinor === "12000000000"
      && !v.package.conflicts.includes("CIRCULAR_FINANCING_DEPENDENCY"));
    const notice = (await t.admin.query("SELECT body FROM finnor_os.s7_economic_records WHERE tenant_id=$1 AND idempotency_key=$2",
      [f.tenant, "v4-notice:" + acyclic.publicationDigest])).rows[0].body;
    const repayment = notice.payload.continuingObligations.filter((o: any) => o.obligation.id === "repayment");
    assert.equal(repayment.length, 3); assert.equal(new Set(repayment.map((o: any) => o.commitmentId)).size, 3);
    await t.stopWorker();
    assert(!acyclic.package.unresolvedClaims.includes("TRANCHE_NOT_PRESENT_ELIGIBLE:principal"));
    const movedTranche = { ...terms[0], trancheId: "secondary", executionDigest: capitalDigest("Original executed tranche amendment") };
    sourceEvents.push(...await originalEvents(movedTranche, false)); await t.startWorker();
    const currentTranche = await t.current(f, v => v.current && v.package?.unresolvedClaims.includes("TRANCHE_NOT_PRESENT_ELIGIBLE:principal"));
    assert.equal(currentTranche.package.eligibleUndrawnMinor, "12000000000"); await t.stopWorker();
    const excessGuarantee = { ...movedTranche, executionDigest: capitalDigest("Original permitted-ID guarantee exposure amendment"),
      guarantees: [{ id: "development-allowed-guarantee", guarantorEntityId: f.mandate.legalEntityId,
        maximum: f.mandate.requirement, expiresAt: movedTranche.expiresAt }] };
    sourceEvents.push(...await originalEvents(excessGuarantee, false)); await t.startWorker();
    const guaranteeRejected = await t.current(f, v => v.current && v.package?.commitments.some((c: any) =>
      c.commitmentId === identities[0] && c.unresolvedClaims.includes("GUARANTEE_AGGREGATE_EXPOSURE_OUTSIDE_AUTHORITY")));
    assert.equal(guaranteeRejected.package.commitments.find((c: any) => c.commitmentId === identities[0]).verified, false);
    await t.stopWorker(); sourceEvents.push(...await originalEvents(terms[0], false)); await t.startWorker();
    await t.current(f, v => v.current && v.package?.eligibleUndrawnMinor === "12000000000"); await t.stopWorker();
    const currentCovenant = { id: "current-covenant-A", semanticRef: "Original exact executed covenant scope",
      conflictsWith: ["superseded-covenant-B"], obligation: "Original covenant remains unless independently amended" };
    const covenantA = { ...terms[0], covenants: [currentCovenant], executionDigest: capitalDigest("Original executed A covenant") },
      covenantB = { ...terms[1], covenants: [{ ...currentCovenant, id: "superseded-covenant-B", conflictsWith: [] }],
        executionDigest: capitalDigest("Original executed B covenant") };
    sourceEvents.push(...await originalEvents(covenantA, false), ...await originalEvents(covenantB, false)); await t.startWorker();
    const covenantConflict = await t.current(f, v => v.current && v.package?.conflicts.includes("COVENANT_CONFLICT:current-covenant-A"));
    assert.equal(covenantConflict.package.eligibleUndrawnMinor, "0"); await t.stopWorker();
    const covenantAmendment = { ...covenantB, covenants: [], executionDigest: capitalDigest("Independently executed B covenant removal") };
    sourceEvents.push(...await originalEvents(covenantAmendment, false)); await t.startWorker();
    const amendedCovenant = await t.current(f, v => v.current && v.package?.eligibleUndrawnMinor === "12000000000");
    assert(!amendedCovenant.package.conflicts.includes("COVENANT_CONFLICT:current-covenant-A"));
    assert.equal(capitalFormationView.parse(amendedCovenant).package!.eligibleUndrawnMinor, "12000000000"); await t.stopWorker();
    const shared = { ...terms[1], facilityId: terms[0].facilityId, capacityResourceIds: terms[0].capacityResourceIds,
      executionDigest: capitalDigest("Original exact shared facility correction") };
    sourceEvents.push(...await originalEvents(shared, false)); await t.startWorker();
    const overallocated = await t.current(f, v => v.current && v.package?.conflicts.some((c: string) => c.startsWith("SHARED_CAPACITY_EXCEEDED:")));
    assert.equal(overallocated.package.eligibleUndrawnMinor, "0"); await t.stopWorker();
    const ambiguous = { ...shared, capacityResourceIds: terms[1].capacityResourceIds, executionDigest: capitalDigest("Original disjoint capacity alias correction") };
    sourceEvents.push(...await originalEvents(ambiguous, false));
    const { ref: bRef, revision: _bRevision, priorRef: _bPrior, ...bResource } = resources[1];
    ok(await t.http(f, "allocations/resource", { resource: { ...bResource,
      sourceRef: { ...bResource.sourceRef, contentDigest: capitalDigest(ambiguous) } }, expectedRef: bRef }));
    await t.startWorker();
    const aliasCapacity = await t.current(f, v => v.current && v.package?.conflicts.some((c: string) => c.startsWith("CANONICAL_FACILITY_CAPACITY_IDENTITY_AMBIGUOUS:")));
    assert.equal(aliasCapacity.package.eligibleUndrawnMinor, "0"); await t.stopWorker();
    const alias = { ...shared, instrumentIdentity: terms[0].instrumentIdentity, executionDigest: capitalDigest("Original duplicate document alias") };
    sourceEvents.push(...await originalEvents(alias, false)); await t.startWorker();
    const aliased = await t.current(f, v => v.current && v.package?.conflicts.some((c: string) => c.startsWith("ALIASED_COMMITMENT:")));
    assert.equal(aliased.package.eligibleUndrawnMinor, "0");
    await t.stopWorker();
    const pendingEvents = [], largeAmount = "9".repeat(38);
    for (let n = 0; n < 17; n++) {
      const pending = { ...bases[0], commitmentIdentity: "wide-pending-" + n, instrumentIdentity: randomUUID(), facilityId: randomUUID(),
        amount: { ...bases[0]!.amount, amountMinor: largeAmount }, executionDigest: capitalDigest("Original authenticated pending offer " + n),
        conditions: Array.from({ length: 64 }, (_, k) => ({ ...terms[0].conditions[0], id: "pending-condition-" + n + "-" + k, dependencyCommitmentIds: [] })) };
      const event = await f.domainActors.CORPORATE_DEBT.provider.rpc("EVENT", { kind: "OFFER", context: {
        programmeId: f.mandate.programmeId, providerEntityId: pending.providerEntityId, representativeId: pending.representativeId,
        instrument: pending.instrument, commitmentIdentity: pending.commitmentIdentity, terms: pending,
      }, extra: { terms: pending, cost: { receiptId: "pending-offer-" + n, microUSD: "0", final: true } } });
      ok(await t.cb(f, "capital-formation-event", { programmeId: f.mandate.programmeId, event })); pendingEvents.push(event);
    }
    await t.startWorker();
    const wide = await t.current(f, v => v.current && v.package?.remainingConditions.length >= 1088);
    const wire = capitalFormationView.parse(wide);
    assert.equal(wire.package!.faceMinor, (BigInt(aliased.package.faceMinor) + 17n * BigInt(largeAmount)).toString());
    assert(wire.package!.faceMinor.length > 38);
    assert.equal(wire.package!.remainingConditions.length, wide.package.remainingConditions.length);
    assert.equal(wire.package!.fundingReceivedMinor, "0"); assert.equal(wire.package!.readiness, "INCOMPLETE");
    await t.artifact("boundaries/scoped-cycles-and-duties.json", { initial, published, sourceEvents, resources, cyclicSnapshot,
      independentOracle: JSON.parse(oracle.stdout), circular, corrected, acyclic, notice, movedTranche, currentTranche, excessGuarantee, guaranteeRejected,
      covenantA, covenantB, covenantConflict, covenantAmendment, amendedCovenant,
      shadowProfile: f.shadowProfile, selectedDebt, shared, overallocated, ambiguous, aliasCapacity, alias, aliased, pendingEvents, wide, wire,
      noFundingObserved: true });
    await stop(f); t.dispose(f);
    return { issuerLocalIdsNotAliased: true, threeNodeCycleDetected: true, circularEligibleMinor: "0", acyclicEligibleMinor: "12000000000",
      equalLocalObligationIdsRetained: 3, receivedMinor: acyclic.package.fundingReceivedMinor };
  });
  await t.check("C_PROFESSIONAL_ACTIVITY_INDEPENDENCE", "Actual exact professional review rejects representative and shared-key substitutions before any POST", async () => {
    const observations = [];
    for (const activityReview of ["REPRESENTATIVE", "SHARED_KEY", "INDEPENDENT"]) {
      const f = await t.fixture("activity-" + activityReview.toLowerCase().replaceAll("_", "-"), { activityReview });
      const result = await t.cb(f, "capital-formation-submit", f.request);
      if (activityReview === "INDEPENDENT") {
        assert.equal(result.status, 202, JSON.stringify(result));
        await t.current(f, v => v.current && v.package?.conditionalCommittedMinor === "8000000000"); await stop(f);
      } else { assert.equal(result.status, 409); assert.equal(result.body.code, "EXACT_PROFESSIONAL_ACTIVITY_SCOPE_UNESTABLISHED"); }
      const readbacks = await Promise.all(Object.values(f.domainActors).map((group: any) => group.provider.rpc("READBACK")));
      const posts = readbacks.flatMap(r => r.calls).filter(c => c.method === "POST").length;
      assert.equal(posts, activityReview === "INDEPENDENT" ? 1 : 0);
      observations.push({ activityReview, originalRequest: f.request, result, posts, readbacks }); t.dispose(f);
    }
    await t.artifact("boundaries/professional-activity-independence.json", observations);
    return { independentPositivePosts: 1, representativeSubstitutionPosts: 0, sharedKeySubstitutionPosts: 0, noDisclosedBytesOnRejection: true };
  });
  await t.check("E_EXACT_PROVIDER_COST_CEILING", "Authenticated excess cost reconciles original delivery but cannot widen the operation ceiling or episode grant", async () => {
    const f = await t.fixture("provider-overrun", { providerCostMicroUSD: "3000" }); await submit(f);
    const view = await t.current(f, v => v.current && v.status === "BLOCKED" && v.budget.costCeilingMicroUSD === "3250");
    const before = await state(f), advance = await t.cb(f, "capital-formation-advance", { programmeId: f.mandate.programmeId,
      expectedRevision: view.revision, triggerRef: "Original grant cannot cure an authenticated operation-price overrun" });
    assert.equal(advance.status, 409); assert.equal(advance.body.code, "ORIGINAL_EPISODE_STOPPED_OR_EXHAUSTED");
    assert.deepEqual(await state(f), before);
    const readbacks = await Promise.all(Object.values(f.domainActors).map((group: any) => group.provider.rpc("READBACK")));
    assert.equal(readbacks.flatMap(r => r.calls).filter(c => c.method === "POST").length, 1);
    const observed = (await t.admin.query("SELECT body FROM finnor_os.v4_transitions WHERE tenant_id=$1 AND kind='INDEPENDENT_PROVIDER_OPERATION_OBSERVED'", [f.tenant])).rows;
    assert.equal(observed[0].body.originalCostCeilingMicroUSD, "2500"); assert.equal(observed[0].body.authenticatedCostMicroUSD, "3250");
    assert(!("costs" in observed[0].body)); assert(observed[0].body.receiptEvidenceVersionIds.length > 0);
    assert(Buffer.byteLength(canonicalCapital(observed[0].body)) < 65536);
    const operation = (await t.admin.query("SELECT execution_state FROM finnor_os.external_operations WHERE tenant_id=$1", [f.tenant])).rows;
    assert.equal(operation[0].execution_state, "reconciled");
    const original = (await snapshot(f)).events.find(e => e.body.kind === "COMMITMENT_EXECUTED")!;
    const late = await f.domainActors.CORPORATE_DEBT.provider.rpc("EVENT", { kind: "CORRECTION", context: original.body,
      extra: { terms: original.body.terms, cost: { receiptId: "late-distinct-charge", microUSD: "2000", final: true } } });
    ok(await t.cb(f, "capital-formation-event", { programmeId: f.mandate.programmeId, event: late }));
    const afterLate = await t.current(f, v => v.status === "BLOCKED" && v.budget.costCeilingMicroUSD === "5250");
    assert.equal((await state(f)).contacts_spent, before.contacts_spent);
    const wideReceipts = [], largeCost = "9".repeat(38);
    for (let n = 0; n < 2; n++) {
      const event = await f.domainActors.CORPORATE_DEBT.provider.rpc("EVENT", { kind: "CORRECTION", context: original.body,
        extra: { terms: original.body.terms, cost: { receiptId: "wide-distinct-charge-" + n, microUSD: largeCost, final: true } } });
      ok(await t.cb(f, "capital-formation-event", { programmeId: f.mandate.programmeId, event })); wideReceipts.push(event);
    }
    const expectedWideCost = (5250n + 2n * BigInt(largeCost)).toString();
    const wide = await t.current(f, v => v.current && v.status === "BLOCKED" && v.budget.costCeilingMicroUSD === expectedWideCost);
    assert.equal((await state(f)).cost_ceiling_micro_usd, expectedWideCost);
    assert.equal(capitalFormationView.parse(wide).budget.costCeilingMicroUSD, expectedWideCost);
    assert.equal((await state(f)).contacts_spent, before.contacts_spent);
    await t.stopWorker();
    const longReceiptEvents = [];
    for (let n = 0; n < 128; n++) {
      const event = await f.domainActors.CORPORATE_DEBT.provider.rpc("EVENT", { kind: "CORRECTION", context: original.body,
        extra: { terms: original.body.terms, cost: { receiptId: ("long-receipt-" + n + "-").padEnd(512, "x"), microUSD: "0", final: true } } });
      ok(await t.cb(f, "capital-formation-event", { programmeId: f.mandate.programmeId, event })); longReceiptEvents.push(event);
    }
    const compact = (await t.admin.query(`SELECT body FROM finnor_os.v4_transitions
      WHERE tenant_id=$1 AND kind='INDEPENDENT_PROVIDER_OPERATION_OBSERVED' ORDER BY created_at DESC,id DESC LIMIT 1`, [f.tenant])).rows[0].body;
    const retained = await snapshot(f);
    const expectedEvidence = retained.events.flatMap((event, index) => event.body.operationId === original.body.operationId
      ? [retained.eventReferences[index]!.evidenceVersionId] : []);
    assert.deepEqual(compact.receiptEvidenceVersionIds, expectedEvidence);
    assert(compact.receiptCount >= 128); assert(!("costs" in compact));
    assert(Buffer.byteLength(canonicalCapital(compact)) < 65536);
    assert.equal(compact.authenticatedCostMicroUSD, expectedWideCost);
    const sourceNotice = (await t.admin.query("SELECT body FROM finnor_os.s7_economic_records WHERE tenant_id=$1 AND idempotency_key=$2",
      [f.tenant, `v4-operation-cost:${original.body.operationId}:${compact.receiptDigest}`])).rows[0].body;
    assert.deepEqual(sourceNotice.payload.receiptEvidenceVersionIds, expectedEvidence);
    await t.artifact("boundaries/exact-cost-overrun.json", { originalRequest: f.request, view, before, advance, observed, operation, readbacks, late, afterLate,
      wideReceipts, expectedWideCost, wide, longReceiptEvents, compact, retained, sourceNotice, originalGrantUnchanged: true });
    await stop(f); await t.startWorker(); t.dispose(f);
    return { frozenOperationCeilingMicroUSD: "2500", retainedAuthenticatedCostMicroUSD: "3250", lateRetainedCostMicroUSD: "5250",
      posts: 1, originalOperationReconciled: true, newGrant: false };
  });
  await t.check("E_UNRESOLVED_COST_RECEIPT", "Nonfinal and contradictory exact issuer-local cost receipts keep original exposure and block budget renewal", async () => {
    const f = await t.fixture("cost-finality", { providerCostFinal: false }); await submit(f);
    const unresolved = await t.current(f, v => v.status === "RECONCILING" && v.budget.costUnknown && v.budget.contactsSpent === 1 && v.package);
    const publicationCount = (await t.admin.query("SELECT count(*)::int n FROM finnor_os.v4_publications WHERE tenant_id=$1", [f.tenant])).rows[0].n;
    await sleep(2200);
    const unchangedCount = (await t.admin.query("SELECT count(*)::int n FROM finnor_os.v4_publications WHERE tenant_id=$1", [f.tenant])).rows[0].n;
    assert.equal(unchangedCount, publicationCount);
    await t.stopWorker();
    const original = (await snapshot(f)).events.find(e => e.body.kind === "COMMITMENT_EXECUTED")!;
    const before = await f.domainActors.CORPORATE_DEBT.provider.rpc("READBACK");
    assert.equal(before.calls.filter((c: any) => c.method === "POST").length, 1);
    const final = await f.domainActors.CORPORATE_DEBT.provider.rpc("EVENT", { kind: "CORRECTION", context: original.body,
      extra: { terms: original.body.terms, cost: { ...original.body.cost, final: true } } });
    ok(await t.cb(f, "capital-formation-event", { programmeId: f.mandate.programmeId, event: final }));
    assert(original.body.operationId && before.operations.some((o: any) => o.operationId === original.body.operationId));
    // Pause the actual native delivery-state update, not a mock transport.
    // A concurrent ordinary source write must survive the worker's completion.
    await t.admin.query(`CREATE FUNCTION finnor_os.v4_test_finality_pause() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(2); RETURN NEW; END $$;
      CREATE TRIGGER v4_test_finality_pause BEFORE UPDATE OF execution_state ON finnor_os.external_operations
      FOR EACH ROW WHEN (NEW.id='${original.body.operationId}'::uuid AND NEW.execution_state='reconciled')
      EXECUTE FUNCTION finnor_os.v4_test_finality_pause()`);
    await t.startWorker();
    const pauseDeadline = Date.now() + 15000;
    while (!(await t.admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event='PgSleep'")).rows[0].n) {
      assert(Date.now() < pauseDeadline, "Original native finality race observation deadline"); await sleep(50);
    }
    const raceReceipt = await f.domainActors.CORPORATE_DEBT.provider.rpc("EVENT", { kind: "CORRECTION", context: original.body,
      extra: { terms: original.body.terms, cost: { receiptId: "concurrent-late-nonfinal-cost", microUSD: "100", final: false } } });
    ok(await t.cb(f, "capital-formation-event", { programmeId: f.mandate.programmeId, event: raceReceipt }));
    const raceObserved = await read(f); assert.equal(raceObserved.budget.costUnknown, true);
    await t.stopWorker();
    await t.admin.query("DROP TRIGGER v4_test_finality_pause ON finnor_os.external_operations; DROP FUNCTION finnor_os.v4_test_finality_pause()");
    const raceFinal = await f.domainActors.CORPORATE_DEBT.provider.rpc("EVENT", { kind: "CORRECTION", context: original.body,
      extra: { terms: original.body.terms, cost: { ...raceReceipt.body.cost, final: true } } });
    ok(await t.cb(f, "capital-formation-event", { programmeId: f.mandate.programmeId, event: raceFinal }));
    await t.startWorker(); const resolved = await sourceReady(f); await t.stopWorker();
    const pending = await f.domainActors.CORPORATE_DEBT.provider.rpc("EVENT", { kind: "CORRECTION", context: original.body,
      extra: { terms: original.body.terms, cost: { receiptId: "late-distinct-pending-cost", microUSD: "100", final: false } } });
    ok(await t.cb(f, "capital-formation-event", { programmeId: f.mandate.programmeId, event: pending }));
    assert.equal((await read(f)).budget.costUnknown, true);
    const lateFinal = await f.domainActors.CORPORATE_DEBT.provider.rpc("EVENT", { kind: "CORRECTION", context: original.body,
      extra: { terms: original.body.terms, cost: { ...pending.body.cost, final: true } } });
    ok(await t.cb(f, "capital-formation-event", { programmeId: f.mandate.programmeId, event: lateFinal }));
    assert.equal((await read(f)).budget.costUnknown, false);
    const intervening = await f.domainActors.CORPORATE_DEBT.provider.rpc("EVENT", { kind: "CORRECTION", context: original.body,
      extra: { terms: original.body.terms, cost: { ...original.body.cost, microUSD: "1100", final: false } } });
    ok(await t.cb(f, "capital-formation-event", { programmeId: f.mandate.programmeId, event: intervening }));
    const contradictory = await f.domainActors.CORPORATE_DEBT.provider.rpc("EVENT", { kind: "CORRECTION", context: original.body,
      extra: { terms: original.body.terms, cost: { ...original.body.cost, microUSD: "1100", final: true } } });
    ok(await t.cb(f, "capital-formation-event", { programmeId: f.mandate.programmeId, event: contradictory }));
    const conflict = await read(f); assert.equal(conflict.budget.costUnknown, true);
    const rejection = await t.cb(f, "capital-formation-advance", { programmeId: f.mandate.programmeId, expectedRevision: conflict.revision,
      triggerRef: "A contradictory final source cannot renew the original budget" });
    assert.equal(rejection.status, 409); assert.equal(rejection.body.code, "ORIGINAL_EPISODE_STOPPED_OR_EXHAUSTED");
    const cost = (await t.admin.query("SELECT body FROM finnor_os.v4_transitions WHERE tenant_id=$1 AND kind='INDEPENDENT_PROVIDER_OPERATION_OBSERVED' ORDER BY created_at", [f.tenant])).rows;
    assert(cost.some((r: any) => r.body.conflictingFinalReceipt && !r.body.costFinal));
    const after = await f.domainActors.CORPORATE_DEBT.provider.rpc("READBACK");
    assert.equal(after.calls.filter((c: any) => c.method === "POST").length, 1);
    assert(after.calls.some((c: any) => c.method === "GET"));
    await t.startWorker();
    const costTraceView = await t.current(f, v => v.current && v.budget.costUnknown && v.publicationDigest !== resolved.publicationDigest);
    await t.stopWorker();
    const costTrace = (await publication(f))!, retainedFacts = costTrace.artifacts.flatMap(a => a.envelope.cost_receipts)
      .filter(r => r.issuerId === original.body.issuerId && r.receiptId === original.body.cost.receiptId);
    for (const event of [original, final, intervening, contradictory]) {
      assert(retainedFacts.some(r => r.microUSD === event.body.cost.microUSD && r.final === event.body.cost.final));
    }
    await t.artifact("boundaries/cost-finality.json", { originalRequest: f.request, unresolved, publicationCount, unchangedCount,
      before, final, raceReceipt, raceObserved, raceFinal, resolved, pending, lateFinal, intervening, contradictory, conflict, rejection, cost, after,
      costTraceView, costTrace, retainedFacts });
    await stop(f); await t.startWorker(); t.dispose(f);
    return { initialUnknownRetained: true, authenticatedSameReceiptFinalization: true, conflictingFinalReceiptRetained: true,
      originalProviderPosts: 1, originalGetRecovery: true, finalCostFalselyDeclared: false };
  });
  await t.check("G_ORIGINAL_RECOVERY_AFTER_STOP", "Original process-loss recovery survives cancellation and disclosure revocation without renewed activity or stale publication", async () => {
    const f = await t.fixture("stop-after-acceptance", { delayed: true }), provider = f.domainActors.CORPORATE_DEBT.provider;
    const accepted = new Promise<any>((yes, no) => {
      const listener = (m: any) => { if (m.kind === "ACCEPTED_ORIGINAL_OPERATION" && m.programmeId === f.mandate.programmeId) {
        clearTimeout(timer); provider.cp.off("message", listener); yes(m);
      } };
      const timer = setTimeout(() => { provider.cp.off("message", listener); no(Error("Finite original acceptance observation")); }, 30000);
      provider.cp.on("message", listener);
    });
    await submit(f); const original = await accepted; await t.killWorker();
    const before = (await t.admin.query("SELECT id,request_hash,execution_state FROM finnor_os.external_operations WHERE tenant_id=$1", [f.tenant])).rows;
    const stopped = await stop(f);
    await t.admin.query("UPDATE finnor_os.s1_capital_disclosures SET revision=revision+1,revoked=true WHERE tenant_id=$1 AND programme_id=$2", [f.tenant, f.mandate.programmeId]);
    // Wait only for the original native 15-second physical lease. Neither the
    // programme's 600-second deadline nor the native 60-second retry is renewed.
    await sleep(18000);
    const acceptedSources = (await provider.rpc("READBACK")).operations.find((o: any) => o.operationId === original.operationId).answer.events;
    ok(await t.cb(f, "capital-formation-event", { programmeId: f.mandate.programmeId, event: acceptedSources[0] }));
    await t.startWorker();
    const deadline = Date.now() + 100000;
    let after;
    while (Date.now() < deadline) {
      after = (await t.admin.query("SELECT id,request_hash,execution_state FROM finnor_os.external_operations WHERE tenant_id=$1 AND id=$2", [f.tenant, original.operationId])).rows[0];
      if (after.execution_state === "reconciled") break;
      await sleep(200);
    }
    assert.equal(after.execution_state, "reconciled"); assert.equal(after.request_hash, before[0].request_hash);
    const terminal = await read(f), readback = await provider.rpc("READBACK");
    assert.equal(terminal.status, "STOPPED"); assert.equal(terminal.current, false); assert.equal(terminal.package, null);
    assert.equal(readback.calls.filter((c: any) => c.method === "POST").length, 1);
    assert(readback.calls.some((c: any) => c.method === "GET"));
    assert.equal(terminal.budget.contactsSpent, 1);
    const notices = (await t.admin.query("SELECT body FROM finnor_os.s7_economic_records WHERE tenant_id=$1 AND body->'payload'->>'schema'='finnor.v4.operation-cost-source.v1'", [f.tenant])).rows;
    assert(notices.some((r: any) => r.body.payload.costFinal && r.body.payload.authenticatedCostMicroUSD === "1250"));
    await t.artifact("boundaries/original-recovery-after-stop.json", { originalRequest: f.request, original, before, stopped, after, terminal, readback, notices,
      actualLeaseObservationMs: 18000, originalProgrammeDeadlineUnchanged: true, finalPhysicalCostNotQualified: true });
    t.dispose(f);
    return { status: "STOPPED", posts: 1, getOnlyRecovery: true, stalePublicationAvailable: false,
      originalRequestHashPreserved: true, sameGrantResponsibilityAndS7CostsRetained: true };
  });
  await t.check("S7_ATOMIC_NOTICE", "Native S7 notice refusal rolls back V4 publication; original source/cost survives and same-grant repair commits both owners together", async () => {
    const f = await t.fixture("s7-atomic");
    assert.match(f.mandate.programmeId, /^[0-9a-f-]{36}$/);
    await t.admin.query(`CREATE FUNCTION finnor_os.v4_fixture_reject_s7() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.body->'payload'->>'programmeId'='${f.mandate.programmeId}' AND NEW.body->'payload'->>'schema'='finnor.v4.economic-notice.v1'
        THEN RAISE EXCEPTION 'FINITE_V4_S7_NOTICE_REFUSAL'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER v4_fixture_reject_s7 BEFORE INSERT ON finnor_os.s7_economic_records FOR EACH ROW EXECUTE FUNCTION finnor_os.v4_fixture_reject_s7();`);
    try {
      await submit(f);
      await t.current(f, v => v.status === "BLOCKED" && v.authenticatedEventCount >= 3 && !v.package);
      const failed = (await t.admin.query("SELECT * FROM finnor_os.v4_publications WHERE tenant_id=$1", [f.tenant])).rows;
      assert.deepEqual(failed, []);
      await t.artifact("boundaries/s7-atomic-refusal.json", { originalRequest: f.request, publications: failed,
        retainedSources: (await t.admin.query("SELECT issuer_id,event_id,integrity_digest FROM finnor_os.v4_source_events WHERE tenant_id=$1", [f.tenant])).rows,
        state: await state(f), noPublicationWithoutNotice: true });
    } finally {
      await t.admin.query("DROP TRIGGER v4_fixture_reject_s7 ON finnor_os.s7_economic_records; DROP FUNCTION finnor_os.v4_fixture_reject_s7();");
    }
    const v = await read(f);
    ok(await t.cb(f, "capital-formation-advance", { programmeId: f.mandate.programmeId, expectedRevision: v.revision,
      triggerRef: "Exact native S7 availability restored; same original Work, grant and deadline" }));
    const restored = await sourceReady(f);
    const row = (await t.admin.query(`SELECT p.content_digest,s.body,s.event FROM finnor_os.v4_publications p
      JOIN finnor_os.s7_economic_records s ON s.tenant_id=p.tenant_id AND s.principal_id=p.principal_id
        AND s.idempotency_key='v4-notice:'||p.content_digest WHERE p.tenant_id=$1`, [f.tenant])).rows;
    assert(row.length > 0);
    for (const r of row) {
      const delivery = (await t.admin.query("SELECT kind,identity FROM finnor_os.s6_owner_delivery_origins WHERE tenant_id=$1 AND semantic_owner='S7' AND identity=ANY($2::text[])",
        [f.tenant, [r.body.ref.id, r.event.eventId]])).rows;
      assert.equal(delivery.length, 2);
    }
    const readback = await f.domainActors.CORPORATE_DEBT.provider.rpc("READBACK");
    assert.equal(readback.calls.filter((c: any) => c.method === "POST").length, 1);
    await t.artifact("boundaries/s7-atomic-restored.json", { restored, row, readback, protectedReceipt: null, principalAsProfit: false });
    await t.stopWorker();
    const manifestPath = join(t.repo, "finnor-os/packages/private-equity/src/capital-formation/method-files.json"), original = await readFile(manifestPath);
    await t.check("RUNTIME_INSTALLED_SOURCE_CHANGE", "Real installed API fails closed on an owned pinned-source edit and exact restoration preserves original programme identity", async () => {
      let rejected;
      try {
        await writeFile(manifestPath, Buffer.concat([original, Buffer.from("\n")]));
        rejected = await read(f); assert.equal(rejected.current, false); assert.equal(rejected.package, null);
        assert(rejected.blockers.includes("INSTALLED_V4_METHOD_CHANGED"));
      } finally { await writeFile(manifestPath, original); }
      assert.equal(capitalDigest(await readFile(manifestPath)), capitalDigest(original));
      await t.artifact("boundaries/installed-source-change.json", { originalManifestDigest: capitalDigest(original), restoredManifestDigest: capitalDigest(await readFile(manifestPath)),
        rejected, originalWorkId: f.workId, originalProgrammeId: f.mandate.programmeId, unchangedGrant: f.mandate.budgetGrantRef });
      return { staleInstalledResultAvailable: false, exactSourceRestored: true, newProgrammeOrGrant: false };
    });
    await stop(f); await t.startWorker(); t.dispose(f);
    return { refusedNoticePublicationCount: 0, restoredAtomicPairs: row.length, originalProviderPosts: 1, nativeS7DeliveryOrigins: true, protectedReceipt: null };
  });
}
