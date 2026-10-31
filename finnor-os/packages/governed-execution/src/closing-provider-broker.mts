/** Separate S6 process. Only this process receives provider credential bindings.
 * The normal worker has native effect refs and a broker client credential only. */
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import pg from "pg";
import { ClosingSpecSchema } from "@finnor/shared-types";
import { ClosingProfileSchema } from "../../private-equity/src/closing/contracts";
import { validateClosingAdmission } from "../../capability-evolution/src/closing-admission";
import { ClosingBrokerRequestSchema, closingOperationRequest, closingProviderContractDigest, originalClosingRequirement } from "./closing-provider";
import { workforceCompensationPrepareSchema, workforceCompensationBoundaryRefusal } from "../../private-equity/src/workforce-compensation-payment";
import { brokerOrigin, brokerPrivateFile, brokerRequest, brokerToken } from "./broker-io";

const url = process.env.FINNOR_V3_BROKER_DATABASE_URL;
if (!url) throw Error("S6 closing broker requires its separately owned database credential");
const pool = new pg.Pool({ connectionString: url, max: 4, statement_timeout: 15000 });
const canonical = (v: unknown): string => v === null || typeof v !== "object" ? JSON.stringify(v)
  : Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;

async function nativeRead(request: unknown, mutation: boolean, existingClient?: pg.PoolClient) {
  const refs = ClosingBrokerRequestSchema.parse(request), c = existingClient ?? await pool.connect();
  try {
    if (!existingClient) await c.query("BEGIN");
    if (process.env.NODE_ENV !== "production") await c.query("SET LOCAL ROLE finnor_closing_broker");
    if ((await c.query("SELECT current_user AS role")).rows[0]?.role !== "finnor_closing_broker") throw Error("S6_CLOSING_BROKER_DATABASE_IDENTITY");
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [refs.tenantId]);
    const q = (await c.query("SELECT * FROM finnor_os.pe_closing_programmes WHERE tenant_id=$1 AND id=$2", [refs.tenantId, refs.programmeId])).rows[0];
    if (!q) throw Error("S6_CLOSING_PROGRAMME_UNAVAILABLE");
    const spec = ClosingSpecSchema.parse(q.spec), step = spec.steps.find(s => s.key === refs.nodeKey);
    if (!step) throw Error("S6_CLOSING_NODE_IDENTITY");
    const p = (await c.query("SELECT * FROM finnor_os.pe_closing_profiles WHERE tenant_id=$1 AND id=$2", [refs.tenantId, q.profile_id])).rows[0];
    const profile = ClosingProfileSchema.parse(p?.body), provider = profile.providers.find(p => p.id === step.providerProfileId);
    const { admission: _admission, ...profileBody } = profile;
    if (!provider || !provider.allowedKinds.includes(step.kind as any) || p.digest !== q.profile_digest
        || createHash("sha256").update(canonical(profileBody)).digest("hex") !== q.profile_digest
        || profile.environment !== spec.environment
        || mutation && (p.status !== "ACTIVE" || new Date(p.valid_until).getTime() <= Date.now())) throw Error("S6_CLOSING_CURRENT_QUALIFIED_PROVIDER_REQUIRED");
    const integration = (await c.query("SELECT * FROM finnor_os.tenant_integrations WHERE tenant_id=$1 AND id=$2", [refs.tenantId, provider.integrationId])).rows[0];
    if (!integration || integration.binding !== "finnor_closing_provider" || integration.health !== "ok"
        || integration.source_policy?.closingDisabled === true
        || spec.environment === "DEVELOPMENT" && integration.mode !== "emulator"
        || spec.environment === "LIVE" && integration.mode !== "real") throw Error("S6_CLOSING_CURRENT_ACCOUNT_INTERFACE_REQUIRED");
    if (spec.environment === "DEVELOPMENT") {
      if (process.env.NODE_ENV === "production") throw Error("S6_CLOSING_DEVELOPMENT_NOT_LIVE");
    } else if (mutation) {
      const result = validateClosingAdmission(profile.admission, {
        profileDigest: q.profile_digest, checkerDigest: profile.checkerDigest, environment: spec.environment,
        apiRuntimeDigest: process.env.FINNOR_V3_API_RUNTIME_DIGEST ?? "",
        workerRuntimeDigest: process.env.FINNOR_V3_WORKER_RUNTIME_DIGEST ?? "",
        providerContractDigest: closingProviderContractDigest(),
      }, JSON.parse(process.env.FINNOR_S8_V3_ISSUER_PUBLIC_KEYS ?? "{}"));
      if (!result.admitted) throw Error("S6_CLOSING_S8_PROFILE_INTERFACE_AND_RUNTIME_ADMISSION_REQUIRED");
    }
    const link = (await c.query(
      "SELECT l.*,a.status AS action_status,a.initiated_by,e.semantic_hash,e.effect FROM finnor_os.pe_closing_node_links l JOIN finnor_os.domain_actions a ON a.tenant_id=l.tenant_id AND a.id=l.domain_action_id JOIN finnor_os.business_effects e ON e.tenant_id=l.tenant_id AND e.id=l.business_effect_id WHERE l.tenant_id=$1 AND l.programme_id=$2 AND l.node_key=$3",
      [refs.tenantId, q.id, step.key],
    )).rows[0];
    if (!link || link.domain_action_id !== refs.domainActionId || link.business_effect_id !== refs.businessEffectId
        || link.semantic_hash !== refs.businessEffectHash || link.initiated_by !== step.actor.principalId) throw Error("S6_CLOSING_EXACT_NATIVE_EFFECT_AND_ACTOR_REQUIRED");
    const delta = link.effect.delta.values;
    if (delta.programmeId !== q.id || delta.specDigest !== q.spec_digest
        || canonical(delta.closingStep) !== canonical(step)
        || canonical(delta.closingRequirement) !== canonical(originalClosingRequirement(spec, step))) throw Error("S6_CLOSING_COMPILED_EFFECT_DIFFERS_FROM_ORIGINAL_SPEC");
    if (mutation) {
      if (q.stopped_at || ["CLOSED","REOPENED","FAILED","STOPPED"].includes(q.status)
          || new Date(q.original_deadline_at).getTime() <= Date.now() || link.action_status !== "executing") throw Error("S6_CLOSING_EXECUTION_STOPPED_OR_EXPIRED");
      const check = (await c.query("SELECT * FROM finnor_os.pe_closing_checks WHERE tenant_id=$1 AND id=$2", [refs.tenantId, q.last_check_id])).rows[0];
      const basis = (await c.query("SELECT finnor_os.pe_closing_execution_basis_digest($1,$2,$3) AS digest", [refs.tenantId, q.id, refs.businessEffectId])).rows[0]?.digest;
      if (!check || check.programme_id !== q.id || check.spec_digest !== q.spec_digest
          || check.observation_basis_digest !== basis || new Date(check.valid_until).getTime() <= Date.now()
          || !check.body.readyOperationKeys?.includes(step.key) || check.checker_digest !== profile.checkerDigest) throw Error("S6_CLOSING_INDEPENDENT_CURRENT_READINESS_REQUIRED");
      const lease = (await c.query(
        "SELECT s.id FROM finnor_os.workflow_steps s JOIN finnor_os.workflow_runs r ON r.tenant_id=s.tenant_id AND r.id=s.workflow_run_id JOIN finnor_os.commands co ON co.tenant_id=r.tenant_id AND co.id=r.command_id JOIN finnor_os.provider_operation_attempts a ON a.tenant_id=s.tenant_id AND a.workflow_step_claim_id IN(SELECT id FROM finnor_os.workflow_step_claims cl WHERE cl.tenant_id=s.tenant_id AND cl.workflow_step_id=s.id AND cl.claim_token=s.claim_token) WHERE s.tenant_id=$1 AND s.domain_action_id=$2 AND s.business_effect_id=$3 AND s.status='leased' AND s.execution_state='commit_started' AND s.lease_expires_at>clock_timestamp() AND s.cancellation_requested_at IS NULL AND r.status='running' AND co.status='running' AND a.id=$4",
        [refs.tenantId, refs.domainActionId, refs.businessEffectId, refs.providerOperationAttemptId],
      )).rows[0];
      if (!lease || !link.consumption_ref) throw Error("S6_CLOSING_CURRENT_WORKFLOW_AND_S5_CONSUMPTION_REQUIRED");
      const allocation = (await c.query(
        "SELECT pr.problem,pr.certificate,r.status,r.revocation_reason,co.body,st.effect_ref FROM finnor_os.s5_proposals pr JOIN finnor_os.s5_reservations r ON r.tenant_id=pr.tenant_id AND r.allocation_digest=pr.content_digest JOIN finnor_os.s5_consumptions co ON co.tenant_id=r.tenant_id AND co.reservation_id=r.reservation_id JOIN finnor_os.s5_consumption_states st ON st.tenant_id=co.tenant_id AND st.consumption_id=co.consumption_id WHERE pr.tenant_id=$1 AND pr.content_digest=$2 AND co.consumption_id=$3 AND co.principal_id=$4",
        [refs.tenantId, step.allocationRef?.contentDigest, link.consumption_ref.id, step.actor.principalId],
      )).rows[0];
      const resources = (await c.query("SELECT r.body FROM finnor_os.s5_resources r JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision) WHERE r.tenant_id=$1 ORDER BY r.resource_id", [refs.tenantId])).rows.map(r => r.body);
      const loop = (await c.query("SELECT state,deadline_at FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2", [refs.tenantId, q.work_id])).rows[0];
      if (!allocation || allocation.status === "RELEASED" || allocation.revocation_reason
          || canonical(allocation.certificate.ref) !== canonical(step.allocationRef && {
            owner: step.allocationRef.owner, id: step.allocationRef.id, version: step.allocationRef.version, contentDigest: step.allocationRef.contentDigest,
          })
          || canonical(allocation.problem.resources) !== canonical(resources)
          || Date.parse(allocation.certificate.validUntil) <= Date.now()
          || allocation.body.policyRef?.contentDigest !== step.policyRef?.contentDigest
          || allocation.effect_ref?.id !== refs.businessEffectId || allocation.effect_ref.contentDigest !== refs.businessEffectHash
          || !loop || ["blocked", "failed", "cancelled"].includes(loop.state)
          || new Date(loop.deadline_at).getTime() <= Date.now()) {
        throw Error("S6_CLOSING_ORIGINAL_CURRENT_S5_AND_WORK_GRANT_REQUIRED");
      }
    }
    if (!existingClient) await c.query("COMMIT");
    return { refs, q, spec, step, profile, provider };
  } catch (e) { if (!existingClient) await c.query("ROLLBACK"); throw e; }
  finally { if (!existingClient) c.release(); }
}

async function credential(provider: Awaited<ReturnType<typeof nativeRead>>["provider"], environment: string) {
  const path = process.env.FINNOR_V3_PROVIDER_BINDINGS_FILE;
  if (!path) throw Error("S6_CLOSING_CREDENTIAL_CUSTODY_UNAVAILABLE");
  const config = JSON.parse((await brokerPrivateFile(path)).toString("utf8"));
  const binding = config[provider.credentialRef];
  if (!binding || binding.origin !== provider.origin || binding.accountId !== provider.accountId
      || binding.integrationId !== provider.integrationId || binding.environment !== environment) throw Error("S6_CLOSING_CREDENTIAL_ORIGIN_ACCOUNT_BINDING");
  return {
    token: brokerToken(await brokerPrivateFile(binding.tokenPath, binding.tokenSha256)),
    ...(binding.caPath ? { ca: await brokerPrivateFile(binding.caPath, binding.caSha256) } : {}),
  };
}
export async function brokerClosingOperation(request: unknown, mutation: boolean) {
  let context = await nativeRead(request, mutation);
  const { refs, provider, spec, step } = context;
  const base = brokerOrigin(provider.origin, spec.environment === "DEVELOPMENT" ? "DISPOSABLE_TEST_AUTHORITY" : "PROTECTED");
  const target = new URL(`/v1/accounts/${encodeURIComponent(provider.accountId)}/closing-operations/${encodeURIComponent(refs.businessEffectId)}`, base);
  const auth = await credential(provider, spec.environment), deadlineAt = Math.min(Date.now() + 10000, new Date(context.q.original_deadline_at).getTime());
  if (!mutation) {
    const read = await brokerRequest(target, { method: "GET", ...auth, deadlineAt: Date.now() + 10000 });
    // A missing object is deliberately UNKNOWN, never whole-operation absence.
    return { observed: read.status === 200, observation: read.status === 200 ? read.body : null, originalBusinessEffectId: refs.businessEffectId, retryPermitted: false };
  }
  const c = await pool.connect();
  let invocationId: string | undefined;
  try {
    await c.query("BEGIN");
    if (process.env.NODE_ENV !== "production") await c.query("SET LOCAL ROLE finnor_closing_broker");
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [refs.tenantId]);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`s6-closing-egress:${refs.tenantId}:${refs.businessEffectId}`]);
    const prior = (await c.query(
      "SELECT i.id FROM finnor_os.provider_invocations i JOIN finnor_os.provider_operation_attempts a ON a.tenant_id=i.tenant_id AND a.id=i.provider_operation_attempt_id JOIN finnor_os.external_operations o ON o.tenant_id=a.tenant_id AND o.id=a.external_operation_id WHERE o.tenant_id=$1 AND o.business_effect_id=$2 AND i.closing_provider_egress_at IS NOT NULL LIMIT 1",
      [refs.tenantId, refs.businessEffectId],
    )).rows[0];
    const rows = prior ? { rows: [] } : await c.query(
      "UPDATE finnor_os.provider_invocations SET closing_provider_egress_at=clock_timestamp() WHERE tenant_id=$1 AND provider_operation_attempt_id=$2 AND closing_provider_egress_at IS NULL AND request_may_have_left_at IS NOT NULL AND id=(SELECT id FROM finnor_os.provider_invocations WHERE tenant_id=$1 AND provider_operation_attempt_id=$2 ORDER BY ordinal DESC LIMIT 1) RETURNING id",
      [refs.tenantId, refs.providerOperationAttemptId],
    );
    invocationId = rows.rows[0]?.id;
    await c.query("COMMIT"); // Durable before any possible external bank egress.
  } catch (e) { await c.query("ROLLBACK"); throw e; }
  finally { c.release(); }
  if (!invocationId) return { acknowledged: false, originalBusinessEffectId: refs.businessEffectId, outcome: "UNKNOWN_OR_PRIOR_ATTEMPT_RETAINED", retryPermitted: false };
  // Material writers participate in this same fence. Keep it through physical
  // egress, after the marker has independently committed. Revocation either
  // wins first or waits for this authorized effect; it cannot slip into the gap.
  const guard = await pool.connect();
  let reply: Awaited<ReturnType<typeof brokerRequest>>;
  try {
    await guard.query("BEGIN");
    await guard.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`v3-material-cut:${refs.tenantId}`]);
    context = await nativeRead(request, true, guard);
    reply = await brokerRequest(target, {
      method: "POST", ...auth, body: closingOperationRequest(context.spec, context.step, refs.businessEffectId), deadlineAt,
    });
    await guard.query("COMMIT");
  } catch (error) { await guard.query("ROLLBACK"); throw error; }
  finally { guard.release(); }
  const record = await pool.connect();
  let discard = false;
  try {
    await record.query("BEGIN");
    if (process.env.NODE_ENV !== "production") await record.query("SET LOCAL ROLE finnor_closing_broker");
    await record.query("SELECT set_config('app.tenant_id',$1,true)", [refs.tenantId]);
    await record.query("UPDATE finnor_os.provider_invocations SET closing_provider_response_digest=$3 WHERE tenant_id=$1 AND id=$2", [refs.tenantId, invocationId, reply.responseDigest]);
    await record.query("COMMIT");
  } catch (error) {
    try { await record.query("ROLLBACK"); } catch { discard = true; }
    throw error;
  } finally { record.release(discard); }
  return { acknowledged: reply.status >= 200 && reply.status < 300, originalBusinessEffectId: refs.businessEffectId,
    externalId: refs.businessEffectId, responseDigest: reply.responseDigest, settlementEstablished: false, retryPermitted: false };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.env.NODE_ENV === "production" && (process.env.NODE_OPTIONS || process.execArgv.some(a => /tsx|loader|import/.test(a)))) throw Error("Protected broker requires compiled installed bytes without host loaders");
  const path = process.env.FINNOR_V3_BROKER_SERVER_TOKEN_FILE;
  if (!path) throw Error("S6 closing broker authentication is required");
  const token = brokerToken(await brokerPrivateFile(path));
  const server = createServer(async (req, res) => {
    const supplied = req.headers.authorization ?? "", expected = `Bearer ${token}`;
    if (Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      res.writeHead(401); res.end(); return;
    }
    if (req.method !== "POST" || !["/dispatch", "/read", "/workforce-compensation/prepare"].includes(req.url ?? "")) { res.writeHead(404); res.end(); return; }
    try {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > 8192) throw Error("Request bound"); chunks.push(chunk); }
      if (req.url === "/workforce-compensation/prepare") {
        // W2 compensation payment preparation is answered before any
        // credential resolution or provider transport. While no qualified W2
        // outbound financial settlement provider is installed, the only
        // honest answer is the exact durable content-addressed refusal.
        const parsed = workforceCompensationPrepareSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (!parsed.success) {
          res.writeHead(422, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "S6_W2_PAYMENT_PREPARE_REQUEST_INVALID" })); return;
        }
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(workforceCompensationBoundaryRefusal(parsed.data))); return;
      }
      const result = await brokerClosingOperation(JSON.parse(Buffer.concat(chunks).toString("utf8")), req.url === "/dispatch");
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(result));
    } catch (error) {
      const fault = error && typeof error === "object" ? error as { code?: unknown; name?: unknown; stack?: unknown } : {};
      console.error(JSON.stringify({ role: "closing-broker", operation: req.url,
        code: error instanceof Error && /^S6_[A-Z0-9_]+$/.test(error.message) ? error.message
          : typeof fault.code === "string" && /^[A-Z0-9_]{1,128}$/.test(fault.code) ? fault.code : "S6_CLOSING_OUTCOME_RETAINED",
        errorType: typeof fault.name === "string" ? fault.name : "UNKNOWN",
        frames: typeof fault.stack === "string" ? fault.stack.split("\n").filter(line => line.trim().startsWith("at ")).slice(0, 6) : [] }));
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error && /^S6_[A-Z0-9_]+$/.test(error.message) ? error.message : "S6_CLOSING_OUTCOME_RETAINED" }));
    }
  });
  server.listen(Number(process.env.FINNOR_V3_BROKER_PORT ?? 49284), "127.0.0.1", () => console.log(JSON.stringify({ role: "closing-broker", ready: true, providerContractDigest: closingProviderContractDigest() })));
  const stop = () => server.close(async () => { await pool.end(); process.exit(0); });
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}
