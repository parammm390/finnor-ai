/** One native owner snapshot per selector. No expected values or signing keys. */
import {ObservedEnvironment} from '../../../packages/private-equity/src/institution-qualification/scoring';
import type {collectIndependentOwnerRead} from './qualification-runtime.mts';

export async function collectQualificationObservation(input:{drafts:Array<Awaited<ReturnType<typeof collectIndependentOwnerRead>>>;
  environmentIds:string[];expectedSelectorCount:number;
  save:(name:string,body:unknown)=>void|Promise<void>}){
  if(input.environmentIds.length!==10||new Set(input.environmentIds).size!==10||input.expectedSelectorCount<10||input.expectedSelectorCount>160
    ||input.drafts.some(p=>!input.environmentIds.includes(p.environmentId)))throw Error('ORIGINAL_TEN_OBSERVER_ENVIRONMENTS_REQUIRED');
  const observed=new Map(input.environmentIds.map(id=>[id,ObservedEnvironment.parse({mappings:[],obligations:[],completions:[],changes:[],violations:[]})]));
  const gaps=[];
  for(const [ordinal,draft]of input.drafts.entries()){
      await input.save('native-observation-'+ordinal+'.json',draft);
      const target=observed.get(draft.environmentId)!;
      for(const row of draft.observations){
        const atom={identity:row.identity,semanticDigest:row.semanticDigest};
        if(!row.accepted)gaps.push({environmentId:draft.environmentId,kind:draft.kind,identity:row.identity,
          reason:'CURRENT_NATIVE_OWNER_PREDICATES_UNRESOLVED',witnessDigest:row.witnessDigest});
        if(draft.kind==='MAPPING_CLAIMS'&&row.accepted)target.mappings.push(atom);
        if(draft.kind==='OBLIGATION_CLAIMS'&&row.accepted)target.obligations.push(atom);
        if(draft.kind==='POSTCONDITION_WITNESSES')target.completions.push({identity:row.identity,
          disposition:row.accepted?'OBSERVED':'UNKNOWN',postconditionDigest:row.accepted?row.semanticDigest:null,
          observedAt:row.accepted?row.observedAt:null,witnessDigest:row.witnessDigest});
        if(draft.kind==='CHANGE_WITNESSES')target.changes.push({identity:row.identity,
          recognizedAt:row.accepted?row.observedAt:null,witnessDigest:row.witnessDigest});
      }
  }
  const result={schema:'finnor.x1.native-observation-collection-draft.v1',
    environments:input.environmentIds.map(environmentId=>({environmentId,observed:ObservedEnvironment.parse(observed.get(environmentId))})),
    gaps,snapshotCount:input.drafts.length,allSelectorsObserved:input.drafts.length===input.expectedSelectorCount&&gaps.length===0,
    expectedValuesRead:false,duplicateNativeClaimsRetained:true,signature:null,
    violationsCoverageEstablished:false,completeLifecycleCostsEstablished:false,protectedQualificationEstablished:false,
    signingAndClockCustodyRequired:true,moneyUsd:null,humanSeconds:null,aggregatePeakMemoryBytes:null};
  await input.save('native-observation-collection-draft.json',result);return result;
}
