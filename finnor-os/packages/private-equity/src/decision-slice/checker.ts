import type { Expression } from '@finnor/underwriting';
import { compileUnderwritingModel } from '@finnor/underwriting';
import { epistemicHash } from '../../../epistemic-runtime/src/source-precedence';
import type { ProjectionInput, ProjectionWitness, ProjectionCheck } from './contracts';
import { DecisionSliceError } from './contracts';
import { checkEpisode } from './budget';

/** Separate mechanics checker. Does not import the proposal/mapping implementation.
 * Authentic owner resolution is a service prerequisite, not inferred from hashes. */
export function checkDecisionProjection(input:ProjectionInput,witness:ProjectionWitness):ProjectionCheck {
  const reasons:string[]=[],{binding,graph}=input;
  const reject=(reason:string)=>{reasons.push(reason);};
  try{
    checkEpisode();
    const {ref,...body}=graph;
    if(ref.owner!=='M1'||ref.id!==`decision-graph:${ref.contentDigest}`||epistemicHash(body)!==ref.contentDigest
      ||graph.bindingDigest!==epistemicHash(binding)||witness.bindingDigest!==graph.bindingDigest||witness.graphDigest!==ref.contentDigest)
      reject('GRAPH_BINDING_OR_WITNESS_REVISION_MISMATCH');
    if(witness.schema!=='finnor.m1.exact-projection-witness.v1'||witness.method!=='COMPLETE_DECLARED_BACKWARD_CLOSURE'
      ||witness.uncertaintyDomain!=='SUPPLIED_NATIVE_MODELS_AND_RECORDED_OWNER_OBJECTS'
      ||witness.numericalLossBound!==null||witness.projectionBudgetRef!==null)reject('UNSUPPORTED_OR_UNAUTHORIZED_NUMERIC_PROJECTION');
    const nodeById=new Map(graph.nodes.map(node=>[node.id,node]));
    if(nodeById.size!==graph.nodes.length)reject('DUPLICATE_NODE');
    const rootIds=[...new Set(graph.roots.map(root=>root.id))].sort();
    if(epistemicHash(rootIds)!==epistemicHash(witness.rootIds))reject('ROOT_SET_CHANGED');
    const retained=new Set(witness.retainedIds),omitted=new Set(witness.omittedIds);
    if(retained.size!==witness.retainedIds.length||omitted.size!==witness.omittedIds.length||
      graph.nodes.some(node=>retained.has(node.id)===omitted.has(node.id))||
      [...retained,...omitted].some(id=>!nodeById.has(id)))reject('PARTITION_INCOMPLETE_OR_DUPLICATE');
    for(const root of graph.roots)if(!retained.has(root.id)||!nodeById.has(root.id))reject('MATERIAL_ROOT_OMITTED');
    for(const edge of graph.edges)if(!nodeById.has(edge.from)||!nodeById.has(edge.to)||retained.has(edge.from)&&!retained.has(edge.to))
      reject('DEPENDENCY_GROUP_OMITTED');
    for(const group of graph.solverGroups)if(group.members.some(id=>retained.has(id))&&group.members.some(id=>!retained.has(id)))
      reject('SOLVER_GROUP_CUT');

    // Derive refs independently from immutable native expression syntax, including
    // inactive conditional arms, products and periods, rather than a successful trace.
    const expressionRefs=(expression:Expression,lags:Map<string,number|null>,depth=0):string[]=>{
      if(depth>64)throw Error('EXPRESSION_DEPTH');
      switch(expression.op){
        case 'literal':return [];
        case 'ref':case 'lag':{
          const lag=expression.op==='lag'?expression.periods:0;
          lags.set(expression.nodeId,lags.has(expression.nodeId)&&lags.get(expression.nodeId)!==lag?null:lag);
          return [expression.nodeId];
        }
        case 'negate':return expressionRefs(expression.arg,lags,depth+1);
        case 'compare':return [...expressionRefs(expression.left,lags,depth+1),...expressionRefs(expression.right,lags,depth+1)];
        case 'if':return [...expressionRefs(expression.condition,lags,depth+1),...expressionRefs(expression.then,lags,depth+1),...expressionRefs(expression.else,lags,depth+1)];
        default:return expression.args.flatMap(arg=>expressionRefs(arg,lags,depth+1));
      }
    };
    for(const candidate of binding.underwriting){
      const compiled=compileUnderwritingModel(candidate.definition,checkEpisode);
      if(compiled.semanticHash!==candidate.modelDigest)reject('NATIVE_MODEL_DIGEST_MISMATCH');
      for(const definition of candidate.definition.nodes){
        checkEpisode();
        const id=`${candidate.candidateId}:${definition.id}`,node=nodeById.get(id);
        if(!node||node.definitionDigest!==epistemicHash(definition)||node.unit!==definition.unit||
          node.currency!==(definition.currency??null)||epistemicHash(node.ownerRef)!==epistemicHash(candidate.modelRef)||
          epistemicHash(node.periods)!==epistemicHash([candidate.definition.periodDefinition]))reject('NATIVE_NODE_TYPE_UNIT_PERIOD_OR_IDENTITY_MISMATCH');
        const expression=definition.kind==='expression'||definition.kind==='series'?definition.expression:definition.kind==='check'?definition.assertion:null;
        const lags=new Map<string,number|null>();
        const expected=expression?[...new Set(expressionRefs(expression,lags))].sort():[...definition.dependencies].sort();
        const actual=graph.edges.filter(edge=>edge.from===id&&edge.kind==='COMPUTATIONAL').map(edge=>edge.to).sort();
        if(epistemicHash(actual)!==epistemicHash(expected.map(dep=>`${candidate.candidateId}:${dep}`).sort()))reject('DECLARED_COMPUTATIONAL_EDGE_MISSING_OR_ADDED');
        for(const edge of graph.edges.filter(edge=>edge.from===id&&edge.kind==='COMPUTATIONAL')){
          const nativeId=edge.to.slice(candidate.candidateId.length+1);
          if(edge.lagPeriods!==(lags.get(nativeId)??null))reject('NATIVE_COMPUTATIONAL_LAG_CHANGED');
        }
        for(const edge of graph.edges.filter(e=>e.from===id&&e.kind==='COMPUTATIONAL'))if(edge.expressionDigest!==epistemicHash(definition))reject('EXPRESSION_COMMITMENT_CHANGED');
        const financialSource=binding.request.source.kind==='UNDERWRITING'?binding.request.source:
          binding.request.source.kind==='POLICY'?binding.request.source.underwriting:undefined;
        if(definition.kind==='input'&&financialSource){
          const selected=financialSource.evidenceDerivationInputs?.[definition.id];
          const derivation=selected&&binding.p4.find(d=>d.id===selected.derivationId);
          const actual=graph.edges.filter(e=>e.from===id&&e.kind==='PROVENANCE'),resolved=candidate.input.values[definition.id];
          if(derivation&&selected){
            const owner={owner:'P4',id:derivation.id,version:derivation.code.version,contentDigest:epistemicHash(derivation)};
            const output=derivation.result?.outputs[selected.output];
            if(actual.length!==1||actual[0]!.to!==`p4:${derivation.id}:complete-owner`||actual[0]!.expressionDigest!==
              epistemicHash({binding:selected,input:resolved,derivation:owner}))reject('P4_INPUT_PROVENANCE_EDGE_CHANGED_OR_OMITTED');
            if(!output||output.kind!=='scalar'||epistemicHash(output.semantics)!==epistemicHash(definition.evidenceSemantics)||
              resolved?.value!==output.value||resolved?.truthClass!=='DERIVED_VALUE'||resolved.status!=='KNOWN'||
              !resolved.provenance.some(p=>p.kind==='evidence_derivation'&&p.id===derivation.id&&p.anchorId===selected.output&&p.semanticHash===derivation.result?.digest))
              reject('P4_EXACT_TYPED_SCALAR_OR_NATIVE_INPUT_PREIMAGE_CHANGED');
          }else if(actual.length)reject('P4_PROVENANCE_WITHOUT_AUTHENTIC_RESOLVED_OWNER');
        }
        if(!['input','constant'].includes(definition.kind)||definition.kind==='input'&&definition.required||candidate.definition.runtime)
          if(!rootIds.includes(id)||!retained.has(id))reject('NATIVE_RUN_VALIDITY_ROOT_MISSING');
      }
      for(const block of candidate.definition.circularBlocks){
        const group=graph.solverGroups.find(group=>group.id===`${candidate.candidateId}:${block.id}`);
        if(!group||epistemicHash(group.members)!==epistemicHash(block.nodeIds.map(id=>`${candidate.candidateId}:${id}`))||
          epistemicHash(group.semantics)!==epistemicHash(block.settings)||group.members.some(id=>!retained.has(id)))reject('SOLVER_SEMANTICS_CHANGED_OR_CUT');
      }
    }
    const requiredObject=(id:string,value:unknown)=>{
      checkEpisode();
      if(nodeById.get(id)?.definitionDigest!==epistemicHash(value)||!retained.has(id)||!rootIds.includes(id))reject('COMPLETE_NATIVE_OWNER_OBJECT_OMITTED_OR_CHANGED');
    };
    for(const derivation of binding.p4){
      const id=`p4:${derivation.id}:complete-owner`,owner=nodeById.get(id)?.ownerRef;
      requiredObject(id,derivation);
      if(derivation.schema!=='finnor.evidence-derivation.v1'||derivation.code.version!=='p4-native-v1'||
        derivation.work.id!==binding.work.id||derivation.work.revision!==binding.work.inputId||
        derivation.status!=='TESTED'||derivation.failure||derivation.coverage.status!=='COMPLETE_SELECTED_UNIVERSE'||!derivation.result||!derivation.independentChecks.length||
        derivation.independentChecks.some(c=>c.status!=='PASS')||derivation.contradictions.length||
        owner?.owner!=='P4'||owner.contentDigest!==epistemicHash(derivation))reject('P4_AUTHENTIC_COMPLETE_OWNER_OR_CHECK_QUALIFICATION_CHANGED');
    }
    for(const {policy,model,kernel}of binding.policies){
      const prefix=`policy:${policy.ref.contentDigest}`;
      requiredObject(`${prefix}:complete-owner`,policy);requiredObject(`${prefix}:model`,model);requiredObject(`${prefix}:kernel`,kernel);
      for(const mechanism of model.request.mechanisms)for(const equation of mechanism.equations)for(const feature of equation.features){
        const atoms=feature.kind==='PRODUCT'?[feature.left,feature.right]:[feature];
        for(const atom of atoms){
          if(atom.kind==='CONSTANT')continue;
          const from=`${prefix}:state:${equation.variableId}`,to=`${prefix}:${atom.kind==='STATE'?'state':'exposure'}:${atom.id}`;
          if(!graph.edges.some(edge=>edge.from===from&&edge.to===to&&edge.kind==='MODEL_RELATIVE_RESPONSE'&&edge.lagPeriods===atom.lag&&
            edge.expressionDigest===epistemicHash({mechanismId:mechanism.id,equation,feature})))reject('S3_PRODUCT_LAG_OR_MODEL_ALTERNATIVE_EDGE_MISSING');
        }
      }
      for(const action of policy.problem.actions)requiredObject(`${prefix}:action:${action.id}`,action);
      for(const observation of policy.problem.observations)requiredObject(`${prefix}:observation:${observation.id}`,observation);
      for(const obligation of policy.problem.obligations)requiredObject(`${prefix}:obligation:${obligation.ref.contentDigest}`,obligation);
    }
    if(binding.allocation){
      const {problem,certificate}=binding.allocation,prefix=`allocation:${certificate.ref.contentDigest}`;
      requiredObject(`${prefix}:complete-problem`,problem);
      for(const resource of binding.resourceSnapshot?.resources??problem.resources){
        const rid=`${prefix}:resource:${resource.resourceId}`;requiredObject(rid,resource);
        for(const covenant of resource.covenants)requiredObject(`${rid}:covenant:${covenant.id}`,covenant);
      }
      for(const scenario of problem.jointModel.scenarios)requiredObject(`${prefix}:joint:${scenario.id}`,scenario);
      for(const outstanding of binding.resourceSnapshot?.outstanding??problem.outstanding)
        requiredObject(`${prefix}:outstanding:${outstanding.reservationRef.contentDigest}`,outstanding);
    }
    for(const gap of binding.gaps)requiredObject(`gap:${gap.id}`,gap);
    for(const obligation of binding.obligations)requiredObject(`effect:${obligation.id}`,obligation);
    requiredObject(`work:${binding.work.inputId}`,binding.work);
  }catch(error){
    if(error instanceof DecisionSliceError&&error.code==='LIMIT_EXCEEDED')throw error;
    reject('CHECK_INPUT_UNSUPPORTED_OR_CORRUPT');
  }
  return {schema:'finnor.m1.projection-check.v1',status:reasons.length?'REJECTED':'CHECKED',reasons:[...new Set(reasons)],
    witnessDigest:epistemicHash(witness),checker:'M1_SEPARATE_DECLARED_GRAPH_CHECKER_V1',
    exactPreservation:reasons.length===0,independentlyAdmitted:false,executionAuthorityGranted:false};
}
