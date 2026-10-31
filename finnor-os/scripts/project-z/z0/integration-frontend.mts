import type { Replace } from "./prepare-integration.mts";

/** Proposed shared mount/client changes. Never writes a shared file. */
export async function frontendIntegration(replace: Replace) {
  const client = "src/components/centropy/canvas/application-semantics-client.ts";
  const panel = "src/components/centropy/canvas/ApplicationSemanticsPanel.tsx";
  await replace(client, "  protectedReceipt: z.null(),\n  ref: ApplicationReferenceSchema,\n}).strict()\n\nconst sessionSchema",
    `  protectedReceipt: z.null(),
  ref: ApplicationReferenceSchema,
  childLimit: unsignedInteger.optional(),
  childUsedAfter: unsignedInteger.optional(),
  recovery: z.boolean().optional(),
}).strict()

const institutionViewSchema = z.object({
  schema: z.literal("finnor.z0.institution-application-view.v1"),
  originRef: ApplicationReferenceSchema,
  compilerRequestId: z.string().uuid(), programId: z.string().uuid(),
  responsibilityIdentity: z.string().regex(/^x1-obligation:[a-f0-9]{64}$/),
  originalWorkId: z.string().uuid(), originalWorkInputId: z.string().uuid(),
  institutionalProgramRef: ApplicationReferenceSchema,
  originalReservationRef: ApplicationReferenceSchema,
  originalDeadlineAt: timestamp, wallDeadlineAt: timestamp, childDeadlineAt: timestamp,
  programmeStatus: label, modelAcceptanceRef: ApplicationReferenceSchema.nullable(),
  modelConsumedByOriginalP1: z.boolean(),
  completionOwner: z.literal("ORIGINAL_P1_AND_INDEPENDENT_CANONICAL_OBSERVER"),
  learnedModelCompletesResponsibility: z.literal(false), newAllowance: z.literal(false),
  protectedAdmission: z.literal(false), executionAuthorityGranted: z.literal(false),
  budget: z.object({
    originalReservationRef: ApplicationReferenceSchema, status: label,
    newReservation: z.literal(false), releaseGranted: z.literal(false),
    originalDeadlineAt: timestamp, wallDeadlineAt: timestamp, childDeadlineAt: timestamp,
    resources: z.array(z.object({
      resourceId: label, unit: z.enum(["request", "seconds"]),
      limit: unsignedInteger, used: unsignedInteger,
      remaining: z.string().max(96).regex(/^-?(?:0|[1-9][0-9]*)$/), overdrawn: z.boolean(),
    }).strict()).min(1).max(16),
    monetaryCost: z.null(), monetaryCostStatus: z.literal("UNKNOWN"),
  }).strict(),
}).strict()

const sessionSchema`);
  await replace(client, "  charges: z.array(chargeSchema).max(2048),",
    "  charges: z.array(chargeSchema).max(2048),\n  institutional: institutionViewSchema.nullable().optional(),");
  await replace(client, "    const { model, check, composition, freshAuthority } = session",
        `    const { model, check, composition, freshAuthority } = session
    const institution = session.institutional
    if (institution && (institution.originalWorkId !== expected.workId
      || session.id !== session.parentId || freshAuthority !== null
      || institution.childDeadlineAt !== session.deadlineAt
      || institution.budget.childDeadlineAt !== session.deadlineAt
      || institution.budget.originalDeadlineAt !== institution.originalDeadlineAt
      || institution.budget.wallDeadlineAt !== institution.wallDeadlineAt
      || Date.parse(session.deadlineAt) > Date.parse(institution.originalDeadlineAt)
      || Date.parse(session.deadlineAt) > Date.parse(institution.wallDeadlineAt)
      || institution.modelConsumedByOriginalP1 && !institution.modelAcceptanceRef
      || !applicationReferencesMatch(institution.originalReservationRef, institution.budget.originalReservationRef)
      || model && (!model.envelope.institutional_program_ref
        || !applicationReferencesMatch(model.envelope.institutional_program_ref, institution.institutionalProgramRef)
        || !applicationReferencesMatch(model.envelope.resource_grant_ref, institution.originalReservationRef))
      || institution.budget.resources.some(resource =>
        BigInt(resource.limit) - BigInt(resource.used) !== BigInt(resource.remaining)
        || resource.overdrawn !== (BigInt(resource.used) > BigInt(resource.limit))))) {
      throw new ApplicationProjectionError()
    }`);
  await replace(client,
    '        || BigInt(charge.usedAfter) > BigInt(charge.limit)) throw new ApplicationProjectionError()',
    `        || BigInt(charge.usedAfter) > BigInt(charge.limit)
        || (charge.childLimit !== undefined || charge.childUsedAfter !== undefined || charge.recovery !== undefined)
          && (!institution || charge.childLimit === undefined || charge.childUsedAfter === undefined || charge.recovery === undefined
            || BigInt(charge.childUsedAfter) > BigInt(charge.childLimit)
            || BigInt(charge.childLimit) > BigInt(charge.limit)
            || charge.recovery && charge.phase !== "RECOVERY")) throw new ApplicationProjectionError()`);
  await replace(client, "const acquisitionRequestSchema = z.object({",
    `const institutionSelectorSchema = z.object({
  compilerRequestId: z.string().uuid(), programId: z.string().uuid(),
  responsibilityIdentity: z.string().regex(/^x1-obligation:[a-f0-9]{64}$/),
}).strict()
const acquisitionRequestSchema = z.object({`);
  await replace(client, "  deadlineAt: timestamp, idempotencyKey: label,\n}).strict()",
    "  deadlineAt: timestamp, idempotencyKey: label,\n  institutionalOrigin: institutionSelectorSchema.optional(),\n}).strict()");
  await replace(client, "  resourceDemandJson: string\n  deadlineAt: string\n}",
    "  resourceDemandJson: string\n  deadlineAt: string\n  institutionalOriginJson?: string\n}");
  await replace(client, "    deadlineAt: draft.deadlineAt, idempotencyKey,",
    `    deadlineAt: draft.deadlineAt, idempotencyKey,
    ...(draft.institutionalOriginJson?.trim() ? {
      institutionalOrigin: parseApplicationJsonInput(draft.institutionalOriginJson, "Original institution references"),
    } : {}),`);

  await replace(panel, '    profileIdsJson: "", targetsJson: "", resourceDemandJson: "", deadlineAt: "",',
    '    profileIdsJson: "", targetsJson: "", resourceDemandJson: "", deadlineAt: "", institutionalOriginJson: "",');
  await replace(panel,
    '        <button type="submit">Request acquisition and native reservation</button>',
    `        <details>
          <summary>Learn for an unfinished original X1 responsibility</summary>
          <p>Supply only existing compilerRequestId, programId and responsibilityIdentity references as one JSON object.
            The native owner revalidates the checked responsibility, original input, deadline and remaining S5 resources.
            This request cannot create a new allowance or complete the original Work.</p>
          <label>Original institution references (optional for a standalone non-X1 Work)
            <textarea name="institutionalOrigin" value={draft.institutionalOriginJson ?? ""}
              onChange={event => setDraft({ ...draft, institutionalOriginJson: event.target.value })}
              rows={3} maxLength={1024} spellCheck={false} autoComplete="off"/>
          </label>
        </details>
        <button type="submit">{draft.institutionalOriginJson?.trim()
          ? "Request learning under original reservation" : "Request acquisition and native reservation"}</button>`);
  await replace(panel, "    {model ? <ModelEvidence model={model} check={session.check} now={now}/>",
    `    {session.institutional ? <section>
      <h4>Original institutional responsibility</h4>
      <p>Original Work: {session.institutional.originalWorkId}. Input: {session.institutional.originalWorkInputId}.</p>
      <p>Original P1: {session.institutional.programId} · {session.institutional.programmeStatus}.
        Responsibility: <code>{session.institutional.responsibilityIdentity}</code>.</p>
      <p>Institution artifact: <Reference value={session.institutional.institutionalProgramRef}/></p>
      <p>Same original S5 reservation: <Reference value={session.institutional.originalReservationRef}/></p>
      <p>Original deadline: {session.institutional.originalDeadlineAt}. Wall deadline: {session.institutional.wallDeadlineAt}.
        Learning cutoff: {session.institutional.childDeadlineAt}. None is renewed.</p>
      <p>Original P1 consumed the checked model: {session.institutional.modelConsumedByOriginalP1 ? "yes" : "not observed"}.
        Learning never fulfills the responsibility. The original owner and independent canonical observer still decide completion.</p>
      {session.institutional.modelAcceptanceRef ? <p>S4 acceptance: <Reference value={session.institutional.modelAcceptanceRef}/></p> : null}
      <details><summary>Remaining original resources and known accounting gaps</summary>
        <JsonEvidence value={session.institutional.budget}/>
      </details>
      <p>No new reservation, budget, release, protected admission or fresh business-effect authority is granted.</p>
    </section> : null}
    {model ? <ModelEvidence model={model} check={session.check} now={now}/>`);
  await replace(panel, "          blockedReason={blockReason}",
    '          blockedReason={selected.institutional ? "Institution learning returns to the original P1 owner. This grant cannot fund a fresh business assignment." : blockReason}');
}
