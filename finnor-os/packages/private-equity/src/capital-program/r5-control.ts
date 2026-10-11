import type { CoalitionCandidate, CoalitionCheck, CoalitionSelection } from "../../../shared-types/src/coalition-programme";
import { R5_VERSION } from "../../../shared-types/src/coalition-programme";
import type { ExperimentRef } from "@finnor/shared-types";
import type { CapitalOwnerBinding } from "./v2-owners";
import { assertCapitalOwnerBinding } from "./v2-owners";
import type { PeMutationContext } from "../types";
import { m3Hash, CapitalProgramV2Error } from "./v2-contracts";
import { persistEnterpriseCoalitionSelection } from "../enterprise-control";
import type { runCoalitionNativeSearch } from "./r5-search";
import type {CapitalProgramV2Request} from "./v2-contracts";

export async function chooseCoalitionControl(
  ctx: PeMutationContext, binding: CapitalOwnerBinding, candidate: CoalitionCandidate,
  checker: CoalitionCheck, native: Awaited<ReturnType<typeof runCoalitionNativeSearch>>, nativeComponentRef: ExperimentRef,
  source:NonNullable<CapitalProgramV2Request["coalition"]>["source"],
): Promise<CoalitionSelection> {
  await assertCapitalOwnerBinding(ctx,binding);
  const owned=binding.r5,tie=native.tie;
  if(!owned||!tie?.qualified||!checker.feasible||checker.candidateDigest!==m3Hash(candidate)||
    candidate.objective!==checker.lower||native.lower!==candidate.objective||
    native.originalDigest!==m3Hash(owned.original)||tie.checked.result.tieQualified!==true||
    tie.checked.result.candidateDigest!==m3Hash(tie.candidate))
    throw new CapitalProgramV2Error("BLOCKED_SELECTION","S4 original independent coalition value/tie gate is unpassed");
  const selected=candidate.programmeOptions.filter(option=>candidate.selectedOptionIds.includes(option.id));
  const body:Omit<CoalitionSelection,"ref">={
    schema:"finnor.s4.coalition-selection.v1",version:R5_VERSION,tenantId:ctx.auth.tenantId,principalId:ctx.auth.userId,
    workId:binding.work.id,workRevision:binding.work.inputId,original:owned.original,originalRef:owned.sourceRef,
    rightsRef:binding.policy.bindings.rightsRef,source,sourceRoot:binding.model.request.roots[0]!,
    dependencies:binding.dependencies,resourceSnapshotDigest:owned.resourceSnapshotDigest,runtimeRef:owned.runtimeRef,
    candidate,checker,incumbentPolicyRef:binding.policy.ref,mandateRef:binding.policy.mandateRef,nativeComponentRef,
    selectedOptionIds:candidate.selectedOptionIds,value:candidate.objective,
    demandDigest:m3Hash({originalDigest:native.originalDigest,selected,division:candidate.division}),
    tie:{rule:tie.rule,originalCandidateDigest:String(tie.checked.result.candidateDigest),
      checkerIdentity:tie.checked.checkerIdentity,physicalRef:tie.checked.physicalRef},
    validUntil:binding.validUntil,knowledgeAt:new Date().toISOString(),qualification:"EXACT_SUPPLIED_JOINT_MODEL_UNADMITTED",
    programmeExecutableQualified:false,executionAuthorityGranted:false,reservationGranted:false,
  };
  const contentDigest=m3Hash(body);
  const choice:CoalitionSelection={...body,ref:{owner:"S4",id:"coalition-selection:"+contentDigest,version:R5_VERSION,contentDigest}};
  await persistEnterpriseCoalitionSelection(ctx,choice);return choice;
}
