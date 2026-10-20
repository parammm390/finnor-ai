/** Literal development inputs transcribed from independent-oracle.md.
 * These declarations do not call any candidate outcome/training implementation. */
import {reconciliation,quantity} from '../x3/business-fixtures.mts';
import type {BusinessSpecification,ApplicationExpression} from '../../packages/private-equity/src/enterprise-applications/contracts';
export const training=[
 ['E01','USD',['1200','2300'],'3500',1],['E02','INR',['41000','7000'],'48000',1],
 ['E03','USD',['99998','1'],'99999',1],['E04','USD',['99999','1'],'100000',2],
 ['E05','INR',['100000','1'],'100001',2],['E06','USD',['9007199254740994','3'],'9007199254740997',2],
 ['E07','INR',['700','600'],'1300',1],['E08','USD',['19000','25000'],'44000',1],
] as const;
export const transfer=[
 ['F01','USD',['3100','4900'],'8000',1],['F02','INR',['16000','14000'],'30000',1],
 ['F03','USD',['49998','1'],'49999',1],['F04','USD',['49999','1'],'50000',2],
 ['F05','INR',['50000','1'],'50001',2],['F06','USD',['9007199254741000','9'],'9007199254741009',2],
 ['F07','INR',['80000','120000'],'200000',2],['F08','USD',['0','0'],'0',1],
 ['F09','USD',['6000','1250'],'7250',1],['F10','INR',['21000','2000'],'23000',1],
 ['F11','USD',['48000','6000'],'54000',2],['F12','INR',['70000','30000'],'100000',2],
 ['F13','USD',['1','999'],'1000',1],['F14','INR',['15000','25000','9999'],'49999',1],
 ['F15','USD',['20000','20000','10000'],'50000',2],['F16','INR',['10000000000000000000000000','7'],'10000000000000000000000007',2],
] as const;
export const retention=[
 ['R01','USD',['1400','2600'],'4000',1],['R02','INR',['30000','69999'],'99999',1],
 ['R03','USD',['60000','40000'],'100000',2],['R04','INR',['100000','9'],'100009',2],
 ['R05','USD',['9007199254741010','1'],'9007199254741011',2],['R06','USD',['45','55'],'100',1],
 ['R07','INR',['12345','54321'],'66666',1],['R08','USD',['0','1'],'1',1],
] as const;
export const modes=['COMPILED_ORIGINAL','COMPILED_TRAINED','NATIVE_EXACT','COMPILED_NO_NEURAL'] as const;
export const names:Record<string,string>={
 reconciliation:'settlementLot',DRAFT:'AWAITING_FEEDS',RECONCILED:'TIED_OUT',APPROVED:'ATTESTED',PREPARED:'PACKAGED',
 create:'openLot',edit:'attachExport',reconcile:'tieOut',approve:'attest',prepare:'package',execute:'noDispatch',
 CREATED:'OPENED',EDITED:'EXPORT_ATTACHED',APPROVAL_RECORDED:'ATTESTATION_PENDING',
 analyst:'ledgerOp',partner:'finance',compliance:'risk',x3_analyst:'x5_ledger_operator',x3_partner:'x5_finance_attestor',x3_compliance:'x5_risk_signer',
 book:'ledgerSlices',bank:'exportSlices',quantity:'tiedTotal',deltaMinor:'tieDelta',memo:'lotMemo',bookStatus:'ledgerStatus',bankStatus:'exportStatus',
 bookEvidence:'ledgerEvidence',bankEvidence:'exportEvidence',operation:'lotOperation',channel:'lotChannel',
};
export function rename<T>(input:T,map=names,parentKey=''):T{
 if(typeof input==='string')return (['schema','type','kind','op','encoding'].includes(parentKey)?input:map[input]??input) as T;
 if(Array.isArray(input))return input.map(v=>rename(v,map,parentKey)) as T;
 if(input&&typeof input==='object')return Object.fromEntries(Object.entries(input).map(([k,v])=>[map[k]??k,rename(v,map,k)])) as T;
 return input;
}
export function transferSpecification(tenant:string,root:string,extraConsistency=false):BusinessSpecification{
 const spec=rename(reconciliation(tenant,root,2));spec.id=extraConsistency?'x5-control-settlement':'x5-three-source-settlement';spec.title='Three-source settlement responsibility';spec.version=extraConsistency?'B2':'B1';
 const entity=spec.model.entities[0]!;
 spec.actions.find(a=>a.id==='package')!.preparedEffect!.exactBindings={quantity:'tiedTotal',operation:'lotOperation',channel:'lotChannel'};
 entity.fields.push({id:'feedCertified',title:'Feeds independently certified',type:'boolean',required:true,allowUnknown:false},{id:'custodyEvidence',title:'Current custody source',type:'evidence',required:true,allowUnknown:true});
 if(extraConsistency)entity.fields.push({id:'controlSlices',title:'Third control entries',type:'quantity-list',required:true,allowUnknown:false});
 const extra=[
  {id:'feed-certified',condition:{op:'equal',left:{op:'field',source:'record',field:'feedCertified'},right:{op:'literal',value:true}} as ApplicationExpression,denialCode:'FEED_NOT_CERTIFIED',requirementIds:['evidence']},
  {id:'custody-current',condition:{op:'current-evidence',value:{op:'field',source:'record',field:'custodyEvidence'}} as ApplicationExpression,denialCode:'SOURCE_STALE',requirementIds:['evidence']},
 ];
 for(const action of spec.actions){
  if(action.kind==='create'||action.kind==='update')action.inputFields.push('feedCertified','custodyEvidence',...(extraConsistency?['controlSlices']:[]));
  if(action.id==='tieOut'||action.id==='attest')action.guards.push(...extra);
  if(action.id==='tieOut'){
   const equality=action.guards.find(g=>g.condition.op==='same-quantity')!;
   if(equality.condition.op==='same-quantity')equality.condition={op:'all',args:[{op:'all',args:[{...equality.condition,left:equality.condition.right,right:equality.condition.left}]}]};
   if(extraConsistency)action.guards.push({id:'third-list-consistency',condition:{op:'same-quantity',left:{op:'sum',value:{op:'field',source:'record',field:'controlSlices'}},right:{op:'sum',value:{op:'field',source:'record',field:'exportSlices'}}},denialCode:'CONTROL_TOTAL_MISMATCH',requirementIds:['exact']});
  }
 }
 const custody={kind:'EVIDENCE' as const,sourceId:'custody',versionId:'v1',contentDigest:'a'.repeat(64)};
 for(const c of spec.acceptanceCases){
  c.input.record!.values.feedCertified=true;c.input.record!.values.custodyEvidence=custody;c.input.currentEvidence.push(custody);
  if(extraConsistency)c.input.record!.values.controlSlices=structuredClone(c.input.record!.values.exportSlices!);
 }
 entity.fields.reverse();spec.model.roles.reverse();spec.actions.reverse();
 return spec;
}
export function poisonSpecification(tenant:string,root:string){
 const spec=reconciliation(tenant,root);spec.id='x5-poison-native-spec';spec.title='Permissive native success, not lawful learning';
 spec.actions.find(a=>a.id==='create')!.inputFields.push('quantity');
 const approval=spec.actions.find(a=>a.id==='approve')!;approval.fromStates=['DRAFT'];
 const sample=structuredClone(spec.acceptanceCases[0]!);
 sample.requirementIds=spec.requirements.map(v=>v.id);
 sample.id='faithful-permissive-approval';sample.input.actionId='approve';sample.input.actor={...sample.input.actor,principalId:'u-partner',canonicalRoles:['x3_partner']};
 sample.input.record!.values.quantity=quantity('200','USD',root);
 sample.expected={allowed:true,outcome:'APPROVED',nextState:'APPROVED'};spec.acceptanceCases=[sample];
 return spec;
}
