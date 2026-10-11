import type { CoalitionCheck, CoalitionProgramme } from "../../../shared-types/src/coalition-programme";
import { R5_VERSION } from "../../../shared-types/src/coalition-programme";
import type { PeMutationContext } from "../types";
import type { M3QueryRow } from "./v2-store";
import { m3Event, m3Tx, writeM3Record } from "./v2-store";
import { m3Hash, m3Ref, m3Same, m3Bounded, CapitalProgramV2Error, type CapitalProgramV2 } from "./v2-contracts";
import { assertCapitalOwnerBinding } from "./v2-owners";
import { assertR5Current } from "./r5-owners";
import { createR2PrivateDirectory, loadR2Runtime, R2NativeSession } from "./r2-native";
import { runCoalitionNativeSearch, coalitionNativeCandidate } from "./r5-search";
import {chooseCoalitionControl} from "./r5-control";
import {checkCoalitionAllocationPoint} from "./r5-allocation";
import {persistAllocationExperience,readAllocationSnapshot} from "../allocation-store";
import {prepareS5Experience,AllocationContractError} from "../../../epistemic-runtime/src/allocation-contracts";
import type {AllocationCheck} from "@finnor/shared-types";
import {compileCoalitionOwnerProgramme} from "../program-synthesis/coalition";

/** M3 transport/durable envelope remains M3. The independently checked
 * coalition artifact has its own R5 schema; it is never a relabeled v2 pool. */
export async function searchCoalitionCapitalProgram(
  ctx: PeMutationContext, row: M3QueryRow, attemptId: string, checkpoint: () => Promise<void>, priorCpuMs: number,
): Promise<{ program: CapitalProgramV2; evidence: null }> {
  const started = performance.now(), cpu = process.cpuUsage(), rss = process.memoryUsage().rss;
  const binding = row.acceptance, owned = binding.r5;
  if (!owned || !row.request.coalition || !row.deadline_at)
    throw new CapitalProgramV2Error("CHECK_FAILED", "Original R5 owner/query/deadline binding is absent");
  const runtime = await loadR2Runtime();
  if (!m3Same(runtime.ref, owned.runtimeRef)) throw new CapitalProgramV2Error("STALE_INPUT", "Original R5 native runtime changed");
  const directory = await createR2PrivateDirectory(ctx.auth.tenantId, ctx.auth.userId, row.id);
  const session = new R2NativeSession(runtime, directory, row.deadline_at.getTime() - 2500,
    owned.original.limits.native, async () => {
      await checkpoint(); await assertCapitalOwnerBinding(ctx, binding); await assertR5Current(ctx, row.request, binding);
    }, async event => { await m3Event(ctx, row.id, attemptId, "R5_PHYSICAL_CHILD", { ...event,
      directory, originalDeadlineAt: row.deadline_at!.toISOString(), costsRetained: true }); },
    checkpoint, priorCpuMs + (owned.admissionCost?.cpuMs ?? 0), owned.admissionCost?.memoryBytes ?? 0);
  session.bindCoalitionChecker(owned.checkerIdentity);
  const native = await runCoalitionNativeSearch(owned.original, session);
  const nativeRef = m3Ref("r5-native-original-proof", native);
  await writeM3Record(ctx, "modules", nativeRef, native);
  await m3Event(ctx, row.id, attemptId, "R5_ORIGINAL_FAMILY_CHECKED", {
    nativeRef, originalDigest: native.originalDigest, partitions: native.family.partitions.length,
    programmeOptions: native.family.options.length, status: native.status, lower: native.lower, upper: native.upper,
    code: binding.code.digest, ownerSnapshotDigest: owned.resourceSnapshotDigest,
  });
  const candidate = coalitionNativeCandidate(native, session);
  const checked = candidate ? await session.checkCoalition(owned.original, "candidate", { candidate }) : null;
  if(checked&&(checked.result.originalDigest!==native.originalDigest||checked.result.candidateDigest!==m3Hash(candidate)||
    checked.result.feasible!==true||checked.result.lower!==native.lower))
    throw new CapitalProgramV2Error("CHECK_FAILED","Independent complete exposed candidate binding differs");
  const checker: CoalitionCheck | null = checked ? {
    schema: "finnor.r5.independent-check.v1", originalDigest: native.originalDigest, candidateDigest: m3Hash(candidate),
    disposition: "ACCEPTED", feasible: checked.result.feasible === true,
    lower: typeof checked.result.lower === "string" ? checked.result.lower : null, upper: native.upper,
    claims: ["INDEPENDENT_ORIGINAL_NATIVE_PROFILE", "ORIGINAL_FULL_WORLD_FEASIBILITY", "COMPLETE_JOINT_MASTER_CORRESPONDENCE",
      ...(native.tie?.qualified?["EXACT_FROZEN_TIE_ON_ACCEPTED_PRIMARY_FACE"]:[])],
    witnesses: [], coverage: { parties: owned.original.parties.length, worlds: owned.original.worlds.length,
      partitions: native.family.partitions.length, programmeOptions: native.family.options.length,
      transferVariables: owned.original.transfers.length * owned.original.parties.length },
    provenance: { runtimeRef: checked.runtimeRef, physicalRef: checked.physicalRef, checkerIdentity: checked.checkerIdentity,
      nativeProofRefs: [...native.proofs.flatMap(proof => [proof.proofRef!, proof.viprRef!]),
        ...(native.tie?.stages.flatMap(stage=>[stage.solved.proofRef!,stage.solved.viprRef!])??[])] },
  } : null;
  const selection=candidate&&checker&&native.tie?.qualified
    ?await chooseCoalitionControl(ctx,binding,candidate,checker,native,nativeRef,row.request.coalition.source):null;
  const p1ProgrammeRef=selection?await compileCoalitionOwnerProgramme(ctx,selection,session,row.id,row.deadline_at.toISOString(),binding.code.digest,attemptId):null;
  let allocationPoint:AllocationCheck|null=null;
  let allocationPointReason="Explicit original S4 demand mapping is absent; native component feasibility is not canonical lower-bound acceptance";
  if(selection&&owned.original.controlDemand)try{
    allocationPoint=checkCoalitionAllocationPoint(selection,binding.policy.mandate,await readAllocationSnapshot(ctx));
  }catch(error){
    if(!(error instanceof AllocationContractError)||error.code!=="INVALID_CANDIDATE")throw error;
    allocationPointReason=error.message;
  }
  if(allocationPoint)await persistAllocationExperience(ctx,[prepareS5Experience(binding.policy.mandate,"CANDIDATE",
    allocationPoint.problemRef.id,{selectionRef:selection!.ref,check:allocationPoint,
      qualification:"R5_ORIGINAL_CANONICAL_POINT_ONLY_NO_RESERVATION",reservationCreated:false,
      executionAuthorityGranted:false},[selection!.ref.id,owned.sourceRef.id])]);
  const acceptedLower=allocationPoint?.feasible?native.lower:null;
  const unresolvedClaims = [
    ...native.unresolved.map(reason => ({ claim: "NATIVE_COMPONENT", reason })),
    ...(!selection?[{ claim: "S4_FROZEN_TIE_AND_SELECTION", reason: "Original exact joint choice/tie gate is unpassed" }]:[]),
    ...(!p1ProgrammeRef?[{ claim: "P1_EXECUTABLE_JOINT_PROGRAMME", reason: "Original selected programme compilation/check gate is unpassed" }]:[]),
    ...(!allocationPoint?.feasible?[{claim:"S5_ORIGINAL_CANONICAL_POINT",reason:allocationPoint?
      allocationPoint.reasons.join(";"):allocationPointReason}]:[]),
    { claim: "S5_SINGLE_JOINT_RESERVATION", reason: "Historical search has no reservation. Invoke the checked ordinary P1 owner handoff and retain its separate actual S5 responsibility" },
    { claim: "S6_PROPOSED_CONSENT_SCHEDULE", reason: "Historical search has no proposed owner schedule. The ordinary P1 handoff must issue the actual S6 origin; proposed amounts are not effects" },
  ];
  const coalitionBody: Omit<CoalitionProgramme, "ref"> = {
    schema: "finnor.coalition-programme.v1", version: R5_VERSION,
    status: native.status === "INFEASIBLE" ? "INFEASIBLE" : "INCOMPLETE",
    originalRef: owned.sourceRef, original: owned.original, candidate, checker, nativeComponentRef: nativeRef,
    lower: acceptedLower, upper: native.upper, gap: acceptedLower===null?null:native.gap,
    consents: owned.original.parties.map(party => ({ partyId: party.id, proposalVersion: candidate ? m3Hash(candidate) : native.originalDigest,
      requirementRef: party.requiredConsentRef, status: "PROPOSED", evidenceRef: null })),
    owners: { s4SelectionRef: selection?.ref??null, s5JointReservationRef: null, s6ProposedScheduleRef: null, p1ProgrammeRef },
    unresolvedClaims, lifecycle: [
      { state: "PROPOSED", at: new Date().toISOString(), reason: "Actual immutable S1/Work/owner/native inputs resolved" },
      { state: "NATIVE_COMPONENT_DEVELOPMENT_VERIFIED", at: new Date().toISOString(), reason: native.status },
    ], executionAuthorityGranted: false, admission: { status: "UNQUALIFIED", receipt: null },
    costs: { physicalRefs: session.receipts.map(receipt => receipt.ref), cpuMs: session.chargedCpuMs,
      aggregateSampledPeakBytes: session.aggregatePeakMemoryBytes, money: null },
  };
  const contentDigest = m3Hash(coalitionBody);
  const coalition: CoalitionProgramme = { ...coalitionBody,
    ref: { owner: "R5", id: "coalition-programme:" + contentDigest, version: R5_VERSION, contentDigest } };
  const usage = process.cpuUsage(cpu);
  const body: Omit<CapitalProgramV2, "ref"> = {
    schema: "finnor.capital-program.v2", producerVersion: "m3-owner-economic-v2",
    originalCapability: "CapitalProgramSearch", deliveryAlias: "EconomicProgramSynthesis",
    state: "PROPOSED_BLOCKED", executionAuthorityGranted: false,
    envelope: { tenantId: ctx.auth.tenantId, principalId: ctx.auth.userId, sharingScope: "PRIVATE_PRINCIPAL",
      work: binding.work, plan: binding.plan, parents: [owned.sourceRef, binding.policy.ref],
      requestRef: m3Ref("capital-program-request", row.request), inputDigest: m3Hash(binding),
      knowledgeAt: new Date().toISOString(), validAt: binding.policy.mandate.horizon.startAt, validUntil: binding.validUntil,
      ownerVector: binding.ownerVector, recompilation: binding.recompilation ?? null, sourceDigests: binding.code.files,
      schemaDigest: binding.schemaDigest, runtime: { node: process.version, platform: process.platform,
        architecture: process.arch, imageAttestation: null },
      grant: { limits: row.request.resource, qualification: "ORIGINAL_SHARED_R2_NATIVE_EPISODE_NO_FINANCIAL_OR_EFFECT_AUTHORITY",
        financialFundingRef: null, aggregatePhysicalLimits: "SHARED_R2_SERIAL_CHILD_GRANT", deadlineAt: row.deadline_at.toISOString() },
      invocationRefs: session.receipts.map(receipt => receipt.ref.id), admission: { status: "BLOCKED_EXTERNAL", receipt: null } },
    mandate: binding.policy.mandateRef, programModule: null, ownerBoundGraph: null, valueUnit: owned.original.unit,
    evidenceSlice: null, mechanisms: [binding.model.ref, owned.sourceRef], inquiries: [], allocationRequest: null,
    effectProposals: [], challengeEvidence: [], candidates: [],
    allocation: { problem: null, checks: allocationPoint?[allocationPoint]:[], qualification: "R5_ORIGINAL_CANONICAL_POINT_ONLY_JOINT_OWNER_HANDOFF_PENDING", reservationCreated: false },
    incumbentAndSearchGap: { incumbentDigest: m3Hash(binding.policy.ref), selectedDigest: candidate ? m3Hash(candidate) : null,
      valueBounds: null, generatedDescriptors: native.family.options.length, attemptedDescriptors: native.iterations.length,
      remainingDescriptors: native.family.complete ? 0 : 1, finiteDomainComplete: native.family.complete,
      upperBound: native.upper, globalOptimalityClaimed: false, modeledImprovement: null,
      unsampledModelGap: "UNKNOWN", identificationGap: "UNKNOWN", selectionQualification: "R5_NATIVE_PROFILE_ONLY_OWNER_TIE_AND_RESERVATION_UNQUALIFIED" },
    blockers: unresolvedClaims.map(claim => ({ code: claim.claim, owner: "R5", requirement: claim.reason })),
    pendingRequests: [], unresolvedBindings: [], costs: { money: null, status: "UNMETERED",
      wallMs: performance.now() - started, cpuUserMicros: usage.user, cpuSystemMicros: usage.system,
      rssBeforeBytes: rss, rssAfterBytes: process.memoryUsage().rss, outputBytes: 0,
      generated: native.family.options.length, attempted: native.iterations.length, refinementSteps: 0,
      expansions: native.family.partitions.length, externalModelCalls: 0,
      upstreamComputeRefs: [binding.model.compute.id, binding.kernel.compute.id, binding.policy.compute.id],
      upstreamChargesDuplicated: false, unknownAttemptIds: [], failedAttemptCostsRetained: true },
    limitations: ["Native mathematical component is not functional R5 completion",
      "Consent, actual canonical reservation, S8 admission, execution and settlement are not granted",
      "Dollars, human time, protected comparison and economic gain remain unqualified"],
    coalitionProgramme: coalition,
  };
  body.costs.outputBytes = Buffer.byteLength(JSON.stringify(body)); m3Bounded(body, row.request.resource.maxResultBytes);
  await m3Tx(ctx, client => client.query(
    "UPDATE finnor_os.m3_queries SET generated=$4,attempted=$5 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
    [ctx.auth.tenantId, ctx.auth.userId, row.id, native.family.options.length, native.iterations.length]));
  return { program: { ...body, ref: m3Ref("capital-program", body) }, evidence: null };
}
