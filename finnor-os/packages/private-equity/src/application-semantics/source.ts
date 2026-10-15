import type {
  ApplicationField, ApplicationParameter, ApplicationScalar, ApplicationSnapshot, ApplicationState,
  ApplicationStructuralWitness, ExactApplicationQuantity, ExperimentRef, ScopedApplicationIdentity,
} from "@finnor/shared-types";
import {
  ApplicationComputerProvider, ApplicationProviderFault, applicationByteDigest,
  applicationContentRef, applicationProviderFault, applicationResourcePath,
  type ApplicationComputerSession, type ApplicationDocument, type ApplicationDocumentForm,
  type ApplicationFormControl, type ApplicationPublicSource,
  type ApplicationSessionOptions,
} from "../../../computer/src/application-provider";
import type {
  ApplicationPhysicalEgressFence, AuthorizedApplicationProfile, DescribedApplicationOperation,
  NativeApplicationRequestIdentity, PreparedApplicationWire, PrivateApplicationBinding,
} from "./ports";
import {
  ApplicationFieldSchema, ApplicationParameterSchema, ApplicationSnapshotSchema,
  ExactApplicationQuantitySchema, ScopedApplicationIdentitySchema, X2_LIMITS, boundedX2, x2Digest,
} from "./contracts";
import { projectApplicationSnapshot } from "./observation";

/**
 * A structural source, not a business/transition planner. Operation signatures
 * are observations; neither verbs, labels nor OpenAPI responses establish
 * guards, effects, authorization, durable completion or model admission.
 *
 * Frozen before code: partial quantities, schema cycles/unknown unions, opaque
 * reads, scope/revision drift, bounds, metadata literals, implicit browser
 * requests and reused/late wire permits must not become successful evidence.
 */
type ObjectValue = Record<string, unknown>;
interface FieldSpec { path: string; kind: ApplicationField["kind"]; nullable: boolean; schema: ObjectValue | null; presence: boolean }
interface Lowering {
  parameter: ApplicationParameter;
  path: string[];
  schema: ObjectValue | null;
  quantityNames: Record<string, string> | null;
  control: ApplicationFormControl | null;
}
interface FormSlots {
  context: ApplicationFormControl;
  request: ApplicationFormControl;
  version: ApplicationFormControl;
  secrets: ApplicationFormControl[];
}
interface ContextObservation {
  body: ObjectValue;
  binding: ObjectValue;
  refs: ExperimentRef[];
  entities: Map<string, string>;
  permissions: string[] | null;
  deadline: string | null;
}
interface Capture {
  raw: ObjectValue;
  context: ContextObservation;
  source: ApplicationPublicSource;
  document: ApplicationDocument | null;
}
interface Candidate {
  operation: DescribedApplicationOperation;
  binding: PrivateApplicationBinding;
  lowerings: Lowering[];
  slots: FormSlots | null;
  document: ApplicationDocument | null;
  form: ApplicationDocumentForm | null;
}
interface DocumentSchema { source: ApplicationPublicSource; document: ObjectValue; recordSchema: ObjectValue | null }
interface PreparedRecord {
  target: ScopedApplicationIdentity;
  operationId: string;
  scopeDigest: string;
  recordRevision: string;
  semanticDigest: string;
}
export interface UnsupportedApplicationStructure {
  disposition: "UNSUPPORTED";
  code: string;
  sourceRef: ExperimentRef | null;
  location: string;
}

const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const pointer = (path: readonly string[]) => `/${path.map((key) => key.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
const fieldName = (name: string): string => {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(name) || name.split(".").some((key) => forbidden.has(key))) {
    return applicationProviderFault("X2_UNSUPPORTED_FIELD_NAME");
  }
  return name;
};
const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return applicationProviderFault("X2_UNSUPPORTED_OBJECT_SHAPE");
  return value as ObjectValue;
};
const maybeObject = (value: unknown): ObjectValue | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
const strings = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string") || value.length > 32) {
    return applicationProviderFault("X2_UNSUPPORTED_STRING_DOMAIN");
  }
  return value as string[];
};
const stringValue = (value: unknown): string => {
  if (typeof value !== "string" || !value || value.length > X2_LIMITS.maxTextLength) {
    return applicationProviderFault("X2_UNSUPPORTED_TEXT_VALUE");
  }
  return value;
};
const json = (text: string): unknown => {
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch { return applicationProviderFault("X2_UNSUPPORTED_JSON_SOURCE"); }
  boundedX2(value, X2_LIMITS.maxSourceBytes);
  return value;
};
const nullableSchema = (input: ObjectValue): { schema: ObjectValue; nullable: boolean } => {
  let schema = input;
  let nullable = false;
  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter((type) => type !== "null");
    nullable = schema.type.includes("null");
    if (nonNull.length !== 1 || typeof nonNull[0] !== "string") applicationProviderFault("X2_UNSUPPORTED_SCHEMA_UNION");
    schema = { ...schema, type: nonNull[0] };
  }
  for (const keyword of ["anyOf", "oneOf"]) {
    if (schema[keyword] !== undefined) {
      if (!Array.isArray(schema[keyword])) applicationProviderFault("X2_UNSUPPORTED_SCHEMA_UNION");
      const variants = schema[keyword] as unknown[];
      const other = variants.filter((variant) => maybeObject(variant)?.type !== "null");
      nullable ||= other.length !== variants.length;
      if (other.length !== 1) applicationProviderFault("X2_UNSUPPORTED_SCHEMA_UNION");
      schema = { ...schema, ...object(other[0]) };
      delete schema[keyword];
    }
  }
  return { schema, nullable };
};
const getPath = (value: unknown, path: readonly string[], schema: ObjectValue | null = null): { available: boolean; value: unknown } => {
  let current = value;
  let definition = schema;
  for (const key of path) {
    // A present null parent is observed absence, not an inaccessible child.
    if (current === null) return { available: true, value: null };
    const container = maybeObject(current);
    const type = definition ? nullableSchema(definition).schema : null;
    const properties = type?.type === "object" ? maybeObject(type.properties) : null;
    if (!container || !Object.hasOwn(container, key)) {
      // Coverage is checked separately. Only a declared optional property
      // permits absent children, never a missing required/unknown field.
      if (container && properties && Object.hasOwn(properties, key)
        && !strings(type?.required ?? []).includes(key)) return { available: true, value: null };
      return { available: false, value: undefined };
    }
    current = container[key];
    definition = properties ? maybeObject(properties[key]) : null;
  }
  return { available: true, value: current };
};
const putPath = (root: ObjectValue, path: readonly string[], value: unknown): void => {
  let at = root;
  for (let index = 0; index < path.length - 1; index++) {
    const key = path[index]!;
    if (forbidden.has(key)) applicationProviderFault("X2_UNSAFE_LOWERING_KEY");
    at[key] ??= {};
    at = object(at[key]);
  }
  const last = path.at(-1);
  if (!last || forbidden.has(last)) applicationProviderFault("X2_UNSAFE_LOWERING_KEY");
  at[last] = value;
};
const unique = <T>(values: T[]): T[] => {
  const seen = new Set<string>();
  return values.filter((value) => { const key = x2Digest(value); if (seen.has(key)) return false; seen.add(key); return true; });
};

// Metadata belongs to the private envelope/readback, not demonstration literals.
// This is a syntactic exclusion, not a map of business fields or transitions.
const metadata = (name: string) =>
  ["context", "request", "expectedVersion", "observation", "idempotencyKey"].includes(name)
  || ["applicationId", "accountId", "recordId", "principalId", "grantId", "effectId", "obligationId", "parentId"].includes(name)
  || /(?:Revision|Version|Digest|At)$/.test(name) || ["revision", "version", "deadline"].includes(name)
  || /(?:csrf|password|session|token|nonce)/i.test(name);
const requestKeys = ["requestId", "effectId", "obligationId", "idempotencyKey", "parentId", "deadline"] as const;
const contextKeys = ["applicationId", "accountId", "recordId", "principalId", "grantId", "applicationVersion",
  "schemaRevision", "semanticRevision", "renderingRevision", "authorityRevision", "grantRevision"] as const;
const revisionKeys = ["applicationVersion", "schemaRevision", "semanticRevision", "renderingRevision",
  "authorityRevision", "grantRevision"] as const;
const hasKeys = (value: unknown, keys: readonly string[]): boolean => {
  const record = maybeObject(value);
  return !!record && keys.every((key) => Object.hasOwn(record, key));
};
const dimensions = ["amount", "currency", "entity", "unit", "date", "basis"] as const;
const coreDimensions = ["decimal", "currency", "entity", "unit", "time", "basis"] as const;
const incompleteQuantity = (value: unknown): boolean => {
  const record = maybeObject(value);
  return !!record && (Object.hasOwn(record, "amount") || Object.hasOwn(record, "decimal"))
    && ["currency", "entity", "unit", "date", "time", "basis"].some((key) => Object.hasOwn(record, key));
};
const quantityShape = (value: unknown): "dto" | "core" | null => {
  const record = maybeObject(value);
  if (!record) return null;
  if (dimensions.every((key) => Object.hasOwn(record, key)) && Object.keys(record).length === 6) return "dto";
  if (coreDimensions.every((key) => Object.hasOwn(record, key)) && record.kind === "quantity"
    && Object.keys(record).length === 7) return "core";
  return null;
};
const quantity = (value: unknown): ExactApplicationQuantity => {
  const record = object(value);
  const shape = quantityShape(record);
  if (!shape) return applicationProviderFault("X2_UNSUPPORTED_INCOMPLETE_QUANTITY");
  const result = shape === "core" ? record : {
    kind: "quantity", decimal: record.amount, currency: record.currency, entity: record.entity,
    unit: record.unit, time: record.date, basis: record.basis,
  };
  const parsed = ExactApplicationQuantitySchema.safeParse(result);
  if (!parsed.success) return applicationProviderFault("X2_UNSUPPORTED_EXACT_QUANTITY");
  return parsed.data;
};
const schemaQuantityShape = (input: ObjectValue): "dto" | "core" | null => {
  const properties = maybeObject(input.properties);
  if (!properties) return null;
  const keys = Object.keys(properties);
  const required = input.required === undefined ? [] : strings(input.required);
  for (const [kind, shape] of [["dto", dimensions], ["core", coreDimensions]] as const) {
    if (shape.every((key) => keys.includes(key) && required.includes(key))
      && keys.length === shape.length + (kind === "core" ? 1 : 0)
      && shape.every((key) => nullableSchema(object(properties[key])).schema.type === "string")
      && (kind !== "core" || object(properties.kind).const === "quantity"
        || Array.isArray(object(properties.kind).enum)
          && x2Digest(object(properties.kind).enum) === x2Digest(["quantity"]))) return kind;
  }
  return null;
};

/** Local JSON Schema references only. No remote resolver, annotations, defaults,
 * examples, locator code or transition descriptions are executable input. */
function resolveSchema(input: unknown, document: ObjectValue, stack: string[] = [], depth = 0): ObjectValue {
  if (depth > 32) return applicationProviderFault("X2_SCHEMA_DEPTH_BOUND");
  let schema = object(input);
  if (schema.$ref !== undefined) {
    const ref = stringValue(schema.$ref);
    if (!ref.startsWith("#/") || stack.includes(ref)) return applicationProviderFault("X2_UNSUPPORTED_SCHEMA_REFERENCE");
    const path = ref.slice(2).split("/").map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"));
    if (path.some((key) => forbidden.has(key))) return applicationProviderFault("X2_UNSAFE_SCHEMA_REFERENCE");
    const found = getPath(document, path);
    if (!found.available) return applicationProviderFault("X2_SCHEMA_REFERENCE_MISSING");
    const siblings = { ...schema };
    delete siblings.$ref;
    schema = { ...resolveSchema(found.value, document, [...stack, ref], depth + 1), ...siblings };
  }
  const result: ObjectValue = {};
  for (const [key, value] of Object.entries(schema)) {
    if (forbidden.has(key)) return applicationProviderFault("X2_UNSAFE_SCHEMA_KEY");
    if (["description", "title", "example", "examples", "default", "$id", "$schema", "deprecated"].includes(key)) continue;
    if (!["type", "enum", "const", "properties", "required", "additionalProperties", "items",
      "anyOf", "oneOf", "allOf", "pattern", "format", "minLength", "maxLength", "minimum", "maximum"].includes(key)) {
      return applicationProviderFault("X2_UNSUPPORTED_SCHEMA_KEYWORD");
    }
    if (["allOf", "oneOf", "anyOf"].includes(key)) {
      if (!Array.isArray(value) || value.length > 16) return applicationProviderFault("X2_SCHEMA_VARIANT_BOUND");
      result[key] = value.map((variant) => resolveSchema(variant, document, stack, depth + 1));
    } else if (key === "properties") {
      const properties = object(value);
      if (Object.keys(properties).length > 32) return applicationProviderFault("X2_SCHEMA_PROPERTY_BOUND");
      result.properties = Object.fromEntries(Object.entries(properties)
        .map(([name, child]) => [name, resolveSchema(child, document, stack, depth + 1)]));
    } else if (key === "items" || key === "additionalProperties" && typeof value === "object") {
      result[key] = resolveSchema(value, document, stack, depth + 1);
    } else result[key] = value;
  }
  if (result.allOf !== undefined) {
    const properties: ObjectValue = { ...maybeObject(result.properties) };
    const required = result.required === undefined ? [] : strings(result.required);
    for (const variant of result.allOf as ObjectValue[]) {
      if (variant.type !== "object" || variant.additionalProperties !== false) {
        return applicationProviderFault("X2_UNSUPPORTED_SCHEMA_INTERSECTION");
      }
      for (const [name, child] of Object.entries(object(variant.properties))) {
        if (properties[name] !== undefined && x2Digest(properties[name]) !== x2Digest(child)) {
          return applicationProviderFault("X2_AMBIGUOUS_SCHEMA_INTERSECTION");
        }
        properties[name] = child;
      }
      required.push(...strings(variant.required ?? []));
    }
    delete result.allOf;
    result.type = "object"; result.properties = properties;
    result.required = [...new Set(required)]; result.additionalProperties = false;
  }
  return result;
}

function validateSchema(value: unknown, input: ObjectValue, depth = 0): void {
  if (depth > 32) applicationProviderFault("X2_SCHEMA_DEPTH_BOUND");
  const { schema, nullable } = nullableSchema(input);
  if (value === null && nullable) return;
  if (schema.const !== undefined && x2Digest(value) !== x2Digest(schema.const)) applicationProviderFault("X2_PARAMETER_SCHEMA_MISMATCH");
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length > 32
      || !schema.enum.some((choice) => x2Digest(choice) === x2Digest(value))) {
      applicationProviderFault("X2_PARAMETER_SCHEMA_MISMATCH");
    }
  }
  if (schema.type === "object") {
    const record = object(value);
    const properties = object(schema.properties ?? {});
    for (const key of strings(schema.required ?? [])) {
      if (!Object.hasOwn(record, key)) applicationProviderFault("X2_REQUIRED_PARAMETER_MISSING");
    }
    for (const [key, child] of Object.entries(record)) {
      if (forbidden.has(key) || !properties[key]) applicationProviderFault("X2_UNKNOWN_PARAMETER_FIELD");
      validateSchema(child, object(properties[key]), depth + 1);
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") applicationProviderFault("X2_PARAMETER_TYPE_MISMATCH");
    if (value.length > (typeof schema.maxLength === "number" ? schema.maxLength : X2_LIMITS.maxTextLength)
      || value.length < (typeof schema.minLength === "number" ? schema.minLength : 0)) {
      applicationProviderFault("X2_PARAMETER_TEXT_BOUND");
    }
    if (schema.pattern !== undefined) {
      // Conservative regular-expression fragment; reject backreferences,
      // lookarounds and nested/grouped quantifiers rather than run untrusted code.
      const pattern = stringValue(schema.pattern);
      if (pattern.length > 256 || /\\[1-9]|\(\?/.test(pattern) || /\)[*+{]/.test(pattern)) {
        applicationProviderFault("X2_UNSUPPORTED_SCHEMA_PATTERN");
      }
      let expression: RegExp;
      try { expression = new RegExp(pattern, "u"); }
      catch { return applicationProviderFault("X2_UNSUPPORTED_SCHEMA_PATTERN"); }
      if (!expression.test(value)) applicationProviderFault("X2_PARAMETER_PATTERN_MISMATCH");
    }
    if (schema.format === "date") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
        || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
        applicationProviderFault("X2_PARAMETER_DATE_MISMATCH");
      }
    } else if (schema.format && schema.format !== "date-time") applicationProviderFault("X2_UNSUPPORTED_SCHEMA_FORMAT");
    if (schema.format === "date-time" && !Number.isFinite(Date.parse(value))) applicationProviderFault("X2_PARAMETER_DATE_MISMATCH");
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") applicationProviderFault("X2_PARAMETER_TYPE_MISMATCH");
  } else if (schema.type === "integer") {
    // Only private envelope concurrency/revision numbers reach this branch.
    if (typeof value !== "number" || !Number.isSafeInteger(value)
      || typeof schema.minimum === "number" && value < schema.minimum
      || typeof schema.maximum === "number" && value > schema.maximum) {
      applicationProviderFault("X2_PARAMETER_INTEGER_MISMATCH");
    }
  } else if (schema.type !== "null" || value !== null) applicationProviderFault("X2_UNSUPPORTED_SCHEMA_TYPE");
}

export class ApplicationSourceSession {
  private readonly profile: AuthorizedApplicationProfile;
  private readonly computer: ApplicationComputerSession;
  private readonly candidates = new Map<string, Candidate>();
  private readonly fields = new Map<string, ApplicationField>();
  private readonly nullFacts = new Map<string, ExperimentRef[]>();
  private fieldContract: ApplicationField[] | null = null;
  private readonly latestObservations = new Map<string, string>();
  private readonly prepared = new WeakMap<PreparedApplicationWire, PreparedRecord>();
  private readonly requestRecords = new Map<string, {
    identity: NativeApplicationRequestIdentity; target: ScopedApplicationIdentity; context: ObjectValue;
  }>();
  private readonly unsupportedKeys = new Set<string>();
  private schemas: DocumentSchema[] = [];
  private observerRef: ExperimentRef | null = null;
  private discovered = false;
  private discovering = false;
  private preparing = false;
  private observedApiCapture: { targetDigest: string; capture: Capture } | null = null;
  private closed = false;
  /** Main must retain these in the coverage/denominator. Supported output alone
   * is not complete acquisition or a qualification of an unknown structure. */
  readonly unsupported: UnsupportedApplicationStructure[] = [];

  constructor(
    profile: AuthorizedApplicationProfile,
    private readonly retain: (ref: ExperimentRef, body: unknown) => Promise<void>,
    options: ApplicationSessionOptions & { computerProvider?: ApplicationComputerProvider } = {},
  ) {
    this.profile = structuredClone(profile);
    this.computer = (options.computerProvider ?? new ApplicationComputerProvider()).createSession(this.profile, retain, options);
  }

  private gap(code: string, sourceRef: ExperimentRef | null, location: string): void {
    const entry: UnsupportedApplicationStructure = { disposition: "UNSUPPORTED", code, sourceRef, location };
    const key = x2Digest(entry);
    if (this.unsupportedKeys.has(key)) return;
    if (this.unsupported.length >= 256) applicationProviderFault("X2_UNSUPPORTED_STRUCTURE_BOUND");
    this.unsupportedKeys.add(key);
    this.unsupported.push(entry);
  }

  private assertOpen(): void {
    if (this.closed) applicationProviderFault("X2_APPLICATION_SOURCE_CLOSED");
    this.computer.assertCurrent();
  }
  private safeText(value: string): string {
    if (!value || value.length > 256 || /[\x00-\x1f]/.test(value)) applicationProviderFault("X2_UNSUPPORTED_DESCRIPTION");
    this.noCredentials(value);
    return value;
  }
  private noCredentials(value: unknown): void {
    const text = JSON.stringify(value);
    for (const header of Object.values(this.profile.credentials.headers)) {
      // Remote public grant identity is transport metadata, not an auth header
      // claim. Bearer/password material, including reflected tokens, is refused.
      const secret = /^Bearer /i.test(header) ? header.slice(7) : header;
      if (secret.length >= 16 && text.includes(secret) && header !== this.profile.grantRef.id
        && !Object.keys(this.profile.credentials.headers).some((key) =>
          /grant/i.test(key) && this.profile.credentials.headers[key] === header)) {
        applicationProviderFault("X2_CREDENTIAL_REFLECTION_REFUSED");
      }
    }
  }
  private template(path: string, target?: ScopedApplicationIdentity): string {
    let url: URL;
    try { url = new URL(path, this.profile.origin); }
    catch { return applicationProviderFault("X2_UNSUPPORTED_APPLICATION_ACTION"); }
    if (url.origin !== this.profile.origin || url.search || url.hash || url.username || url.password) {
      applicationProviderFault("X2_APPLICATION_ACTION_ORIGIN_FENCE");
    }
    return url.pathname.split("/").map((segment) => {
      let decoded: string;
      try { decoded = decodeURIComponent(segment); }
      catch { return applicationProviderFault("X2_UNSUPPORTED_APPLICATION_ACTION"); }
      if (decoded === this.profile.account) return "{accountId}";
      if (target && decoded === target.id) return "{recordId}";
      return segment.replaceAll("%7B", "{").replaceAll("%7D", "}");
    }).join("/").replace(/\{account\}/g, "{accountId}").replace(/\{record\}/g, "{recordId}")
      .replace(/\{request\}/g, "{requestId}");
  }

  private async documents(): Promise<DocumentSchema[]> {
    const sources = await this.computer.documentation();
    const documents: DocumentSchema[] = [];
    for (const source of sources) {
      if (source.status !== 200) { this.gap("X2_DOCUMENTATION_UNAVAILABLE", source.ref, "documentation"); continue; }
      if (!source.contentType?.includes("json")) { this.gap("X2_UNSUPPORTED_DOCUMENTATION_FORMAT", source.ref, "documentation"); continue; }
      const document = object(json(source.text));
      if (document.openapi !== "3.1.0" && document.openapi !== "3.1.1") {
        this.gap("X2_UNSUPPORTED_OPENAPI_VERSION", source.ref, "openapi"); continue;
      }
      const paths = object(document.paths);
      if (Object.keys(paths).length > 64) applicationProviderFault("X2_SCHEMA_PATH_BOUND");
      let recordSchema: ObjectValue | null = null;
      for (const [path, item] of Object.entries(paths)) {
        if (this.template(path) !== this.template(this.profile.recordPathTemplate)) continue;
        const get = maybeObject(object(item).get);
        const response = get ? maybeObject(object(get.responses ?? {})["200"]) : null;
        const content = response ? maybeObject(response.content) : null;
        const media = content ? maybeObject(content["application/json"]) : null;
        if (media?.schema) recordSchema = resolveSchema(media.schema, document);
      }
      documents.push({ source, document, recordSchema });
    }
    return documents;
  }

  private parseDescriptions(document: ApplicationDocument): ObjectValue {
    const candidates = document.descriptions.filter((description) =>
      description.entries.some((entry) => entry.name === "applicationId")
      && description.entries.some((entry) => entry.name === "accountId"));
    if (candidates.length !== 1) applicationProviderFault("X2_UNSUPPORTED_OR_AMBIGUOUS_DESCRIPTION");
    const record: ObjectValue = {};
    for (const { name, value } of candidates[0]!.entries) {
      fieldName(name);
      if (Object.hasOwn(record, name)) applicationProviderFault("X2_DUPLICATE_DESCRIPTION_FIELD");
      const trimmed = value.trim();
      if (!trimmed) record[name] = null;
      else if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed === "null") record[name] = json(trimmed);
      else if (["version", "semanticRevision", "renderingRevision", "authorityRevision", "grantRevision"].includes(name)
        && /^\d+$/.test(trimmed)) {
        // Revision/concurrency metadata only, never a monetary amount.
        const number = Number(trimmed);
        if (!Number.isSafeInteger(number)) applicationProviderFault("X2_REVISION_PRECISION_BOUND");
        record[name] = number;
      } else record[name] = value;
    }
    this.noCredentials(record);
    return record;
  }

  private formSlots(form: ApplicationDocumentForm, source: ExperimentRef): FormSlots | null {
    const hidden = form.controls.filter((control) => control.kind === "hidden" && !control.disabled);
    const contexts = hidden.filter((control) => {
      try { return hasKeys(json(control.value), contextKeys); } catch { return false; }
    });
    const requests = hidden.filter((control) => {
      try { return hasKeys(json(control.value), requestKeys); } catch { return false; }
    });
    if (!contexts.length && !requests.length) return null; // Not a conditional application operation.
    if (contexts.length !== 1 || requests.length !== 1) applicationProviderFault("X2_AMBIGUOUS_PRIVATE_FORM_ENVELOPE");
    const versions = hidden.filter((control) => control !== contexts[0] && control !== requests[0]
      && /(?:expected|version|concurrency)/i.test(control.name) && /^(?:0|[1-9][0-9]*|null)$/.test(control.value));
    if (versions.length !== 1) {
      this.gap("X2_UNSUPPORTED_PRIVATE_CONCURRENCY_SLOT", source, "form"); return null;
    }
    const secrets = hidden.filter((control) => /(?:csrf|token|nonce|session)/i.test(control.name));
    return { context: contexts[0]!, request: requests[0]!, version: versions[0]!, secrets };
  }

  private validateContext(binding: ObjectValue, target?: ScopedApplicationIdentity): void {
    if (!hasKeys(binding, contextKeys) || binding.applicationId !== this.profile.application
      || binding.accountId !== this.profile.account || binding.principalId !== this.profile.actingPrincipal
      || target && binding.recordId !== null && binding.recordId !== target.id) {
      applicationProviderFault("X2_EXTERNAL_SCOPE_OR_ACTING_PRINCIPAL_MISMATCH");
    }
    if (typeof binding.grantId !== "string" || !this.computer.matchesRemoteGrant(binding.grantId)) {
      applicationProviderFault("X2_EXTERNAL_GRANT_UNBOUND");
    }
    for (const key of revisionKeys) {
      const value = binding[key];
      if (key === "applicationVersion" || key === "schemaRevision") stringValue(value);
      else if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        applicationProviderFault("X2_UNSUPPORTED_EXTERNAL_REVISION");
      }
    }
    if (binding.role !== undefined && binding.role !== this.profile.role
      || binding.roles !== undefined && !strings(binding.roles).includes(this.profile.role)) {
      applicationProviderFault("X2_EXTERNAL_ROLE_MISMATCH");
    }
  }

  private async contextObservation(document: ApplicationDocument | null, target: ScopedApplicationIdentity): Promise<ContextObservation> {
    const source = await this.computer.contextSource();
    let body: ObjectValue;
    const refs: ExperimentRef[] = [];
    if (source) {
      refs.push(source.ref);
      if (source.status !== 200) applicationProviderFault("X2_CURRENT_CONTEXT_UNAVAILABLE");
      body = object(json(source.text));
    } else {
      if (!document) return applicationProviderFault("X2_CURRENT_CONTEXT_UNAVAILABLE");
      const contexts: ObjectValue[] = [];
      for (const form of document.forms) {
        const slots = this.formSlots(form, document.source.ref);
        if (slots) contexts.push(object(json(slots.context.value)));
      }
      if (!contexts.length || new Set(contexts.map(x2Digest)).size !== 1) {
        applicationProviderFault("X2_CURRENT_CONTEXT_UNAVAILABLE");
      }
      body = { binding: contexts[0] };
      refs.push(document.source.ref);
    }
    this.noCredentials(body);
    const binding = object(body.binding);
    this.validateContext(binding, target);
    if (body.role !== undefined && body.role !== this.profile.role
      || body.roles !== undefined && !strings(body.roles).includes(this.profile.role)) {
      applicationProviderFault("X2_EXTERNAL_ROLE_MISMATCH");
    }
    if (body.role === undefined && body.roles === undefined && binding.role === undefined && binding.roles === undefined) {
      this.gap("X2_EXTERNAL_ROLE_NOT_EXPOSED_NATIVE_OWNER_CHECK_REQUIRED", refs[0] ?? null, "context.role");
    }
    if (body.recordIds !== undefined && !strings(body.recordIds).includes(target.id)) {
      applicationProviderFault("X2_EXTERNAL_TARGET_GRANT_MISMATCH");
    }
    const entities = new Map<string, string>();
    if (body.entities !== undefined) {
      if (!Array.isArray(body.entities) || body.entities.length > 32) applicationProviderFault("X2_ENTITY_DOMAIN_BOUND");
      for (const value of body.entities) {
        const entity = object(value);
        const id = stringValue(entity.entityId);
        const currency = stringValue(entity.currency);
        if (!/^[A-Z]{3}$/.test(currency) || entities.has(id)) applicationProviderFault("X2_ENTITY_DOMAIN_AMBIGUOUS");
        entities.set(id, currency);
      }
    }
    const permissions = body.permissions === undefined ? null : strings(body.permissions);
    const deadline = body.deadline === undefined ? null : stringValue(body.deadline);
    if (deadline && (!Number.isFinite(Date.parse(deadline)) || Date.parse(deadline) <= Date.now())) {
      applicationProviderFault("X2_EXTERNAL_GRANT_DEADLINE");
    }
    return { body, binding, refs, entities, permissions, deadline };
  }

  private async capture(target: ScopedApplicationIdentity): Promise<Capture> {
    this.computer.assertCurrent(target);
    const source = await this.computer.recordSource(target);
    if (source.status !== 200) applicationProviderFault("X2_RECORD_OBSERVER_UNAVAILABLE");
    let document: ApplicationDocument | null = null;
    let raw: ObjectValue;
    if (source.contentType?.includes("json")) raw = object(json(source.text));
    else if (source.contentType?.includes("html")) {
      document = await this.computer.document("record", target, undefined, source);
      raw = this.parseDescriptions(document);
    } else return applicationProviderFault("X2_UNSUPPORTED_RECORD_OBSERVER_FORMAT");
    const context = await this.contextObservation(document, target);
    if (raw.applicationId !== this.profile.application || raw.accountId !== this.profile.account || raw.recordId !== target.id) {
      applicationProviderFault("X2_RECORD_SCOPE_MISMATCH");
    }
    for (const key of revisionKeys.filter((key) => key !== "grantRevision")) {
      if (raw[key] !== context.binding[key]) applicationProviderFault("X2_RECORD_CONTEXT_REVISION_MISMATCH");
    }
    this.noCredentials(raw);
    // A complete observed tuple proves this entity/currency pair. Independent
    // select lists alone do not prove which currency belongs to which entity.
    for (const tuple of this.quantities(raw)) {
      const known = context.entities.get(tuple.entity);
      if (known && known !== tuple.currency) applicationProviderFault("X2_OBSERVED_ENTITY_CURRENCY_MISMATCH");
      context.entities.set(tuple.entity, tuple.currency);
    }
    return { raw, context, source: document?.source ?? source, document };
  }

  private quantities(value: unknown, depth = 0): ExactApplicationQuantity[] {
    if (depth > 32) applicationProviderFault("X2_SOURCE_DEPTH_BOUND");
    if (quantityShape(value)) return [quantity(value)];
    const record = maybeObject(value);
    if (!record) return [];
    return Object.entries(record).filter(([key]) => !metadata(key))
      .flatMap(([, child]) => this.quantities(child, depth + 1));
  }

  setFieldContract(fields: ApplicationField[]): void {
    if (fields.length > X2_LIMITS.maxStateFields || new Set(fields.map(field => field.path)).size !== fields.length) {
      applicationProviderFault("X2_STATE_FIELD_BOUND");
    }
    this.fieldContract = fields.map(field => ApplicationFieldSchema.parse(structuredClone(field)));
  }
  fieldDeclarations(): ApplicationField[] {
    return [...this.fields.values()].map(field => structuredClone(field));
  }
  private absencePaths(raw: ObjectValue, schema: ObjectValue | null) {
    const nullPrefixes: string[] = [], optionalAbsentPaths: string[] = [];
    const walk = (value: unknown, definition: ObjectValue | null, path: string[], depth = 0): void => {
      if (depth > 32) applicationProviderFault("X2_STATE_SCHEMA_DEPTH_BOUND");
      if (path.length && metadata(path.at(-1)!)) return;
      if (value === null && path.length) { nullPrefixes.push(fieldName(path.join("."))); return; }
      const container = maybeObject(value), type = definition ? nullableSchema(definition).schema : null;
      const properties = type?.type === "object" ? object(type.properties ?? {}) : container;
      if (!properties) return;
      for (const [key, child] of Object.entries(properties)) {
        if (metadata(key)) continue;
        const next = [...path, key];
        if (type && container && !Object.hasOwn(container, key) && !strings(type.required ?? []).includes(key)) {
          optionalAbsentPaths.push(fieldName(next.join("."))); continue;
        }
        walk(type ? container?.[key] : child, type ? object(child) : null, next, depth + 1);
      }
    };
    walk(raw, schema, []);
    if (nullPrefixes.length > 32 || optionalAbsentPaths.length > 32) applicationProviderFault("X2_STATE_FIELD_BOUND");
    return { nullPrefixes, optionalAbsentPaths };
  }

  private specs(raw: ObjectValue, schema: ObjectValue | null, source: ExperimentRef): FieldSpec[] {
    const result: FieldSpec[] = [];
    const fieldDomain = new Set<string>();
    const include = (path: string) => {
      fieldDomain.add(path);
      if (fieldDomain.size > X2_LIMITS.maxStateFields) applicationProviderFault("X2_STATE_FIELD_BOUND");
    };
    const walk = (value: unknown, definition: ObjectValue | null, path: string[], inheritedNull = false, depth = 0): void => {
      if (depth > 32) applicationProviderFault("X2_STATE_SCHEMA_DEPTH_BOUND");
      if (path.length && metadata(path.at(-1)!)) return;
      const shaped = definition ? nullableSchema(definition) : null;
      const type = shaped?.schema ?? null;
      const nullable = inheritedNull || !!shaped?.nullable || value === null;
      const name = path.length ? fieldName(path.join(".")) : "";
      if (type && schemaQuantityShape(type) || !type && quantityShape(value)) {
        include(name);
        result.push({ path: name, kind: "quantity", nullable, schema: type, presence: false }); return;
      }
      if (type && incompleteQuantity(type.properties) || !type && incompleteQuantity(value)) {
        include(name); this.gap("X2_UNSUPPORTED_INCOMPLETE_QUANTITY", source, name); return;
      }
      const properties = type?.type === "object" ? object(type.properties ?? {}) : maybeObject(value);
      if (properties) {
        for (const [key, child] of Object.entries(properties)) {
          if (metadata(key)) continue;
          walk(type ? maybeObject(value)?.[key] : child, type ? object(child) : null,
            [...path, key], nullable || !!type && !strings(type.required ?? []).includes(key), depth + 1);
        }
        return;
      }
      if (!path.length) applicationProviderFault("X2_UNSUPPORTED_RECORD_STATE");
      if (!type && value === null) {
        this.gap("X2_UNSUPPORTED_NULL_ONLY_STATE_TYPE", source, name); return;
      }
      include(name);
      if (type?.type === "array" || Array.isArray(value)) {
        this.gap("X2_UNSUPPORTED_ARRAY_STATE", source, name); return;
      }
      if (type && !["string", "boolean", "null"].includes(String(type.type))
        || !type && typeof value === "number") {
        this.gap("X2_UNSUPPORTED_NUMERIC_OR_UNKNOWN_STATE", source, name); return;
      }
      const kind: FieldSpec["kind"] = /Id$/.test(path.at(-1)!) && (type?.type === "string" || typeof value === "string")
        ? "identity" : type?.enum ? "enum" : type?.type === "boolean" || typeof value === "boolean" ? "boolean" : "text";
      result.push({ path: name, kind, nullable, schema: type, presence: false });
    };
    walk(raw, schema, []);
    if (result.length > X2_LIMITS.maxStateFields) applicationProviderFault("X2_STATE_FIELD_BOUND");
    return result;
  }

  private coverage(raw: ObjectValue, path: string): boolean {
    const observation = maybeObject(raw.observation);
    if (!observation) return false; // No invented accessibility.
    const available = strings(observation.available);
    const unavailable = strings(observation.unavailable);
    if (available.some((field) => unavailable.includes(field))) applicationProviderFault("X2_AMBIGUOUS_OBSERVATION_COVERAGE");
    const root = path.split(".")[0]!;
    if (unavailable.some((field) => field === root || field === path || path.startsWith(`${field}.`))) return false;
    return available.some((field) => field === root || field === path || path.startsWith(`${field}.`));
  }

  private async snapshot(capture: Capture, target: ScopedApplicationIdentity): Promise<ApplicationSnapshot> {
    const schemas = this.schemas.map((entry) => entry.recordSchema).filter((value): value is ObjectValue => value !== null);
    if (new Set(schemas.map(x2Digest)).size > 1) applicationProviderFault("X2_AMBIGUOUS_RECORD_SCHEMA");
    const absence = this.absencePaths(capture.raw, schemas[0] ?? null);
    for (const prefix of absence.nullPrefixes) if (this.coverage(capture.raw, prefix)) {
      this.nullFacts.set(prefix, unique([...(this.nullFacts.get(prefix) ?? []), capture.source.ref]));
    }
    const specs = this.specs(capture.raw, schemas[0] ?? null, capture.source.ref);
    const state: ApplicationState = {};
    const leaves: ApplicationState = {}, leafKinds: ApplicationStructuralWitness["leafKinds"] = {};
    const unavailableFields: string[] = [];
    for (const spec of specs) {
      const path = spec.path.split(".");
      const observed = getPath(capture.raw, spec.presence ? path.slice(0, -1) : path, schemas[0] ?? null);
      if (!observed.available || !this.coverage(capture.raw, spec.path)) {
        unavailableFields.push(spec.path); continue;
      }
      let value: ApplicationScalar;
      if (observed.value === null) value = null;
      else if (spec.presence && maybeObject(observed.value)) value = true;
      else if (spec.kind === "quantity") value = quantity(observed.value);
      else if (spec.kind === "identity" && typeof observed.value === "string") value = ScopedApplicationIdentitySchema.parse({
        kind: "identity", application: this.profile.application, account: this.profile.account,
        entity: target.entity, id: observed.value,
      });
      else if (typeof observed.value === "string" && observed.value.length <= X2_LIMITS.maxTextLength
        || typeof observed.value === "boolean") value = observed.value as string | boolean;
      else { this.gap("X2_UNSUPPORTED_OBSERVED_STATE_SHAPE", capture.source.ref, spec.path); unavailableFields.push(spec.path); continue; }
      if (spec.schema && value !== null) validateSchema(["quantity", "identity"].includes(spec.kind) ? observed.value : value, spec.schema);
      state[spec.path] = value;
      if (value !== null) { leaves[spec.path] = value; leafKinds[spec.path] = spec.kind; }
      const previous = this.fields.get(spec.path);
      if (previous && previous.kind !== spec.kind && previous.observedValues.some((item) => item !== null)) {
        applicationProviderFault("X2_OBSERVED_STATE_TYPE_DRIFT");
      }
      const values = unique([...(previous?.observedValues ?? []), value]);
      const priorNullRefs = [...this.nullFacts].filter(([prefix]) => spec.path === prefix || spec.path.startsWith(`${prefix}.`))
        .flatMap(([, refs]) => refs);
      if (values.length > 32) applicationProviderFault("X2_OBSERVED_VALUE_BOUND");
      this.fields.set(spec.path, ApplicationFieldSchema.parse({
        path: spec.path, kind: spec.kind, nullable: spec.nullable || previous?.nullable === true || priorNullRefs.length > 0,
        observedValues: values, observationRefs: unique([...(previous?.observationRefs ?? []), ...priorNullRefs, capture.source.ref]),
      }));
    }
    if (this.fields.size > X2_LIMITS.maxStateFields) applicationProviderFault("X2_STATE_FIELD_BOUND");
    for (const path of this.fields.keys()) {
      if (!Object.hasOwn(state, path) && !unavailableFields.includes(path)) unavailableFields.push(path);
    }
    if (unavailableFields.length > X2_LIMITS.maxStateFields) applicationProviderFault("X2_STATE_FIELD_BOUND");
    const revision = capture.raw.version;
    if (revision !== null && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0)) {
      applicationProviderFault("X2_UNSUPPORTED_RECORD_REVISION");
    }
    const binding = capture.context.binding;
    const observation = object(capture.raw.observation);
    const structuralWitness: ApplicationStructuralWitness = {
      schema: "finnor.x2.structural-observation-witness.v1",
      observerContractRef: await this.observer(), publishedSchemaDigest: schemas[0] ? x2Digest(schemas[0]) : null,
      leaves, leafKinds, availablePaths: strings(observation.available), unavailablePaths: strings(observation.unavailable),
      ...absence,
    };
    const snapshot = ApplicationSnapshotSchema.parse({
      schema: "finnor.x2.application-snapshot.v1",
      scope: {
        tenantId: this.profile.tenantId, principalId: this.profile.principalId,
        application: this.profile.application, account: this.profile.account, role: this.profile.role,
        grantRef: this.profile.grantRef,
        rightsRef: `authority:${String(binding.authorityRevision)}:grant:${String(binding.grantRevision)}`,
      },
      target, applicationRevision: stringValue(binding.applicationVersion),
      recordRevision: revision === null ? "UNAVAILABLE" : String(revision),
      schemaDigest: x2Digest({ schema: structuralWitness.schema, observerContractRef: structuralWitness.observerContractRef,
        publishedSchemaDigest: structuralWitness.publishedSchemaDigest }),
      sourceRef: capture.source.ref, observedAt: new Date().toISOString(), state, unavailableFields,
      observationQualification: "LAWFUL_INDEPENDENT_READBACK", structuralWitness,
    });
    const view = projectApplicationSnapshot(snapshot, this.fieldContract ?? this.fieldDeclarations());
    snapshot.state = view.state; snapshot.unavailableFields = view.unavailableFields;
    await this.retain(applicationContentRef("application-observation", snapshot), snapshot);
    this.latestObservations.set(target.id, x2Digest(snapshot));
    return snapshot;
  }

  private quantityParameter(
    name: string, schema: ObjectValue | null, required: boolean, context: ContextObservation,
    sourceRef: ExperimentRef, current: ExactApplicationQuantity[], names: Record<string, string> | null,
    controls: ApplicationFormControl[] = [],
  ): ApplicationParameter {
    const properties = schema ? object(schema.properties) : null;
    const shape = schema ? schemaQuantityShape(schema) : "dto";
    if (!shape) return applicationProviderFault("X2_UNSUPPORTED_QUANTITY_SCHEMA");
    const choices = (dimension: string, currentValues: string[]): string[] => {
      const definition = properties ? object(properties[dimension]) : null;
      const enumValues = definition?.enum === undefined ? [] : strings(definition.enum);
      const form = names ? controls.find((control) => control.name === names[dimension]) : null;
      const values = [...new Set(definition?.enum !== undefined ? enumValues
        : form?.options.length ? form.options : currentValues)];
      if (!values.length || values.length > 32) return applicationProviderFault("X2_QUANTITY_DIMENSION_DOMAIN_UNAVAILABLE");
      return values;
    };
    const authorizedCurrencies = [...new Set(context.entities.values())];
    const declaredCurrencies = choices("currency", current.map((value) => value.currency));
    const currencies = context.body.entities !== undefined
      ? declaredCurrencies.filter((currency) => authorizedCurrencies.includes(currency)) : declaredCurrencies;
    if (!currencies.length || currencies.some((currency) => !/^[A-Z]{3}$/.test(currency))) {
      applicationProviderFault("X2_QUANTITY_CURRENCY_DOMAIN_UNAVAILABLE");
    }
    const units = choices("unit", current.map((value) => value.unit));
    const bases = choices("basis", current.map((value) => value.basis));
    const amountSchema = properties ? object(properties[shape === "core" ? "decimal" : "amount"]) : null;
    const pattern = typeof amountSchema?.pattern === "string" ? amountSchema.pattern : "";
    const fixedScale = pattern.match(/\\\.\[0-9\]\{([0-9]+)\}/)?.[1];
    const places = fixedScale ? Number(fixedScale)
      : Math.max(0, ...current.map((value) => value.decimal.split(".")[1]?.length ?? 0));
    if (!Number.isSafeInteger(places) || places > 32) applicationProviderFault("X2_QUANTITY_PRECISION_BOUND");
    return ApplicationParameterSchema.parse({
      name: fieldName(name), kind: "quantity", required, values: [], maxLength: 96,
      quantityContext: { currencies, units, bases, maxDecimalPlaces: places,
        entityBinding: "CURRENT_AUTHORIZED_TARGET", timeBinding: "EXACT_CALLER_BINDING" },
      schemaEvidence: [sourceRef],
    });
  }

  private scalarParameter(
    name: string, schema: ObjectValue, required: boolean, ref: ExperimentRef,
  ): ApplicationParameter {
    const { schema: type, nullable } = nullableSchema(schema);
    if (type.type !== "string" && type.type !== "boolean") applicationProviderFault("X2_UNSUPPORTED_PARAMETER_SHAPE");
    const identity = type.type === "string" && /Id$/.test(name);
    const choices: ApplicationScalar[] = type.enum === undefined ? [] : (() => {
      if (!Array.isArray(type.enum) || type.enum.length > 32
        || type.enum.some((value) => !["string", "boolean"].includes(typeof value) && value !== null)) {
        return applicationProviderFault("X2_UNSUPPORTED_PARAMETER_ENUM");
      }
      return type.enum as ApplicationScalar[];
    })();
    if (nullable && !choices.includes(null) && type.enum !== undefined) choices.push(null);
    return ApplicationParameterSchema.parse({
      name: fieldName(name), kind: identity ? "identity" : type.enum ? "enum" : type.type === "boolean" ? "boolean" : "text",
      required, values: identity ? [] : choices,
      maxLength: typeof type.maxLength === "number" ? type.maxLength : X2_LIMITS.maxTextLength,
      quantityContext: null, schemaEvidence: [ref],
    });
  }

  private async observer(): Promise<ExperimentRef> {
    if (this.observerRef) return this.observerRef;
    const body = {
      schema: "finnor.x2.structural-observer-contract.v2", profileId: this.profile.id,
      recordResourceDigest: applicationByteDigest(this.profile.recordPathTemplate),
      requestResourceDigest: this.profile.requestPathTemplate ? applicationByteDigest(this.profile.requestPathTemplate) : null,
      coverage: "EXPLICIT_AVAILABLE_UNAVAILABLE", completion: "INDEPENDENT_SCOPED_READBACK_REQUIRED",
      structuralProjection: "COVERED_ACTUAL_LEAF_NULL_ANCESTOR_OR_SCHEMA_OPTIONAL_ABSENCE",
      uiDescriptionContract: "BOUNDED_STRUCTURED_DESCRIPTION_JSON_AND_OBSERVABLE_EMPTY_CELL_ABSENCE",
      businessCompletionSemantics: "UNKNOWN_UNTIL_OBSERVED", executionAuthorityGranted: false,
    };
    this.observerRef = applicationContentRef("application-observer-contract", body);
    await this.retain(this.observerRef, body);
    return this.observerRef;
  }

  private async candidate(input: {
    id: string; label: string; substrate: "API" | "UI"; method: string; pathTemplate: string;
    bodySchema: ObjectValue | null; lowerings: Lowering[]; sourceRef: ExperimentRef;
    context: ContextObservation; form?: ApplicationDocumentForm; slots?: FormSlots; document?: ApplicationDocument;
  }): Promise<Candidate> {
    if (input.lowerings.length > X2_LIMITS.maxParameters) applicationProviderFault("X2_PARAMETER_BOUND");
    const semanticDigest = x2Digest({
      parameters: input.lowerings.map(({ parameter, schema }) => {
        const { schemaEvidence: _evidence, ...type } = parameter;
        return { parameter: type, schema };
      }),
      applicationVersion: input.context.binding.applicationVersion,
      schemaRevision: input.context.binding.schemaRevision, semanticRevision: input.context.binding.semanticRevision,
      // No effect/precondition/desired outcome is inferred from these structures.
    });
    const rendering = input.form ? {
      label: input.form.label, method: input.form.method, actionTemplate: input.pathTemplate,
      controls: input.form.controls.map(({ name, label, kind, required, pattern, maxLength }) =>
        ({ name, label, kind, required, pattern, maxLength })),
    } : { method: input.method, pathTemplate: input.pathTemplate, bodySchema: input.bodySchema };
    const renderingDigest = x2Digest(rendering);
    const body: Omit<PrivateApplicationBinding, "ref"> = {
      schema: "finnor.x2.private-application-binding.v1", operationId: input.id, profileId: this.profile.id,
      substrate: input.substrate, method: input.method, pathTemplate: input.pathTemplate,
      bodySchema: input.bodySchema,
      parameterPaths: Object.fromEntries(input.lowerings.map((lowering) =>
        [lowering.parameter.name, lowering.quantityNames ? `quantity:${JSON.stringify(lowering.quantityNames)}` : pointer(lowering.path)])),
      form: input.form ? {
        label: input.form.label, method: input.method, actionTemplate: input.pathTemplate,
        // Values are fresh private lowering slots, never reusable semantics,
        // defaults, credentials, CSRF, request IDs or hidden context literals.
        fields: input.form.controls.map(({ name, label, kind }) => ({ name, label, kind, value: null })),
      } : null,
      sourceRef: input.sourceRef, semanticDigest, renderingDigest, observationOnly: false,
    };
    const binding: PrivateApplicationBinding = { ...body, ref: applicationContentRef("private-application-binding", body) };
    const parameters = input.lowerings.map((lowering) => lowering.parameter);
    const signature = { operationId: input.id, parameters, substrate: input.substrate, effects: "UNKNOWN", completion: "INDEPENDENT_OBSERVATION_REQUIRED" };
    this.noCredentials(body);
    this.noCredentials(signature);
    const signatureRef = applicationContentRef("application-type-signature", signature);
    await this.retain(binding.ref, binding);
    await this.retain(signatureRef, signature);
    const operation: DescribedApplicationOperation = {
      id: this.safeText(input.id), label: this.safeText(input.label), parameters,
      role: this.profile.role, profileId: this.profile.id, privateBindingRef: binding.ref,
      observerContractRef: await this.observer(), semanticRevision: String(input.context.binding.semanticRevision),
      renderingDigest, sourceRefs: [input.sourceRef, signatureRef], observationOnly: false,
    };
    return { operation, binding, lowerings: input.lowerings, slots: input.slots ?? null,
      document: input.document ?? null, form: input.form ?? null };
  }

  private async apiCandidates(schemas: DocumentSchema[], capture: Capture): Promise<Candidate[]> {
    const result: Candidate[] = [];
    let conditionalStructures = 0;
    for (const { source, document } of schemas) {
      for (const [path, item] of Object.entries(object(document.paths))) {
        const template = this.template(path);
        for (const [verb, description] of Object.entries(object(item))) {
          if (!["get", "post", "put", "patch", "delete", "head", "options", "trace"].includes(verb)) continue;
          const method = verb.toUpperCase();
          const operation = object(description);
          const requestBody = maybeObject(operation.requestBody);
          if (!requestBody) {
            // No arbitrary GET/link is an observer. Only the configured read
            // templates are callable; the rest remain fenced/unsupported.
            const knownRead = [this.profile.contextPath, this.profile.recordPathTemplate, this.profile.requestPathTemplate]
              .some((known) => known && this.template(known) === template);
            if (!knownRead && operation.operationId !== undefined) this.gap("X2_UNKNOWN_EFFECT_OR_UNBOUNDED_OPERATION", source.ref, `paths.${verb}`);
            continue;
          }
          if (++conditionalStructures > X2_LIMITS.maxOperations) applicationProviderFault("X2_OPERATION_BOUND");
          try {
            if (method === "GET" || method === "HEAD" || method === "OPTIONS" || method === "TRACE") {
              applicationProviderFault("X2_UNSUPPORTED_CONDITIONAL_GET_SCHEMA");
            }
            const media = object(object(requestBody.content)["application/json"]);
            const body = resolveSchema(media.schema, document);
            const properties = object(body.properties);
            const required = strings(body.required ?? []);
            if (body.type !== "object" || body.additionalProperties !== false
              || !["context", "request", "expectedVersion"].every((key) => properties[key] && required.includes(key))
              || !hasKeys(object(properties.context).properties, contextKeys)
              || !hasKeys(object(properties.request).properties, requestKeys)
              || !template.includes("{recordId}")) applicationProviderFault("X2_UNSUPPORTED_CONDITIONAL_ENVELOPE");
            const lowerings: Lowering[] = [];
            const walk = (definition: ObjectValue, route: string[], needed: boolean, depth = 0): void => {
              if (depth > 16) applicationProviderFault("X2_PARAMETER_SCHEMA_DEPTH_BOUND");
              if (route.some((key) => /(?:csrf|password|session|token|nonce)/i.test(key))) {
                applicationProviderFault("X2_PRIVATE_CREDENTIAL_PARAMETER_UNSUPPORTED");
              }
              const { schema } = nullableSchema(definition);
              if (schemaQuantityShape(schema)) {
                lowerings.push({
                  parameter: this.quantityParameter(route.join("."), schema, needed, capture.context, source.ref,
                    this.quantities(capture.raw), null), path: route, schema: definition, quantityNames: null, control: null,
                });
              } else if (schema.type === "object") {
                if (incompleteQuantity(schema.properties)) applicationProviderFault("X2_UNSUPPORTED_INCOMPLETE_QUANTITY");
                if (schema.additionalProperties !== false) applicationProviderFault("X2_UNSUPPORTED_OPEN_PARAMETER_OBJECT");
                for (const [key, child] of Object.entries(object(schema.properties))) {
                  walk(object(child), [...route, key], needed && strings(schema.required ?? []).includes(key), depth + 1);
                }
              } else lowerings.push({
                parameter: this.scalarParameter(route.join("."), definition, needed, source.ref),
                path: route, schema: definition, quantityNames: null, control: null,
              });
            };
            for (const [key, definition] of Object.entries(properties)) {
              if (!["context", "request", "expectedVersion"].includes(key)) walk(object(definition), [key], required.includes(key));
            }
            const suppliedId = typeof operation.operationId === "string" ? operation.operationId : null;
            const id = suppliedId && /^[A-Za-z][A-Za-z0-9_.-]{0,120}$/.test(suppliedId)
              ? `api.${suppliedId}` : `api.${x2Digest({ method, template })}`;
            result.push(await this.candidate({
              id, label: typeof operation.summary === "string" ? operation.summary : suppliedId ?? id,
              substrate: "API", method, pathTemplate: template, bodySchema: body, lowerings,
              sourceRef: source.ref, context: capture.context,
            }));
          } catch (error) {
            if (!(error instanceof ApplicationProviderFault)) throw error;
            if (/_BOUND$/.test(error.code)) throw error;
            this.gap(error.code, source.ref, `paths.${verb}`);
          }
        }
      }
    }
    return result;
  }

  private async uiCandidates(document: ApplicationDocument, capture: Capture, target: ScopedApplicationIdentity): Promise<Candidate[]> {
    const result: Candidate[] = [];
    for (const form of document.forms) {
      const slots = this.formSlots(form, document.source.ref);
      if (!slots) continue;
      try {
        if (form.overrides || form.target && form.target !== "_self"
          || form.encoding !== "application/x-www-form-urlencoded" || !["GET", "POST"].includes(form.method)) {
          applicationProviderFault("X2_UNSUPPORTED_FORM_SUBSTRATE");
        }
        const binding = object(json(slots.context.value));
        this.validateContext(binding, target);
        if (revisionKeys.some((key) => binding[key] !== capture.context.binding[key])) applicationProviderFault("X2_FORM_CONTEXT_REVISION_MISMATCH");
        const template = this.template(form.action, target);
        if (!template.includes("{recordId}")) applicationProviderFault("X2_UNSCOPED_FORM_ACTION");
        if (new Set(form.controls.map((control) => control.name)).size !== form.controls.length) {
          applicationProviderFault("X2_AMBIGUOUS_FORM_CONTROL");
        }
        const transport = [slots.context, slots.request, slots.version, ...slots.secrets];
        const controls = form.controls.filter((control) => !transport.includes(control));
        if (controls.some((control) => control.disabled || !control.name
          || ["file", "password", "checkbox", "radio", "submit", "image", "reset"].includes(control.kind))) {
          applicationProviderFault("X2_UNSUPPORTED_FORM_CONTROL");
        }
        const quantityNames: Record<string, string> = {};
        for (const dimension of dimensions) {
          const matches = controls.filter((control) =>
            control.name.split(/[._:-]/).at(-1)?.toLowerCase() === dimension
            || control.label?.trim().toLowerCase() === dimension);
          if (matches.length > 1) applicationProviderFault("X2_AMBIGUOUS_FORM_QUANTITY");
          if (matches.length) quantityNames[dimension] = matches[0]!.name;
        }
        const dimensionCount = Object.keys(quantityNames).length;
        if (dimensionCount && dimensionCount !== dimensions.length) applicationProviderFault("X2_UNSUPPORTED_INCOMPLETE_QUANTITY");
        const lowerings: Lowering[] = [];
        if (dimensionCount) {
          const currentDTO = Object.fromEntries(dimensions.map((dimension) =>
            [dimension, controls.find((control) => control.name === quantityNames[dimension])!.value]));
          const current = quantity(currentDTO);
          lowerings.push({
            parameter: this.quantityParameter("quantity", null, true, capture.context, document.source.ref,
              [current], quantityNames, controls), path: [], schema: null, quantityNames, control: null,
          });
        }
        for (const control of controls) {
          if (Object.values(quantityNames).includes(control.name)) continue;
          const definition: ObjectValue = {
            type: "string",
            ...(control.options.length ? { enum: control.options } : {}),
            ...(control.pattern ? { pattern: control.pattern } : {}),
            ...(control.maxLength !== null ? { maxLength: control.maxLength } : {}),
            ...(control.kind === "date" ? { format: "date" } : {}),
          };
          if (control.kind === "hidden" && !/Id$/.test(control.name)) applicationProviderFault("X2_UNKNOWN_PRIVATE_HIDDEN_SLOT");
          lowerings.push({
            parameter: this.scalarParameter(control.name, definition, control.required || control.kind === "hidden", document.source.ref),
            path: [control.name], schema: definition, quantityNames: null, control,
          });
        }
        const id = `ui.${x2Digest({ template, method: form.method })}`;
        result.push(await this.candidate({
          id, label: form.label || id, substrate: "UI", method: form.method, pathTemplate: template,
          bodySchema: null, lowerings, sourceRef: document.source.ref, context: capture.context,
          slots, form, document,
        }));
      } catch (error) {
        if (!(error instanceof ApplicationProviderFault)) throw error;
        if (/_BOUND$/.test(error.code)) throw error;
        this.gap(error.code, document.source.ref, "form");
      }
    }
    return result;
  }

  private async entryDocument(target: ScopedApplicationIdentity, capture: Capture): Promise<ApplicationDocument | null> {
    if (this.profile.discoverySurface === "API") return null;
    if (capture.document) return capture.document;
    try { return await this.computer.document("entrypoint", target); }
    catch (error) {
      if (!(error instanceof ApplicationProviderFault)) throw error;
      this.gap(error.code, capture.source.ref, "entrypoint");
      return null;
    }
  }

  async discover(): Promise<{
    operations: DescribedApplicationOperation[]; fields: ApplicationField[];
    sourceRefs: ExperimentRef[]; typeSignatureRefs: ExperimentRef[]; substrate: "API" | "UI" | "HYBRID";
    observations: ApplicationSnapshot[];
  }> {
    this.assertOpen();
    if (this.discovered) applicationProviderFault("X2_SESSION_DISCOVERY_ALREADY_FROZEN");
    if (this.discovering) applicationProviderFault("X2_CONCURRENT_DISCOVERY");
    this.discovering = true;
    try {
      this.schemas = await this.documents();
      const sources: ExperimentRef[] = this.schemas.map((schema) => schema.source.ref);
      const observations: ApplicationSnapshot[] = [];
      let api = false; let ui = false;
      for (const id of this.profile.allowedTargets) {
        // Target identity comes from a permitted record/context, not a demo or
        // withheld objective. Entity is established after reading its tuple.
        const provisional: ScopedApplicationIdentity = {
          kind: "identity", application: this.profile.application, account: this.profile.account, entity: "record", id,
        };
        const capture = await this.capture(provisional);
        const tuples = this.quantities(capture.raw);
        const entity = tuples[0]?.entity ?? (capture.context.entities.size === 1 ? [...capture.context.entities.keys()][0] : null);
        if (!entity) applicationProviderFault("X2_UNSUPPORTED_TARGET_ENTITY_OBSERVATION");
        const target = { ...provisional, entity };
        observations.push(await this.snapshot(capture, target));
        sources.push(capture.source.ref, ...capture.context.refs);
        const candidates = await this.apiCandidates(this.schemas, capture);
        api ||= candidates.length > 0;
        const document = await this.entryDocument(target, capture);
        if (document) {
          sources.push(document.source.ref);
          const forms = await this.uiCandidates(document, capture, target);
          ui ||= forms.length > 0;
          candidates.push(...forms);
        }
        for (const candidate of candidates) {
          const previous = this.candidates.get(candidate.operation.id);
          if (previous && previous.binding.semanticDigest !== candidate.binding.semanticDigest) {
            applicationProviderFault("X2_DISCOVERY_SIGNATURE_AMBIGUITY");
          }
          if (!previous) this.candidates.set(candidate.operation.id, {
            ...candidate, slots: null, document: null, form: null,
            lowerings: candidate.lowerings.map((lowering) => ({
              ...lowering, control: lowering.control?.kind === "hidden" ? { ...lowering.control, value: "" } : lowering.control,
            })),
          });
        }
        if (this.candidates.size > X2_LIMITS.maxOperations) applicationProviderFault("X2_OPERATION_BOUND");
        if (document) await this.computer.releaseDocument(document);
        if (capture.document && capture.document !== document) await this.computer.releaseDocument(capture.document);
      }
      if (!this.candidates.size || !this.fields.size) applicationProviderFault("X2_UNSUPPORTED_EMPTY_APPLICATION_DOMAIN");
      const operations = [...this.candidates.values()].map((candidate) => structuredClone(candidate.operation));
      const typeSignatureRefs = unique(operations.flatMap((operation) => operation.sourceRefs.slice(1)));
      this.discovered = true;
      return {
        operations, fields: [...this.fields.values()].map((field) => structuredClone(field)),
        sourceRefs: unique(sources), typeSignatureRefs, substrate: api && ui ? "HYBRID" : ui ? "UI" : "API",
        observations,
      };
    } finally { this.discovering = false; }
  }

  async observe(target: ScopedApplicationIdentity): Promise<{
    snapshot: ApplicationSnapshot; context: ObjectValue; rawRecord: ObjectValue;
  }> {
    this.assertOpen();
    ScopedApplicationIdentitySchema.parse(target);
    this.computer.assertCurrent(target);
    if (!this.discovered && !this.discovering) await this.discover();
    const capture = await this.capture(target);
    try {
      if (capture.context.entities.size && !capture.context.entities.has(target.entity)) {
        applicationProviderFault("X2_TARGET_ENTITY_OUTSIDE_OBSERVED_CONTEXT");
      }
      const snapshot = await this.snapshot(capture, target);
      this.observedApiCapture = {
        targetDigest: x2Digest(target), capture: structuredClone({ ...capture, document: null }),
      };
      return { snapshot, context: structuredClone(capture.context.body), rawRecord: structuredClone(capture.raw) };
    } finally {
      if (capture.document) await this.computer.releaseDocument(capture.document);
    }
  }

  async parameterSamples(operation: DescribedApplicationOperation, observation: ApplicationSnapshot): Promise<ApplicationState[]> {
    this.assertOpen();
    const candidate = this.candidates.get(operation.id);
    if (!candidate || x2Digest(candidate.operation) !== x2Digest(operation)) applicationProviderFault("X2_OPERATION_SIGNATURE_SUBSTITUTION");
    ApplicationSnapshotSchema.parse(observation);
    if (this.latestObservations.get(observation.target.id) !== x2Digest(observation)) {
      applicationProviderFault("X2_ORIGINAL_CURRENT_SOURCE_OBSERVATION_REQUIRED");
    }
    if (observation.scope.tenantId !== this.profile.tenantId || observation.scope.principalId !== this.profile.principalId
      || observation.scope.application !== this.profile.application || observation.scope.account !== this.profile.account
      || observation.scope.role !== this.profile.role || x2Digest(observation.scope.grantRef) !== x2Digest(this.profile.grantRef)) {
      applicationProviderFault("X2_SAMPLE_OBSERVATION_SCOPE");
    }
    this.computer.assertCurrent(observation.target);
    const domains: Array<{ name: string; values: ApplicationScalar[]; required: boolean }> = [];
    for (const lowering of candidate.lowerings) {
      const parameter = lowering.parameter;
      let values: ApplicationScalar[] = [];
      if (parameter.kind === "quantity") {
        const context = parameter.quantityContext!;
        const observed = Object.values(observation.state).filter((value): value is ExactApplicationQuantity =>
          maybeObject(value)?.kind === "quantity").filter((value) => value.entity === observation.target.entity);
        for (const current of observed) {
          for (const unit of context.units) for (const basis of context.bases) {
            if (context.currencies.includes(current.currency)) values.push({ ...current, unit, basis });
          }
        }
      } else if (parameter.kind === "identity") {
        values = Object.values(observation.state).filter((value): value is ScopedApplicationIdentity =>
          !!value && typeof value === "object" && value.kind === "identity"
          && value.application === this.profile.application && value.account === this.profile.account
          && value.entity === observation.target.entity);
      } else {
        const exact = observation.state[parameter.name];
        if (exact !== undefined && (typeof exact === "string" || typeof exact === "boolean" || exact === null)) values.push(exact);
        if (lowering.control && lowering.control.kind !== "hidden") values.push(lowering.control.value);
        values.push(...parameter.values);
        if (parameter.kind === "boolean") values.push(false, true);
      }
      values = unique(values).filter((value) => {
        try { this.lowerValue(lowering, value, observation.target); return true; } catch { return false; }
      });
      if (!values.length && parameter.required) {
        this.gap("X2_REQUIRED_SAMPLE_BINDING_UNAVAILABLE", candidate.binding.sourceRef, parameter.name);
        return [];
      }
      if (values.length > 32) applicationProviderFault("X2_PARAMETER_SAMPLE_DOMAIN_BOUND");
      domains.push({ name: parameter.name, values, required: parameter.required });
    }
    let samples: ApplicationState[] = [{}];
    for (const domain of domains) {
      const next: ApplicationState[] = [];
      const choices: Array<ApplicationScalar | undefined> = domain.required ? domain.values : [undefined, ...domain.values];
      if (samples.length * choices.length > X2_LIMITS.maxExplorationInteractions) applicationProviderFault("X2_PARAMETER_SAMPLE_BOUND");
      for (const sample of samples) for (const value of choices) next.push(value === undefined ? { ...sample } : { ...sample, [domain.name]: value });
      samples = next;
    }
    if (samples.length > 8) this.gap("X2_BOUNDED_SAMPLE_SUBSET_REMAINS_UNEXPLORED", candidate.binding.sourceRef,
      `parameter-samples:${samples.length}:selected-8`);
    return samples.slice(0, 8);
  }

  private lowerValue(lowering: Lowering, value: ApplicationScalar, target: ScopedApplicationIdentity): unknown {
    const parameter = lowering.parameter;
    if (parameter.kind === "quantity") {
      const tuple = quantity(value);
      const context = parameter.quantityContext!;
      if (tuple.entity !== target.entity || !context.currencies.includes(tuple.currency)
        || !context.units.includes(tuple.unit) || !context.bases.includes(tuple.basis)
        || (tuple.decimal.split(".")[1]?.length ?? 0) > context.maxDecimalPlaces) {
        applicationProviderFault("X2_QUANTITY_CONTEXT_BINDING_MISMATCH");
      }
      const shape = lowering.schema ? schemaQuantityShape(nullableSchema(lowering.schema).schema) : "dto";
      const result = shape === "core" ? tuple : {
        amount: tuple.decimal, currency: tuple.currency, entity: tuple.entity, unit: tuple.unit, date: tuple.time, basis: tuple.basis,
      };
      if (lowering.schema) validateSchema(result, lowering.schema);
      return result;
    }
    if (parameter.kind === "identity") {
      const parsed = ScopedApplicationIdentitySchema.safeParse(value);
      if (!parsed.success || parsed.data.application !== this.profile.application || parsed.data.account !== this.profile.account) {
        applicationProviderFault("X2_PARAMETER_IDENTITY_SCOPE_MISMATCH");
      }
      if (lowering.schema) validateSchema(parsed.data.id, lowering.schema);
      return parsed.data.id;
    }
    if (typeof value !== "string" && typeof value !== "boolean" && value !== null) applicationProviderFault("X2_PARAMETER_TYPE_MISMATCH");
    if (typeof value === "string" && value.length > parameter.maxLength) applicationProviderFault("X2_PARAMETER_TEXT_BOUND");
    if (lowering.schema) validateSchema(value, lowering.schema);
    return value;
  }

  private scopeDigest(context: ContextObservation): string {
    return x2Digest({
      binding: context.binding, permissions: context.permissions,
      entities: [...context.entities.entries()].sort(([left], [right]) => left.localeCompare(right)),
      deadline: context.deadline,
    });
  }

  async prepare(
    operationId: string, target: ScopedApplicationIdentity, parameters: ApplicationState,
    identity: NativeApplicationRequestIdentity,
  ): Promise<PreparedApplicationWire> {
    this.assertOpen();
    if (this.preparing) applicationProviderFault("X2_CONCURRENT_PREPARATION");
    this.preparing = true;
    let captureDocument: ApplicationDocument | null = null;
    let formDocument: ApplicationDocument | null = null;
    let keptDocument: ApplicationDocument | null = null;
    try {
      this.computer.assertCurrent(target, identity);
      if (!this.discovered) await this.discover();
      const previous = this.candidates.get(operationId);
      if (!previous) applicationProviderFault("X2_UNKNOWN_OPERATION");
      boundedX2(parameters, X2_LIMITS.maxSourceBytes);
      this.noCredentials(parameters);
      const schemas = await this.documents();
      const cached = previous.binding.substrate === "API" && this.observedApiCapture?.targetDigest === x2Digest(target)
        ? this.observedApiCapture.capture : null;
      this.observedApiCapture = null;
      const capture = cached ?? await this.capture(target);
      captureDocument = capture.document;
      const expectedVersion = capture.raw.version;
      if (typeof expectedVersion !== "number" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0
        || !this.coverage(capture.raw, "version")) applicationProviderFault("X2_CONDITIONAL_RECORD_VERSION_UNAVAILABLE");
      if (capture.context.deadline && Date.parse(identity.deadline) > Date.parse(capture.context.deadline)) {
        applicationProviderFault("X2_ORIGINAL_EXTERNAL_DEADLINE_EXCEEDED");
      }
      const available = previous.binding.substrate === "API" ? await this.apiCandidates(schemas, capture)
        : await (async () => {
          const document = await this.entryDocument(target, capture);
          if (!document) return applicationProviderFault("X2_CURRENT_FORM_UNAVAILABLE");
          formDocument = document;
          return await this.uiCandidates(document, capture, target);
        })();
      const current = available.find((candidate) => candidate.operation.id === operationId);
      if (!current) applicationProviderFault("X2_BINDING_SOURCE_DRIFT");
      if (current.binding.semanticDigest !== previous.binding.semanticDigest) applicationProviderFault("X2_SEMANTIC_SOURCE_DRIFT");
      if (current.binding.renderingDigest !== previous.binding.renderingDigest) applicationProviderFault("X2_RENDERING_BINDING_DRIFT");
      for (const lowering of current.lowerings) {
        if (!Object.hasOwn(parameters, lowering.parameter.name)) continue;
        if (lowering.parameter.kind === "identity") {
          const dependency = ScopedApplicationIdentitySchema.parse(parameters[lowering.parameter.name]);
          const observedIds = new Set<string>();
          const collect = (value: unknown, depth = 0): void => {
            if (depth > 32) applicationProviderFault("X2_SOURCE_DEPTH_BOUND");
            if (Array.isArray(value)) { for (const child of value) collect(child, depth + 1); return; }
            const record = maybeObject(value);
            if (!record) return;
            for (const [key, child] of Object.entries(record)) {
              if (/Id$/.test(key) && typeof child === "string") observedIds.add(child);
              else if (typeof child === "object") collect(child, depth + 1);
            }
          };
          collect(capture.raw); collect(capture.context.body);
          if (lowering.control?.kind === "hidden") {
            if (dependency.id !== lowering.control.value) applicationProviderFault("X2_CURRENT_PRIVATE_DEPENDENCY_BINDING_MISMATCH");
          } else if (!observedIds.has(dependency.id)) applicationProviderFault("X2_DEPENDENCY_IDENTITY_NOT_CURRENTLY_OBSERVED");
          continue;
        }
        if (lowering.parameter.kind !== "quantity") continue;
        const tuple = quantity(parameters[lowering.parameter.name]);
        if (capture.context.entities.get(tuple.entity) !== tuple.currency) {
          applicationProviderFault("X2_CURRENT_ENTITY_CURRENCY_BINDING_MISMATCH");
        }
      }
      const allowed = new Set(current.lowerings.map((lowering) => lowering.parameter.name));
      if (Object.keys(parameters).length > X2_LIMITS.maxParameters || Object.keys(parameters).some((key) => !allowed.has(key))) {
        applicationProviderFault("X2_UNKNOWN_OR_EXCESS_PARAMETERS");
      }
      for (const lowering of current.lowerings) {
        if (lowering.parameter.required && !Object.hasOwn(parameters, lowering.parameter.name)) applicationProviderFault("X2_REQUIRED_PARAMETER_MISSING");
      }
      const context = { ...capture.context.binding, recordId: target.id };
      const path = applicationResourcePath(current.binding.pathTemplate, this.profile, target, identity);
      let url = new URL(path, this.profile.origin).href;
      let body: string | null;
      let contentType: string | null;
      let controls: Record<string, string> | null = null;
      if (current.binding.substrate === "API") {
        const payload: ObjectValue = { context, request: { ...identity }, expectedVersion };
        for (const lowering of current.lowerings) {
          if (Object.hasOwn(parameters, lowering.parameter.name)) putPath(payload, lowering.path,
            this.lowerValue(lowering, parameters[lowering.parameter.name]!, target));
        }
        validateSchema(payload, current.binding.bodySchema!);
        body = JSON.stringify(payload); contentType = "application/json";
      } else {
        const slots = current.slots!;
        controls = {};
        for (const secret of slots.secrets) controls[secret.name] = secret.value;
        controls[slots.context.name] = JSON.stringify(context);
        controls[slots.request.name] = JSON.stringify(identity);
        controls[slots.version.name] = String(expectedVersion);
        for (const lowering of current.lowerings) {
          if (!Object.hasOwn(parameters, lowering.parameter.name)) continue;
          const value = this.lowerValue(lowering, parameters[lowering.parameter.name]!, target);
          if (lowering.quantityNames) {
            const tuple = object(value);
            for (const [dimension, name] of Object.entries(lowering.quantityNames)) {
              const next = stringValue(tuple[dimension]);
              const control = current.form!.controls.find((item) => item.name === name)!;
              if (control.options.length && !control.options.includes(next)) applicationProviderFault("X2_FORM_QUANTITY_DOMAIN_MISMATCH");
              controls[name] = next;
            }
          } else controls[lowering.path[0]!] = value === null ? "" : String(value);
        }
        // HTML's serializer emits every successful control, in DOM order.
        // Optional controls cannot silently retain an unbound current value.
        for (const control of current.form!.controls) {
          if (!Object.hasOwn(controls, control.name)) {
            if (control.required || control.kind === "hidden") applicationProviderFault("X2_UNBOUND_SUCCESSFUL_FORM_CONTROL");
            controls[control.name] = "";
          }
        }
        const encoded = new URLSearchParams();
        for (const control of current.form!.controls) encoded.append(
          control.name.replace(/\r\n|\r|\n/g, "\r\n"), controls[control.name]!.replace(/\r\n|\r|\n/g, "\r\n"));
        if (current.binding.method === "GET") {
          url += `?${encoded.toString()}`; body = null; contentType = null;
        } else { body = encoded.toString(); contentType = "application/x-www-form-urlencoded"; }
      }
      const wire: PreparedApplicationWire = {
        url, method: current.binding.method, contentType, body, bodyDigest: applicationByteDigest(body ?? ""),
        bindingRef: previous.binding.ref, identity: { ...identity }, context, expectedVersion: String(expectedVersion),
      };
      const sealed = this.computer.seal(wire, current.document && controls
        ? { document: current.document, formIndex: current.form!.index, controls } : undefined);
      keptDocument = controls ? current.document : null;
      this.prepared.set(sealed, {
        target: structuredClone(target), operationId, scopeDigest: this.scopeDigest(capture.context),
        recordRevision: String(expectedVersion), semanticDigest: current.binding.semanticDigest,
      });
      return sealed;
    } finally {
      if (captureDocument && captureDocument !== keptDocument) await this.computer.releaseDocument(captureDocument);
      if (formDocument && formDocument !== keptDocument && formDocument !== captureDocument) await this.computer.releaseDocument(formDocument);
      this.preparing = false;
    }
  }

  async dispatch(wire: PreparedApplicationWire, fence: ApplicationPhysicalEgressFence): Promise<{
    status: number | null; body: unknown; responseRef: ExperimentRef | null; possibleEgress: boolean;
  }> {
    this.assertOpen();
    const prepared = this.prepared.get(wire);
    if (!prepared) applicationProviderFault("X2_SOURCE_OWNED_PREPARED_WIRE_REQUIRED");
    this.observedApiCapture = null;
    this.computer.assertCurrent(prepared.target, wire.identity);
    // Current remote scope/grant/permissions/revisions and conditional version
    // are re-read immediately before asking the native physical fence.
    const capture = await this.capture(prepared.target);
    let entry: ApplicationDocument | null = null;
    try {
      if (this.scopeDigest(capture.context) !== prepared.scopeDigest
        || String(capture.raw.version) !== prepared.recordRevision) applicationProviderFault("X2_PRE_WIRE_EXTERNAL_DRIFT");
      const schemas = await this.documents();
      const currentCandidates = this.candidates.get(prepared.operationId)?.binding.substrate === "API"
        ? await this.apiCandidates(schemas, capture) : await (async () => {
          entry = await this.entryDocument(prepared.target, capture);
          if (!entry) applicationProviderFault("X2_CURRENT_FORM_UNAVAILABLE");
          return await this.uiCandidates(entry, capture, prepared.target);
        })();
      const current = currentCandidates.find((candidate) => candidate.operation.id === prepared.operationId);
      if (!current || current.binding.semanticDigest !== prepared.semanticDigest
        || current.binding.renderingDigest !== this.candidates.get(prepared.operationId)!.binding.renderingDigest) {
        applicationProviderFault("X2_PRE_WIRE_SEMANTIC_OR_RENDERING_DRIFT");
      }
    } finally {
      if (entry) await this.computer.releaseDocument(entry);
      if (capture.document && capture.document !== entry) await this.computer.releaseDocument(capture.document);
    }
    const result = await this.computer.execute(wire, fence);
    if (result.possibleEgress) this.requestRecords.set(wire.identity.requestId, {
      identity: structuredClone(wire.identity), target: prepared.target, context: structuredClone(wire.context),
    });
    this.noCredentials(result.body);
    return result;
  }
  /** Alias for the follow-up callable surface. */
  async execute(wire: PreparedApplicationWire, fence: ApplicationPhysicalEgressFence) { return await this.dispatch(wire, fence); }

  async observeRequest(identity: NativeApplicationRequestIdentity): Promise<{
    body: ObjectValue | null; sourceRef: ExperimentRef | null; available: boolean;
  }> {
    this.assertOpen();
    const original = this.requestRecords.get(identity.requestId);
    if (original && x2Digest(identity) !== x2Digest(original.identity) || !this.profile.requestPathTemplate) {
      return { body: null, sourceRef: null, available: false };
    }
    if (Object.keys(identity).length !== requestKeys.length || requestKeys.some((key) =>
      typeof identity[key] !== "string" || !identity[key] || identity[key].length > 256)
      || !Number.isFinite(Date.parse(identity.deadline))) applicationProviderFault("X2_INVALID_NATIVE_REQUEST_IDENTITY");
    this.computer.assertCurrent(original?.target);
    let source: ApplicationPublicSource | null;
    try { source = await this.computer.requestSource(identity); }
    catch (error) {
      if (!(error instanceof ApplicationProviderFault)) throw error;
      return { body: null, sourceRef: null, available: false };
    }
    if (!source || source.status !== 200) return { body: null, sourceRef: source?.ref ?? null, available: false };
    let body: ObjectValue;
    if (source.contentType?.includes("json")) body = object(json(source.text));
    else if (source.contentType?.includes("html")) {
      try {
        const document = await this.computer.document("request", undefined, identity, source);
        try { source = document.source; body = this.parseDescriptions(document); }
        finally { await this.computer.releaseDocument(document); }
      } catch (error) {
        if (!(error instanceof ApplicationProviderFault)) throw error;
        return { body: null, sourceRef: source.ref, available: false };
      }
    } else return { body: null, sourceRef: source.ref, available: false };
    this.noCredentials(body);
    if (body.applicationId !== this.profile.application || body.accountId !== this.profile.account
      || typeof body.recordId !== "string" || !this.profile.allowedTargets.includes(body.recordId)
      || original && body.recordId !== original.target.id || body.principalId !== this.profile.actingPrincipal
      || !hasKeys(body.request, requestKeys) || x2Digest(body.request) !== x2Digest(identity)
      || original && ["applicationVersion", "schemaRevision", "semanticRevision"].some((key) => body[key] !== original.context[key])
      || typeof body.operation !== "string" || !body.operation || body.operation.length > 256
      || typeof body.status !== "string" || !body.status || body.status.length > 256
      || typeof body.applicationVersion !== "string" || typeof body.schemaRevision !== "string"
      || typeof body.semanticRevision !== "number" || !Number.isSafeInteger(body.semanticRevision)
      || typeof body.acceptedAt !== "string" || !Number.isFinite(Date.parse(body.acceptedAt))
      || body.completedAt !== null && (typeof body.completedAt !== "string" || !Number.isFinite(Date.parse(body.completedAt)))
      || !Object.hasOwn(body, "reporting")) {
      applicationProviderFault("X2_INDEPENDENT_REQUEST_IDENTITY_OR_COVERAGE_MISMATCH");
    }
    if (body.reporting !== null && body.reporting !== undefined) quantity(body.reporting);
    // Return the application's exact observation. No toast/status vocabulary
    // here decides business completion or clears a native UNKNOWN obligation.
    return { body: structuredClone(body), sourceRef: source.ref, available: true };
  }

  async binding(operationId: string): Promise<PrivateApplicationBinding> {
    this.assertOpen();
    if (!this.discovered) await this.discover();
    const candidate = this.candidates.get(operationId);
    if (!candidate) applicationProviderFault("X2_UNKNOWN_OPERATION");
    return structuredClone(candidate.binding);
  }

  async close(): Promise<void> { this.closed = true; await this.computer.close(); }
}
