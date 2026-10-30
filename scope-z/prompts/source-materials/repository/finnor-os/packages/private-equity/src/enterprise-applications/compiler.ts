import {
  APPLICATION_PROFILE, APPLICATION_LIMITS, ApplicationFault, applicationCanonical,
  applicationDigest, applicationBytesDigest, parseBusinessSpecification,
  type BusinessSpecification, type ApplicationExpression, type ApplicationField,
} from "./contracts";
import {
  validateProgram, type ApplicationProgram, type ApplicationInstruction, type CompiledApplicationAction,
} from "./program";

export interface ApplicationSourceAsset {
  path: string;
  language: "json" | "html";
  /** Exact UTF-8 source content, not a file path or executable module. */
  bytes: string;
  digest: string;
}
export interface ApplicationFrontend {
  schema: "finnor.enterprise-application.forms.v1";
  renderer: "FINNOR_HOST_TYPED_FORMS_V1";
  entities: {
    entityId: string; title: string; states: string[]; initialState: string;
    fields: (ApplicationField & { encoding: "text" | "boolean" | "json"; unknownEncoding: "EXPLICIT_UNKNOWN_WITH_REASON" })[];
    actions: { id: string; title: string; kind: "create" | "update" | "transition";
      inputFields: string[]; fromStates: string[]; toState: string; roles: string[] }[];
    assetPath: string;
  }[];
}
export interface ApplicationDependencyManifest {
  schema: "finnor.enterprise-application.dependencies.v1";
  profile: typeof APPLICATION_PROFILE;
  kernel: "x3-stack-v1";
  runtime: "FINNOR_API_NODE_22";
  decimal: "NONNEGATIVE_PRECISION_38_SCALE_12_BIGINT_V1";
  hostContracts: readonly [
    "CANONICAL_VREFERENCE_V1", "CANONICAL_ROLE_AUTHORITY_CURRENT_AT_COMMIT",
    "HOST_EVIDENCE_CURRENTNESS", "HOST_SCOPED_RELATION_RESOLUTION",
    "INSTALLED_RELEASE_AND_RECORD_CAS", "DURABLE_APPROVAL_RECEIPTS",
    "S4_PREPARED_INTENT_NO_DISPATCH", "FINNOR_HOST_TYPED_FORMS_V1",
  ];
  executableGuestDependencies: readonly [];
  /** These logical requirements are NOT exact source/lock/runtime receipts or compatibility success. */
  exactHostReceiptsRequired: true;
}
export interface BuiltApplication {
  program: ApplicationProgram;
  sources: ApplicationSourceAsset[];
  frontend: ApplicationFrontend;
  dependencyManifest: ApplicationDependencyManifest;
  digest: string;
}

function instructions(expression: ApplicationExpression): ApplicationInstruction[] {
  switch (expression.op) {
    case "literal": return [{ op: "PUSH", value: expression.value }];
    case "field": return [{ op: "LOAD", source: expression.source, field: expression.field }];
    case "state": return [{ op: "STATE", is: expression.is }];
    case "sum": return [...instructions(expression.value), { op: "SUM" }];
    case "known": return [...instructions(expression.value), { op: "KNOWN" }];
    case "current-evidence": return [...instructions(expression.value), { op: "CURRENT_EVIDENCE" }];
    case "not": return [...instructions(expression.value), { op: "NOT" }];
    case "equal": case "same-quantity": case "difference": return [
      ...instructions(expression.left), ...instructions(expression.right),
      { op: expression.op === "equal" ? "EQUAL" : expression.op==="difference"?"DIFFERENCE":"SAME_QUANTITY" },
    ];
    case "compare": return [...instructions(expression.left), ...instructions(expression.right),
      { op: "COMPARE", comparison: expression.comparison }];
    case "currency-threshold": return [...instructions(expression.value),
      { op: "CURRENCY_THRESHOLD", comparison: expression.comparison, thresholds: expression.thresholds }];
    case "all": case "any": return [
      ...expression.args.flatMap(instructions), { op: expression.op === "all" ? "ALL" : "ANY", count: expression.args.length },
    ];
  }
}
function compileAction(action: BusinessSpecification["actions"][number]): CompiledApplicationAction {
  const { assignments, guards, approval, ...header } = action;
  return {
    ...header,
    assignments: assignments.map(({ field, value }) => ({ field, code: instructions(value) })),
    guards: guards.map(({ condition, ...guard }) => ({ ...guard, code: instructions(condition) })),
    ...(approval ? { approval: {
      ...approval, requirements: approval.requirements.map(({ role, when }) => ({ role, code: instructions(when) })),
    } } : {}),
  };
}
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function fieldControl(field: ApplicationField, actionId: string): string {
  const id = escapeHtml(`${actionId}--${field.id}`), name = escapeHtml(field.id);
  const title = escapeHtml(field.title), required = field.required ? " required" : "";
  let control: string;
  if (field.type === "text")
    control = `<input id="${id}" name="${name}" type="text" maxlength="${field.maxLength}"${required}>`;
  else if (field.type === "boolean")
    control = `<select id="${id}" name="${name}"${required}><option value="">Choose explicitly</option>` +
      `<option value="true">True</option><option value="false">False</option></select>`;
  else if (field.type === "enum")
    control = `<select id="${id}" name="${name}"${required}><option value="">Choose explicitly</option>` +
      field.options.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("") + "</select>";
  else control = `<textarea id="${id}" name="${name}" data-encoding="json" spellcheck="false"${required}></textarea>`;
  return `<label for="${id}">${title}</label>${control}` +
    (field.allowUnknown ? `<p data-unknown-field="${id}">UNKNOWN requires an explicit reason; blank is not zero or UNKNOWN.</p>` : "");
}
function entityHtml(entity: ApplicationFrontend["entities"][number]): string {
  return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'\">" +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(entity.title)}</title></head><body>` +
    `<main data-finnor-typed-form="v1" data-entity="${escapeHtml(entity.entityId)}"><h1>${escapeHtml(entity.title)}</h1>` +
    "<p>Hosted FINNOR controls supply authenticated actions and currentness. This inert preview cannot submit or execute effects.</p>" +
    entity.actions.map(action => `<section><h2>${escapeHtml(action.title)}</h2>` +
      `<form data-action="${escapeHtml(action.id)}" data-kind="${action.kind}">` +
      action.inputFields.map(id => fieldControl(entity.fields.find(f => f.id === id)!, action.id)).join("") +
      `<button type="button" data-finnor-command="${escapeHtml(action.id)}">${escapeHtml(action.title)}</button></form></section>`).join("") +
    "<section><h2>Record schema</h2><dl>" + entity.fields.map(f =>
      `<dt>${escapeHtml(f.title)}</dt><dd>${f.type}${f.required ? "; required" : "; optional"}${f.allowUnknown ? "; explicit UNKNOWN permitted" : ""}</dd>`).join("") +
    "</dl></section><output data-finnor-decision aria-live=\"polite\"></output></main></body></html>";
}
/** Produces executable typed instructions and host-renderable forms, never a build/check/admission receipt.
 * Acceptance literals remain specification inputs for an independent checker; they do not choose code. */
export function compileApplication(input: BusinessSpecification | unknown): BuiltApplication {
  const started = performance.now(), spec = parseBusinessSpecification(input);
  if (spec.unresolvedCriticalRequirementIds.length)
    throw new ApplicationFault("UNRESOLVED_CRITICAL_REQUIREMENTS", spec.unresolvedCriticalRequirementIds.join(", "));
  const program = validateProgram({
    schema: "finnor.enterprise-application.program.v1", profile: APPLICATION_PROFILE, kernelVersion: "x3-stack-v1",
    specificationDigest: applicationDigest(spec),
    identity: { id: spec.id, version: spec.version, title: spec.title, owner: spec.owner },
    model: spec.model, requirements: spec.requirements, actions: spec.actions.map(compileAction),
    invariants: spec.invariants.map(({ condition, ...invariant }) => ({ ...invariant, code: instructions(condition) })),
  });
  const frontend: ApplicationFrontend = {
    schema: "finnor.enterprise-application.forms.v1", renderer: "FINNOR_HOST_TYPED_FORMS_V1",
    entities: spec.model.entities.map(entity => ({
      entityId: entity.id, title: entity.title, states: entity.states, initialState: entity.initialState,
      fields: entity.fields.map(field => ({ ...field,
        encoding: field.type === "text" || field.type === "enum" ? "text" : field.type === "boolean" ? "boolean" : "json",
        unknownEncoding: "EXPLICIT_UNKNOWN_WITH_REASON",
      })),
      actions: spec.actions.filter(a => a.entityId === entity.id).map(a => ({
        id: a.id, title: a.title, kind: a.kind, inputFields: a.inputFields,
        fromStates: a.fromStates, toState: a.toState, roles: a.roles,
      })),
      assetPath: `forms/${encodeURIComponent(entity.id)}.html`,
    })),
  };
  const dependencyManifest: ApplicationDependencyManifest = {
    schema: "finnor.enterprise-application.dependencies.v1", profile: APPLICATION_PROFILE,
    kernel: "x3-stack-v1", runtime: "FINNOR_API_NODE_22", decimal: "NONNEGATIVE_PRECISION_38_SCALE_12_BIGINT_V1",
    hostContracts: [
      "CANONICAL_VREFERENCE_V1", "CANONICAL_ROLE_AUTHORITY_CURRENT_AT_COMMIT",
      "HOST_EVIDENCE_CURRENTNESS", "HOST_SCOPED_RELATION_RESOLUTION",
      "INSTALLED_RELEASE_AND_RECORD_CAS", "DURABLE_APPROVAL_RECEIPTS",
      "S4_PREPARED_INTENT_NO_DISPATCH", "FINNOR_HOST_TYPED_FORMS_V1",
    ], executableGuestDependencies: [], exactHostReceiptsRequired: true,
  };
  const source = (path: string, language: ApplicationSourceAsset["language"], bytes: string): ApplicationSourceAsset =>
    ({ path, language, bytes, digest: applicationBytesDigest(bytes) });
  const sources = [
    source("backend/program.json", "json", applicationCanonical(program)),
    source("frontend/forms.json", "json", applicationCanonical(frontend)),
    source("dependencies.json", "json", applicationCanonical(dependencyManifest)),
    ...frontend.entities.map(e => source(e.assetPath, "html", entityHtml(e))),
  ];
  if (Buffer.byteLength(applicationCanonical({ program, sources, frontend, dependencyManifest }), "utf8") > APPLICATION_LIMITS.assetBytes)
    throw new ApplicationFault("RESOURCE_BOUND", "Generated application exceeds the 4 MiB allocation");
  if (performance.now() - started > 30000) throw new ApplicationFault("BUILD_DEADLINE", "Compiler exceeded its 30-second computation bound");
  return { program, sources, frontend, dependencyManifest, digest: applicationDigest({ program, sources, frontend, dependencyManifest }) };
}

// Stable host-facing entry point; the independent checker must implement its own spec interpreter.
export {
  parseBusinessSpecification, validateRecordValues, BusinessSpecificationSchema, ApplicationFault,
  applicationCanonical, applicationDigest, applicationBytesDigest,
} from "./contracts";
export type {
  BusinessSpecification, ApplicationExecutionContext, ApplicationValue, ApplicationValues,
  ApplicationExpression, ApplicationQuantity, ApplicationEvidence, ApplicationApprovalReceipt,
} from "./contracts";
export { validateProgram, runApplicationProgram } from "./program";
export type {
  ApplicationProgram, ActionDecision, ApplicationApprovalDecision, ApplicationPreparedEffectIntent,
} from "./program";
