/** Coherence at existing owner seams, not a planner, ledger or grant system. */
import { createDefaultPluginRegistry, planningCapabilitiesForVertical } from "../../plugin-registry";
import { observeOriginalWork } from "./original-work-observation";
import { prepareInstitutionApplicationOrigin } from "./institution-origin";

export class ConvergedInstitutionRuntime {
  readonly interfaceVersion = "institution-runtime-convergence-v1";
  readonly scientificIncrement = false;
  capabilities(vertical: string) {
    return planningCapabilitiesForVertical(createDefaultPluginRegistry(), vertical);
  }
  observeOriginalWork = observeOriginalWork;
  prepareInstitutionApplicationOrigin = prepareInstitutionApplicationOrigin;
}
export * from "./semantics";
export * from "./original-work-observation";
export * from "./institution-origin";
export * from "./institution-allocation";
export * from "./institution-consumer";
export * from "./projection";
