/** Encoding of the frozen business declarations, not an expected-answer engine.
 * Amounts and literal assertions come from scope-x3/acceptance. */
import type {BusinessSpecification,ApplicationExpression,ApplicationExecutionContext,ApplicationValues} from '../../packages/private-equity/src/enterprise-applications/contracts';
export const literal=(value:any):ApplicationExpression=>({op:'literal',value});
export const field=(name:string):ApplicationExpression=>({op:'field',source:'record',field:name});
const sum=(name:string):ApplicationExpression=>({op:'sum',value:field(name)});
const all=(...args:ApplicationExpression[]):ApplicationExpression=>({op:'all',args});
const equals=(left:ApplicationExpression,value:any):ApplicationExpression=>({op:'equal',left,right:literal(value)});
const not=(value:ApplicationExpression):ApplicationExpression=>({op:'not',value});
const dummy='a'.repeat(64);
export function quantity(amount:any,currency='USD',root='root'){
 return {kind:'QUANTITY',amount,currency,entity:{owner:'S1',id:root,revision:'1',contentDigest:dummy},units:'minor',time:{kind:'AS_OF',asOf:'2026-01-01T00:00:00.000Z'},accountingBasis:'RECORDED_MINOR'} as const;
}
export function reconciliation(tenant:string,root:string,version=1):BusinessSpecification{
 const names=['exact','evidence','approval','authority','lifecycle','effects'],req=(...ids:string[])=>ids.length?ids:names;
 const currencies=version>=2?['USD','INR','EUR']:['USD','INR'];
 const thresholds=currencies.map(currency=>({currency,amount:version>=2?'50000':'100000',units:'minor',accountingBasis:'RECORDED_MINOR',timeMode:'AS_OF' as const}));
 const guard=(id:string,condition:ApplicationExpression,denialCode:string,unknownCode?:string)=>({id,condition,denialCode,requirementIds:req(id==='amounts'?'exact':'evidence'),...(unknownCode?{unknownCode}:{})});
 const evidenceGuards=[
  guard('unknown',all(not(equals(field('bookStatus'),'UNKNOWN')),not(equals(field('bankStatus'),'UNKNOWN'))),'EVIDENCE_UNKNOWN'),
  guard('conflict',all(not(equals(field('bookStatus'),'CONFLICTING')),not(equals(field('bankStatus'),'CONFLICTING'))),'EVIDENCE_CONFLICTING'),
  guard('known',all({op:'known',value:field('book')},{op:'known',value:field('bank')}),'EVIDENCE_UNKNOWN'),
  guard('current',all({op:'current-evidence',value:field('bookEvidence')},{op:'current-evidence',value:field('bankEvidence')}),'SOURCE_STALE'),
 ];
 const base=(id:string,title:string,kind:'create'|'update'|'transition',fromStates:string[],toState:string,roles:string[],inputFields:string[]=[])=>({
  id,title,entityId:'reconciliation',kind,fromStates,toState,roles,inputFields,assignments:[],guards:[],outcome:id.toUpperCase(),requirementIds:req(),
 });
 const inputs=['memo','book','bank','bookStatus','bankStatus','bookEvidence','bankEvidence','operation','channel'];
 const spec:BusinessSpecification={
  schema:'finnor.business-specification.v1',profile:'PE_FIRM_TYPED_APPLICATION_V1',id:'firm-reconciliation',version:String(version),title:'Exact firm reconciliation',family:'PE_FIRM_OPERATIONS',
  owner:{id:tenant,version:'1'},model:{currencies:['USD','INR','EUR'],units:['minor'],timeModes:['AS_OF'],accountingBases:['RECORDED_MINOR'],
   roles:['analyst','partner','compliance'].map(id=>({id,canonicalRole:'x3_'+id})),
   entities:[{id:'reconciliation',title:'Reconciliation',states:['DRAFT','RECONCILED','APPROVED','PREPARED'],initialState:'DRAFT',fields:[
    {id:'memo',title:'Business memo',type:'text',required:true,allowUnknown:false,maxLength:8000},
    ...['book','bank'].map(id=>({id,title:id==='book'?'Book entries':'Bank entries',type:'quantity-list' as const,required:true,allowUnknown:true})),
    ...['bookStatus','bankStatus'].map(id=>({id,title:id,type:'enum' as const,options:['KNOWN','UNKNOWN','CONFLICTING'],required:true,allowUnknown:false})),
    ...['bookEvidence','bankEvidence'].map(id=>({id,title:id,type:'evidence' as const,required:true,allowUnknown:true})),
    {id:'quantity',title:'Exact reconciled amount',type:'quantity',required:false,allowUnknown:true},
    {id:'deltaMinor',title:'Signed dimensional difference, diagnostic only',type:'text',required:false,allowUnknown:true,maxLength:64},
    ...['operation','channel'].map(id=>({id,title:id,type:'text' as const,required:true,allowUnknown:false,maxLength:200})),
   ]}]},requirements:names.map(id=>({id,text:{exact:'Exact dimensional reconciliation without floating point.',evidence:'UNKNOWN, conflict and stale sources never approve.',approval:'Current non-self, distinct-principal approval with inclusive currency threshold.',authority:'Only canonical scoped roles authorize.',lifecycle:'Original records and release bindings survive maintenance.',effects:'Prepared intention is not dispatch.'}[id]!,critical:true})),
  unresolvedCriticalRequirementIds:[],invariants:[],actions:[
   {...base('create','Create reconciliation','create',[],'DRAFT',['analyst','partner','compliance'],inputs),outcome:'CREATED'},
   {...base('edit','Edit and explicitly rebase','update',['DRAFT','RECONCILED','APPROVED','PREPARED'],'DRAFT',['analyst'],inputs),outcome:'EDITED'},
   {...base('reconcile','Reconcile exact entries','transition',['DRAFT'],'RECONCILED',['analyst']),outcome:'RECONCILED',
    assignments:[{field:'quantity',value:sum('book')},{field:'deltaMinor',value:{op:'difference',left:sum('book'),right:sum('bank')}}],guards:[...evidenceGuards,
     guard('supported',{op:'currency-threshold',value:sum('book'),comparison:'gte',thresholds:thresholds.map(t=>({...t,amount:'0'}))},'UNSUPPORTED_CURRENCY','UNSUPPORTED_CURRENCY'),
     guard('amounts',{op:'same-quantity',left:sum('book'),right:sum('bank')},'AMOUNT_MISMATCH'),
    ]},
   {...base('approve','Approve reconciliation','transition',['RECONCILED'],'APPROVED',['partner','compliance']),outcome:'APPROVED',guards:evidenceGuards,
    approval:{requirements:[{role:'partner',when:literal(true)},{role:'compliance',when:{op:'currency-threshold',value:field('quantity'),comparison:'gte',thresholds}}],
     noSelfApproval:true,distinctPrincipals:true,pendingOutcome:'APPROVAL_RECORDED'}},
   {...base('prepare','Prepare exact intention, no dispatch','transition',['APPROVED','PREPARED'],'PREPARED',['analyst']),outcome:'PREPARED',guards:evidenceGuards,requiresApprovalsFrom:'approve',
    preparedEffect:{kind:'S4_EXACT_CONDITIONAL_DOSE',fields:['quantity','bookEvidence','bankEvidence','operation','channel']}},
   {...base('execute','Execution is outside this application','transition',['DRAFT','RECONCILED','APPROVED','PREPARED'],'PREPARED',['analyst','partner','compliance']),guards:[guard('execution',literal(false),'EXECUTION_OUT_OF_SCOPE')],outcome:'NEVER_EXECUTED'},
  ],acceptanceCases:[],
 };
 const bookEvidence={kind:'EVIDENCE' as const,sourceId:'book',versionId:'v1',contentDigest:dummy},bankEvidence={...bookEvidence,sourceId:'bank'};
 const values:ApplicationValues={memo:'Frozen development vector',book:{kind:'QUANTITY_LIST',entries:[quantity('9007199254740992','USD',root),quantity('1','USD',root)]},
  bank:{kind:'QUANTITY_LIST',entries:[quantity('9007199254740993','USD',root)]},bookStatus:'KNOWN',bankStatus:'KNOWN',bookEvidence,bankEvidence,operation:'LOCAL_PREPARE',channel:'LOCAL'};
 const context=(actionId:string,state:string,role='analyst',v:ApplicationValues=values):ApplicationExecutionContext=>({
  entityId:'reconciliation',actionId,installedReleaseId:'r'+version,tenantId:tenant,scopeId:root,
  actor:{principalId:'u-'+role,canonicalRoles:['x3_'+role],authorityRevision:'1',authorityCurrent:true,tenantId:tenant,scopeId:root},
  record:{entityId:'reconciliation',state,values:v,authorPrincipalId:'u-analyst',recordDigest:dummy,reference:{owner:'X3',id:'r',revision:'1',contentDigest:dummy},releaseId:'r'+version},
  expectedRecordDigest:dummy,expectedRecordReference:{owner:'X3',id:'r',revision:'1',contentDigest:dummy},input:{},approvals:[],currentAuthorities:[],currentEvidence:[bookEvidence,bankEvidence],currentRelations:[],
 });
 spec.acceptanceCases=[
  {id:'exact-match',requirementIds:['exact','lifecycle'],input:context('reconcile','DRAFT'),expected:{allowed:true,outcome:'RECONCILED',nextState:'RECONCILED'}},
  {id:'one-minor-mismatch',requirementIds:['exact'],input:context('reconcile','DRAFT','analyst',{...values,bank:{kind:'QUANTITY_LIST',entries:[quantity('9007199254740992','USD',root)]}}),expected:{allowed:false,outcome:'AMOUNT_MISMATCH',nextState:'DRAFT'}},
  {id:'wrong-role',requirementIds:['authority'],input:context('reconcile','DRAFT','partner'),expected:{allowed:false,outcome:'ROLE_DENIED',nextState:'DRAFT'}},
  {id:'unknown',requirementIds:['evidence'],input:context('reconcile','DRAFT','analyst',{...values,bankStatus:'UNKNOWN'}),expected:{allowed:false,outcome:'EVIDENCE_UNKNOWN',nextState:'DRAFT'}},
  {id:'high-approval',requirementIds:['approval'],input:context('approve','RECONCILED','partner',{...values,quantity:quantity('9007199254740993','USD',root)}),expected:{allowed:true,outcome:'APPROVAL_RECORDED',nextState:'RECONCILED'}},
  {id:'execute-refused',requirementIds:['effects'],input:context('execute','DRAFT','partner'),expected:{allowed:false,outcome:'EXECUTION_OUT_OF_SCOPE',nextState:'DRAFT'}},
 ];
 return spec;
}
export function exceptionRegister(tenant:string,root:string):BusinessSpecification{
 const spec=reconciliation(tenant,root),required=['controls'];
 spec.id='control-exceptions';spec.title='Firm control-exception register';spec.model={...spec.model,roles:[{id:'operator',canonicalRole:'x3_analyst'},{id:'reviewer',canonicalRole:'x3_partner'}],
  entities:[{id:'control_exception',title:'Control exception',states:['OPEN','EVIDENCED','CLOSED'],initialState:'OPEN',fields:[
   {id:'memo',title:'Exception memo',type:'text',required:true,allowUnknown:false,maxLength:8000},
   {id:'remediation',title:'Remediation',type:'text',required:true,allowUnknown:false,maxLength:8000},
   {id:'support',title:'Canonical support',type:'evidence',required:true,allowUnknown:true},
  ]}]};
 spec.requirements=[{id:'controls',text:'The frozen independently specified control exception workflow, canonical roles, source currentness and no self review.',critical:true}];
 const base={entityId:'control_exception',assignments:[],guards:[],requirementIds:required};
 const current={id:'support-current',condition:{op:'current-evidence' as const,value:field('support')},denialCode:'SOURCE_STALE',requirementIds:required};
 spec.actions=[
  {...base,id:'create',title:'Record control exception',kind:'create',fromStates:[],toState:'OPEN',roles:['operator'],inputFields:['memo','remediation','support'],outcome:'CREATED'},
  {...base,id:'document',title:'Document remediation',kind:'transition',fromStates:['OPEN'],toState:'EVIDENCED',roles:['operator'],inputFields:[],guards:[current],outcome:'EVIDENCED'},
  {...base,id:'close',title:'Independently close exception',kind:'transition',fromStates:['EVIDENCED'],toState:'CLOSED',roles:['reviewer'],inputFields:[],guards:[current],outcome:'CLOSED',
   approval:{requirements:[{role:'reviewer',when:literal(true)}],noSelfApproval:true,distinctPrincipals:true,pendingOutcome:'REVIEW_PENDING'}},
 ];
 const source={kind:'EVIDENCE' as const,sourceId:'support',versionId:'v1',contentDigest:dummy},v={memo:'Quarterly access review missing',remediation:'Independent reviewer confirms complete access inventory',support:source};
 const context=spec.acceptanceCases[0]!.input;
 spec.acceptanceCases=[{id:'document',requirementIds:required,input:{...context,entityId:'control_exception',actionId:'document',
  record:{...context.record!,entityId:'control_exception',state:'OPEN',values:v},currentEvidence:[source]},expected:{allowed:true,outcome:'EVIDENCED',nextState:'EVIDENCED'}}];
 return spec;
}
