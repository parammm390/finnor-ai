import type {ExperimentRef} from '@finnor/shared-types';
import type {PeMutationContext} from '../types';
import {readCapitalProgramOwnerEvidence} from './v2-api';
import {resolveDecisionWork} from '../decision-slice/adapters';
import {assertCapitalOwnerBinding} from './v2-owners';
import {m3Query,m3Tx,readM3Record} from './v2-store';
import {m3Hash,m3Ref,m3Same,m3Unavailable,CapitalProgramV2Error,CAPITAL_PROGRAM_V2_VERSION,
  type CapitalProgramV2,type CapitalProgramV2Module} from './v2-contracts';
import {CapitalProgramV2RefSchema} from '@finnor/shared-types/src/capital-program';

export interface CapitalCandidateClaim {
  ref:ExperimentRef;candidateDigest:string|null;
  evaluation:
    {kind:'POLICY_BOUND';policyId:string;minimum:string;unit:string;claimKind:'MODEL_WORST_CASE'}|
    {kind:'ALLOCATION_SELECTION';selectedPolicyIds:string[];claimKind:'UNIVERSAL_DETERMINISTIC'}|
    {kind:'NATIVE_CHECK';candidateId:string;nodeId:string;claimKind:'UNIVERSAL_DETERMINISTIC'};
  basis:ExperimentRef[];qualification:string;
}
export interface CapitalChallengeContext {
  queryId:string;program:CapitalProgramV2;request:Awaited<ReturnType<typeof m3Query>>['request'];
  ownerBinding:Awaited<ReturnType<typeof m3Query>>['acceptance'];graph:unknown;
  modules:Array<{ref:ExperimentRef;body:Omit<CapitalProgramV2Module,'ref'>;sha256:string}>;
  claims:CapitalCandidateClaim[];
}
function decimal(value:number):string{
  if(!Number.isFinite(value)||Math.abs(value)>1e12)
    throw new CapitalProgramV2Error('CHECK_FAILED','Owner claim exceeds the finite challenge quantity domain');
  // Expand the owner's exact JS serialization, never round a lower bound up.
  const [mantissa,exponent]=String(value).split('e');
  if(!exponent)return mantissa!;
  const negative=mantissa!.startsWith('-'),digits=mantissa!.replace('-','').replace('.',''),
    point=(mantissa!.replace('-','').split('.')[0]!.length)+Number(exponent);
  const body=point<=0?'0.'+'0'.repeat(-point)+digits:point>=digits.length?digits+'0'.repeat(point-digits.length):
    digits.slice(0,point)+'.'+digits.slice(point);
  if(body.split('.')[1]?.length!>18)
    throw new CapitalProgramV2Error('CHECK_FAILED','Owner claim precision is outside the registered challenge decimal domain');
  return (negative?'-':'')+body;
}
/** Authenticated current publication plus original module/graph preimages.
 * A ref-shaped object, a raw private file or an obsolete query is not a reader. */
export async function readCurrentCapitalProgram(ctx:PeMutationContext,value:unknown,workId:string):Promise<CapitalChallengeContext>{
  return (await readCapitalChallengeOwnerEvidence(ctx,value,workId)).context;
}
export async function readCapitalChallengeOwnerEvidence(ctx:PeMutationContext,value:unknown,workId:string){
  const parsed=CapitalProgramV2RefSchema.parse(value);
  if(parsed.owner!=='M3'||parsed.version!==CAPITAL_PROGRAM_V2_VERSION||
    parsed.id!=='capital-program:'+parsed.contentDigest)throw m3Unavailable();
  const row=await m3Tx(ctx,async c=>(await c.query<{id:string}>(
    'SELECT id FROM finnor_os.m3_queries WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND result_digest=$4',
    [ctx.auth.tenantId,ctx.auth.employeeId??ctx.auth.userId,workId,parsed.contentDigest])).rows[0],true);
  if(!row)throw m3Unavailable();
  const {current:view,evidence}=await readCapitalProgramOwnerEvidence(ctx,row.id);
  if(!view.program||!['TESTED','PARTIAL'].includes(view.status)||!m3Same(view.program.ref,parsed))
    throw new CapitalProgramV2Error('STALE_INPUT','Exact current immutable capital programme required');
  const program=view.program,query=await m3Query(ctx,row.id),modules:CapitalChallengeContext['modules']=[];
  if(program.envelope.work.id!==workId||!program.evidenceSlice||!program.ownerBoundGraph||!evidence||
    !m3Same(program.evidenceSlice,evidence.slice.ref))
    throw new CapitalProgramV2Error('CHECK_FAILED','Capital programme Work/evidence/graph is unresolved');
  const graph=await readM3Record(ctx,'graphs',program.ownerBoundGraph);
  for(const candidate of program.candidates)if(candidate.moduleRef){
    const module=await readM3Record<Omit<CapitalProgramV2Module,'ref'>>(ctx,'modules',candidate.moduleRef);
    if(module.body.schema!=='finnor.m3.executable-economic-module.v2'||module.body.compiler.typeChecked!==true||
      module.body.inputDigest!==m3Hash(query.acceptance.policy.problem)||
      !m3Same(module.body.execution,candidate.moduleExecution))
      throw new CapitalProgramV2Error('CHECK_FAILED','Candidate module, original input and execution preimage differ');
    modules.push({ref:candidate.moduleRef,body:module.body,sha256:module.sha256});
  }
  const claims:CapitalCandidateClaim[]=[];
  const add=(body:Omit<CapitalCandidateClaim,'ref'>)=>claims.push({...body,ref:m3Ref('candidate-claim',{
    program:program.ref,work:program.envelope.work,...body,
  })});
  for(const candidate of program.candidates){
    if(candidate.disposition==='CHECKED_MODEL_RELATIVE'&&candidate.policyRef&&candidate.valueBounds){
      add({candidateDigest:candidate.semanticDigest,evaluation:{kind:'POLICY_BOUND',policyId:candidate.policyRef.id,
        minimum:decimal(candidate.valueBounds[0]),unit:program.valueUnit,claimKind:'MODEL_WORST_CASE'},
        basis:[candidate.policyRef,...program.mechanisms,program.evidenceSlice],
        qualification:'M3_PUBLISHED_S4_FINITE_MODEL_LOWER_BOUND_NOT_EXPECTATION_PROBABILITY_OR_FIELD_VALUE'});
    }
  }
  for(const check of program.allocation.checks.filter(check=>check.feasible)){
    if(!program.allocationRequest)throw new CapitalProgramV2Error('CHECK_FAILED','Claimed allocation lacks its original owner request');
    add({candidateDigest:null,evaluation:{kind:'ALLOCATION_SELECTION',selectedPolicyIds:check.selectedPolicyIds,
      claimKind:'UNIVERSAL_DETERMINISTIC'},basis:[program.allocationRequest],
      qualification:'M3_PUBLISHED_EXACT_FINITE_S5_MECHANICS_NOT_A_RESERVATION'});
  }
  // Registered native checks are claims only when M3 actually published a
  // successful result. A proposed financial scenario is not the base M1 input.
  const finance=query.acceptance.nativeFinance;
  if(finance)for(const candidate of program.candidates.filter(c=>c.structure==='INCUMBENT'&&c.nativeFinance))
    for(const node of finance.model.nodes.filter(n=>n.kind==='check')){
      const result=candidate.nativeFinance!.result as {values?:Record<string,{value:unknown}>};
      if(result.values?.[node.id]?.value===true)add({candidateDigest:candidate.semanticDigest,
        evaluation:{kind:'NATIVE_CHECK',candidateId:finance.modelRef.id,nodeId:node.id,claimKind:'UNIVERSAL_DETERMINISTIC'},
        basis:[finance.modelRef,program.evidenceSlice],qualification:'M3_PUBLISHED_NATIVE_CHECK_ON_EXACT_ORIGINAL_INPUT'});
    }
  return {context:{queryId:query.id,program,request:query.request,ownerBinding:query.acceptance,graph:graph.body,modules,claims},
    evidence};
}
/** Frozen original bytes can be checked without replaying M1 several times per
 * cell. Live Work, generation, publication and all M3 owners still apply.
 * The full reader remains mandatory at final publication. */
export async function assertCapitalProgramBinding(ctx:PeMutationContext,expected:CapitalChallengeContext):Promise<CapitalChallengeContext['ownerBinding']['code']>{
  const query=await m3Query(ctx,expected.queryId),work=await resolveDecisionWork(ctx,query.work_id);
  if(!['TESTED','PARTIAL'].includes(query.status)||query.result_digest!==expected.program.ref.contentDigest||
    query.work_id!==expected.program.envelope.work.id||work.inputDigest!==query.work_input_digest||
    !m3Same(query.request,expected.request)||!m3Same(query.acceptance,expected.ownerBinding))
    throw new CapitalProgramV2Error('STALE_INPUT','Frozen M3 Work, candidate or owner binding changed');
  const published=await m3Tx(ctx,async c=>(await c.query(
    'SELECT result_digest FROM finnor_os.m3_publications WHERE tenant_id=$1 AND principal_id=$2 AND query_id=$3 AND generation=$4',
    [ctx.auth.tenantId,ctx.auth.employeeId??ctx.auth.userId,query.id,query.generation])).rows[0],true);
  if(published?.result_digest!==query.result_digest)
    throw new CapitalProgramV2Error('CHECK_FAILED','Frozen M3 candidate has no matching current publication');
  return assertCapitalOwnerBinding(ctx,query.acceptance);
}
