import type { CoalitionProblem,CoalitionSelection } from "../../../shared-types/src/coalition-programme";
import type { ExperimentRef } from "@finnor/shared-types";
import { parseCoalitionProblem, requireCoalition } from "../../../epistemic-runtime/src/coalition-programme-search/domain";
import { r2Quantity as q } from "../../../epistemic-runtime/src/r2-rational";
import { readSourceObject } from "../deliberation/store";
import { authorizeBeliefResources } from "../enterprise-beliefs";
import { readAllocationSnapshot } from "../allocation-store";
import { revisions, assertDependencies } from "../evidence-execution/store";
import type { PeMutationContext, PeWorldRootRef } from "../types";
import type { CapitalOwnerBinding } from "./v2-owners";
import { loadR2Runtime, coalitionCheckerIdentity, type R2Runtime } from "./r2-native";
import { m3Same, CapitalProgramV2Error, type CapitalProgramV2Request } from "./v2-contracts";
import {resolveDecisionWork} from "../decision-slice/adapters";
import {DecisionSliceError} from "../decision-slice/contracts";
import {coalitionSelectionSnapshot,coalitionOriginalSnapshot} from "./r5-allocation-owner";

export interface R5OwnerBinding {
  original: CoalitionProblem;
  sourceRef: ExperimentRef;
  runtimeRef: ExperimentRef;
  runtimeManifest: R2Runtime["manifest"];
  checkerIdentity: {path:string;sha256:string};
  resourceSnapshotDigest: string;
  admissionCost?: { cpuMs: number; wallMs: number; memoryBytes: number; money: null };
}

function partyRoot(ref: ExperimentRef): PeWorldRootRef {
  const match = /^canonical:(external_organization|pe_fund):([0-9a-f-]{36})$/.exec(ref.id);
  if (ref.owner !== "S1" || !match)
    throw new CapitalProgramV2Error("INVALID_REQUEST", "R5 party identity must name an existing permissioned S1 root");
  return { entityType: match[1]!, entityId: match[2]! } as PeWorldRootRef;
}

/** Supplied coalition laws remain unadmitted. Every Work/root/source/resource
 * comes from its actual existing owner, never an HTTP-supplied receipt. */
export async function resolveR5Owners(
  ctx: PeMutationContext, request: CapitalProgramV2Request, binding: CapitalOwnerBinding,
): Promise<R5OwnerBinding> {
  const r5 = request.coalition;
  if (!r5) throw new CapitalProgramV2Error("INVALID_REQUEST", "Original R5 source is absent");
  const root = binding.model.request.roots[0];
  if (!root) throw new CapitalProgramV2Error("INVALID_REQUEST", "R5 original model owner root is absent");
  const row = await readSourceObject(ctx, root, r5.source.sourceId, r5.source.versionId);
  if (row.content_hash !== r5.source.contentDigest || Date.parse(row.as_of) > Date.now() ||
      Date.parse(row.retrieved_at) > Date.now())
    throw new CapitalProgramV2Error("STALE_INPUT", "R5 source bytes, knowledge time or current version changed");
  const p = parseCoalitionProblem(JSON.parse(row.content));
  requireCoalition(p.owner.tenantId === ctx.auth.tenantId && p.owner.principalId === ctx.auth.userId &&
    p.owner.workId === binding.work.id && p.owner.workRevision === binding.work.inputId, "ORIGINAL_PRIVATE_WORK_BINDING");
  requireCoalition(m3Same(p.objective.mandateRef, binding.policy.mandateRef) &&
    m3Same(p.model.ref, binding.model.ref) && p.unit === binding.policy.mandate.utility.unit,
    "ORIGINAL_S3_S4_MODEL_MANDATE_UNIT_BINDING");
  requireCoalition(p.objective.kind === "ROBUST", "EXPECTED_OWNER_MANDATE_REQUIRES_QUALIFIED_JOINT_LAW_ADAPTER");
  const roots = p.parties.map(party => partyRoot(party.partyRef));
  await authorizeBeliefResources(ctx, roots.map(root => ({ type: root.entityType, id: root.entityId })));
  const sourceRef:ExperimentRef={owner:"S1",id:"source-version:"+r5.source.versionId,
    version:"r5-current-source-v1",contentDigest:row.content_hash};
  const snapshot = await coalitionOriginalSnapshot(ctx,p,sourceRef,binding.resources);
  if(p.canonicalAllocation){
    const canonical=p.canonicalAllocation;
    requireCoalition(p.controlDemand&&m3Same(canonical.mandate,binding.policy.mandate)&&
      m3Same(canonical.resources,snapshot.resources)&&m3Same(canonical.outstanding,snapshot.outstanding)&&
      canonical.snapshotDigest===snapshot.snapshotDigest&&Date.parse(canonical.knowledgeAt)<=Date.now(),
      "ORIGINAL_COMPLETE_CANONICAL_ALLOCATION_BASIS");
  }
  binding.resources=snapshot;
  const resourceCoordinate=binding.ownerVector.find(row=>row.key==="s5-complete-registry-outstanding");
  if(resourceCoordinate)resourceCoordinate.digest=snapshot.snapshotDigest;
  requireCoalition(p.resources.length === snapshot.resources.length &&
    p.resources.every(resource => snapshot.resources.some(current => m3Same(current.ref, resource.sourceRef))),
    "COMPLETE_CURRENT_S5_RESOURCE_REGISTRY");
  for (const resource of p.resources) {
    const current = snapshot.resources.find(current => m3Same(current.ref, resource.sourceRef))!;
    const kind = current.kind === "STOCK" ? "CUMULATIVE_EXPENDITURE" :
      current.kind === "EXPOSURE" ? "OCCUPANCY" : current.kind;
    requireCoalition(current.resourceId === resource.id && current.unit === resource.unit &&
      kind === resource.kind && !current.revoked && current.rightsRef === binding.policy.bindings.rightsRef &&
      current.availability.length === p.dates.length &&
      roots.every(root => current.permittedRoots.some(permitted => m3Same(permitted, root))),
      "CURRENT_S5_RESOURCE_KIND_RIGHTS_SCOPE_CLOCK");
    for (let date = 0; date < p.dates.length; date++) {
      requireCoalition(Date.parse(p.dates[date]!) === Date.parse(current.horizon.startAt) + date * current.horizon.periodMs,
        "CURRENT_S5_ORIGINAL_DATE_EDGE");
      const available = current.availability[date]!;
      requireCoalition(available.amount !== null && available.basis === "REPORTED_AVAILABLE", "UNSETTLED_OR_UNKNOWN_RESOURCE_AVAILABILITY");
      const cumulative = ["STOCK", "CUMULATIVE_EXPENDITURE"].includes(current.kind);
      const existing = cumulative
        ? current.existingUse.slice(0, date + 1).reduce((sum, value) => sum.add(q(value)), q("0"))
        : q(current.existingUse[date]!);
      let outstanding = q("0");
      for (const commitment of snapshot.outstanding)
        for (const envelope of commitment.envelopes.filter(envelope => envelope.resourceId === current.resourceId))
          outstanding = outstanding.add(cumulative
            ? envelope.quantities.slice(0, date + 1).reduce((sum, value) => sum.add(q(value)), q("0"))
            : q(envelope.quantities[date]!));
      const free = q(available.amount).sub(existing).sub(outstanding).sub(q(current.safetyMargin));
      requireCoalition(free.n >= 0n && p.worlds.every(world => q(resource.available[world.id]![date]!).compare(free) === 0),
        "CURRENT_S5_RETAINED_SHARED_COMMITMENTS");
    }
  }
  for (const party of p.parties) {
    const funding = snapshot.resources.find(resource => m3Same(resource.ref, party.fundingRef));
    requireCoalition(funding && funding.resourceClass === "CASH" && funding.unit === p.unit &&
      funding.currency === p.currency && funding.legalEntityRef.id === partyRoot(party.partyRef).entityId,
      "ORIGINAL_PARTY_CASH_OWNERSHIP");
    const cash = p.resources.find(resource => resource.id === funding.resourceId)!;
    requireCoalition(p.worlds.every(world => party.settledCash[world.id]!.every((value, date) =>
      q(value).compare(q(cash.available[world.id]![date]!)) === 0)), "ORIGINAL_PARTY_CURRENT_SETTLED_CASH");
  }
  // Until supplied S6 liabilities can be bound exactly, do not invent zero
  // liability or erase an existing unknown/partial business effect.
  if (binding.outstandingEffects.length)
    throw new CapitalProgramV2Error("BLOCKED_SELECTION", "R5_UNACCOUNTED_S6_OBLIGATION_REQUIRES_ORIGINAL_OWNER_RECONCILIATION");
  const runtime = await loadR2Runtime();
  return { original: p, sourceRef,
    runtimeRef: runtime.ref, runtimeManifest: runtime.manifest, checkerIdentity: await coalitionCheckerIdentity(),
    resourceSnapshotDigest: snapshot.snapshotDigest };
}

export async function assertR5Current(ctx: PeMutationContext, request: CapitalProgramV2Request, binding: CapitalOwnerBinding) {
  if (!binding.r5) return;
  await assertDependencies(ctx, await r5CurrentDependencies(ctx,binding));
  await authorizeBeliefResources(ctx, binding.r5.original.parties.map(party => {
    const root=partyRoot(party.partyRef);return {type:root.entityType,id:root.entityId};
  }));
  const source = request.coalition!.source, root = binding.model.request.roots[0]!;
  const row = await readSourceObject(ctx, root, source.sourceId, source.versionId);
  const snapshot = await coalitionOriginalSnapshot(ctx,binding.r5.original,binding.r5.sourceRef,await readAllocationSnapshot(ctx)), runtime = await loadR2Runtime();
  if (row.content_hash !== source.contentDigest || snapshot.snapshotDigest !== binding.r5.resourceSnapshotDigest ||
      !m3Same(runtime.ref, binding.r5.runtimeRef)||!m3Same(await coalitionCheckerIdentity(),binding.r5.checkerIdentity))
    throw new CapitalProgramV2Error("STALE_INPUT", "R5 original source, shared commitments, runtime or independent checker changed");
}

export const r5SourceDependencies = (ctx: PeMutationContext, request: CapitalProgramV2Request) =>
  revisions(ctx, [`evidence:${request.coalition!.source.sourceId}`, `source-version:${request.coalition!.source.versionId}`]);

export async function assertR5SelectionCurrent(ctx:PeMutationContext,selection:CoalitionSelection):Promise<void>{
  const work=await resolveDecisionWork(ctx,selection.workId).catch(error=>{
    if(error instanceof DecisionSliceError&&error.code==="UNAVAILABLE")
      throw new CapitalProgramV2Error("UNAVAILABLE","Permitted coalition Work is unavailable");
    throw error;
  });
  if(work.inputId!==selection.workRevision)
    throw new CapitalProgramV2Error("STALE_INPUT","Original coalition Work revision changed");
  await authorizeBeliefResources(ctx,selection.original.parties.map(party=>{
    const root=partyRoot(party.partyRef);return {type:root.entityType,id:root.entityId};
  }));
  const source=selection.source,row=await readSourceObject(ctx,selection.sourceRoot as PeWorldRootRef,source.sourceId,source.versionId);
  const actual=await readAllocationSnapshot(ctx),snapshot=await coalitionSelectionSnapshot(ctx,selection,actual),runtime=await loadR2Runtime();
  if(row.content_hash!==source.contentDigest||!m3Same(JSON.parse(row.content),selection.original))
    throw new CapitalProgramV2Error("STALE_INPUT","Original coalition source changed");
  if(snapshot.snapshotDigest!==selection.resourceSnapshotDigest)
    throw new CapitalProgramV2Error("STALE_INPUT","Original coalition complete resources changed");
  await assertDependencies(ctx,actual.snapshotDigest!==snapshot.snapshotDigest?
    selection.dependencies.filter(dependency=>dependency.key!=="m3:s5-complete"):selection.dependencies);
  if(!m3Same(runtime.ref,selection.runtimeRef)||!m3Same(await coalitionCheckerIdentity(),selection.tie.checkerIdentity))
    throw new CapitalProgramV2Error("STALE_INPUT","Original coalition runtime or checker changed");
}

/** Reconcile the coarse S5 revision only after the actual immutable own origin
 * explains it and all outside commitments/resources equal the original cut. */
export async function r5CurrentDependencies(ctx:PeMutationContext,binding:CapitalOwnerBinding){
 if(!binding.r5)return binding.dependencies;
 const actual=await readAllocationSnapshot(ctx),baseline=await coalitionOriginalSnapshot(ctx,binding.r5.original,binding.r5.sourceRef,actual);
 return actual.snapshotDigest!==baseline.snapshotDigest&&baseline.snapshotDigest===binding.r5.resourceSnapshotDigest?
  binding.dependencies.filter(dependency=>dependency.key!=="m3:s5-complete"):binding.dependencies;
}
export {partyRoot as coalitionPartyRoot};
