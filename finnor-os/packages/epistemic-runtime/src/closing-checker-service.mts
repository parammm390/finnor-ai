import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import pg from "pg";
import { z } from "zod";
import { ClosingObservationSchema, ClosingSpecSchema, type ClosingEvidenceRef, type ClosingObservation } from "@finnor/shared-types";
import { ClosingProfileSchema } from "../../private-equity/src/closing/contracts";
import { checkClosingTransaction, type ClosingCheckInput } from "./closing-checker";
import { validateClosingAdmission } from "../../capability-evolution/src/closing-admission";

const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const RequestSchema = z.object({ tenantId: z.string().uuid(), programmeId: z.string().uuid() }).strict();
export async function closingCheckerIdentity(): Promise<string> {
  if (!import.meta.url.endsWith(".mts") && !import.meta.url.endsWith(".ts")) {
    // The installed checker is a self-contained bundle. Hash the actual loaded
    // executable, not source files that happen to exist on the build host.
    return hash(await readFile(fileURLToPath(import.meta.url)));
  }
  const base = dirname(fileURLToPath(import.meta.url));
  const extension = import.meta.url.endsWith(".mts") ? ".ts" : ".js";
  const files = [
    fileURLToPath(import.meta.url), resolve(base, "closing-checker" + extension),
    resolve(base, "../../shared-types/src/closing" + extension),
    resolve(base, "../../private-equity/src/closing/contracts" + extension),
    resolve(base, "../../capability-evolution/src/closing-admission" + extension),
  ];
  return hash(JSON.stringify(await Promise.all(files.map(async f => ({ name: f.split("/").slice(-3).join("/"), sha256: hash(await readFile(f)) })))));
}

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(",")}}`;
}
function failureDiagnostic(error: unknown) {
  const value = error instanceof Error ? error : undefined;
  const fields = value as (Error & Record<string, unknown>) | undefined;
  const identifier = (v: unknown) => typeof v === "string" && /^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(v) ? v : undefined;
  const predicates = [
    "Independent checker database identity is not isolated", "Closing programme unavailable",
    "Canonical closing source has an invalid immutable observation",
    "Canonical signed observation bytes changed", "Canonical original-operation observation bytes changed",
    "Request bound",
  ];
  return {
    event: "INDEPENDENT_CLOSING_CHECK_FAILED",
    errorType: value && ["Error", "TypeError", "RangeError", "SyntaxError", "ZodError", "DatabaseError"].includes(value.name)
      ? value.name : "UnknownError",
    predicate: value && predicates.includes(value.message) ? value.message : undefined,
    sqlCode: typeof fields?.code === "string" && /^[0-9A-Z]{5}$/.test(fields.code) ? fields.code : undefined,
    table: identifier(fields?.table), column: identifier(fields?.column), constraint: identifier(fields?.constraint),
    issues: error instanceof z.ZodError ? error.issues.slice(0, 8).map(issue => ({
      code: issue.code, path: issue.path.slice(0, 8).map(part => typeof part === "number" ? part : identifier(part) ?? "[field]"),
    })) : undefined,
    // Never include the arbitrary message, request, SQL parameters or values.
    frames: value?.stack?.split("\n").filter(line => /^\s+at /.test(line)).slice(0, 8).map(line => line.slice(0, 300)),
  };
}
const identity = closingCheckerIdentity();
const databaseUrl = process.env.FINNOR_V3_CHECKER_DATABASE_URL;
if (!databaseUrl) throw Error("The independent checker requires its separately owned database credential");
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, statement_timeout: 15000 });

/** The only accepted request is an identity. Facts and the original specification
 * are selected under the independent role, never supplied by the controller. */
export async function checkAndPersistClosing(request: unknown) {
  const { tenantId, programmeId } = RequestSchema.parse(request), client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    if (process.env.NODE_ENV !== "production") await client.query("SET LOCAL ROLE finnor_closing_checker");
    const who = (await client.query("SELECT current_user AS role")).rows[0]?.role;
    if (who !== "finnor_closing_checker") throw Error("Independent checker database identity is not isolated");
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    const result = (await client.query("WITH material AS MATERIALIZED(SELECT finnor_os.pe_closing_cut($1,$2) body) SELECT body AS cut,encode(sha256(convert_to(body::text,'UTF8')),'hex') AS digest,finnor_os.pe_closing_execution_basis_from_cut(body,NULL) AS basis FROM material", [tenantId, programmeId])).rows[0];
    if (!result?.cut) throw Error("Closing programme unavailable");
    const cut = result.cut, q = cut.programme, spec = ClosingSpecSchema.parse(q.spec);
    const profile = ClosingProfileSchema.parse(cut.profile?.body), checkerDigest = await identity;
    const { admission: _admission, ...profilePreimage } = profile;
    const profileBound = hash(stable(profilePreimage)) === q.profile_digest
      && cut.profile.digest === q.profile_digest && profile.environment === spec.environment;
    let admitted = spec.environment === "DEVELOPMENT" && process.env.NODE_ENV !== "production";
    if (spec.environment !== "DEVELOPMENT") {
      const keys = JSON.parse(process.env.FINNOR_S8_V3_ISSUER_PUBLIC_KEYS ?? "{}");
      admitted = validateClosingAdmission(profile.admission, {
        profileDigest: q.profile_digest, checkerDigest, environment: spec.environment,
        apiRuntimeDigest: process.env.FINNOR_V3_API_RUNTIME_DIGEST ?? "",
        workerRuntimeDigest: process.env.FINNOR_V3_WORKER_RUNTIME_DIGEST ?? "",
        providerContractDigest: process.env.FINNOR_V3_PROVIDER_CONTRACT_DIGEST ?? "",
      }, keys).admitted;
    }
    const now = new Date().toISOString(), nowMs = Date.parse(now);
    const actors = cut.actors.filter((a: { status: string }) => a.status === "active").map((a: { id: string }) => a.id);
    const validRoleBindings = profile.roleBindings.filter(b => cut.roles.some((a: Record<string, any>) => {
      const definition = cut.roleDefinitions.find((d: Record<string, unknown>) => d.id === a.role_id);
      const scope = a.resource_scope;
      const inScope = scope?.kind === "tenant" || scope?.kind === "resources"
        && (!scope.resourceType || ["*", "pe_deal"].includes(scope.resourceType))
        && scope.resourceIds?.includes(spec.transactionId);
      return a.id === b.assignmentId && a.employee_id === b.principalId && a.active && definition?.active
        && inScope && hash(stable(a)) === b.assignmentDigest && hash(stable(definition)) === b.roleDefinitionDigest
        && Date.parse(String(a.effective_from)) <= nowMs && (!a.expires_at || Date.parse(String(a.expires_at)) > nowMs);
    })).map(b => ({ ref: b.ref, principalId: b.principalId, legalEntityIds: b.legalEntityIds }));
    const observations: ClosingCheckInput["observations"] = [];
    for (const v of cut.evidence) {
      const parsed = ClosingObservationSchema.safeParse(v.snapshot?.closingObservation);
      if (!parsed.success) throw Error("Canonical closing source has an invalid immutable observation");
      const ref: ClosingEvidenceRef = {
        sourceId: v.source_id, versionId: v.id, versionNumber: v.version_number,
        contentHash: v.content_hash, snapshotHash: hash(stable(v.snapshot)),
      };
      if (hash(v.content) !== v.content_hash || v.content !== stable(parsed.data)) throw Error("Canonical signed observation bytes changed");
      observations.push({ ref, observation: parsed.data });
    }
    const input: ClosingCheckInput = {
      spec, graph: q.graph, observations, issuers: profile.issuers, currentActorIds: actors, validRoleBindings,
      operations: cut.operations.map((r: Record<string, any>) => {
        const o = r.operation, link = r.link;
        const possible = r.invocations.some((i: Record<string, unknown>) =>
          o.provider === "finnor_closing_provider" ? i.closing_provider_egress_at : i.request_may_have_left_at);
        // verified_absent is not trusted here. Whole-operation absence requires
        // independently accepted adapter-specific signed evidence.
        const status = o.verification_status === "verified" ? "SETTLED" : o.verification_status === "divergent" ? "DIVERGENT"
          : possible ? o.status === "success" ? "ACKNOWLEDGED" : "UNKNOWN" : "UNATTEMPTED";
        let settlement: ClosingCheckInput["operations"][number]["settlement"];
        const original = ClosingSpecSchema.safeParse(r.originalSpec);
        const originalProfile = ClosingProfileSchema.safeParse(r.originalProfile?.body);
        if (original.success && originalProfile.success && r.originalProfile.status !== "REVOKED") {
          const { admission: _oldAdmission, ...oldProfileBody } = originalProfile.data;
          const originalStep = original.data.steps.find(s => s.key === link.node_key);
          const originalProvider = originalProfile.data.providers.find(p => p.id === originalStep?.providerProfileId);
          if (hash(stable(oldProfileBody)) === r.originalProfileDigest
              && originalProfile.data.environment === original.data.environment
              && original.data.tenantId === spec.tenantId && original.data.transactionId === spec.transactionId
              && originalProvider && originalProvider.integrationId === o.integration_id) {
            const candidates: NonNullable<NonNullable<ClosingCheckInput["operations"][number]["settlement"]>["relatedEvidence"]> = [];
            for (const source of r.settlementCandidates ?? []) {
              const fact = ClosingObservationSchema.safeParse(source.snapshot?.closingObservation);
              if (!fact.success || source.content !== stable(fact.data) || hash(source.content) !== source.content_hash) {
                throw Error("Canonical original-operation observation bytes changed");
              }
              const issuer = originalProfile.data.issuers.find(i => i.id === fact.data.issuerId);
              if (issuer && originalProvider.observationIssuerIds.includes(issuer.id)) candidates.push({
                observation: fact.data, issuer, ref: { sourceId: source.source_id, versionId: source.id,
                  versionNumber: source.version_number, contentHash: source.content_hash, snapshotHash: hash(stable(source.snapshot)) },
              });
            }
            const superseded = new Set(candidates.flatMap(c => c.observation.supersedesFactIds));
            const selected = [...candidates].reverse().find(c => c.observation.status === "CONFIRMED"
              && c.observation.claims.businessEffectId === o.business_effect_id && !superseded.has(c.observation.factId));
            if (selected) settlement = { originalSpec: original.data, stepKey: link.node_key, issuer: selected.issuer,
              evidence: { observation: selected.observation, ref: selected.ref }, relatedEvidence: candidates };
          }
        }
        return { operationKey: link?.node_key ?? o.operation_key, businessEffectId: o.business_effect_id,
          status, material: true, originalReservationRef: link?.consumption_ref?.reservationRef ?? null, settlement };
      }),
      dutyHandoffs: cut.duties.map((r: Record<string, any>) => ({
        ...r.handoff.body, canonicalTaskId: r.task.id,
        status: hash(stable(r.handoff.body)) === r.handoff.digest
          && r.action.action_type === "create_task" && r.action.id === r.task.source_domain_action_id
          && r.action.status === "completed" && r.authority.domain_action_id === r.action.id
          && r.authority.outcome === "allowed" && r.authority.capability === "action:create_task"
          && r.authority.employee_id === r.action.initiated_by
          && r.handoff.transaction_id === spec.transactionId
          && r.task.subject_type === "work" && r.task.subject_id === cut.work.id
          && r.task.work_id === cut.work.id && r.action.work_id === cut.work.id
          && r.task.status !== "cancelled" && r.task.assigned_party_type === "employee"
          && r.task.assigned_party_id === r.handoff.body.ownerPrincipalId
          && r.task.due_at && Date.parse(r.task.due_at) === Date.parse(r.handoff.body.dueAt)
          && r.task.title === `Closing duty ${r.handoff.duty_key}`
          && r.handoff.body.obligationRef?.owner === "S6" && r.handoff.body.obligationRef.id === r.task.id
          ? "OWNED" : "CANCELLED",
      })),
      canonicalWaivers: cut.waivers.map((r: Record<string, any>) => ({
        conditionId: r.condition.id, actorId: r.authority.employee_id, current: r.current,
        authorityRef: { owner: "@finnor/authority", kind: "authority-decision", id: r.authority.id,
          version: String(r.authority.authority_revision), contentDigest: hash(stable(r.authority)) },
      })),
      currentness: {
        expectedWorkInputId: q.work_input_id, currentWorkInputId: cut.latestWorkInput?.id ?? "",
        approvedTermsRevision: cut.latestTerms?.id ?? "", approvedTermsDigest: cut.latestTerms?.content_hash ?? "",
        documentsCurrent: spec.documents.every(d => cut.documents.some((r: Record<string, any>) =>
          r.document?.id === d.documentId && !r.document.archived_at
          && r.version?.id === d.documentVersionId && r.version.byte_sha256 === d.documentDigest
          && r.head?.version_id === d.documentVersionId && r.content?.sha256 === d.documentDigest
          && (r.content.storage_backend === "postgres" ? r.content.actual_sha256 === d.documentDigest
            : r.content.storage_backend === "external" && Boolean(r.content.storage_ref)))),
        dependenciesCurrent: q.dependency_pins.every((p: { key: string; revision: number }) =>
          Number(cut.dependencies.find((r: { key: string }) => r.key === p.key)?.revision ?? 0) === p.revision),
        authorityCurrent: Number(cut.authority?.revision ?? 1) === q.authority_revision && actors.includes(q.principal_id)
          && cut.actors.some((a: Record<string, unknown>) => a.id === q.principal_id && a.role === "owner")
          && !cut.work?.cancelled && cut.work?.currentOwnerId === q.principal_id
          && !cut.objective?.fenced
          && !cut.terminated && cut.plan?.current && cut.plan.work_input_id === q.work_input_id
          && hash(stable(cut.latestWorkInput)) === q.work_input_digest,
        legalSpecAccepted: observations.some(x => x.observation.kind === "LEGAL_SPEC_ACCEPTANCE"), profileEnvironment: profile.environment,
        profileCurrent: admitted && profileBound && cut.profile.status === "ACTIVE"
          && Date.parse(cut.profile.valid_until) > nowMs && profile.checkerDigest === checkerDigest,
        programmeStopped: Boolean(q.stopped_at),
      },
    };
    const check = checkClosingTransaction(input, now);
    if (check.accepted) check.validUntil = new Date(Math.min(Date.parse(check.validUntil), Date.parse(cut.profile.valid_until),
      ...cut.roles.filter((r: Record<string, unknown>) => r.active && r.expires_at).map((r: Record<string, unknown>) => Date.parse(String(r.expires_at))),
      ...cut.allocations.flatMap((r: Record<string, any>) => [r.certificate.validUntil,
        ...r.currentResources.map((v: Record<string, unknown>) => v.validUntil)]).map((value: string) => Date.parse(value)))).toISOString();
    const id = (await client.query(
      "INSERT INTO finnor_os.pe_closing_checks(tenant_id,programme_id,spec_digest,observation_cut_digest,observation_basis_digest,checker_digest,body,accepted,valid_until) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING id",
      [tenantId, programmeId, check.specDigest, result.digest, result.basis, checkerDigest, JSON.stringify(check), check.accepted, check.validUntil],
    )).rows[0].id;
    await client.query("COMMIT");
    return { id, observationCutDigest: result.digest, checkerDigest, check };
  } catch (error) {
    await client.query("ROLLBACK"); throw error;
  } finally { client.release(); }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  if (process.env.NODE_ENV === "production" && (process.env.NODE_OPTIONS || process.execArgv.some(a => /tsx|loader|import/.test(a)))) {
    throw Error("Protected checker requires compiled installed bytes without host loaders");
  }
  const token = process.env.FINNOR_V3_CHECKER_BEARER;
  if (!token || token.length < 32) throw Error("Independent checker service authentication is required");
  const server = createServer(async (req, res) => {
    const provided = req.headers.authorization ?? "", expected = `Bearer ${token}`;
    if (Buffer.byteLength(provided) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
      res.writeHead(401); res.end(); return;
    }
    if (req.method !== "POST" || req.url !== "/check") { res.writeHead(404); res.end(); return; }
    try {
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > 4096) throw Error("Request bound"); chunks.push(chunk); }
      const result = await checkAndPersistClosing(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(result));
    } catch (error) {
      console.error(JSON.stringify(failureDiagnostic(error)));
      res.writeHead(422); res.end(JSON.stringify({ error: "INDEPENDENT_CLOSING_CHECK_UNAVAILABLE" }));
    }
  });
  server.listen(Number(process.env.FINNOR_V3_CHECKER_PORT ?? 49283), "127.0.0.1", async () =>
    console.log(JSON.stringify({ role: "independent-closing-checker", checkerDigest: await identity, ready: true })));
  const stop = () => server.close(async () => { await pool.end(); process.exit(0); });
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}
