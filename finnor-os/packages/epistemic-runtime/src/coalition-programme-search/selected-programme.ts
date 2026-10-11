import type {CoalitionProblem,CoalitionCandidate,CoalitionP1Module} from "../../../shared-types/src/coalition-programme";
import type {ExperimentRef} from "../../../shared-types/src/experiments";
import {epistemicHash} from "../source-precedence";
import {requireCoalition} from "./guards";

/** No new financial evaluator: original exact quantities pass unchanged to the
 * existing current S4/S5/S6 owner callees. Output remains untrusted until checked. */
export function compileSelectedCoalitionProgramme(original:CoalitionProblem,candidate:CoalitionCandidate,selectionRef:ExperimentRef):CoalitionP1Module{
 requireCoalition(candidate.originalDigest===epistemicHash(original),"SELECTED_ORIGINAL_PREIMAGE");
 requireCoalition(selectionRef.owner==="S4"&&selectionRef.version===original.version,"SELECTED_S4_OWNER");
 const programmes=candidate.selectedOptionIds.map(id=>{
  const option=candidate.programmeOptions.find(option=>option.id===id);
  requireCoalition(option,"SELECTED_ORIGINAL_OPTION");return option;
 });
 requireCoalition(programmes.length<=original.parties.length&&programmes.every(option=>option.steps.length<=original.grammar.maxSteps),
  "SELECTED_PROGRAMME_STEP_BOUND");
 return {schema:"finnor.p1.coalition-owner-programme.v1",originalDigest:candidate.originalDigest,
  candidateDigest:epistemicHash(candidate),selectionRef,programmes,division:candidate.division,
  stages:["READ_S4_SELECTION","RESERVE_SINGLE_S5","INTEND_SINGLE_S5_CONSUMPTION","PROPOSE_S6_SCHEDULE","STOP_UNADMITTED_EFFECT"],
  quantityEncoding:"ORIGINAL_CANONICAL_RATIONAL_STRINGS",
  qualification:"ORDINARY_SELECTED_OWNER_PLANNING_NOT_BUSINESS_EXECUTION",executionAuthorityGranted:false};
}
