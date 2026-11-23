/** S2/S3 bounded, nonprobabilistic digital experiment contract. No effect,
 * permission, likelihood, unique-mechanism or production authority is produced. */
import {createHash} from 'node:crypto';
import type {
 DigitalAtom,DigitalPredicate,DigitalCondition,DigitalIdentificationDomain,DigitalTrial,
 IdentificationFamily,IdentificationAnalysis,DigitalObservation,DigitalForecast,DigitalSelectionScore,IdentificationRefutation,
} from '../../shared-types/src/identified-system';
export const IDENTIFICATION_LIMITS=Object.freeze({features:6,featureValues:8,records:16,conditions:64,experiments:64,observations:256,predicates:16384,numeric:49,storage:16*1024*1024,childWallMs:30000,childHeapMiB:256,childOutput:65536,ipcBytes:4*1024*1024});
export function identificationCanonical(v:unknown):string{
 if(Array.isArray(v))return '['+v.map(identificationCanonical).join(',')+']';
 if(v!==null&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+identificationCanonical((v as Record<string,unknown>)[k])).join(',')+'}';
 return JSON.stringify(v);
}
export const identificationDigest=(v:unknown)=>createHash('sha256').update(identificationCanonical(v)).digest('hex');
function refuse(code:string):never{throw Error('X4_'+code);}
export function digitalConditions(d:DigitalIdentificationDomain):DigitalCondition[]{
 const conditions:DigitalCondition[]=[];
 for(const updateTiming of d.interventions.updateTiming)for(const pageSize of d.interventions.pageSize)for(const visibility of d.interventions.visibility){
  const body={updateTiming,pageSize,visibility};
  conditions.push({...body,id:identificationDigest(body).slice(0,24),costUnits:d.costUnits,risk:0,exposure:d.records.length});
 }
 if(conditions.length<3||conditions.length>64||new Set(conditions.map(c=>c.id)).size!==conditions.length)refuse('CONDITION_DOMAIN_BOUND');
 return conditions.sort((a,b)=>a.id.localeCompare(b.id));
}
export const conditionMatches=(c:DigitalCondition,v:DigitalIdentificationDomain['ordinary'])=>c.updateTiming===v.updateTiming&&c.pageSize===v.pageSize&&c.visibility===v.visibility;
export function digitalFeatures(d:DigitalIdentificationDomain,c:DigitalCondition,index:number):Record<string,number>{
 const r=d.records[index];if(!r)refuse('RECORD_DOMAIN_BOUND');
 return {updatedSlot:r.update==='PREEXISTING'?-1:c.updateTiming,position:index+1,pageWindow:c.pageSize,
  roleVisible:d.role==='auditor'||r.visibility==='PUBLIC'?1:c.visibility,...r.features};
}
export function digitalTrial(d:DigitalIdentificationDomain,c:DigitalCondition,instanceId:string,id:string,recordIds:string[]):DigitalTrial{
 if(recordIds.length!==d.records.length||new Set(recordIds).size!==recordIds.length)refuse('FRESH_RECORD_IDENTITIES_REQUIRED');
 return {id,instanceId,applicationVersion:d.applicationVersion,role:d.role,controls:{updateTiming:c.updateTiming,pageSize:c.pageSize},
  records:d.records.map((r,i)=>({id:recordIds[i]!,features:digitalFeatures(d,c,i),value:r.value}))};
}
export function evaluateDigitalPredicate(p:DigitalPredicate,features:Record<string,number>):boolean{
 switch(p.op){
  case'TRUE':return true;case'FALSE':return false;
  case'NOT':return !evaluateDigitalPredicate(p.arg,features);
  case'AND':return evaluateDigitalPredicate(p.args[0],features)&&evaluateDigitalPredicate(p.args[1],features);
  case'OR':return evaluateDigitalPredicate(p.args[0],features)||evaluateDigitalPredicate(p.args[1],features);
  default:{
   const left=features[p.left],right='field'in p.right?features[p.right.field]:p.right.constant;
   if(!Number.isSafeInteger(left)||!Number.isSafeInteger(right))refuse('UNDECLARED_FEATURE');
   return p.op==='EQ'?left===right:p.op==='LT'?left!<right!:left!<=right!;
  }
 }
}
export function digitalValue(a:number,b:number,value:string):string{
 const result=BigInt(a)*BigInt(value)+BigInt(b);
 if(result>9007199254740991n||result< -9007199254740991n)refuse('EXACT_INTEGER_OUTPUT_BOUND');
 return String(result);
}
function deadline(at:number){if(Date.now()>=at)refuse('SEARCH_DEADLINE_EXHAUSTED');}
/** Generate grammar closure, never a mechanism-name menu. Semantically equal
 * atoms are compressed with multiplicities before Boolean closure. */
export function generateDigitalFamily(domain:DigitalIdentificationDomain,deadlineAt:number):IdentificationFamily{
 const conditions=digitalConditions(domain),vectors=conditions.flatMap(c=>domain.records.map((_,i)=>digitalFeatures(domain,c,i)));
 const names=Object.keys(vectors[0]??{}).sort(),featureDomains:Record<string,number[]>={};
 if(names.length<1||names.length>6||domain.records.length<2||domain.records.length>16)refuse('REPRESENTATION_BOUND');
 for(const name of names){
  if(vectors.some(v=>Object.keys(v).sort().join('|')!==names.join('|')))refuse('FEATURE_MEMBERSHIP_CHANGED');
  featureDomains[name]=[...new Set(vectors.map(v=>v[name]!))].sort((a,b)=>a-b);
  if(featureDomains[name]!.length>8||featureDomains[name]!.some(n=>!Number.isSafeInteger(n)))refuse('FEATURE_DOMAIN_BOUND');
 }
 const basis=new Map<string,DigitalAtom>();
 const addAtom=(a:DigitalAtom)=>basis.set(identificationCanonical(a),a);
 addAtom({op:'TRUE'});addAtom({op:'FALSE'});
 for(const name of names){
  for(const constant of featureDomains[name]!)for(const op of ['EQ','LT','LE'] as const){
   const atom={op,left:name,right:{constant}};addAtom(atom);addAtom({op:'NOT',arg:atom});
  }
  for(const other of names)if(other!==name)for(const op of ['EQ','LT','LE'] as const){
   if(op==='EQ'&&name>other)continue;
   const atom={op,left:name,right:{field:other}};addAtom(atom);addAtom({op:'NOT',arg:atom});
  }
 }
 const atomBasis=[...basis.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,v])=>v);
 type Group={mask:bigint;ast:DigitalAtom;count:number};
 const atomGroups=new Map<string,Group>(),family=new Map<string,{mask:bigint;ast:DigitalPredicate;count:number}>();
 const better=(a:DigitalPredicate,b:DigitalPredicate)=>{
  const x=identificationCanonical(a),y=identificationCanonical(b);return x.length<y.length||x.length===y.length&&x<y;
 };
 for(const atom of atomBasis){
  deadline(deadlineAt);let mask=0n;
  vectors.forEach((v,i)=>{if(evaluateDigitalPredicate(atom,v))mask|=1n<<BigInt(i);});
  const key=mask.toString(16),prior=atomGroups.get(key);
  if(prior){prior.count++;if(better(atom,prior.ast))prior.ast=atom;}
  else atomGroups.set(key,{mask,ast:atom,count:1});
 }
 const add=(mask:bigint,ast:DigitalPredicate,count:number)=>{
  const key=mask.toString(16),old=family.get(key);
  if(old){old.count+=count;if(better(ast,old.ast))old.ast=ast;}
  else{if(family.size>=16384)refuse('PREDICATE_REPRESENTATION_EXHAUSTED');family.set(key,{mask,ast,count});}
 };
 const groups=[...atomGroups.values()];
 for(const a of groups)add(a.mask,a.ast,a.count);
 for(let i=0;i<groups.length;i++){
  deadline(deadlineAt);
  for(let j=i;j<groups.length;j++){
   const a=groups[i]!,b=groups[j]!,count=i===j?a.count*(a.count+1)/2:a.count*b.count;
   const args=[a.ast,b.ast].sort((x,y)=>identificationCanonical(x).localeCompare(identificationCanonical(y))) as [DigitalAtom,DigitalAtom];
   add(a.mask&b.mask,{op:'AND',args},count);add(a.mask|b.mask,{op:'OR',args},count);
  }
 }
 const predicates=[...family.values()].sort((a,b)=>a.mask<b.mask?-1:a.mask>b.mask?1:0)
  .map((p,i)=>({id:'P'+String(i).padStart(5,'0'),ast:p.ast,truthHex:p.mask.toString(16),syntacticAlternatives:p.count}));
 const numeric:IdentificationFamily['numeric']=[];
 for(let a=-3;a<=3;a++)for(let b=-3;b<=3;b++)numeric.push({id:'N'+String(numeric.length).padStart(2,'0'),a,b});
 return {schema:'finnor.s3.generated-digital-family.v1',grammar:'CONSTANT_COMPARISON_NEGATION_TWO_ATOM_BOOLEAN_AFFINE_V1',
  domainDigest:identificationDigest(domain),featureDomains,conditionIds:conditions.map(c=>c.id),vectorCount:vectors.length,atomBasis,predicates,numeric,
  rawSyntaxCount:atomBasis.length+atomBasis.length*(atomBasis.length+1),
  representation:'EXACT_FINITE_BEHAVIORAL_QUOTIENT_FACTORIZED_PRODUCT',transport:'REGISTERED_CONDITION_RECORD_VECTORS_ONLY'};
}
function maskFor(program:IdentificationFamily['predicates'][number],conditionIndex:number,records:number):string{
 const mask=(BigInt('0x'+program.truthHex)>>BigInt(conditionIndex*records))&((1n<<BigInt(records))-1n);
 return mask.toString(16);
}
export function analyzeDigitalObservations(f:IdentificationFamily,observations:DigitalObservation[]):IdentificationAnalysis{
 let predicateIds=f.predicates.map(p=>p.id),numericIds=f.numeric.map(p=>p.id);
 const refutations:IdentificationRefutation[]=[];
 for(const o of observations){
  const ci=f.conditionIds.indexOf(o.conditionId);if(ci<0)refuse('OBSERVATION_OUTSIDE_DOMAIN');
  const included=new Map(o.records.map(r=>[r.id,r.value]));
  if(included.size!==o.records.length||o.records.some(r=>!o.trial.records.some(v=>v.id===r.id)))refuse('OBSERVATION_IDENTITY_INVALID');
  let actual=0n;o.trial.records.forEach((r,i)=>{if(included.has(r.id))actual|=1n<<BigInt(i);});
  const actualHex=actual.toString(16),remaining=new Set(predicateIds),groups=new Map<string,string[]>();
  for(const p of f.predicates)if(remaining.has(p.id)){
   const predicted=maskFor(p,ci,o.trial.records.length);
   if(predicted!==actualHex){let group=groups.get(predicted);if(!group){group=[];groups.set(predicted,group);}group.push(p.id);remaining.delete(p.id);}
  }
  for(const [prediction,programIds]of groups)refutations.push({kind:'PREDICATE',programIds,experimentId:o.experimentId,prediction,observation:actualHex});
  predicateIds=[...remaining];
  numericIds=numericIds.filter(id=>{
   const p=f.numeric.find(p=>p.id===id)!;
   const mismatch=o.trial.records.find(r=>included.has(r.id)&&digitalValue(p.a,p.b,r.value)!==included.get(r.id));
   if(!mismatch)return true;
   refutations.push({kind:'AFFINE',programIds:[id],experimentId:o.experimentId,prediction:digitalValue(p.a,p.b,mismatch.value),observation:included.get(mismatch.id)!});return false;
  });
 }
 return {predicateIds,numericIds,refutations,analyzedExperimentIds:observations.map(o=>o.experimentId),observationalEquivalence:'ALL_SURVIVING_PROGRAMMES_RETAINED'};
}
export function forecastDigitalCondition(f:IdentificationFamily,a:IdentificationAnalysis,d:DigitalIdentificationDomain,c:DigitalCondition):DigitalForecast{
 const ci=f.conditionIds.indexOf(c.id);if(ci<0)refuse('PREDICTION_OUTSIDE_DOMAIN');
 const accepted=new Set(a.predicateIds),inclusion=new Map<string,string[]>();
 for(const p of f.predicates)if(accepted.has(p.id)){
  const mask=maskFor(p,ci,d.records.length);let group=inclusion.get(mask);if(!group){group=[];inclusion.set(mask,group);}group.push(p.id);
 }
 const numeric=new Map<string,{programIds:string[];values:string[]}>();
 for(const id of a.numericIds){
  const p=f.numeric.find(p=>p.id===id)!;const values=d.records.map(r=>digitalValue(p.a,p.b,r.value)),key=JSON.stringify(values);
  const old=numeric.get(key);if(old)old.programIds.push(id);else numeric.set(key,{programIds:[id],values});
 }
 return {familyDigest:identificationDigest(f),conditionId:c.id,inclusion:[...inclusion].map(([mask,programIds])=>({mask,programIds})),
  numeric:[...numeric.values()],semantics:'FROZEN_BEFORE_DISPATCH_NO_PRIORS_OR_LIKELIHOODS'};
}
export function scoreDigitalCondition(f:IdentificationFamily,a:IdentificationAnalysis,d:DigitalIdentificationDomain,c:DigitalCondition):DigitalSelectionScore{
 const forecast=forecastDigitalCondition(f,a,d,c),total=a.predicateIds.length*a.numericIds.length;
 let largestPartition=0;
 for(const inc of forecast.inclusion){
  const mask=BigInt('0x'+inc.mask),groups=new Map<string,number>();
  for(const n of forecast.numeric){
   const output=n.values.filter((_,i)=>(mask&(1n<<BigInt(i)))!==0n),key=JSON.stringify(output);
   groups.set(key,(groups.get(key)??0)+n.programIds.length);
  }
  for(const count of groups.values())largestPartition=Math.max(largestPartition,count*inc.programIds.length);
 }
 return {conditionId:c.id,total,largestPartition,worstCaseEliminated:total-largestPartition,costUnits:c.costUnits,risk:c.risk,exposure:c.exposure};
}
export function selectDigitalExperiment(f:IdentificationFamily,a:IdentificationAnalysis,d:DigitalIdentificationDomain,used:string[],deadlineAt:number){
 const conditions=digitalConditions(d),withheld=conditions.find(c=>conditionMatches(c,d.withheld));
 if(!withheld)refuse('WITHHELD_CONDITION_REQUIRED');
 const scores=conditions.filter(c=>c.id!==withheld.id&&!used.includes(c.id)).map(c=>{deadline(deadlineAt);return scoreDigitalCondition(f,a,d,c);});
 scores.sort((x,y)=>y.worstCaseEliminated*x.costUnits-x.worstCaseEliminated*y.costUnits||x.risk-y.risk||x.exposure-y.exposure||x.conditionId.localeCompare(y.conditionId));
 const best=scores[0];
 return {condition:best&&best.worstCaseEliminated>0?conditions.find(c=>c.id===best.conditionId)!:null,scores};
}
export function unanimousDigitalForecast(f:DigitalForecast):boolean{
 if(f.inclusion.length!==1||!f.numeric.length)return false;
 const mask=BigInt('0x'+f.inclusion[0]!.mask),outputs=f.numeric.map(n=>n.values.filter((_,i)=>(mask&(1n<<BigInt(i)))!==0n));
 return new Set(outputs.map(v=>JSON.stringify(v))).size===1;
}
export function digitalForecastMatches(f:DigitalForecast,trial:DigitalTrial,records:Array<{id:string;value:string}>):boolean{
 if(!unanimousDigitalForecast(f))return false;
 const mask=BigInt('0x'+f.inclusion[0]!.mask),values=f.numeric[0]!.values;
 const expected=trial.records.flatMap((r,i)=>(mask&(1n<<BigInt(i)))!==0n?[{id:r.id,value:values[i]!}]:[]);
 const sort=(rows:typeof records)=>[...rows].sort((x,y)=>x.id.localeCompare(y.id));
 return identificationCanonical(sort(expected))===identificationCanonical(sort(records));
}
