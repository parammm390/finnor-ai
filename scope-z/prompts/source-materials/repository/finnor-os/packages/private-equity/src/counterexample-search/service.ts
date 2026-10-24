import { randomUUID,createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PeMutationContext } from '../types';
import { readCurrentDecisionSlice,type CurrentSlice } from '../decision-slice/service';
import { readPrivate } from '../decision-slice/store';
import { authorizeNativeBinding,resolveDecisionWork,principal } from '../decision-slice/adapters';
import { currentDerivation,codeIdentity as p4Code,schemaIdentity,revisions,assertDependencies } from '../evidence-execution/store';
import { inM1Episode } from '../decision-slice/budget';
import { DiagnosticRequestSchema,ChallengeRequestSchema,assertBounded,hash,ref,gap,unavailable,
  ChallengeError,M4_VERSION,copy,type FrozenDiagnostic,type DiagnosticRequest,type OwnerArtifactDiagnostic,
  type RetainedPartialEvidence,type Proposal,type Validation,type ChallengeResult,type SearchReadMode } from './contracts';
import { buildTargets } from './targets';
import { buildFaultGraph } from './fault-graph';
import { tx,searchRow,load,retain,event,events,eventValue,frozenRecord,reportRecord,storageConfigured,budgetRoot,episodeCancelled,type SearchRow } from './store';
import { validateProposal } from './checker';
import { proposal } from './generator';
import { inChallengeEpisode,remainingMs,checkBudget } from './budget';
import {readCurrentCapitalProgram,readCapitalChallengeOwnerEvidence,assertCapitalProgramBinding,
  type CapitalChallengeContext} from '../capital-program/challenge-reader';
import {CapitalProgramV2Error} from '../capital-program/v2-contracts';
import {inM3Episode} from '../capital-program/v2-budget';
import {reportWitnesses,reportClaims,type ChallengeRequest} from './contracts';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../../../..');
const ownPaths=['contracts.ts','budget.ts','targets.ts','fault-graph.ts','generator.ts','reference.py','reference.ts','checker.ts','worlds.ts',
  'effect-fixture.ts','internal-types.ts','minimizer.ts','search.ts','store.ts','service.ts','worker.ts','handler.ts','challenge-result.ts']
  .map(p=>'finnor-os/packages/private-equity/src/counterexample-search/'+p).concat([
    'finnor-os/packages/db/migrations/0166_m4_counterexample_search.sql','finnor-os/apps/worker/src/index.ts']);
const ownIdentity=Promise.all(ownPaths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(resolve(repo,path))).digest('hex')})));
void ownIdentity.catch(()=>undefined);
export async function codeIdentity(){
  return checkedCodeIdentity(await p4Code());
}
async function checkedCodeIdentity(inherited:Awaited<ReturnType<typeof p4Code>>){
  const files=await ownIdentity;
  for(const file of files)if(createHash('sha256').update(await readFile(resolve(repo,file.path))).digest('hex')!==file.sha256)
    throw new ChallengeError('STALE_INPUT','Loaded M4 method changed; restart at an explicit source version');
  const all=[...new Map([...files,...inherited.files].map(f=>[f.path,f])).values()].sort((a,b)=>a.path.localeCompare(b.path));
  return {files:all,digest:hash({files:all,node:process.version,platform:process.platform,architecture:process.arch})};
}
export async function planIdentity(ctx:PeMutationContext,workId:string){
  return tx(ctx,async c=>{
    const row=(await c.query<{id:string;body:unknown}>(
      'SELECT id::text,jsonb_build_object(\'id\',id,\'work_input_id\',work_input_id,\'revision\',revision,\'status\',status,\'graph_hash\',graph_hash,\'semantic_hash\',semantic_hash,\'plan_graph\',plan_graph) body FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND work_id=$2 ORDER BY revision DESC,id DESC LIMIT 1',
      [ctx.auth.tenantId,workId])).rows[0];
    return {id:row?.id??null,digest:hash(row?.body??{workId,plan:'NO_SELECTED_PLAN'})};
  },true);
}
export function profile(){
  if(process.env.FINNOR_M4_PROFILE!=='DISPOSABLE_NATIVE'||process.env.NODE_ENV==='production'||process.env.FINNOR_ENVIRONMENT==='production'||
    process.env.P3_GOVERNORS!=='1')
    throw new ChallengeError('CONFIGURATION_REQUIRED','Only configured disposable trusted-native M4 is qualified; protected runtime, funding and admission are unavailable');
  storageConfigured();
}
async function freeze(ctx:PeMutationContext,request:DiagnosticRequest,parent?:FrozenDiagnostic,
  capital?:{submission:ChallengeRequest;context:CapitalChallengeContext},checkedEvidence?:CurrentSlice):Promise<FrozenDiagnostic>{
  const initialKeys=['rights:tenant','work-inputs:'+request.workId,'m4-work-plan:'+request.workId,
    'm4-current-source-membership','m4-current-resources-and-effects'];
  const revisionCut=await tx(ctx,c=>revisions(ctx,initialKeys,c,true)),schemaDigest=await schemaIdentity(ctx);
  // Only a completed authenticated same-slice parent may supply this immutable
  // original binding. Live rights/metadata and full publication replay still apply.
  if(parent)await assertFrozenContext(ctx,parent);
  const current=parent?{slice:parent.slice,binding:parent.binding,
    projectionInput:{binding:parent.binding,graph:parent.graph}}:checkedEvidence??await readCurrentDecisionSlice(ctx,request.sliceRef);
  if(hash(current.slice.ref)!==hash(request.sliceRef))throw unavailable();
  if(current.binding.work.id!==request.workId)throw unavailable();
  const axes=new Set<string>();
  for(const axis of request.domain.parameters){
    const key=axis.candidateId+':'+axis.nodeId,candidate=current.binding.underwriting.find(c=>c.candidateId===axis.candidateId);
    const node=candidate?.definition.nodes.find(n=>n.id===axis.nodeId);
    if(axes.has(key)||new Set(axis.values).size!==axis.values.length||!node||node.kind!=='input'||
      node.valueType!=='decimal'||node.shape!=='scalar'||!request.evaluations.some(e=>'candidateId'in e&&e.candidateId===axis.candidateId))
      throw new ChallengeError('INVALID_REQUEST','Domain axes require distinct exact scalar owner input bindings and values');
    axes.add(key);
  }
  const code=await codeIdentity(),plan=await planIdentity(ctx,request.workId),p4:FrozenDiagnostic['p4']=[];
  for(let index=0;index<request.evaluations.length;index++){
    const e=request.evaluations[index]!;
    if(e.kind==='P4_TERM'){
      const body=await currentDerivation(ctx,e.derivationId);
      if(body.work.id!==request.workId||body.work.revision!==current.binding.work.inputId)throw new ChallengeError('STALE_INPUT','P4 and M1 require the same final Work input');
      p4.push({evaluationIndex:index,body});
    }
  }
  const faultGraph=buildFaultGraph(current,request,p4),built=buildTargets(current,request,faultGraph,capital?.context);
  const extraKeys=[...new Set(p4.flatMap(p=>p.body.invalidationKeys.map(d=>d.key)))].filter(k=>!initialKeys.includes(k));
  revisionCut.push(...await tx(ctx,c=>revisions(ctx,extraKeys,c,true)));
  const contextDigest=hash({slice:current.slice.ref,vector:current.binding.dependencyVector,plan,p4:p4.map(p=>p.body.id),code:code.digest,
    ...(capital?{capital:capital.context}:{})});
  const frozen:FrozenDiagnostic={schema:capital?'finnor.m4.frozen-challenge.v1':'finnor.m4.frozen-diagnostic.v1',request,slice:current.slice,binding:current.binding,
    graph:current.projectionInput.graph,faultGraph,...built,contextDigest,identityDigest:hash({slice:current.slice.ref,claims:built.claims,
    domain:built.domainRef,contextDigest}),p4,code,plan,revisions:revisionCut,schemaDigest,...(capital?{capital}:{})};
  if(!capital)frozen.gaps.push(gap('PENDING_M3_READER','Owner-artifact diagnostic is not the original CapitalProgram ChallengeResult',null,false,'M3'));
  else{
    for(const blocker of capital.context.program.blockers)frozen.gaps.push(gap(blocker.code,blocker.requirement,null,false,blocker.owner));
    for(const unresolved of capital.context.program.unresolvedBindings)frozen.gaps.push(gap(
      'M3_REQUIRED_BINDING_UNRESOLVED',`${unresolved.field}: ${unresolved.reason}`,null,true,unresolved.owner));
    frozen.gaps.push(gap('M2_WORK_UNIT_PORT_UNAVAILABLE','Independent finite native search is used; no immutable M2 work-unit reader supplied',null,false,'M2'));
    frozen.gaps.push(gap('M3_GROUNDING_EFFECT_CLAIM_PORT_INCOMPLETE',
      'M3 currently publishes finite model/native/allocation claims, not operative-agreement or isolated effect claims. Those original witness domains remain uncovered',null,false,'M3/P4/P5/P3'));
  }
  if(p4.length)frozen.gaps.push(gap('M1_P4_CONSUMER_PORT_UNAVAILABLE',
    'Authentic P4 diagnostic nodes have a separate M4 fault graph; the available M1 has no installed P4 consumer port',null,false,'M1'));
  frozen.gaps.push(gap('UNMETERED_AGGREGATE_RESOURCES','Reconciled dollars, aggregate OS CPU/memory and protected grants are unqualified',null,false,'S5/S7/S8'));
  for(const g of current.binding.gaps)frozen.gaps.push(gap(g.code,g.requirement,null,false,g.requiredProducer));
  if(current.binding.policies.some(p=>p.kernel.mechanisms.reduce((n,m)=>n+m.scenarios.length,0)>64))
    throw new ChallengeError('LIMIT_EXCEEDED','M4 retained joint-world domain exceeds 64 original worlds');
  if(current.binding.underwriting.some(c=>c.definition.nodes.length>2048)||current.binding.allocation&&
    (current.binding.allocation.problem.policies.length>8||current.binding.allocation.problem.jointModel.scenarios.length>32))
    throw new ChallengeError('LIMIT_EXCEEDED','Original owner domain exceeds registered native/reference cardinality');
  if(Buffer.byteLength(JSON.stringify(frozen))>request.limits.maxBytes)throw new ChallengeError('LIMIT_EXCEEDED','Frozen artifact byte envelope exceeded');
  await assertFrozenContext(ctx,frozen);return frozen;
}
/** The full authenticated freeze owns original-input historical checking.
 * Live metadata/rights guard it; full owner proof replay still gates publication. */
export async function assertFrozenContext(ctx:PeMutationContext,frozen:FrozenDiagnostic):Promise<void>{
  checkBudget();
  await authorizeNativeBinding(ctx,frozen.binding);
  const work=await resolveDecisionWork(ctx,frozen.request.workId);
  const publication=await readPrivate<CurrentSlice['publication']>(ctx,'publications',frozen.slice.ref.contentDigest);
  const validUntil=Date.parse(frozen.binding.validUntil);
  if(publication.schema!=='finnor.m1.publication.v1'||hash(publication.sliceRef)!==hash(frozen.slice.ref)||
    publication.bindingRef.contentDigest!==hash(frozen.binding)||publication.headKey!==hash(`work:${work.id}`)||
    !Number.isSafeInteger(publication.generation)||publication.generation<1||
    work.inputDigest!==frozen.binding.work.inputDigest||!Number.isFinite(validUntil)||Date.now()>=validUntil)
    throw new ChallengeError('STALE_INPUT','Authenticated frozen owner publication, validity or Work input changed');
  const head=await readPrivate<{cancelled:boolean;publishedGeneration:number|null;publishedRef:CurrentSlice['slice']['ref']|null}>(
    ctx,'heads',publication.headKey);
  if(head.cancelled!==false||head.publishedGeneration!==publication.generation||hash(head.publishedRef)!==hash(frozen.slice.ref))
    throw new ChallengeError('STALE_INPUT','Frozen owner publication is no longer the current generation');
  // This actual same-call M3 fence already reread the complete inherited code
  // closure. Reuse that proof, never the frozen owner's recorded digest.
  const checkedCapitalCode=frozen.capital?await assertCapitalCurrent(ctx,frozen.capital,false):undefined;
  if(hash(await planIdentity(ctx,frozen.request.workId))!==hash(frozen.plan)||
    (await (checkedCapitalCode?checkedCodeIdentity(checkedCapitalCode):codeIdentity())).digest!==frozen.code.digest||
    await schemaIdentity(ctx)!==frozen.schemaDigest)
    throw new ChallengeError('STALE_INPUT','Frozen method, schema or plan changed');
  await assertDependencies(ctx,frozen.revisions);
  checkBudget();
}
export async function assertCurrent(ctx:PeMutationContext,frozen:FrozenDiagnostic):Promise<void>{
  checkBudget();
  const current=frozen.capital?await currentCapitalEvidence(ctx,frozen.capital):
    await readCurrentDecisionSlice(ctx,frozen.request.sliceRef);
  if(hash(current.binding.dependencyVector)!==hash(frozen.binding.dependencyVector)||
    hash(current.slice.ref)!==hash(frozen.slice.ref)||hash(await planIdentity(ctx,frozen.request.workId))!==hash(frozen.plan)||
    (await codeIdentity()).digest!==frozen.code.digest||await schemaIdentity(ctx)!==frozen.schemaDigest)
    throw new ChallengeError('STALE_INPUT','Exact owner, Work, plan, source, runtime or schema context changed');
  await assertDependencies(ctx,frozen.revisions);
  for(const p of frozen.p4)if(hash(await currentDerivation(ctx,p.body.id))!==hash(p.body))
    throw new ChallengeError('STALE_INPUT','Original P4 derivation changed or is no longer current');
  checkBudget();
}
async function currentCapitalEvidence(ctx:PeMutationContext,capital:NonNullable<FrozenDiagnostic['capital']>){
  try{
    const checked=await inM3Episode(remainingMs(),()=>readCapitalChallengeOwnerEvidence(ctx,capital.submission.candidate,capital.submission.workId));
    if(hash(checked.context)!==hash(capital.context))
      throw new ChallengeError('STALE_INPUT','Exact M3 candidate/claim/module/input/owner context changed');
    return checked.evidence;
  }catch(error){
    if(error instanceof CapitalProgramV2Error)throw new ChallengeError(error.code==='UNAVAILABLE'?'UNAVAILABLE':
      error.code==='LIMIT_EXCEEDED'?'LIMIT_EXCEEDED':'STALE_INPUT','Current immutable M3 candidate is unavailable or changed');
    throw error;
  }
}
async function assertCapitalCurrent(ctx:PeMutationContext,capital:NonNullable<FrozenDiagnostic['capital']>,full=true){
  try{
    if(!full)return await inM3Episode(remainingMs(),()=>assertCapitalProgramBinding(ctx,capital.context));
    const current=await inM3Episode(remainingMs(),()=>readCurrentCapitalProgram(ctx,capital.submission.candidate,capital.submission.workId));
    if(hash(current)!==hash(capital.context))throw new ChallengeError('STALE_INPUT','Exact M3 candidate/claim/module/input/owner context changed');
  }catch(error){
    if(error instanceof CapitalProgramV2Error)throw new ChallengeError(error.code==='UNAVAILABLE'?'UNAVAILABLE':
      error.code==='LIMIT_EXCEEDED'?'LIMIT_EXCEEDED':'STALE_INPUT','Current immutable M3 candidate is unavailable or changed');
    throw error;
  }
}
function diagnosticForCapital(request:ChallengeRequest,context:CapitalChallengeContext):DiagnosticRequest{
  if(!context.program.evidenceSlice)throw new ChallengeError('CHECK_FAILED','M3 evidence slice is unresolved');
  if(!context.claims.length||context.claims.length>16)
    throw new ChallengeError('LIMIT_EXCEEDED','Current candidate claim set is empty or exceeds the registered sixteen-claim domain');
  return DiagnosticRequestSchema.parse({schema:'finnor.m4.diagnostic-request.v1',workId:request.workId,
    sliceRef:context.program.evidenceSlice,idempotencyKey:request.idempotencyKey,evaluations:context.claims.map(c=>c.evaluation),
    domain:{parameters:[],maxCombination:3},limits:request.limits});
}
export async function submitDiagnostic(ctx:PeMutationContext,value:unknown,parentId:string|null=null){
  assertBounded(value);return submitSearch(ctx,DiagnosticRequestSchema.parse(value),parentId);
}
export async function submitChallenge(ctx:PeMutationContext,value:unknown,parentId:string|null=null){
  assertBounded(value);return submitSearch(ctx,ChallengeRequestSchema.parse(value),parentId);
}
async function submitSearch(ctx:PeMutationContext,submission:DiagnosticRequest|ChallengeRequest,parentId:string|null,
  checkedCapital?:Awaited<ReturnType<typeof readCapitalChallengeOwnerEvidence>>){
  profile();
  return withIssuedCapitalChallengeRead(()=>inChallengeEpisode(submission.limits.deadlineMs,()=>inM1Episode(remainingMs(),async()=>{
    const started=Date.now(),digest=hash(submission),work=await resolveDecisionWork(ctx,submission.workId);
    let capital:FrozenDiagnostic['capital'],checkedEvidence:CurrentSlice|undefined;
    if(submission.schema==='finnor.m4.challenge-request.v1'){
      try{
        const checked=checkedCapital??await inM3Episode(remainingMs(),()=>readCapitalChallengeOwnerEvidence(ctx,submission.candidate,submission.workId));
        capital={submission,context:checked.context};checkedEvidence=checked.evidence;
      }
      catch(error){
        if(error instanceof CapitalProgramV2Error)throw new ChallengeError(error.code==='UNAVAILABLE'?'UNAVAILABLE':
          error.code==='LIMIT_EXCEEDED'?'LIMIT_EXCEEDED':'STALE_INPUT','Current immutable M3 candidate is unavailable or changed');
        throw error;
      }
    }
    const request=capital?diagnosticForCapital(capital.submission,capital.context):submission as DiagnosticRequest;
    const existing=await tx(ctx,async c=>(await c.query<SearchRow>(
      'SELECT * FROM finnor_os.m4_searches WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',
      [ctx.auth.tenantId,principal(ctx),request.idempotencyKey])).rows[0],true);
    if(existing){
      if(existing.request_digest!==digest||existing.parent_search_id!==parentId||existing.work_input_digest!==work.inputDigest)
        throw new ChallengeError('CONFLICT','Idempotency key already binds a different exact request/context');
      await authorizeNativeBinding(ctx,(await frozenRecord(ctx,existing)).binding);
      return {searchId:existing.id,status:existing.status,duplicate:true};
    }
    const parent=parentId?await searchRow(ctx,parentId):null;
    let reusable:FrozenDiagnostic|undefined;
    if(parent){
      const previous=await frozenRecord(ctx,parent);
      if(parent.status!=='COMPLETED'||!await reportRecord(ctx,parent,previous))
        throw new ChallengeError('CONFLICT','Completed authenticated parent evidence is required for repair');
      if(await episodeCancelled(ctx,parent))throw new ChallengeError('CANCELLED','The parent search episode was cancelled');
      if(parent.work_id!==request.workId)throw new ChallengeError('INVALID_REQUEST','A linked repair must retain the owning Work');
      if(previous.schema!==(capital?'finnor.m4.frozen-challenge.v1':'finnor.m4.frozen-diagnostic.v1'))
        throw new ChallengeError('INVALID_REQUEST','Repair cannot substitute a diagnostic for the original candidate challenge');
      if(!capital&&hash(previous.slice.ref)===hash(request.sliceRef))reusable=previous;
    }
    const frozen=await inChallengeEpisode(Math.min(remainingMs(),parent?parent.deadline_at.getTime()-Date.now():Infinity),
      ()=>inM1Episode(remainingMs(),()=>freeze(ctx,request,reusable,capital,checkedEvidence)));
    const deadline=new Date(Math.min(started+request.limits.deadlineMs,Date.now()+remainingMs(),parent?.deadline_at.getTime()??Infinity));
    if(deadline.getTime()<=Date.now())throw new ChallengeError('LIMIT_EXCEEDED','Parent repair episode deadline is exhausted');
    return tx(ctx,async c=>{
      const prior=(await c.query<SearchRow>('SELECT * FROM finnor_os.m4_searches WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3 FOR UPDATE',
        [ctx.auth.tenantId,principal(ctx),request.idempotencyKey])).rows[0];
      if(prior){if(prior.request_digest!==digest||prior.parent_search_id!==parentId)throw new ChallengeError('CONFLICT','Concurrent idempotency conflict');
        return {searchId:prior.id,status:prior.status,duplicate:true};}
      if(parentId){
        const locked=await searchRow(ctx,parentId,c,true),root=await budgetRoot(ctx,locked,c);
        if(await episodeCancelled(ctx,locked,c,true))throw new ChallengeError('CANCELLED','The parent search episode was cancelled');
        const active=await c.query(`WITH RECURSIVE lineage AS(
          SELECT id,status FROM finnor_os.m4_searches WHERE tenant_id=$1 AND principal_id=$2 AND id=$3
          UNION ALL SELECT s.id,s.status FROM finnor_os.m4_searches s JOIN lineage l ON s.parent_search_id=l.id
            WHERE s.tenant_id=$1 AND s.principal_id=$2)
          SELECT id FROM lineage WHERE status IN('QUEUED','RUNNING') LIMIT 1`,
          [ctx.auth.tenantId,principal(ctx),root.id]);
        if(active.rowCount)throw new ChallengeError('CONFLICT','One parent episode already has an active repair');
      }
      await assertDependencies(ctx,frozen.revisions,c,true);
      const retention=(await c.query<{days:number}>(
        "SELECT coalesce((SELECT retention_days FROM finnor_os.tenant_retention_policies WHERE tenant_id=$1 AND data_class='m4_evidence'),(SELECT retention_days FROM finnor_os.tenant_data_retention_policies WHERE tenant_id=$1),90) days",
        [ctx.auth.tenantId])).rows[0]!.days;
      const id=randomUUID(),row=(await c.query<SearchRow>(
        `INSERT INTO finnor_os.m4_searches(id,tenant_id,principal_id,work_id,work_input_id,work_input_digest,idempotency_key,request_digest,
          frozen_digest,parent_search_id,limits,deadline_at,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,clock_timestamp()+($13::int || ' days')::interval) RETURNING *`,
        [id,ctx.auth.tenantId,principal(ctx),request.workId,work.inputId,work.inputDigest,request.idempotencyKey,digest,hash(frozen),parentId,
          JSON.stringify(request.limits),deadline,Math.max(1,Math.min(90,retention))])).rows[0]!;
      await retain(ctx,row,'FROZEN',frozen,c);
      await event(ctx,row,null,'SUBMITTED',{requestDigest:digest,frozenDigest:hash(frozen),deadlineAt:deadline.toISOString(),
        parentSearchId:parentId,budgetIncludesQueueWaiting:true,upstreamCostDuplicated:false},c);
      const job=(await c.query<{id:string}>(
        `INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,priority,protocol_version,retry_safety)
         VALUES($1,'run_counterexample_search_v1',$2::jsonb,$3,'interactive',50,1,'locally_idempotent') RETURNING id`,
        [ctx.auth.tenantId,JSON.stringify({tenantId:ctx.auth.tenantId,principalId:principal(ctx),searchId:id}),'m4:'+id])).rows[0]!;
      await c.query('UPDATE finnor_os.m4_searches SET job_id=$4 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',
        [ctx.auth.tenantId,principal(ctx),id,job.id]);
      return {searchId:id,status:'QUEUED',duplicate:false};
    });
  })));
}
async function authorizeFrozenSearch(ctx:PeMutationContext,frozen:FrozenDiagnostic){
  await authorizeNativeBinding(ctx,frozen.binding);
  for(const p of frozen.p4){
    const {authorize}=await import('../evidence-execution/store');
    await authorize(ctx,p.body.beliefView.root as import('../types').PeWorldRootRef,
      p.body.sourceHandles.filter(h=>h.source.kind==='artifact').map(h=>({type:'document',id:(h.source as Extract<typeof h.source,{kind:'artifact'}>).documentId})));
  }
}
export async function authorizedSearch(ctx:PeMutationContext,id:string){
  const row=await searchRow(ctx,id),frozen=await frozenRecord(ctx,row);
  await authorizeFrozenSearch(ctx,frozen);
  return {row,frozen};
}
interface IssuedReadScope {
  closed:boolean;
  checked:Map<string,{fingerprint:string;frozen:FrozenDiagnostic;
    issued:{report:ChallengeResult;deadlineAt:string;limits:SearchRow['limits']}}>;
}
const issuedReads=new AsyncLocalStorage<IssuedReadScope>();
/** Private to one trusted invocation. Every reuse still observes actual rights,
 * cancellation, retention, immutable publication and encrypted payload bytes. */
export async function withIssuedCapitalChallengeRead<T>(invoke:()=>Promise<T>):Promise<T>{
  const parent=issuedReads.getStore();
  if(parent&&!parent.closed)return invoke();
  const scope:IssuedReadScope={closed:false,checked:new Map()};
  try{return await issuedReads.run(scope,invoke);}
  finally{scope.closed=true;scope.checked.clear();}
}
async function issuedFingerprint(ctx:PeMutationContext,row:SearchRow){
  const payloads=await tx(ctx,async c=>(await c.query<{payloads:unknown[]}>(
    `SELECT coalesce(jsonb_agg(jsonb_build_object(
      'digest',p.digest,'kind',r.kind,'keyId',p.key_id,'nonce',encode(p.nonce,'hex'),'tag',encode(p.tag,'hex'),
      'ciphertextDigest',encode(sha256(p.ciphertext),'hex'),'ciphertextBytes',octet_length(p.ciphertext),
      'plaintextBytes',r.plaintext_bytes,'expiresAt',p.expires_at) ORDER BY p.digest),'[]'::jsonb) payloads
     FROM finnor_os.m4_payloads p JOIN finnor_os.m4_records r USING(tenant_id,principal_id,search_id,digest)
     WHERE p.tenant_id=$1 AND p.principal_id=$2 AND p.search_id=$3 AND p.digest=ANY($4::text[])`,
    [ctx.auth.tenantId,principal(ctx),row.id,[row.frozen_digest,row.report_digest]])).rows[0]!.payloads,true);
  if(payloads.length!==2)throw unavailable();
  storageConfigured();
  // Never exposed or persisted. A same-ID key rotation also invalidates reuse.
  const keyDigest=createHash('sha256').update(process.env.FINNOR_M4_STORAGE_KEY!).digest('hex');
  return hash({searchId:row.id,workId:row.work_id,inputId:row.work_input_id,inputDigest:row.work_input_digest,
    requestDigest:row.request_digest,frozenDigest:row.frozen_digest,reportDigest:row.report_digest,
    parentId:row.parent_search_id,deadlineAt:row.deadline_at.toISOString(),expiresAt:row.expires_at.toISOString(),
    limits:row.limits,payloads,keyDigest,keyId:process.env.FINNOR_M4_STORAGE_KEY_ID});
}
async function assertIssuedAvailable(ctx:PeMutationContext,row:SearchRow){
  if(await episodeCancelled(ctx,row))throw new ChallengeError('CANCELLED','Original challenge episode was cancelled');
  if(row.status!=='COMPLETED'||!row.report_digest||row.expires_at.getTime()<=Date.now())throw unavailable();
}
/** Historical owner evidence, never a claim that the old candidate remains
 * current. Current rights, original ciphertext and exact publication apply. */
export async function readIssuedCapitalChallenge(ctx:PeMutationContext,id:string,value:unknown){
  const row=await searchRow(ctx,id);
  await assertIssuedAvailable(ctx,row);
  const scope=issuedReads.getStore(),key=hash({tenantId:ctx.auth.tenantId,principalId:principal(ctx),id,value}),
    cached=scope&&!scope.closed?scope.checked.get(key):undefined;
  if(cached){
    if(await issuedFingerprint(ctx,row)!==cached.fingerprint)
      throw new ChallengeError('CHECK_FAILED','Checked issued evidence publication, custody or encrypted bytes changed');
    await authorizeFrozenSearch(ctx,cached.frozen);
    const current=await searchRow(ctx,id);await assertIssuedAvailable(ctx,current);
    if(await issuedFingerprint(ctx,current)!==cached.fingerprint)
      throw new ChallengeError('CHECK_FAILED','Checked encrypted evidence changed during current authorization');
    return copy(cached.issued);
  }
  const before=scope&&!scope.closed?await issuedFingerprint(ctx,row):null,
    frozen=await frozenRecord(ctx,row);
  await authorizeFrozenSearch(ctx,frozen);
  const report=await reportRecord(ctx,row,frozen);
  if(!report||report.schema!=='finnor.m4.challenge-result.v1'||!frozen.capital||
    hash(report.ref)!==hash(value)||row.status!=='COMPLETED')throw unavailable();
  if(report.envelope.work.id!==row.work_id||hash(report.candidate)!==hash(frozen.capital.submission.candidate))
    throw new ChallengeError('CHECK_FAILED','Original issued challenge does not match its frozen candidate');
  const current=await searchRow(ctx,id);await assertIssuedAvailable(ctx,current);
  const issued={report:report as ChallengeResult,deadlineAt:row.deadline_at.toISOString(),limits:row.limits};
  if(scope&&!scope.closed&&before){
    if(await issuedFingerprint(ctx,current)!==before)
      throw new ChallengeError('CHECK_FAILED','Issued evidence changed while its original encrypted preimages were authenticated');
    if(scope.checked.size>=16)throw new ChallengeError('LIMIT_EXCEEDED','One invocation exceeds sixteen checked issued-evidence handles');
    scope.checked.set(key,{fingerprint:before,frozen:copy(frozen),issued:copy(issued)});
  }
  return issued;
}
async function partialEvidence(ctx:PeMutationContext,row:SearchRow,frozen:FrozenDiagnostic):Promise<RetainedPartialEvidence>{
  const checked=await events(ctx,row,['CHECK','REUSED_SETTLED_CHECK','VALID_ORIGINAL','REPAIR_CHECK']);
  const accepted=new Map<string,RetainedPartialEvidence['acceptedChecks'][number]>();
  for(const e of checked){
    const v=eventValue<{proposal:Proposal;validation:Validation}>(e);
    if(v.validation?.status!=='VALID'||!v.validation.material||!v.validation.failureKey)continue;
    const target=frozen.targets.find(t=>hash(t.ref)===hash(v.proposal?.targetRef));
    if(!target||hash(proposal(frozen,target,v.proposal.components,v.proposal.worldId))!==hash(v.proposal))
      throw new ChallengeError('CHECK_FAILED','Retained accepted check does not bind the original frozen claim');
    if(!accepted.has(v.proposal.ref.contentDigest))
      accepted.set(v.proposal.ref.contentDigest,{eventId:e.id,retainedAt:e.createdAt,proposal:v.proposal,validation:v.validation});
  }
  const body={schema:'finnor.m4.retained-partial-evidence.v1' as const,searchId:row.id,candidateIdentity:frozen.identityDigest,
    contextDigest:frozen.contextDigest,result:accepted.size?'FAILURE_WITNESS' as const:'BLOCKED' as const,
    acceptedChecks:[...accepted.values()],incomplete:true as const,published:false as const,currentUsePermitted:false as const,
    effectReexecution:false as const,unresolved:[...frozen.gaps,gap('PARTIAL_SEARCH_NO_CURRENT_PUBLICATION',
      'Only committed original independent checks are reconstructed. Coverage, minimization and costs remain incomplete; no current result was published',null,true)]};
  return {ref:ref('retained-partial-evidence',body),...body};
}
export async function readDiagnostic(ctx:PeMutationContext,id:string,withLedger=false,readMode:SearchReadMode='CURRENT'){
  const {row,frozen}=await authorizedSearch(ctx,id);
  let applicability:{status:string;reason:string}={status:'HISTORICAL_NOT_RECHECKED',reason:'RETAINED_EVIDENCE_ONLY_CURRENT_USE_NOT_ASSERTED'};
  if(readMode==='CURRENT'){
    try{await assertCurrent(ctx,frozen);applicability={status:'CURRENT',reason:'EXACT_OWNER_CONTEXT_REVALIDATED'};}
    catch(error){
      if(error instanceof ChallengeError&&['LIMIT_EXCEEDED','CANCELLED'].includes(error.code))throw error;
      applicability={status:'STALE',reason:'EXACT_CONTEXT_CHANGED_CURRENT_USE_REFUSED'};
    }
  }
  if(await episodeCancelled(ctx,row))applicability={status:'CANCELLED',reason:'PARENT_EPISODE_CANCELLED_CURRENT_USE_REFUSED'};
  if(readMode==='ISSUED_HISTORY'&&row.expires_at.getTime()<=Date.now())
    applicability={status:'EXPIRED',reason:'RETENTION_EXPIRED_CURRENT_USE_REFUSED'};
  const report=await reportRecord(ctx,row,frozen);
  if(readMode==='ISSUED_HISTORY'&&report&&!['COMPLETED','CANCELLED','STALE'].includes(row.status))
    throw new ChallengeError('CHECK_FAILED','Retained report has no terminal issued publication');
  const partial=report?null:await partialEvidence(ctx,row,frozen);
  const ledger=withLedger?await events(ctx,row):undefined;
  const deliveryHistory=await tx(ctx,async c=>(await c.query(`SELECT a.id,a.claim_fence "claimFence",
    a.worker_id "workerId",a.outcome,a.started_at "startedAt",a.finished_at "finishedAt",a.failure_kind "failureKind",
    NULL::numeric "costUSD",NULL::bigint "cpuMicros",'UNMETERED_DELIVERY_OVERHEAD' "costStatus",
    a.outcome='lease_lost' "finalPhysicalCostUnknown"
    FROM finnor_os.job_delivery_attempts a JOIN finnor_os.jobs j ON j.id=a.job_id
    WHERE j.id=$1 AND j.tenant_id=$2 AND j.payload->>'searchId'=$3 AND j.payload->>'principalId'=$4
    ORDER BY a.started_at,a.id LIMIT 17`,[row.job_id,ctx.auth.tenantId,row.id,principal(ctx)])).rows,true);
  if(deliveryHistory.length>16)throw new ChallengeError('LIMIT_EXCEEDED','Complete physical delivery read exceeds its bounded envelope');
  return {searchId:id,status:row.status,identity:{tenantId:row.tenant_id,principalId:row.principal_id,
    workId:row.work_id,workInputId:row.work_input_id,sliceRef:frozen.slice.ref,
    candidateIdentity:frozen.identityDigest,contextDigest:frozen.contextDigest},
    report,partialEvidence:partial,applicability,deadlineAt:row.deadline_at.toISOString(),retainedUntil:row.expires_at.toISOString(),
    privateStorage:'AES_256_GCM_PRINCIPAL_RLS',trials:row.trials,retainedBytes:Number(row.retained_bytes),
    deliveryHistory,
    ...(ledger?{ledger:ledger.map(e=>({...e,body:e.body.body}))}:{}),executionAuthorityGranted:false};
}
export async function cancelDiagnostic(ctx:PeMutationContext,id:string){
  const {row}=await authorizedSearch(ctx,id);
  return tx(ctx,async c=>{
    const current=await searchRow(ctx,id,c,true);
    if(['CANCELLED','FAILED','EXPIRED','STALE'].includes(current.status))return {searchId:id,status:current.status};
    await c.query("UPDATE finnor_os.m4_searches SET status='CANCELLED',updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [ctx.auth.tenantId,principal(ctx),id]);
    await event(ctx,row,null,'CANCELLED',{requestedBy:principal(ctx),historicalWitnessesAndCostsRetained:true,
      businessLiabilitiesReleased:false},c);
    return {searchId:id,status:'CANCELLED'};
  });
}
export async function replayWitness(ctx:PeMutationContext,id:string,witnessRef:unknown){
  const {row,frozen}=await authorizedSearch(ctx,id);
  if(await episodeCancelled(ctx,row))throw new ChallengeError('CANCELLED','The parent search episode was cancelled');
  await assertCurrent(ctx,frozen);
  if(row.status!=='COMPLETED')throw new ChallengeError('CONFLICT','Current completed search required for witness replay');
    const report=await reportRecord(ctx,row,frozen),witness=report&&reportWitnesses(report).find(w=>hash(w.ref)===hash(witnessRef));
  if(!witness)throw unavailable();
  // Effects are observation traces, never repeatable mutations. Do not POST the fixture again.
  if(witness.class==='EFFECT_INTERFACE')return {witness,replay:'RETAINED_INDEPENDENT_OBSERVATION_ONLY',effectReexecuted:false,executionAuthorityGranted:false};
  if(row.deadline_at.getTime()<=Date.now())throw new ChallengeError('LIMIT_EXCEEDED','Replay cannot acquire a fresh parent budget');
  return inChallengeEpisode(row.deadline_at.getTime()-Date.now(),async()=>{
    await tx(ctx,async c=>{
      const current=await searchRow(ctx,id,c,true);
      if(await episodeCancelled(ctx,current,c,true))throw new ChallengeError('CANCELLED','The parent search episode was cancelled');
      const root=await budgetRoot(ctx,current,c);
      if(current.trials>=current.limits.maxTrials||root.trials>=root.limits.maxTrials)
        throw new ChallengeError('LIMIT_EXCEEDED','Parent replay trial bound exhausted');
      if(root.id!==current.id)await c.query('UPDATE finnor_os.m4_searches SET trials=trials+1 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',
        [ctx.auth.tenantId,principal(ctx),root.id]);
      await c.query('UPDATE finnor_os.m4_searches SET trials=trials+1 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',
        [ctx.auth.tenantId,principal(ctx),id]);
      await event(ctx,current,null,'DEBIT',{phase:'REPLAY',witnessRef:witness.ref,parentEpisodeId:root.id},c);
    });
    const validation=await validateProposal(ctx,frozen,witness.minimized);
    await assertCurrent(ctx,frozen);
    await tx(ctx,async c=>{
      const current=await searchRow(ctx,id,c,true);
      if(await episodeCancelled(ctx,current,c,true))throw new ChallengeError('CANCELLED','The parent search episode was cancelled');
      await event(ctx,current,null,'REPLAY_CHECK',{witnessRef:witness.ref,validation},c);
    });
    return {witnessRef:witness.ref,validation,reproduced:validation.status==='VALID'&&validation.failureKey===witness.validation.failureKey,
      effectReexecuted:false,executionAuthorityGranted:false};
  });
}
export async function requestRepair(ctx:PeMutationContext,id:string,replacement:DiagnosticRequest|ChallengeRequest){
  return withIssuedCapitalChallengeRead(()=>requestCheckedRepair(ctx,id,replacement));
}
async function requestCheckedRepair(ctx:PeMutationContext,id:string,replacement:DiagnosticRequest|ChallengeRequest){
  const {row,frozen}=await authorizedSearch(ctx,id),report=await reportRecord(ctx,row,frozen);
  if(await episodeCancelled(ctx,row))throw new ChallengeError('CANCELLED','The parent search episode was cancelled');
  if(!report||row.status!=='COMPLETED')throw new ChallengeError('CONFLICT','An issued original report is required for a linked repair');
  if(replacement.workId!==row.work_id)throw new ChallengeError('INVALID_REQUEST','A linked repair must retain the owning Work');
  if(Object.entries(replacement.limits).some(([key,value])=>value>row.limits[key as keyof DiagnosticRequest['limits']]))
    throw new ChallengeError('INVALID_REQUEST','Repair cannot widen the parent resource envelope');
  if(report.schema==='finnor.m4.challenge-result.v1'){
    if(replacement.schema!=='finnor.m4.challenge-request.v1')
      throw new ChallengeError('INVALID_REQUEST','An original candidate challenge cannot be replaced by a diagnostic');
    const checked=await inM3Episode(remainingMs(),()=>readCapitalChallengeOwnerEvidence(ctx,replacement.candidate,replacement.workId)),
      current=checked.context;
    if(hash(current.program.ref)===hash(report.candidate)||
      !current.program.challengeEvidence.some(value=>hash(value)===hash(report.ref))||
      !current.program.envelope.parents.some(value=>hash(value)===hash(report.candidate)))
      throw new ChallengeError('CONFLICT','Repair requires a new current M3 revision bound to this exact original ChallengeResult and candidate');
    return submitSearch(ctx,replacement,id,checked);
  }
  if(replacement.schema!=='finnor.m4.diagnostic-request.v1')
    throw new ChallengeError('INVALID_REQUEST','A diagnostic cannot supply the original candidate challenge lineage');
  return submitDiagnostic(ctx,replacement,id);
}
export async function repairRechecks(ctx:PeMutationContext,row:SearchRow,frozen:FrozenDiagnostic,
  debit:(phase:string,body:unknown)=>Promise<void>,signal:AbortSignal,retainCheck:(kind:string,body:unknown)=>Promise<void>,
  canCheck:(p:Proposal)=>Promise<boolean>,priorCheck:(p:Proposal)=>Promise<Validation|null>){
  if(!row.parent_search_id)return {parentResultRef:null,replay:[] as OwnerArtifactDiagnostic['repairReplay']};
  const parent=await authorizedSearch(ctx,row.parent_search_id),report=await reportRecord(ctx,parent.row,parent.frozen);
  if(!report)throw new ChallengeError('CONFLICT','Repair parent evidence unavailable');
  const replay:OwnerArtifactDiagnostic['repairReplay']=[];
  for(const witness of reportWitnesses(report)){
    const prior=reportClaims(report).find(c=>hash(c.ref)===hash(witness.claimRef))!;
    const priorEvaluation=prior.evaluation;
    let next=frozen.claims.find(c=>hash(c.evaluation)===hash(priorEvaluation)),changedVersion=false;
    let components=witness.minimized.components;
    // Transport only an unchanged scalar predicate over a genuine direct owner
    // version. No caller-supplied alias, new model, policy or scenario is a link.
    if(!next&&(priorEvaluation.kind==='MECHANICAL_BOUND'||priorEvaluation.kind==='NATIVE_CHECK')){
      const old=parent.frozen.binding.underwriting.find(c=>c.candidateId===priorEvaluation.candidateId);
      const candidates=frozen.claims.filter(c=>c.evaluation.kind===priorEvaluation.kind&&'candidateId'in c.evaluation&&
        hash({...c.evaluation,candidateId:priorEvaluation.candidateId})===hash(priorEvaluation));
      for(const candidate of candidates){
        const evaluation=candidate.evaluation;
        if(!('candidateId'in evaluation)||!old||old.scenarioRef)continue;
        const newer=frozen.binding.underwriting.find(c=>c.candidateId===evaluation.candidateId);
        if(!newer||newer.scenarioRef)continue;
        const linked=await tx(ctx,async c=>(await c.query(`SELECT n.id FROM finnor_os.underwriting_model_versions n
          JOIN finnor_os.underwriting_model_versions p ON p.tenant_id=n.tenant_id AND p.id=n.parent_version_id
          WHERE n.tenant_id=$1 AND n.id=$2 AND p.id=$3 AND n.model_id=p.model_id
            AND n.investment_case_id=p.investment_case_id`,
          [ctx.auth.tenantId,newer.modelRef.id,old.modelRef.id])).rowCount!>0,true);
        if(!linked)continue;
        next=candidate;changedVersion=true;
        components=components.map(component=>component.candidateId===old.candidateId?
          {...component,candidateId:newer.candidateId}:component);
        break;
      }
    }
    if(!next){replay.push({witnessRef:witness.ref,outcome:'NOT_SAME_PREDICATE',scopeChange:'PREDICATE_CHANGED'});continue;}
    if(!changedVersion&&hash(parent.frozen.binding.dependencyVector)!==hash(frozen.binding.dependencyVector)){
      replay.push({witnessRef:witness.ref,outcome:'NEW_CONTEXT_REQUIRES_NEW_CHECK',scopeChange:'CONTEXT_CHANGED'});continue;
    }
    const target=frozen.targets.find(t=>hash(t.claimRef)===hash(next.ref));
    if(!target){replay.push({witnessRef:witness.ref,outcome:'UNSUPPORTED_NEW_DOMAIN',scopeChange:'DOMAIN_CHANGED'});continue;}
    const p=proposal(frozen,target,components,witness.minimized.worldId),settled=await priorCheck(p);
    if(!settled&&!await canCheck(p)){
      await retainCheck('REPAIR_REFUSED',{witnessRef:witness.ref,proposalRef:p.ref,reason:'WITNESS_ALLOCATION_EXHAUSTED'});
      replay.push({witnessRef:witness.ref,outcome:'UNRESOLVED',scopeChange:'WITNESS_ALLOCATION_EXHAUSTED'});continue;
    }
    if(!settled)await debit('REPAIR_REPLAY',{witnessRef:witness.ref,proposal:p});
    const v=settled??(witness.class==='EFFECT_INTERFACE'?witness.validation:await validateProposal(ctx,frozen,p,signal));
    await assertCurrent(ctx,frozen);
    await retainCheck('REPAIR_CHECK',{witnessRef:witness.ref,proposal:p,validation:v,
      scopeChange:changedVersion?'CANDIDATE_VERSION_CHANGED':null});
    replay.push({witnessRef:witness.ref,outcome:v.status,scopeChange:changedVersion?'CANDIDATE_VERSION_CHANGED':null});
  }
  return {parentResultRef:report.ref,replay};
}
