import type {
  ApplicationField, ApplicationParameter, ApplicationScope, ApplicationSnapshot,
  ApplicationState, ApplicationTransitionEvidence, ExperimentRef,
  ApplicationActionModelEnvelope, ScopedApplicationIdentity,
} from "@finnor/shared-types";

export interface DescribedApplicationOperation {
  id: string;
  label: string;
  parameters: ApplicationParameter[];
  role: string;
  profileId: string;
  privateBindingRef: ExperimentRef;
  observerContractRef: ExperimentRef;
  semanticRevision: string;
  renderingDigest: string;
  sourceRefs: ExperimentRef[];
  observationOnly: boolean;
}
export interface ApplicationDiscovery {
  scope: ApplicationScope;
  operations: DescribedApplicationOperation[];
  fields: ApplicationField[];
  sourceRefs: ExperimentRef[];
  typeSignatureRefs: ExperimentRef[];
  substrate: "API" | "UI" | "HYBRID";
}
export interface OriginalApplicationParent {
  originalParentRef: ExperimentRef;
  tenantRef: ExperimentRef;
  workRef: ExperimentRef;
  institutionalProgramRef: ExperimentRef | null;
  institutionalOriginRef?: ExperimentRef;
  authorityGrantRef: ExperimentRef;
  resourceGrantRef: ExperimentRef;
  baselineManifestRef: ExperimentRef;
  rightsRevision: string;
  deadlineAt: string;
  validAfter: string;
  dependencyLockDigest: string;
  runtimeDigest: string;
  schemaDigest: string;
  dependencyPins: Array<{ path: string; sha256: string }>;
  producerRef: ExperimentRef;
  grammarRef: ExperimentRef;
  checkerRef: ExperimentRef;
  runtimeRef: ExperimentRef;
  costRefs: ExperimentRef[];
  humanWorkRefs: ExperimentRef[];
}
/** This port is implemented by native owners, never by the learned program. */
export interface ApplicationLearningPort {
  readonly parent: OriginalApplicationParent;
  discover(): Promise<ApplicationDiscovery>;
  observe(target: ScopedApplicationIdentity, profileId: string): Promise<ApplicationSnapshot>;
  parameterSamples(operation: DescribedApplicationOperation, observation: ApplicationSnapshot): Promise<ApplicationState[]>;
  interact(input: {
    operation: DescribedApplicationOperation;
    target: ScopedApplicationIdentity;
    parameters: ApplicationState;
    purpose: "AUTHORIZED_EXPLORATION";
  }): Promise<ApplicationTransitionEvidence>;
  originalEvidence(): Promise<ApplicationTransitionEvidence[]>;
  retainClaim(ref: ExperimentRef, body: unknown): Promise<void>;
  charge(input: { phase: "ACQUISITION" | "CHECKING" | "COMPOSITION"; units: number }): Promise<ExperimentRef>;
  assertCurrent(): Promise<void>;
}
export type ApplicationModelEnvelopeInput = {
  parent: OriginalApplicationParent;
  semanticRevisionRef: ExperimentRef;
  scope: ApplicationScope;
  substrate: ApplicationDiscovery["substrate"];
  sourceRefs: ExperimentRef[];
  evidenceRefs: ExperimentRef[];
  inferredRefs: ExperimentRef[];
  observerRefs: ExperimentRef[];
  obligationRefs: ExperimentRef[];
  dependencies: ExperimentRef[];
};
export type BuiltApplicationEnvelope = ApplicationActionModelEnvelope;

export interface NativeApplicationRequestIdentity {
  requestId: string;
  effectId: string;
  obligationId: string;
  idempotencyKey: string;
  parentId: string;
  deadline: string;
}
export interface PrivateApplicationBinding {
  schema: "finnor.x2.private-application-binding.v1";
  ref: ExperimentRef;
  operationId: string;
  profileId: string;
  substrate: "API" | "UI";
  method: string;
  pathTemplate: string;
  bodySchema: Record<string, unknown> | null;
  parameterPaths: Record<string, string>;
  form: {
    label: string;
    method: string;
    actionTemplate: string;
    fields: Array<{ name: string; label: string | null; kind: string; value: string | null }>;
  } | null;
  sourceRef: ExperimentRef;
  semanticDigest: string;
  renderingDigest: string;
  observationOnly: boolean;
}
export interface AuthorizedApplicationProfile {
  id: string;
  tenantId: string;
  principalId: string;
  application: string;
  account: string;
  actingPrincipal: string;
  role: string;
  grantRef: ExperimentRef;
  origin: string;
  entrypoint: string;
  documentationPaths: string[];
  contextPath: string | null;
  recordPathTemplate: string;
  requestPathTemplate: string | null;
  allowedTargets: string[];
  validUntil: string;
  credentials: { headers: Record<string, string> };
  sourceContract: "BOUNDED_CONDITIONAL_APPLICATION_V1";
  protectionDomain: "DISPOSABLE_TEST_AUTHORITY";
  discoverySurface?: "API" | "UI" | "HYBRID";
}
export interface PreparedApplicationWire {
  url: string;
  method: string;
  contentType: string | null;
  body: string | null;
  bodyDigest: string;
  bindingRef: ExperimentRef;
  identity: NativeApplicationRequestIdentity;
  context: Record<string, unknown>;
  expectedVersion: string;
}
/** The provider asks S6 before wire; no caller-labelled read/write decision. */
export interface ApplicationPhysicalEgressFence {
  beforeWire(wire: PreparedApplicationWire): Promise<void>;
  afterWire(input: { status: number | null; responseDigest: string | null; possibleEgress: boolean }): Promise<void>;
}
