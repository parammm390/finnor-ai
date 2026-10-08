import type { InterventionFeature } from '@finnor/shared-types';
import type { Expression } from '@finnor/underwriting';
import { epistemicHash } from '../../../epistemic-runtime/src/source-precedence';
import { m1Ref, p4Ref, DecisionSliceError, type NativeBinding, type DecisionNode, type DecisionEdge, type DecisionGraph,
  type ProjectionWitness, type NodeKind } from './contracts';
import { checkEpisode } from './budget';

/** Dependencies express the complete declared domain, not observed branch sensitivity. */
export function buildDecisionGraph(binding:NativeBinding):DecisionGraph {
  const nodes:DecisionNode[]=[],edges:DecisionEdge[]=[],roots:DecisionGraph['roots']=[];
  const solverGroups:DecisionGraph['solverGroups']=[];
  const add=(id:string,nativeId:string,kind:NodeKind,value:unknown,ownerRef:DecisionNode['ownerRef'],candidateId:string|null,
    unit:string|null=null,currency:string|null=null,periods:unknown[]=[],status='RETAINED',qualification='OWNER_RECORD_NOT_SCIENTIFIC_TRUTH')=>{
    checkEpisode();
    nodes.push({id,nativeId,kind,candidateId,ownerRef,unit,currency,periods,definitionDigest:epistemicHash(value),qualification,status});
  };
  const root=(id:string,criterion:string,hard=false)=>roots.push({id,criterion,hard});
  const edge=(from:string,to:string,kind:DecisionEdge['kind'],value:unknown,lagPeriods:number|null=null)=>{
    checkEpisode();
    edges.push({from,to,kind,expressionDigest:epistemicHash(value),lagPeriods});
  };
  const expressionLags=(expression:Expression):Map<string,number|null>=>{
    const result=new Map<string,number|null>();
    const visit=(x:Expression)=>{
      if(x.op==='ref'||x.op==='lag'){const lag=x.op==='lag'?x.periods:0;result.set(x.nodeId,result.has(x.nodeId)&&result.get(x.nodeId)!==lag?null:lag);}
      else if('args'in x)x.args.forEach(visit);
      else if(x.op==='negate')visit(x.arg);
      else if(x.op==='compare'){visit(x.left);visit(x.right);}
      else if(x.op==='if'){visit(x.condition);visit(x.then);visit(x.else);}
    };visit(expression);return result;
  };
  for(const derivation of binding.p4){
    const id=`p4:${derivation.id}:complete-owner`;
    add(id,derivation.id,'OWNER_OBJECT',derivation,p4Ref(derivation),null,null,null,[],'P4_RESOLVED','P4_EXACT_FINANCIAL_DERIVATION_NOT_OPERATIVE_LEGAL_COMPLETENESS');
    root(id,'COMPLETE_P4_PROGRAM_SOURCES_CHECKS_AND_CURRENTNESS',true);
  }
  for(const candidate of binding.underwriting){
    const prefix=candidate.candidateId,periods= candidate.definition.periodDefinition;
    for(const node of candidate.definition.nodes){
      const id=`${prefix}:${node.id}`,input=candidate.inputQualifications.find(q=>q.nodeId===node.id);
      add(id,node.id,'NATIVE_VARIABLE',node,candidate.modelRef,prefix,node.unit,node.currency??null,[periods],
        input?.status??'RETAINED',node.kind==='input'?'NATIVE_OWNER_INPUT_QUALIFICATION_RETAINED':'DECLARED_NATIVE_COMPUTATION');
      // Native execution evaluates every executable node. Its failure can invalidate
      // the full run even if this expression is disconnected from selected outputs.
      if(!['input','constant'].includes(node.kind)||node.kind==='input'&&node.required)
        root(id,node.kind==='check'?'HARD_NATIVE_CHECK':node.kind==='output'?'CANDIDATE_PAYOFF':'NATIVE_RUN_VALIDITY',node.kind==='check'||node.kind==='input');
      const expression=node.kind==='expression'||node.kind==='series'?node.expression:node.kind==='check'?node.assertion:null;
      const lags=expression?expressionLags(expression):new Map<string,number|null>();
      for(const dep of node.dependencies)edge(id,`${prefix}:${dep}`,'COMPUTATIONAL',node,lags.get(dep)??null);
      const financialSource=binding.request.source.kind==='UNDERWRITING'?binding.request.source:
        binding.request.source.kind==='POLICY'?binding.request.source.underwriting:undefined;
      if(node.kind==='input'&&financialSource){
        const selected=financialSource.evidenceDerivationInputs?.[node.id];
        const derivation=selected&&binding.p4.find(d=>d.id===selected.derivationId);
        if(derivation)edge(id,`p4:${derivation.id}:complete-owner`,'PROVENANCE',
          {binding:selected,input:candidate.input.values[node.id],derivation:p4Ref(derivation)});
      }
    }
    for(const block of candidate.definition.circularBlocks){
      solverGroups.push({id:`${prefix}:${block.id}`,members:block.nodeIds.map(id=>`${prefix}:${id}`),semantics:block.settings,
        status:candidate.definition.runtime?'QUALIFIED_SPECIALIZED_NATIVE_SOLVER':'UNSUPPORTED_GENERIC_CYCLE_RETAINED'});
      for(const id of block.nodeIds)root(`${prefix}:${id}`,'SOLVER_BLOCK_VALIDITY',true);
    }
    if(candidate.definition.runtime){
      // The specialized evaluator has conventions not exhaustively represented in
      // declared schedule edges. Preserve its entire model/input rather than cut it.
      for(const node of candidate.definition.nodes)root(`${prefix}:${node.id}`,'FULL_SPECIALIZED_RUNTIME_DEPENDENCY',true);
    }
  }
  for(const {policy,model,kernel}of binding.policies){
    const prefix=`policy:${policy.ref.contentDigest}`,ownerId=`${prefix}:complete-owner`;
    add(ownerId,'complete-policy','OWNER_OBJECT',policy,policy.ref,prefix);root(ownerId,'ALL_CANDIDATES_INCUMBENT_BRANCHES_TIMING_AND_UTILITY',true);
    const modelId=`${prefix}:model`;
    add(modelId,'complete-model','OWNER_OBJECT',model,model.ref,prefix);root(modelId,'COMPLETE_MODEL_ALTERNATIVES_IDENTIFICATION_AND_HISTORY',true);
    add(`${prefix}:kernel`,'complete-kernel','OWNER_OBJECT',kernel,kernel.ref,prefix);root(`${prefix}:kernel`,'JOINT_SCENARIO_COEFFICIENTS_SHOCKS_SUPPORT',true);
    edge(ownerId,modelId,'OWNER_CURRENTNESS',policy.bindings);
    edge(ownerId,`${prefix}:kernel`,'MODEL_RELATIVE_RESPONSE',kernel.ref);
    for(const state of model.request.stateVariables){
      const id=`${prefix}:state:${state.id}`;add(id,state.id,'STATE',state,model.ref,prefix,state.unit,null,[model.request.time]);
      root(id,'UTILITY_HARD_RANGE_AND_COMPLETE_JOINT_TRANSITION');
    }
    for(const exposure of model.request.exposures){
      const id=`${prefix}:exposure:${exposure.id}`;add(id,exposure.id,'EXPOSURE',exposure,model.ref,prefix,exposure.unit,null,[model.request.time]);
      root(id,'ACTION_AND_LAGGED_EXPOSURE');
    }
    const featureAtoms=(feature:InterventionFeature)=>
      feature.kind==='PRODUCT'?[feature.left,feature.right]:[feature];
    for(const mechanism of model.request.mechanisms){
      const assumptionId=`${prefix}:assumptions:${mechanism.id}`;
      add(assumptionId,mechanism.id,'MODEL_ASSUMPTION',mechanism,model.ref,prefix);root(assumptionId,'MODEL_ALTERNATIVE_AND_COUNTERPARTY_ASSUMPTIONS',true);
      for(const equation of mechanism.equations)for(const feature of equation.features)for(const atom of featureAtoms(feature)){
        if(atom.kind==='CONSTANT')continue;
        edge(`${prefix}:state:${equation.variableId}`,`${prefix}:${atom.kind==='STATE'?'state':'exposure'}:${atom.id}`,
          'MODEL_RELATIVE_RESPONSE',{mechanismId:mechanism.id,equation,feature},atom.lag);
      }
    }
    for(const action of policy.problem.actions){
      const id=`${prefix}:action:${action.id}`;add(id,action.id,'TIMING',action,policy.ref,prefix,action.costUnit);
      root(id,'EVERY_ACTION_INCLUDING_WAIT_STOP_INQUIRE_ALTERNATIVES',true);edge(ownerId,id,'COMPUTATIONAL',action);
      for(const exposureId of Object.keys(action.exposures))edge(id,`${prefix}:exposure:${exposureId}`,'MODEL_RELATIVE_RESPONSE',action.exposures);
    }
    for(const observation of policy.problem.observations){
      const id=`${prefix}:observation:${observation.id}`;add(id,observation.id,'OBSERVATION',observation,policy.ref,prefix,observation.unit);
      root(id,'AVAILABLE_INFORMATION_BRANCH_NONANTICIPATIVITY',true);
      edge(id,`${prefix}:state:${observation.variableId}`,'OBSERVATIONAL',observation,observation.delayPeriods);
    }
    for(const obligation of policy.problem.obligations){
      const id=`${prefix}:obligation:${obligation.ref.contentDigest}`;add(id,obligation.ref.id,'OBLIGATION',obligation,policy.ref,prefix);
      root(id,'OUTSTANDING_EXPOSURE_OCCUPATION_AND_TERMINAL_LIABILITY',true);
    }
  }
  if(binding.allocation){
    const {problem,certificate}=binding.allocation,prefix=`allocation:${certificate.ref.contentDigest}`;
    const id=`${prefix}:complete-problem`;add(id,'complete-allocation-problem','OWNER_OBJECT',problem,problem.ref,null);
    root(id,'JOINT_RESOURCE_FEASIBILITY_AND_COMPLETE_RANKING',true);
    for(const resource of binding.resourceSnapshot?.resources??problem.resources){
      const rid=`${prefix}:resource:${resource.resourceId}`;add(rid,resource.resourceId,'RESOURCE',resource,resource.ref,null,resource.unit,resource.currency,[resource.horizon]);
      root(rid,'SHARED_CAPITAL_LIQUIDITY_EXISTING_USE_RIGHTS',true);
      for(const covenant of resource.covenants){
        const cid=`${rid}:covenant:${covenant.id}`;add(cid,covenant.id,'COVENANT',covenant,resource.ref,null,covenant.unit,null,covenant.periods);
        root(cid,'HARD_CONTRACTUAL_RESOURCE_BOUNDARY',true);
        for(const term of covenant.terms)edge(cid,`${prefix}:resource:${term.resourceId}`,'CONTRACTUAL',covenant);
      }
    }
    for(const scenario of problem.jointModel.scenarios){
      const sid=`${prefix}:joint:${scenario.id}`;add(sid,scenario.id,'JOINT_INTERACTION',scenario,problem.jointModel.ref,null,problem.mandate.utility.unit);
      root(sid,'JOINT_PRODUCTS_COMMON_PATHS_AND_RANKING',true);
    }
    for(const outstanding of binding.resourceSnapshot?.outstanding??problem.outstanding){
      const oid=`${prefix}:outstanding:${outstanding.reservationRef.contentDigest}`;
      add(oid,outstanding.reservationRef.id,'OUTSTANDING_COMMITMENT',outstanding,outstanding.certificateRef,null);
      root(oid,'CROSS_MANDATE_RESERVATION_UNKNOWN_OUTCOME_AND_RECOVERY',true);
    }
  }
  for(const obligation of binding.obligations){
    const id=`effect:${obligation.id}`;add(id,obligation.id,'OBLIGATION',obligation,{owner:'S6_NATIVE_EFFECT_STATE',id:obligation.id,version:'business-effect-state-v1',contentDigest:obligation.digest},null);
    root(id,'UNRECONCILED_NATIVE_EFFECT_LIABILITY',true);
  }
  const workId=`work:${binding.work.inputId}`;add(workId,binding.work.inputId,'AUTHORITY',binding.work,binding.work.ref,null);
  root(workId,'WORK_REVISION_CURRENTNESS',true);
  for(const gap of binding.gaps){
    const id=`gap:${gap.id}`,ref=m1Ref('material-premise',gap);add(id,gap.code,gap.requiredProducer==='S4'?'AUTHORITY':'CONTRACTUAL',gap,ref,null,null,null,[],gap.status);
    root(id,'UNRESOLVED_MATERIAL_PREMISE',true);
  }
  if(nodes.length>binding.request.resource.maxNodes)throw new DecisionSliceError('LIMIT_EXCEEDED','Decision dependency graph exceeds its node envelope');
  const known=new Set(nodes.map(n=>n.id));
  if(known.size!==nodes.length||edges.some(e=>!known.has(e.from)||!known.has(e.to)))
    throw new DecisionSliceError('CHECK_FAILED','Native graph contains duplicate or unsupported dependency identities');
  const body={schema:'finnor.decision-dependency-graph.v1' as const,bindingDigest:epistemicHash(binding),nodes,edges,roots,solverGroups,gaps:binding.gaps};
  return {...body,ref:m1Ref('decision-graph',body)};
}
export function proposeExactProjection(graph:DecisionGraph):ProjectionWitness {
  const reachable=new Set<string>(),pending=graph.roots.map(r=>r.id);
  const dependencies=new Map<string,string[]>();
  for(const edge of graph.edges)dependencies.set(edge.from,[...(dependencies.get(edge.from)??[]),edge.to]);
  while(pending.length){checkEpisode();const id=pending.pop()!;if(reachable.has(id))continue;reachable.add(id);pending.push(...dependencies.get(id)??[]);
    for(const group of graph.solverGroups)if(group.members.includes(id))pending.push(...group.members);
  }
  return {schema:'finnor.m1.exact-projection-witness.v1',bindingDigest:graph.bindingDigest,graphDigest:graph.ref.contentDigest,
    rootIds:[...new Set(graph.roots.map(r=>r.id))].sort(),retainedIds:[...reachable].sort(),
    omittedIds:graph.nodes.filter(n=>!reachable.has(n.id)).map(n=>n.id).sort(),method:'COMPLETE_DECLARED_BACKWARD_CLOSURE',
    uncertaintyDomain:'SUPPLIED_NATIVE_MODELS_AND_RECORDED_OWNER_OBJECTS',numericalLossBound:null,projectionBudgetRef:null,
    limitations:['Exact declared dependency preservation is not an enterprise completeness or numerical loss certificate',
      'Only disconnected groups are excluded; simultaneous material omissions are unsupported without S4 budget',
      'No global minimality, calibration, protected admission or effect authority']};
}
