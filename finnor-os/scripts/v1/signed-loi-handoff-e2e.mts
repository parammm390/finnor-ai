/** Affected authenticated E2E slice, composed into the existing native campaign.
 * Fixture qualifications are synthetic. No Deal or acceptance is seeded. */
import { strict as assert } from "node:assert";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { closingDigest } from "../../packages/private-equity/src/closing/compiler";
import { ClosingProfileSchema } from "../../packages/private-equity/src/closing/contracts";

export async function prepareSignedLoiHandoff(params: {
  admin: pg.Client; tenant: string; actor: string; buyer: string;
  publicKeyPem: string; validUntil: string;
}) {
  const { admin, tenant, actor, buyer, publicKeyPem, validUntil } = params;
  const signer = randomUUID(), role = randomUUID(), dealId = randomUUID();
  await admin.query(`INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name)
    VALUES($1,$2,$3,'owner','active','Independent synthetic LOI record issuer')`,
  [signer, tenant, signer + "@test.invalid"]);
  await admin.query(`INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name)
    VALUES($1,$2,'development-signed-loi-handoff','Finite development handoff')`, [role, tenant]);
  await admin.query(`INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk)
    VALUES($1,$2,'private_equity:promote_opportunity','pe_opportunity','allow','high')`, [tenant, role]);
  await admin.query(`INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope,expires_at)
    VALUES($1,$2,$3,'{"kind":"tenant"}'::jsonb,$4)`, [tenant, actor, role, validUntil]);
  const assignment = (await admin.query(`SELECT to_jsonb(a) assignment,to_jsonb(r) definition
    FROM finnor_os.employee_role_assignments a JOIN finnor_os.employee_roles r
      ON r.tenant_id=a.tenant_id AND r.id=a.role_id
    WHERE a.tenant_id=$1 AND a.employee_id=$2 AND a.active AND r.key='owner'`, [tenant, actor])).rows[0];
  assert(assignment, "REAL_BOOTSTRAP_OWNER_ASSIGNMENT_REQUIRED");
  const ref = (id: string) => ({ owner: "INDEPENDENT_DEVELOPMENT_FIXTURE", kind: "NOT_LIVE_QUALIFICATION",
    id, version: "1", contentDigest: closingDigest({ syntheticScope: id }) });
  const profiles = [];
  for (const scoped of [true, false]) {
    const id = "loi-" + randomUUID();
    const body = ClosingProfileSchema.parse({
      schema: "finnor.closing-profile.v1", environment: "DEVELOPMENT",
      checkerDigest: closingDigest({ purpose: "SIGNED_LOI_PROMOTION", synthetic: true }),
      legalScope: "DISPOSABLE_SIGNED_RECORD_PROTOCOL_NOT_COUNSEL_QUALIFICATION",
      issuers: [{ id: "independent-loi-source", publicKeyPem, actorId: signer, status: "ACTIVE",
        qualifiedScopes: scoped ? ["signed-loi"] : ["closing-spec"], kinds: ["DOCUMENT_EXECUTION"],
        channels: ["separate-owned-loi-http"], validUntil, environment: "DEVELOPMENT",
        qualificationRef: ref("synthetic-exact-signed-record") }],
      roleBindings: [{ ref: ref(assignment.assignment.id), principalId: actor,
        assignmentId: assignment.assignment.id, assignmentDigest: closingDigest(assignment.assignment),
        roleDefinitionDigest: closingDigest(assignment.definition), legalEntityIds: [buyer] }],
      providers: [], admission: null, prerequisiteAdmissions: { V1: null, V2: null },
      irreversibleOrdering: "EXPLICIT_DEPENDENCIES_WITH_RETAINED_EXPOSURE_NOT_ATOMIC",
    });
    const { admission: _admission, ...preimage } = body, digest = closingDigest(preimage);
    await admin.query(`INSERT INTO finnor_os.pe_closing_profiles(tenant_id,id,revision,environment,status,body,digest,valid_until)
      VALUES($1,$2,1,'DEVELOPMENT','ACTIVE',$3::jsonb,$4,$5)`, [tenant, id, JSON.stringify(body), digest, validUntil]);
    profiles.push({ id, digest });
  }
  return { profiles, signer, dealId, token: randomBytes(24).toString("base64url"), validUntil };
}
export type SignedLoiFixture = Awaited<ReturnType<typeof prepareSignedLoiHandoff>>;

export async function exerciseSignedLoiHandoff(params: {
  admin: pg.Client; tenant: string; actor: string; buyer: string; company: string; origin: string;
  fixture: SignedLoiFixture; programmeId: string; artifact: any; artifactRef: any;
  workId: string; workInputId: string; investmentCaseId: string;
  call: (operation: string, value: unknown, expected?: number) => Promise<any>;
}) {
  const { admin, tenant, actor, buyer, company, fixture, call } = params;
  const opportunityId = params.artifact.opportunityId, documentId = randomUUID();
  const signedAt = new Date().toISOString();
  const document = Buffer.from(JSON.stringify({ schema: "finnor.development-loi.v1",
    programmeId: params.programmeId, opportunityId, workId: params.workId, workInputId: params.workInputId,
    investmentCaseId: params.investmentCaseId, dealId: fixture.dealId, buyerId: buyer, companyId: company,
    terms: params.artifact.terms, signedAt, qualification: "SYNTHETIC_NOT_LEGAL_OR_LIVE" }));
  await admin.query(`INSERT INTO finnor_os.documents(id,tenant_id,kind,title,source_system,created_by)
    VALUES($1,$2,'signed_loi','Exact synthetic signed-LOI input','v1:independent-development',$3)`, [documentId, tenant, actor]);
  await admin.query(`INSERT INTO finnor_os.document_contents(document_id,tenant_id,bytes,size_bytes,content_type)
    VALUES($1,$2,$3,$4,'application/json')`, [documentId, tenant, document, document.length]);
  const versions = (await admin.query(`SELECT
    (SELECT version FROM finnor_os.pe_opportunities WHERE tenant_id=$1 AND id=$2) opportunity,
    (SELECT version FROM finnor_os.pe_investment_cases WHERE tenant_id=$1 AND id=$3) investment_case`,
  [tenant, opportunityId, params.investmentCaseId])).rows[0];
  const goalBefore = (await admin.query(`SELECT objective,success_condition,deadline_at,max_steps,max_actions,max_queries
    FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2`, [tenant, params.workId])).rows[0];
  const inputCount = (await admin.query("SELECT count(*)::int n FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2",
    [tenant, params.workId])).rows[0].n;
  const unsigned = {
    opportunityId, qualifiedOpportunityRef: params.artifactRef, expectedOpportunityVersion: versions.opportunity,
    workId: params.workId, expectedWorkInputId: params.workInputId, investmentCaseId: params.investmentCaseId,
    expectedInvestmentCaseVersion: versions.investment_case, profileId: fixture.profiles[0]!.id,
    expectedProfileDigest: fixture.profiles[0]!.digest,
    deal: { id: fixture.dealId, name: "Actual native Opportunity signed-LOI handoff",
      dealLeadEmployeeId: actor, targetClosingAt: new Date(Date.now() + 86400000).toISOString() },
    loi: { documentId, documentDigest: createHash("sha256").update(document).digest("hex"), signedAt },
  };
  async function signed(request = unsigned) {
    const response = await fetch(params.origin + "/loi-attest", { method: "POST",
      headers: { authorization: "Bearer " + fixture.token, "content-type": "application/json" },
      body: JSON.stringify({ request, document: document.toString("base64") }), signal: AbortSignal.timeout(5000) });
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
    return { ...request, attestation: body };
  }
  const countDeals = async () => (await admin.query(`SELECT count(*)::int n FROM finnor_os.pe_deals
    WHERE tenant_id=$1 AND opportunity_id=$2`, [tenant, opportunityId])).rows[0].n;
  const accepted = await signed(), refusals: Array<{ name: string; response: unknown }> = [];
  const refuse = async (name: string, input: unknown, expected = 422) => {
    refusals.push({ name, response: await call("opportunity-promote", input, expected) });
    assert.equal(await countDeals(), 0, name + "_MUST_NOT_PROMOTE");
  };
  await refuse("forged-signature", { ...accepted, attestation: { ...accepted.attestation, signature: Buffer.alloc(64).toString("base64") } });
  await refuse("wrong-purpose", { ...accepted, attestation: { ...accepted.attestation, purpose: "LEGAL_SPEC_ACCEPTANCE" } }, 400);
  await refuse("self-attestation", { ...accepted, attestation: { ...accepted.attestation, actorId: actor } });
  await refuse("expired-attestation", { ...accepted, attestation: { ...accepted.attestation, validUntil: new Date(Date.now() - 1000).toISOString() } });
  await refuse("changed-profile-digest", { ...accepted, expectedProfileDigest: "0".repeat(64) });
  await refuse("missing-explicit-signed-loi-scope", await signed({ ...unsigned,
    profileId: fixture.profiles[1]!.id, expectedProfileDigest: fixture.profiles[1]!.digest }));
  const wrongDigest = await signed();
  await admin.query("UPDATE finnor_os.document_contents SET bytes=$3,size_bytes=$4 WHERE tenant_id=$1 AND document_id=$2",
    [tenant, documentId, Buffer.from("Changed actual retained bytes"), 29]);
  await refuse("changed-retained-bytes", wrongDigest);
  await admin.query("UPDATE finnor_os.document_contents SET bytes=$3,size_bytes=$4 WHERE tenant_id=$1 AND document_id=$2",
    [tenant, documentId, document, document.length]);
  await refuse("stale-case-atomic-rollback", await signed({ ...unsigned, expectedInvestmentCaseVersion: versions.investment_case + 1 }), 409);
  const stateAfterRollback = (await admin.query("SELECT state,version FROM finnor_os.pe_opportunities WHERE tenant_id=$1 AND id=$2",
    [tenant, opportunityId])).rows[0];
  assert.equal(stateAfterRollback.state, "qualified"); assert.equal(stateAfterRollback.version, versions.opportunity);
  const result = await call("opportunity-promote", accepted);
  const replay = await call("opportunity-promote", accepted);
  assert.equal(result.deal.id, fixture.dealId); assert.equal(result.investmentCase.id, params.investmentCaseId);
  assert.equal(result.investmentCase.dealId ?? result.investmentCase.deal_id, fixture.dealId);
  assert.equal(result.workId, params.workId); assert.equal(result.workInputId, params.workInputId);
  assert.equal(result.receiptDigest, replay.receiptDigest); assert.equal(await countDeals(), 1);
  assert.equal(result.liveAdmissionGranted, false); assert.equal(result.financingOrSettlementAuthorityGranted, false);
  const conflict = await signed({ ...unsigned, deal: { ...unsigned.deal, name: unsigned.deal.name + " conflicting retry" } });
  await call("opportunity-promote", conflict, 409); assert.equal(await countDeals(), 1);
  const goalAfter = (await admin.query(`SELECT objective,success_condition,deadline_at,max_steps,max_actions,max_queries
    FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2`, [tenant, params.workId])).rows[0];
  assert.deepEqual(goalAfter, goalBefore, "FULL_ORIGINAL_GOAL_AND_GRANTS_MUST_NOT_BE_REPLACED");
  assert.equal((await admin.query("SELECT count(*)::int n FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2",
    [tenant, params.workId])).rows[0].n, inputCount);
  const retained = (await admin.query(`SELECT v.snapshot FROM finnor_os.evidence_source_versions v
    JOIN finnor_os.evidence_sources s ON s.id=v.source_id
    WHERE s.tenant_id=$1 AND s.source_key=$2 ORDER BY v.version_number DESC LIMIT 1`,
  [tenant, "signed-loi-handoff:" + fixture.dealId])).rows[0];
  assert.deepEqual(retained.snapshot.signedLoiHandoff, accepted);
  return { classification: "DEVELOPMENT_ENGINEERING_NOT_PROFESSIONAL_OR_LIVE_QUALIFICATION",
    independentlySignedOverActualHttp: true, result, replay, refusals, stateAfterRollback,
    originalGoalPreserved: true, originalInputPreserved: true, retainedEvidence: retained };
}
