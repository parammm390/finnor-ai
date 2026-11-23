import type { ConstructionResult, Y3Ref } from "../../interaction-synthesis/contracts";
import type { InteractionProtocol, SubmitRequest } from "../../interaction-synthesis/product-contracts";
import type { CoalitionConstruction, CoalitionCheck, CoalitionRuntime } from
  "../../../../epistemic-runtime/src/project-z/z2-coalitions/contracts";
export interface CoalitionProductRuntime {
  schema: "finnor.project-z.z2.product-runtime.v1";
  digest: string; semanticDigest: string; math: CoalitionRuntime; nativeSemanticDigest: string;
  ownerPins: { path: string; sha256: string }[];
  executionOwnerPin: { path: string; sha256: string };
}
export interface CoalitionCheckpoint extends ConstructionResult {
  z2: { construction: CoalitionConstruction; runtimeDigest: string };
}
export interface CoalitionResilientProtocol {
  schema: "finnor.coalition-resilient-protocol.v1";
  nativeProtocolId: string; ref: Y3Ref; productLockDigest: string;
  nativeProtocolRef: Y3Ref; originalRequestDigest: string; problemDigest: string;
  candidateDigest: string | null; runtime: CoalitionProductRuntime;
  original: {
    tenantId: string; principalId: string; workId: string; workInputId: string; workInputDigest: string;
    root: SubmitRequest["root"]; episodeId: string; deadlineAt: string; rightsRevision: string;
    attemptsUsed: number; searchStepsOccupied: number; retainedBytes: number;
  };
  incentiveConcept: string; coalitionLimit: string; excludedThreatClasses: string[];
  construction: CoalitionConstruction; check: CoalitionCheck;
  nativeOwnerContract: "INTERACTION_PROTOCOL_S4_EXACT_TERMS_CONSENT_S5_S6_V1";
  qualification: {
    protectedAdmission: false; productionActivated: false; equippedIncrement: "NOT_RUN";
    operational100x: "NOT_RUN"; financial100x: "NOT_RUN"; actualCompliance: "UNKNOWN";
  };
  gaps: string[];
}
export type NativeCoalitionArtifact = InteractionProtocol & { coalition: CoalitionResilientProtocol };

/** Participant-visible scope only. Private models, plans, gains and witnesses stay with the owner. */
export interface CoalitionTermsContract {
  schema: "finnor.project-z.z2.terms-contract.v1"; certificateRef: Y3Ref; nativeProtocolRef: Y3Ref;
  productLockDigest: string; runtimeSemanticDigest: string; checkerDigest: string;
  incentiveConcept: string; coalitionLimit: string; excludedThreatClasses: string[];
  modelStatus: "SUPPLIED_EXACT_MODELS_NOT_FIELD_IDENTIFICATION";
  actualCompliance: "UNKNOWN"; privateProofDataIncluded: false; protectedAdmission: false;
  productionActivated: false; executionAuthorityGranted: false;
}
