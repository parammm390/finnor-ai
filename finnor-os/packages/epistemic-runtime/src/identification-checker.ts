/** Independent S3 checker. Intentionally does NOT import the producer,
 * instrument, broker, fixture, candidate normalizer or test-oracle source. */
import {createHash} from 'node:crypto';
import type {
 DigitalAtom,DigitalPredicate,DigitalIdentificationDomain,DigitalExperimentProtocol,
 DigitalHttpReceipt,DigitalInstrumentCertificate,DigitalIdentificationCheckInput,
 IdentificationFamily,IdentificationAnalysis,IdentificationIndependentCheck,DigitalObservation,
} from '../../shared-types/src/identified-system';
function reject(code:string):never{throw Error('X4_INDEPENDENT_CHECK_'+code);}
function encode(v:unknown):string{
 if(Array.isArray(v))return '['+v.map(encode).join(',')+']';
 if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+encode((v as Record<string,unknown>)[k])).join(',')+'}';
 return JSON.stringify(v);
}
const hash=(v:unknown)=>createHash('sha256').update(encode(v)).digest('hex');
function object(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))reject('OBJECT_REQUIRED');return v as Record<string,unknown>;}
function list(v:unknown):unknown[]{if(!Array.isArray(v))reject('ARRAY_REQUIRED');return v;}
const instant=(v:unknown)=>{if(typeof v!=='string'||!Number.isFinite(Date.parse(v)))reject('CLOCK_INVALID');return Date.parse(v);};
function integer(v:unknown):string{
 if(typeof v!=='string'||! /^(0|-?[1-9][0-9]{0,15})$/.test(v)||BigInt(v)>9007199254740991n||BigInt(v)< -9007199254740991n)reject('INTEGER_OR_UNIT_INVALID');
 return v;
}
function fields(d:DigitalIdentificationDomain,c:{updateTiming:number;pageSize:number;visibility:number},i:number):Record<string,number>{
 const t=d.records[i]!;
 return {...t.features,updatedSlot:t.update==='PREEXISTING'?-1:c.updateTiming,position:i+1,pageWindow:c.pageSize,roleVisible:d.role==='auditor'||t.visibility==='PUBLIC'?1:c.visibility};
}
function conditions(d:DigitalIdentificationDomain){
 const out:Array<{id:string;updateTiming:number;pageSize:number;visibility:number}>=[];
 for(const t of d.interventions.updateTiming)for(const p of d.interventions.pageSize)for(const v of d.interventions.visibility){
  const body={updateTiming:t,pageSize:p,visibility:v};out.push({...body,id:hash(body).slice(0,24)});
 }
 return out.sort((x,y)=>x.id.localeCompare(y.id));
}
function evaluate(ast:DigitalPredicate,row:Record<string,number>):boolean{
 if(ast.op==='TRUE')return true;if(ast.op==='FALSE')return false;
 if(ast.op==='NOT')return !evaluate(ast.arg,row);
 if(ast.op==='AND'||ast.op==='OR'){const [x,y]=ast.args.map(p=>evaluate(p,row));return ast.op==='AND'?x!&&y!:x!||y!;}
 const atom=ast as Extract<DigitalAtom,{left:string}>,left=row[atom.left],right='constant'in atom.right?atom.right.constant:row[atom.right.field];
 if(!Number.isSafeInteger(left)||!Number.isSafeInteger(right))reject('PROGRAMME_VARIABLE_UNBOUND');
 if(atom.op==='EQ')return left===right;if(atom.op==='LT')return left!<right!;if(atom.op==='LE')return left!<=right!;
 return reject('PROGRAMME_OPCODE_UNSUPPORTED');
}
function exact(a:number,b:number,v:string){return String(BigInt(a)*BigInt(v)+BigInt(b));}
function independentClosure(d:DigitalIdentificationDomain,f:IdentificationFamily,deadline:number){
 const cs=conditions(d),rows=cs.flatMap(c=>d.records.map((_,i)=>fields(d,c,i))),variables=Object.keys(rows[0]??{}).sort();
 const values=Object.fromEntries(variables.map(n=>[n,[...new Set(rows.map(r=>r[n]!))].sort((a,b)=>a-b)]));
 if(hash(values)!==hash(f.featureDomains)||hash(cs.map(c=>c.id))!==hash(f.conditionIds)||rows.length!==f.vectorCount||f.domainDigest!==hash(d))reject('DOMAIN_VECTOR_SUBSTITUTION');
 const atoms=new Map<string,DigitalAtom>();
 for(const op of ['TRUE','FALSE'] as const){const p={op};atoms.set(encode(p),p);}
 for(const left of variables){
  const rights:Array<{constant:number}|{field:string}>=[...values[left]!.map(constant=>({constant})),...variables.filter(v=>v!==left).map(field=>({field}))];
  for(const right of rights)for(const op of ['LE','EQ','LT'] as const){
   if(op==='EQ'&&'field'in right&&right.field<left)continue;
   const p={op,left,right},not={op:'NOT' as const,arg:p};atoms.set(encode(p),p);atoms.set(encode(not),not);
  }
 }
 const basis=[...atoms.values()].sort((x,y)=>encode(x).localeCompare(encode(y)));
 if(hash(basis)!==hash(f.atomBasis)||f.rawSyntaxCount!==basis.length+basis.length*(basis.length+1))reject('GRAMMAR_BASIS_OMITTED');
 const truth=(p:DigitalPredicate)=>rows.reduce((m,row,i)=>evaluate(p,row)?m|(1n<<BigInt(i)):m,0n);
 const masks=basis.map(truth),counts=new Map<string,number>();
 const add=(m:bigint)=>{const k=m.toString(16);counts.set(k,(counts.get(k)??0)+1);};
 masks.forEach(add);
 for(let a=0;a<masks.length;a++){
  if(Date.now()>=deadline)reject('DEADLINE');
  for(let b=a;b<masks.length;b++){add(masks[a]!&masks[b]!);add(masks[a]!|masks[b]!);}
 }
 if(counts.size>16384||counts.size!==f.predicates.length||new Set(f.predicates.map(p=>p.id)).size!==f.predicates.length)reject('GRAMMAR_CLOSURE_OMITTED');
 const ordered=[...counts.keys()].sort((a,b)=>BigInt('0x'+a)<BigInt('0x'+b)?-1:1);
 f.predicates.forEach((p,i)=>{
  if(p.id!=='P'+String(i).padStart(5,'0')||p.truthHex!==ordered[i]||counts.get(p.truthHex)!==p.syntacticAlternatives||truth(p.ast).toString(16)!==p.truthHex)reject('PROGRAMME_CLASS_OR_EQUIVALENCE_INVALID');
  const valid=(a:DigitalAtom)=>atoms.has(encode(a));
  if(p.ast.op==='AND'||p.ast.op==='OR'){if(!p.ast.args.every(valid))reject('PROGRAMME_OUTSIDE_GRAMMAR');}
  else if(!valid(p.ast as DigitalAtom))reject('PROGRAMME_OUTSIDE_GRAMMAR');
 });
 const numerical=[];for(let a=-3;a<=3;a++)for(let b=-3;b<=3;b++)numerical.push({id:'N'+String(numerical.length).padStart(2,'0'),a,b});
 if(hash(numerical)!==hash(f.numeric))reject('NUMERIC_CLOSURE_OMITTED');
 return {cs,rows};
}
/** A separately implemented raw cursor walk. A displayed page count is never
 * coverage. Pending responses cannot stand in for an empty terminal result. */
export function checkRawDigitalPages(receipts:DigitalHttpReceipt[],binding:{instanceId:string;applicationVersion:string;role:string;experimentId?:string;completedAt?:string}){
 if(!receipts.length||receipts.length>64)reject('PAGE_BOUND');
 const seen=new Set<string>(),ids=new Set<string>(),rows:Array<{id:string;value:string}>=[];
 let expected:string|null=null,terminal=false,identity:string|undefined,last:Record<string,unknown>|undefined;
 for(const r of receipts){
  if(r.status!==200||r.cursor!==expected||terminal)reject('CURSOR_OR_HTTP_STATUS');
  const p=object(r.body);
  if(p.instanceId!==binding.instanceId||p.applicationVersion!==binding.applicationVersion||p.role!==binding.role||p.units!=='count')reject('INSTRUMENT_IDENTITY_UNIT_VERSION');
  if(typeof p.experimentId!=='string'||identity&&p.experimentId!==identity||binding.experimentId&&p.experimentId!==binding.experimentId)reject('PAGE_EXPERIMENT_IDENTITY');
  identity=p.experimentId as string;
  if(instant(p.observedAt)>instant(r.receivedAt)+1000)reject('PAGE_FUTURE_CLOCK');
  if(p.available===false){if(list(p.records).length||p.nextCursor!==null||r.cursor!==null)reject('PENDING_NOT_EMPTY');continue;}
  if(p.available!==true||typeof p.completedAt!=='string'||binding.completedAt&&p.completedAt!==binding.completedAt)reject('AVAILABILITY_OR_STALE_CLOCK');
  if(instant(p.completedAt)>instant(p.observedAt))reject('OBSERVATION_PRECEDES_COMPLETION');
  const page=list(p.records);if(page.length>16)reject('PAGE_RECORD_BOUND');
  for(const value of page){const row=object(value);if(typeof row.id!=='string'||ids.has(row.id))reject('DUPLICATE_OR_MISSING_ID');ids.add(row.id);rows.push({id:row.id,value:integer(row.value)});}
  if(p.nextCursor===null){terminal=true;last=p;continue;}
  if(typeof p.nextCursor!=='string'||!p.nextCursor||p.nextCursor.length>256||seen.has(p.nextCursor))reject('REPEATED_OR_INVALID_CURSOR');
  seen.add(p.nextCursor);expected=p.nextCursor;
 }
 if(!terminal||!last)reject('TRUNCATED_OR_PENDING');
 return {records:rows,last};
}
function literalControls(role:string){
 const rows=(prefix:string,values:string[])=>values.map((value,i)=>({id:prefix+String(i+1).padStart(12,'0'),value}));
 return [
  {id:'empty',records:[]},
  {id:'pagination',records:rows('10000000-0000-4000-8000-',['-4','0','7','23','101'])},
  {id:'timing',records:rows('20000000-0000-4000-8000-',['11'])},
  {id:role==='auditor'?'role-auditor':'role-analyst',records:rows('30000000-0000-4000-8000-',role==='auditor'?['13','17']:['13'])},
  {id:'integer-units',records:rows('40000000-0000-4000-8000-',['-9007199254740991','0','9007199254740991'])},
  {id:'delayed',records:rows('70000000-0000-4000-8000-',['31'])},
  {id:'duplicates',records:rows('50000000-0000-4000-8000-',['19']),negative:true},
  {id:'stale',records:rows('60000000-0000-4000-8000-',['29']),negative:true},
  {id:'repeated-cursor',records:rows('80000000-0000-4000-8000-',['2','3','5','7','11']),negative:true},
  {id:'skipped-cursor',records:rows('90000000-0000-4000-8000-',['2','3','5','7','11']),negative:true},
 ];
}
export function checkDigitalInstrumentCertificate(c:DigitalInstrumentCertificate){
 const binding={instanceId:c.instanceId,applicationVersion:c.applicationVersion,role:c.role};
 if(c.disposition!=='VALIDATED_DEVELOPMENT'||new Set(c.controls.map(v=>v.controlId)).size!==c.controls.length||instant(c.completedAt)<instant(c.registeredAt)||instant(c.validUntil)<=instant(c.completedAt))reject('CERTIFICATE_BINDING');
 for(const expected of literalControls(c.role)){
  const control=c.controls.find(v=>v.controlId===expected.id);if(!control)reject('CONTROL_OMITTED');
  if(!control.requests.length||control.requests.some(r=>r.status!==200))reject('CONTROL_HTTP_FAILURE_IS_NOT_DEFECT_DETECTION');
  let valid=false;
  try{
   const actual=checkRawDigitalPages(control.requests,binding);
   valid=hash(actual.records)===hash(expected.records);
   if(expected.id==='pagination'&&control.requests.filter(r=>object(r.body).available===true).length!==3)valid=false;
   if(expected.id==='delayed'&&!control.requests.some(r=>object(r.body).available===false))valid=false;
   if(expected.id==='timing'){
    const time=object(actual.last.timing),events=list(time.events);
    const expectedEvents=['accepted','started','completed'].map((type,i)=>({id:'21000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),type,at:['2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.120Z','2026-01-01T00:00:00.240Z'][i]}));
    valid=valid&&time.requestedAt==='2026-01-01T00:00:00.000Z'&&time.startedAt==='2026-01-01T00:00:00.120Z'&&time.completedAt==='2026-01-01T00:00:00.240Z'&&hash(events)===hash(expectedEvents);
   }
  }catch{valid=false;}
  if(expected.negative?valid:!valid)reject('KNOWN_CONTROL_'+expected.id.toUpperCase().replaceAll('-','_'));
 }
 const missing=c.controls.find(v=>v.controlId==='missing');
 if(!missing||missing.requests.length!==1||missing.requests[0]!.status!==404)reject('MISSING_IS_NOT_EMPTY');
 return true;
}
function observationFromRaw(e:DigitalIdentificationCheckInput['experiments'][number]):DigitalObservation{
 const p=e.protocol,t=p.trial,receipts=e.raw.readbacks;
 const final=receipts.at(-1);if(!final||final.status!==200)reject('READBACK_MISSING');
 const r=object(final.body);
 if(r.id!==t.id||r.instanceId!==t.instanceId||r.applicationVersion!==t.applicationVersion||r.role!==t.role||r.units!=='count'||r.status!=='COMPLETE'||hash(r.delivered)!==hash(t))reject('ACTUAL_EXPOSURE_NOT_INTENT');
 if(instant(e.registeredAt)>=instant(r.requestedAt)||instant(p.instrumentRef.revision)>instant(r.requestedAt))reject('PREDICTION_POSTHOC');
 const requestAt=instant(r.requestedAt),startAt=instant(r.startedAt),completedAt=instant(r.completedAt);
 if(startAt<=requestAt||completedAt<=startAt)reject('EXECUTION_TIMING');
 const events=list(r.events).map(object);const eventIds=new Set<string>();let previous=-Infinity;
 events.forEach((v,i)=>{const at=instant(v.at);if(typeof v.id!=='string'||eventIds.has(v.id)||v.sequence!==i+1||at<previous)reject('EVENT_IDENTITY_ORDER');eventIds.add(v.id);previous=at;});
 const accepted=events.filter(v=>v.type==='accepted');
 if(accepted.length!==1||accepted[0]!==events[0]||instant(accepted[0]!.at)<requestAt||instant(accepted[0]!.at)>=startAt)reject('REQUEST_ACCEPTANCE_ORDER');
 const starts=events.filter(v=>v.type==='started'),ends=events.filter(v=>v.type==='completed');
 if(starts.length!==1||ends.length!==1)reject('EXECUTION_EVENT_MISSING');
 // Phase timestamps describe the operation; journal timestamps describe the
 // subsequent durable notifications. Validate their causal intervals, not an
 // invented equality between two independently recorded clock reads.
 const startEventAt=instant(starts[0]!.at),endEventAt=instant(ends[0]!.at);
 if(startEventAt<startAt||startEventAt>=completedAt||endEventAt<completedAt)reject('EXECUTION_EVENT_ORDER');
 const written=events.filter(v=>v.type==='output-written');
 if(written.length!==1||written[0]!==events.at(-1)||instant(written[0]!.at)<endEventAt)reject('OUTPUT_NOT_WRITTEN');
 const prepared=events.find(v=>v.type==='records-prepared'),preparedIds=t.records.filter(v=>v.features.updatedSlot===-1).map(v=>v.id).sort();
 if(!prepared||events.filter(v=>v.type==='records-prepared').length!==1||instant(prepared.at)<instant(accepted[0]!.at)||instant(prepared.at)>=startAt||hash(list(prepared.recordIds).slice().sort())!==hash(preparedIds))reject('INITIAL_RECORD_SET');
 for(const slot of [1,3]){
  const ids=t.records.filter(v=>v.features.updatedSlot===slot).map(v=>v.id).sort();
  const updates=events.filter(v=>v.type==='records-updated'&&v.detail==='slot:'+slot);
  if(ids.length){
   const update=updates[0];if(updates.length!==1||!update||hash(list(update.recordIds).slice().sort())!==hash(ids))reject('UPDATE_EXPOSURE');
   const at=instant(update.at);if(slot===1?!(requestAt<at&&at<startAt):!(startEventAt<at&&at<completedAt))reject('UPDATE_TIMING_AMBIGUOUS');
  }else if(updates.length)reject('UNREQUESTED_UPDATE');
 }
 const observed=checkRawDigitalPages(e.raw.pages,{instanceId:t.instanceId,applicationVersion:t.applicationVersion,role:t.role,experimentId:t.id,completedAt:r.completedAt as string});
 if(hash(list(written[0]!.recordIds).slice().sort())!==hash(observed.records.map(v=>v.id).sort()))reject('OUTPUT_RECORD_SET_DISAGREES');
 if(observed.records.some(v=>!t.records.some(r=>r.id===v.id)))reject('FOREIGN_RECORD');
 const effect=e.effectObservation;
 if(effect.requestDigest!==hash(t)||effect.trialId!==t.id||effect.domainActionId!==p.effect.domainActionId||effect.businessEffectId!==p.effect.businessEffectId||effect.executionState!=='reconciled'||effect.status!=='succeeded')reject('CANONICAL_EFFECT_NOT_RECONCILED');
 return {experimentId:t.id,conditionId:p.condition.id,records:observed.records,trial:t};
}
function independentAnalysis(f:IdentificationFamily,obs:DigitalObservation[]):IdentificationAnalysis{
 const pids=new Set(f.predicates.map(p=>p.id)),nids=new Set(f.numeric.map(p=>p.id)),refutations:IdentificationAnalysis['refutations']=[];
 for(const o of obs){
  const positions=new Map(o.trial.records.map((r,i)=>[r.id,i])),actual=o.records.reduce((m,r)=>m|(1n<<BigInt(positions.get(r.id)!)),0n);
  const output=new Map(o.records.map(r=>[r.id,r.value])),offset=f.conditionIds.indexOf(o.conditionId)*o.trial.records.length;
  const buckets=new Map<string,string[]>();
  for(const p of f.predicates)if(pids.has(p.id)){
   const m=(BigInt('0x'+p.truthHex)>>BigInt(offset))&((1n<<BigInt(o.trial.records.length))-1n);
   if(m!==actual){pids.delete(p.id);const k=m.toString(16);let bucket=buckets.get(k);if(!bucket){bucket=[];buckets.set(k,bucket);}bucket.push(p.id);}
  }
  for(const [prediction,programIds]of buckets)refutations.push({kind:'PREDICATE',programIds,experimentId:o.experimentId,prediction,observation:actual.toString(16)});
  for(const n of f.numeric)if(nids.has(n.id)){
   const bad=o.trial.records.find(r=>output.has(r.id)&&exact(n.a,n.b,r.value)!==output.get(r.id));
   if(bad){nids.delete(n.id);refutations.push({kind:'AFFINE',programIds:[n.id],experimentId:o.experimentId,prediction:exact(n.a,n.b,bad.value),observation:output.get(bad.id)!});}
  }
 }
 return {predicateIds:[...pids],numericIds:[...nids],refutations,analyzedExperimentIds:obs.map(o=>o.experimentId),observationalEquivalence:'ALL_SURVIVING_PROGRAMMES_RETAINED'};
}
type ProgrammeIndex={predicates:Map<string,IdentificationFamily['predicates'][number]>;numeric:Map<string,IdentificationFamily['numeric'][number]>;familyDigest:string};
function verifyForecast(p:DigitalExperimentProtocol,f:IdentificationFamily,prior:IdentificationAnalysis,o:DigitalObservation,index:ProgrammeIndex){
 const cf=p.forecast,ci=f.conditionIds.indexOf(p.condition.id),size=o.trial.records.length;
 if(cf.familyDigest!==index.familyDigest||p.familyDigest!==index.familyDigest||p.hypothesisRevisionDigest!==hash(prior)||cf.conditionId!==p.condition.id)reject('FROZEN_REVISION_CHANGED');
 const pi=new Map<string,string>();for(const row of cf.inclusion)for(const id of row.programIds){if(pi.has(id))reject('DUPLICATE_PREDICTION');pi.set(id,row.mask);}
 if(hash([...pi.keys()].sort())!==hash([...prior.predicateIds].sort()))reject('PREDICTIONS_OMITTED');
 for(const id of prior.predicateIds){const prog=index.predicates.get(id)!;const mask=(BigInt('0x'+prog.truthHex)>>BigInt(ci*size))&((1n<<BigInt(size))-1n);if(pi.get(id)!==mask.toString(16))reject('PREDICTION_PROGRAMME_DISAGREES');}
 const ni=new Map<string,string[]>();for(const row of cf.numeric)for(const id of row.programIds){if(ni.has(id))reject('DUPLICATE_NUMERIC_PREDICTION');ni.set(id,row.values);}
 if(hash([...ni.keys()].sort())!==hash([...prior.numericIds].sort()))reject('NUMERIC_PREDICTIONS_OMITTED');
 for(const id of prior.numericIds){const n=index.numeric.get(id)!;if(hash(ni.get(id))!==hash(o.trial.records.map(r=>exact(n.a,n.b,r.value))))reject('NUMERIC_PREDICTION_DISAGREES');}
 if(['FRESH','REPLICATION','DECISION_USE'].includes(p.phase)){
  const actual=new Map(o.records.map(r=>[r.id,r.value]));
  for(const id of prior.predicateIds){const n=index.predicates.get(id)!;
   o.trial.records.forEach((r,i)=>{if(evaluate(n.ast,r.features)!==actual.has(r.id))reject('WITHHELD_PREDICTION_FAILED');});
  }
  for(const id of prior.numericIds){const n=index.numeric.get(id)!;for(const r of o.trial.records)if(actual.has(r.id)&&exact(n.a,n.b,r.value)!==actual.get(r.id))reject('WITHHELD_VALUE_PREDICTION_FAILED');}
 }
}
/** Recompute all admissible experiment partitions independently, including the
 * empty-output equivalence of otherwise different affine programmes. */
function verifySelection(p:DigitalExperimentProtocol,prior:IdentificationAnalysis,d:DigitalIdentificationDomain,used:string[],index:ProgrammeIndex){
 if(p.phase!=='DISCOVERY'){
  const required={BASELINE:'REGISTERED_ORDINARY',FRESH:'WITHHELD_FRESH',REPLICATION:'INDEPENDENT_REPLICATION',DECISION_USE:'CURRENT_DECISION_USE'}[p.phase];
  if(p.selection.criterion!==required||p.selection.scores.length)reject('ASSIGNMENT_SELECTION_CHANGED');
  return;
 }
 if(p.selection.criterion!=='FINITE_MINIMAX_ELIMINATION_PER_COST')reject('SELECTION_CRITERION');
 const all=conditions(d),withheld=hash(d.withheld).slice(0,24),size=d.records.length;
 const scores=all.filter(c=>c.id!==withheld&&!used.includes(c.id)).map(c=>{
  const ci=all.findIndex(v=>v.id===c.id),masks=new Map<string,number>();
  for(const id of prior.predicateIds){
   const programme=index.predicates.get(id)!,m=(BigInt('0x'+programme.truthHex)>>BigInt(ci*size))&((1n<<BigInt(size))-1n),k=m.toString(16);
   masks.set(k,(masks.get(k)??0)+1);
  }
  let largestPartition=0;
  for(const [mask,count]of masks){
   const m=BigInt('0x'+mask),bins=new Map<string,number>();
   for(const id of prior.numericIds){
    const n=index.numeric.get(id)!;
    const output=d.records.flatMap((r,i)=>(m&(1n<<BigInt(i)))!==0n?[exact(n.a,n.b,r.value)]:[]),k=encode(output);
    bins.set(k,(bins.get(k)??0)+1);
   }
   for(const frequency of bins.values())largestPartition=Math.max(largestPartition,count*frequency);
  }
  const total=prior.predicateIds.length*prior.numericIds.length;
  return {conditionId:c.id,total,largestPartition,worstCaseEliminated:total-largestPartition,costUnits:d.costUnits,risk:0,exposure:size};
 });
 scores.sort((x,y)=>y.worstCaseEliminated*x.costUnits-x.worstCaseEliminated*y.costUnits||x.risk-y.risk||x.exposure-y.exposure||x.conditionId.localeCompare(y.conditionId));
 if(!scores[0]||scores[0].worstCaseEliminated<=0||scores[0].conditionId!==p.condition.id||hash(scores)!==hash(p.selection.scores))reject('MINIMAX_EXPERIMENT_NOT_OPTIMAL');
}
export function checkDigitalIdentification(input:DigitalIdentificationCheckInput,deadlineAt:number):IdentificationIndependentCheck{
 const {domain:d,family:f}=input;independentClosure(d,f,deadlineAt);
 const index:ProgrammeIndex={predicates:new Map(f.predicates.map(p=>[p.id,p])),numeric:new Map(f.numeric.map(p=>[p.id,p])),familyDigest:hash(f)};
 if(index.predicates.size!==f.predicates.length||index.numeric.size!==f.numeric.length)reject('DUPLICATE_PROGRAMME_ID');
 if(input.experiments.length<3||input.experiments.length>64)reject('EXPERIMENT_COVERAGE');
 const seenIds=new Set<string>(),seenRecords=new Set<string>(),observations:DigitalObservation[]=[];
 let fresh:typeof input.experiments[number]|undefined,replica:typeof fresh,baseline:typeof fresh;
 for(const e of input.experiments){
  if(Date.now()>=deadlineAt)reject('DEADLINE');
  checkDigitalInstrumentCertificate(e.instrument);
  const p=e.protocol,t=p.trial;
  const admitted=conditions(d).find(c=>c.id===p.condition.id);
  if(!admitted||hash(p.condition)!==hash({...admitted,costUnits:d.costUnits,risk:0,exposure:d.records.length})||t.records.length!==d.records.length||t.role!==d.role||t.applicationVersion!==d.applicationVersion||
   hash(t.controls)!==hash({updateTiming:admitted.updateTiming,pageSize:admitted.pageSize}))reject('REGISTERED_DOMAIN_OR_COST_CHANGED');
  const first=input.experiments[0]!.protocol;
  if(p.identificationId!==first.identificationId||p.workId!==first.workId||p.workInputId!==first.workInputId||p.workInputDigest!==first.workInputDigest||
   hash(p.consentRef)!==hash(first.consentRef)||hash(p.allocationRef)!==hash(first.allocationRef)||hash(p.stopping)!==hash(first.stopping)||
   p.runtimeDigest!==first.runtimeDigest||p.checkerDigest!==first.checkerDigest||p.principalId!==input.authorId&&p.phase!=='REPLICATION'||
   p.stopping.maxExperiments<input.experiments.length||instant(p.stopping.originalDeadlineAt)<=instant(e.registeredAt))reject('ORIGINAL_OWNER_OR_STOPPING_CHANGED');
  if(e.instrument.id!==p.instrumentRef.id||e.instrument.principalId!==p.principalId||e.instrument.targetId!==p.targetId||e.instrument.instanceId!==t.instanceId||e.instrument.applicationVersion!==t.applicationVersion||instant(e.instrument.completedAt)>instant(e.registeredAt)||instant(e.instrument.validUntil)<=instant(e.registeredAt))reject('INSTRUMENT_NOT_CURRENT_AT_ASSIGNMENT');
  if(seenIds.has(t.id)||seenRecords.size+t.records.length>1024)reject('TRIAL_IDENTITY_REUSE');seenIds.add(t.id);
  t.records.forEach((r,i)=>{if(seenRecords.has(r.id)||hash(r.features)!==hash(fields(d,p.condition,i))||r.value!==d.records[i]!.value)reject('FRESH_INPUT_OR_ASSIGNMENT_CHANGED');seenRecords.add(r.id);});
  const o=observationFromRaw(e),prior=independentAnalysis(f,observations);verifyForecast(p,f,prior,o,index);
  verifySelection(p,prior,d,observations.map(v=>v.conditionId),index);
  if(p.phase==='DISCOVERY'&&(fresh||hash({updateTiming:p.condition.updateTiming,pageSize:p.condition.pageSize,visibility:p.condition.visibility})===hash(d.withheld)))reject('WITHHELD_CONTAMINATED');
  if(p.phase==='BASELINE'){if(baseline||observations.length||hash({updateTiming:p.condition.updateTiming,pageSize:p.condition.pageSize,visibility:p.condition.visibility})!==hash(d.ordinary))reject('ORDINARY_ASSIGNMENT');baseline=e;}
  if(p.phase==='FRESH'){
   if(fresh||observations.some(v=>v.conditionId===p.condition.id)||hash({updateTiming:p.condition.updateTiming,pageSize:p.condition.pageSize,visibility:p.condition.visibility})!==hash(d.withheld))reject('WITHHELD_REUSED');fresh=e;
  }
  if(p.phase==='REPLICATION'){
   if(!fresh||p.principalId===input.authorId||p.trial.instanceId===fresh.protocol.trial.instanceId||p.condition.id!==fresh.protocol.condition.id)reject('REPLICATION_NOT_INDEPENDENT_FRESH');replica=e;
  }
  observations.push(o);
 }
 if(!baseline||!fresh||!replica)reject('FRESH_REPLICATION_REQUIRED');
 const analysis=independentAnalysis(f,observations);
 if(!analysis.predicateIds.length||!analysis.numericIds.length)reject('REPRESENTATION_REFUTED');
 const contrast=observations.some(o=>o.records.length!==observations[0]!.records.length);
 const claimClass=input.requestedClaimClass!=='PREDICTIVE'&&contrast&&analysis.predicateIds.length===1?'INTERVENTION_IDENTIFIED' as const:'PREDICTIVE' as const;
 return {schema:'finnor.s3.digital-identification-check.v1',inputDigest:hash(input),familyDigest:hash(f),analysis,
  checks:{completeGrammarClosure:true,independentKnownControls:true,rawPaginationIdentityUnits:true,actualDeliveredExposure:true,
   predictionsPreregistered:true,independentlyOptimalMinimaxSelection:true,everyRefutationRetained:true,freshWithheldCondition:true,independentPrincipalAndInstanceReplication:true,
   canonicalOriginalEffectReconciliation:true,deterministicProfileAssumptionsExplicit:true},
  checkedAt:new Date().toISOString(),disposition:'SUPPORTED_DEVELOPMENT',claimClass,
  limitations:['FINITE_REGISTERED_INPUTS_ONLY','ASSUMED_DETERMINISTIC_NO_INTERFERENCE_COMPLETE_MEASUREMENT',
   'BEHAVIORAL_EQUIVALENCE_IS_NOT_UNIQUE_HIDDEN_MECHANISM','NO_PRODUCTION_TRANSPORT','DEVELOPMENT_BUILDER_CONTROLLED_CUSTODY',
   ...(input.requestedClaimClass==='MECHANISM_SPECIFIC'?['REQUESTED_MECHANISM_SPECIFIC_CLAIM_NOT_ESTABLISHED']:[])]};
}
