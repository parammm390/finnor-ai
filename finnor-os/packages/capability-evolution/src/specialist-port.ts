/** Typed dev-only protected specialist domain in the existing S8 lifecycle. */
import { z } from "zod";
import { SPECIALIST_QUALIFICATION_DOMAIN, specialistLimitsSchema, specialistMechanismSchema,
  specialistModelIdentitySchema } from "../../governed-execution/src/specialist-contract";
import { assertSignature, digest, fault, RefSchema, sameRef, SourcePinSchema,
  type AuthorityKey, type CapabilityRef, type Signed } from "./contracts";
import type { JournalEntry } from "./journal";
import { assertWorkforceSpecialistSourceClosure, installedWorkforceSpecialistIdentity } from "./specialist-source";
import { specialistPortConfigurationSchema } from "./specialist-domain";

const text = z.string().min(1).max(4096), hex = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });
const CandidateBody = z.object({
  schema: z.literal("finnor.s8.workforce-specialist-method.v1"), tenantId: text, principalId: text,
  rightsRef: text, owningInterface: z.literal("w2-specialist-analysis-v1"),
  qualificationDomain: z.literal(SPECIALIST_QUALIFICATION_DOMAIN), productionActive: z.literal(false),
  mechanism: specialistMechanismSchema, modelIdentity: specialistModelIdentitySchema,
  dependencies: z.array(SourcePinSchema).min(1).max(256), sourceClosureDigest: hex, runtimeDigest: hex,
  limits: specialistLimitsSchema, proposedAt: instant, validAfter: instant, validUntil: instant,
  executionAuthorityGranted: z.literal(false),
}).strict();
export type WorkforceSpecialistCandidate = z.infer<typeof CandidateBody> & { ref: CapabilityRef };
export const workforceSpecialistCapabilityRef = (kind: string, body: unknown): CapabilityRef => ({
  owner: "S8", id: "workforce-specialist-" + kind + ":" + digest(body),
  version: "s8-workforce-specialist-v1", contentDigest: digest(body),
});
export function parseWorkforceSpecialistCandidate(value: unknown): WorkforceSpecialistCandidate {
  const { ref, ...rest } = z.object({ ref: RefSchema }).passthrough().parse(value);
  const body = CandidateBody.parse(rest);
  if (!sameRef(ref, workforceSpecialistCapabilityRef("candidate", body))
    || body.sourceClosureDigest !== digest(body.dependencies)
    || Date.parse(body.validUntil) <= Date.parse(body.validAfter))
    fault("S8_SPECIALIST_CANDIDATE_IDENTITY_INVALID");
  return { ...body, ref };
}
export const specialistQualificationCases = [
  "OWNING_WORK_INTAKE_AND_INDEPENDENT_CRITERION", "PARENT_SCOPE_AND_ORIGINAL_S5_BOUNDS",
  "ABSENT_STALE_REVOKED_OR_SUBSTITUTED_ADMISSION", "KERNEL_AGGREGATE_MEMORY_CPU_PIDS_AND_ZERO_DISK",
  "GUEST_NETWORK_FILES_CREDENTIALS_AND_PROCESS_ISOLATION", "GUARDIAN_DEADLINE_AND_PARENT_DEATH",
  "BEDROCK_IAM_SINGLE_MODEL_NATIVE_BODY_BOUND", "P3_LOSS_AND_JOB_LEASE_LOSS_ABORT_PHYSICAL_IO",
  "FENCED_POSSIBLE_CALL_UNKNOWN_RECOVERY_NO_REPLAY",
] as const;
export const specialistProtocolSchema = z.object({
  schema: z.literal("finnor.s8.workforce-specialist-evaluation.v1"), revisionRef: RefSchema,
  tenantId: text, principalId: text, evaluatorId: text, registeredAt: instant,
  candidateDigest: hex, caseCommitments: z.array(hex).length(specialistQualificationCases.length),
  cases: z.tuple([z.literal(specialistQualificationCases[0]), z.literal(specialistQualificationCases[1]),
    z.literal(specialistQualificationCases[2]), z.literal(specialistQualificationCases[3]),
    z.literal(specialistQualificationCases[4]), z.literal(specialistQualificationCases[5]),
    z.literal(specialistQualificationCases[6]), z.literal(specialistQualificationCases[7]),
    z.literal(specialistQualificationCases[8])]),
}).strict();
const Protocol = specialistProtocolSchema;
export const specialistEvaluationSchema = Protocol.omit({ registeredAt: true }).extend({
  schema: z.literal("finnor.s8.workforce-specialist-evaluation-result.v1"), protocolRef: RefSchema,
  completedAt: instant, resultsDigest: hex,
  results: z.array(z.object({ case: z.enum(specialistQualificationCases),
    status: z.enum(["PASS", "FAIL", "NOT_RUN"]), evidenceRef: RefSchema }).strict())
    .length(specialistQualificationCases.length),
  disposition: z.enum(["SUPPORTED_DEV_PROTECTED", "REFUSED", "INCONCLUSIVE"]),
  falseCompletions: z.number().int().nonnegative(), authorityViolations: z.number().int().nonnegative(),
}).strict();
export const specialistAdmissionSchema = z.object({
  schema: z.literal("finnor.s8.workforce-specialist-admission.v1"), revisionRef: RefSchema,
  evaluationRef: RefSchema, candidateDigest: hex,
  qualificationDomain: z.literal(SPECIALIST_QUALIFICATION_DOMAIN),
  protectedQualification: z.literal(true), productionActive: z.literal(false), executionAuthorityGranted: z.literal(false),
}).strict();
const Revocation = z.object({ revisionRef: RefSchema, expectedAdmissionRef: RefSchema, reason: text }).strict();
type Actor = { id: string; principalId: string; roles: readonly string[] };
type Policy = { domain: string; tenantId: string; principalId: string; rightsRef: string;
  validAfter: string; validUntil: string; evaluatorKeys: AuthorityKey[]; promotionKeys: AuthorityKey[];
  protectedEvents?: { contract: string; maxRecoveryEvents: number };
  specialistAnalysis?: z.infer<typeof specialistPortConfigurationSchema> };
type State = { candidate: WorkforceSpecialistCandidate;
  protocol: Signed<z.infer<typeof Protocol>> | null; protocolRef: CapabilityRef | null;
  evaluation: Signed<z.infer<typeof specialistEvaluationSchema>> | null; evaluationRef: CapabilityRef | null;
  admission: Signed<z.infer<typeof specialistAdmissionSchema>> | null; admissionRef: CapabilityRef | null;
  revoked: boolean };
export const workforceSpecialistCommitResult = (ref: CapabilityRef) => ({
  ref, qualificationDomain: SPECIALIST_QUALIFICATION_DOMAIN,
  productionActive: false as const, executionAuthorityGranted: false as const,
});
type SpecialistPortAnswer =
  | { readOnly: false; result: ReturnType<typeof workforceSpecialistCommitResult> }
  | { readOnly: true; result: {
      current: boolean; revisionRef: CapabilityRef; candidate: WorkforceSpecialistCandidate | null;
      admissionRef: CapabilityRef | null; evaluationRef: CapabilityRef | null; protocolRef: CapabilityRef | null;
      evaluation: State["evaluation"]; admission: State["admission"]; protocol: State["protocol"];
      qualificationDomain: typeof SPECIALIST_QUALIFICATION_DOMAIN; protectedQualification: boolean;
      productionActive: false; executionAuthorityGranted: false;
    } };
type PreparedSpecialistCommand = Extract<SpecialistPortAnswer, { readOnly: true }>
  | { readOnly: false; ref: CapabilityRef; content: unknown };
export const workforceSpecialistOperations = ["SPECIALIST_PROPOSE", "SPECIALIST_REGISTER",
  "SPECIALIST_EVALUATE", "SPECIALIST_ADMIT", "SPECIALIST_REVOKE", "SPECIALIST_CURRENT"] as const;

export class WorkforceSpecialistCapabilityPort {
  private states = new Map<string, State>();
  private consumedCases = new Set<string>();
  private registrationHolds = new Map<string, string>();
  constructor(private policy: Policy) {}
  private registrationIntent(entry: JournalEntry) {
    const b = entry.body;
    const signed = z.object({ body: Protocol, keyId: text, signature: z.string().min(1).max(128) }).strict().parse(b.input);
    const ref = workforceSpecialistCapabilityRef("specialist_register", signed);
    const requestDigest = digest({ actorId: entry.actorId, requestId: b.requestId,
      operation: b.operation, body: b.input });
    if (entry.operation !== "SPECIALIST_COMMIT_INTENT" || b.operation !== "SPECIALIST_REGISTER"
      || b.originalRequestDigest !== requestDigest || !sameRef(RefSchema.parse(b.ref), ref)
      || digest(b.content) !== digest(signed)
      || entry.requestId !== "specialist-intent:" + digest({ requestId: b.requestId, requestDigest, actorId: entry.actorId })
      || entry.requestDigest !== digest({ requestDigest, ref, content: signed })
      || entry.result.commitmentOnly !== true || entry.result.originalResponsibilityRetained !== true
      || entry.result.executionAuthorityGranted !== false)
      fault("S8_SPECIALIST_REGISTRATION_INTENT_CHANGED");
    return { protocol: signed.body, owner: digest({ requestId: b.requestId, requestDigest,
      actorId: entry.actorId, ref }) };
  }
  private assertRegistrationHold(protocol: z.infer<typeof Protocol>, owner: string) {
    if (this.state(protocol.revisionRef).protocol || protocol.caseCommitments.some(commitment =>
      this.consumedCases.has(commitment) || this.registrationHolds.get(commitment) !== owner))
      fault("S8_SPECIALIST_ORIGINAL_REGISTRATION_CASE_HOLD_REQUIRED", 503);
  }
  assertOriginalCommitRecovery(entry: JournalEntry) {
    if (entry.body.operation !== "SPECIALIST_REGISTER") return;
    const original = this.registrationIntent(entry);
    this.assertRegistrationHold(original.protocol, original.owner);
  }
  private authorize(actor: Actor, operation: string) {
    if (!workforceSpecialistOperations.some(value => value === operation))
      fault("S8_SPECIALIST_OPERATION_UNSUPPORTED", 404);
    const role = operation === "SPECIALIST_PROPOSE" ? "PROPOSER"
      : operation === "SPECIALIST_ADMIT" || operation === "SPECIALIST_REVOKE" ? "PROMOTER"
      : operation === "SPECIALIST_REGISTER" || operation === "SPECIALIST_EVALUATE" ? "EVALUATOR" : null;
    if (role ? !actor.roles.includes(role) : operation !== "SPECIALIST_CURRENT"
      || !actor.roles.some(value => value === "READER" || value === "CONSUMER"))
      fault("S8_OPERATION_NOT_AUTHORIZED", 403);
    if (!this.policy.specialistAnalysis || this.policy.domain !== "REVIEWED_PROTECTED_DOMAIN" || !this.policy.protectedEvents)
      fault("S8_SPECIALIST_PROTECTED_DOMAIN_UNAVAILABLE", 503);
    return role;
  }
  async revalidateReplay(actor: Actor, operation: string, input: unknown) {
    const role = this.authorize(actor, operation);
    if (operation === "SPECIALIST_PROPOSE") {
      const candidate = parseWorkforceSpecialistCandidate(input);
      if (actor.principalId !== candidate.principalId || digest(this.state(candidate.ref).candidate) !== digest(candidate))
        fault("S8_OPERATION_NOT_AUTHORIZED", 403);
      await this.dependencies(candidate);
      return;
    }
    const raw = z.object({ body: z.unknown(), keyId: text, signature: z.string().min(1).max(128) }).strict().parse(input);
    const schema = operation === "SPECIALIST_REGISTER" ? Protocol : operation === "SPECIALIST_EVALUATE"
      ? specialistEvaluationSchema : operation === "SPECIALIST_ADMIT" ? specialistAdmissionSchema : Revocation;
    const body = schema.parse(raw.body), state = this.state(body.revisionRef);
    assertSignature({ ...raw, body }, role === "PROMOTER" ? this.policy.promotionKeys : this.policy.evaluatorKeys, actor.principalId);
    await this.dependencies(state.candidate);
    if (operation === "SPECIALIST_ADMIT" && !this.current(state))
      fault("S8_SPECIALIST_ADMISSION_NOT_CURRENT", 503);
  }
  replay(entry: JournalEntry) {
    if (entry.operation === "SPECIALIST_COMMIT_INTENT") {
      if (entry.body.operation === "SPECIALIST_REGISTER") {
        const { protocol, owner } = this.registrationIntent(entry);
        this.state(protocol.revisionRef);
        for (const commitment of protocol.caseCommitments) {
          const held = this.registrationHolds.get(commitment);
          if (this.consumedCases.has(commitment) || held !== undefined && held !== owner)
            fault("S8_SPECIALIST_REGISTRATION_CASE_HOLD_CONFLICT", 503);
        }
        // Durable original intent owns cases before any possible named-reference call.
        // Missing readback, revocation and restart never release this ambiguous hold.
        for (const commitment of protocol.caseCommitments) this.registrationHolds.set(commitment, owner);
      }
      return;
    }
    if (entry.operation === "SPECIALIST_PROPOSE") {
      const candidate = parseWorkforceSpecialistCandidate(entry.body);
      this.states.set(candidate.ref.id, { candidate, protocol: null, protocolRef: null,
        evaluation: null, evaluationRef: null, admission: null, admissionRef: null, revoked: false });
      return;
    }
    const state = this.state(entry.body.body?.revisionRef ?? entry.body.revisionRef);
    if (entry.operation === "SPECIALIST_REGISTER") {
      const protocol = Protocol.parse(entry.body.body);
      const ref = workforceSpecialistCapabilityRef("specialist_register", entry.body);
      if (!sameRef(entry.result.ref, ref)) fault("S8_SPECIALIST_REGISTRATION_REFERENCE_CHANGED");
      this.assertRegistrationHold(protocol, digest({ requestId: entry.requestId,
        requestDigest: entry.requestDigest, actorId: entry.actorId, ref }));
      state.protocol = entry.body; state.protocolRef = entry.result.ref;
      for (const commitment of protocol.caseCommitments) this.consumedCases.add(commitment);
    } else if (entry.operation === "SPECIALIST_EVALUATE") {
      state.evaluation = entry.body; state.evaluationRef = entry.result.ref;
    } else if (entry.operation === "SPECIALIST_ADMIT") {
      state.admission = entry.body; state.admissionRef = entry.result.ref;
    } else if (entry.operation === "SPECIALIST_REVOKE") state.revoked = true;
    else fault("S8_SPECIALIST_OPERATION_UNSUPPORTED", 404);
  }
  private state(ref: CapabilityRef) {
    const state = this.states.get(ref?.id);
    if (!state || !sameRef(state.candidate.ref, ref)) fault("S8_SPECIALIST_REVISION_NOT_FOUND", 404);
    return state;
  }
  private async dependencies(candidate: WorkforceSpecialistCandidate) {
    const domain = this.policy.specialistAnalysis;
    if (!domain || this.policy.domain !== "REVIEWED_PROTECTED_DOMAIN" || !this.policy.protectedEvents
      || candidate.tenantId !== this.policy.tenantId || candidate.principalId !== this.policy.principalId
      || candidate.rightsRef !== this.policy.rightsRef
      || digest(domain.mechanism) !== digest(candidate.mechanism)
      || digest(domain.modelIdentity) !== digest(candidate.modelIdentity)
      || digest(domain.sourcePins) !== candidate.sourceClosureDigest)
      fault("S8_SPECIALIST_PROTECTED_DOMAIN_UNAVAILABLE", 503);
    await assertWorkforceSpecialistSourceClosure(candidate.dependencies);
    if ((await installedWorkforceSpecialistIdentity()).runtimeDigest !== candidate.runtimeDigest)
      fault("S8_SPECIALIST_RUNTIME_CHANGED", 503);
  }
  private current(state: State) {
    const now = Date.now();
    if (state.revoked || !state.protocol || !state.evaluation || !state.admission
      || state.evaluation.body.disposition !== "SUPPORTED_DEV_PROTECTED"
      || now < Date.parse(state.candidate.validAfter) || now >= Date.parse(state.candidate.validUntil)
      || now < Date.parse(this.policy.validAfter) || now >= Date.parse(this.policy.validUntil)) return false;
    assertSignature(state.protocol, this.policy.evaluatorKeys, state.protocol.body.evaluatorId);
    assertSignature(state.evaluation, this.policy.evaluatorKeys, state.evaluation.body.evaluatorId);
    assertSignature(state.admission, this.policy.promotionKeys);
    return true;
  }
  /** No journal/reference/event/case-hold/model effects. Repeat under the fence. */
  async admitCommand(actor: Actor, operation: string, input: unknown): Promise<void> {
    await this.prepareCommand(actor, operation, input);
  }
  private async prepareCommand(actor: Actor, operation: string, input: unknown): Promise<PreparedSpecialistCommand> {
    const readOnly = operation === "SPECIALIST_CURRENT";
    const role = this.authorize(actor, operation);
    if (readOnly) {
      const state = this.state(z.object({ revisionRef: RefSchema }).strict().parse(input).revisionRef);
      await this.dependencies(state.candidate);
      const current = this.current(state);
      return { readOnly: true, result: { current, revisionRef: state.candidate.ref,
        candidate: current ? state.candidate : null, admissionRef: current ? state.admissionRef : null,
        evaluation: current ? state.evaluation : null, admission: current ? state.admission : null,
        protocol: current ? state.protocol : null, protocolRef: current ? state.protocolRef : null,
        evaluationRef: current ? state.evaluationRef : null,
        qualificationDomain: SPECIALIST_QUALIFICATION_DOMAIN,
        protectedQualification: current, productionActive: false, executionAuthorityGranted: false } };
    }
    let content: unknown, ref: CapabilityRef;
    if (operation === "SPECIALIST_PROPOSE") {
      const candidate = parseWorkforceSpecialistCandidate(input);
      if (candidate.tenantId !== this.policy.tenantId || candidate.principalId !== this.policy.principalId
        || candidate.principalId !== actor.principalId || candidate.rightsRef !== this.policy.rightsRef
        || Date.parse(candidate.validAfter) < Date.parse(this.policy.validAfter)
        || Date.parse(candidate.validUntil) > Date.parse(this.policy.validUntil)
        || Date.parse(candidate.proposedAt) > Date.now() || this.states.has(candidate.ref.id))
        fault("S8_SPECIALIST_PROPOSAL_SCOPE_INVALID");
      await this.dependencies(candidate);
      const { ref: _ref, ...body } = candidate; content = body; ref = candidate.ref;
    } else {
      const raw = z.object({ body: z.unknown(), keyId: text, signature: z.string().min(1).max(128) }).strict().parse(input);
      const schema = operation === "SPECIALIST_REGISTER" ? Protocol : operation === "SPECIALIST_EVALUATE"
        ? specialistEvaluationSchema : operation === "SPECIALIST_ADMIT" ? specialistAdmissionSchema
        : operation === "SPECIALIST_REVOKE" ? Revocation : null;
      if (!schema) fault("S8_SPECIALIST_OPERATION_UNSUPPORTED", 404);
      const body = schema.parse(raw.body), signed = { ...raw, body }, state = this.state(body.revisionRef);
      await this.dependencies(state.candidate);
      if (state.revoked) fault("S8_SPECIALIST_REVOKED");
      assertSignature(signed, role === "PROMOTER" ? this.policy.promotionKeys : this.policy.evaluatorKeys, actor.principalId);
      if (operation === "SPECIALIST_REGISTER") {
        const protocol = Protocol.parse(body);
        if (state.protocol || protocol.tenantId !== state.candidate.tenantId
          || protocol.principalId !== state.candidate.principalId || protocol.evaluatorId !== actor.principalId
          || protocol.candidateDigest !== state.candidate.ref.contentDigest
          || Date.parse(protocol.registeredAt) < Date.parse(state.candidate.proposedAt)
          || Date.parse(protocol.registeredAt) > Date.now()
          || new Set(protocol.caseCommitments).size !== protocol.caseCommitments.length
          || protocol.caseCommitments.some(value => this.consumedCases.has(value) || this.registrationHolds.has(value)))
          fault("S8_SPECIALIST_REGISTRATION_INVALID");
      } else if (operation === "SPECIALIST_EVALUATE") {
        const evaluation = specialistEvaluationSchema.parse(body), protocol = state.protocol?.body;
        if (!protocol || state.evaluation || !sameRef(evaluation.protocolRef, state.protocolRef)
          || evaluation.tenantId !== protocol.tenantId || evaluation.principalId !== protocol.principalId
          || evaluation.evaluatorId !== protocol.evaluatorId || evaluation.candidateDigest !== protocol.candidateDigest
          || digest(evaluation.caseCommitments) !== digest(protocol.caseCommitments)
          || Date.parse(evaluation.completedAt) < Date.parse(protocol.registeredAt)
          || Date.parse(evaluation.completedAt) > Date.now()
          || digest(evaluation.results) !== evaluation.resultsDigest
          || new Set(evaluation.results.map(value => value.case)).size !== specialistQualificationCases.length
          || evaluation.disposition === "SUPPORTED_DEV_PROTECTED" && (evaluation.falseCompletions !== 0
            || evaluation.authorityViolations !== 0 || evaluation.results.some(value => value.status !== "PASS")))
          fault("S8_SPECIALIST_EVALUATION_INVALID");
      } else if (operation === "SPECIALIST_ADMIT") {
        const admission = specialistAdmissionSchema.parse(body);
        if (state.admission || !state.evaluation || state.evaluation.body.disposition !== "SUPPORTED_DEV_PROTECTED"
          || !sameRef(admission.evaluationRef, state.evaluationRef)
          || admission.candidateDigest !== state.candidate.ref.contentDigest
          || Date.now() < Date.parse(state.candidate.validAfter) || Date.now() >= Date.parse(state.candidate.validUntil))
          fault("S8_SPECIALIST_ADMISSION_INVALID");
        assertSignature(state.evaluation, this.policy.evaluatorKeys, state.evaluation.body.evaluatorId);
      } else if (!sameRef(Revocation.parse(body).expectedAdmissionRef, state.admissionRef))
        fault("S8_SPECIALIST_REVOCATION_INVALID");
      content = signed; ref = workforceSpecialistCapabilityRef(operation.toLowerCase(), signed);
    }
    return { readOnly: false, ref, content };
  }
  async command(actor: Actor, operation: string, input: unknown,
    commit: (ref: CapabilityRef, content: unknown) => Promise<unknown>): Promise<SpecialistPortAnswer> {
    const prepared = await this.prepareCommand(actor, operation, input);
    if (prepared.readOnly) return prepared;
    await commit(prepared.ref, prepared.content);
    const result = workforceSpecialistCommitResult(prepared.ref);
    // Lifecycle.persist owns replay and protected-event acknowledgement.
    return { readOnly: false, result };
  }
}
