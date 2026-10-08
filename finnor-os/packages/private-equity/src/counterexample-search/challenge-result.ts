import {ref,ChallengeError,type FrozenDiagnostic,type OwnerArtifactDiagnostic,type ChallengeResult} from './contracts';
import type {SearchRow} from './store';

/** Construct the original contract from the frozen M3 publication and actual
 * independent search. No diagnostic reference can stand in for this result. */
export function buildChallengeResult(frozen:FrozenDiagnostic,row:SearchRow,
  details:Omit<OwnerArtifactDiagnostic,'ref'>):ChallengeResult{
  const capital=frozen.capital;
  if(!capital||frozen.schema!=='finnor.m4.frozen-challenge.v1')
    throw new ChallengeError('CHECK_FAILED','Original candidate publication required for ChallengeResult');
  const program=capital.context.program,body:Omit<ChallengeResult,'ref'>={
    schema:'finnor.m4.challenge-result.v1',
    envelope:{
      id:row.id,tenant:{id:row.tenant_id,principalId:row.principal_id,sharingScope:'PRIVATE_PRINCIPAL'},
      mandateOrChange:program.mandate,work:program.envelope.work,
      parents:[program.ref,frozen.slice.ref,...(details.parentResultRef?[details.parentResultRef]:[])],
      inputs:{candidate:program.ref,moduleRefs:capital.context.modules.map(m=>m.ref),
        moduleDigests:capital.context.modules.map(m=>m.sha256),graphRef:program.ownerBoundGraph!,
        claims:capital.context.claims.map(c=>c.ref),contextDigest:frozen.contextDigest,inputDigest:program.envelope.inputDigest},
      rights:frozen.slice.envelope.rights,owners:program.envelope.ownerVector,
      producer:{owner:'M4',version:details.producer.version,sourceDigest:frozen.code.digest,schemaDigest:frozen.schemaDigest},
      runtime:details.runtime,domain:{ref:frozen.domainRef,qualified:'FINITE_OWNER_CLAIMS_H0_H1',independentAdmission:null},
      invalidation:frozen.revisions,computeGrant:{searchId:row.id,deadlineAt:row.deadline_at.toISOString(),
        limits:row.limits,financialFunding:null,aggregateOSLimits:'UNQUALIFIED'},
      costs:{...details.ledger,upstreamChargesDuplicated:false},state:'TESTED',
    },
    producer:details.producer,identity:details.identity,runtime:details.runtime,evaluation:details.evaluation,
    resources:details.resources,cost:details.cost,qualification:details.qualification,executionAuthorityGranted:false,
    candidate:program.ref,claims:details.claims.map(c=>c.ref),searchedDomain:frozen.domainRef,
    independentWitnesses:details.witnesses.map(w=>w.ref),unresolved:details.unresolved.map(g=>g.ref),
    repairDependencies:details.repairDependencies.ref,result:details.result,
    claimRecords:details.claims,witnessRecords:details.witnesses,coverageGaps:details.unresolved,
    domainRecord:details.searchedDomain,repairClosure:details.repairDependencies,
    coverage:details.coverage,ledger:details.ledger,parentResultRef:details.parentResultRef,repairReplay:details.repairReplay,
  };
  return {ref:ref('challenge-result',body),...body};
}
