import { z } from "zod";
import {
  APPLICATION_PROFILE, APPLICATION_LIMITS, ApplicationFault, ApplicationIdSchema,
  ApplicationDigestSchema, ApplicationValueSchema, ApplicationModelSchema, ApplicationThresholdsSchema,
  ApplicationRequirementSchema, ApplicationActionSchema, ApplicationGuardSchema, ApplicationApprovalSchema,
  ApplicationInvariantSchema, ApplicationExecutionContextSchema,
  applicationCanonical, applicationDigest, applicationRequire, applicationUnique,
  applicationCompatible, applicationValueType, parseApplicationData, assertApplicationData,
  validateApplicationModel, validateApplicationValue, validateValuesAgainstModel, validateApplicationRawQuantities,
  type ApplicationValue, type ApplicationValues, type ApplicationValueType, type ApplicationUnknown,
  type ApplicationQuantity, type ApplicationModel, type ApplicationEntity, type ApplicationExecutionContext,
  type ApplicationApprovalReceipt,
} from "./contracts";
import { applicationSumQuantities, applicationDimensionMismatch, applicationExactCompare, applicationExactDifference } from "./exact";

const comparison = z.enum(["lt", "lte", "eq", "gte", "gt"]);
export const ApplicationInstructionSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("PUSH"), value: ApplicationValueSchema }).strict(),
  z.object({ op: z.literal("LOAD"), source: z.enum(["record", "input"]), field: ApplicationIdSchema }).strict(),
  z.object({ op: z.literal("STATE"), is: ApplicationIdSchema }).strict(),
  ...(["SUM", "KNOWN", "CURRENT_EVIDENCE", "NOT", "EQUAL", "SAME_QUANTITY", "DIFFERENCE"] as const).map(op =>
    z.object({ op: z.literal(op) }).strict()),
  z.object({ op: z.literal("COMPARE"), comparison }).strict(),
  z.object({ op: z.literal("CURRENCY_THRESHOLD"), comparison, thresholds: ApplicationThresholdsSchema }).strict(),
  ...(["ALL", "ANY"] as const).map(op => z.object({
    op: z.literal(op), count: z.number().int().min(1).max(32),
  }).strict()),
]);
export type ApplicationInstruction = z.infer<typeof ApplicationInstructionSchema>;
export const ApplicationCodeSchema = z.array(ApplicationInstructionSchema).min(1).max(APPLICATION_LIMITS.expressionInstructions);
const CompiledGuardSchema = ApplicationGuardSchema.omit({ condition: true }).extend({ code: ApplicationCodeSchema });
const CompiledApprovalSchema = ApplicationApprovalSchema.omit({ requirements: true }).extend({
  requirements: z.array(z.object({ role: ApplicationIdSchema, code: ApplicationCodeSchema }).strict()).min(1).max(8),
});
export const CompiledApplicationActionSchema = ApplicationActionSchema.omit({
  guards: true, assignments: true, approval: true,
}).extend({
  guards: z.array(CompiledGuardSchema).max(64),
  assignments: z.array(z.object({ field: ApplicationIdSchema, code: ApplicationCodeSchema }).strict()).max(32),
  approval: CompiledApprovalSchema.optional(),
});
const CompiledInvariantSchema = ApplicationInvariantSchema.omit({ condition: true }).extend({ code: ApplicationCodeSchema });
export const ApplicationProgramSchema = z.object({
  schema: z.literal("finnor.enterprise-application.program.v1"), profile: z.literal(APPLICATION_PROFILE),
  kernelVersion: z.literal("x3-stack-v1"), specificationDigest: ApplicationDigestSchema,
  identity: z.object({
    id: ApplicationIdSchema, version: z.string().min(1).max(200), title: z.string().min(1).max(500),
    owner: z.object({ id: z.string().min(1).max(200), version: z.string().min(1).max(200) }).strict(),
  }).strict(),
  model: ApplicationModelSchema, requirements: z.array(ApplicationRequirementSchema).min(1).max(128),
  actions: z.array(CompiledApplicationActionSchema).min(1).max(32),
  invariants: z.array(CompiledInvariantSchema).max(64),
}).strict();
export type ApplicationProgram = z.infer<typeof ApplicationProgramSchema>;
export type CompiledApplicationAction = z.infer<typeof CompiledApplicationActionSchema>;

/** Static stack verification runs on every untrusted/deserialized program, before any action.
 * Expressions have no jumps, loops, calls or side effects. Stack types include explicit UNKNOWN. */
export function validateApplicationCode(
  code: readonly ApplicationInstruction[], model: ApplicationModel, entity: ApplicationEntity, inputFields: readonly string[],
): ApplicationValueType {
  const stack: ApplicationValueType[] = [];
  const depths: number[] = [];
  const pop = () => {
    const t = stack.pop(); applicationRequire(t !== undefined, "Stack underflow", "INVALID_PROGRAM"); return t;
  };
  const needs = (type: ApplicationValueType, expected: ApplicationValueType) =>
    applicationRequire(type === expected || type === "UNKNOWN", `Expected ${expected} operand`, "INVALID_PROGRAM");
  for (const instruction of code) {
    const arity = instruction.op === "PUSH" || instruction.op === "LOAD" || instruction.op === "STATE" ? 0 :
      instruction.op === "ALL" || instruction.op === "ANY" ? instruction.count :
      instruction.op === "EQUAL" || instruction.op === "SAME_QUANTITY" || instruction.op === "COMPARE" || instruction.op==="DIFFERENCE" ? 2 : 1;
    applicationRequire(depths.length >= arity, "Expression depth stack underflow", "INVALID_PROGRAM");
    const operands = depths.splice(depths.length - arity, arity);
    const depth = arity ? Math.max(...operands) + 1 : 0;
    applicationRequire(depth <= APPLICATION_LIMITS.expressionDepth, "Expression depth exceeded", "INVALID_PROGRAM");
    depths.push(depth);
    switch (instruction.op) {
      case "PUSH": {
        const type = applicationValueType(instruction.value);
        if (type === "quantity" || type === "quantity-list") validateApplicationValue(model, {
          id: "Literal", title: "Literal", type, required: true, allowUnknown: false,
        }, instruction.value);
        const value = instruction.value;
        if (typeof value === "object" && "kind" in value && value.kind === "RELATION")
          applicationRequire(model.entities.some(e => e.id === value.entityId), "Unknown relation literal", "INVALID_PROGRAM");
        stack.push(type); break;
      }
      case "LOAD": {
        const field = entity.fields.find(f => f.id === instruction.field);
        applicationRequire(field && (instruction.source !== "input" || inputFields.includes(field.id)), "Unknown or unscoped load", "INVALID_PROGRAM");
        stack.push(field.type); break;
      }
      case "STATE":
        applicationRequire(entity.states.includes(instruction.is), "Unknown state operand", "INVALID_PROGRAM");
        stack.push("boolean"); break;
      case "SUM": needs(pop(), "quantity-list"); stack.push("quantity"); break;
      case "KNOWN": pop(); stack.push("boolean"); break;
      case "CURRENT_EVIDENCE": needs(pop(), "evidence"); stack.push("boolean"); break;
      case "NOT": needs(pop(), "boolean"); stack.push("boolean"); break;
      case "ALL": case "ANY":
        for (let i = 0; i < instruction.count; i++) needs(pop(), "boolean");
        stack.push("boolean"); break;
      case "EQUAL": {
        const b = pop(), a = pop();
        applicationRequire(applicationCompatible(a, b), "Incompatible equality operands", "INVALID_PROGRAM");
        stack.push("boolean"); break;
      }
      case "SAME_QUANTITY": case "COMPARE":
        needs(pop(), "quantity"); needs(pop(), "quantity"); stack.push("boolean"); break;
      case "DIFFERENCE":
        needs(pop(),"quantity");needs(pop(),"quantity");stack.push("text");break;
      case "CURRENCY_THRESHOLD":
        needs(pop(), "quantity"); applicationUnique(instruction.thresholds.map(t => t.currency), "Threshold currencies");
        instruction.thresholds.forEach(t => applicationRequire(model.currencies.includes(t.currency) &&
          model.units.includes(t.units) && model.accountingBases.includes(t.accountingBasis) && model.timeModes.includes(t.timeMode),
        "Unknown threshold dimension", "INVALID_PROGRAM"));
        stack.push("boolean"); break;
      default: throw new ApplicationFault("INVALID_PROGRAM", "Unknown opcode");
    }
    applicationRequire(stack.length <= APPLICATION_LIMITS.stack, "Stack allocation exceeded", "INVALID_PROGRAM");
  }
  applicationRequire(stack.length === 1, "Expression must leave exactly one result", "INVALID_PROGRAM");
  return stack[0]!;
}
export function validateProgram(value: unknown): ApplicationProgram {
  const program = parseApplicationData(ApplicationProgramSchema, value, APPLICATION_LIMITS.assetBytes);
  validateApplicationModel(program.model);
  applicationUnique(program.requirements.map(r => r.id), "Requirements");
  applicationUnique(program.actions.map(a => a.id), "Actions");
  applicationUnique(program.invariants.map(i => i.id), "Invariants");
  let instructions = 0;
  const refs = (ids: string[]) => {
    applicationUnique(ids, "Requirement references");
    ids.forEach(id => applicationRequire(program.requirements.some(r => r.id === id), "Unknown requirement", "INVALID_PROGRAM"));
  };
  const check = (code: ApplicationInstruction[], entity: ApplicationEntity, inputs: string[]) => {
    instructions += code.length;
    applicationRequire(instructions <= APPLICATION_LIMITS.programInstructions, "Instruction budget exceeded", "INVALID_PROGRAM");
    return validateApplicationCode(code, program.model, entity, inputs);
  };
  for (const a of program.actions) {
    const entity = program.model.entities.find(e => e.id === a.entityId);
    applicationRequire(entity, "Unknown action entity", "INVALID_PROGRAM"); refs(a.requirementIds);
    applicationUnique(a.roles, "Action roles"); applicationUnique(a.fromStates, "Action states");
    applicationUnique(a.inputFields, "Action input fields"); applicationUnique(a.assignments.map(v => v.field), "Assignments");
    applicationUnique(a.guards.map(g => g.id), "Guards");
    applicationRequire(a.roles.every(id => program.model.roles.some(r => r.id === id)), "Unknown role", "INVALID_PROGRAM");
    applicationRequire(a.inputFields.every(id => entity.fields.some(f => f.id === id)), "Unknown input field", "INVALID_PROGRAM");
    applicationRequire(entity.states.includes(a.toState) && a.fromStates.every(s => entity.states.includes(s)), "Unknown state", "INVALID_PROGRAM");
    applicationRequire(a.kind === "create" ? !a.fromStates.length && a.toState === entity.initialState : a.fromStates.length > 0,
      "Invalid creation/transition states", "INVALID_PROGRAM");
    applicationRequire(a.kind !== "update" || a.toState === entity.initialState, "Update must reset state", "INVALID_PROGRAM");
    for (const assignment of a.assignments) {
      const field = entity.fields.find(f => f.id === assignment.field);
      applicationRequire(field && applicationCompatible(field.type, check(assignment.code, entity, a.inputFields)),
        "Invalid assignment", "INVALID_PROGRAM");
    }
    for (const guard of a.guards) {
      refs(guard.requirementIds);
      applicationRequire(check(guard.code, entity, a.inputFields) === "boolean", "Invalid guard", "INVALID_PROGRAM");
    }
    if (a.approval) {
      applicationUnique(a.approval.requirements.map(r => r.role), "Approval roles");
      for (const r of a.approval.requirements) {
        applicationRequire(a.roles.includes(r.role), "Unknown approval role", "INVALID_PROGRAM");
        applicationRequire(check(r.code, entity, a.inputFields) === "boolean", "Invalid approval predicate", "INVALID_PROGRAM");
      }
    }
    if (a.approval || a.requiresApprovalsFrom || a.preparedEffect)
      applicationRequire(a.kind === "transition" && !a.inputFields.length && !a.assignments.length,
        "Approval/effect transition cannot change content", "INVALID_PROGRAM");
    applicationRequire(!(a.approval && a.requiresApprovalsFrom), "Ambiguous approval policy", "INVALID_PROGRAM");
    if (a.requiresApprovalsFrom) applicationRequire(program.actions.some(other =>
      other.id === a.requiresApprovalsFrom && other.entityId === a.entityId && other.approval), "Unknown approval source", "INVALID_PROGRAM");
    if (a.preparedEffect) {
      applicationUnique(a.preparedEffect.fields, "Effect fields");
      applicationRequire(a.preparedEffect.fields.every(id => entity.fields.some(f => f.id === id)), "Unknown effect field", "INVALID_PROGRAM");
    }
  }
  for (const invariant of program.invariants) {
    refs(invariant.requirementIds);
    const entity = program.model.entities.find(e => e.id === invariant.entityId);
    applicationRequire(entity && check(invariant.code, entity, []) === "boolean", "Invalid invariant", "INVALID_PROGRAM");
  }
  return program;
}

function unknown(reason: string): ApplicationUnknown { return { kind: "UNKNOWN", reason }; }
function unknownOutcome(reason: string): string {
  // A user-authored UNKNOWN explanation is inert diagnostic text, never a command or outcome identifier.
  return ["CURRENCY_MISMATCH", "ENTITY_MISMATCH", "UNITS_MISMATCH", "TIME_MISMATCH",
    "ACCOUNTING_BASIS_MISMATCH", "SOURCE_STALE", "UNSUPPORTED_THRESHOLD_CURRENCY"].includes(reason)
    ? reason : reason.startsWith("MISSING_FIELD:") ? "MISSING_FIELD" : "UNKNOWN_VALUE";
}
function isUnknown(value: ApplicationValue): value is ApplicationUnknown {
  return typeof value === "object" && "kind" in value && value.kind === "UNKNOWN";
}
function quantity(value: ApplicationValue): ApplicationQuantity {
  if (typeof value !== "object" || !("kind" in value) || value.kind !== "QUANTITY")
    throw new ApplicationFault("INVALID_PROGRAM", "Expected runtime quantity operand");
  return value;
}
function predicate(value: ApplicationValue): boolean | ApplicationUnknown {
  if (typeof value === "boolean" || isUnknown(value)) return value;
  throw new ApplicationFault("INVALID_PROGRAM", "Expected runtime predicate operand");
}
function equalValue(a: ApplicationValue, b: ApplicationValue): boolean | ApplicationUnknown {
  if (isUnknown(a)) return a;
  if (isUnknown(b)) return b;
  if (applicationValueType(a) === "quantity" && applicationValueType(b) === "quantity") {
    const left = quantity(a), right = quantity(b), mismatch = applicationDimensionMismatch(left, right);
    return mismatch ? unknown(mismatch) : applicationExactCompare(left.amount, right.amount, "eq");
  }
  return applicationCanonical(a) === applicationCanonical(b);
}
/** Internal execution of already validated, bounded straight-line code; never interprets original specification expressions. */
function executeCode(
  code: readonly ApplicationInstruction[], context: ApplicationExecutionContext, values: ApplicationValues, state: string,
): ApplicationValue {
  const stack: ApplicationValue[] = [];
  const pop = () => {
    const value = stack.pop();
    if (value === undefined) throw new ApplicationFault("INVALID_PROGRAM", "Runtime stack underflow");
    return value;
  };
  for (const instruction of code) {
    switch (instruction.op) {
      case "PUSH": stack.push(instruction.value); break;
      case "LOAD": stack.push((instruction.source === "record" ? values : context.input)[instruction.field] ??
        unknown(`MISSING_FIELD:${instruction.field}`)); break;
      case "STATE": stack.push(state === instruction.is); break;
      case "KNOWN": stack.push(!isUnknown(pop())); break;
      case "SUM": {
        const value = pop();
        if (isUnknown(value)) { stack.push(value); break; }
        if (typeof value !== "object" || !("kind" in value) || value.kind !== "QUANTITY_LIST")
          throw new ApplicationFault("INVALID_PROGRAM", "Invalid SUM operand");
        stack.push(applicationSumQuantities(value.entries)); break;
      }
      case "CURRENT_EVIDENCE": {
        const value = pop();
        if (isUnknown(value)) { stack.push(value); break; }
        if (typeof value !== "object" || !("kind" in value) || value.kind !== "EVIDENCE")
          throw new ApplicationFault("INVALID_PROGRAM", "Invalid evidence operand");
        stack.push(context.currentEvidence.some(e => e.sourceId === value.sourceId &&
          e.versionId === value.versionId && e.contentDigest === value.contentDigest) ? true : unknown("SOURCE_STALE"));
        break;
      }
      case "NOT": {
        const value = predicate(pop()); stack.push(typeof value === "boolean" ? !value : value); break;
      }
      case "ALL": case "ANY": {
        const operands = Array.from({ length: instruction.count }, () => predicate(pop())).reverse();
        // Strong Kleene: FALSE dominates conjunction; TRUE dominates disjunction.
        const dominant = instruction.op === "ANY";
        stack.push(operands.some(v => v === dominant) ? dominant :
          operands.find(v => typeof v !== "boolean") ?? !dominant);
        break;
      }
      case "EQUAL": { const right = pop(), left = pop(); stack.push(equalValue(left, right)); break; }
      case "SAME_QUANTITY": case "COMPARE": case "DIFFERENCE": {
        const right = pop(), left = pop();
        if (isUnknown(left) || isUnknown(right)) { stack.push(isUnknown(left) ? left : right); break; }
        const a = quantity(left), b = quantity(right), mismatch = applicationDimensionMismatch(a, b);
        stack.push(mismatch ? unknown(mismatch) :
          instruction.op==="DIFFERENCE"?applicationExactDifference(a.amount,b.amount):applicationExactCompare(a.amount, b.amount, instruction.op === "COMPARE" ? instruction.comparison : "eq"));
        break;
      }
      case "CURRENCY_THRESHOLD": {
        const value = pop(); if (isUnknown(value)) { stack.push(value); break; }
        const q = quantity(value), threshold = instruction.thresholds.find(t => t.currency === q.currency);
        // Policy magnitudes apply to this canonical entity/exact time, but never reinterpret
        // units, accounting basis or temporal mode. There is no implicit minor/major conversion.
        stack.push(!threshold ? unknown("UNSUPPORTED_THRESHOLD_CURRENCY") :
          q.units !== threshold.units ? unknown("UNITS_MISMATCH") :
          q.accountingBasis !== threshold.accountingBasis ? unknown("ACCOUNTING_BASIS_MISMATCH") :
          q.time.kind !== threshold.timeMode ? unknown("TIME_MISMATCH") :
          applicationExactCompare(q.amount, threshold.amount, instruction.comparison));
        break;
      }
      default: throw new ApplicationFault("INVALID_PROGRAM", "Unrecognized runtime opcode");
    }
    if (stack.length > APPLICATION_LIMITS.stack) throw new ApplicationFault("INVALID_PROGRAM", "Runtime stack exceeded");
  }
  if (stack.length !== 1) throw new ApplicationFault("INVALID_PROGRAM", "Malformed runtime result");
  return stack[0]!;
}
export interface ApplicationApprovalDecision {
  status: "PENDING" | "COMPLETE";
  requiredRoles: string[];
  missingRoles: string[];
  /** Existing host receipts plus the proposed receipt; these are not persisted by this kernel. */
  receipts: ApplicationApprovalReceipt[];
  proposedReceipt?: ApplicationApprovalReceipt;
}
export interface ApplicationPreparedEffectIntent {
  kind: string;
  idempotencyKey: string;
  binding: {
    tenantId: string; scopeId: string; entityId: string; actionId: string; recordDigest: string;
    recordReference: NonNullable<ApplicationExecutionContext["record"]>["reference"];
    releaseId: string; specificationDigest: string;
    values: ApplicationValues; approvals: ApplicationApprovalReceipt[];
  };
  disposition: "PREPARED_INTENT_ONLY";
}
export interface ActionDecision {
  allowed: boolean;
  outcome: string;
  nextState?: string;
  values?: ApplicationValues;
  /** Pure evaluated assignments may explain a refusal. They are not committed
   * values unless allowed=true and the host transaction succeeds. */
  evaluatedAssignments?: ApplicationValues;
  unknownReason?: string;
  requirementIds: string[];
  approval?: ApplicationApprovalDecision;
  preparedEffectIntent?: ApplicationPreparedEffectIntent;
  resetApprovals?: boolean;
}
function denial(outcome: string, state?: string, requirementIds: string[] = [], unknownReason?: string): ActionDecision {
  return { allowed: false, outcome, ...(state === undefined ? {} : { nextState: state }),
    requirementIds, ...(unknownReason === undefined ? {} : { unknownReason }) };
}
function approvalDecision(
  program: ApplicationProgram, context: ApplicationExecutionContext, source: CompiledApplicationAction,
  values: ApplicationValues, state: string, add: boolean,
): ApplicationApprovalDecision {
  const policy = source.approval!, record = context.record!;
  const requiredRoles: string[] = [];
  for (const requirement of policy.requirements) {
    const value = predicate(executeCode(requirement.code, context, values, state));
    if (typeof value !== "boolean") throw new ApplicationFault(unknownOutcome(value.reason), "Approval predicate is UNKNOWN");
    if (value) requiredRoles.push(requirement.role);
  }
  applicationRequire(requiredRoles.length > 0, "No applicable approval roles", "APPROVAL_POLICY_EMPTY");
  const receipts = context.approvals.filter(r => r.actionId === source.id);
  applicationUnique(receipts.map(r => r.role), "Duplicate approval role");
  for (const receipt of receipts) {
    applicationRequire(policy.requirements.some(r => r.role === receipt.role), "Unexpected receipt role", "INVALID_APPROVALS");
    applicationRequire(receipt.recordDigest === record.recordDigest && receipt.releaseId === context.installedReleaseId &&
      receipt.tenantId === context.tenantId && receipt.scopeId === context.scopeId &&
      applicationCanonical(receipt.recordReference) === applicationCanonical(record.reference),
    "Approval binding changed", "APPROVAL_BINDING_MISMATCH");
    const canonicalRole = program.model.roles.find(r => r.id === receipt.role)!.canonicalRole;
    applicationRequire(context.currentAuthorities.some(a => a.principalId === receipt.principalId &&
      a.canonicalRole === canonicalRole && a.authorityRevision === receipt.authorityRevision && a.current &&
      a.tenantId === context.tenantId && a.scopeId === context.scopeId), "Approver authority is not current", "APPROVER_AUTHORITY_REVOKED");
    applicationRequire(!policy.noSelfApproval || receipt.principalId !== record.authorPrincipalId, "Self approval", "SELF_APPROVAL_DENIED");
  }
  if (policy.distinctPrincipals)
    applicationRequire(new Set(receipts.map(r => r.principalId)).size === receipts.length,
      "Approvals need distinct principals", "PRINCIPAL_SEPARATION_DENIED");
  let proposedReceipt: ApplicationApprovalReceipt | undefined;
  if (add) {
    applicationRequire(!policy.noSelfApproval || context.actor.principalId !== record.authorPrincipalId,
      "Author cannot approve", "SELF_APPROVAL_DENIED");
    const eligible = requiredRoles.filter(id => {
      const canonical = program.model.roles.find(r => r.id === id)!.canonicalRole;
      return context.actor.canonicalRoles.includes(canonical);
    });
    // An explicit role disambiguates a dual-role principal. Otherwise prefer an identical retry,
    // then the first unfilled eligible role. Distinct-principal policy is still enforced below.
    const role = context.approvalRole ?? eligible.find(id => receipts.some(r =>
      r.role === id && r.principalId === context.actor.principalId)) ?? eligible.find(id => !receipts.some(r => r.role === id));
    applicationRequire(role && eligible.includes(role), "Actor has no applicable approval role", "ROLE_DENIED");
    const existing = receipts.find(r => r.role === role);
    if (existing) applicationRequire(existing.principalId === context.actor.principalId &&
      existing.authorityRevision === context.actor.authorityRevision, "Role already approved by another binding", "APPROVAL_ALREADY_RECORDED");
    else {
      applicationRequire(!policy.distinctPrincipals || !receipts.some(r => r.principalId === context.actor.principalId),
        "Same principal cannot approve different roles", "PRINCIPAL_SEPARATION_DENIED");
      proposedReceipt = {
        actionId: source.id, role, principalId: context.actor.principalId,
        authorityRevision: context.actor.authorityRevision, recordDigest: record.recordDigest,
        recordReference: record.reference, releaseId: context.installedReleaseId,
        tenantId: context.tenantId, scopeId: context.scopeId,
      };
      receipts.push(proposedReceipt);
    }
  }
  const missingRoles = requiredRoles.filter(role => !receipts.some(r => r.role === role));
  return { status: missingRoles.length ? "PENDING" : "COMPLETE", requiredRoles, missingRoles, receipts,
    ...(proposedReceipt ? { proposedReceipt } : {}) };
}
/** Pure decision kernel. Host-owned authentication, durable CAS, approval persistence, relation
 * resolution, installation binding and effect proposal deduplication MUST surround this call. */
export function runApplicationProgram(untrustedProgram: unknown, untrustedContext: unknown): ActionDecision {
  let context: ApplicationExecutionContext | undefined;
  try {
    const program = validateProgram(untrustedProgram);
    assertApplicationData(untrustedContext, 128 * 1024);
    if (untrustedContext !== null && typeof untrustedContext === "object" && !Array.isArray(untrustedContext)) {
      const raw = untrustedContext as Record<string, unknown>;
      if (typeof raw.entityId === "string") {
        validateApplicationRawQuantities(program.model, raw.entityId, raw.input);
        if (raw.record !== null && typeof raw.record === "object" && !Array.isArray(raw.record))
          validateApplicationRawQuantities(program.model, raw.entityId, (raw.record as Record<string, unknown>).values);
      }
    }
    context = parseApplicationData(ApplicationExecutionContextSchema, untrustedContext, 128 * 1024);
    return runValidated(program, context);
  } catch (error) {
    if (error instanceof ApplicationFault) return denial(error.code, context?.record?.state);
    // Never allow malformed data or unexpected implementation errors to authorize a mutation.
    return denial("APPLICATION_EXECUTION_FAILED", context?.record?.state);
  }
}
function runValidated(program: ApplicationProgram, context: ApplicationExecutionContext): ActionDecision {
  const action = program.actions.find(a => a.id === context.actionId && a.entityId === context.entityId);
  const state = context.record?.state;
  if (!action) return denial("UNKNOWN_ACTION", state);
  const deny = (code: string, reason?: string) => denial(code, state, action.requirementIds, reason);
  if (context.actor.tenantId !== context.tenantId) return deny("TENANT_DENIED");
  if (context.actor.scopeId !== context.scopeId) return deny("SCOPE_DENIED");
  if (!context.actor.authorityCurrent) return deny("AUTHORITY_REVOKED");
  applicationUnique(context.actor.canonicalRoles, "Actor canonical roles");
  applicationUnique(context.currentEvidence.map(e => e.sourceId), "Current evidence sources");
  applicationUnique(context.currentAuthorities.map(a => applicationCanonical({
    principalId: a.principalId, canonicalRole: a.canonicalRole, tenantId: a.tenantId, scopeId: a.scopeId,
  })), "Current authority bindings");
  applicationUnique(context.currentRelations.map(r => applicationCanonical({
    entityId: r.entityId, owner: r.reference.owner, id: r.reference.id,
  })), "Current relation bindings");
  for (const receipt of context.approvals)
    applicationRequire(program.actions.some(a => a.id === receipt.actionId &&
      a.approval?.requirements.some(r => r.role === receipt.role)), "Unknown approval reference", "INVALID_APPROVALS");
  for (const relation of context.currentRelations)
    applicationRequire(program.model.entities.some(e => e.id === relation.entityId), "Unknown relation entity", "INVALID_RELATION");
  if (!action.roles.some(id => context.actor.canonicalRoles.includes(program.model.roles.find(r => r.id === id)!.canonicalRole)))
    return deny("ROLE_DENIED");
  const entity = program.model.entities.find(e => e.id === action.entityId)!;
  if (action.kind === "create") {
    if (context.record || context.expectedRecordDigest || context.expectedRecordReference || context.approvals.length)
      return deny("INVALID_CREATE_CONTEXT");
  } else {
    const record = context.record;
    if (!record || record.entityId !== entity.id) return deny("RECORD_ENTITY_MISMATCH");
    if (record.releaseId !== context.installedReleaseId) return deny("RELEASE_CHANGED");
    if (!context.expectedRecordDigest || context.expectedRecordDigest !== record.recordDigest ||
        !context.expectedRecordReference || applicationCanonical(context.expectedRecordReference) !== applicationCanonical(record.reference))
      return deny("RECORD_REF_MISMATCH");
    if (record.reference.contentDigest !== record.recordDigest) return deny("RECORD_DIGEST_MISMATCH");
    if (!action.fromStates.includes(record.state)) return deny("INVALID_STATE");
    validateValuesAgainstModel(program.model, entity.id, record.values);
  }
  const input = validateValuesAgainstModel(program.model, entity.id, context.input, true);
  for (const id of Object.keys(input)) if (!action.inputFields.includes(id)) return deny("UNSCOPED_INPUT_FIELD");
  let values: ApplicationValues = { ...(context.record?.values ?? {}), ...input };
  if(action.kind==="update"){
    const derived=new Set(program.actions.filter(a=>a.entityId===entity.id).flatMap(a=>a.assignments.map(x=>x.field)));
    for(const id of derived)if(!action.inputFields.includes(id)&&!action.assignments.some(a=>a.field===id)){
      const f=entity.fields.find(f=>f.id===id)!;
      if(f.allowUnknown)values[id]=unknown("BUSINESS_CONTENT_CHANGED");else delete values[id];
    }
  }
  const assignments: ApplicationValues = {};
  for (const assignment of action.assignments)
    assignments[assignment.field] = executeCode(assignment.code, context, values, state ?? entity.initialState);
  values = validateValuesAgainstModel(program.model, entity.id, { ...values, ...assignments });
  // Relation identifiers are data; their existence/scope/current reference must be host-resolved.
  for (const value of Object.values(values)) if (typeof value === "object" && "kind" in value && value.kind === "RELATION" &&
      !context.currentRelations.some(r => applicationCanonical(r) === applicationCanonical(value))) return deny("RELATION_NOT_CURRENT");
  for (const guard of action.guards) {
    const result = predicate(executeCode(guard.code, context, values, state ?? entity.initialState));
    if (result !== true) return {...denial(typeof result === "boolean" ? guard.denialCode : guard.unknownCode ?? unknownOutcome(result.reason),
      state, guard.requirementIds, typeof result === "boolean" ? undefined : result.reason),evaluatedAssignments:assignments};
  }
  let approval: ApplicationApprovalDecision | undefined;
  if (action.approval) approval = approvalDecision(program, context, action, values, state!, true);
  if (action.requiresApprovalsFrom) {
    const source = program.actions.find(a => a.id === action.requiresApprovalsFrom)!;
    approval = approvalDecision(program, context, source, values, state!, false);
    if (approval.status !== "COMPLETE") return { ...deny("APPROVALS_INCOMPLETE"), approval };
  }
  const nextState = approval?.status === "PENDING" ? state! : action.toState;
  for (const invariant of program.invariants.filter(i => i.entityId === entity.id)) {
    const result = predicate(executeCode(invariant.code, context, values, nextState));
    if (result !== true) return denial(invariant.denialCode, state, invariant.requirementIds,
      typeof result === "boolean" ? undefined : result.reason);
  }
  let preparedEffectIntent: ApplicationPreparedEffectIntent | undefined;
  if (action.preparedEffect && approval?.status !== "PENDING") {
    const selected: ApplicationValues = {};
    for (const id of action.preparedEffect.fields) {
      const value = values[id];
      if (value === undefined || isUnknown(value)) return deny("EFFECT_VALUE_UNKNOWN");
      selected[id] = value;
    }
    const binding: ApplicationPreparedEffectIntent["binding"] = {
      tenantId: context.tenantId, scopeId: context.scopeId, entityId: entity.id, actionId: action.id,
      recordDigest: context.record!.recordDigest, recordReference: context.record!.reference,
      releaseId: context.installedReleaseId, specificationDigest: program.specificationDigest,
      values: selected, approvals: [...(approval?.receipts ?? [])].sort((a, b) =>
        a.role < b.role ? -1 : a.role > b.role ? 1 : a.principalId < b.principalId ? -1 : a.principalId > b.principalId ? 1 : 0),
    };
    preparedEffectIntent = {
      kind: action.preparedEffect.kind, idempotencyKey: applicationDigest({ kind: action.preparedEffect.kind, binding }),
      binding, disposition: "PREPARED_INTENT_ONLY",
    };
  }
  return {
    allowed: true, outcome: approval?.status === "PENDING" ? action.approval!.pendingOutcome : action.outcome,
    nextState, values, requirementIds: action.requirementIds,evaluatedAssignments:assignments,
    ...(approval ? { approval } : {}), ...(preparedEffectIntent ? { preparedEffectIntent } : {}),
    ...(action.kind === "update" ? { resetApprovals: true } : {}),
  };
}
