import type {ContingentPolicy,ControlAction,ExactInformationModel} from '@finnor/shared-types';
import {ExperimentRational} from './experiment-numerics';
import {parseExactInformationModel,ControlFraction as Q,controlBytesDigest,controlCanonical,ExactControlError} from './certified-state-reduction';
import {exactPresentation} from './exact-control-policy';
import {epistemicHash} from './source-precedence';
const models=new WeakMap<ContingentPolicy,ExactInformationModel>();
export function exactPolicyModel(policy:ContingentPolicy):ExactInformationModel|null{
 if(!policy.exactProfile)return null;const prior=models.get(policy);if(prior)return prior;
 const p=policy.exactProfile;if(controlBytesDigest(p.modelBytes)!==p.modelDigest||p.evaluation.modelDigest!==p.modelDigest)throw new ExactControlError('UNSUPPORTED','S5_EXACT_ORIGINAL_BYTES_BINDING');
 const model=parseExactInformationModel(p.modelBytes,{deadlineAt:Date.now()+30000,maxSteps:4000000});
 if(epistemicHash(model.mandateRef)!==epistemicHash(policy.mandateRef)||model.rightsRef!==policy.bindings.rightsRef)throw new ExactControlError('UNSUPPORTED','S5_EXACT_ORIGINAL_MANDATE_BINDING');
 const exact=policy.demand.exact;
 if(policy.demand.schema!=='finnor.contingent-resource-demand.exact.v2'||!exact||exact.modelDigest!==p.modelDigest||exact.quantityEncoding!=='NORMALIZED_RATIONAL_PAIRS'||exact.numericProjection!=='PRESENTATION_ONLY'||epistemicHash(exact.sourceRef)!==epistemicHash(p.sourceRef)||controlCanonical(exact.units)!==controlCanonical(model.units)||controlCanonical(exact.discountFactors)!==controlCanonical(model.economics.discountFactors)||exact.branches.length!==policy.nodes.length)throw new ExactControlError('UNSUPPORTED','S5_EXACT_DEMAND_SOURCE_BINDING');
 const root=model.states.find(s=>s.id===p.evaluation.root);
 if(!root||controlCanonical(exact.existingObligations)!==controlCanonical(root.semantics.obligations))throw new ExactControlError('UNSUPPORTED','S5_EXACT_ORIGINAL_OBLIGATION_BINDING');
 for(const node of policy.nodes){const a=model.actions.find(a=>a.id===node.actionId),b=exact.branches.find(b=>b.nodeId===node.id),d=policy.demand.branches.find(b=>b.nodeId===node.id);
  if(!a||!b||!d||b.actionId!==a.id||b.period!==node.period||b.occupationPeriods!==a.occupationPeriods||b.parentNodeId!==d.parentNodeId||controlCanonical(b.mutuallyExclusiveSiblings)!==controlCanonical(d.mutuallyExclusiveSiblings)||controlCanonical(b.total)!==controlCanonical(a.resources)||controlCanonical(b.occupancy)!==controlCanonical(a.occupancy)||controlCanonical(b.exposures)!==controlCanonical(a.exposures)||controlCanonical(b.cost)!==controlCanonical(a.cost)||controlCanonical(b.humanSeconds)!==controlCanonical(a.humanSeconds)||controlCanonical(b.terminalLiability)!==controlCanonical(a.tailLiability))throw new ExactControlError('UNSUPPORTED','S5_EXACT_ORIGINAL_BRANCH_DEMAND_BINDING');
 }
 models.set(policy,model);return model;
}
/** This function is used independently by the canonical S5 reconstruction and
 * its numerical proposal compiler. It never parses a displayed approximation
 * when an authoritative exact S4 action exists. */
export function exactPolicyActionQuantity(policy:ContingentPolicy,action:ControlAction,field:'resources'|'occupancy'|'cost'|'tailLiability'|'humanSeconds',dimension?:string):ExperimentRational|null{
 const model=exactPolicyModel(policy);if(!model)return null;const a=model.actions.find(a=>a.id===action.id);
 if(!a)throw new ExactControlError('UNSUPPORTED','S5_ORIGINAL_EXACT_ACTION_MISSING');
 const value=dimension?(a[field] as Record<string,unknown>)[dimension]:a[field],q=Q.read(value);
 const display=dimension?(action[field] as Record<string,unknown>)[dimension]:action[field];
 if(exactPresentation(value)!==display)throw new ExactControlError('UNSUPPORTED','S5_DISPLAY_ORIGINAL_ACTION_BINDING');
 return new ExperimentRational(q.n,q.d);
}
