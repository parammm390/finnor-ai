"use client"

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react"
import { CentropyApiError } from "@/components/centropy/lib/api"
import { getCurrentSessionKey, useCentropyAuth } from "@/components/centropy/lib/centropy-auth"
import { onBusinessInvalidation } from "@/components/centropy/lib/business-invalidation"
import {
  ApplicationInputError,
  acquireApplication,
  applicationReferencesMatch,
  applicationUseBlockReason,
  buildApplicationAcquisitionRequest,
  buildApplicationExecutionRequest,
  cancelApplication,
  executeApplication,
  readApplicationProjection,
  readApplicationScope,
  type ApplicationAcquisitionDraft,
  type ApplicationAcquisitionRequest,
  type ApplicationExecutionDraft,
  type ApplicationExecutionRequest,
  type ApplicationModelView,
  type ApplicationReference,
  type ApplicationSemanticsScope,
  type ApplicationSession,
  type ApplicationWorkProjection,
  type ApplicationWorkSelection,
} from "./application-semantics-client"
import type {
  ApplicationModelCheck,
  ApplicationScalar,
  ApplicationState,
  LearnedApplicationOperation,
} from "../../../../finnor-os/packages/shared-types/src/application-semantics"

export type ApplicationSemanticsPanelProps = ApplicationWorkSelection & {
  onSelectWork?: (workId: string) => void
}

const sessionLabels: Record<ApplicationSession["status"], string> = {
  QUEUED: "Waiting for application acquisition",
  ACQUIRING: "Acquiring application evidence",
  MODEL_READY: "Logical model available; fresh native binding is still required",
  PLANNING: "Checking a composition; effects are not established",
  EXECUTING: "Native execution in progress; inspect original effect records",
  WAITING_OBSERVATION: "Waiting for independent outcome observation",
  COMPLETED: "Native session marked completed; independent coverage remains a separate check",
  UNKNOWN: "Outcome UNKNOWN; original responsibility is retained",
  BLOCKED: "Native work blocked; missing predicates are not success",
  CANCELLED: "New work cancelled; possible effects and original responsibility remain",
  STALE: "Logical artifact or binding is stale; current use is not established",
  FAILED: "Native work failed; this does not prove that possible effects were undone",
}
const effectLabels: Record<ApplicationSession["effects"][number]["status"], string> = {
  PREPARED: "Prepared obligation; this is not dispatch or effect proof",
  POSSIBLE_EGRESS: "An attempt may have left; do not replay it",
  PENDING: "Independent observation is pending",
  VERIFIED: "Native effect marked VERIFIED; inspect its independent observation reference",
  UNKNOWN: "Outcome UNKNOWN; original responsibility is retained",
  DENIED: "Native effect record is DENIED; this is not compensation",
}
const activeStatuses = new Set<ApplicationSession["status"]>([
  "QUEUED", "ACQUIRING", "PLANNING", "EXECUTING", "WAITING_OBSERVATION",
])

function Reference({ value }: { value: ApplicationReference }) {
  return <code style={{ overflowWrap: "anywhere" }}>
    {value.owner} / {value.id} @ {value.version} · {value.contentDigest}
  </code>
}

function ReferenceList({ title, values }: { title: string; values: ApplicationReference[] }) {
  return <details>
    <summary>{title} · {values.length} supplied reference{values.length === 1 ? "" : "s"}</summary>
    {values.length ? <ul>{values.map((value, index) =>
      <li key={`${index}:${value.owner}:${value.id}`}><Reference value={value}/></li>,
    )}</ul> : <p>No reference supplied. This is missing evidence, not a verified absence or a completed check.</p>}
  </details>
}

function JsonEvidence({ value }: { value: object }) {
  // Callers supply only schema-validated views, never a raw API/error envelope.
  return <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12 }}>
    {JSON.stringify(value, null, 2)}
  </pre>
}

function ScalarValue({ value }: { value: ApplicationScalar }) {
  if (value === null) return <span>explicit null</span>
  if (typeof value === "string") return <span style={{ whiteSpace: "pre-wrap" }}>{value}</span>
  if (typeof value === "boolean") return <span>{value ? "true" : "false"}</span>
  if (value.kind === "identity") return <span>
    Identity: {value.application} / {value.account} / {value.entity} / {value.id}
  </span>
  return <span>
    <strong>{value.decimal}</strong> · currency {value.currency} · entity {value.entity}
    {" · "}unit {value.unit} · time {value.time} · basis {value.basis}
  </span>
}

function StateValues({ value }: { value: ApplicationState }) {
  const entries = Object.entries(value)
  return entries.length ? <dl>{entries.map(([field, scalar]) => <div key={field}>
    <dt><code>{field}</code></dt><dd><ScalarValue value={scalar}/></dd>
  </div>)}</dl> : <p>No application fields supplied in this state.</p>
}

function OperationCard({ operation, accepted }: { operation: LearnedApplicationOperation; accepted: boolean }) {
  return <article>
    <h5>{operation.label || "Operation label not supplied"}</h5>
    <p><code>{operation.id}({operation.parameters.map(parameter =>
      `${parameter.name}${parameter.required ? "" : "?"}: ${parameter.kind}`,
    ).join(", ")})</code></p>
    <p>{accepted ? "This operation ID is included in the retained model check." : "This operation ID is not accepted by the supplied model check."}
      {" "}Neither statement grants dispatch authority.</p>
    {operation.parameters.length ? <details>
      <summary>Parameter signatures, exact context and schema evidence</summary>
      {operation.parameters.map((parameter, index) => <article key={`${index}:${parameter.name}`}>
        <p><code>{parameter.name}</code> · {parameter.kind} · {parameter.required ? "required" : "optional"}
          {" · "}declared maximum length {parameter.maxLength}</p>
        {parameter.values.length ? <ul>{parameter.values.map((value, valueIndex) =>
          <li key={valueIndex}><ScalarValue value={value}/></li>,
        )}</ul> : <p>No enumerated values supplied; do not infer unconstrained permission.</p>}
        {parameter.quantityContext ? <JsonEvidence value={parameter.quantityContext}/>
          : parameter.kind === "quantity" ? <p>Quantity context is missing. Exact application binding is UNKNOWN.</p> : null}
        <ReferenceList title="Parameter schema evidence" values={parameter.schemaEvidence}/>
      </article>)}
    </details> : <p>No declared parameters.</p>}
    <p>Role required: {operation.authorization.role}. Current native and external authority must still be checked.</p>
    <p>Grant reference: <Reference value={operation.authorization.grantRef}/></p>
    <p>Effect classification: {operation.effects.classification}. Replay policy: {operation.effects.replay}.</p>
    <p>Identification: {operation.uncertainty.identification}.
      {" "}Declared interaction ceiling {operation.resources.maximumInteractions};
      {" "}unresolved-effect resource count {operation.resources.unresolvedEffects}. The original parent is required.</p>
    <details>
      <summary>Preconditions, transition predictions and uncertainty</summary>
      <p>Assignments below are model predictions, not observed outcomes. Independent observation is required for completion.</p>
      <p>Field-copy assignments use current observed fields. Alternatives are correlated whole-state predictions, not independently interchangeable values.</p>
      <JsonEvidence value={{
        observedParameterBindings: operation.observedParameterBindings,
        precondition: operation.precondition,
        postcondition: operation.postcondition,
        reads: operation.reads,
        writes: operation.writes,
        effects: operation.effects,
        uncertainty: operation.uncertainty,
      }}/>
    </details>
    <details>
      <summary>Bound observer, private-binding reference and revisions</summary>
      <p>Only the binding reference is shown. No credentials, private binding payload, selectors, or interaction code are exposed.</p>
      <JsonEvidence value={{
        observerContractRef: operation.observerContractRef,
        privateBindingRef: operation.privateBindingRef,
        semanticRevision: operation.semanticRevision,
        renderingDigest: operation.renderingDigest,
        dependencies: operation.dependencies,
        evidenceRefs: operation.evidenceRefs,
      }}/>
    </details>
  </article>
}

function ModelEvidence({ model, check, now }: {
  model: ApplicationModelView
  check: ApplicationModelCheck | null
  now: number
}) {
  const envelope = model.envelope
  const inWindow = now >= Date.parse(envelope.validAfter) && now < Date.parse(envelope.validUntil)
  return <>
    <section>
      <h4>Logical model and declared supported domain</h4>
      <p>Application {model.scope.application} · application account {model.scope.account} · bound role {model.scope.role}</p>
      <p>Model: <Reference value={model.ref}/></p>
      <p>Native rights reference: {model.scope.rightsRef}. Artifact rights revision: {envelope.rights_revision}.</p>
      <p>Current role/grant, target, private binding and resource authority are revalidated by native owners, not granted here.</p>
      <details>
        <summary>Declared finite domain ceilings</summary>
        <p>These are artifact domain ceilings, not the remaining original Work allocation or measured budget headroom.</p>
        <JsonEvidence value={model.supported_domain}/>
      </details>
      <details>
        <summary>Observable state and declared signatures</summary>
        <p>Observed values are evidence within their recorded scope. They are not fresh-target outcome receipts.</p>
        <JsonEvidence value={{
          observableStateSchema: model.observable_state_schema,
          stateSchema: model.stateSchema,
          operationSignatures: model.operation_signatures,
          preconditionPredicates: model.precondition_predicates,
        }}/>
      </details>
      {model.operations.length ? model.operations.map(operation => <OperationCard
        key={operation.id}
        operation={operation}
        accepted={check?.acceptedOperationIds.includes(operation.id) === true}
      />) : <p>No logical operations supplied. Usable operation coverage is UNKNOWN.</p>}
    </section>
    <section>
      <h4>Independent evidence and model checks</h4>
      {check ? <>
        <p>Check disposition: {check.disposition} · checked at {check.checkedAt}.</p>
        <p>Checker-reported false-valid count: {check.falseValid}; false-invalid count: {check.falseInvalid}.
          {" "}These are retained finite-check counts, not universal correctness rates.</p>
        <p>Accepted operation IDs: {check.acceptedOperationIds.length ? check.acceptedOperationIds.join(", ") : "none supplied"}.</p>
        <p>Check: <Reference value={check.ref}/></p>
        <p>Independent checker: <Reference value={check.checkerRef}/></p>
        <ReferenceList title="Original check evidence" values={check.originalEvidenceRefs}/>
        {check.counterexamples.length ? <details>
          <summary>Counterexamples and remaining falsifiers</summary><JsonEvidence value={check.counterexamples}/>
        </details> : <p>No counterexamples supplied in this check. That is not a universal external proof.</p>}
      </> : <p>No independent model check supplied. Qualification is UNKNOWN, not accepted.</p>}
      <p>Observed, declared, inferred and predicted claims are separate. A checked logical model is not admission or evidence that a requested external effect occurred.</p>
      <ReferenceList title="Source observations" values={model.source_observations}/>
      <ReferenceList title="Application identity/version evidence" values={model.application_identity_and_version_evidence}/>
      <ReferenceList title="Declared type-signature evidence" values={model.declared_type_signatures}/>
      <ReferenceList title="Inferred preconditions" values={model.inferred_preconditions}/>
      <ReferenceList title="Inferred postconditions" values={model.inferred_postconditions}/>
      <ReferenceList title="Actual independent outcomes" values={model.actual_independent_outcomes}/>
      <ReferenceList title="Held-out execution evidence" values={model.held_out_execution_evidence}/>
      <ReferenceList title="Falsifier evidence" values={model.falsifier_tests}/>
      <details>
        <summary>Model contract, observer and independent-check references</summary>
        <JsonEvidence value={{
          parameterAndUnitConstraints: model.parameter_and_unit_constraints,
          effectAndObligationContracts: model.effect_and_obligation_contracts,
          postconditionObservers: model.postcondition_observers,
          transitionModelAndUncertainty: model.transition_model_and_uncertainty,
          compositionalRules: model.compositional_rules,
          permittedExplorationRecord: model.permitted_exploration_record,
          checkerResults: model.checker_results,
          independentCheckRefs: envelope.independent_check_refs,
          observedClaims: envelope.observed_claims,
          inferredClaims: envelope.inferred_claims,
          predictedClaims: envelope.predicted_claims,
          unresolvedClaims: envelope.unresolved_claims,
        }}/>
      </details>
    </section>
    <section>
      <h4>Validity and drift</h4>
      <p>Artifact lifecycle: {envelope.lifecycle_state}. Declared validity window: {inWindow ? "within its time bounds" : "not currently within its time bounds"}.
        {" "}Time bounds alone do not establish current native authority.</p>
      <p>Valid after {envelope.validAfter}; valid until {envelope.validUntil}. Knowledge cut: {envelope.knowledge_cut}.</p>
      <p>Missing evidence remains UNKNOWN. Semantic validity follows the sound dependency closure; private bindings require lawful current revalidation.</p>
      <ReferenceList title="Native invalidation dependencies" values={envelope.invalidation_dependencies}/>
      <ReferenceList title="Drift detector references" values={model.drift_detectors}/>
      <details>
        <summary>Source revisions, fingerprints and compiler commitments</summary>
        <JsonEvidence value={{
          artifactId: envelope.artifact_id,
          schemaRevision: envelope.schema_revision,
          contentDigest: envelope.content_digest,
          sourceRevisionVector: envelope.source_revision_vector,
          applicationFingerprints: envelope.application_fingerprints,
          grammar: envelope.grammarRef,
          checker: envelope.checkerRef,
          runtime: envelope.runtimeRef,
          dependencyLockDigest: envelope.dependency_lock_digest,
          runtimeDigest: envelope.runtime_digest,
          validities: model.validities,
          provenance: envelope.provenance,
        }}/>
      </details>
    </section>
  </>
}

function SessionEvidence({ session, now }: { session: ApplicationSession; now: number }) {
  const { model, composition } = session
  return <>
    <section>
      <h4>{sessionLabels[session.status]}</h4>
      <p>Session {session.id} · native generation {session.generation} · parent session {session.parentId}.
        {" "}{session.id === session.parentId ? "Acquisition parent." : "Fresh execution child; original allocation is retained."}</p>
      <p>Reason: {session.reason ?? "No reason supplied."}</p>
      <p>Original parent: <Reference value={session.originalParentRef}/></p>
      <p>Original deadline: {session.deadlineAt}
        {now >= Date.parse(session.deadlineAt) ? " · expired; no fresh work is implied" : " · this is not a renewed allocation"}.</p>
      {session.cancelledAt ? <p>Cancellation requested at {session.cancelledAt}; this is not rollback or resource release.</p> : null}
    </section>
    {model ? <ModelEvidence model={model} check={session.check} now={now}/>
      : <section><h4>Logical model not yet supplied</h4>
        <p>Operation signatures, supported domain, source validity and independent qualification are not yet established. There is no successful substitute or simulated application binding.</p>
      </section>}
    <section>
      <h4>Planned composition and gaps</h4>
      {composition ? <>
        <p>Disposition: {composition.disposition}. Explored search nodes: {composition.exploredNodes}.</p>
        <p>Target: <ScalarValue value={composition.target}/></p>
        <p>Composition deadline: {composition.deadlineAt}. No execution authority is granted by this plan.</p>
        <p>Composition: <Reference value={composition.ref}/></p>
        <p>Initial observation: <Reference value={composition.initialObservationRef}/></p>
        <h5>Requested goal</h5><StateValues value={composition.goal}/>
        <ol>{composition.steps.map((step, index) => <li key={`${index}:${step.id}`}>
          <article>
            <h5>Step {step.id} · operation {step.operationId}</h5>
            <details><summary>Exact step parameters</summary><StateValues value={step.parameters}/></details>
            <details><summary>Fresh-parameter observation bindings</summary><JsonEvidence value={step.parameterObservations}/></details>
            <details><summary>Expected state — prediction only</summary><StateValues value={step.expectedState}/></details>
            <details><summary>Conditional state — permitted observation still required</summary><StateValues value={step.conditionalState}/></details>
            <p>Independent observation is required. A predicted state is not effect completion.</p>
          </article>
        </li>)}</ol>
        {composition.gaps.length ? <>
          <p>Unresolved composition gaps; these are not completed steps:</p>
          <ul>{composition.gaps.map((gap, index) => <li key={`${index}:${gap.stepId}`}>
            Step {gap.stepId} · {gap.code} · independent observation required
          </li>)}</ul>
        </> : <p>No gaps supplied by the plan. This does not establish the external goal or remove required observations.</p>}
      </> : <p>No checked composition supplied. Planned steps, fresh binding and goal coverage remain unestablished.</p>}
    </section>
    <section>
      <h4>Effects and original UNKNOWN responsibilities</h4>
      <p>Cancellation stops new work only. It does not undo a possible effect, compensate an UNKNOWN outcome, release obligations, or reset the original parent/deadline.</p>
      {session.effects.length ? session.effects.map((effect, index) => <article
        key={`${index}:${effect.effect_id}`}
        data-application-effect-state={effect.status}
      >
        <h5>{effect.status}: {effectLabels[effect.status]}</h5>
        <p>Original obligation: <Reference value={effect.obligation_ref}/></p>
        <p>Canonical effect ID: <code>{effect.effect_id}</code>. Effect state: {effect.effect_status}.</p>
        <p>Original request row: <code>{effect.request_id}</code>. Native action state: {effect.action_status}.</p>
        <p>Possible egress recorded: {effect.possible_egress ? "yes — cancellation does not undo it" : "no flag supplied by this record; not universal absence proof"}.</p>
        {effect.observation_ref ? <p>Observation: <Reference value={effect.observation_ref}/></p>
          : <p>No independent observation reference supplied. Outcome coverage remains UNKNOWN, even if a status label says VERIFIED.</p>}
        {effect.verification ? <details><summary>Independent native verification — separate from the response</summary>
          <p>{effect.verification.state} · {effect.verification.qualification} · checked at {effect.verification.checkedAt}.</p>
          <p>Basis: {effect.verification.basis}</p>
          <p>Evidence: <Reference value={effect.verification.evidenceRef}/></p>
          {effect.verification.requestObservationRef ? <p>Request observation: <Reference value={effect.verification.requestObservationRef}/></p>
            : <p>Request-observation reference not supplied.</p>}
          <p>Money is unmetered; neither protected qualification nor resource release is granted.</p>
        </details> : <p>No independent native verification supplied. Business completion remains unestablished.</p>}
      </article>) : <p>No effect records supplied. That is not proof that no attempt occurred or that the external goal is complete.</p>}
      {model ? <>
        <ReferenceList title="Original S6 obligation references" values={model.envelope.S6_obligation_refs}/>
        <ReferenceList title="Provider observation references" values={model.envelope.provider_observation_refs}/>
      </> : null}
    </section>
    <section>
      <h4>Original resources and cost qualification</h4>
      <p>Billing: {session.billing}. Original resource release: {session.resourceReleaseGranted ? "granted" : "not granted"}.</p>
      <p>S5 charges describe conservative occupation of the original parent, across its children. They are not provider billing, per-session totals or renewed allowances.</p>
      <dl className="ct-evidence__values">
        <div><dt>Money / currency-qualified billing</dt><dd data-application-cost="money">UNKNOWN</dd></div>
        <div><dt>Complete attributable human work</dt><dd data-application-cost="humanSeconds">UNKNOWN</dd></div>
        <div><dt>Aggregate simultaneous peak bytes</dt><dd data-application-cost="aggregatePeakBytes">UNKNOWN</dd></div>
      </dl>
      <details><summary>Original resource charges · {session.charges.length} supplied records</summary>
        {session.charges.length ? session.charges.map(charge => <article key={charge.chargeKey}>
          <h5>{charge.phase} · resource {charge.resourceId}</h5>
          <p>Charged units: {charge.units} {charge.unit}. Original limit: <code>{charge.limit}</code>.
            {" "}Cumulative original occupation after this charge: <code>{charge.usedAfter}</code> {charge.unit}.</p>
          <p>Recorded at {charge.createdAt}. Qualification: {charge.qualification}. Money: UNKNOWN — {charge.costs.status}.</p>
          <p>Charge: <Reference value={charge.ref}/></p>
          <details><summary>Allocation, reservation, consumption and request lineage</summary><JsonEvidence value={{
            originalParentRef: charge.originalParentRef, allocationRef: charge.allocationRef,
            reservationRef: charge.reservationRef, consumptionRef: charge.consumptionRef,
            requestRef: charge.requestRef, requestDigest: charge.requestDigest, chargeKey: charge.chargeKey,
          }}/></details>
        </article>) : <p>No charges supplied. This is not evidence of free work or available budget.</p>}
      </details>
      {model ? <>
        <p>Original resource grant: <Reference value={model.envelope.resource_grant_ref}/></p>
        <ReferenceList title="Build, learning and compute cost references" values={model.envelope.build_learning_compute_cost_refs}/>
        <ReferenceList title="Attributable human-work references" values={model.envelope.attributable_human_work_refs}/>
      </> : <p>No model resource-grant reference supplied. Resource qualification is UNKNOWN.</p>}
    </section>
    <section>
      <h4>Separate admission and production gates</h4>
      <p>Logical model check: {session.check?.disposition ?? "UNKNOWN — no check supplied"}.</p>
      <p>External conformance is empirical within retained evidence, not universal proof.</p>
      <p>Protected admission: not granted. A logical model or plan does not grant execution authority. Production activation: not established by this projection.</p>
      <p>A fresh-use request is evaluated by current native and external authority. This panel cannot approve protected execution or production activation.</p>
      {model?.envelope.admitted_domain_ref ? <p>Referenced domain (not a protected or execution grant):
        {" "}<Reference value={model.envelope.admitted_domain_ref}/></p> : <p>No admitted-domain reference supplied.</p>}
    </section>
  </>
}

function ApplicationAcquisitionForm({ busy, blockedReason, onSubmit }: {
  busy: boolean; blockedReason: string | null; onSubmit: (draft: ApplicationAcquisitionDraft) => void
}) {
  const helpId = useId()
  const [draft, setDraft] = useState<ApplicationAcquisitionDraft>({
    profileIdsJson: "", targetsJson: "", resourceDemandJson: "", deadlineAt: "",
  })
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); onSubmit(draft) }
  return <section>
    <h4>Request bounded authorized application acquisition</h4>
    <p id={helpId}>Use existing native profile references, admitted discovery targets and the original requested resources/deadline.
      {" "}Only authorized development exploration is supported. Do not enter credentials, browser handles, selectors or private source bodies.
      {" "}A native response is not a learned model, independent outcome, admission or execution grant.</p>
    {blockedReason ? <p role="status">{blockedReason}</p> : null}
    <form onSubmit={submit} aria-describedby={helpId}>
      <fieldset disabled={busy || Boolean(blockedReason)} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: "grid", gap: 14 }}>
        <label>Existing discovery-profile UUIDs — JSON array, 1–8 distinct references
          <textarea name="profileIds" value={draft.profileIdsJson} onChange={event => setDraft({ ...draft, profileIdsJson: event.target.value })}
            required rows={2} maxLength={65536} spellCheck={false} autoComplete="off"/>
        </label>
        <label>Authorized discovery targets — JSON array, 2–16 distinct identities
          <textarea name="targets" value={draft.targetsJson} onChange={event => setDraft({ ...draft, targetsJson: event.target.value })}
            required rows={5} maxLength={65536} spellCheck={false} autoComplete="off" aria-describedby={helpId}/>
        </label>
        <p>Each target has string fields: kind (identity), application, account, entity and id. No demonstrated target becomes a fresh execution target.</p>
        <label>Original resource demand — JSON array, 1–2 resource bindings
          <textarea name="resourceDemand" value={draft.resourceDemandJson} onChange={event => setDraft({ ...draft, resourceDemandJson: event.target.value })}
            required rows={3} maxLength={65536} spellCheck={false} autoComplete="off" aria-describedby={helpId}/>
        </label>
        <p>Each demand has resourceId, unit (request or seconds), and amount as an exact integer string from 0 to 9999. Native S5 validates the actual reservation; these are not billing dollars.</p>
        <label>Original deadline — ISO timestamp with explicit time-zone offset
          <input name="deadlineAt" value={draft.deadlineAt} onChange={event => setDraft({ ...draft, deadlineAt: event.target.value })}
            required maxLength={64} autoComplete="off" spellCheck={false}/>
        </label>
        <p>The native development window is at most one hour and must fit current profile/grant validity. Child execution, recovery and cancellation do not renew it.</p>
        <button type="submit">Request acquisition and native reservation</button>
      </fieldset>
    </form>
  </section>
}

function FreshApplicationUseForm({ busy, blockedReason, onSubmit }: {
  busy: boolean
  blockedReason: string | null
  onSubmit: (draft: ApplicationExecutionDraft) => void
}) {
  const helpId = useId()
  const [freshWorkId, setFreshWorkId] = useState("")
  const [executionProfileId, setExecutionProfileId] = useState("")
  const [targetId, setTargetId] = useState("")
  const [goalJson, setGoalJson] = useState("")
  const [parametersJson, setParametersJson] = useState("{}")
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    onSubmit({ freshWorkId, executionProfileId, targetId, goalJson, parametersJson })
  }
  return <section>
    <h4>Request fresh native application use</h4>
    <p>Bind this frozen acquisition model to a different existing native Work and a fresh authorized record.
      {" "}The original parent/resources/deadline remain unchanged. Current role/grant, application binding and independent observations are checked by native owners.</p>
    <p id={helpId}>Goal and parameters must be strict JSON objects. Values may be text, boolean, explicit null, a scoped identity
      {" "}(kind, application, account, entity, id), or an exact quantity
      {" "}(kind: quantity, decimal, currency, entity, unit, time, basis).
      {" "}At most 16 application fields are supported. All quantity/context fields are strings. Numeric JSON literals, arrays, credentials and secrets are rejected.
      {" "}Never paste a password, API key, token, private key, cookie, credential payload or authenticated URL.</p>
    {blockedReason ? <p role="status">{blockedReason}</p> : <p>A model check is not effect authority. Submission requests fresh native validation; no automatic replay or retry is performed.</p>}
    <form onSubmit={submit} aria-describedby={helpId}>
      <fieldset disabled={busy || Boolean(blockedReason)} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: "grid", gap: 14 }}>
        <div className="ct-evidence__fields">
          <label>Existing fresh Work UUID — different from acquisition Work
            <input name="freshWorkId" value={freshWorkId} onChange={event => setFreshWorkId(event.target.value)}
              required maxLength={36} autoComplete="off" spellCheck={false}/>
          </label>
          <label>Existing execution-profile UUID (reference only)
            <input name="executionProfileId" value={executionProfileId} onChange={event => setExecutionProfileId(event.target.value)}
              required maxLength={36} autoComplete="off" spellCheck={false}/>
          </label>
          <label>Current authorized target identifier
            <input name="targetId" value={targetId} onChange={event => setTargetId(event.target.value)}
              required maxLength={256} autoComplete="off" spellCheck={false}/>
          </label>
        </div>
        <label>Goal — strict application-state JSON
          <textarea name="goal" value={goalJson} onChange={event => setGoalJson(event.target.value)}
            required rows={5} maxLength={65536} spellCheck={false} autoComplete="off" aria-describedby={helpId}/>
        </label>
        <label>Parameters — strict application-state JSON
          <textarea name="parameters" value={parametersJson} onChange={event => setParametersJson(event.target.value)}
            required rows={5} maxLength={65536} spellCheck={false} autoComplete="off" aria-describedby={helpId}/>
        </label>
        <button type="submit">Request fresh use and native checks</button>
      </fieldset>
    </form>
  </section>
}

interface Fence {
  key: string
  sessionKey: string | null
  ready: boolean
  stamp: number
}
interface Marker {
  stamp: number
  sequence: number
  sessionKey: string
}
interface Snapshot {
  stamp: number
  scope: ApplicationSemanticsScope
  data: ApplicationWorkProjection
  readAt: string
}
interface Notice {
  stamp: number
  phase: "idle" | "reading" | "ready" | "error"
  message: string
}
interface ActionNotice {
  stamp: number
  busy: boolean
  message: string
}
interface UnconfirmedUse {
  stamp: number
  sourceKey: string
  tenantId: string
  principalId: string
  kind: "acquire" | "execute"
  sessionId: string | null
  workId: string
  parentId: string | null
  originalParentRef: ApplicationReference | null
}

export function ApplicationSemanticsPanel(props: ApplicationSemanticsPanelProps) {
  const { session, loading, authError, role, roleLoading, roleError } = useCentropyAuth()
  const workSelection = useMemo<ApplicationWorkSelection>(() => ({
    root: { entityType: props.root.entityType, entityId: props.root.entityId },
    workId: props.workId,
  }), [props.root.entityType, props.root.entityId, props.workId])
  const scopeKey = JSON.stringify(workSelection)
  const [available, setAvailable] = useState(false)
  // Supabase identity is only a session/token freshness fence. Native principal
  // and tenant come from authenticated /me, never decoded JWT claims or inputs.
  const sessionKey = session ? `${session.user.id}:${session.access_token}` : null
  const ready = Boolean(sessionKey && getCurrentSessionKey() === sessionKey
    && !loading && !authError && role === "owner" && !roleLoading && !roleError && available)
  const generation = useRef(0)
  const fence = useRef<Fence | null>(null)
  if (!fence.current || fence.current.key !== scopeKey
    || fence.current.sessionKey !== sessionKey || fence.current.ready !== ready) {
    // The render mask changes before effects run, so old private DOM/form values
    // cannot survive a new scope render. The same monotone counter fences reads.
    fence.current = { key: scopeKey, sessionKey, ready, stamp: ++generation.current }
  }
  const stamp = fence.current.stamp
  const activeRead = useRef<{ marker: Marker; controller: AbortController } | null>(null)
  const activeAction = useRef<Marker | null>(null)
  const actionController = useRef<AbortController | null>(null)
  const nativeScope = useRef<ApplicationSemanticsScope | null>(null)
  // Only an uncertain transport fence is retained across reauthentication. It
  // contains no parameters/result/token and cannot render until native identity
  // and scope are freshly matched. Canonical records remain the only truth.
  const unconfirmedRef = useRef<UnconfirmedUse | null>(null)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [actionNotice, setActionNotice] = useState<ActionNotice | null>(null)
  const [selection, setSelection] = useState<{ stamp: number; id: string } | null>(null)
  const [unconfirmed, setUnconfirmed] = useState<UnconfirmedUse | null>(null)
  const [recordedWork, setRecordedWork] = useState<{ stamp: number; id: string } | null>(null)
  const [formRevision, setFormRevision] = useState(0)
  const [clock, setClock] = useState(() => Date.now())
  const visible = ready && snapshot?.stamp === stamp ? snapshot.data : null
  const selected = visible?.sessions.find(candidate => selection?.stamp === stamp && candidate.id === selection.id)
    ?? visible?.sessions[0] ?? null
  const busy = actionNotice?.stamp === stamp && actionNotice.busy
  const currentNotice = notice?.stamp === stamp ? notice : null
  const currentActionNotice = actionNotice?.stamp === stamp ? actionNotice : null
  const uncertain = unconfirmed?.stamp === stamp ? unconfirmed : null

  const isCurrent = useCallback((marker: Marker) => Boolean(
    fence.current?.ready && fence.current.stamp === marker.stamp
    && generation.current === marker.sequence && getCurrentSessionKey() === marker.sessionKey
    && navigator.onLine && document.visibilityState === "visible",
  ), [])

  const erasePrivate = useCallback(() => {
    setSnapshot(null)
    setSelection(null)
    setRecordedWork(null)
    setFormRevision(revision => revision + 1)
  }, [])

  const readCanonical = useCallback(async (marker: Marker, message: string): Promise<Snapshot | null> => {
    if (!isCurrent(marker)) return null
    activeRead.current?.controller.abort()
    const request = { marker, controller: new AbortController() }
    activeRead.current = request
    setNotice({ stamp: marker.stamp, phase: "reading", message })
    try {
      const transport = {
        sessionKey: marker.sessionKey,
        signal: request.controller.signal,
      }
      const scope = await readApplicationScope(workSelection, transport)
      if (!isCurrent(marker)) return null
      if (nativeScope.current && JSON.stringify(nativeScope.current) !== JSON.stringify(scope)) erasePrivate()
      nativeScope.current = scope
      const data = await readApplicationProjection(scope, transport)
      if (!isCurrent(marker) || request.controller.signal.aborted) return null
      const pending = unconfirmedRef.current
      if (pending && pending.sourceKey === scopeKey && pending.tenantId === scope.tenantId
        && pending.principalId === scope.principalId) {
        const fenced = { ...pending, stamp: marker.stamp }
        unconfirmedRef.current = fenced
        setUnconfirmed(fenced)
        const destination = pending.workId === scope.workId ? data
          : await readApplicationProjection({ ...scope, workId: pending.workId }, transport)
        if (!isCurrent(marker) || request.controller.signal.aborted) return null
        const recorded = destination.sessions.find(candidate => candidate.id === pending.sessionId
          && (pending.kind === "acquire"
            ? candidate.id === candidate.parentId
            : candidate.parentId === pending.parentId && pending.originalParentRef !== null
              && applicationReferencesMatch(candidate.originalParentRef, pending.originalParentRef)))
        if (recorded) {
          // Registration is observed, not business completion or effect closure.
          if (pending.kind === "execute") setRecordedWork({ stamp: marker.stamp, id: destination.workId })
          unconfirmedRef.current = null
          setUnconfirmed(null)
        }
      } else if (pending) {
        unconfirmedRef.current = null
        setUnconfirmed(null)
      }
      const now = Date.now()
      setClock(now)
      const next = { stamp: marker.stamp, scope, data, readAt: new Date(now).toISOString() }
      setSnapshot(next)
      setNotice({
        stamp: marker.stamp,
        phase: "ready",
        message: data.sessions.length
          ? "Canonical scope matched. Inspect qualification, binding gaps and independent outcomes separately."
          : "No X2 application sessions supplied for this native Work. Authorized acquisition may be requested; no model or grant is implied.",
      })
      return next
    } catch (error) {
      if (!isCurrent(marker)) return null
      erasePrivate()
      setNotice({
        stamp: marker.stamp,
        phase: "error",
        message: error instanceof CentropyApiError && [401, 403, 404].includes(error.status)
          ? "Current application evidence is unavailable in this access scope. Private records and inputs have been cleared."
          : "The current-use projection could not be verified. Private records and inputs have been cleared; no ready or complete claim is retained.",
      })
      return null
    } finally {
      if (activeRead.current === request) activeRead.current = null
    }
  }, [workSelection, scopeKey, isCurrent, erasePrivate])

  const refresh = useCallback(async (clear: boolean) => {
    if (!ready || !sessionKey || fence.current?.stamp !== stamp || activeAction.current?.stamp === stamp
      || !navigator.onLine || document.visibilityState !== "visible") return
    const marker = { stamp, sequence: ++generation.current, sessionKey }
    activeRead.current?.controller.abort()
    if (clear) erasePrivate()
    await readCanonical(marker, "Reading the current native Work, principal, tenant and root scope…")
  }, [ready, sessionKey, stamp, erasePrivate, readCanonical])

  const invalidate = useCallback((message: string) => {
    generation.current++
    activeRead.current?.controller.abort()
    actionController.current?.abort()
    activeAction.current = null
    erasePrivate()
    setUnconfirmed(null)
    setActionNotice(null)
    setNotice({ stamp, phase: "idle", message })
  }, [stamp, erasePrivate])

  useEffect(() => {
    const counter = generation
    const reads = activeRead
    const actions = activeAction
    const controls = actionController
    erasePrivate()
    nativeScope.current = null
    setNotice(null)
    setActionNotice(null)
    setUnconfirmed(null)
    if (unconfirmedRef.current?.sourceKey !== scopeKey) unconfirmedRef.current = null
    actions.current = null
    if (ready && document.visibilityState === "visible") void refresh(false)
    return () => {
      counter.current++
      reads.current?.controller.abort()
      reads.current = null
      controls.current?.abort()
      controls.current = null
      actions.current = null
    }
  }, [stamp, ready, scopeKey, refresh, erasePrivate])

  useEffect(() => {
    const usable = () => navigator.onLine && document.visibilityState === "visible"
    setAvailable(usable())
    const environment = () => {
      if (fence.current?.stamp !== stamp) return
      setAvailable(usable())
      invalidate("Connectivity or visibility changed. Private evidence and inputs are cleared until current identity and scope are revalidated.")
      if (usable()) void refresh(false)
    }
    document.addEventListener("visibilitychange", environment)
    window.addEventListener("offline", environment)
    window.addEventListener("online", environment)
    window.addEventListener("focus", environment)
    return () => {
      document.removeEventListener("visibilitychange", environment)
      window.removeEventListener("offline", environment)
      window.removeEventListener("online", environment)
      window.removeEventListener("focus", environment)
    }
  }, [stamp, refresh, invalidate])

  useEffect(() => onBusinessInvalidation(signal => {
    if (!signal.tags.some(tag => ["work", "company-brain", "authority", "connections", "source", "workspace"].includes(tag))) return
    // The maintained client publishes our own write acknowledgement too; it is
    // not a revocation event or completion. Its explicit post-write read owns it.
    if (signal.source === "mutation" && /company-brain\/application-(?:acquire|execute|cancel)$/.test(signal.path ?? "")) return
    invalidate("Owner state or access changed. Private evidence and inputs are cleared pending current-use revalidation.")
    void refresh(false)
  }), [invalidate, refresh])

  useEffect(() => {
    if (!visible || busy) return
    const timer = window.setTimeout(() => {
      if (document.visibilityState === "visible") void refresh(false)
    }, visible.sessions.some(candidate => activeStatuses.has(candidate.status)) || uncertain ? 3000 : 15000)
    return () => window.clearTimeout(timer)
  }, [visible, busy, uncertain, refresh])

  useEffect(() => {
    if (!selected) return
    const now = Date.now()
    const boundaries = [selected.deadlineAt, selected.model?.envelope.validAfter, selected.model?.envelope.validUntil]
      .filter((value): value is string => Boolean(value))
      .map(value => Date.parse(value))
      .filter(value => value > now)
    if (!boundaries.length) return
    const timer = window.setTimeout(() => {
      if (fence.current?.stamp !== stamp) return
      setClock(Date.now())
      if (document.visibilityState === "visible") void refresh(true)
    }, Math.min(Math.min(...boundaries) - now + 1, 2_147_483_647))
    return () => window.clearTimeout(timer)
  }, [selected, stamp, refresh])

  async function control(kind: "acquire" | "execute" | "cancel", draft?: ApplicationExecutionDraft | ApplicationAcquisitionDraft) {
    if (!ready || !sessionKey || !visible || !snapshot || snapshot.stamp !== stamp || fence.current?.stamp !== stamp
      || getCurrentSessionKey() !== sessionKey || activeAction.current?.stamp === stamp
      || currentNotice?.phase === "reading" || !navigator.onLine || document.visibilityState !== "visible") return
    if (kind !== "cancel" && unconfirmedRef.current?.stamp === stamp) {
      setActionNotice({ stamp, busy: false, message: "The original request is not yet observed in canonical native state. Refresh or stop new work; do not replay it." })
      return
    }
    let executionRequest: ApplicationExecutionRequest | undefined
    let acquisitionRequest: ApplicationAcquisitionRequest | undefined
    const originalScope = snapshot.scope
    try {
      if (kind === "acquire" && draft && "profileIdsJson" in draft) {
        acquisitionRequest = buildApplicationAcquisitionRequest(originalScope, draft, crypto.randomUUID())
      } else if (kind === "execute" && selected && draft && "freshWorkId" in draft) {
        executionRequest = buildApplicationExecutionRequest(originalScope, selected.id, draft, crypto.randomUUID())
      } else if (kind !== "cancel") return
    } catch (error) {
      setActionNotice({ stamp, busy: false, message: error instanceof ApplicationInputError ? error.message
        : "The exact input could not be validated. No native request was sent." })
      return
    }
    const originalSessionId = selected?.id
    const marker = { stamp, sequence: ++generation.current, sessionKey }
    const controller = new AbortController()
    const transport = { sessionKey, signal: controller.signal }
    activeAction.current = marker
    actionController.current = controller
    activeRead.current?.controller.abort()
    setSnapshot(null)
    setActionNotice({ stamp, busy: true, message: "Rechecking current native identity, access and Work before the request. No authority, effect or release receipt is inferred." })
    try {
      const current = await readCanonical(marker, "Revalidating canonical scope before the native request…")
      if (!isCurrent(marker)) return
      if (!current) {
        setActionNotice({ stamp, busy: false, message: "No native request was sent: current scope could not be verified." })
        return
      }
      if (JSON.stringify(current.scope) !== JSON.stringify(originalScope)) {
        erasePrivate()
        setActionNotice({ stamp, busy: false, message: "Native identity or authority epoch changed. Inputs cleared; no request was sent." })
        return
      }
      const original = current.data.sessions.find(candidate => candidate.id === originalSessionId)
      if (kind === "acquire" && current.data.sessions.length) {
        setActionNotice({ stamp, busy: false, message: "This Work already has canonical application sessions. Inspect them; a new acquisition must not reset original responsibility." })
        return
      }
      if (kind === "execute") {
        const block = original ? applicationUseBlockReason(original, Date.now()) : "The selected acquisition parent is not supplied in current scope."
        if (block || !executionRequest) {
          setActionNotice({ stamp, busy: false, message: block ?? "The exact request is unavailable. No native request was sent." })
          return
        }
        // A fresh Work read also prevents a lost acknowledgement/reload from
        // becoming another submission with a newly generated effect identity.
        const fresh = await readApplicationProjection({ ...current.scope, workId: executionRequest.workId }, transport)
        if (!isCurrent(marker)) return
        if (fresh.sessions.length) {
          setRecordedWork({ stamp, id: fresh.workId })
          setActionNotice({ stamp, busy: false, message: "That Work already contains native application sessions. Open its original records; no repeat request was sent." })
          return
        }
      }
      if (!isCurrent(marker)) return
      if (kind !== "cancel") {
        const pending: UnconfirmedUse = {
          stamp, sourceKey: scopeKey, tenantId: current.scope.tenantId, principalId: current.scope.principalId,
          kind, sessionId: null, workId: executionRequest?.workId ?? current.scope.workId,
          parentId: kind === "execute" ? original?.id ?? null : null,
          originalParentRef: kind === "execute" ? original?.originalParentRef ?? null : null,
        }
        unconfirmedRef.current = pending
        setUnconfirmed(pending)
      }
      erasePrivate()
      let responseMessage: string
      try {
        const registered = kind === "execute" && executionRequest
          ? await executeApplication(current.scope, executionRequest, transport)
          : kind === "acquire" && acquisitionRequest
            ? await acquireApplication(current.scope, acquisitionRequest, transport)
            : await cancelApplication(current.scope, transport)
        if (!isCurrent(marker)) return
        if (registered && unconfirmedRef.current?.stamp === stamp) {
          const pending = { ...unconfirmedRef.current, sessionId: registered.sessionId }
          unconfirmedRef.current = pending
          setUnconfirmed(pending)
        }
        responseMessage = kind === "cancel"
          ? "The native stop-request response returned for this Work. Only canonical records establish new-work cancellation; possible effects and original responsibility are not undone."
          : "The native request response returned. Only canonical registration and independent observations establish its state; no business completion or grant is inferred."
      } catch (error) {
        if (!isCurrent(marker)) return
        if (kind === "acquire" && error instanceof CentropyApiError && error.status === 404
          && error.details && typeof error.details === "object" && "code" in error.details
          && error.details.code === "X2_ACQUISITION_PROFILE_UNAVAILABLE") {
          unconfirmedRef.current = null
          setUnconfirmed(null)
          responseMessage = "The native owner refused an unavailable profile before registration. No acquisition was registered by this request. Correct the profile input before requesting acquisition."
        } else if (error instanceof CentropyApiError && [401, 403, 404].includes(error.status)) {
          erasePrivate()
          setNotice({ stamp, phase: "error", message: "Current native access was denied or unavailable. Private evidence and inputs are cleared. Original responsibility remains with its native owner." })
          return
        } else {
          responseMessage = "The native request outcome is unconfirmed. No automatic retry or replay occurs; only current canonical records can reconcile the original request."
        }
      }
      if (!isCurrent(marker)) return
      setSnapshot(null)
      await readCanonical(marker, "Reading the canonical projection after the native response; no optimistic receipt is shown…")
      if (isCurrent(marker)) setActionNotice({ stamp, busy: false, message: responseMessage })
    } catch {
      if (!isCurrent(marker)) return
      erasePrivate()
      setNotice({ stamp, phase: "error", message: "Current native scope or fresh Work could not be verified. Private evidence and inputs cleared; no ready or completion claim is retained." })
    } finally {
      if (activeAction.current === marker) activeAction.current = null
      if (actionController.current === controller) actionController.current = null
      if (isCurrent(marker)) setActionNotice(previous => previous?.stamp === stamp ? { ...previous, busy: false } : previous)
    }
  }

  const blockReason = !selected ? "Select a current native application session."
    : uncertain ? "An original native request remains unconfirmed. Only a current canonical registration can remove this transport replay fence; effect responsibility remains separate."
      : currentNotice?.phase === "reading" ? "Wait for the current-use scope read to finish."
        : applicationUseBlockReason(selected, clock)
  const boundaryMessage = loading || roleLoading ? "Revalidating authentication and workspace rights. Private application evidence is hidden."
    : !session ? "Sign in to read private native Work application evidence."
      : authError || roleError || !role ? "Current authentication or rights could not be verified. Private application evidence is hidden."
        : !available ? "Offline or hidden view. Private evidence and inputs are cleared; reconnecting requires a new current-use read."
          : "Waiting for a current native scope read."

  return <div className="ct-evidence ct-application-semantics"
    data-application-work={visible?.workId ?? "none"}
    data-application-session={selected?.id ?? "none"}
    data-application-status={selected?.status ?? "none"}
    aria-busy={Boolean(busy || currentNotice?.phase === "reading")}
  >
    <h3>Application operations · FRONTIER5.X2</h3>
    <p>Learned logical software semantics in maintained native Work. Acquisition, evidence, fresh binding, independent effects, admission and production activation are separate.</p>
    <p>References are supplied commitments, not signatures or grants. This panel checks scope and reference linkage; native owners verify the referenced evidence.</p>
    <p role={currentNotice?.phase === "error" ? "alert" : "status"} aria-live="polite">
      {ready ? currentNotice?.message ?? "Reading current native application scope…" : boundaryMessage}
    </p>
    {ready && currentActionNotice ? <p role="status" aria-live="polite">{currentActionNotice.message}</p> : null}
    <div className="ct-evidence__actions">
      <button type="button" disabled={!ready || busy} onClick={() => void refresh(true)}>Refresh current scope</button>
      {visible?.sessions.length ? <button type="button" disabled={busy || currentNotice?.phase === "reading"
        || visible.sessions.every(candidate => candidate.cancelledAt !== null)}
        onClick={() => void control("cancel")}>Request stop of new work for this Work — not rollback</button> : null}
    </div>
    {visible ? <>
      <p>Canonical Work {visible.workId} · root {visible.root.entityType} / {visible.root.entityId}.</p>
      <p>Tenant {visible.tenantId} · native principal {visible.principalId}.
        {" "}Last successful scope read: {snapshot?.readAt}. No resolved transport response is cached.</p>
      <p>Neither an admission nor a production-activation receipt is supplied by this projection.</p>
      {recordedWork?.stamp === stamp && props.onSelectWork ? <button type="button" disabled={busy || currentNotice?.phase === "reading"}
        onClick={() => {
          if (fence.current?.stamp === stamp && getCurrentSessionKey() === sessionKey && navigator.onLine) props.onSelectWork?.(recordedWork.id)
        }}>Open recorded fresh Work · {recordedWork.id} — outcome still requires independent evidence</button> : null}
      {visible.sessions.length > 1 ? <label>Native application session
        <select value={selected?.id ?? ""} disabled={busy || currentNotice?.phase === "reading"}
          onChange={event => setSelection({ stamp, id: event.target.value })}>
          {visible.sessions.map(candidate => <option key={candidate.id} value={candidate.id}>
            {candidate.id} · {candidate.status}
          </option>)}
        </select>
      </label> : null}
      {selected ? <>
        <SessionEvidence session={selected} now={clock}/>
        <FreshApplicationUseForm
          key={`${stamp}:${formRevision}:${selected.id}`}
          busy={busy}
          blockedReason={blockReason}
          onSubmit={draft => void control("execute", draft)}
        />
      </> : <ApplicationAcquisitionForm
        key={`${stamp}:${formRevision}:acquire`}
        busy={busy}
        blockedReason={uncertain ? "The original acquisition request is unconfirmed. Do not renew its resources or deadline by submitting another request."
          : currentNotice?.phase === "reading" ? "Wait for current-use revalidation." : null}
        onSubmit={draft => void control("acquire", draft)}
      />}
    </> : <p>No private model, plan, costs or ready/complete claim is retained without a verified current-use projection.</p>}
  </div>
}
