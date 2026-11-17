import { canonicalConsumerConfigurationSchema, canonicalAuthorityReplySchema, openConsumerCanonicalAuthority, assertCanonicalCurrentBinding, canonicalEpochReference } from "./specialist-publication-consumer";
/** Current signed S8 method only. No policy, key, test result or spend is minted. */
import { createPublicKey, randomUUID, verify } from "node:crypto";
import { z } from "zod";
import { canonical } from "../../governed-execution/src/protocol";
import { SPECIALIST_QUALIFICATION_DOMAIN, specialistLimitsSchema,
  type SpecialistLimits, type SpecialistMechanism, type SpecialistModelIdentity } from "../../governed-execution/src/specialist-contract";
import { privateFile } from "./journal";
import { assertSignature, byteDigest, digest, fault, RefSchema, sameRef, type CapabilityRef } from "./contracts";
import { installedWorkforceSpecialistIdentity } from "./specialist-source";
import { parseWorkforceSpecialistCandidate, specialistAdmissionSchema, specialistEvaluationSchema,
  specialistProtocolSchema, workforceSpecialistCapabilityRef, type WorkforceSpecialistCandidate } from "./specialist-port";

const text = z.string().min(1).max(4096), instant = z.string().datetime({ offset: true });
const key = z.object({ id: text, principalId: text, publicKey: text, validAfter: instant,
  validUntil: instant, revoked: z.boolean() }).strict();
const Policy = z.object({
  schema: z.literal("finnor.s8.workforce-specialist-consumer-policy.v1"),
  domain: z.literal("REVIEWED_PROTECTED_DOMAIN"),
  qualificationDomain: z.literal(SPECIALIST_QUALIFICATION_DOMAIN), productionActive: z.literal(false),
  tenantId: text, principalId: text, rightsRef: text, spendBudgetRef: RefSchema,
  endpoint: text, tokenPath: text, tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  canonical: canonicalConsumerConfigurationSchema,
  expectedCandidate: z.unknown(), evaluatorKeys: z.array(key).min(1).max(16),
  promotionKeys: z.array(key).min(1).max(16),
  validAfter: instant, validUntil: instant, timeoutMs: z.number().int().min(100).max(5000),
}).strict();
const signed = <T extends z.ZodTypeAny>(schema: T) => z.object({
  body: schema, keyId: text, signature: z.string().min(1).max(128),
}).strict();
const Reply = z.object({
  canonicalAuthority:canonicalAuthorityReplySchema,
  current: z.literal(true), revisionRef: RefSchema, candidate: z.unknown(), admissionRef: RefSchema,
  evaluation: signed(specialistEvaluationSchema), evaluationRef: RefSchema,
  protocol: signed(specialistProtocolSchema), protocolRef: RefSchema,
  admission: signed(specialistAdmissionSchema),
  qualificationDomain: z.literal(SPECIALIST_QUALIFICATION_DOMAIN),
  protectedQualification: z.literal(true), productionActive: z.literal(false), executionAuthorityGranted: z.literal(false),
  protectedHistory: z.object({ contract: z.literal("S8_CAPABILITY_EVENTS_V1"),
    publishedSequence: z.number().int().positive(), eventId: text, receipt: z.unknown(),
    executionAuthorityGranted: z.literal(false) }).strict(),
}).strict();
export interface WorkforceSpecialistCapability {
  schema: "finnor.s8.workforce-specialist-consumer-binding.v1";
  revisionRef: CapabilityRef; admissionRef: CapabilityRef; evaluationRef: CapabilityRef;
  policyDigest: string; candidateDigest: string; sourceClosureDigest: string; runtimeDigest: string;
  mechanism: SpecialistMechanism; modelIdentity: SpecialistModelIdentity; limits: SpecialistLimits;
  spendBudgetRef: CapabilityRef; qualificationDomain: typeof SPECIALIST_QUALIFICATION_DOMAIN;
  validUntil: string;
  canonicalAuthority:{enrollmentDigest:string;epoch:string;historyDigest:string};
  protectedQualification: true; productionActive: false; executionAuthorityGranted: false;
}
export interface WorkforceSpecialistScope {
  tenantId: string; principalId: string; rightsRef: string; spendBudgetRef: CapabilityRef;
  methodRef: CapabilityRef; admissionRef: CapabilityRef; modelIdentity: SpecialistModelIdentity;
  mechanism: SpecialistMechanism; deadlineAt: number; signal: AbortSignal;
}

async function currentInstalled(candidate: WorkforceSpecialistCandidate) {
  const identity = await installedWorkforceSpecialistIdentity();
  if (candidate.sourceClosureDigest !== identity.sourceClosureDigest
    || candidate.runtimeDigest !== identity.runtimeDigest || digest(candidate.dependencies) !== digest(identity.sources))
    fault("S8_SPECIALIST_INSTALLED_METHOD_CHANGED", 503);
}
export async function createInstalledWorkforceSpecialistProposal(input: {
  tenantId: string; principalId: string; rightsRef: string; mechanism: SpecialistMechanism;
  modelIdentity: SpecialistModelIdentity; limits: SpecialistLimits; validAfter: string; validUntil: string;
}) {
  const installed = await installedWorkforceSpecialistIdentity();
  const body = { schema: "finnor.s8.workforce-specialist-method.v1", ...input,
    owningInterface: "w2-specialist-analysis-v1", qualificationDomain: SPECIALIST_QUALIFICATION_DOMAIN,
    productionActive: false, executionAuthorityGranted: false, dependencies: installed.sources,
    sourceClosureDigest: installed.sourceClosureDigest, runtimeDigest: installed.runtimeDigest,
    proposedAt: new Date().toISOString() };
  return parseWorkforceSpecialistCandidate({ ...body, ref: workforceSpecialistCapabilityRef("candidate", body) });
}

/** Select only the one explicitly configured candidate model, then authenticate
 * it through the complete current-policy/lifecycle read. No environment model
 * fallback or unsigned candidate can confer invocation authority. */
export async function resolveInstalledWorkforceSpecialistCapability(scope: Omit<WorkforceSpecialistScope, "modelIdentity">) {
  scope.signal.throwIfAborted();
  const path = process.env.FINNOR_S8_WORKFORCE_SPECIALIST_CONSUMER_CONFIG;
  if (!path || !process.env.FINNOR_S8_WORKFORCE_SPECIALIST_CONSUMER_ROOT) fault("WORKFORCE_SPECIALIST_UNADMITTED", 503);
  const raw = signed(Policy).parse(JSON.parse((await privateFile(path)).toString()));
  const candidate = parseWorkforceSpecialistCandidate(raw.body.expectedCandidate);
  return currentWorkforceSpecialistCapability({ ...scope, modelIdentity: candidate.modelIdentity });
}

/** Every boundary re-reads policy, token, loaded closure and live lifecycle. */
export async function currentWorkforceSpecialistCapability(scope: WorkforceSpecialistScope,
  expected?: WorkforceSpecialistCapability): Promise<WorkforceSpecialistCapability> {
  scope.signal.throwIfAborted();
  if (!Number.isFinite(scope.deadlineAt) || scope.deadlineAt <= Date.now())
    fault("S8_SPECIALIST_ORIGINAL_DEADLINE_EXPIRED");
  const path = process.env.FINNOR_S8_WORKFORCE_SPECIALIST_CONSUMER_CONFIG;
  const root = process.env.FINNOR_S8_WORKFORCE_SPECIALIST_CONSUMER_ROOT;
  if (!path || !root) fault("WORKFORCE_SPECIALIST_UNADMITTED", 503);
  const raw = signed(Policy).parse(JSON.parse((await privateFile(path)).toString()));
  const policy = raw.body, rootKey = createPublicKey(root);
  if (rootKey.asymmetricKeyType !== "ed25519"
    || !verify(null, Buffer.from(canonical(policy)), rootKey, Buffer.from(raw.signature, "base64"))
    || Date.now() < Date.parse(policy.validAfter) || Date.now() >= Date.parse(policy.validUntil)
    || Date.parse(policy.validUntil) <= Date.parse(policy.validAfter))
    fault("S8_SPECIALIST_CONSUMER_POLICY_INVALID", 403);
  const fingerprint = (publicKey: string) => {
    const parsed = createPublicKey(publicKey);
    if (parsed.asymmetricKeyType !== "ed25519") fault("S8_SPECIALIST_AUTHORITY_KEY_INVALID", 403);
    return byteDigest(parsed.export({ type: "spki", format: "der" }));
  };
  if (policy.evaluatorKeys.some(evaluator => policy.promotionKeys.some(promoter =>
    evaluator.principalId === promoter.principalId || fingerprint(evaluator.publicKey) === fingerprint(promoter.publicKey))))
    fault("S8_SPECIALIST_AUTHORITIES_NOT_SEPARATED", 403);
  if ([policy.evaluatorKeys, policy.promotionKeys].some(keys => new Set(keys.map(value => value.id)).size !== keys.length)
    || [...policy.evaluatorKeys, ...policy.promotionKeys].some(value => value.principalId === policy.principalId))
    fault("S8_SPECIALIST_AMBIGUOUS_OR_SELF_ADMISSION_AUTHORITY", 403);
  if (policy.tenantId !== scope.tenantId || policy.principalId !== scope.principalId || policy.rightsRef !== scope.rightsRef
    || !sameRef(policy.spendBudgetRef, scope.spendBudgetRef))
    fault("S8_SPECIALIST_CONSUMER_SCOPE_OR_SPEND_BUDGET_CHANGED", 403);
  const endpoint = new URL(policy.endpoint);
  if (endpoint.origin !== policy.endpoint || endpoint.username || endpoint.password
    || endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1")
    fault("S8_SPECIALIST_CONSUMER_ENDPOINT_INVALID", 403);
  const candidate = parseWorkforceSpecialistCandidate(policy.expectedCandidate);
  if (candidate.tenantId !== scope.tenantId || candidate.principalId !== scope.principalId
    || candidate.rightsRef !== scope.rightsRef || !sameRef(candidate.ref, scope.methodRef)
    || digest(candidate.modelIdentity) !== digest(scope.modelIdentity)
    || digest(candidate.mechanism) !== digest(scope.mechanism)
    || Date.parse(candidate.validAfter) < Date.parse(policy.validAfter)
    || Date.parse(candidate.validUntil) > Date.parse(policy.validUntil)
    || Date.now() < Date.parse(candidate.validAfter) || Date.now() >= Date.parse(candidate.validUntil))
    fault("S8_SPECIALIST_CANDIDATE_SCOPE_OR_PROFILE_CHANGED");
  await currentInstalled(candidate); scope.signal.throwIfAborted();
  const canonicalAuthority=await openConsumerCanonicalAuthority(policy,root);
  try{
  const before=await canonicalAuthority.readEpoch();
  const token = await privateFile(policy.tokenPath, 4096);
  if (byteDigest(token) !== policy.tokenHash) fault("S8_SPECIALIST_CONSUMER_TOKEN_CHANGED", 403);
  const signal = AbortSignal.any([scope.signal,
    AbortSignal.timeout(Math.max(1, Math.min(policy.timeoutMs, scope.deadlineAt - Date.now())))]);
  const response = await fetch(policy.endpoint + "/command", { method: "POST", redirect: "error", credentials: "omit",
    headers: { authorization: "Bearer " + token.toString(), "content-type": "application/json" },
    body: canonical({ requestId: "w2-specialist-current:" + randomUUID(),
      operation: "SPECIALIST_CURRENT", body: { revisionRef: candidate.ref } }), signal });
  if (!response.body) fault("S8_SPECIALIST_CURRENT_BODY_UNAVAILABLE", 503);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  let bytes = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      if (next.value.length > 1048576 - bytes) fault("S8_SPECIALIST_CURRENT_RESPONSE_BOUND", 503);
      chunks.push(next.value); bytes += next.value.length;
    }
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined); reader.releaseLock();
  }
  if (!response.ok) fault("S8_SPECIALIST_CURRENT_REFUSED", response.status);
  const reply = Reply.parse(JSON.parse(Buffer.concat(chunks, bytes).toString()));
  if (!reply.protectedHistory.receipt || !sameRef(reply.revisionRef, candidate.ref)
    || digest(parseWorkforceSpecialistCandidate(reply.candidate)) !== digest(candidate)
    || !sameRef(reply.admissionRef, scope.admissionRef)
    || !sameRef(reply.protocolRef, workforceSpecialistCapabilityRef("specialist_register", reply.protocol))
    || !sameRef(reply.evaluationRef, workforceSpecialistCapabilityRef("specialist_evaluate", reply.evaluation))
    || !sameRef(reply.admissionRef, workforceSpecialistCapabilityRef("specialist_admit", reply.admission)))
    fault("S8_SPECIALIST_CURRENT_COMMITMENT_SUBSTITUTION");
  const protocol = reply.protocol.body, evaluation = reply.evaluation.body, admission = reply.admission.body;
  const protocolKey = assertSignature(reply.protocol, policy.evaluatorKeys, protocol.evaluatorId);
  const evaluationKey = assertSignature(reply.evaluation, policy.evaluatorKeys, protocol.evaluatorId);
  const admissionKey = assertSignature(reply.admission, policy.promotionKeys);
  if (!sameRef(protocol.revisionRef, candidate.ref) || !sameRef(evaluation.revisionRef, candidate.ref)
    || !sameRef(admission.revisionRef, candidate.ref) || !sameRef(evaluation.protocolRef, reply.protocolRef)
    || !sameRef(admission.evaluationRef, reply.evaluationRef)
    || protocol.candidateDigest !== candidate.ref.contentDigest || evaluation.candidateDigest !== candidate.ref.contentDigest
    || admission.candidateDigest !== candidate.ref.contentDigest || evaluation.evaluatorId !== protocol.evaluatorId
    || evaluation.disposition !== "SUPPORTED_DEV_PROTECTED" || evaluation.falseCompletions !== 0
    || evaluation.authorityViolations !== 0 || evaluation.results.some(result => result.status !== "PASS")
    || new Set(evaluation.results.map(result => result.case)).size !== evaluation.cases.length
    || digest(evaluation.results) !== evaluation.resultsDigest
    || digest(protocol.caseCommitments) !== digest(evaluation.caseCommitments)
    || protocol.tenantId !== candidate.tenantId || protocol.principalId !== candidate.principalId
    || evaluation.tenantId !== candidate.tenantId || evaluation.principalId !== candidate.principalId
    || digest(protocol.cases) !== digest(evaluation.cases)
    || Date.parse(protocol.registeredAt) < Date.parse(candidate.proposedAt)
    || Date.parse(protocol.registeredAt) > Date.now()
    || Date.parse(evaluation.completedAt) < Date.parse(protocol.registeredAt) || Date.parse(evaluation.completedAt) > Date.now())
    fault("S8_SPECIALIST_CURRENT_EVALUATION_BINDING_INVALID");
  const validUntil = new Date(Math.min(...[candidate.validUntil, policy.validUntil,
    protocolKey.validUntil, evaluationKey.validUntil, admissionKey.validUntil].map(Date.parse))).toISOString();
  if (scope.deadlineAt >= Date.parse(validUntil)) fault("S8_SPECIALIST_ADMISSION_ENDS_BEFORE_ATTEMPT");
  await currentInstalled(candidate); scope.signal.throwIfAborted();
  const epoch=await canonicalAuthority.readEpoch();
  if(before.epoch!==epoch.epoch||before.historyDigest!==epoch.historyDigest)
    fault("S8_CANONICAL_ADMISSION_CHANGED_DURING_CONSUMER_READ",503);
  assertCanonicalCurrentBinding(epoch,{...reply,candidate});
  const binding: WorkforceSpecialistCapability = {
    canonicalAuthority:canonicalEpochReference(epoch),
    schema: "finnor.s8.workforce-specialist-consumer-binding.v1", revisionRef: candidate.ref,
    admissionRef: reply.admissionRef, evaluationRef: reply.evaluationRef, policyDigest: digest(policy),
    candidateDigest: candidate.ref.contentDigest, sourceClosureDigest: candidate.sourceClosureDigest,
    runtimeDigest: candidate.runtimeDigest, mechanism: candidate.mechanism, modelIdentity: candidate.modelIdentity,
    limits: specialistLimitsSchema.parse(candidate.limits), spendBudgetRef: policy.spendBudgetRef,
    qualificationDomain: SPECIALIST_QUALIFICATION_DOMAIN, protectedQualification: true,
    productionActive: false, executionAuthorityGranted: false, validUntil,
  };
  if (expected && digest(binding) !== digest(expected)) fault("S8_SPECIALIST_CURRENT_ADMISSION_CHANGED");
  return binding;
  }finally{await canonicalAuthority.close();}
}

/** Actual role caller used by the registered owner and separately enrolled proof
 * services. This never accepts a connection, role credential or issuer from a job. */
export async function openWorkforceSpecialistPublicationAuthority(
  requiredRole: "candidate" | "proof" | "projection" | "reader", originalReadOnly = requiredRole !== "candidate") {
  const path = process.env.FINNOR_S8_WORKFORCE_SPECIALIST_CONSUMER_CONFIG;
  const root = process.env.FINNOR_S8_WORKFORCE_SPECIALIST_CONSUMER_ROOT;
  if (!path || !root) fault("WORKFORCE_SPECIALIST_UNADMITTED", 503);
  const raw = signed(Policy).parse(JSON.parse((await privateFile(path)).toString()));
  const policy = raw.body, key = createPublicKey(root);
  if (key.asymmetricKeyType !== "ed25519"
    || !verify(null, Buffer.from(canonical(policy)), key, Buffer.from(raw.signature, "base64"))
    || Date.parse(policy.validAfter) >= Date.parse(policy.validUntil)
    || !originalReadOnly && (Date.now() < Date.parse(policy.validAfter) || Date.now() >= Date.parse(policy.validUntil)))
    fault("S8_SPECIALIST_CONSUMER_POLICY_INVALID", 403);
  return openConsumerCanonicalAuthority(policy, root, [requiredRole], originalReadOnly);
}
