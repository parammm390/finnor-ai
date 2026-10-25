/** Public acquisition read contracts. Keep this file independent of server
 * owners, execution modules and schema construction dependencies. */
export interface AcquisitionMandateView {
    dealId:string;
    workId:string;
    baseRunId:string;
    bidDomain:{nodeId:string;currency:string;values:string[]};
    financingCases:Array<{key:string;name:string;overrides:Array<{nodeId:string;value:string;reason:string}>}>;
    constraints:Array<{outputNodeId:string;operator:'gte'|'lte';threshold:string;unit:'money'|'rate'|'multiple'|'ratio'|'count';currency?:string}>;
    limits:{maxCandidates:number;deadlineMs:number};
}
export interface AcquisitionCandidate {
    bid: string;
    financingCaseKey: string;
    runId: string;
    resultHash: string;
    feasible: boolean | null;
    failedConstraints: string[];
    unresolved: string[];
}
export interface AcquisitionResult {
    schema: 'finnor.acquisition-decision.v1';
    baseRunId: string;
    inputHash: string;
    candidates: AcquisitionCandidate[];
    completeSearch: boolean;
    maximumBid: {
        value: string | null;
        financingCaseKey: string | null;
        runId: string | null;
        qualification: 'MAXIMUM_IN_DECLARED_FINITE_DOMAIN' | 'UNRESOLVED' | 'NO_FEASIBLE_CANDIDATE';
    };
    executionAuthorityGranted: false;
    realizedProfitEstablished: false;
    costUSD: null;
}
export interface AcquisitionDecisionRead {
    decisionId:string;
    workId:string;
    workInputId:string;
    status:'QUEUED'|'RUNNING'|'WAITING_ANALYSIS'|'TESTED'|'PARTIAL'|'FAILED'|'INVALIDATED';
    request:AcquisitionMandateView;
    result:AcquisitionResult|null;
    reason:string|null;
    deadlineAt:string;
    completionEvent:{eventType:'analysis.acquisition.terminal';resource:{type:'work';id:string};correlationId:string};
    analysis?:{programId:string|null;baseRunId:string|null;resultDigest:string|null;parentPlanRevisionId:string|null};
}
