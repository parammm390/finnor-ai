import { z } from "zod";
import { SignedBilateralCheckSchema, type SignedBilateralCheck } from "@finnor/shared-types";
import { verifySigned } from "../../../governed-execution/src/canonical";
import { brokerPrivateFile, brokerResponseBytes } from "../../../governed-execution/src/broker-io";
import type { PeMutationContext } from "../types";
import { cpuCost, reserve, settle } from "./costs";
import type { OwnerBindings } from "./governance";
import { actor, candidateDependencies, event, hash, newId, reference, tx, type Programme, type Candidate } from "./store";

const Configuration = z.object({
  schema: z.literal("finnor.bilateral-checker-client.v1"), endpoint: z.string().url(),
  publicKeyDigest: z.string().regex(/^[a-f0-9]{64}$/), tokenPath: z.string(), tokenDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export async function independentCheck(ctx: PeMutationContext, p: Programme, candidate: Candidate, b: OwnerBindings): Promise<SignedBilateralCheck> {
  if (!candidate.current_terms_id || !p.frozen_manifest) throw Error("BILATERAL_CURRENT_TERMS_AND_SOURCE_REQUIRED");
  const path = process.env.FINNOR_V1_CHECKER_CLIENT_CONFIG;
  if (!path) throw Error("S8_SEPARATE_BILATERAL_CHECKER_UNAVAILABLE");
  const config = Configuration.parse(JSON.parse((await brokerPrivateFile(path)).toString("utf8"))), url = new URL(config.endpoint);
  if (config.endpoint !== b.domain.checker.endpoint || config.publicKeyDigest !== hash(b.domain.checker.publicKeyPem) ||
    url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash)
    throw Error("S8_EXACT_INDEPENDENT_CHECKER_DOMAIN_REQUIRED");
  const token = (await brokerPrivateFile(config.tokenPath,undefined,8192)).toString("utf8").trim();
  if (!/^[\x21-\x7e]{16,4096}$/.test(token) || hash(token) !== config.tokenDigest)
    throw Error("S8_INDEPENDENT_CHECKER_CREDENTIAL_CHANGED");
  const key = "v1-check:" + newId(), cpuCeiling = "5000000", held = cpuCost(b.grant, BigInt(cpuCeiling));
  await reserve(ctx, p, b.grant, key, "NATIVE", held, cpuCeiling);
  await event(ctx, p, "S8", "INDEPENDENT_ORIGINAL_CHECK_REQUESTED", {
    candidateId: candidate.id, termsId: candidate.current_terms_id, checkerIdentity: b.domain.checker.identity,
    specificationDigest: b.domain.checker.specificationDigest, originalGrantRef: p.intake.budgetGrantRef,
    independentCredentialDomain: b.domain.checker.credentialDomain, chargeKey: key,
  });
  const remaining = Math.min(15000,...[b.mandate.deadline,b.grant.originalProgrammeDeadline,b.grant.expiresAt,b.source.retentionUntil].map(time=>Date.parse(time)-Date.now()));
  if (!Number.isFinite(remaining) || remaining <= 0) throw Error("BILATERAL_ORIGINAL_CHECK_DEADLINE_EXHAUSTED");
  const response = await fetch(url, { method: "POST", redirect: "error",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ tenantId: p.tenant_id, principalId: p.principal_id, programmeId: p.id,
      candidateId: candidate.id, termsId: candidate.current_terms_id }), signal: AbortSignal.timeout(Math.ceil(remaining)) });
  const bytes = await brokerResponseBytes(response,262144);
  const value = JSON.parse(bytes.toString("utf8"));
  if (!response.ok) throw Error(value.predicate?.match(/^[A-Z][A-Z0-9_:]{0,159}$/)?.[0] ?? "S8_ORIGINAL_RECORD_CHECK_UNAVAILABLE");
  const signed = SignedBilateralCheckSchema.parse(value), check = signed.body;
  if (!verifySigned(check, signed.signature, b.domain.checker.publicKeyPem) ||
    hash(check.checkerIdentity) !== hash(b.domain.checker.identity) ||
    check.specificationDigest !== b.domain.checker.specificationDigest || check.tenantId !== p.tenant_id ||
    check.principalId !== p.principal_id || check.programmeId !== p.id || check.candidateId !== candidate.id ||
    check.workId !== p.work_id || check.workInputId !== p.work_input_id ||
    check.termsRef.id !== candidate.current_terms_id || check.sourceDigest !== p.frozen_digest ||
    check.dependencyDigest !== hash(candidateDependencies(p, candidate.company_id)) ||
    check.rightsRevision !== b.rights.rightsRevision ||
    [["mandateRef", p.intake.mandateRef], ["authorityProfileRef", p.intake.authorityProfileRef],
      ["domainProfileRef", p.intake.domainProfileRef], ["relationshipPolicyRef", p.intake.relationshipPolicyRef]]
      .some(([name, ref]) => hash(check[name as "mandateRef"]) !== hash(ref)) ||
    Date.parse(check.checkedAt) > Date.now() || Date.now() >= Date.parse(check.expiresAt) ||
    check.result === "ACCEPT" && (!Object.values(check.conjuncts).every(Boolean) || check.reasons.length))
    throw Error("S8_BILATERAL_RECEIPT_SIGNATURE_IDENTITY_SCOPE_OR_CURRENTNESS_INVALID");
  await settle(ctx, p, b.grant, { key, kind: "NATIVE",
    microUsd: cpuCost(b.grant, BigInt(check.usage.cpuMicros)), reservedMicroUsd: held, cpuMicros: check.usage.cpuMicros,
    wallMs: check.usage.wallMs, peakMemoryBytes: check.usage.peakMemoryBytes, bytes: bytes.byteLength,
    reasons: ["INDEPENDENT_CHECKER_PROCESS_CPU_DELTA", "CHECKER_STARTUP_IDLE_AND_PROVISIONED_CAPACITY_NOT_EXCLUSIVELY_ATTRIBUTED"] });
  if (BigInt(check.usage.cpuMicros) > BigInt(cpuCeiling) || BigInt(check.usage.peakMemoryBytes) > BigInt(b.grant.maximumMemoryBytes))
    throw Error("BILATERAL_ORIGINAL_NATIVE_RESOURCE_GRANT_EXCEEDED");
  await tx(ctx, async c => {
    const old = (await c.query("SELECT digest FROM finnor_os.v1_claim_checks WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [p.tenant_id, actor(ctx), check.id])).rows[0];
    if (!old || old.digest !== hash(signed)) throw Error("S8_INDEPENDENT_RECEIPT_CUSTODY_OR_REPLAY_CONFLICT");
    await event(ctx, p, "S8", "INDEPENDENT_ORIGINAL_CHECK_OBSERVED", {
      checkRef: reference("S8", check.id, 1, signed), result: check.result, reasons: check.reasons,
      conjuncts: check.conjuncts, protectedAdmission: false,
    }, c);
  });
  return signed;
}
