import {exactPolicyActionQuantity} from './exact-allocation-adapter';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { AllocationDualProposal, AllocationResultState, CanonicalAllocationProblem, S5ComputeInvocation } from '@finnor/shared-types';
import { ExperimentRational, ER_ZERO } from './experiment-numerics';
import { allocationDecimal as decimal, allocationNumber as number, allocationDerivedQuantity as quantity, assertAllocationProblem, AllocationContractError } from './allocation-contracts';
import { epistemicHash } from './source-precedence';

interface MatrixRow {id:string;coefficients:Record<string,string>;lower:string|null;upper:string|null}
export interface AllocationMilpInput {schema:'finnor.s5.milp.v1'|'finnor.s5.milp.rational.v2';quantityEncoding?:'DECIMAL_OR_RATIONAL_V2';c:string[];integrality:number[];lowerBounds:Array<string|null>;upperBounds:Array<string|null>;rows:MatrixRow[];budget:{deadlineMs:number;nodeLimit:number}}
interface SolverResult {schema:'finnor.s5.milp-result.v1';status:string;vector:number[]|null;minObjective:number|null;minDualBound:number|null;mipGap:number|null;nodeCount:number|null;termination:string;dualProposal:AllocationDualProposal|null;
  backend:{pythonVersion:string;scipyVersion:string;numpyVersion:string;highsVersion:string};usage:Record<string,unknown>;warnings:string[]}
const files=['allocation-producer.ts','allocation-solver.py','allocation-checker.ts','allocation-verifier.ts','allocation-verifier-worker.mjs','allocation-contracts.ts','control-contracts.ts','source-precedence.ts','../../db/migrations/0150_portfolio_resource_clearing.sql','../../db/migration-head.ts','../../shared-types/src/allocation.ts','../../private-equity/src/enterprise-allocation.ts','../../private-equity/src/allocation-store.ts'].map(p=>fileURLToPath(new URL(p,import.meta.url)));
const sources=Promise.all(files.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})));
void sources.catch(()=>undefined);
let activeSolvers=0;
export async function allocationSourcesCurrent(expected:S5ComputeInvocation['backend']['sourceDigests']):Promise<boolean>{try{return epistemicHash(await sources)===epistemicHash(expected)&&(await Promise.all(expected.map(async s=>createHash('sha256').update(await readFile(s.path)).digest('hex')===s.sha256))).every(Boolean);}catch{return false;}}
const sum=(v:ExperimentRational[])=>v.reduce((a,b)=>a.add(b),ER_ZERO);
const usage=(kind:string,raw:ExperimentRational[],t:number)=>kind==='STOCK'||kind==='CUMULATIVE_EXPENDITURE'?sum(raw.slice(0,t+1)):raw[t]!;

/** Ordinary evolvable compiler. The feasibility checker never reads its rows. */
export function compileAllocationMilp(p:CanonicalAllocationProblem,deadlineMs:number):{input:AllocationMilpInput;policyColumns:string[]} {
  assertAllocationProblem(p);const ids=p.policies.map(policy=>policy.ref.id),h=p.mandate.horizon.periods,columns=new Map(ids.map((id,i)=>[id,i]));
  const monomials=new Map<string,string[]>();for(const s of p.jointModel.scenarios)for(const term of s.terms)if(term.policyIds.length>1)monomials.set([...term.policyIds].sort().join('|'),[...term.policyIds].sort());
  const productColumns=new Map<string,number>();for(const key of monomials.keys())productColumns.set(key,ids.length+productColumns.size);
  const z=ids.length+productColumns.size,rows:MatrixRow[]=[],totalColumns=z+1;
  const c=Array<string>(totalColumns).fill('0'),integrality=Array<number>(totalColumns).fill(1),lowerBounds:Array<string|null>=Array<string>(totalColumns).fill('0'),upperBounds:Array<string|null>=Array<string>(totalColumns).fill('1');
  c[z]='-1';integrality[z]=0;lowerBounds[z]=decimal(p.jointModel.scenarios.map(s=>s.terms.reduce((v,t)=>quantity(t.value).n<0n?v.add(quantity(t.value)):v,quantity(s.baseValue))).reduce((a,b)=>a.compare(b)<0?a:b));upperBounds[z]=decimal(p.jointModel.scenarios.map(s=>s.terms.reduce((v,t)=>quantity(t.value).n>0n?v.add(quantity(t.value)):v,quantity(s.baseValue))).reduce((a,b)=>a.compare(b)>0?a:b));
  const add=(id:string,coefficients:Record<string,ExperimentRational>,upper:ExperimentRational|null,lower:ExperimentRational|null=null)=>rows.push({id,coefficients:Object.fromEntries(Object.entries(coefficients).filter(([,q])=>q.n!==0n).map(([k,q])=>[k,decimal(q)])),lower:lower?decimal(lower):null,upper:upper?decimal(upper):null});
  for(const [key,components]of monomials){const y=productColumns.get(key)!;
    for(const id of components)add(`product:${key}:${id}`,{[y]:number(1),[columns.get(id)!]:number(-1)},ER_ZERO);
    add(`product:${key}:lower`,Object.fromEntries([[String(y),number(-1)],...components.map(id=>[String(columns.get(id)!),number(1)] as const)]),number(components.length-1));
  }
  for(const choice of p.jointModel.choiceConstraints)add(`choice:${choice.id}`,Object.fromEntries(choice.policyIds.map(id=>[String(columns.get(id)!),number(1)])),number(choice.maximum),number(choice.minimum));
  for(const outstanding of p.outstanding)for(const policy of outstanding.policyRefs)if(columns.has(policy.id))add(`already-committed:${policy.id}`,{[columns.get(policy.id)!]:number(1)},ER_ZERO);
  // Separate reconstruction from the checker: aggregate original actions into
  // per-policy coefficients, then generate sparse rows from canonical registry.
  for(const scenario of p.jointModel.scenarios){const raw=new Map<string,Map<string,ExperimentRational[]>>();
    for(const policy of p.policies){const resources=new Map(p.resources.map(r=>[r.resourceId,Array.from({length:h+1},()=>ER_ZERO)]));
      const path=scenario.policyPaths.find(path=>path.policyRef.id===policy.ref.id)!,funding=p.funding.find(f=>f.policyRef.id===policy.ref.id)!;
      for(const id of path.nodeIds){const n=policy.nodes.find(n=>n.id===id)!,a=policy.problem.actions.find(a=>a.id===n.actionId)!;
        for(const b of p.demandBindings.filter(b=>b.policyRef.id===policy.ref.id)){const values=resources.get(b.resourceId)!;
          if(b.component==='TOTAL')values[n.period]=values[n.period]!.add((exactPolicyActionQuantity(policy,a,'resources',b.dimensionId)??number(a.resources[b.dimensionId]!)));
          else for(let offset=0;offset<a.occupationPeriods&&n.period+offset<=h;offset++)values[n.period+offset]=values[n.period+offset]!.add((exactPolicyActionQuantity(policy,a,'occupancy',b.dimensionId)??number(a.occupancy[b.dimensionId]!)));}
        for(const [resourceId,period,amount,field]of [[funding.actionCostResourceId,n.period,a.cost,'cost'],[funding.humanSecondsResourceId,n.period,a.humanSeconds,'humanSeconds'],[funding.terminalLiabilityResourceId,h,a.tailLiability,'tailLiability']] as const)if(resourceId){const v=resources.get(resourceId)!;v[period]=v[period]!.add(exactPolicyActionQuantity(policy,a,field)??number(amount));}
      }raw.set(policy.ref.id,resources);
    }
    const base=new Map(p.resources.map(r=>[r.resourceId,r.existingUse.map(quantity)])),minimumBase=new Map(p.resources.map(r=>[r.resourceId,r.existingUse.map(quantity)]));
    for(const o of p.outstanding)for(const e of o.envelopes){const values=base.get(e.resourceId),lower=minimumBase.get(e.resourceId);if(!values||!lower||e.minimumQuantities?.length!==h+1)throw new AllocationContractError('INVALID_REQUEST','Outstanding resource lower/upper semantics omitted from compiler');for(let t=0;t<=h;t++){values[t]=values[t]!.add(quantity(e.quantities[t]!));lower[t]=lower[t]!.add(quantity(e.minimumQuantities[t]!));}}
    if(p.mandate.utility.tail.terminalLiability!==0){const resourceId=p.funding[0]!.terminalLiabilityResourceId!;for(const baseline of [base,minimumBase]){const v=baseline.get(resourceId)!;v[h]=v[h]!.add(number(p.mandate.utility.tail.terminalLiability));}}
    for(const r of p.resources)for(let t=0;t<=h;t++){
      if(r.availability[t]!.amount===null||r.availability[t]!.basis!=='REPORTED_AVAILABLE')throw new AllocationContractError('INVALID_REQUEST','Unresolved resource cannot be compiled as available cash');
      add(`resource:${r.resourceId}:${scenario.id}:${t}`,Object.fromEntries(ids.map(id=>[String(columns.get(id)!),usage(r.kind,raw.get(id)!.get(r.resourceId)!,t)])),quantity(r.availability[t]!.amount!).sub(quantity(r.safetyMargin)).sub(usage(r.kind,base.get(r.resourceId)!,t)));
    }
    for(const covenant of new Map(p.resources.flatMap(r=>r.covenants).map(c=>[c.id,c])).values())for(const t of covenant.periods){const coefficient:Record<string,ExperimentRational>={};let baseline=ER_ZERO;
      for(const term of covenant.terms){const resource=p.resources.find(r=>r.resourceId===term.resourceId)!;
        baseline=baseline.add(quantity(term.coefficient).mul(usage(resource.kind,(quantity(term.coefficient).n<0n?minimumBase:base).get(resource.resourceId)!,t)));
        for(const id of ids){const key=String(columns.get(id)!);coefficient[key]=(coefficient[key]??ER_ZERO).add(quantity(term.coefficient).mul(usage(resource.kind,raw.get(id)!.get(resource.resourceId)!,t)));}}
      add(`covenant:${covenant.id}:${scenario.id}:${t}`,coefficient,quantity(covenant.maximum).sub(quantity(covenant.safetyMargin)).sub(baseline));
    }
    for(const d of p.mandate.resources.dimensions){const totals:Record<string,ExperimentRational>={};const occupancies=Array.from({length:h+1},()=>({} as Record<string,ExperimentRational>));
      for(const policy of p.policies){const index=String(columns.get(policy.ref.id)!);totals[index]=ER_ZERO;const path=scenario.policyPaths.find(q=>q.policyRef.id===policy.ref.id)!;
        for(const nodeId of path.nodeIds){const node=policy.nodes.find(n=>n.id===nodeId)!,action=policy.problem.actions.find(a=>a.id===node.actionId)!;totals[index]=totals[index]!.add((exactPolicyActionQuantity(policy,action,'resources',d.id)??number(action.resources[d.id]!)));
          for(let t=node.period;t<Math.min(h+1,node.period+action.occupationPeriods);t++)occupancies[t]![index]=(occupancies[t]![index]??ER_ZERO).add((exactPolicyActionQuantity(policy,action,'occupancy',d.id)??number(action.occupancy[d.id]!)));}}
      add(`mandate-total:${d.id}:${scenario.id}`,totals,number(d.totalLimit));for(let t=0;t<=h;t++)add(`mandate-occupancy:${d.id}:${scenario.id}:${t}`,occupancies[t]!,number(d.capacity));
    }
    for(const coupling of p.mandate.resources.couplings)for(let t=0;t<=h;t++){const coeffs:Record<string,ExperimentRational>={};
      for(const policy of p.policies){const col=String(columns.get(policy.ref.id)!);coeffs[col]=ER_ZERO;for(const nodeId of scenario.policyPaths.find(q=>q.policyRef.id===policy.ref.id)!.nodeIds){const node=policy.nodes.find(n=>n.id===nodeId)!,action=policy.problem.actions.find(a=>a.id===node.actionId)!;
          if(t>=node.period&&t<node.period+action.occupationPeriods)for(const [id,w]of Object.entries(coupling.weights))coeffs[col]=coeffs[col]!.add(number(w).mul((exactPolicyActionQuantity(policy,action,'occupancy',id)??number(action.occupancy[id]!))));}}
      add(`mandate-coupling:${coupling.id}:${scenario.id}:${t}`,coeffs,number(coupling.maxPerPeriod));}
    add(`mandate-human:${scenario.id}`,Object.fromEntries(p.policies.map(policy=>[String(columns.get(policy.ref.id)!),sum(scenario.policyPaths.find(path=>path.policyRef.id===policy.ref.id)!.nodeIds.map(id=>exactPolicyActionQuantity(policy,policy.problem.actions.find(a=>a.id===policy.nodes.find(n=>n.id===id)!.actionId)!,'humanSeconds')??number(policy.problem.actions.find(a=>a.id===policy.nodes.find(n=>n.id===id)!.actionId)!.humanSeconds)))])),number(p.mandate.search.maxHumanSeconds));
    const value:Record<string,ExperimentRational>={[z]:number(1)};
    for(const term of scenario.terms){const col=term.policyIds.length===1?columns.get(term.policyIds[0]!)!:productColumns.get([...term.policyIds].sort().join('|'))!;value[col]=(value[col]??ER_ZERO).sub(quantity(term.value));}
    add(`worst-path:${scenario.id}`,value,quantity(scenario.baseValue));add(`risk-floor:${scenario.id}`,{...value,[z]:ER_ZERO},quantity(scenario.baseValue).sub(number(p.mandate.risk.minimumUtility)));
  }
  if(rows.length>30000||totalColumns>1024)throw new AllocationContractError('LIMIT_EXCEEDED','MILP formulation exceeds registered structural limit');
  return {input:{schema:p.quantityEncoding==='DECIMAL_OR_RATIONAL_V2'?'finnor.s5.milp.rational.v2':'finnor.s5.milp.v1',...(p.quantityEncoding==='DECIMAL_OR_RATIONAL_V2'?{quantityEncoding:'DECIMAL_OR_RATIONAL_V2' as const}:{}),c,integrality,lowerBounds,upperBounds,rows,budget:{deadlineMs:Math.max(1,Math.floor(deadlineMs)),nodeLimit:p.mandate.search.maxExpansions}},policyColumns:ids};
}
export async function produceAllocationCandidate(problem:CanonicalAllocationProblem,deadlineAt:number):Promise<{status:AllocationResultState;selectedPolicyIds:string[]|null;reasons:string[];compute:S5ComputeInvocation;solverUpperBoundEstimate:number|null;dualProposal:AllocationDualProposal|null}> {
  const start=performance.now(),cpu=process.cpuUsage(),startedAt=new Date().toISOString(),rss=process.memoryUsage().rss;
  const compute:S5ComputeInvocation={schema:'finnor.model-compute-invocation.v1',semanticOwner:'S5',id:'',tenantId:problem.tenantId,principalId:problem.principalId,rightsRef:problem.mandate.rightsRef,inputRef:problem.ref,outputRefs:[],requestedRoute:'SCIPY_HIGHS_ROBUST_MILP',actualRoute:'NOT_INVOKED',fallbacks:[],backend:{name:'scipy.optimize.milp/HiGHS',version:null,pythonVersion:null,scipyVersion:null,numpyVersion:null,sourceDigests:await sources.catch(()=>[]),deterministicReplayClaimed:false},harness:{nodeVersion:process.version,platform:process.platform,architecture:process.arch,configuration:{domain:'s5-joint-finite-v1',decisionDeadlineMs:problem.mandate.search.deadlineMs,nodeLimit:problem.mandate.search.maxExpansions,threads:1,memoryCeilingBytes:16*1024**3,memoryEnforcement:'STRUCTURAL_LIMITS_AND_MEASURED_USAGE_NO_CONTAINER_LIMIT'}},attempts:[],usage:{elapsedMs:0,cpuUserMicros:0,cpuSystemMicros:0,rssBeforeBytes:rss,rssAfterBytes:rss,backend:{},accountingScope:'PROCESS_AND_CHILD_INTERVAL_NOT_CONTAINER_PEAK'},cost:{money:null,pricebookRef:null,status:'LOCAL_COST_UNMETERED',externalCalls:0},admission:{status:'BLOCKED_EXTERNAL',receipt:null}};
  let status:AllocationResultState='NUMERICAL_FAILURE',selectedPolicyIds:string[]|null=null,solverUpperBoundEstimate:number|null=null;let dualProposal:AllocationDualProposal|null=null;const reasons:string[]=[];
  try{
    if(compute.backend.sourceDigests.length!==files.length)throw Error('LOADED_S5_SOURCE_IDENTITY_UNAVAILABLE');
    if(activeSolvers>=2){status='SEARCH_EXHAUSTED';throw Error('LOCAL_SOLVER_CONCURRENCY_BUDGET');}
    if(performance.now()>=deadlineAt){status='SEARCH_EXHAUSTED';throw Error('OWNER_RESOLUTION_CONSUMED_DECISION_DEADLINE');}
    const matrix=compileAllocationMilp(problem,deadlineAt-performance.now());
    // The solver's numerical search limit excludes process startup and result
    // transport. Reserve that time inside the unchanged hard owner deadline.
    const remaining=deadlineAt-performance.now()-500;
    if(remaining<=0){status='SEARCH_EXHAUSTED';throw Error('OWNER_RESOLUTION_CONSUMED_DECISION_DEADLINE');}
    matrix.input.budget.deadlineMs=Math.max(1,Math.floor(remaining));
    const bytes=JSON.stringify(matrix.input);if(Buffer.byteLength(bytes)>8*1024*1024)throw new AllocationContractError('LIMIT_EXCEEDED','MILP input exceeds 8 MiB');
    const python=process.env.FINNOR_S5_PYTHON??process.env.FINNOR_S3_PYTHON;
    if(!python){status='SOLVER_UNAVAILABLE';throw Error('S5_PINNED_PYTHON_NOT_CONFIGURED');}
    compute.actualRoute='SCIPY_HIGHS_ROBUST_MILP';activeSolvers++;
    const result=await new Promise<SolverResult>((resolve,reject)=>{
      let child:ReturnType<typeof spawn>;
      try{child=spawn(python,[fileURLToPath(new URL('./allocation-solver.py',import.meta.url))],{env:{NODE_ENV:process.env.NODE_ENV,PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',MKL_NUM_THREADS:'1'},stdio:['pipe','pipe','pipe']});}
      catch(error){activeSolvers--;reject(error);return;}
      let stdout='',stderr='',closed=false,settled=false,failed:Error|null=null;
      const fail=(error:Error)=>{const first=!failed;failed??=error;if(!settled){settled=true;reject(failed);}if(first){clearTimeout(timer);child.kill('SIGKILL');}};
      const timer=setTimeout(()=>fail(Object.assign(Error('SOLVER_WALL_DEADLINE'),{code:'DEADLINE'})),Math.max(1,deadlineAt-performance.now()));
      child.stdout!.on('data',(b:Buffer)=>{if(failed)return;stdout+=b.toString();if(Buffer.byteLength(stdout)>2*1024*1024)fail(Error('SOLVER_OUTPUT_LIMIT'));});
      child.stderr!.on('data',(b:Buffer)=>{if(!failed&&stderr.length<4096)stderr+=b.toString().slice(0,4096-stderr.length);});
      child.on('error',fail);
      child.on('close',code=>{closed=true;clearTimeout(timer);activeSolvers--;if(settled)return;settled=true;try{if(code!==0)throw Error(`SOLVER_PROCESS_EXIT:${code}:${stderr}`);const r=JSON.parse(stdout);if(r.schema!=='finnor.s5.milp-result.v1')throw Error('SOLVER_RESULT_SCHEMA');resolve(r);}catch(error){reject(error);}});
      // Promise settlement is immediate on error, but CPU concurrency remains
      // charged until close. Failed kill/spawn/stdio events cannot settle twice.
      child.stdin!.on('error',error=>{if(!closed)fail(error);});child.stdin!.end(bytes);
    });
    Object.assign(compute.backend,{version:result.backend.highsVersion,pythonVersion:result.backend.pythonVersion,scipyVersion:result.backend.scipyVersion,numpyVersion:result.backend.numpyVersion});compute.usage.backend=result.usage;
    compute.usage.backend.termination=result.termination;compute.usage.backend.numericStatus=result.status;compute.usage.backend.warnings=result.warnings;
    if(result.backend.scipyVersion!=='1.16.2'||result.backend.numpyVersion!=='2.3.3'||result.backend.highsVersion!=='1.8.0')throw Error('SOLVER_PINNED_VERSION_CHANGED');
    if(result.minDualBound!==null&&Number.isFinite(result.minDualBound))solverUpperBoundEstimate=-result.minDualBound;
    if(result.vector&&['OPTIMAL_NUMERICAL','FEASIBLE_NUMERICAL','SEARCH_EXHAUSTED'].includes(result.status)){
      if(result.vector.length!==matrix.input.c.length||result.vector.some(v=>!Number.isFinite(v))||result.vector.slice(0,matrix.policyColumns.length).some(v=>Math.abs(v-Math.round(v))>1e-7||v< -1e-7||v>1+1e-7))throw Error('SOLVER_NONINTEGER_OR_NONFINITE_INCUMBENT');
      selectedPolicyIds=matrix.policyColumns.filter((_,i)=>result.vector![i]!>.5);status=result.status==='OPTIMAL_NUMERICAL'?'FEASIBLE':'SEARCH_EXHAUSTED';
    }else{status=result.status==='INFEASIBLE_NUMERICAL'?'INFEASIBLE':result.status==='SEARCH_EXHAUSTED'?'SEARCH_EXHAUSTED':'NUMERICAL_FAILURE';reasons.push(result.termination);}
    dualProposal=result.dualProposal;compute.outputRefs=[`solver-output:${epistemicHash(result)}`];
  }catch(e){if(e instanceof AllocationContractError)throw e;const code=(e as NodeJS.ErrnoException).code;if(code==='ENOENT')status='SOLVER_UNAVAILABLE';if(code==='DEADLINE')status='SEARCH_EXHAUSTED';reasons.push(e instanceof Error?e.message:'SOLVER_FAILURE');}
  const usageCpu=process.cpuUsage(cpu);Object.assign(compute.usage,{elapsedMs:performance.now()-start,cpuUserMicros:usageCpu.user,cpuSystemMicros:usageCpu.system,rssAfterBytes:process.memoryUsage().rss});compute.attempts=[{startedAt,finishedAt:new Date().toISOString(),status}];compute.id=`model-compute:${epistemicHash(compute)}`;
  return {status,selectedPolicyIds,reasons,compute,solverUpperBoundEstimate,dualProposal};
}
