import type {PoolClient} from 'pg';
import type {PeMutationContext} from '../types';
import {currentEconomicTheoryAdmissionTx} from '../../../capability-evolution/src/economic-theory-port';
import {digest,reference} from '../economic-action-theory/contracts';
/** A semantic module is consumed by S4. It is not an analytical propose_effect
 * opcode and does not acquire authority by appearing in a programme. */
export async function economicSemanticModuleTx(ctx:PeMutationContext,c:PoolClient,theoryId:string){
 const {row,admission}=await currentEconomicTheoryAdmissionTx(ctx,c,theoryId);
 const body={schema:'finnor.p1.economic-semantic-module.v1' as const,theoryRef:row.artifact!.envelope.contentRef,
  admissionRef:admission.ref,problemDigest:digest(row.request.problem),body:row.candidate!,
  validity:row.artifact!.envelope.validityDomain,executionAuthorityGranted:false as const};
 return {row,admission,module:{...body,ref:reference('P1','economic-semantic-module',body)}};
}
