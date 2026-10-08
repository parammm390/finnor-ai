import { epistemicHash } from '../../../epistemic-runtime/src/source-precedence';
import type { PeMutationContext } from '../types';
import { m1Ref, PatchSchema, same, unavailable, DecisionSliceError, type ContextRevision, type DecisionSlice,
  type M1Ref, type NativeBinding } from './contracts';
import { readOptional, readPrivateText, readRecord, writePrivate, writeRecord, withStoreLock } from './store';

export function contextSeed(binding:NativeBinding,slice:Pick<DecisionSlice,'materialVariables'|'unresolvedCoverage'|'fullEvidenceHandles'>):ContextRevision{
  const verifiedRefs=slice.materialVariables.map(variable=>({variableId:variable.id,ownerRef:variable.ownerRef,status:variable.status}));
  const estimates=slice.materialVariables.filter(v=>/MODEL|RESPONSE|ASSUMPTION|COMPUTATION/.test(v.qualification)).map(v=>({variableId:v.id,qualification:v.qualification}));
  const contradictions=binding.views.flatMap(view=>view.contradictions);
  const qualifiedDigest=epistemicHash({verifiedRefs,estimates,contradictions,unresolved:slice.unresolvedCoverage,
    inputDigest:epistemicHash(binding),universeRef:slice.fullEvidenceHandles.ref});
  const body={schema:'finnor.m1.working-context.v1' as const,parentRef:null,sliceDigest:epistemicHash(binding),revision:1,qualifiedDigest,
    verifiedRefs,estimates,contradictions,unresolved:slice.unresolvedCoverage,selectedHandles:[slice.fullEvidenceHandles.ref.id],
    notes:[],agenda:slice.unresolvedCoverage.map(g=>g.requirement).slice(0,32),patchDigest:null};
  return {...body,ref:m1Ref('working-context',body)};
}
export async function retainContext(ctx:PeMutationContext,context:ContextRevision):Promise<void>{
  const {ref,...body}=context;await writeRecord(ctx,'contexts',ref,body);
}
export async function serveWorkingContext(ctx:PeMutationContext,slice:DecisionSlice):Promise<{context:ContextRevision;reconstructionRef:M1Ref|null}>{
  return withStoreLock(ctx,epistemicHash(`context:${slice.ref.contentDigest}`),async()=>{
    const head=await readOptional<{ref:M1Ref}>(ctx,'context-heads',slice.ref.contentDigest);
    const ref=head?.ref??slice.workingContext.seedRef;
    const body=await readRecord<Omit<ContextRevision,'ref'>>(ctx,'contexts',ref),context={...body,ref};
    if(context.qualifiedDigest!==slice.workingContext.qualifiedDigest)throw unavailable();
    let working:ContextRevision|null=null,corruptDigest:string|null=null;
    // A symlink or unsafe file is not an invitation to replace it. A bounded
    // corrupt disposable JSON file may be repaired from the immutable history.
    try{working=await readOptional<ContextRevision>(ctx,'working',slice.ref.contentDigest);}
    catch(error){
      // Diagnostic hashing uses the same bounded no-follow descriptor as JSON
      // reads. Never turn a parse failure into an unchecked pathname read.
      corruptDigest=epistemicHash(await readPrivateText(ctx,'working',slice.ref.contentDigest));
    }
    let reconstructionRef:M1Ref|null=null;
    if(!working||!same(working,context)){
      const reconstruction={schema:'finnor.m1.context-reconstruction.v1',sliceRef:slice.ref,contextRef:ref,
        qualifiedDigest:context.qualifiedDigest,priorDisposableDigest:corruptDigest??(working?epistemicHash(working):null),
        reason:working?'UNVALIDATED_DISPOSABLE_REPLACEMENT':corruptDigest?'CORRUPT_DISPOSABLE':'MISSING_OR_COLD_DISPOSABLE',
        rightsRechecked:true,historicalOwnersRechecked:true,at:new Date().toISOString(),money:null};
      reconstructionRef=m1Ref('context-reconstruction',reconstruction);
      await writeRecord(ctx,'invalidations',reconstructionRef,reconstruction);
      await writePrivate(ctx,'working',slice.ref.contentDigest,context);
    }
    if(!head)await writePrivate(ctx,'context-heads',slice.ref.contentDigest,{ref});
    return {context,reconstructionRef};
  });
}
export async function patchWorkingContext(ctx:PeMutationContext,slice:DecisionSlice,expectedRef:unknown,value:unknown):Promise<ContextRevision>{
  const patch=PatchSchema.parse(value),expected=expectedRef as M1Ref;
  return withStoreLock(ctx,epistemicHash(`context:${slice.ref.contentDigest}`),async()=>{
    const head=await readOptional<{ref:M1Ref}>(ctx,'context-heads',slice.ref.contentDigest),ref=head?.ref??slice.workingContext.seedRef;
    if(!same(ref,expected))throw new DecisionSliceError('CONFLICT','Working context revision changed');
    const body=await readRecord<Omit<ContextRevision,'ref'>>(ctx,'contexts',ref);
    if(body.qualifiedDigest!==slice.workingContext.qualifiedDigest)throw unavailable();
    const allowed=new Set([slice.fullEvidenceHandles.ref.id,...slice.fullEvidenceHandles.views.map(v=>v.ownerViewRef),
      ...slice.fullEvidenceHandles.p4.flatMap(d=>[d.ownerRef.id,...d.handles.map(h=>h.id)])]);
    if(patch.selectedHandles?.some(handle=>!allowed.has(handle)))throw new DecisionSliceError('INVALID_REQUEST','Context selected handles are outside its permitted universe');
    const nextBody={...body,...patch,parentRef:ref,revision:body.revision+1,patchDigest:epistemicHash({expectedRef:ref,patch})};
    const next={...nextBody,ref:m1Ref('working-context',nextBody)};
    await retainContext(ctx,next);
    // The immutable revision is durable before the coherent CAS head. A crash
    // after the head but before disposable replacement reconstructs that head.
    await writePrivate(ctx,'context-heads',slice.ref.contentDigest,{ref:next.ref});
    await writePrivate(ctx,'working',slice.ref.contentDigest,next);
    return next;
  });
}
