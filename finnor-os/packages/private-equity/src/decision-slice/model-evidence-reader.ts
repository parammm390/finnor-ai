/** M1's original current-reader checks remain authoritative. The sole extension
 * is read-only model evidence after the exact analytical Work has completed. */
import type {PeMutationContext} from '../types';
import {readCurrentDecisionSlice} from './service';
import {readRecord,readPrivate} from './store';
import {DecisionSliceError,same,type DecisionSlice,type NativeBinding,type M1Ref} from './contracts';
import {withModelReadCut,type ModelReadCut} from './model-read-scope';
import {withTenantTransaction} from '@finnor/db';
export async function readCurrentModelEvidenceForProgramme(ctx:PeMutationContext,ref:M1Ref,cut:ModelReadCut){
 if(ctx.auth.tenantId!==cut.tenantId||(ctx.auth.employeeId??ctx.auth.userId)!==cut.principalId)throw new DecisionSliceError('UNAVAILABLE','Permitted decision context is unavailable');
 const body=await readRecord<Omit<DecisionSlice,'ref'>>(ctx,'slices',ref),publication=await readPrivate<{sliceRef:M1Ref;bindingRef:M1Ref}>(ctx,'publications',ref.contentDigest),binding=await readRecord<NativeBinding>(ctx,'bindings',publication.bindingRef);
 if(!same(publication.sliceRef,ref)||binding.request.purpose!=='MODEL_EVIDENCE'||body.envelope.work.id!==cut.workId||body.envelope.work.inputId!==cut.workInputId)throw new DecisionSliceError('UNAVAILABLE','Permitted model evidence is unavailable');
 await withTenantTransaction(cut.tenantId,{userId:cut.principalId,readOnly:true},async(_db,c)=>{
  const q=(await c.query('SELECT id FROM finnor_os.p1_requests WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND work_id=$4 AND work_input_id=$5 AND status NOT IN (\'CANCELLED\',\'INVALIDATED\')',[cut.tenantId,cut.principalId,cut.programId,cut.workId,cut.workInputId])).rows[0];
  if(!q)throw new DecisionSliceError('UNAVAILABLE','Permitted analytical programme is unavailable');
 });
 return withModelReadCut(cut,()=>readCurrentDecisionSlice(ctx,ref));
}
