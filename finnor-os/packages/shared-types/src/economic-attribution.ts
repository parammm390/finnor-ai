/** S7 owns qualification; referenced authorities, S2 assignment and S6 receipts
 * must be independently resolved. None of these types grants execution. */
export type EconomicEvidenceClass = 'DETERMINISTICALLY_VERIFIED' | 'EMPIRICALLY_VERIFIED' | 'PROBABILISTICALLY_SUPPORTED' | 'PARTIAL' | 'BLOCKED_EXTERNAL' | 'UNKNOWN';
export interface EconomicRef {
    owner: string;
    id: string;
    version: string;
    contentDigest: string;
}
export interface EconomicInterval {
    lower: string;
    upper: string;
}
export const ECONOMIC_COST_CATEGORIES = ['INTERVENTION', 'SYSTEM', 'HUMAN', 'COMPUTE', 'DATA', 'INTEGRATION', 'MAINTENANCE', 'RECOVERY', 'LEARNING', 'FAILED_RESEARCH', 'ADMISSION', 'REMEDIATION', 'DEVELOPMENT'] as const;
export type EconomicCostCategory = typeof ECONOMIC_COST_CATEGORIES[number];
export type EconomicControllerRole = 'FINNOR' | 'BUSINESS_AS_USUAL' | 'PINNED_CURRENT_FINNOR' | 'FRONTIER_SPECIALIST' | 'MUSE' | 'DOTS' | 'EXPERT_PE';
export interface OutcomeEstimand {
    schema: 'finnor.outcome-estimand.v1';
    version: 's7-bounded-owner-value-v1';
    semanticOwner: 'S7';
    key: string;
    episodeId: string;
    mandateRef: EconomicRef;
    ownerBoundaryRef: EconomicRef;
    ownershipWaterfallRef: EconomicRef;
    populationRef: EconomicRef;
    currency: string;
    registeredAt: string;
    assignmentAt: string;
    endpointAt: string;
    horizonMonths: number;
    outcomeAccessNotBefore: string;
    clusters: Array<{
        id: string;
        weight: string;
        openingWealth: string;
        wealthSupport: EconomicInterval;
        sourceManifestRef: EconomicRef;
    }>;
    controllers: Array<{
        id: string;
        role: EconomicControllerRole;
        programmeRef: EconomicRef;
        policyRefs: EconomicRef[];
        interventionRefs: EconomicRef[];
        adaptationRuleRef: EconomicRef;
    }>;
    businessAsUsualId: string;
    assignment: {
        kind: 'INDEPENDENT_CLUSTER_RANDOMIZATION';
        protocolRef: EconomicRef;
        probabilities: Record<string, string>;
        independenceRef: EconomicRef;
        exposureMappingRef: EconomicRef;
        noBetweenClusterInterferenceRef: EconomicRef;
    } | {
        kind: 'OBSERVATIONAL_UNIDENTIFIED';
        protocolRef: EconomicRef;
        exposureMappingRef: EconomicRef;
        reasons: string[];
    };
    discountSchedule: Array<{
        at: string;
        factor: string;
    }>;
    capitalCarryRef: EconomicRef;
    valuationProtocol: {
        ref: EconomicRef;
        authorityRefs: EconomicRef[];
        methodRefs: EconomicRef[];
        independenceRef: EconomicRef;
        conflictsBlindingRef: EconomicRef;
        maxAsOfAgeMs: number;
    };
    analysis: {
        method: 'BOUNDED_HT_HOEFFDING_V1';
        alpha: '0.05';
        registeredLooks: string[];
        minimumProbability: string;
        powerRegistrationRef: EconomicRef;
    };
    allocationRef: EconomicRef;
    requiredSourceRefs: EconomicRef[];
    assumptions: Array<{
        id: string;
        meaning: string;
        status: 'SUPPORTED' | 'DECLARED' | 'UNKNOWN' | 'CONTRADICTED';
        evidenceRefs: EconomicRef[];
    }>;
    budgets: {
        maximumClusters: number;
        maximumItemsPerCluster: number;
        maximumElapsedMs: number;
        maximumInputBytes: number;
    };
    correctionOf: EconomicRef | null;
}
export interface EconomicAssignment {
    clusterId: string;
    controllerId: string;
    assignedAt: string;
    assignmentRef: EconomicRef;
    protocolRef: EconomicRef;
    stages: Array<{
        stage: 'INTENDED' | 'AUTHORIZED' | 'ATTEMPTED' | 'ACKNOWLEDGED' | 'OBSERVED' | 'VERIFIED' | 'RECONCILED' | 'FAILED' | 'DECLINED' | 'REJECTED' | 'CANCELLED' | 'PARTIAL' | 'OVERRIDDEN' | 'UNKNOWN' | 'CENSORED';
        ref: EconomicRef;
    }>;
    actualExposureRefs: EconomicRef[];
}
export interface EconomicItem {
    canonicalId: string;
    sourceRef: EconomicRef;
    ownerBoundaryRef: EconomicRef;
    currency: string;
    at: string;
    destination: 'CASH_OWNER' | 'ADDITIONAL_CAPITAL' | 'RESIDUAL_EQUITY' | 'EXTRA_LIABILITY' | 'COST_ONCE' | 'EMBEDDED_COST' | 'INTERNAL_TRANSFER';
    amount: EconomicInterval | null;
    costCategory: EconomicCostCategory | null;
    embeddedIn: string | null;
    /** Owner-resolved adjustment statements cover cash/asset/debt/ownership changes. */
    reconciliationRefs: EconomicRef[];
}
export interface EconomicAccountingSubmission {
    schema: 'finnor.economic-accounting.v1';
    estimandRef: EconomicRef;
    clusterId: string;
    controllerId: string;
    knowledgeAt: string;
    asOf: string;
    closedLoopDays: number;
    sourceManifestRef: EconomicRef;
    items: EconomicItem[];
    sourceTotals: Array<{
        sourceRef: EconomicRef;
        destination: EconomicItem['destination'];
        itemIds: string[];
        total: EconomicInterval;
    }>;
    costCoverage: Array<{
        category: EconomicCostCategory;
        status: 'COMPLETE' | 'BOUNDED' | 'UNKNOWN';
        itemIds: string[];
        zeroCostEvidenceRef: EconomicRef | null;
    }>;
    valuations: Array<{
        itemId: string;
        authorityRef: EconomicRef;
        methodRef: EconomicRef;
        asOf: string;
        signedAssessmentRef: EconomicRef;
        inputRefs: EconomicRef[];
        ownershipDebtRef: EconomicRef;
        independenceRef: EconomicRef;
    }>;
    liabilityCoverageRef: EconomicRef | null;
    conservationRef: EconomicRef | null;
    correctionOf: EconomicRef | null;
}
/** Supplied only by an authenticated owner resolver; never accepted as HTTP authority. */
export interface EconomicEvidenceResolution {
    ref: EconomicRef;
    status: 'RESOLVED_AUTHENTICATED' | 'UNVERIFIED' | 'UNAVAILABLE';
    tenantId: string;
    knowledgeAt: string;
    protectedReceiptRef: EconomicRef | null;
    signatureVerified: boolean;
    independent: boolean;
    sourceOrigin?: 'FIELD' | 'GENERATED_CHALLENGE' | 'RETROSPECTIVE' | 'MODELED' | 'UNKNOWN';
    protectionDomain?: 'REVIEWED_PROTECTED_DOMAIN' | 'DISPOSABLE_TEST_AUTHORITY';
}
export interface EconomicAssessmentInput {
    schema: 'finnor.economic-assessment-request.v1';
    tenantId: string;
    principalId: string;
    estimand: OutcomeEstimand;
    estimandRef: EconomicRef;
    assessedAt: string;
    lookAt: string;
    assignments: EconomicAssignment[];
    accounting: EconomicAccountingSubmission[];
    evidence: EconomicEvidenceResolution[];
    priorAssessmentRef: EconomicRef | null;
    computeCost: {
        amount: EconomicInterval | null;
        pricebookRef: EconomicRef | null;
        meteringRef: EconomicRef | null;
    };
}
export interface EconomicAccountingResult {
    clusterId: string;
    controllerId: string;
    wealth: EconomicInterval | null;
    realizedOwnerCash: EconomicInterval | null;
    additionalCapital: EconomicInterval | null;
    residualEquity: EconomicInterval | null;
    extraLiabilities: EconomicInterval | null;
    onceCosts: EconomicInterval | null;
    completeCosts: boolean;
    independentResidual: boolean;
    sourceReconciled: boolean;
    supportedHorizon: 'H1' | 'H2';
    reasons: string[];
    itemIds: string[];
}
export interface EconomicAssessment {
    schema: 'finnor.economic-assessment.v1';
    version: 's7-bounded-owner-value-v1';
    semanticOwner: 'S7';
    ref: EconomicRef;
    tenantId: string;
    principalId: string;
    estimandRef: EconomicRef;
    assessedAt: string;
    lookAt: string;
    priorAssessmentRef: EconomicRef | null;
    population: {
        eligibleClusters: number;
        assignedClusters: number;
        retainedClusters: number;
        excludedClusters: 0;
    };
    accounting: EconomicAccountingResult[];
    contrasts: Array<{
        controllerId: string;
        businessAsUsualId: string;
        identification: 'DESIGN_BASED_CONDITIONAL' | 'UNIDENTIFIED';
        interval: EconomicInterval | null;
        scoreInterval: EconomicInterval | null;
        samplingRadiusUpper: string | null;
        support: EconomicInterval;
        reasons: string[];
    }>;
    supportedHorizon: 'H1' | 'H2';
    evidenceClass: EconomicEvidenceClass;
    completeCosts: boolean;
    protectedHistoryComplete: boolean;
    uncertainty: {
        coverage: 'SIMULTANEOUS_95_CONDITIONAL' | 'SUPPORT_BOUNDS_ONLY';
        familyContrasts: number;
        registeredLooks: number;
        sampling: 'BOUNDED_INDEPENDENT_CLUSTER_RANDOMIZATION' | 'UNIDENTIFIED';
        identification: string;
        measurement: string;
        valuation: string;
        cost: string;
        censoring: string;
        numerical: {
            arithmetic: 'BIGINT_RATIONAL';
            outwardDecimalPlaces: 12;
            maximumEndpointRoundingError: '0.000000000001';
            radius: 'EXACT_RATIONAL_LOG_UPPER_AND_SQRT_UPPER';
        };
    };
    aggregateCredit: {
        programmeOnly: true;
        actionCreditsIdentified: false;
        jointAndUnallocatedValuePreserved: true;
    };
    compute: {
        elapsedMs: number;
        processCpuUserMicros: number;
        processCpuSystemMicros: number;
        rssBeforeBytes: number;
        rssAfterBytes: number;
        cost: EconomicAssessmentInput['computeCost'];
        moneyStatus: 'METERED_SUPPLIED_UNVERIFIED' | 'UNKNOWN';
        sourceDigests: Array<{
            path: string;
            sha256: string;
        }>;
        nodeVersion: string;
        actualRoute: 'LOCAL_EXACT_BOUNDED';
        admission: 'UNADMITTED';
        protectedReceipt: null;
    };
    reasons: string[];
    executionAuthorityGranted: false;
    capabilityAdmissionGranted: false;
    protectedReceipt: null;
}
export interface EconomicBenchmarkRegistration {
    schema: 'finnor.economic-benchmark-registration.v1';
    key: string;
    registeredAt: string;
    protocolRef: EconomicRef;
    estimandRef: EconomicRef;
    matchedEnvelopeRef: EconomicRef;
    controllers: Array<{
        id: string;
        role: EconomicControllerRole;
        pinnedVersionRef: EconomicRef;
        required: true;
    }>;
    epsilon: string;
    absoluteValueFloor: string;
    minimumDecisionPayoff: string;
    downsideLimit: string;
    primaryHorizonMonths: 36;
    minimumClosedLoopDays: 90;
    multiplicityRef: EconomicRef;
    powerStoppingRef: EconomicRef;
    pricebookRef: EconomicRef;
    capabilityFrontierRef: EconomicRef;
    refreshAsOf: string;
    nextRefreshAt: string;
}
export interface EconomicBenchmarkInput {
    schema: 'finnor.economic-benchmark-request.v1';
    registration: EconomicBenchmarkRegistration;
    registrationRef: EconomicRef;
    assessedAt: string;
    assessments: Array<{
        controllerId: string;
        assessment: EconomicAssessment;
        matchedEnvelopeRef: EconomicRef;
        protocolRef: EconomicRef;
        independentEvaluatorRef: EconomicRef;
    }>;
    gates: Array<{
        controllerId: string;
        reach: 'PASS' | 'FAIL' | 'UNMEASURED';
        resource: 'PASS' | 'FAIL' | 'UNMEASURED';
        safety: 'PASS' | 'FAIL' | 'UNMEASURED';
        downsideUpper: string | null;
        decisionPayoffLower: string | null;
        evidenceRefs: EconomicRef[];
    }>;
    evidence: EconomicEvidenceResolution[];
}
export interface EconomicBenchmarkAssessment {
    schema: 'finnor.economic-benchmark-assessment.v1';
    registrationRef: EconomicRef;
    assessedAt: string;
    economic100x: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
    named10x: {
        Muse: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
        dots: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
    };
    strongestBaselineUpper: string | null;
    strongestBaselineLower: string | null;
    ratioInterval: EconomicInterval | null;
    comparisons: Array<{
        controllerId: string;
        role: EconomicControllerRole;
        status: 'QUALIFIED' | 'UNMEASURED' | 'UNQUALIFIED';
        interval: EconomicInterval | null;
        reasons: string[];
    }>;
    reasons: string[];
    capabilityDominance: 'SEPARATE_UNMEASURED';
    evidenceClass: EconomicEvidenceClass;
    claimGranted: boolean;
}
/** Ordinary ModelComputeFabric invocation; admission remains independent. */
export interface S7ModelComputeInvocation {
    schema: 'finnor.model-compute-invocation.v1';
    semanticOwner: 'S7';
    id: string;
    tenantId: string;
    principalId: string;
    rightsRef: string;
    inputRef: EconomicRef;
    outputRefs: string[];
    requestedRoute: 'LOCAL_EXACT_BOUNDED';
    actualRoute: 'LOCAL_EXACT_BOUNDED';
    fallbacks: [
    ];
    backend: {
        name: 'finnor-bigint-bounded-ht';
        version: string;
        sourceDigests: Array<{
            path: string;
            sha256: string;
        }>;
        identityBasis: 'LOADED_SOURCE_SNAPSHOT';
    };
    harness: {
        nodeVersion: string;
        platform: string;
        architecture: string;
        configuration: OutcomeEstimand['budgets'];
        deterministicReplayClaimed: false;
    };
    attempts: Array<{
        startedAt: string;
        finishedAt: string;
        status: 'COMPLETED';
    }>;
    randomness: {
        used: false;
        seed: null;
    };
    usage: {
        elapsedMs: number;
        processCpuUserMicros: number;
        processCpuSystemMicros: number;
        rssBeforeBytes: number;
        rssAfterBytes: number;
        accountingScope: 'PROCESS_INTERVAL_INCLUSIVE_NOT_ISOLATED_PEAK';
    };
    cost: {
        money: EconomicInterval | null;
        pricebookRef: EconomicRef | null;
        meteringRef: EconomicRef | null;
        status: 'LOCAL_COST_UNMETERED' | 'METERED_SOURCE_CONDITIONAL';
        sourceReadCalls: number;
    };
    admission: {
        status: 'BLOCKED_EXTERNAL';
        receipt: null;
    };
}
