import { createHash } from "node:crypto";
import { z } from "zod";
import { VReferenceSchema, UnknownQuantitySchema, type VReference } from "../../../shared-types/src/primary-diligence";

export const APPLICATION_PROFILE = "PE_FIRM_TYPED_APPLICATION_V1" as const;
export const APPLICATION_LIMITS = Object.freeze({
  specificationBytes: 256 * 1024, assetBytes: 4 * 1024 * 1024,
  entities: 8, fields: 32, states: 16, actions: 32, roles: 8,
  invariants: 64, acceptanceCases: 128, quantityEntries: 128,
  expressionDepth: 24, expressionInstructions: 512, programInstructions: 32768, stack: 64,
});
export class ApplicationFault extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) {
    super(message); this.name = "ApplicationFault";
  }
}
const reserved = new Set(["__proto__", "constructor", "prototype"]);
export const ApplicationIdSchema = z.string().min(1).max(120)
  .regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/).refine(v => !reserved.has(v), "Reserved identifier");
export const ApplicationDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const label = z.string().min(1).max(500);
const token = z.string().min(1).max(200);
const currency = z.string().regex(/^[A-Z]{3}$/);
const instant = z.string().datetime({ offset: true });

/** Reject non-JSON objects, accessors, cycles, reserved keys and excessive depth before Zod recurses.
 * This boundary expects decoded JSON; proxies and executable objects are not a supported input channel. */
export function assertApplicationData(value: unknown, maxBytes = APPLICATION_LIMITS.specificationBytes): void {
  let bytes = 0, nodes = 0;
  const ancestors = new Set<object>();
  function visit(v: unknown, depth: number): void {
    if (++nodes > 100000 || depth > 48) throw new ApplicationFault("RESOURCE_BOUND", "JSON tree exceeds bounds");
    if (typeof v === "string") bytes += Buffer.byteLength(v, "utf8") + 2;
    else if (v === null || typeof v === "boolean") bytes += 5;
    else if (typeof v === "number" && Number.isFinite(v)) bytes += 24;
    else if (typeof v === "object" && v !== null) {
      const proto = Object.getPrototypeOf(v);
      if ((!Array.isArray(v) && proto !== Object.prototype && proto !== null) || ancestors.has(v))
        throw new ApplicationFault("INVALID_DATA", "Only acyclic plain JSON data is supported");
      ancestors.add(v); bytes += 2;
      const descriptors = Object.getOwnPropertyDescriptors(v);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (Array.isArray(v) && key === "length") continue;
        if (reserved.has(key) || !("value" in descriptor) || !descriptor.enumerable ||
            (Array.isArray(v) && !/^(?:0|[1-9][0-9]*)$/.test(key)))
          throw new ApplicationFault("RESERVED_OR_INVALID_KEY", `Invalid JSON key: ${key}`);
        bytes += Buffer.byteLength(key, "utf8") + 4; visit(descriptor.value, depth + 1);
      }
      if (Object.getOwnPropertySymbols(v).length || (Array.isArray(v) && Object.keys(v).length !== v.length))
        throw new ApplicationFault("INVALID_DATA", "Symbols and sparse arrays are not JSON data");
      ancestors.delete(v);
    } else throw new ApplicationFault("INVALID_DATA", "Unsupported JSON value");
    if (bytes > maxBytes) throw new ApplicationFault("RESOURCE_BOUND", "JSON exceeds byte allocation");
  }
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes)
    throw new ApplicationFault("RESOURCE_BOUND", "Serialized JSON exceeds byte allocation");
}
/** Stable content encoding, not a protected receipt or admission claim. */
export function applicationCanonical(value: unknown, maxBytes = APPLICATION_LIMITS.assetBytes): string {
  assertApplicationData(value, maxBytes);
  function encode(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(encode).join(",")}]`;
    if (v !== null && typeof v === "object") return `{${Object.keys(v).sort()
      .map(k => `${JSON.stringify(k)}:${encode((v as Record<string, unknown>)[k])}`).join(",")}}`;
    return JSON.stringify(v);
  }
  return encode(value);
}
export function applicationDigest(value: unknown, maxBytes = APPLICATION_LIMITS.assetBytes): string {
  return createHash("sha256").update(applicationCanonical(value, maxBytes)).digest("hex");
}
export function applicationBytesDigest(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}
export function parseApplicationData<T>(schema: z.ZodType<T>, value: unknown, bytes?: number): T {
  assertApplicationData(value, bytes);
  const result = schema.safeParse(value);
  if (!result.success) throw new ApplicationFault("INVALID_CONTRACT", result.error.issues
    .slice(0, 8).map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  return result.data;
}

export const ApplicationDecimalSchema = z.string().max(51)
  .regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,12})?$/)
  .refine(v => v.replace(".", "").replace(/^0+/, "").length <= 38, "Maximum precision is 38 digits");
export const ApplicationUnknownSchema = UnknownQuantitySchema;
export type ApplicationUnknown = z.infer<typeof ApplicationUnknownSchema>;
export const ApplicationTimeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("AS_OF"), asOf: instant }).strict(),
  z.object({ kind: z.literal("PERIOD"), start: instant, end: instant }).strict(),
]).superRefine((t, ctx) => {
  if (t.kind === "PERIOD" && Date.parse(t.start) > Date.parse(t.end))
    ctx.addIssue({ code: "custom", message: "Period start must not follow end" });
});
export const ApplicationQuantitySchema = z.object({
  kind: z.literal("QUANTITY"), amount: ApplicationDecimalSchema, currency,
  entity: VReferenceSchema, units: token, time: ApplicationTimeSchema, accountingBasis: token,
}).strict();
export type ApplicationQuantity = z.infer<typeof ApplicationQuantitySchema>;
export const ApplicationQuantityListSchema = z.object({
  kind: z.literal("QUANTITY_LIST"), entries: z.array(ApplicationQuantitySchema).min(1).max(APPLICATION_LIMITS.quantityEntries),
}).strict();
export const ApplicationEvidenceSchema = z.object({
  kind: z.literal("EVIDENCE"), sourceId: token, versionId: token, contentDigest: ApplicationDigestSchema,
}).strict();
export type ApplicationEvidence = z.infer<typeof ApplicationEvidenceSchema>;
export const ApplicationRelationSchema = z.object({
  kind: z.literal("RELATION"), entityId: ApplicationIdSchema, reference: VReferenceSchema,
}).strict();
export const ApplicationValueSchema = z.union([
  z.string().max(8000), z.boolean(), ApplicationUnknownSchema, ApplicationQuantitySchema,
  ApplicationQuantityListSchema, ApplicationEvidenceSchema, ApplicationRelationSchema, VReferenceSchema,
]);
export type ApplicationValue = z.infer<typeof ApplicationValueSchema>;
export type ApplicationValues = Record<string, ApplicationValue>;
export const ApplicationValuesSchema = z.record(ApplicationValueSchema);
const FieldBase = {
  id: ApplicationIdSchema, title: label, required: z.boolean(), allowUnknown: z.boolean(),
};
export const ApplicationFieldSchema = z.discriminatedUnion("type", [
  z.object({ ...FieldBase, type: z.literal("text"), maxLength: z.number().int().min(1).max(8000) }).strict(),
  z.object({ ...FieldBase, type: z.literal("boolean") }).strict(),
  z.object({ ...FieldBase, type: z.literal("enum"), options: z.array(token).min(1).max(32) }).strict(),
  z.object({ ...FieldBase, type: z.literal("quantity") }).strict(),
  z.object({ ...FieldBase, type: z.literal("quantity-list") }).strict(),
  z.object({ ...FieldBase, type: z.literal("evidence") }).strict(),
  z.object({ ...FieldBase, type: z.literal("reference") }).strict(),
  z.object({ ...FieldBase, type: z.literal("relation"), entityId: ApplicationIdSchema }).strict(),
]);
export type ApplicationField = z.infer<typeof ApplicationFieldSchema>;
export const ApplicationEntitySchema = z.object({
  id: ApplicationIdSchema, title: label, fields: z.array(ApplicationFieldSchema).min(1).max(32),
  states: z.array(ApplicationIdSchema).min(1).max(16), initialState: ApplicationIdSchema,
}).strict();
export type ApplicationEntity = z.infer<typeof ApplicationEntitySchema>;
export const ApplicationRoleSchema = z.object({
  id: ApplicationIdSchema, canonicalRole: token,
}).strict();
export const ApplicationModelSchema = z.object({
  currencies: z.array(currency).min(1).max(32), units: z.array(token).min(1).max(32),
  timeModes: z.array(z.enum(["AS_OF", "PERIOD"])).min(1).max(2),
  accountingBases: z.array(token).min(1).max(32),
  roles: z.array(ApplicationRoleSchema).min(1).max(8),
  entities: z.array(ApplicationEntitySchema).min(1).max(8),
}).strict();
export type ApplicationModel = z.infer<typeof ApplicationModelSchema>;
export type ApplicationComparison = "lt" | "lte" | "eq" | "gte" | "gt";
const ComparisonSchema = z.enum(["lt", "lte", "eq", "gte", "gt"]);
export const ApplicationThresholdsSchema = z.array(z.object({
  currency, amount: ApplicationDecimalSchema, units: token, accountingBasis: token,
  timeMode: z.enum(["AS_OF", "PERIOD"]),
}).strict()).min(1).max(32);
export type ApplicationExpression =
  | { op: "literal"; value: ApplicationValue }
  | { op: "field"; source: "record" | "input"; field: string }
  | { op: "sum" | "known" | "current-evidence" | "not"; value: ApplicationExpression }
  | { op: "equal" | "same-quantity" | "difference"; left: ApplicationExpression; right: ApplicationExpression }
  | { op: "compare"; comparison: ApplicationComparison; left: ApplicationExpression; right: ApplicationExpression }
  | { op: "currency-threshold"; value: ApplicationExpression; comparison: ApplicationComparison;
      thresholds: z.infer<typeof ApplicationThresholdsSchema> }
  | { op: "state"; is: string }
  | { op: "all" | "any"; args: ApplicationExpression[] };
export const ApplicationExpressionSchema: z.ZodType<ApplicationExpression> = z.lazy(() => z.discriminatedUnion("op", [
  z.object({ op: z.literal("literal"), value: ApplicationValueSchema }).strict(),
  z.object({ op: z.literal("field"), source: z.enum(["record", "input"]), field: ApplicationIdSchema }).strict(),
  ...(["sum", "known", "current-evidence", "not"] as const).map(op =>
    z.object({ op: z.literal(op), value: ApplicationExpressionSchema }).strict()),
  ...(["equal", "same-quantity", "difference"] as const).map(op => z.object({
    op: z.literal(op), left: ApplicationExpressionSchema, right: ApplicationExpressionSchema,
  }).strict()),
  z.object({ op: z.literal("compare"), comparison: ComparisonSchema,
    left: ApplicationExpressionSchema, right: ApplicationExpressionSchema }).strict(),
  z.object({ op: z.literal("currency-threshold"), value: ApplicationExpressionSchema,
    comparison: ComparisonSchema, thresholds: ApplicationThresholdsSchema }).strict(),
  z.object({ op: z.literal("state"), is: ApplicationIdSchema }).strict(),
  ...(["all", "any"] as const).map(op => z.object({
    op: z.literal(op), args: z.array(ApplicationExpressionSchema).min(1).max(32),
  }).strict()),
]));
export const ApplicationRequirementSchema = z.object({
  id: ApplicationIdSchema, text: z.string().min(1).max(4000), critical: z.boolean(),
}).strict();
export const ApplicationGuardSchema = z.object({
  id: ApplicationIdSchema, condition: ApplicationExpressionSchema,
  denialCode: ApplicationIdSchema, unknownCode: ApplicationIdSchema.optional(),
  requirementIds: z.array(ApplicationIdSchema).min(1).max(64),
}).strict();
export const ApplicationApprovalSchema = z.object({
  requirements: z.array(z.object({
    role: ApplicationIdSchema, when: ApplicationExpressionSchema,
  }).strict()).min(1).max(8),
  noSelfApproval: z.boolean(), distinctPrincipals: z.boolean(), pendingOutcome: ApplicationIdSchema,
}).strict();
export const ApplicationActionSchema = z.object({
  id: ApplicationIdSchema, title: label, entityId: ApplicationIdSchema,
  kind: z.enum(["create", "update", "transition"]),
  fromStates: z.array(ApplicationIdSchema).max(16), toState: ApplicationIdSchema,
  roles: z.array(ApplicationIdSchema).min(1).max(8), inputFields: z.array(ApplicationIdSchema).max(32),
  assignments: z.array(z.object({ field: ApplicationIdSchema, value: ApplicationExpressionSchema }).strict()).max(32),
  guards: z.array(ApplicationGuardSchema).max(64), outcome: ApplicationIdSchema,
  requirementIds: z.array(ApplicationIdSchema).min(1).max(64),
  approval: ApplicationApprovalSchema.optional(), requiresApprovalsFrom: ApplicationIdSchema.optional(),
  preparedEffect: z.object({ kind: ApplicationIdSchema, fields: z.array(ApplicationIdSchema).min(1).max(32) }).strict().optional(),
}).strict();
export type ApplicationAction = z.infer<typeof ApplicationActionSchema>;
export const ApplicationInvariantSchema = z.object({
  id: ApplicationIdSchema, entityId: ApplicationIdSchema, critical: z.boolean(),
  condition: ApplicationExpressionSchema, denialCode: ApplicationIdSchema,
  requirementIds: z.array(ApplicationIdSchema).min(1).max(64),
}).strict();

export const ApplicationApprovalReceiptSchema = z.object({
  actionId: ApplicationIdSchema, role: ApplicationIdSchema, principalId: token,
  recordDigest: ApplicationDigestSchema, recordReference: VReferenceSchema,
  releaseId: token, authorityRevision: token, tenantId: token, scopeId: token,
}).strict();
export type ApplicationApprovalReceipt = z.infer<typeof ApplicationApprovalReceiptSchema>;
export const ApplicationRecordSchema = z.object({
  entityId: ApplicationIdSchema, state: ApplicationIdSchema, values: ApplicationValuesSchema,
  authorPrincipalId: token, recordDigest: ApplicationDigestSchema, reference: VReferenceSchema, releaseId: token,
}).strict();
/** ALL identity, authority, source-currentness and relation facts here are trusted HOST inputs.
 * Never construct this object by spreading a client request. The host must recheck at atomic commit.
 * recordDigest binds immutable business content/source references (not evolving workflow state). */
export const ApplicationExecutionContextSchema = z.object({
  entityId: ApplicationIdSchema, actionId: ApplicationIdSchema, installedReleaseId: token,
  tenantId: token, scopeId: token,
  actor: z.object({
    principalId: token, canonicalRoles: z.array(token).max(32), authorityRevision: token,
    authorityCurrent: z.boolean(), tenantId: token, scopeId: token,
  }).strict(),
  record: ApplicationRecordSchema.optional(),
  expectedRecordDigest: ApplicationDigestSchema.optional(), expectedRecordReference: VReferenceSchema.optional(),
  input: ApplicationValuesSchema, approvalRole: ApplicationIdSchema.optional(),
  approvals: z.array(ApplicationApprovalReceiptSchema).max(256),
  currentAuthorities: z.array(z.object({
    principalId: token, canonicalRole: token, authorityRevision: token, current: z.boolean(),
    tenantId: token, scopeId: token,
  }).strict()).max(256),
  currentEvidence: z.array(ApplicationEvidenceSchema).max(128),
  currentRelations: z.array(ApplicationRelationSchema).max(128),
}).strict();
export type ApplicationExecutionContext = z.infer<typeof ApplicationExecutionContextSchema>;
export const BusinessSpecificationSchema = z.object({
  schema: z.literal("finnor.business-specification.v1"), profile: z.literal(APPLICATION_PROFILE),
  owner: z.object({ id: token, version: token }).strict(),
  id: ApplicationIdSchema, version: token, title: label, family: z.literal("PE_FIRM_OPERATIONS"),
  model: ApplicationModelSchema,
  requirements: z.array(ApplicationRequirementSchema).min(1).max(128),
  unresolvedCriticalRequirementIds: z.array(ApplicationIdSchema).max(64),
  actions: z.array(ApplicationActionSchema).min(1).max(32),
  invariants: z.array(ApplicationInvariantSchema).max(64),
  acceptanceCases: z.array(z.object({
    id: ApplicationIdSchema, requirementIds: z.array(ApplicationIdSchema).min(1).max(64),
    input: ApplicationExecutionContextSchema,
    expected: z.object({ allowed: z.boolean(), outcome: ApplicationIdSchema, nextState: ApplicationIdSchema.optional() }).strict(),
  }).strict()).min(1).max(128),
}).strict();
export type BusinessSpecification = z.infer<typeof BusinessSpecificationSchema>;
export type ApplicationValueType = ApplicationField["type"] | "UNKNOWN";

export function applicationUnique(values: readonly string[], subject: string): void {
  if (new Set(values).size !== values.length) throw new ApplicationFault("DUPLICATE_IDENTIFIER", subject);
}
export function applicationRequire(condition: unknown, message: string, code = "DANGLING_REFERENCE"): asserts condition {
  if (!condition) throw new ApplicationFault(code, message);
}
export function applicationValueType(value: ApplicationValue): ApplicationValueType {
  if (typeof value === "string") return "text";
  if (typeof value === "boolean") return "boolean";
  if (!("kind" in value)) return "reference";
  switch (value.kind) {
    case "UNKNOWN": return "UNKNOWN";
    case "QUANTITY": return "quantity";
    case "QUANTITY_LIST": return "quantity-list";
    case "EVIDENCE": return "evidence";
    case "RELATION": return "relation";
  }
}
export function applicationCompatible(a: ApplicationValueType, b: ApplicationValueType): boolean {
  return a === b || a === "UNKNOWN" || b === "UNKNOWN" ||
    (a === "enum" && b === "text") || (a === "text" && b === "enum");
}
export function validateApplicationModel(model: ApplicationModel): void {
  for (const [name, values] of Object.entries({
    currencies: model.currencies, units: model.units, timeModes: model.timeModes, accountingBases: model.accountingBases,
    roles: model.roles.map(r => r.id), canonicalRoles: model.roles.map(r => r.canonicalRole),
    entities: model.entities.map(e => e.id),
  })) applicationUnique(values, name);
  for (const entity of model.entities) {
    applicationUnique(entity.fields.map(f => f.id), `${entity.id} fields`);
    applicationUnique(entity.states, `${entity.id} states`);
    applicationRequire(entity.states.includes(entity.initialState), "Unknown initial state");
    for (const field of entity.fields) {
      if (field.type === "enum") applicationUnique(field.options, `${field.id} enum options`);
      if (field.type === "relation") applicationRequire(model.entities.some(e => e.id === field.entityId), "Unknown related entity");
    }
  }
}
export function validateApplicationValue(model: ApplicationModel, field: ApplicationField, value: ApplicationValue): void {
  const type = applicationValueType(value);
  if (type === "UNKNOWN") {
    applicationRequire(field.allowUnknown, `${field.id} does not permit UNKNOWN`, "UNKNOWN_NOT_ALLOWED"); return;
  }
  applicationRequire(applicationCompatible(field.type, type), `${field.id} has wrong value type`, "INVALID_FIELD_VALUE");
  if (field.type === "text" && typeof value === "string")
    applicationRequire(value.length <= field.maxLength, `${field.id} is too long`, "INVALID_FIELD_VALUE");
  if (field.type === "enum")
    applicationRequire(typeof value === "string" && field.options.includes(value), `${field.id} enum mismatch`, "INVALID_FIELD_VALUE");
  if (typeof value !== "object" || !("kind" in value)) return;
  if (value.kind === "RELATION")
    applicationRequire(field.type === "relation" && field.entityId === value.entityId, "Relation entity mismatch", "INVALID_RELATION");
  const quantities = value.kind === "QUANTITY" ? [value] : value.kind === "QUANTITY_LIST" ? value.entries : [];
  for (const q of quantities) {
    applicationRequire(model.currencies.includes(q.currency), "Unsupported currency", "UNSUPPORTED_CURRENCY");
    applicationRequire(model.units.includes(q.units) && model.timeModes.includes(q.time.kind) &&
      model.accountingBases.includes(q.accountingBasis), "Unsupported quantity dimensions", "UNSUPPORTED_DIMENSIONS");
  }
}
/** Call after the JSON boundary. Classifies malformed numeric data without ever coercing it. */
export function validateApplicationRawQuantities(model: ApplicationModel, entityId: string, input: unknown): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return;
  const entity = model.entities.find(e => e.id === entityId);
  if (!entity) return;
  const raw = input as Record<string, unknown>;
  for (const field of entity.fields) {
    if ((field.type !== "quantity" && field.type !== "quantity-list") || !Object.hasOwn(raw, field.id)) continue;
    const value = raw[field.id];
    if (ApplicationUnknownSchema.safeParse(value).success) continue;
    const schema = field.type === "quantity" ? ApplicationQuantitySchema : ApplicationQuantityListSchema;
    applicationRequire(schema.safeParse(value).success, `Malformed exact quantity field ${field.id}`, "INVALID_QUANTITY");
  }
}
export function validateValuesAgainstModel(model: ApplicationModel, entityId: string, input: unknown, partial = false): ApplicationValues {
  assertApplicationData(input, 128 * 1024);
  validateApplicationRawQuantities(model, entityId, input);
  const values = parseApplicationData(ApplicationValuesSchema, input, 128 * 1024);
  const entity = model.entities.find(e => e.id === entityId);
  applicationRequire(entity, `Unknown entity ${entityId}`);
  for (const [key, value] of Object.entries(values)) {
    const field = entity.fields.find(f => f.id === key);
    applicationRequire(field, `Unrecognized field ${key}`, "UNRECOGNIZED_FIELD");
    validateApplicationValue(model, field, value);
  }
  if (!partial) for (const f of entity.fields)
    applicationRequire(!f.required || Object.hasOwn(values, f.id), `Missing required field ${f.id}`, "MISSING_REQUIRED_FIELD");
  return values;
}
export function applicationExpressionType(
  expression: ApplicationExpression, model: ApplicationModel, entity: ApplicationEntity,
  inputFields: readonly string[], depth = 0, count = { n: 0 },
): ApplicationValueType {
  applicationRequire(depth <= APPLICATION_LIMITS.expressionDepth && ++count.n <= APPLICATION_LIMITS.expressionInstructions,
    "Expression exceeds bounds", "RESOURCE_BOUND");
  const child = (e: ApplicationExpression) => applicationExpressionType(e, model, entity, inputFields, depth + 1, count);
  const boolean = (t: ApplicationValueType) => applicationRequire(t === "boolean" || t === "UNKNOWN", "Expected predicate", "EXPRESSION_TYPE");
  switch (expression.op) {
    case "literal": {
      const t = applicationValueType(expression.value);
      if (t === "quantity" || t === "quantity-list" || t === "relation") {
        const f = t === "relation"
          ? { id: "Literal", title: "Literal", type: "relation" as const, required: true, allowUnknown: true,
              entityId: (expression.value as z.infer<typeof ApplicationRelationSchema>).entityId }
          : { id: "Literal", title: "Literal", type: t, required: true, allowUnknown: true };
        validateApplicationValue(model, f, expression.value);
        if (f.type === "relation") applicationRequire(model.entities.some(e => e.id === f.entityId), "Unknown relation entity");
      }
      return t;
    }
    case "field": {
      const f = entity.fields.find(f => f.id === expression.field);
      applicationRequire(f && (expression.source !== "input" || inputFields.includes(f.id)), "Unknown or unscoped field");
      return f.type;
    }
    case "state": applicationRequire(entity.states.includes(expression.is), "Unknown state"); return "boolean";
    case "all": case "any": expression.args.forEach(e => boolean(child(e))); return "boolean";
    case "not": boolean(child(expression.value)); return "boolean";
    case "known": child(expression.value); return "boolean";
    case "sum": applicationRequire(child(expression.value) === "quantity-list", "Sum requires quantity-list", "EXPRESSION_TYPE"); return "quantity";
    case "current-evidence": applicationRequire(child(expression.value) === "evidence", "Expected evidence", "EXPRESSION_TYPE"); return "boolean";
    case "currency-threshold":
      applicationRequire(child(expression.value) === "quantity", "Expected quantity", "EXPRESSION_TYPE");
      applicationUnique(expression.thresholds.map(t => t.currency), "Threshold currencies");
      expression.thresholds.forEach(t => applicationRequire(model.currencies.includes(t.currency) &&
        model.units.includes(t.units) && model.accountingBases.includes(t.accountingBasis) && model.timeModes.includes(t.timeMode),
      "Unknown threshold dimension"));
      return "boolean";
    case "compare": case "same-quantity":
      applicationRequire(child(expression.left) === "quantity" && child(expression.right) === "quantity", "Expected quantities", "EXPRESSION_TYPE");
      return "boolean";
    case "difference":
      applicationRequire(child(expression.left) === "quantity" && child(expression.right) === "quantity", "Expected dimensional quantities", "EXPRESSION_TYPE");
      return "text";
    case "equal":
      applicationRequire(applicationCompatible(child(expression.left), child(expression.right)), "Equality type mismatch", "EXPRESSION_TYPE");
      return "boolean";
  }
}
/** Structural and reference validation only; no decision interpreter or acceptance success is run here. */
export function parseBusinessSpecification(value: unknown): BusinessSpecification {
  const spec = parseApplicationData(BusinessSpecificationSchema, value);
  validateApplicationModel(spec.model);
  const requirements = spec.requirements.map(r => r.id);
  applicationUnique(requirements, "Requirements");
  const refs = (ids: string[]) => { applicationUnique(ids, "Requirement references");
    ids.forEach(id => applicationRequire(requirements.includes(id), `Unknown requirement ${id}`)); };
  refs(spec.unresolvedCriticalRequirementIds);
  spec.unresolvedCriticalRequirementIds.forEach(id =>
    applicationRequire(spec.requirements.some(r => r.id === id && r.critical), "Unresolved requirement is not critical"));
  applicationUnique(spec.actions.map(a => a.id), "Actions");
  applicationUnique(spec.invariants.map(i => i.id), "Invariants");
  applicationUnique(spec.acceptanceCases.map(c => c.id), "Acceptance cases");
  for (const action of spec.actions) {
    const entity = spec.model.entities.find(e => e.id === action.entityId);
    applicationRequire(entity, "Unknown action entity"); refs(action.requirementIds);
    applicationUnique(action.fromStates, "Action states"); applicationUnique(action.roles, "Action roles");
    applicationUnique(action.inputFields, "Action input fields"); applicationUnique(action.assignments.map(a => a.field), "Assignments");
    applicationUnique(action.guards.map(g => g.id), "Guards");
    applicationRequire(entity.states.includes(action.toState) && action.fromStates.every(s => entity.states.includes(s)), "Unknown transition state");
    applicationRequire(action.kind === "create" ? action.fromStates.length === 0 && action.toState === entity.initialState :
      action.fromStates.length > 0, "Invalid creation/transition states", "INVALID_ACTION");
    applicationRequire(action.kind !== "update" || action.toState === entity.initialState, "Updates must reset initial state", "INVALID_ACTION");
    action.roles.forEach(r => applicationRequire(spec.model.roles.some(role => role.id === r), "Unknown role"));
    action.inputFields.forEach(f => applicationRequire(entity.fields.some(field => field.id === f), "Unknown input field"));
    const type = (e: ApplicationExpression) => applicationExpressionType(e, spec.model, entity, action.inputFields);
    for (const assignment of action.assignments) {
      const f = entity.fields.find(f => f.id === assignment.field); applicationRequire(f, "Unknown assignment field");
      applicationRequire(applicationCompatible(f.type, type(assignment.value)), "Assignment type mismatch", "EXPRESSION_TYPE");
      if (assignment.value.op === "literal") validateApplicationValue(spec.model, f, assignment.value.value);
    }
    for (const guard of action.guards) { refs(guard.requirementIds);
      applicationRequire(type(guard.condition) === "boolean", "Guard is not boolean", "EXPRESSION_TYPE"); }
    if (action.approval) {
      applicationUnique(action.approval.requirements.map(r => r.role), "Approval roles");
      for (const r of action.approval.requirements) {
        applicationRequire(action.roles.includes(r.role), "Approval role must be an action role");
        applicationRequire(type(r.when) === "boolean", "Approval condition is not boolean", "EXPRESSION_TYPE");
      }
    }
    if (action.approval || action.requiresApprovalsFrom || action.preparedEffect)
      applicationRequire(action.kind === "transition" && !action.inputFields.length && !action.assignments.length,
        "Approval/effect transitions cannot change business content", "INVALID_ACTION");
    applicationRequire(!(action.approval && action.requiresApprovalsFrom), "Ambiguous approval policy", "INVALID_ACTION");
    if (action.requiresApprovalsFrom) applicationRequire(spec.actions.some(a =>
      a.id === action.requiresApprovalsFrom && a.entityId === entity.id && a.approval), "Unknown approval policy");
    if (action.preparedEffect) {
      applicationUnique(action.preparedEffect.fields, "Prepared effect fields");
      action.preparedEffect.fields.forEach(f => applicationRequire(entity.fields.some(v => v.id === f), "Unknown effect field"));
    }
  }
  for (const invariant of spec.invariants) {
    refs(invariant.requirementIds);
    const entity = spec.model.entities.find(e => e.id === invariant.entityId); applicationRequire(entity, "Unknown invariant entity");
    applicationRequire(applicationExpressionType(invariant.condition, spec.model, entity, []) === "boolean",
      "Invariant is not boolean", "EXPRESSION_TYPE");
  }
  for (const c of spec.acceptanceCases) {
    refs(c.requirementIds);
    const action = spec.actions.find(a => a.id === c.input.actionId && a.entityId === c.input.entityId);
    applicationRequire(action, "Unknown acceptance action");
    if (c.expected.nextState) applicationRequire(spec.model.entities.find(e => e.id === action.entityId)?.states.includes(c.expected.nextState),
      "Unknown expected state");
    // Case inputs may intentionally be invalid business values/roles/states; do not turn negative cases into positives.
  }
  return spec;
}
export function validateRecordValues(specification: BusinessSpecification, entityId: string, values: unknown): ApplicationValues {
  const spec = parseBusinessSpecification(specification);
  return validateValuesAgainstModel(spec.model, entityId, values);
}
export type ApplicationCanonicalReference = VReference;
