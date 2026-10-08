// Generated from finnor-os/openapi.json, SHA-256 6efff3b8571482a29335a8f2f43210cbeaefd5d84bae063493548ce93da17b1c.
export interface paths {
    "/api/outcome-packs/control": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        packId: "deal_to_verified_closing_readiness" | "deal_request_resolution" | "critical_deal_dependency_resolution" | "general_operator_objective";
                        enabled: boolean;
                        reason: string;
                    };
                };
            };
            responses: {
                /** @description Owner recorded exact mission enablement; runtime authority remains enforced for every effect */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Only a human owner can change mission enablement */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/actions/human": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        idempotencyKey: string;
                        /** Format: uuid */
                        threadId?: string;
                        /** @constant */
                        actionType: "waive_closing_condition";
                        payload: {
                            /** Format: uuid */
                            dealId: string;
                            /** Format: uuid */
                            closingConditionId: string;
                            expectedVersion: number;
                            reason: string;
                        };
                    } | {
                        /** Format: uuid */
                        idempotencyKey: string;
                        /** Format: uuid */
                        threadId?: string;
                        /** @constant */
                        actionType: "verify_closing_item";
                        payload: {
                            /** Format: uuid */
                            dealId: string;
                            /** Format: uuid */
                            closingItemId: string;
                            expectedVersion: number;
                            /** Format: uuid */
                            verifierEmployeeId?: string;
                            verificationSource?: string;
                            /** Format: uuid */
                            documentId?: string;
                            /** Format: uuid */
                            evidenceSourceId?: string;
                            /** Format: uuid */
                            evidenceVersionId?: string;
                        };
                    };
                };
            };
            responses: {
                /** @description Same exact intake replayed without a second action */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact human-authored closing decision drafted in canonical Work and Thread, awaiting effect review */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Canonical human identity or verifier identity rejected */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Intake key belongs to a different decision */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Canonical grounding or authority rejects the decision */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/computer/runs/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": Record<string, never>;
                };
            };
            responses: {
                /** @description Durable cancellation requested for the exact computer run */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Actor cannot cancel this run */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/connections/{ref}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    ref: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Canonical provider connection status */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    ref: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Connection revoked by its owning security service */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/connections/{ref}/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    ref: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": Record<string, never>;
                };
            };
            responses: {
                /** @description Provider readback confirms a usable connection */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Provider connection is not usable */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/connections/google/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        authProfileRef: string;
                        /** Format: uri */
                        redirectUri?: string;
                    };
                };
            };
            responses: {
                /** @description PKCE authorization URL and HTTP-only state cookie issued */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Canonical auth profile or provider configuration is unavailable */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/reconciliation/{id}/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                        /** @enum {string} */
                        outcome: "happened_as_intended" | "definitely_did_not_happen" | "happened_differently" | "still_unknowable" | "legally_compensatable";
                        evidence: {
                            [key: string]: unknown;
                        };
                        reason: string;
                        provider?: string;
                        /** Format: uuid */
                        integrationId?: string;
                        controlKey?: string;
                    };
                };
            };
            responses: {
                /** @description Evidence-bearing resolution recorded by the canonical workflow owner */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/workflows/steps/{id}/compensate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                        reason: string;
                        controlKey?: string;
                    };
                };
            };
            responses: {
                /** @description Canonical compensation requested after legal-state and authority checks */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/reviewed-deck-link": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedCaseVersion: number;
                        /** Format: uuid */
                        documentId: string;
                        /** Format: uuid */
                        documentVersionId: string;
                    };
                };
            };
            responses: {
                /** @description Exact approved deck version linked and independently read back in its Deal-root IC case */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/push-subscriptions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uri */
                        endpoint: string;
                        keys: {
                            p256dh: string;
                            auth: string;
                        };
                    };
                };
            };
            responses: {
                /** @description Authenticated browser's actual Web Push subscription recorded */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uri */
                        endpoint: string;
                    };
                };
            };
            responses: {
                /** @description Own device subscription removed */
                204: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/operating-profile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Own employee profile and canonical tenant operating profile with owner editability */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        company?: {
                            industry: string | null;
                            niche: string | null;
                            description: string | null;
                            primaryGeographies: string[];
                            foundedYear: number | null;
                            idealCustomerProfile: {
                                [key: string]: unknown;
                            };
                            businessFacts: {
                                [key: string]: unknown;
                            };
                            comparisonDefaults: {
                                scaleMetric?: string;
                                performanceMetric?: string;
                            };
                        };
                        employee?: {
                            title: string | null;
                            profileFacts: {
                                [key: string]: unknown;
                            };
                        };
                    };
                };
            };
            responses: {
                /** @description Own employee or owner-authorized company profile saved */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Company profile edit requires owner authority */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/user-prefs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Authenticated employee preferences */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        homepage?: ("bridge" | "map" | "my-day") | null;
                        /** @enum {string} */
                        density?: "comfortable" | "compact";
                        pinnedPanels?: string[];
                        accent?: string | null;
                        soundEnabled?: boolean;
                        notificationPreferences?: {
                            [key: string]: boolean;
                        };
                        quietHoursStart?: string | null;
                        quietHoursEnd?: string | null;
                    };
                };
            };
            responses: {
                /** @description Own validated preferences saved */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        post?: never;
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Own preferences reset to canonical defaults */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/outcome-packs/grants": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Owner-visible tenant autonomy grants */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        packId: "deal_to_verified_closing_readiness" | "deal_request_resolution" | "critical_deal_dependency_resolution" | "general_operator_objective";
                        packVersion: number;
                        scope: {
                            effectClasses: ("internal_draft" | "internal_write" | "operational_change" | "financial_write" | "external_side_effect" | "external_spend" | "batch_external" | "durable_workflow")[];
                            resources: {
                                type: string;
                                ids?: string[];
                            }[];
                            principal: string;
                            providers: {
                                provider: string;
                                /** Format: uuid */
                                applicationAccountId?: string;
                            }[];
                            maxAmountUsd: number | null;
                            /** @enum {string} */
                            maxRisk: "low" | "medium" | "high";
                            /** Format: date-time */
                            validFrom: string;
                            /** Format: date-time */
                            expiresAt: string;
                            policyVersion: number | null;
                            authorityRevision: number;
                            certificationFingerprint: string;
                            /** Format: date-time */
                            reviewAfter: string;
                        };
                        reason: string;
                    };
                };
            };
            responses: {
                /** @description Human owner created the bounded autonomy grant */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/outcome-packs/grants/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Human owner revoked the exact autonomy grant */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/actions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Instruction accepted into governed Work */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/actions/pending": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Tenant-scoped pending action page */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/employees": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Tenant-scoped employee list */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Tenant-scoped business events */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/operational-deltas": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    cursor?: string;
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Bounded tenant-scoped operational delta page */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Invalid cursor or limit */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Cursor tenant scope mismatch */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/read-models/{view}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    view: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Named tenant-scoped read model */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/insights": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Tenant-scoped insights */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/setup/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Source-backed setup status */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Source-backed integration status */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/audit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Tenant-scoped audit records */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/receipts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Tenant-scoped decision receipts */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/receipts/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Exact decision receipt */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Authenticated employee context */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/dlq": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Tenant-scoped dead-letter page */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/dlq/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Exact dead-letter record */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/dlq/{id}/replay": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Authorized dead-letter replay requested */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/dlq/{id}/discard": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Authorized dead-letter discard recorded */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/corrections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Tenant-scoped corrections */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        receiptId: string;
                        correctedFact: string;
                    };
                };
            };
            responses: {
                /** @description Receipt-linked human correction recorded */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/vitals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Queue and runtime vitals */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/activity": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Tenant-scoped raw diagnostic activity */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            items: {
                                /** @enum {string} */
                                source: "action_log" | "workflow_step" | "computer_step" | "work_event" | "call";
                                /** Format: uuid */
                                id: string;
                                /** Format: date-time */
                                occurredAt: string;
                                detail: {
                                    [key: string]: unknown;
                                };
                            }[];
                            nextCursor: string | null;
                            hasMore: boolean;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/semantic-activity": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        root: {
                            /** @enum {string} */
                            entityType: "pe_strategy" | "pe_opportunity" | "pe_deal" | "pe_fund" | "pe_vehicle" | "external_organization" | "pe_portfolio_holding";
                            /** Format: uuid */
                            entityId: string;
                        };
                        /** Format: date-time */
                        asOf?: string;
                        limit?: number;
                    };
                };
            };
            responses: {
                /** @description Deterministic tenant-scoped PE semantic activity from P1-P7 canonical records */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description PE root absent from the authenticated tenant */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/{operation}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    operation: "belief-view" | "belief-pin" | "roots" | "projection" | "search" | "object" | "traverse" | "provenance" | "history" | "evidence-lineage" | "decision-lineage" | "available-actions" | "context" | "evidence-handles" | "evidence-submit" | "evidence-read" | "evidence-witness" | "evidence-replay" | "evidence-cancel" | "evidence-consume" | "program-submit" | "program-read" | "program-witness" | "program-module" | "program-projection" | "program-cancel" | "program-resume" | "program-artifact" | "program-ports" | "program-interface-module" | "compute-search-submit" | "compute-search-read" | "compute-search-projection" | "compute-search-cancel" | "compute-search-resume" | "compute-search-reconcile" | "interface-acquire" | "interface-read" | "interface-projection" | "interface-catalogue" | "interface-module" | "interface-cancel" | "interface-resume" | "interface-reconcile" | "interface-admission" | "interface-invoke" | "interface-ports" | "decision-slice-compile" | "decision-slice-read" | "decision-slice-context" | "decision-slice-patch" | "decision-slice-witness" | "decision-slice-consume" | "decision-slice-cancel" | "decision-slice-recompile" | "decision-slice-changes" | "decision-slice-view" | "continuation-submit" | "continuation-read" | "continuation-projection" | "procedure-experience" | "procedure-induce" | "procedure-induction-read" | "procedure-induction-cancel" | "procedure-read" | "procedure-component" | "procedure-counterexample" | "procedure-projection" | "procedure-admission-request" | "procedure-interface" | "procedure-costs" | "deliberation-submit" | "deliberation-read" | "deliberation-projection" | "deliberation-cancel" | "deliberation-resume" | "deliberation-reconcile" | "deliberation-calibrate" | "deliberation-evidence-read" | "deliberation-module-read";
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Tenant-scoped Company Brain operation. Owner request schemas and current authority are checked by each delegated handler. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Root or object absent from the authenticated tenant */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/digital-twin": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @constant */
                        operation: "create-fund";
                        /** Format: uuid */
                        id?: string;
                        name: string;
                        legalName?: string;
                        vintageYear?: number;
                        baseCurrency?: string;
                        /** @enum {string} */
                        status?: "forming" | "active" | "harvesting" | "liquidated";
                        /** Format: date-time */
                        validFrom?: string;
                        /** Format: date-time */
                        validTo?: string;
                    } | {
                        /** @constant */
                        operation: "transition-fund";
                        /** Format: uuid */
                        fundId: string;
                        expectedVersion: number;
                        /** @enum {string} */
                        to: "active" | "harvesting" | "liquidated";
                    } | {
                        /** @constant */
                        operation: "create-vehicle";
                        /** Format: uuid */
                        id?: string;
                        name: string;
                        legalName?: string;
                        /** @enum {string} */
                        vehicleType: "main" | "feeder" | "parallel" | "co_invest" | "blocker" | "continuation" | "other";
                        jurisdiction?: string;
                        /** @enum {string} */
                        status?: "forming" | "active" | "harvesting" | "liquidated";
                        /** Format: date-time */
                        validFrom?: string;
                        /** Format: date-time */
                        validTo?: string;
                    } | {
                        /** @constant */
                        operation: "transition-vehicle";
                        /** Format: uuid */
                        vehicleId: string;
                        expectedVersion: number;
                        /** @enum {string} */
                        to: "active" | "harvesting" | "liquidated";
                    } | {
                        /** @constant */
                        operation: "link-fund-vehicle";
                        /** Format: uuid */
                        id?: string;
                        /** Format: uuid */
                        fundId: string;
                        /** Format: uuid */
                        vehicleId: string;
                        /** @enum {string} */
                        relationshipKind: "master" | "feeder" | "parallel" | "co_invest" | "blocker" | "continuation" | "other";
                        /** Format: date-time */
                        validFrom: string;
                        /** Format: date-time */
                        validTo?: string;
                        evidence: {
                            /** Format: uuid */
                            evidenceSourceId: string;
                            /** Format: uuid */
                            evidenceVersionId: string;
                        };
                        /** @enum {string} */
                        completeness?: "complete" | "partial" | "unknown" | "conflicting" | "unavailable_before_history_baseline";
                    } | {
                        /** @constant */
                        operation: "link-strategy-mandate";
                        /** Format: uuid */
                        id?: string;
                        /** @enum {string} */
                        principalType: "pe_fund" | "pe_vehicle";
                        /** Format: uuid */
                        principalId: string;
                        /** Format: uuid */
                        strategyId: string;
                        /** Format: date-time */
                        validFrom: string;
                        /** Format: date-time */
                        validTo?: string;
                        evidence: {
                            /** Format: uuid */
                            evidenceSourceId: string;
                            /** Format: uuid */
                            evidenceVersionId: string;
                        };
                        /** @enum {string} */
                        completeness?: "complete" | "partial" | "unknown" | "conflicting" | "unavailable_before_history_baseline";
                    } | {
                        /** @constant */
                        operation: "create-portfolio-holding";
                        /** Format: uuid */
                        id?: string;
                        /** Format: uuid */
                        fundId?: string;
                        /** Format: uuid */
                        vehicleId?: string;
                        /** Format: uuid */
                        companyId: string;
                        /** Format: uuid */
                        originDealId: string;
                        entryDate: string;
                        evidence: {
                            /** Format: uuid */
                            evidenceSourceId: string;
                            /** Format: uuid */
                            evidenceVersionId: string;
                        };
                        /** @enum {string} */
                        completeness?: "complete" | "partial" | "unknown" | "conflicting" | "unavailable_before_history_baseline";
                    } | {
                        /** @constant */
                        operation: "record-company-hierarchy";
                        /** Format: uuid */
                        id?: string;
                        /** Format: uuid */
                        parentCompanyId: string;
                        /** Format: uuid */
                        childCompanyId: string;
                        /** @enum {string} */
                        relationshipKind: "parent_subsidiary" | "holding_operating";
                        /** Format: date-time */
                        validFrom: string;
                        /** Format: date-time */
                        validTo?: string;
                        evidence: {
                            /** Format: uuid */
                            evidenceSourceId: string;
                            /** Format: uuid */
                            evidenceVersionId: string;
                        };
                        /** @enum {string} */
                        completeness?: "complete" | "partial" | "unknown" | "conflicting" | "unavailable_before_history_baseline";
                    } | {
                        /** @constant */
                        operation: "record-company-party-role";
                        /** Format: uuid */
                        id?: string;
                        /** Format: uuid */
                        companyId: string;
                        /** @enum {string} */
                        partyType: "external_organization" | "external_contact";
                        /** Format: uuid */
                        partyId: string;
                        /** @enum {string} */
                        role: "sponsor" | "advisor";
                        roleDetail?: string;
                        /** Format: date-time */
                        validFrom: string;
                        /** Format: date-time */
                        validTo?: string;
                        evidence: {
                            /** Format: uuid */
                            evidenceSourceId: string;
                            /** Format: uuid */
                            evidenceVersionId: string;
                        };
                        /** @enum {string} */
                        completeness?: "complete" | "partial" | "unknown" | "conflicting" | "unavailable_before_history_baseline";
                    } | {
                        /** @constant */
                        operation: "create-security";
                        /** Format: uuid */
                        id?: string;
                        /** Format: uuid */
                        issuerCompanyId: string;
                        securityKey: string;
                        /** @enum {string} */
                        securityType: "common_equity" | "preferred_equity" | "convertible" | "option" | "warrant" | "other";
                        name: string;
                        currencyCode?: string;
                        seniority?: number;
                        /** Format: date-time */
                        validFrom: string;
                        /** Format: date-time */
                        validTo?: string;
                        evidence: {
                            /** Format: uuid */
                            evidenceSourceId: string;
                            /** Format: uuid */
                            evidenceVersionId: string;
                        };
                        /** @enum {string} */
                        completeness?: "complete" | "partial" | "unknown" | "conflicting" | "unavailable_before_history_baseline";
                    } | {
                        /** @constant */
                        operation: "create-debt-facility";
                        /** Format: uuid */
                        id?: string;
                        /** Format: uuid */
                        borrowerCompanyId: string;
                        facilityKey: string;
                        name: string;
                        /** @enum {string} */
                        facilityType: "revolver" | "term_loan" | "delayed_draw" | "mezzanine" | "unitranche" | "notes" | "other";
                        committedAmount?: string;
                        currencyCode?: string;
                        maturityDate?: string;
                        /** @enum {string} */
                        status?: "committed" | "active" | "repaid" | "cancelled" | "defaulted";
                        /** Format: date-time */
                        validFrom: string;
                        /** Format: date-time */
                        validTo?: string;
                        evidence: {
                            /** Format: uuid */
                            evidenceSourceId: string;
                            /** Format: uuid */
                            evidenceVersionId: string;
                        };
                        /** @enum {string} */
                        completeness?: "complete" | "partial" | "unknown" | "conflicting" | "unavailable_before_history_baseline";
                    } | {
                        /** @constant */
                        operation: "link-debt-facility-lender";
                        /** Format: uuid */
                        id?: string;
                        /** Format: uuid */
                        debtFacilityId: string;
                        /** @enum {string} */
                        lenderPartyType: "external_organization" | "external_contact";
                        /** Format: uuid */
                        lenderPartyId: string;
                        /** @enum {string} */
                        lenderRole: "agent" | "arranger" | "lender" | "administrative_agent" | "other";
                        commitmentAmount?: string;
                        currencyCode?: string;
                        /** Format: date-time */
                        validFrom: string;
                        /** Format: date-time */
                        validTo?: string;
                        evidence: {
                            /** Format: uuid */
                            evidenceSourceId: string;
                            /** Format: uuid */
                            evidenceVersionId: string;
                        };
                        /** @enum {string} */
                        completeness?: "complete" | "partial" | "unknown" | "conflicting" | "unavailable_before_history_baseline";
                    } | {
                        /** @constant */
                        operation: "record-ownership";
                        /** Format: uuid */
                        id?: string;
                        /** @enum {string} */
                        ownerType: "pe_fund" | "pe_vehicle" | "external_organization";
                        /** Format: uuid */
                        ownerId: string;
                        /** @enum {string} */
                        subjectType: "external_organization" | "pe_security";
                        /** Format: uuid */
                        subjectId: string;
                        economicPercentage?: string;
                        votingPercentage?: string;
                        amount?: string;
                        currencyCode?: string;
                        ownershipClass?: string;
                        /** Format: date-time */
                        validFrom: string;
                        /** Format: date-time */
                        validTo?: string;
                        evidence: {
                            /** Format: uuid */
                            evidenceSourceId: string;
                            /** Format: uuid */
                            evidenceVersionId: string;
                        };
                        /** @enum {string} */
                        completeness?: "complete" | "partial" | "unknown" | "conflicting" | "unavailable_before_history_baseline";
                    } | {
                        /** @constant */
                        operation: "revise-ownership";
                        /** Format: uuid */
                        priorInterestId: string;
                        expectedVersion: number;
                        /** Format: date-time */
                        validFrom: string;
                        replacement: {
                            /** @enum {string} */
                            ownerType: "pe_fund" | "pe_vehicle" | "external_organization";
                            /** Format: uuid */
                            ownerId: string;
                            /** @enum {string} */
                            subjectType: "external_organization" | "pe_security";
                            /** Format: uuid */
                            subjectId: string;
                            economicPercentage?: string;
                            votingPercentage?: string;
                            amount?: string;
                            currencyCode?: string;
                            ownershipClass?: string;
                            /** Format: date-time */
                            validTo?: string;
                            evidence: {
                                /** Format: uuid */
                                evidenceSourceId: string;
                                /** Format: uuid */
                                evidenceVersionId: string;
                            };
                            /** @enum {string} */
                            completeness?: "complete" | "partial" | "unknown" | "conflicting" | "unavailable_before_history_baseline";
                            /** Format: uuid */
                            id?: string;
                        };
                    } | {
                        /** @constant */
                        operation: "create-benchmark";
                        /** Format: uuid */
                        id?: string;
                        benchmarkKey: string;
                        name: string;
                        metricKey: string;
                        unit: string;
                        currencyCode?: string;
                        cohortDefinition?: {
                            [key: string]: unknown;
                        };
                    } | {
                        /** @constant */
                        operation: "create-metric-series";
                        /** Format: uuid */
                        id?: string;
                        /** @enum {string} */
                        subjectType: "external_organization" | "pe_portfolio_holding";
                        /** Format: uuid */
                        subjectId: string;
                        metricKey: string;
                        name: string;
                        unit: string;
                        currencyCode?: string;
                        /** @enum {string} */
                        frequency: "instant" | "daily" | "weekly" | "monthly" | "quarterly" | "annual" | "event";
                        /** Format: uuid */
                        benchmarkId?: string;
                    } | {
                        /** @constant */
                        operation: "record-metric-observation";
                        /** Format: uuid */
                        id?: string;
                        /** Format: uuid */
                        metricSeriesId: string;
                        /** Format: date-time */
                        periodStart: string;
                        /** Format: date-time */
                        periodEnd: string;
                        value: {
                            /** @constant */
                            type: "number";
                            value: string;
                        } | {
                            /** @constant */
                            type: "text";
                            value: string;
                        } | {
                            /** @constant */
                            type: "boolean";
                            value: boolean;
                        };
                        evidence: {
                            /** Format: uuid */
                            evidenceSourceId: string;
                            /** Format: uuid */
                            evidenceVersionId: string;
                        };
                    } | {
                        /** @constant */
                        operation: "restate-metric-observation";
                        /** Format: uuid */
                        priorObservationId: string;
                        expectedVersion: number;
                        replacement: {
                            /** Format: uuid */
                            id?: string;
                            value: {
                                /** @constant */
                                type: "number";
                                value: string;
                            } | {
                                /** @constant */
                                type: "text";
                                value: string;
                            } | {
                                /** @constant */
                                type: "boolean";
                                value: boolean;
                            };
                            evidence: {
                                /** Format: uuid */
                                evidenceSourceId: string;
                                /** Format: uuid */
                                evidenceVersionId: string;
                            };
                        };
                    } | {
                        /** @constant */
                        operation: "record-benchmark-observation";
                        /** Format: uuid */
                        id?: string;
                        /** Format: uuid */
                        benchmarkId: string;
                        /** Format: date-time */
                        periodStart: string;
                        /** Format: date-time */
                        periodEnd: string;
                        value: string;
                        evidence: {
                            /** Format: uuid */
                            evidenceSourceId: string;
                            /** Format: uuid */
                            evidenceVersionId: string;
                        };
                    } | {
                        /** @constant */
                        operation: "restate-benchmark-observation";
                        /** Format: uuid */
                        priorObservationId: string;
                        expectedVersion: number;
                        /** Format: uuid */
                        id?: string;
                        value: string;
                        evidence: {
                            /** Format: uuid */
                            evidenceSourceId: string;
                            /** Format: uuid */
                            evidenceVersionId: string;
                        };
                    } | {
                        /** @constant */
                        operation: "record-outcome";
                        /** Format: uuid */
                        id?: string;
                        /** @enum {string} */
                        subjectType: "external_organization" | "pe_portfolio_holding";
                        /** Format: uuid */
                        subjectId: string;
                        /** Format: uuid */
                        decisionId?: string;
                        outcomeType: string;
                        description: string;
                        observedValue?: {
                            [key: string]: unknown;
                        };
                        /** Format: date-time */
                        observedAt: string;
                        /** Format: date-time */
                        validFrom: string;
                        /** Format: date-time */
                        validTo?: string;
                        evidence: {
                            /** Format: uuid */
                            evidenceSourceId: string;
                            /** Format: uuid */
                            evidenceVersionId: string;
                        };
                    } | {
                        /** @constant */
                        operation: "record-exit";
                        /** Format: uuid */
                        id?: string;
                        /** Format: uuid */
                        portfolioHoldingId: string;
                        expectedHoldingVersion: number;
                        /** @enum {string} */
                        exitType: "strategic_sale" | "sponsor_sale" | "ipo" | "recapitalization" | "write_off" | "other";
                        /** Format: uuid */
                        buyerCompanyId?: string;
                        /** @enum {string} */
                        status: "announced" | "signed" | "closed" | "cancelled";
                        /** Format: date-time */
                        announcedAt?: string;
                        /** Format: date-time */
                        signedAt?: string;
                        /** Format: date-time */
                        closedAt?: string;
                        /** Format: date-time */
                        cancelledAt?: string;
                        grossProceeds?: string;
                        currencyCode?: string;
                        /** Format: date-time */
                        observedAt: string;
                        evidence: {
                            /** Format: uuid */
                            evidenceSourceId: string;
                            /** Format: uuid */
                            evidenceVersionId: string;
                        };
                    } | {
                        /** @constant */
                        operation: "record-fact-coverage";
                        /** Format: uuid */
                        id?: string;
                        /** @enum {string} */
                        subjectType: "external_organization" | "pe_fund" | "pe_vehicle" | "pe_portfolio_holding";
                        /** Format: uuid */
                        subjectId: string;
                        /** @enum {string} */
                        proposition: "company_ownership" | "company_debt" | "company_parent" | "portfolio_membership" | "ownership_total";
                        /** @enum {string} */
                        coverageStatus: "complete" | "partial" | "unknown" | "conflicting" | "unavailable_before_history_baseline";
                        /** Format: date-time */
                        validFrom: string;
                        /** Format: date-time */
                        validTo?: string;
                        evidence: {
                            /** Format: uuid */
                            evidenceSourceId: string;
                            /** Format: uuid */
                            evidenceVersionId: string;
                        };
                    } | {
                        /** @constant */
                        operation: "revise-fact-coverage";
                        /** Format: uuid */
                        priorCoverageId: string;
                        expectedVersion: number;
                        /** @enum {string} */
                        coverageStatus: "complete" | "partial" | "unknown" | "conflicting" | "unavailable_before_history_baseline";
                        evidence: {
                            /** Format: uuid */
                            evidenceSourceId: string;
                            /** Format: uuid */
                            evidenceVersionId: string;
                        };
                    } | {
                        /** @constant */
                        operation: "record-identity-resolution";
                        decisionId: string;
                        /** Format: uuid */
                        sourceLinkId: string;
                        expectedObservedHash: string | null;
                        /** @enum {string} */
                        kind: "merge" | "split" | "correction";
                        fromRefs: {
                            entityType: string;
                            /** Format: uuid */
                            entityId: string;
                        }[];
                        toRefs: {
                            entityType: string;
                            /** Format: uuid */
                            entityId: string;
                        }[];
                        decision: string;
                        /** Format: date-time */
                        validFrom?: string;
                        /** Format: date-time */
                        validTo?: string;
                        authority: {
                            [key: string]: unknown;
                        };
                        evidence: {
                            /** Format: uuid */
                            evidenceSourceId: string;
                            /** Format: uuid */
                            evidenceVersionId: string;
                        };
                        /** Format: date-time */
                        observedAt?: string;
                    } | {
                        /** @constant */
                        operation: "resolve-identity-as-known";
                        /** Format: uuid */
                        sourceLinkId: string;
                        /** Format: date-time */
                        validAt: string;
                        /** Format: date-time */
                        knowledgeAt: string;
                    } | {
                        /** @constant */
                        operation: "closed-world-claim";
                        /** @enum {string} */
                        subjectType: "external_organization" | "pe_fund" | "pe_vehicle" | "pe_portfolio_holding";
                        /** Format: uuid */
                        subjectId: string;
                        /** @enum {string} */
                        proposition: "company_ownership" | "company_debt" | "company_parent" | "portfolio_membership" | "ownership_total";
                        /** Format: date-time */
                        validAt: string;
                        /** Format: date-time */
                        knowledgeAt?: string;
                    };
                };
            };
            responses: {
                /** @description Tenant-scoped PE Digital Twin query or transition */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Evidence-backed canonical PE fact, identity, observation, or exact relation created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Canonical reference absent from the authenticated tenant */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Expected version or concurrent canonical truth conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Canonical invariant rejected the requested fact */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/workflows/runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Tenant-scoped workflow runs */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/workflows/runs/{id}/pause": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                    };
                };
            };
            responses: {
                /** @description Authorized workflow pause */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/workflows/runs/{id}/resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                    };
                };
            };
            responses: {
                /** @description Authorized workflow resume */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/workflows/runs/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                    };
                };
            };
            responses: {
                /** @description Authorized workflow cancellation */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/workflows/runs/{id}/retry": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                    };
                };
            };
            responses: {
                /** @description Authorized workflow retry */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/workflows/runs/{id}/escalate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                    };
                };
            };
            responses: {
                /** @description Authorized workflow escalation */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/instructions/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Exact instruction lifecycle */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/instructions/{id}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Exact instruction event stream page */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/stream": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query: {
                    instructionId: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description EventSource stream for one instruction lifecycle */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description instructionId is missing */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Bad auth */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Instruction not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/works/{id}/execution": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Exact Work execution projection */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/works/{id}/replay": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Exact Work causal replay */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/works/{id}/objective": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Exact Work objective state */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Objective control recorded */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/committee-configurations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        committeeOrgUnitId: string;
                        /** Format: uuid */
                        policyRevisionId: string;
                        members: {
                            /** Format: uuid */
                            employeeId: string;
                            memberRole: string;
                            votingEligible?: boolean;
                            chair?: boolean;
                            /** Format: date-time */
                            effectiveFrom: string;
                            /** Format: date-time */
                            effectiveUntil?: string;
                        }[];
                        idempotencyKey: string;
                    };
                };
            };
            responses: {
                /** @description Immutable committee membership and Core policy revision snapshot created */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Bounded tenant-scoped IC Case list with exact P1, P3, P4, Recommendation, and Decision references */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        dealId: string;
                        /** Format: uuid */
                        investmentCaseId: string;
                        /** Format: uuid */
                        committeeConfigVersionId: string;
                        /** Format: uuid */
                        scheduledInternalEventId?: string;
                        /** Format: uuid */
                        primaryUnderwritingRunId?: string;
                        /** Format: uuid */
                        reconsidersDecisionId?: string;
                        /** Format: uuid */
                        workId?: string;
                        idempotencyKey: string;
                    };
                };
            };
            responses: {
                /** @description ICCase opened against one exact P1 InvestmentCase and committee configuration */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    asOf?: string;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description One deterministic no-hindsight IC aggregate read model */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description ICCase absent in this tenant or at the requested time */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/decision-proof": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Canonical P1 Decision, immutable DecisionProposal, Core Authority decision, and Core DecisionReceipt proof */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/begin-preparation": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                    };
                };
            };
            responses: {
                /** @description ICCase entered PREPARING */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/ready-for-review": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                    };
                };
            };
            responses: {
                /** @description ICCase entered READY_FOR_REVIEW */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/open-questions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                    };
                };
            };
            responses: {
                /** @description ICCase entered QUESTIONS_OPEN */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/ready-for-vote": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                    };
                };
            };
            responses: {
                /** @description ICCase entered READY_FOR_VOTE after deterministic prerequisites */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/withdraw": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedVersion: number;
                    };
                };
            };
            responses: {
                /** @description ICCase entered terminal WITHDRAWN */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/memos": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedCaseVersion: number;
                        /** @enum {string} */
                        artifactRole: "MEMO" | "DECK";
                        /** Format: uuid */
                        documentId: string;
                        /** Format: uuid */
                        documentVersionId: string;
                        /** Format: uuid */
                        underwritingRunId?: string;
                        /** Format: date-time */
                        evidenceCutoffAt: string;
                        /** @enum {string} */
                        sourceCompleteness: "COMPLETE" | "INCOMPLETE" | "CONFLICTING" | "UNKNOWN";
                        /** @enum {string} */
                        changeClassification?: "INITIAL" | "MATERIAL" | "NON_MATERIAL" | "MANUAL_REVIEW_REQUIRED";
                        semanticChecks?: {
                            [key: string]: unknown;
                        };
                        idempotencyKey: string;
                    };
                };
            };
            responses: {
                /** @description Exact P3 Memo or Deck DocumentVersion revision selected */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/underwriting-run": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedCaseVersion: number;
                        /** Format: uuid */
                        underwritingRunId: string;
                    };
                };
            };
            responses: {
                /** @description Exact immutable P4 UnderwritingRun selected as the primary run */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/questions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedCaseVersion: number;
                        question: string;
                        /** @enum {string} */
                        priority?: "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
                        requiredBeforeVote?: boolean;
                        requiredBeforeDecision?: boolean;
                        /** Format: uuid */
                        workId?: string;
                        idempotencyKey: string;
                    };
                };
            };
            responses: {
                /** @description First-class IC Question opened, optionally linked to Core Work */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/questions/{questionId}/sources": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    questionId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedQuestionVersion: number;
                        link: {
                            source: {
                                /** @constant */
                                kind: "EVIDENCE_VERSION";
                                /** Format: uuid */
                                evidenceVersionId: string;
                            } | {
                                /** @constant */
                                kind: "ARTIFACT_ANCHOR";
                                /** Format: uuid */
                                documentId: string;
                                /** Format: uuid */
                                documentVersionId: string;
                                anchorId: string;
                                anchorHash: string;
                            } | {
                                /** @constant */
                                kind: "UNDERWRITING_RUN";
                                /** Format: uuid */
                                underwritingRunId: string;
                            } | {
                                /** @constant */
                                kind: "P1_WORLD";
                                /** @enum {string} */
                                entityType: "pe_strategy" | "pe_opportunity" | "pe_deal" | "pe_investment_case" | "pe_thesis" | "pe_assumption" | "pe_decision" | "pe_deal_party" | "pe_workstream" | "pe_request" | "pe_deliverable" | "pe_finding" | "pe_deal_risk" | "pe_dependency" | "pe_milestone" | "pe_closing_condition" | "pe_closing_item" | "pe_document_link" | "pe_evidence_link" | "pe_finding_risk_link" | "pe_ic_case" | "pe_ic_memo" | "pe_ic_question" | "pe_ic_recommendation" | "pe_ic_vote" | "pe_ic_dissent" | "pe_ic_condition" | "pe_ic_decision_proposal" | "pe_fund" | "pe_vehicle" | "pe_fund_vehicle_link" | "pe_strategy_mandate" | "pe_portfolio_holding" | "pe_company_hierarchy" | "pe_company_party_role" | "pe_security" | "pe_debt_facility" | "pe_debt_facility_lender" | "pe_ownership_interest" | "pe_metric_series" | "pe_metric_observation" | "pe_benchmark" | "pe_benchmark_observation" | "pe_outcome" | "pe_exit" | "pe_fact_coverage";
                                /** Format: uuid */
                                entityId: string;
                            } | {
                                /** @constant */
                                kind: "IC_QUESTION";
                                /** Format: uuid */
                                questionId: string;
                            } | {
                                /** @constant */
                                kind: "PE_RISK";
                                /** Format: uuid */
                                riskId: string;
                            } | {
                                /** @constant */
                                kind: "IC_CONDITION";
                                /** Format: uuid */
                                conditionId: string;
                            };
                            /** @enum {string} */
                            relationship: "SUPPORTS" | "CONTRADICTS" | "ANSWERS" | "VERIFIES" | "REQUIRES" | "REFERENCES";
                            /** @enum {string} */
                            truthStatus?: "ATTACHED" | "CONFLICTING" | "STALE" | "UNKNOWN";
                            idempotencyKey: string;
                        };
                    };
                };
            };
            responses: {
                /** @description Exact Evidence, P3 anchor, P4 Run, or canonical source attached to the Question */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/questions/{questionId}/answer": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    questionId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedQuestionVersion: number;
                        answer: string;
                    };
                };
            };
            responses: {
                /** @description Authenticated employee answer recorded without implying resolution */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/questions/{questionId}/resolve": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    questionId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedQuestionVersion: number;
                    };
                };
            };
            responses: {
                /** @description Answered Question deterministically resolved */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/questions/{questionId}/waive": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    questionId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedQuestionVersion: number;
                        reason: string;
                        idempotencyKey: string;
                    };
                };
            };
            responses: {
                /** @description Question waived under pinned policy, Core Authority, and Core DecisionReceipt */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/questions/{questionId}/supersede": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    questionId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedQuestionVersion: number;
                    };
                };
            };
            responses: {
                /** @description Question explicitly superseded without rewriting its immutable history */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/recommendations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedCaseVersion: number;
                        /** @enum {string} */
                        outcome: "INVEST" | "DECLINE" | "DEFER" | "INVEST_WITH_CONDITIONS" | "CONTINUE_DILIGENCE";
                        rationale: string;
                        /** Format: uuid */
                        memoId?: string;
                        /** Format: uuid */
                        underwritingRunId?: string;
                        sources?: {
                            source: {
                                /** @constant */
                                kind: "EVIDENCE_VERSION";
                                /** Format: uuid */
                                evidenceVersionId: string;
                            } | {
                                /** @constant */
                                kind: "ARTIFACT_ANCHOR";
                                /** Format: uuid */
                                documentId: string;
                                /** Format: uuid */
                                documentVersionId: string;
                                anchorId: string;
                                anchorHash: string;
                            } | {
                                /** @constant */
                                kind: "UNDERWRITING_RUN";
                                /** Format: uuid */
                                underwritingRunId: string;
                            } | {
                                /** @constant */
                                kind: "P1_WORLD";
                                /** @enum {string} */
                                entityType: "pe_strategy" | "pe_opportunity" | "pe_deal" | "pe_investment_case" | "pe_thesis" | "pe_assumption" | "pe_decision" | "pe_deal_party" | "pe_workstream" | "pe_request" | "pe_deliverable" | "pe_finding" | "pe_deal_risk" | "pe_dependency" | "pe_milestone" | "pe_closing_condition" | "pe_closing_item" | "pe_document_link" | "pe_evidence_link" | "pe_finding_risk_link" | "pe_ic_case" | "pe_ic_memo" | "pe_ic_question" | "pe_ic_recommendation" | "pe_ic_vote" | "pe_ic_dissent" | "pe_ic_condition" | "pe_ic_decision_proposal" | "pe_fund" | "pe_vehicle" | "pe_fund_vehicle_link" | "pe_strategy_mandate" | "pe_portfolio_holding" | "pe_company_hierarchy" | "pe_company_party_role" | "pe_security" | "pe_debt_facility" | "pe_debt_facility_lender" | "pe_ownership_interest" | "pe_metric_series" | "pe_metric_observation" | "pe_benchmark" | "pe_benchmark_observation" | "pe_outcome" | "pe_exit" | "pe_fact_coverage";
                                /** Format: uuid */
                                entityId: string;
                            } | {
                                /** @constant */
                                kind: "IC_QUESTION";
                                /** Format: uuid */
                                questionId: string;
                            } | {
                                /** @constant */
                                kind: "PE_RISK";
                                /** Format: uuid */
                                riskId: string;
                            } | {
                                /** @constant */
                                kind: "IC_CONDITION";
                                /** Format: uuid */
                                conditionId: string;
                            };
                            /** @enum {string} */
                            relationship: "SUPPORTS" | "CONTRADICTS" | "ANSWERS" | "VERIFIES" | "REQUIRES" | "REFERENCES";
                            /** @enum {string} */
                            truthStatus?: "ATTACHED" | "CONFLICTING" | "STALE" | "UNKNOWN";
                            idempotencyKey: string;
                        }[];
                        idempotencyKey: string;
                    };
                };
            };
            responses: {
                /** @description Immutable Recommendation revision pinned to exact Memo and P4 Run */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/voting/open": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedCaseVersion: number;
                        /** Format: uuid */
                        recommendationId: string;
                        /** Format: uuid */
                        memoId: string;
                        /** Format: uuid */
                        underwritingRunId: string;
                        idempotencyKey: string;
                    };
                };
            };
            responses: {
                /** @description Voting opened on one immutable basis under Core Authority */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/votes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        recommendationId: string;
                        /** Format: uuid */
                        memoId: string;
                        /** Format: uuid */
                        underwritingRunId: string;
                        expectedVotingBasisVersion: number;
                        /** @enum {string} */
                        choice: "APPROVE" | "REJECT" | "ABSTAIN" | "DEFER";
                        rationale?: string;
                        idempotencyKey: string;
                    };
                };
            };
            responses: {
                /** @description Authenticated member's one immutable effective Vote recorded; voter identity is never accepted in the body */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/dissents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        voteId: string;
                        rationale: string;
                        sources?: {
                            source: {
                                /** @constant */
                                kind: "EVIDENCE_VERSION";
                                /** Format: uuid */
                                evidenceVersionId: string;
                            } | {
                                /** @constant */
                                kind: "ARTIFACT_ANCHOR";
                                /** Format: uuid */
                                documentId: string;
                                /** Format: uuid */
                                documentVersionId: string;
                                anchorId: string;
                                anchorHash: string;
                            } | {
                                /** @constant */
                                kind: "UNDERWRITING_RUN";
                                /** Format: uuid */
                                underwritingRunId: string;
                            } | {
                                /** @constant */
                                kind: "P1_WORLD";
                                /** @enum {string} */
                                entityType: "pe_strategy" | "pe_opportunity" | "pe_deal" | "pe_investment_case" | "pe_thesis" | "pe_assumption" | "pe_decision" | "pe_deal_party" | "pe_workstream" | "pe_request" | "pe_deliverable" | "pe_finding" | "pe_deal_risk" | "pe_dependency" | "pe_milestone" | "pe_closing_condition" | "pe_closing_item" | "pe_document_link" | "pe_evidence_link" | "pe_finding_risk_link" | "pe_ic_case" | "pe_ic_memo" | "pe_ic_question" | "pe_ic_recommendation" | "pe_ic_vote" | "pe_ic_dissent" | "pe_ic_condition" | "pe_ic_decision_proposal" | "pe_fund" | "pe_vehicle" | "pe_fund_vehicle_link" | "pe_strategy_mandate" | "pe_portfolio_holding" | "pe_company_hierarchy" | "pe_company_party_role" | "pe_security" | "pe_debt_facility" | "pe_debt_facility_lender" | "pe_ownership_interest" | "pe_metric_series" | "pe_metric_observation" | "pe_benchmark" | "pe_benchmark_observation" | "pe_outcome" | "pe_exit" | "pe_fact_coverage";
                                /** Format: uuid */
                                entityId: string;
                            } | {
                                /** @constant */
                                kind: "IC_QUESTION";
                                /** Format: uuid */
                                questionId: string;
                            } | {
                                /** @constant */
                                kind: "PE_RISK";
                                /** Format: uuid */
                                riskId: string;
                            } | {
                                /** @constant */
                                kind: "IC_CONDITION";
                                /** Format: uuid */
                                conditionId: string;
                            };
                            /** @enum {string} */
                            relationship: "SUPPORTS" | "CONTRADICTS" | "ANSWERS" | "VERIFIES" | "REQUIRES" | "REFERENCES";
                            /** @enum {string} */
                            truthStatus?: "ATTACHED" | "CONFLICTING" | "STALE" | "UNKNOWN";
                            idempotencyKey: string;
                        }[];
                        idempotencyKey: string;
                    };
                };
            };
            responses: {
                /** @description Authenticated member's first-class Dissent attached to their own Vote */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/conditions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedCaseVersion: number;
                        /** Format: uuid */
                        sourceRecommendationId?: string;
                        /** @enum {string} */
                        conditionType: "PRE_DECISION" | "POST_DECISION_PRE_SIGNING" | "PRE_CLOSING" | "MONITORING";
                        title: string;
                        description: string;
                        /** Format: uuid */
                        ownerEmployeeId: string;
                        /** Format: uuid */
                        workId?: string;
                        /** Format: date-time */
                        dueAt?: string;
                        required?: boolean;
                        evidenceRequired?: boolean;
                        idempotencyKey: string;
                    };
                };
            };
            responses: {
                /** @description Governed IC Condition created; it is not a P1 closing condition */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/conditions/{conditionId}/activate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    conditionId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedConditionVersion: number;
                    };
                };
            };
            responses: {
                /** @description IC Condition activated */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/conditions/{conditionId}/satisfy": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    conditionId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedConditionVersion: number;
                        verification: {
                            source: {
                                /** @constant */
                                kind: "EVIDENCE_VERSION";
                                /** Format: uuid */
                                evidenceVersionId: string;
                            } | {
                                /** @constant */
                                kind: "ARTIFACT_ANCHOR";
                                /** Format: uuid */
                                documentId: string;
                                /** Format: uuid */
                                documentVersionId: string;
                                anchorId: string;
                                anchorHash: string;
                            } | {
                                /** @constant */
                                kind: "UNDERWRITING_RUN";
                                /** Format: uuid */
                                underwritingRunId: string;
                            } | {
                                /** @constant */
                                kind: "P1_WORLD";
                                /** @enum {string} */
                                entityType: "pe_strategy" | "pe_opportunity" | "pe_deal" | "pe_investment_case" | "pe_thesis" | "pe_assumption" | "pe_decision" | "pe_deal_party" | "pe_workstream" | "pe_request" | "pe_deliverable" | "pe_finding" | "pe_deal_risk" | "pe_dependency" | "pe_milestone" | "pe_closing_condition" | "pe_closing_item" | "pe_document_link" | "pe_evidence_link" | "pe_finding_risk_link" | "pe_ic_case" | "pe_ic_memo" | "pe_ic_question" | "pe_ic_recommendation" | "pe_ic_vote" | "pe_ic_dissent" | "pe_ic_condition" | "pe_ic_decision_proposal" | "pe_fund" | "pe_vehicle" | "pe_fund_vehicle_link" | "pe_strategy_mandate" | "pe_portfolio_holding" | "pe_company_hierarchy" | "pe_company_party_role" | "pe_security" | "pe_debt_facility" | "pe_debt_facility_lender" | "pe_ownership_interest" | "pe_metric_series" | "pe_metric_observation" | "pe_benchmark" | "pe_benchmark_observation" | "pe_outcome" | "pe_exit" | "pe_fact_coverage";
                                /** Format: uuid */
                                entityId: string;
                            } | {
                                /** @constant */
                                kind: "IC_QUESTION";
                                /** Format: uuid */
                                questionId: string;
                            } | {
                                /** @constant */
                                kind: "PE_RISK";
                                /** Format: uuid */
                                riskId: string;
                            } | {
                                /** @constant */
                                kind: "IC_CONDITION";
                                /** Format: uuid */
                                conditionId: string;
                            };
                            /** @enum {string} */
                            relationship: "SUPPORTS" | "CONTRADICTS" | "ANSWERS" | "VERIFIES" | "REQUIRES" | "REFERENCES";
                            /** @enum {string} */
                            truthStatus?: "ATTACHED" | "CONFLICTING" | "STALE" | "UNKNOWN";
                            idempotencyKey: string;
                        };
                    };
                };
            };
            responses: {
                /** @description IC Condition satisfied only with an exact verification source */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/conditions/{conditionId}/waive": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    conditionId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedConditionVersion: number;
                        reason: string;
                        idempotencyKey: string;
                    };
                };
            };
            responses: {
                /** @description IC Condition waived under pinned policy, Core Authority, and Core DecisionReceipt */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/conditions/{conditionId}/fail": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    conditionId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedConditionVersion: number;
                    };
                };
            };
            responses: {
                /** @description IC Condition explicitly failed without rewriting its prior states */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/conditions/{conditionId}/supersede": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    conditionId: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedConditionVersion: number;
                    };
                };
            };
            responses: {
                /** @description IC Condition explicitly superseded without becoming a P1 closing condition */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/decision-proposals": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedCaseVersion: number;
                        expectedVoteSetVersion: number;
                        idempotencyKey: string;
                    };
                };
            };
            responses: {
                /** @description Deterministic immutable DecisionProposal prepared from the exact vote set */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/voting/close": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        expectedCaseVersion: number;
                        expectedVoteSetVersion: number;
                        idempotencyKey: string;
                    };
                };
            };
            responses: {
                /** @description Voting atomically closed and exact DecisionProposal frozen under Core Authority */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/private-equity/ic/cases/{id}/finalize": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        decisionProposalId: string;
                        expectedCaseVersion: number;
                        title: string;
                        rationale: string;
                        idempotencyKey: string;
                    };
                };
            };
            responses: {
                /** @description P1 owner finalized the sole canonical investment Decision from exact IC proof */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict request schema rejected unknown or invalid input */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks the required Core Authority capability */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Version, identity, or idempotency precondition conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Pinned IC policy or lifecycle prerequisite blocks the transition */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/investment-cases": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Tenant-scoped P1 InvestmentCases with P4 model/run counts */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/investment-cases/{id}/underwriting": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Truthful Underwriting Workspace projection for one exact P1 InvestmentCase */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description InvestmentCase not found in the authenticated tenant */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/underwriting/models": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        investmentCaseId: string;
                        modelKey: string;
                        name: string;
                    };
                };
            };
            responses: {
                /** @description Logical deterministic model attached to the canonical P1 InvestmentCase */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/underwriting/models/{id}/versions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        definition: {
                            /** @constant */
                            schemaVersion: "underwriting-model-ir.v1";
                            modelKey: string;
                            modelVersion: string;
                            financialConventionVersion: string;
                            minimumEngineVersion: string;
                            periodDefinition: {
                                /** @enum {string} */
                                frequency: "annual" | "quarterly" | "monthly";
                                forecastStart: string;
                                count: number;
                                fiscalYearStartMonth?: number;
                            };
                            nodes: ({
                                id: string;
                                /** @enum {string} */
                                kind: "input" | "constant" | "expression" | "series" | "schedule" | "aggregate" | "check" | "output";
                                /** @enum {string} */
                                valueType: "decimal" | "date" | "boolean" | "text";
                                /** @enum {string} */
                                unit: "money" | "rate" | "multiple" | "ratio" | "count" | "date" | "period" | "boolean" | "text";
                                currency?: string;
                                /** @enum {string} */
                                shape: "scalar" | "series";
                                dependencies: string[];
                                source?: {
                                    /** @enum {string} */
                                    kind: "p1_assumption" | "evidence_version" | "artifact_anchor" | "explicit" | "model_parameter";
                                    /** Format: uuid */
                                    assumptionId?: string;
                                    /** Format: uuid */
                                    evidenceVersionId?: string;
                                    /** Format: uuid */
                                    documentId?: string;
                                    /** Format: uuid */
                                    documentVersionId?: string;
                                    anchorId?: string;
                                    anchorHash?: string;
                                    valuePath?: string;
                                    valueSelector?: string;
                                    staleAfterDays?: number;
                                };
                            } & {
                                [key: string]: unknown;
                            })[];
                            circularBlocks: {
                                id: string;
                                nodeIds: string[];
                                iterationOrder: string[];
                                settings: {
                                    /** @constant */
                                    algorithm: "fixed_point";
                                    /** @enum {string} */
                                    initialState: "opening_balance" | "zero";
                                    absoluteTolerance: string;
                                    relativeTolerance: string;
                                    maxIterations: number;
                                };
                            }[];
                            runtime?: {
                                [key: string]: unknown;
                            };
                            metadata?: {
                                [key: string]: string | boolean | number;
                            };
                        };
                        /** Format: uuid */
                        parentVersionId?: string;
                    };
                };
            };
            responses: {
                /** @description Immutable compiled ModelIR version created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Model version identity conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/underwriting/scenarios": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        investmentCaseId: string;
                        /** Format: uuid */
                        modelVersionId: string;
                        /** Format: uuid */
                        parentScenarioId?: string;
                        scenario: {
                            /** @constant */
                            schemaVersion: "underwriting-scenario.v1";
                            name: string;
                            /** Format: uuid */
                            parentScenarioId?: string;
                            overrides: {
                                nodeId: string;
                                value: (string | boolean) | {
                                    [key: string]: string | boolean;
                                };
                                reason?: string;
                            }[];
                            semanticHash?: string;
                        };
                    };
                };
            };
            responses: {
                /** @description Immutable explicit scenario override set created without mutating P1 Assumptions */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/underwriting/runs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        investmentCaseId: string;
                        /** Format: uuid */
                        modelVersionId: string;
                        /** Format: date-time */
                        worldAt: string;
                        idempotencyKey: string;
                        /** Format: uuid */
                        scenarioId?: string;
                        /** Format: uuid */
                        baseRunId?: string;
                        /** Format: uuid */
                        workId?: string;
                        explicitInputs?: {
                            [key: string]: {
                                value: ((string | boolean) | {
                                    [key: string]: string | boolean;
                                }) | null;
                                /** @enum {string} */
                                truthClass: "OBSERVED_FACT" | "CANONICAL_ASSUMPTION" | "MODEL_PARAMETER";
                                /** @enum {string} */
                                status?: "KNOWN" | "UNKNOWN" | "STALE" | "CONFLICTING" | "UNSUPPORTED";
                                provenance?: {
                                    /** @enum {string} */
                                    kind: "p1_assumption" | "evidence_version" | "model_parameter" | "human_input" | "artifact_anchor";
                                    id: string;
                                    versionId?: string;
                                    anchorId?: string;
                                    semanticHash?: string;
                                    /** Format: date-time */
                                    effectiveAt?: string;
                                    /** Format: date-time */
                                    observedAt?: string;
                                    /** Format: date-time */
                                    retrievedAt?: string;
                                }[];
                                reason?: string;
                            };
                        };
                    };
                };
            };
            responses: {
                /** @description Idempotent replay returned the exact prior Run */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Immutable deterministic UnderwritingRun completed */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required input is unknown, stale, conflicting, missing, or non-convergent */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/underwriting/runs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Exact historical Run, InputSnapshot, checks, outputs, engine version, and hashes */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Run not found in the authenticated tenant */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/underwriting/runs/{id}/explain": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query: {
                    nodeId: string;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Deterministic recursive calculation and exact source lineage */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/underwriting/runs/diff": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query: {
                    left: string;
                    right: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Deterministic Run/input/output/check diff with dependency-graph attribution */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/underwriting/model-versions/{id}/affected": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query: {
                    nodeId: string;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Exact downstream dependency impact for one ModelVersion node */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/underwriting/model-versions/diff": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query: {
                    left: string;
                    right: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Semantic ModelIR node/version diff */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/underwriting/sensitivities": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        baseRunId: string;
                        idempotencyKey: string;
                        definition: {
                            /** @constant */
                            schemaVersion: "underwriting-sensitivity.v1";
                            name: string;
                            rowAxis: {
                                nodeId: string;
                                values: ((string | boolean) | {
                                    [key: string]: string | boolean;
                                })[];
                                label?: string;
                            };
                            columnAxis?: {
                                nodeId: string;
                                values: ((string | boolean) | {
                                    [key: string]: string | boolean;
                                })[];
                                label?: string;
                            };
                            outputNodeIds: string[];
                        };
                    };
                };
            };
            responses: {
                /** @description Idempotent sensitivity replay */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Bounded deterministic sensitivity with an immutable Run per cell */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/underwriting/sensitivities/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Exact sensitivity definition and provenance-retaining cell Runs */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/underwriting/artifact-bindings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        investmentCaseId: string;
                        /** Format: uuid */
                        modelVersionId: string;
                        /** Format: uuid */
                        documentId: string;
                        /** Format: uuid */
                        documentVersionId: string;
                        /** @enum {string} */
                        direction: "input" | "output";
                        /** @enum {string} */
                        bindingMode: "read_only" | "write_and_compare" | "compare_only";
                        modelNodeId: string;
                        anchorId: string;
                        anchorHash: string;
                        valueSelector?: string;
                        comparisonPolicy?: {
                            /** @constant */
                            mode: "EXACT_DECIMAL";
                        } | {
                            /** @constant */
                            mode: "DECLARED_ROUNDED_VALUE";
                            decimalPlaces: number;
                        } | {
                            /** @constant */
                            mode: "EXPLICIT_ABSOLUTE_TOLERANCE";
                            tolerance: string;
                        } | {
                            /** @constant */
                            mode: "EXPLICIT_RELATIVE_TOLERANCE";
                            tolerance: string;
                        };
                        /** Format: uuid */
                        supersedesBindingId?: string;
                    };
                };
            };
            responses: {
                /** @description Thin exact P4 node to P3 SpreadsheetIR anchor binding created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Artifact anchor/version conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/underwriting/projections": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        runId: string;
                        /** Format: uuid */
                        documentId: string;
                        /** Format: uuid */
                        baseVersionId: string;
                        idempotencyKey: string;
                    };
                };
            };
            responses: {
                /** @description Idempotent projection replay */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Outputs projected through a P3 typed patch into a new local DocumentVersion */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description P3 version or anchor conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/underwriting/comparisons": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        runId: string;
                        /** Format: uuid */
                        documentId: string;
                        /** Format: uuid */
                        documentVersionId: string;
                    };
                };
            };
            responses: {
                /** @description Independent P4 decimal outputs compared with exact P3/Excel values under declared policies */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/instructions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        instruction: string;
                        /**
                         * @default console
                         * @enum {string}
                         */
                        channel?: "voice" | "text" | "console";
                        reviewBeforeExecution?: boolean;
                        sessionId?: string;
                        idempotencyKey?: string;
                        /** Format: uuid */
                        instructionId?: string;
                        /** Format: uuid */
                        threadId?: string;
                        /** Format: uuid */
                        workId?: string;
                        activeContext?: {
                            /** @constant */
                            version: 1;
                            /** Format: date-time */
                            capturedAt: string;
                            /** @enum {string} */
                            source: "voice" | "text" | "console";
                            activeWork?: {
                                /** Format: uuid */
                                workId: string;
                            };
                            focusedEntity?: {
                                entityType: string;
                                /** Format: uuid */
                                entityId: string;
                            };
                            /** @default [] */
                            selectedEntities?: {
                                entityType: string;
                                /** Format: uuid */
                                entityId: string;
                            }[];
                            /** @default [] */
                            excludedEntities?: {
                                entityType: string;
                                /** Format: uuid */
                                entityId: string;
                            }[];
                            surface: {
                                /** @enum {string} */
                                id: "centropy" | "world" | "home" | "work" | "agents" | "deals";
                                route?: string;
                                /** @enum {string} */
                                spatialState?: "canvas" | "detail" | "list" | "map" | "timeline";
                            };
                            /** @default [] */
                            filters?: {
                                field: string;
                                /** @enum {string} */
                                operator: "eq" | "neq" | "in" | "not_in" | "gte" | "lte" | "contains";
                                value: string | number | boolean | string[];
                            }[];
                            timeContext?: {
                                /** Format: date-time */
                                start?: string;
                                /** Format: date-time */
                                end?: string;
                                timezone?: string;
                            };
                        };
                    };
                };
            };
            responses: {
                /** @description Work accepted */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Invalid or retired request */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/objectives": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        objective: string;
                        /**
                         * @default text
                         * @enum {string}
                         */
                        channel?: "voice" | "text" | "console";
                        sessionId?: string;
                        /** Format: uuid */
                        instructionId?: string;
                        /** Format: uuid */
                        threadId?: string;
                        /** Format: uuid */
                        workId?: string;
                        idempotencyKey?: string;
                        activeContext?: {
                            /** @constant */
                            version: 1;
                            /** Format: date-time */
                            capturedAt: string;
                            /** @enum {string} */
                            source: "voice" | "text" | "console";
                            activeWork?: {
                                /** Format: uuid */
                                workId: string;
                            };
                            focusedEntity?: {
                                entityType: string;
                                /** Format: uuid */
                                entityId: string;
                            };
                            /** @default [] */
                            selectedEntities?: {
                                entityType: string;
                                /** Format: uuid */
                                entityId: string;
                            }[];
                            /** @default [] */
                            excludedEntities?: {
                                entityType: string;
                                /** Format: uuid */
                                entityId: string;
                            }[];
                            surface: {
                                /** @enum {string} */
                                id: "centropy" | "world" | "home" | "work" | "agents" | "deals";
                                route?: string;
                                /** @enum {string} */
                                spatialState?: "canvas" | "detail" | "list" | "map" | "timeline";
                            };
                            /** @default [] */
                            filters?: {
                                field: string;
                                /** @enum {string} */
                                operator: "eq" | "neq" | "in" | "not_in" | "gte" | "lte" | "contains";
                                value: string | number | boolean | string[];
                            }[];
                            timeContext?: {
                                /** Format: date-time */
                                start?: string;
                                /** Format: date-time */
                                end?: string;
                                timezone?: string;
                            };
                        };
                        successCondition?: {
                            /** @constant */
                            version: 1;
                            statement: string;
                            /** @constant */
                            mode: "all";
                            /** @constant */
                            source: "explicit";
                            criteria: ({
                                /** @constant */
                                kind: "no_open_execution";
                            } | {
                                /** @constant */
                                kind: "all_objective_effects_verified";
                                minimumCount: number;
                            } | {
                                /** @constant */
                                kind: "canonical_query";
                                request: {
                                    [key: string]: unknown;
                                };
                                assertion: {
                                    path: (string | number)[];
                                    /** @enum {string} */
                                    operator: "exists" | "not_exists" | "eq" | "not_eq" | "gte" | "lte" | "contains" | "array_contains";
                                    expected?: unknown;
                                };
                            } | {
                                /** @constant */
                                kind: "private_equity_ic_preparation";
                                /** Format: uuid */
                                dealId: string;
                                requireScenario?: boolean;
                            } | {
                                /** @constant */
                                kind: "matched_wait";
                                minimumCount: number;
                                eventType?: string;
                            } | {
                                /** @constant */
                                kind: "delegation_state";
                                minimumCount: number;
                                /** @enum {string} */
                                requiredStatus: "acknowledged" | "accepted" | "completed";
                            } | {
                                /** @constant */
                                kind: "computer_run_state";
                                minimumCount: number;
                                /** @constant */
                                requiredStatus: "succeeded";
                                evidenceRequired: boolean;
                            } | {
                                /** @constant */
                                kind: "decision_evidence";
                                minimumCount: number;
                                accepted: ("canonical_query" | "business_effect" | "matched_event" | "delegation" | "computer_run")[];
                            } | {
                                /** @constant */
                                kind: "manual_verification";
                                reason: string;
                            })[];
                        };
                        budgets?: {
                            maxSteps?: number;
                            maxActions?: number;
                            maxQueries?: number;
                            maxPlannerFailures?: number;
                            maxConsecutiveNoProgress?: number;
                            /** Format: date-time */
                            deadlineAt?: string;
                        };
                    };
                };
            };
            responses: {
                /** @description Objective accepted */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/objectives/{id}/control": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @constant */
                        command: "continue";
                    } | {
                        /** @constant */
                        command: "interrupt";
                    } | {
                        /** @constant */
                        command: "cancel";
                    } | {
                        /** @constant */
                        command: "redirect";
                        objective: string;
                        /**
                         * @default text
                         * @enum {string}
                         */
                        channel?: "voice" | "text" | "console";
                        /** Format: uuid */
                        instructionId?: string;
                        idempotencyKey?: string;
                        successCondition?: {
                            /** @constant */
                            version: 1;
                            statement: string;
                            /** @constant */
                            mode: "all";
                            /** @constant */
                            source: "explicit";
                            criteria: ({
                                /** @constant */
                                kind: "no_open_execution";
                            } | {
                                /** @constant */
                                kind: "all_objective_effects_verified";
                                minimumCount: number;
                            } | {
                                /** @constant */
                                kind: "canonical_query";
                                request: {
                                    [key: string]: unknown;
                                };
                                assertion: {
                                    path: (string | number)[];
                                    /** @enum {string} */
                                    operator: "exists" | "not_exists" | "eq" | "not_eq" | "gte" | "lte" | "contains" | "array_contains";
                                    expected?: unknown;
                                };
                            } | {
                                /** @constant */
                                kind: "private_equity_ic_preparation";
                                /** Format: uuid */
                                dealId: string;
                                requireScenario?: boolean;
                            } | {
                                /** @constant */
                                kind: "matched_wait";
                                minimumCount: number;
                                eventType?: string;
                            } | {
                                /** @constant */
                                kind: "delegation_state";
                                minimumCount: number;
                                /** @enum {string} */
                                requiredStatus: "acknowledged" | "accepted" | "completed";
                            } | {
                                /** @constant */
                                kind: "computer_run_state";
                                minimumCount: number;
                                /** @constant */
                                requiredStatus: "succeeded";
                                evidenceRequired: boolean;
                            } | {
                                /** @constant */
                                kind: "decision_evidence";
                                minimumCount: number;
                                accepted: ("canonical_query" | "business_effect" | "matched_event" | "delegation" | "computer_run")[];
                            } | {
                                /** @constant */
                                kind: "manual_verification";
                                reason: string;
                            })[];
                        };
                    };
                };
            };
            responses: {
                /** @description Control recorded */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/works/{id}/handoff": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        targetEmployeeId: string;
                        note?: string;
                    };
                };
            };
            responses: {
                /** @description Handoff recorded */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/outcome-packs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        packId: "deal_to_verified_closing_readiness" | "deal_request_resolution" | "critical_deal_dependency_resolution" | "general_operator_objective";
                        input: {
                            [key: string]: unknown;
                        };
                        /**
                         * @default console
                         * @enum {string}
                         */
                        channel?: "voice" | "text" | "console";
                        /** Format: uuid */
                        threadId?: string;
                        sessionId?: string;
                        /** Format: uuid */
                        instructionId?: string;
                        /** Format: uuid */
                        workId?: string;
                        idempotencyKey?: string;
                        activeContext?: {
                            /** @constant */
                            version: 1;
                            /** Format: date-time */
                            capturedAt: string;
                            /** @enum {string} */
                            source: "voice" | "text" | "console";
                            activeWork?: {
                                /** Format: uuid */
                                workId: string;
                            };
                            focusedEntity?: {
                                entityType: string;
                                /** Format: uuid */
                                entityId: string;
                            };
                            /** @default [] */
                            selectedEntities?: {
                                entityType: string;
                                /** Format: uuid */
                                entityId: string;
                            }[];
                            /** @default [] */
                            excludedEntities?: {
                                entityType: string;
                                /** Format: uuid */
                                entityId: string;
                            }[];
                            surface: {
                                /** @enum {string} */
                                id: "centropy" | "world" | "home" | "work" | "agents" | "deals";
                                route?: string;
                                /** @enum {string} */
                                spatialState?: "canvas" | "detail" | "list" | "map" | "timeline";
                            };
                            /** @default [] */
                            filters?: {
                                field: string;
                                /** @enum {string} */
                                operator: "eq" | "neq" | "in" | "not_in" | "gte" | "lte" | "contains";
                                value: string | number | boolean | string[];
                            }[];
                            timeContext?: {
                                /** Format: date-time */
                                start?: string;
                                /** Format: date-time */
                                end?: string;
                                timezone?: string;
                            };
                        };
                        budgets?: {
                            maxSteps?: number;
                            maxActions?: number;
                            maxQueries?: number;
                            maxPlannerFailures?: number;
                            maxConsecutiveNoProgress?: number;
                            /** Format: date-time */
                            deadlineAt?: string;
                        };
                    };
                };
            };
            responses: {
                /** @description Outcome pack started */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/queries": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @constant */
                        intent: "work_list";
                        /** Format: uuid */
                        workId?: string;
                        executionKey?: string;
                        idempotencyKey?: string;
                        /** @enum {string} */
                        section?: "all" | "works" | "tasks";
                        openOnly?: boolean;
                        statuses?: string[];
                        /** Format: uuid */
                        recordId?: string;
                        page?: {
                            limit?: number;
                            cursor?: string;
                        };
                    } | {
                        /** @constant */
                        intent: "attention_queue";
                        /** Format: uuid */
                        workId?: string;
                        executionKey?: string;
                        idempotencyKey?: string;
                        page?: {
                            limit?: number;
                            cursor?: string;
                        };
                    } | {
                        /** @constant */
                        intent: "agent_activity";
                        /** Format: uuid */
                        workId?: string;
                        executionKey?: string;
                        idempotencyKey?: string;
                        range?: {
                            /** Format: date-time */
                            start: string;
                            /** Format: date-time */
                            end: string;
                        };
                        localDateRange?: {
                            startDate: string;
                            endDate?: string;
                        };
                        page?: {
                            limit?: number;
                            cursor?: string;
                        };
                    } | {
                        /** @constant */
                        intent: "workforce_status";
                        /** Format: uuid */
                        workId?: string;
                        executionKey?: string;
                        idempotencyKey?: string;
                        page?: {
                            limit?: number;
                            /** Format: uuid */
                            cursor?: string;
                        };
                    } | {
                        /** @constant */
                        intent: "company_context";
                        /** Format: uuid */
                        workId?: string;
                        executionKey?: string;
                        idempotencyKey?: string;
                        anchor?: {
                            /** @enum {string} */
                            entityType: "work" | "task" | "user" | "org_unit" | "tenant_location" | "external_organization" | "external_contact" | "document" | "domain_action" | "workflow_run" | "workflow_step" | "pe_strategy" | "pe_opportunity" | "pe_deal" | "pe_investment_case" | "pe_thesis" | "pe_assumption" | "pe_decision" | "pe_deal_party" | "pe_workstream" | "pe_request" | "pe_deliverable" | "pe_finding" | "pe_deal_risk" | "pe_dependency" | "pe_milestone" | "pe_closing_condition" | "pe_closing_item" | "pe_document_link" | "pe_evidence_link" | "pe_finding_risk_link" | "pe_ic_case" | "pe_ic_memo" | "pe_ic_question" | "pe_ic_recommendation" | "pe_ic_vote" | "pe_ic_dissent" | "pe_ic_condition" | "pe_ic_decision_proposal" | "pe_fund" | "pe_vehicle" | "pe_fund_vehicle_link" | "pe_strategy_mandate" | "pe_portfolio_holding" | "pe_company_hierarchy" | "pe_company_party_role" | "pe_security" | "pe_debt_facility" | "pe_debt_facility_lender" | "pe_ownership_interest" | "pe_metric_series" | "pe_metric_observation" | "pe_benchmark" | "pe_benchmark_observation" | "pe_outcome" | "pe_exit" | "pe_fact_coverage";
                            /** Format: uuid */
                            entityId: string;
                        } | {
                            /** @enum {string} */
                            partyType: "employee" | "team" | "location" | "external_organization" | "external_contact";
                            /** Format: uuid */
                            partyId: string;
                        };
                        query?: string;
                    } | {
                        /** @constant */
                        intent: "party_lookup";
                        /** Format: uuid */
                        workId?: string;
                        executionKey?: string;
                        idempotencyKey?: string;
                        ref?: {
                            /** @enum {string} */
                            partyType: "employee" | "team" | "location" | "external_organization" | "external_contact";
                            /** Format: uuid */
                            partyId: string;
                        };
                        query?: string;
                        page?: {
                            limit?: number;
                            cursor?: string;
                        };
                    } | {
                        /** @constant */
                        intent: "party_context";
                        /** Format: uuid */
                        workId?: string;
                        executionKey?: string;
                        idempotencyKey?: string;
                        ref?: {
                            /** @enum {string} */
                            partyType: "employee" | "team" | "location" | "external_organization" | "external_contact";
                            /** Format: uuid */
                            partyId: string;
                        };
                        query?: string;
                        page?: {
                            limit?: number;
                            cursor?: string;
                        };
                    } | {
                        /** @constant */
                        intent: "team_roster";
                        /** Format: uuid */
                        workId?: string;
                        executionKey?: string;
                        idempotencyKey?: string;
                        teamRef?: {
                            /** @enum {string} */
                            partyType: "employee" | "team" | "location" | "external_organization" | "external_contact";
                            /** Format: uuid */
                            partyId: string;
                        };
                        query?: string;
                        page?: {
                            limit?: number;
                            cursor?: string;
                        };
                    } | {
                        /** @constant */
                        intent: "pe_world_state";
                        /** Format: uuid */
                        workId?: string;
                        executionKey?: string;
                        idempotencyKey?: string;
                        root: {
                            /** @enum {string} */
                            entityType: "pe_strategy" | "pe_opportunity" | "pe_deal" | "pe_fund" | "pe_vehicle" | "external_organization" | "pe_portfolio_holding";
                            /** Format: uuid */
                            entityId: string;
                        };
                        /** Format: date-time */
                        at?: string;
                        /** Format: date-time */
                        validAt?: string;
                        /** Format: date-time */
                        knowledgeAt?: string;
                    } | {
                        /** @constant */
                        intent: "deal_context";
                        /** Format: uuid */
                        workId?: string;
                        executionKey?: string;
                        idempotencyKey?: string;
                        /** Format: uuid */
                        dealId: string;
                        page?: {
                            limit?: number;
                            cursor?: string;
                        };
                    } | {
                        /** @constant */
                        intent: "deal_workstreams";
                        /** Format: uuid */
                        workId?: string;
                        executionKey?: string;
                        idempotencyKey?: string;
                        /** Format: uuid */
                        dealId: string;
                        page?: {
                            limit?: number;
                            cursor?: string;
                        };
                        states?: string[];
                        owner?: {
                            /** @enum {string} */
                            partyType: "employee" | "team" | "location" | "external_organization" | "external_contact";
                            /** Format: uuid */
                            partyId: string;
                        };
                    } | {
                        /** @constant */
                        intent: "open_requests";
                        /** Format: uuid */
                        workId?: string;
                        executionKey?: string;
                        idempotencyKey?: string;
                        /** Format: uuid */
                        dealId: string;
                        page?: {
                            limit?: number;
                            cursor?: string;
                        };
                        /** Format: uuid */
                        workstreamId?: string;
                        requestedFrom?: {
                            /** @enum {string} */
                            partyType: "employee" | "team" | "location" | "external_organization" | "external_contact";
                            /** Format: uuid */
                            partyId: string;
                        };
                        /** @enum {string} */
                        dueState?: "any" | "overdue" | "not_overdue";
                    } | {
                        /** @constant */
                        intent: "open_findings";
                        /** Format: uuid */
                        workId?: string;
                        executionKey?: string;
                        idempotencyKey?: string;
                        /** Format: uuid */
                        dealId: string;
                        page?: {
                            limit?: number;
                            cursor?: string;
                        };
                        /** Format: uuid */
                        workstreamId?: string;
                        severities?: ("low" | "medium" | "high" | "critical")[];
                    } | {
                        /** @constant */
                        intent: "open_deal_risks";
                        /** Format: uuid */
                        workId?: string;
                        executionKey?: string;
                        idempotencyKey?: string;
                        /** Format: uuid */
                        dealId: string;
                        page?: {
                            limit?: number;
                            cursor?: string;
                        };
                        /** Format: uuid */
                        workstreamId?: string;
                        severities?: ("low" | "medium" | "high" | "critical")[];
                    } | {
                        /** @constant */
                        intent: "critical_dependencies";
                        /** Format: uuid */
                        workId?: string;
                        executionKey?: string;
                        idempotencyKey?: string;
                        /** Format: uuid */
                        dealId: string;
                        page?: {
                            limit?: number;
                            cursor?: string;
                        };
                        includeResolved?: boolean;
                    } | {
                        /** @constant */
                        intent: "closing_readiness";
                        /** Format: uuid */
                        workId?: string;
                        executionKey?: string;
                        idempotencyKey?: string;
                        /** Format: uuid */
                        dealId: string;
                        page?: {
                            limit?: number;
                            cursor?: string;
                        };
                    };
                };
            };
            responses: {
                /** @description Canonical query completed */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Invalid or retired query */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/read-models/workforce-status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    limit?: number;
                    cursor?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Source-backed configured AI workforce, assignments, verified metrics, governed learning state, truthful truncation, and a next cursor */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/workforce/profiles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    limit?: number;
                    cursor?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Source-backed governed workforce state with truthful bounded-page metadata */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        profileId?: string;
                        key: string;
                        name: string;
                        /** @enum {string} */
                        status?: "enabled" | "disabled";
                        modelRoute?: {
                            provider: string;
                            model?: string | null;
                            /** @constant */
                            purpose: "objective_execution";
                        };
                        capabilityGrants: {
                            capability: string;
                            /** @enum {string} */
                            kind: "query" | "action" | "wait" | "check";
                        }[];
                        maxConcurrentAssignments?: number;
                        autonomyLimits?: {
                            maxActions?: number;
                            maxQueries?: number;
                            maxReplans?: number;
                            maxPlannerCalls?: number;
                            maxWallClockMs?: number;
                            maxKnownCostUsd?: number | null;
                            maxKnownTokens?: number | null;
                        };
                        planningHints?: {
                            [key: string]: unknown;
                        };
                        learningRevisionId?: string | null;
                    };
                };
            };
            responses: {
                /** @description New immutable configuration revision created */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description AgentProfile and first immutable revision created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Invalid capability or bounded configuration */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks workforce governance authority */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/workforce/proposals/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        decision: "promote" | "reject";
                    };
                };
            };
            responses: {
                /** @description Learning proposal human review recorded; promotion creates immutable LearningRevision and AgentProfileRevision */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Invalid proposal review */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks workforce learning-review authority */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/workforce/assignments/{id}/reassign": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        note?: string;
                    };
                };
            };
            responses: {
                /** @description Active assignment relinquished with immutable operator provenance; normal deterministic assignment resumes the exact P6 node */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Invalid assignment or note */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated employee lacks workforce reassignment authority */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/actions/{id}/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        note?: string;
                        expectedEffectHash?: string;
                        /** @constant */
                        typedConfirmation?: true;
                    };
                };
            };
            responses: {
                /** @description Approval recorded */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/actions/{id}/reject": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        reason?: string;
                    };
                };
            };
            responses: {
                /** @description Rejection recorded */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/actions/{id}/escalate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        note?: string;
                    };
                };
            };
            responses: {
                /** @description Escalation recorded */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/policies/{tenantId}/{actionType}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        policy: {
                            [key: string]: unknown;
                        };
                        requiresConfirmation: boolean;
                        confirmationTemplate?: string | null;
                        modelProvider?: string;
                        confirmationTimeoutHours?: number | null;
                        version?: number;
                        /** Format: date-time */
                        effectiveFrom?: string;
                    };
                };
            };
            responses: {
                /** @description Active policy saved */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/webhooks/vapi": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        message: {
                            type: string;
                            call?: {
                                id?: string;
                                phoneNumberId?: string;
                                customer?: {
                                    number?: string;
                                } & {
                                    [key: string]: unknown;
                                };
                                phoneNumber?: {
                                    number?: string;
                                } & {
                                    [key: string]: unknown;
                                };
                                metadata?: {
                                    [key: string]: unknown;
                                };
                            } & {
                                [key: string]: unknown;
                            };
                            transcript?: string;
                            artifact?: {
                                [key: string]: unknown;
                            };
                        } & {
                            [key: string]: unknown;
                        };
                    };
                };
            };
            responses: {
                /** @description Employee voice event received */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/webhooks/ghl": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Authenticated historical payload quarantined; never executed */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/webhooks/marketing": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Authenticated historical payload quarantined; never executed */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/webhooks/payment": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Authenticated historical payload quarantined; never executed */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/webhooks/esign": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Authenticated historical payload quarantined; never executed */
                410: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/connections/microsoft-graph/start": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        directoryTenantId: string;
                        /** Format: uuid */
                        applicationClientId: string;
                        requestedPermissions: string[];
                        auth: {
                            /** @constant */
                            kind: "federated_workload";
                            awsRegion: string;
                            federationAudience: string;
                            federationConfigId: string;
                            /** @enum {string} */
                            signingAlgorithm: "ES384" | "RS256";
                            identityTokenDurationSeconds?: number;
                        } | {
                            /** @constant */
                            kind: "managed_certificate";
                            credentialRef: string;
                            credentialVersion?: string;
                            /** @constant */
                            certificateFallbackAcknowledged: true;
                        };
                        /** Format: uri */
                        redirectUri?: string;
                    };
                };
            };
            responses: {
                /** @description One-time Microsoft app-only admin-consent configuration started */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Integration administration denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Connection or capability conflict */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/connections/microsoft-graph/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query: {
                    state: string;
                    tenant?: string;
                    admin_consent?: boolean;
                    error?: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description One-time consent state consumed and browser redirected to connection status */
                303: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/connections/microsoft-graph/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Microsoft app identity, consent, permission, capability, and health status */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/microsoft-graph/source-scopes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Configured Microsoft source scopes with coverage and freshness */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        sourceKind: "outlook_mail_folder" | "outlook_calendar_view" | "teams_channel" | "teams_chat" | "teams_user_chat_feed" | "teams_transcript_organizer" | "sharepoint_drive" | "sharepoint_list";
                        /** @enum {string} */
                        permissionMode: "SCOPED" | "BROAD";
                        configuration: {
                            [key: string]: unknown;
                        };
                        negativeProbeConfiguration?: {
                            [key: string]: unknown;
                        } | null;
                        acknowledgeBroadAccess?: boolean;
                        rootBinding?: {
                            /** @enum {string} */
                            type: "pe_strategy" | "pe_opportunity" | "pe_deal" | "pe_fund" | "pe_vehicle" | "external_organization" | "pe_portfolio_holding";
                            /** Format: uuid */
                            id: string;
                        } | null;
                        freshnessPolicy?: {
                            maxAgeSeconds: number;
                            /** @enum {string} */
                            criticality: "informational" | "operational" | "consequential";
                            /** @enum {string} */
                            staleBehavior: "allow_with_warning" | "refresh_then_degrade" | "refresh_then_block";
                        };
                    };
                };
            };
            responses: {
                /** @description Exact source scope verified; subscription-first baseline queued */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Coverage administration denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Effective access not verified or broad access not acknowledged */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/microsoft-graph/source-scopes/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Exact source-scope status */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Source scope not found in the authenticated tenant */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Source disabled; observations, evidence, and coverage history retained */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Coverage administration denied */
                403: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/integrations/microsoft-graph/coverage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description As-of provider coverage, freshness, recovery, unresolved counts, and integration health */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/webhooks/microsoft-graph": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        value: ({
                            subscriptionId: string;
                            clientState: string;
                            /** Format: uuid */
                            tenantId: string;
                            resource?: string;
                            /** @enum {string} */
                            changeType?: "created" | "updated" | "deleted";
                            /** @enum {string} */
                            lifecycleEvent?: "reauthorizationRequired" | "subscriptionRemoved" | "missed";
                            /** Format: date-time */
                            subscriptionExpirationDateTime?: string;
                        } & {
                            [key: string]: unknown;
                        })[];
                    };
                };
            };
            responses: {
                /** @description Validation token echoed exactly as text/plain */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Authenticated notifications durably enqueued before acknowledgement */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Malformed notification envelope */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description clientState, directory, or resource mismatch */
                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Durable enqueue failed; no false success */
                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/artifacts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @enum {string} */
                        kind: "xlsx" | "docx" | "pptx";
                        title: string;
                    };
                };
            };
            responses: {
                /** @description Core Document and first immutable local DocumentVersion created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/{id}/artifact": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Artifact summary, immutable version timeline, distinct heads, semantic status, and pinned context */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/{id}/artifact/versions/{versionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    versionId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Exact immutable version metadata and semantic status */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/{id}/artifact/ir/{versionId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: {
                    id?: string[];
                    kind?: string[];
                    search?: string;
                    sheetId?: string;
                    address?: string;
                    range?: string;
                    dependencyOf?: string;
                    dependentOf?: string;
                    offset?: number;
                    limit?: number;
                };
                header?: never;
                path: {
                    id: string;
                    versionId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Bounded semantic IR slice; never a fabricated Office rendering */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/{id}/artifact/diff": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query: {
                    left: string;
                    right: string;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Semantic diff between two immutable versions */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/{id}/artifact/drafts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        baseVersionId: string;
                    };
                };
            };
            responses: {
                /** @description Actor-owned local draft head created from an exact version */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Stale version or head */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/{id}/artifact/patches": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        baseVersionId: string;
                        draftKey: string;
                        operations: {
                            [key: string]: unknown;
                        }[];
                        expectedSemanticHash?: string;
                    };
                };
            };
            responses: {
                /** @description Atomic typed patch appended one immutable version */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Stale head or anchor precondition */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/{id}/artifact/comments": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query: {
                    versionId: string;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Version-pinned artifact comments */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        versionId: string;
                        anchorId: string;
                        anchorHash: string;
                        body: string;
                        /** Format: uuid */
                        parentCommentId?: string;
                    };
                };
            };
            responses: {
                /** @description Version and anchor-pinned comment created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/{id}/artifact/reviews": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query: {
                    versionId: string;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Version-pinned editorial review history */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        versionId: string;
                        /** @enum {string} */
                        state: "requested" | "approved" | "changes_requested" | "withdrawn" | "comment_resolved";
                        /** Format: uuid */
                        commentId?: string;
                    };
                };
            };
            responses: {
                /** @description Editorial review event recorded; it grants no execution authority */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/{id}/artifact/bindings": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query: {
                    versionId: string;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Exact version and anchor bindings */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        versionId: string;
                        anchorId: string;
                        anchorHash: string;
                        /** @enum {string} */
                        targetKind: "evidence_version" | "canonical_entity" | "document_version";
                        /** Format: uuid */
                        targetId: string;
                        targetEntityType?: string;
                        targetAnchor?: string;
                    };
                };
            };
            responses: {
                /** @description Version-specific Evidence, entity, or DocumentVersion binding created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/{id}/artifact/lineage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query: {
                    versionId: string;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Artifact version lineage */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        sourceVersionId: string;
                        /** Format: uuid */
                        targetVersionId: string;
                        /** @enum {string} */
                        relation: "supersedes" | "derived_from" | "copied_from" | "template_instantiation" | "rendered_from" | "merged_from";
                    };
                };
            };
            responses: {
                /** @description Exact cross-version lineage edge created */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/{id}/artifact/publish": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        localVersionId: string;
                        /** Format: uuid */
                        baseVersionId: string;
                        /** @enum {string} */
                        mode: "APP_ONLY_FILE_REPLACE" | "DELEGATED_FILE_REPLACE";
                    };
                };
            };
            responses: {
                /** @description Conditional Microsoft replace read back and semantically verified */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Provider head conflict; no blind overwrite */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/{id}/artifact/publish-new": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        localVersionId: string;
                        /** Format: uuid */
                        integrationId: string;
                        /** Format: uuid */
                        sourceScopeId: string;
                        driveId: string;
                        parentItemId: string;
                        name: string;
                        /** @enum {string} */
                        mode: "APP_ONLY_FILE_CREATE" | "DELEGATED_FILE_CREATE";
                        /** @constant */
                        conflictBehavior: "fail";
                    };
                };
            };
            responses: {
                /** @description New Microsoft file created at explicit target, read back, and semantically verified */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Name conflict under mandatory fail policy */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/{id}/artifact/publications/{publicationId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    publicationId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Truthful replacement publication state */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Publication not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/{id}/artifact/provider-creations/{creationId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                    creationId: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Truthful provider-create state */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Provider creation not found */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/{id}/artifact/context": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query: {
                    versionId: string;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Version-pinned comments, review, bindings, lineage, remaps, and external operation state */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/documents/{id}/artifact/recalculate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        versionId: string;
                        ranges: {
                            worksheetId: string;
                            address: string;
                        }[];
                    };
                };
            };
            responses: {
                /** @description Delegated Excel calculation requested and required ranges read back */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Provider or authorization precondition failed; calculation remains stale */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/artifact-templates": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {
                /** @description Active immutable artifact templates */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        documentId: string;
                        /** Format: uuid */
                        versionId: string;
                        templateKey: string;
                    };
                };
            };
            responses: {
                /** @description Exact DocumentVersion registered as a template */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/artifact-templates/{key}/instantiate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    key: string;
                };
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        title: string;
                    };
                };
            };
            responses: {
                /** @description New Core Document and first immutable version instantiated with lineage */
                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/compute-search-submit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @constant */
                        schema: "finnor.compute-search-request.v1";
                        /** Format: uuid */
                        programId: string;
                        policyRequest: {
                            owner: string;
                            id: string;
                            version: string;
                            contentDigest: string;
                        };
                        computeGrant: {
                            owner: string;
                            id: string;
                            version: string;
                            contentDigest: string;
                        };
                        idempotencyKey: string;
                        /** @enum {string} */
                        mode: "ordinary_disposable" | "protected";
                        /**
                         * @default ADAPTIVE
                         * @enum {string}
                         */
                        strategy?: "ADAPTIVE" | "FIXED_SEQUENTIAL" | "FIXED_WIDE";
                        limits: {
                            maxUnits: number;
                            maxParallel: number;
                        };
                        /** @default [] */
                        requestedKinds?: "MODEL_REFINE"[];
                        /** @default [] */
                        routeIds?: string[];
                        deliberation?: {
                            moduleRef: {
                                owner: string;
                                id: string;
                                version: string;
                                contentDigest: string;
                            };
                            valueEvidenceRef: {
                                owner: string;
                                id: string;
                                version: string;
                                contentDigest: string;
                            } | null;
                            sourceInspectionRef: {
                                /** Format: uuid */
                                sourceId: string;
                                /** Format: uuid */
                                versionId: string;
                                contentDigest: string;
                            } | null;
                        };
                    };
                };
            };
            responses: {
                /** @description Current principal-scoped plan or durable control receipt */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Original owner-bound computation accepted without protected authority */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Bounded strict request rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Indistinguishable absent or unauthorized private resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Current owner, grant, input, route or terminal predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/compute-search-read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        searchId: string;
                    };
                };
            };
            responses: {
                /** @description Current principal-scoped plan or durable control receipt */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Original owner-bound computation accepted without protected authority */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Bounded strict request rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Indistinguishable absent or unauthorized private resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Current owner, grant, input, route or terminal predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/compute-search-projection": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        root: {
                            entityType: string;
                            /** Format: uuid */
                            entityId: string;
                        };
                        /** Format: uuid */
                        workId: string;
                        /** @enum {string} */
                        methodOwner?: "P2" | "M2";
                    };
                };
            };
            responses: {
                /** @description Current principal-scoped plan or durable control receipt */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Original owner-bound computation accepted without protected authority */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Bounded strict request rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Indistinguishable absent or unauthorized private resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Current owner, grant, input, route or terminal predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/compute-search-cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        searchId: string;
                    };
                };
            };
            responses: {
                /** @description Current principal-scoped plan or durable control receipt */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Original owner-bound computation accepted without protected authority */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Bounded strict request rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Indistinguishable absent or unauthorized private resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Current owner, grant, input, route or terminal predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/compute-search-resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        searchId: string;
                    };
                };
            };
            responses: {
                /** @description Current principal-scoped plan or durable control receipt */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Original owner-bound computation accepted without protected authority */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Bounded strict request rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Indistinguishable absent or unauthorized private resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Current owner, grant, input, route or terminal predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/compute-search-reconcile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        searchId: string;
                    };
                };
            };
            responses: {
                /** @description Current principal-scoped plan or durable control receipt */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Original owner-bound computation accepted without protected authority */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Bounded strict request rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Indistinguishable absent or unauthorized private resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Current owner, grant, input, route or terminal predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/procedure-experience": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        programIds: string[];
                        /** Format: date-time */
                        knowledgeCut: string;
                        /** @enum {string} */
                        mode: "ordinary_disposable" | "protected";
                    };
                };
            };
            responses: {
                /** @description Authorized ordinary procedure preimage or lifecycle receipt; no admission */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Bounded ordinary induction accepted on original Work */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict bounded procedure schema rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Absent or unauthorized principal-scoped procedure resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Rights, currentness, grant or unsupported protected-port predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/procedure-induce": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @constant */
                        schema: "finnor.p6.induction-request.v1";
                        root: {
                            /** @enum {string} */
                            entityType: "pe_strategy" | "pe_opportunity" | "pe_deal" | "pe_fund" | "pe_vehicle" | "external_organization" | "pe_portfolio_holding";
                            /** Format: uuid */
                            entityId: string;
                        };
                        /** Format: uuid */
                        workId: string;
                        programIds: string[];
                        /** Format: date-time */
                        knowledgeCut: string;
                        idempotencyKey: string;
                        /** @enum {string} */
                        mode: "ordinary_disposable" | "protected";
                    };
                };
            };
            responses: {
                /** @description Authorized ordinary procedure preimage or lifecycle receipt; no admission */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Bounded ordinary induction accepted on original Work */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict bounded procedure schema rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Absent or unauthorized principal-scoped procedure resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Rights, currentness, grant or unsupported protected-port predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/procedure-induction-read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        inductionId: string;
                    };
                };
            };
            responses: {
                /** @description Authorized ordinary procedure preimage or lifecycle receipt; no admission */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Bounded ordinary induction accepted on original Work */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict bounded procedure schema rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Absent or unauthorized principal-scoped procedure resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Rights, currentness, grant or unsupported protected-port predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/procedure-induction-cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        inductionId: string;
                    };
                };
            };
            responses: {
                /** @description Authorized ordinary procedure preimage or lifecycle receipt; no admission */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Bounded ordinary induction accepted on original Work */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict bounded procedure schema rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Absent or unauthorized principal-scoped procedure resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Rights, currentness, grant or unsupported protected-port predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/procedure-read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        capsuleId: string;
                    };
                };
            };
            responses: {
                /** @description Authorized ordinary procedure preimage or lifecycle receipt; no admission */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Bounded ordinary induction accepted on original Work */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict bounded procedure schema rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Absent or unauthorized principal-scoped procedure resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Rights, currentness, grant or unsupported protected-port predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/procedure-component": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        capsuleId: string;
                        ref: {
                            /** @enum {string} */
                            owner: "P1" | "P4" | "P5" | "P6" | "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7" | "S8";
                            id: string;
                            version: string;
                            contentDigest: string;
                        };
                    };
                };
            };
            responses: {
                /** @description Authorized ordinary procedure preimage or lifecycle receipt; no admission */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Bounded ordinary induction accepted on original Work */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict bounded procedure schema rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Absent or unauthorized principal-scoped procedure resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Rights, currentness, grant or unsupported protected-port predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/procedure-counterexample": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        capsuleId: string;
                        /** @enum {string} */
                        type: "CORRECTION" | "FAILURE" | "UNKNOWN" | "REVOKED";
                        reason: string;
                        idempotencyKey: string;
                    };
                };
            };
            responses: {
                /** @description Authorized ordinary procedure preimage or lifecycle receipt; no admission */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Bounded ordinary induction accepted on original Work */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict bounded procedure schema rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Absent or unauthorized principal-scoped procedure resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Rights, currentness, grant or unsupported protected-port predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/procedure-projection": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        root: {
                            /** @enum {string} */
                            entityType: "pe_strategy" | "pe_opportunity" | "pe_deal" | "pe_fund" | "pe_vehicle" | "external_organization" | "pe_portfolio_holding";
                            /** Format: uuid */
                            entityId: string;
                        };
                        /** Format: uuid */
                        workId: string;
                    };
                };
            };
            responses: {
                /** @description Authorized ordinary procedure preimage or lifecycle receipt; no admission */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Bounded ordinary induction accepted on original Work */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict bounded procedure schema rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Absent or unauthorized principal-scoped procedure resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Rights, currentness, grant or unsupported protected-port predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/procedure-admission-request": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        capsuleId: string;
                    };
                };
            };
            responses: {
                /** @description Authorized ordinary procedure preimage or lifecycle receipt; no admission */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Bounded ordinary induction accepted on original Work */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict bounded procedure schema rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Absent or unauthorized principal-scoped procedure resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Rights, currentness, grant or unsupported protected-port predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/procedure-interface": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        capsuleId: string;
                        /** Format: uuid */
                        programId: string;
                        /** Format: uuid */
                        acquisitionId: string;
                        outputKey: string;
                    };
                };
            };
            responses: {
                /** @description Authorized ordinary procedure preimage or lifecycle receipt; no admission */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Bounded ordinary induction accepted on original Work */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict bounded procedure schema rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Absent or unauthorized principal-scoped procedure resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Rights, currentness, grant or unsupported protected-port predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/procedure-costs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        capsuleId: string;
                    };
                };
            };
            responses: {
                /** @description Authorized ordinary procedure preimage or lifecycle receipt; no admission */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Bounded ordinary induction accepted on original Work */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict bounded procedure schema rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Absent or unauthorized principal-scoped procedure resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Rights, currentness, grant or unsupported protected-port predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/deliberation-submit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description Whole transport time attenuation; never a new compute or funding grant */
                    "x-deliberation-deadline-ms"?: number;
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        programId: string;
                        policyRequest: {
                            owner: string;
                            id: string;
                            version: string;
                            contentDigest: string;
                        };
                        computeGrant: {
                            owner: string;
                            id: string;
                            version: string;
                            contentDigest: string;
                        };
                        idempotencyKey: string;
                        /** @enum {string} */
                        mode: "ordinary_disposable" | "protected";
                        /**
                         * @default ADAPTIVE
                         * @enum {string}
                         */
                        strategy?: "ADAPTIVE" | "FIXED_SEQUENTIAL" | "FIXED_WIDE";
                        limits: {
                            maxUnits: number;
                            maxParallel: number;
                        };
                        /** @default [] */
                        requestedKinds?: "MODEL_REFINE"[];
                        /** @default [] */
                        routeIds?: string[];
                        /** @constant */
                        schema: "finnor.deliberation-request.v1";
                        /** @default null */
                        valueEvidenceRef?: {
                            owner: string;
                            id: string;
                            version: string;
                            contentDigest: string;
                        } | null;
                        /** @default null */
                        sourceInspectionRef?: {
                            /** Format: uuid */
                            sourceId: string;
                            /** Format: uuid */
                            versionId: string;
                            contentDigest: string;
                        } | null;
                    };
                };
            };
            responses: {
                /** @description Exact authenticated current M2 artifact or bounded development receipt */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Original owner-bound ordinary work accepted without protected authority */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict bounded contract or deadline rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Indistinguishable absent or unauthorized private resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole deadline exhausted; underlying SQL/body IO cancelled where supported */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Current source, owner, module, grant, or supported-domain predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/deliberation-read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description Whole transport time attenuation; never a new compute or funding grant */
                    "x-deliberation-deadline-ms"?: number;
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        searchId: string;
                    };
                };
            };
            responses: {
                /** @description Exact authenticated current M2 artifact or bounded development receipt */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @constant */
                            schema: "finnor.m2.current-reader.v1";
                            /** Format: uuid */
                            searchId: string;
                            /** Format: uuid */
                            programId: string;
                            /** @enum {string} */
                            status: "ACCEPTED" | "RUNNING" | "WAITING" | "STOPPED" | "FAILED" | "CANCELLED" | "INVALIDATED";
                            reason: string | null;
                            policy: {
                                /** @constant */
                                schema: "finnor.deliberation-policy.v1";
                                ref: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                /** @constant */
                                version: "m2-bounded-deliberation-v1";
                                status: string;
                                envelope: {
                                    /** @constant */
                                    schema: "finnor.m2.producer-envelope.v1";
                                    /** Format: uuid */
                                    id: string;
                                    revision: number;
                                    /** Format: uuid */
                                    tenantId: string;
                                    /** Format: uuid */
                                    principalId: string;
                                    work: {
                                        /** Format: uuid */
                                        id: string;
                                        /** Format: uuid */
                                        revision: string;
                                        inputDigest: string;
                                        /** Format: uuid */
                                        planRevisionId: string;
                                    };
                                    mandateRef: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    };
                                    parents: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    }[];
                                    inputs: {
                                        kind: string;
                                        digest: string;
                                        /** Format: date-time */
                                        knownAt: string;
                                    }[];
                                    rightsRef: string;
                                    ownerRevisionVector: {
                                        owner: string;
                                        ref: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        };
                                    }[];
                                    producerAdmission: null;
                                    /** @constant */
                                    executionAuthorityGranted: false;
                                    codeDigest: string;
                                    runtime: {
                                        node: string;
                                        binaryDigest: string;
                                        imageDigest: null;
                                        /** @constant */
                                        kind: "REGISTERED_BOUNDED_VM_NO_PROTECTED_ISOLATION";
                                    };
                                    actualInvocations: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    }[];
                                    domain: string;
                                    invalidationKeys: string[];
                                    currentGrant: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    };
                                    costLedger: {
                                        /** @constant */
                                        owner: "P2";
                                        /** Format: uuid */
                                        searchId: string;
                                        physicalAttempts: number;
                                        controllerRuns: number;
                                        usd: null;
                                    };
                                    /** @enum {string} */
                                    state: "PROPOSED" | "TESTED" | "ADMITTED" | "INVALIDATED" | "FAILED";
                                };
                                policyRequest: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                computeGrant: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                metacontroller: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                nextWork: {
                                    /** Format: uuid */
                                    unitId: string;
                                    /** @enum {string} */
                                    kind: "CONTROL_M2" | "EXECUTE_P1" | "VERIFY_P1" | "MODEL_REFINE" | "INSPECT_SOURCE";
                                    meaning: string;
                                    prerequisites: string[];
                                    /** @constant */
                                    owner: "P2";
                                    routeIds: string[];
                                    target: {
                                        programmeRef: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        };
                                        root: {
                                            /** @enum {string} */
                                            entityType: "pe_strategy" | "pe_opportunity" | "pe_deal" | "pe_fund" | "pe_vehicle" | "external_organization" | "pe_portfolio_holding";
                                            /** Format: uuid */
                                            entityId: string;
                                        };
                                        sourceInspectionRef: {
                                            /** Format: uuid */
                                            sourceId: string;
                                            /** Format: uuid */
                                            versionId: string;
                                            contentDigest: string;
                                        } | null;
                                    };
                                    inputs: {
                                        /** Format: uuid */
                                        workRevision: string;
                                        inputDigest: string;
                                        sourceResultDigest: string;
                                        acceptanceDigest: string;
                                        utilityRef: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        };
                                        valueEvidenceRef: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        } | null;
                                        moduleRef: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        } | null;
                                    };
                                    expectedResult: {
                                        /** @enum {string} */
                                        kind: "MODULE_PROPOSAL" | "NUMERICAL_VALUES" | "INDEPENDENT_ACCEPTANCE_CHECKS" | "NATIVE_MODULE_PROPOSAL" | "SOURCE_OBJECT_INSPECTION";
                                        outputKeys: string[];
                                        qualification: string;
                                    };
                                    checker: {
                                        /** @enum {string} */
                                        owner: "P1" | "M2";
                                        /** @enum {string} */
                                        method: "POSTGRES_NUMERIC_ACCEPTED_EXPRESSION" | "BOUNDED_TYPED_MODULE_PROPOSAL" | "EXACT_SOURCE_ENTITY_PERIOD_UNIT_DIGEST";
                                        acceptanceDigest: string;
                                        /** @constant */
                                        independentlyAcceptedRequired: true;
                                    };
                                    resources: {
                                        /** Format: uuid */
                                        episodeId: string;
                                        /** Format: date-time */
                                        deadlineAt: string;
                                        maxAttempts: number;
                                        maxSteps: number;
                                        maxCandidates: number;
                                        maxUnits: number;
                                        maxParallel: number;
                                        selectedUnitSteps: number;
                                        currentGrant: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        };
                                        sourcePermissionsRef: string;
                                    };
                                    admission: {
                                        /** @enum {string} */
                                        logicalState: "QUEUED" | "RUNNING";
                                        physicalState: string;
                                        attemptId: string | null;
                                        producerAdmission: null;
                                        /** @constant */
                                        executionAuthorityGranted: false;
                                    };
                                    estimate: {
                                        lossUnit: string;
                                        expectedGain: number | null;
                                        conditionalGain: number | null;
                                        completionProbability: number | null;
                                        acceptanceProbability: number | null;
                                        knownNativeCost: number | null;
                                        delayLoss: number | null;
                                        completionDelayMs: number | null;
                                        costUSD: null;
                                        /** @enum {string} */
                                        support: "PUBLIC_MODEL_RELATIVE_DIAGNOSTIC" | "FINITE_CONDITIONAL_ONLY" | "UNAVAILABLE";
                                        evidenceRef: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        } | null;
                                        /** @constant */
                                        nonadditiveChain: true;
                                    };
                                    correlation: {
                                        premiseDigest: string;
                                        equivalenceGroup: string;
                                        /** @constant */
                                        independentPremises: 1;
                                        /** @enum {string} */
                                        novelty: "INDEPENDENT_NUMERICAL_CHECK" | "MATERIAL_SOURCE_QUERY" | "PROCEDURAL_ALTERNATIVE" | "UNVERIFIED_PROPOSAL" | "CONTROLLER_ONLY";
                                    };
                                    lifecycle: {
                                        /** @constant */
                                        cancelPath: "/api/company-brain/deliberation-cancel";
                                        /** @constant */
                                        reconcilePath: "/api/company-brain/deliberation-reconcile";
                                        /** @constant */
                                        retry: "ORIGINAL_EPISODE_ONLY_RECONCILE_UNKNOWN_BEFORE_ANY_RETRY";
                                        /** @constant */
                                        latePublication: "FENCED_COST_ONLY";
                                        /** @constant */
                                        newBudgetGranted: false;
                                    };
                                }[];
                                marginalValueEvidence: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                }[];
                                utilityConversion: {
                                    ref: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    };
                                    unit: string;
                                    /** @constant */
                                    scope: "PUBLIC_FINITE_ACCEPTED_OUTPUT_MECHANICS";
                                    lossWithoutQualifiedResult: number;
                                    lossWithQualifiedResult: number;
                                    nativeAttemptCost: number;
                                    controllerMsCost: number;
                                    delayMsCost: number;
                                    /** @constant */
                                    qualification: "SUPPLIED_MODEL_RELATIVE_UTILITY_NOT_BILLING_OR_FIELD_WEALTH";
                                } | null;
                                qualifications: string[];
                                frontier: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                incumbent: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                } | null;
                                stop: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                outstandingCosts: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                ownerRequests: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                }[];
                                projection: {
                                    frontier: {
                                        candidateId: string;
                                        /** Format: uuid */
                                        unitId: string;
                                        kind: string;
                                        status: string;
                                        premiseDigest: string;
                                        moduleId: string | null;
                                        prerequisites: string[];
                                        accepted: boolean;
                                        /** @enum {string} */
                                        support: "INDEPENDENT_CURRENT_SQL_CHECK" | "UNVERIFIED" | "COST_ONLY";
                                        completion: boolean;
                                        resultDigest: string | null;
                                        programmeRef: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        };
                                        businessProgramRef: null;
                                        challengeRef: null;
                                        /** @enum {string} */
                                        candidateRole: "P1_PROCEDURE" | "M2_CONTROLLER" | "SOURCE_OBLIGATION";
                                        equivalenceGroup: string;
                                        representation: string | null;
                                        decisionLoss: {
                                            unit: string;
                                            lower: number | null;
                                            upper: number | null;
                                            /** @enum {string} */
                                            kind: "OWNER_FINITE_ACCEPTED_OUTPUT_INTERVAL" | "UNAVAILABLE";
                                            provenance: {
                                                owner: string;
                                                id: string;
                                                version: string;
                                                contentDigest: string;
                                            } | null;
                                            /** @constant */
                                            fieldValueQualified: false;
                                        };
                                        independentChecks: {
                                            id: string;
                                            /** @constant */
                                            method: "POSTGRES_NUMERIC_ACCEPTED_EXPRESSION";
                                            /** @enum {string} */
                                            status: "PASS" | "FAIL";
                                            expected: string;
                                            actual: string | null;
                                            unit: string;
                                            currencyCode: string | null;
                                            /** @constant */
                                            qualification: "FINITE_ACCEPTED_EXPRESSION_NOT_BUSINESS_PREMISE_OR_SEALED_EVALUATION";
                                        }[];
                                        unresolvedPremises: string[];
                                        remainingCosts: {
                                            nativeAttemptsLower: number;
                                            costUSD: null;
                                            delayLoss: number | null;
                                            /** @constant */
                                            priceStatus: "UNKNOWN_UNRECONCILED";
                                        };
                                    }[];
                                    incumbent: {
                                        moduleId: string;
                                        /** Format: uuid */
                                        unitId: string;
                                        values: {
                                            [key: string]: {
                                                value: string;
                                                semantics: {
                                                    entityType: string;
                                                    /** Format: uuid */
                                                    entityId: string;
                                                    /** Format: date-time */
                                                    periodStart: string;
                                                    /** Format: date-time */
                                                    periodEnd: string;
                                                    /** @enum {string} */
                                                    unit: "currency" | "count" | "ratio" | "multiple" | "rate";
                                                    currencyCode: string | null;
                                                    /** @enum {string} */
                                                    frequency: "annual" | "quarterly" | "monthly" | "instant" | "daily" | "weekly" | "event";
                                                    /** @enum {string} */
                                                    calendar: "OWNER_RECORDED" | "GREGORIAN";
                                                    /** @enum {string} */
                                                    consolidation: "OWNER_SUBJECT_ONLY" | "CONSOLIDATED" | "STANDALONE";
                                                    instrument: string;
                                                    /** @enum {string} */
                                                    scale: "1" | "1000" | "1000000";
                                                    /** @enum {string} */
                                                    sign: "AS_RECORDED" | "NEGATE";
                                                };
                                                /** @constant */
                                                truthClass: "DERIVED_VALUE";
                                                witnessIds: string[];
                                            };
                                        };
                                        checks: {
                                            id: string;
                                            /** @constant */
                                            method: "POSTGRES_NUMERIC_ACCEPTED_EXPRESSION";
                                            /** @enum {string} */
                                            status: "PASS" | "FAIL";
                                            expected: string;
                                            actual: string | null;
                                            unit: string;
                                            currencyCode: string | null;
                                            /** @constant */
                                            qualification: "FINITE_ACCEPTED_EXPRESSION_NOT_BUSINESS_PREMISE_OR_SEALED_EVALUATION";
                                        }[];
                                        sourceResultDigest: string;
                                        inputDigest: string;
                                        acceptanceDigest: string;
                                    } | null;
                                    stop: {
                                        heuristic: boolean;
                                        reason: string | null;
                                        /** @constant */
                                        technicalOnly: true;
                                        /** @constant */
                                        businessSelectionOwner: "S4";
                                        bound: {
                                            upper: number;
                                            unit: string;
                                            /** @constant */
                                            scope: "PUBLIC_FINITE_ACCEPTED_OUTPUT_MECHANICS";
                                            allAvailableChainsEnumerated: boolean;
                                            evidenceRef: {
                                                owner: string;
                                                id: string;
                                                version: string;
                                                contentDigest: string;
                                            };
                                        } | null;
                                        remainingPredicates: string[];
                                    };
                                    outstandingCosts: {
                                        /** @constant */
                                        owner: "P2";
                                        /** Format: uuid */
                                        ledgerSearchId: string;
                                        /** @constant */
                                        retained: true;
                                        usd: null;
                                        /** @constant */
                                        status: "UNKNOWN_UNRECONCILED";
                                        physicalAttempts: number;
                                        controllerRuns: number;
                                        controllerElapsedMs: number;
                                        controllerCpuMicros: number;
                                        sunkUtilityCost: number | null;
                                        /** @constant */
                                        sunkChargedAgain: false;
                                        attempts: {
                                            /** Format: uuid */
                                            attemptId: string;
                                            /** Format: uuid */
                                            unitId: string;
                                            status: string;
                                            disposition: string;
                                            /** @constant */
                                            liabilityRetained: true;
                                            /** @constant */
                                            mayRetry: false;
                                            submittedAt: string | null;
                                            endpointKey: string | null;
                                        }[];
                                        history: {
                                            /** Format: uuid */
                                            attemptId: string;
                                            /** Format: uuid */
                                            unitId: string;
                                            status: string;
                                            receiptDigest: string;
                                            chargedNativeAttempts: number;
                                            steps: number;
                                            requestedRoute: string;
                                            requestedModel: string | null;
                                            actualProvider: string | null;
                                            actualModel: string | null;
                                            usage: {
                                                inputTokens: number;
                                                outputTokens: number;
                                            } | null;
                                            elapsedMs: number | null;
                                            submittedAt: string | null;
                                            physicalOutcome: string | null;
                                            /** @enum {string} */
                                            responsibility: "AWAIT_RETURN" | "RECONCILE_UNKNOWN" | "RETAIN_USAGE_AND_RECONCILE_BILLING";
                                            /** @constant */
                                            liabilityRetained: true;
                                            /** @constant */
                                            refundGranted: false;
                                            costUSD: null;
                                            invoiceRef: null;
                                            corrections: {
                                                owner: string;
                                                id: string;
                                                version: string;
                                                contentDigest: string;
                                            }[];
                                        }[];
                                        preparation: {
                                            ref: {
                                                owner: string;
                                                id: string;
                                                version: string;
                                                contentDigest: string;
                                            };
                                            /** @enum {string} */
                                            kind: "M2_REGISTERED_SEMANTIC_COMPILATION" | "BOUNDED_PUBLIC_DEVELOPMENT_FIT_CALIBRATION_AND_EVALUATION";
                                            elapsedMs: number;
                                            cpuMicros: number;
                                            costUSD: null;
                                            /** @constant */
                                            chargedAsEpisodeAttempt: false;
                                            /** @constant */
                                            accounting: "SHARED_OR_DEVELOPMENT_PREPARATION_NONADDITIVE_NOT_S5_FUNDING";
                                        }[];
                                        originalParentCostWitness: {
                                            digest: string;
                                            attempts: number;
                                            steps: number;
                                            wallMs: number;
                                            nativeInvocationCount: number;
                                            modelInvocationCount: number;
                                        };
                                        /** @constant */
                                        accountingScope: "P2_ATTEMPTS_OVERLAP_P1_PARENT_NOT_SUMMED_PREPARATION_NONADDITIVE";
                                        unknownCosts: string[];
                                        /** @constant */
                                        externalEffectOwner: "S6";
                                    };
                                };
                            };
                            planRef: {
                                owner: string;
                                id: string;
                                version: string;
                                contentDigest: string;
                            };
                            /** @constant */
                            protectedAdmission: false;
                        };
                    };
                };
                /** @description Original owner-bound ordinary work accepted without protected authority */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict bounded contract or deadline rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Indistinguishable absent or unauthorized private resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole deadline exhausted; underlying SQL/body IO cancelled where supported */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Current source, owner, module, grant, or supported-domain predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/deliberation-projection": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description Whole transport time attenuation; never a new compute or funding grant */
                    "x-deliberation-deadline-ms"?: number;
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        root: {
                            entityType: string;
                            /** Format: uuid */
                            entityId: string;
                        };
                        /** Format: uuid */
                        workId: string;
                        /** @enum {string} */
                        methodOwner?: "P2" | "M2";
                    };
                };
            };
            responses: {
                /** @description Exact authenticated current M2 artifact or bounded development receipt */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @constant */
                            schema: "finnor.m2.work-projection.v1";
                            /** Format: uuid */
                            workId: string;
                            policies: {
                                /** @constant */
                                schema: "finnor.m2.current-reader.v1";
                                /** Format: uuid */
                                searchId: string;
                                /** Format: uuid */
                                programId: string;
                                /** @enum {string} */
                                status: "ACCEPTED" | "RUNNING" | "WAITING" | "STOPPED" | "FAILED" | "CANCELLED" | "INVALIDATED";
                                reason: string | null;
                                policy: {
                                    /** @constant */
                                    schema: "finnor.deliberation-policy.v1";
                                    ref: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    };
                                    /** @constant */
                                    version: "m2-bounded-deliberation-v1";
                                    status: string;
                                    envelope: {
                                        /** @constant */
                                        schema: "finnor.m2.producer-envelope.v1";
                                        /** Format: uuid */
                                        id: string;
                                        revision: number;
                                        /** Format: uuid */
                                        tenantId: string;
                                        /** Format: uuid */
                                        principalId: string;
                                        work: {
                                            /** Format: uuid */
                                            id: string;
                                            /** Format: uuid */
                                            revision: string;
                                            inputDigest: string;
                                            /** Format: uuid */
                                            planRevisionId: string;
                                        };
                                        mandateRef: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        };
                                        parents: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        }[];
                                        inputs: {
                                            kind: string;
                                            digest: string;
                                            /** Format: date-time */
                                            knownAt: string;
                                        }[];
                                        rightsRef: string;
                                        ownerRevisionVector: {
                                            owner: string;
                                            ref: {
                                                owner: string;
                                                id: string;
                                                version: string;
                                                contentDigest: string;
                                            };
                                        }[];
                                        producerAdmission: null;
                                        /** @constant */
                                        executionAuthorityGranted: false;
                                        codeDigest: string;
                                        runtime: {
                                            node: string;
                                            binaryDigest: string;
                                            imageDigest: null;
                                            /** @constant */
                                            kind: "REGISTERED_BOUNDED_VM_NO_PROTECTED_ISOLATION";
                                        };
                                        actualInvocations: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        }[];
                                        domain: string;
                                        invalidationKeys: string[];
                                        currentGrant: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        };
                                        costLedger: {
                                            /** @constant */
                                            owner: "P2";
                                            /** Format: uuid */
                                            searchId: string;
                                            physicalAttempts: number;
                                            controllerRuns: number;
                                            usd: null;
                                        };
                                        /** @enum {string} */
                                        state: "PROPOSED" | "TESTED" | "ADMITTED" | "INVALIDATED" | "FAILED";
                                    };
                                    policyRequest: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    };
                                    computeGrant: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    };
                                    metacontroller: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    };
                                    nextWork: {
                                        /** Format: uuid */
                                        unitId: string;
                                        /** @enum {string} */
                                        kind: "CONTROL_M2" | "EXECUTE_P1" | "VERIFY_P1" | "MODEL_REFINE" | "INSPECT_SOURCE";
                                        meaning: string;
                                        prerequisites: string[];
                                        /** @constant */
                                        owner: "P2";
                                        routeIds: string[];
                                        target: {
                                            programmeRef: {
                                                owner: string;
                                                id: string;
                                                version: string;
                                                contentDigest: string;
                                            };
                                            root: {
                                                /** @enum {string} */
                                                entityType: "pe_strategy" | "pe_opportunity" | "pe_deal" | "pe_fund" | "pe_vehicle" | "external_organization" | "pe_portfolio_holding";
                                                /** Format: uuid */
                                                entityId: string;
                                            };
                                            sourceInspectionRef: {
                                                /** Format: uuid */
                                                sourceId: string;
                                                /** Format: uuid */
                                                versionId: string;
                                                contentDigest: string;
                                            } | null;
                                        };
                                        inputs: {
                                            /** Format: uuid */
                                            workRevision: string;
                                            inputDigest: string;
                                            sourceResultDigest: string;
                                            acceptanceDigest: string;
                                            utilityRef: {
                                                owner: string;
                                                id: string;
                                                version: string;
                                                contentDigest: string;
                                            };
                                            valueEvidenceRef: {
                                                owner: string;
                                                id: string;
                                                version: string;
                                                contentDigest: string;
                                            } | null;
                                            moduleRef: {
                                                owner: string;
                                                id: string;
                                                version: string;
                                                contentDigest: string;
                                            } | null;
                                        };
                                        expectedResult: {
                                            /** @enum {string} */
                                            kind: "MODULE_PROPOSAL" | "NUMERICAL_VALUES" | "INDEPENDENT_ACCEPTANCE_CHECKS" | "NATIVE_MODULE_PROPOSAL" | "SOURCE_OBJECT_INSPECTION";
                                            outputKeys: string[];
                                            qualification: string;
                                        };
                                        checker: {
                                            /** @enum {string} */
                                            owner: "P1" | "M2";
                                            /** @enum {string} */
                                            method: "POSTGRES_NUMERIC_ACCEPTED_EXPRESSION" | "BOUNDED_TYPED_MODULE_PROPOSAL" | "EXACT_SOURCE_ENTITY_PERIOD_UNIT_DIGEST";
                                            acceptanceDigest: string;
                                            /** @constant */
                                            independentlyAcceptedRequired: true;
                                        };
                                        resources: {
                                            /** Format: uuid */
                                            episodeId: string;
                                            /** Format: date-time */
                                            deadlineAt: string;
                                            maxAttempts: number;
                                            maxSteps: number;
                                            maxCandidates: number;
                                            maxUnits: number;
                                            maxParallel: number;
                                            selectedUnitSteps: number;
                                            currentGrant: {
                                                owner: string;
                                                id: string;
                                                version: string;
                                                contentDigest: string;
                                            };
                                            sourcePermissionsRef: string;
                                        };
                                        admission: {
                                            /** @enum {string} */
                                            logicalState: "QUEUED" | "RUNNING";
                                            physicalState: string;
                                            attemptId: string | null;
                                            producerAdmission: null;
                                            /** @constant */
                                            executionAuthorityGranted: false;
                                        };
                                        estimate: {
                                            lossUnit: string;
                                            expectedGain: number | null;
                                            conditionalGain: number | null;
                                            completionProbability: number | null;
                                            acceptanceProbability: number | null;
                                            knownNativeCost: number | null;
                                            delayLoss: number | null;
                                            completionDelayMs: number | null;
                                            costUSD: null;
                                            /** @enum {string} */
                                            support: "PUBLIC_MODEL_RELATIVE_DIAGNOSTIC" | "FINITE_CONDITIONAL_ONLY" | "UNAVAILABLE";
                                            evidenceRef: {
                                                owner: string;
                                                id: string;
                                                version: string;
                                                contentDigest: string;
                                            } | null;
                                            /** @constant */
                                            nonadditiveChain: true;
                                        };
                                        correlation: {
                                            premiseDigest: string;
                                            equivalenceGroup: string;
                                            /** @constant */
                                            independentPremises: 1;
                                            /** @enum {string} */
                                            novelty: "INDEPENDENT_NUMERICAL_CHECK" | "MATERIAL_SOURCE_QUERY" | "PROCEDURAL_ALTERNATIVE" | "UNVERIFIED_PROPOSAL" | "CONTROLLER_ONLY";
                                        };
                                        lifecycle: {
                                            /** @constant */
                                            cancelPath: "/api/company-brain/deliberation-cancel";
                                            /** @constant */
                                            reconcilePath: "/api/company-brain/deliberation-reconcile";
                                            /** @constant */
                                            retry: "ORIGINAL_EPISODE_ONLY_RECONCILE_UNKNOWN_BEFORE_ANY_RETRY";
                                            /** @constant */
                                            latePublication: "FENCED_COST_ONLY";
                                            /** @constant */
                                            newBudgetGranted: false;
                                        };
                                    }[];
                                    marginalValueEvidence: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    }[];
                                    utilityConversion: {
                                        ref: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        };
                                        unit: string;
                                        /** @constant */
                                        scope: "PUBLIC_FINITE_ACCEPTED_OUTPUT_MECHANICS";
                                        lossWithoutQualifiedResult: number;
                                        lossWithQualifiedResult: number;
                                        nativeAttemptCost: number;
                                        controllerMsCost: number;
                                        delayMsCost: number;
                                        /** @constant */
                                        qualification: "SUPPLIED_MODEL_RELATIVE_UTILITY_NOT_BILLING_OR_FIELD_WEALTH";
                                    } | null;
                                    qualifications: string[];
                                    frontier: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    };
                                    incumbent: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    } | null;
                                    stop: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    };
                                    outstandingCosts: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    };
                                    ownerRequests: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    }[];
                                    projection: {
                                        frontier: {
                                            candidateId: string;
                                            /** Format: uuid */
                                            unitId: string;
                                            kind: string;
                                            status: string;
                                            premiseDigest: string;
                                            moduleId: string | null;
                                            prerequisites: string[];
                                            accepted: boolean;
                                            /** @enum {string} */
                                            support: "INDEPENDENT_CURRENT_SQL_CHECK" | "UNVERIFIED" | "COST_ONLY";
                                            completion: boolean;
                                            resultDigest: string | null;
                                            programmeRef: {
                                                owner: string;
                                                id: string;
                                                version: string;
                                                contentDigest: string;
                                            };
                                            businessProgramRef: null;
                                            challengeRef: null;
                                            /** @enum {string} */
                                            candidateRole: "P1_PROCEDURE" | "M2_CONTROLLER" | "SOURCE_OBLIGATION";
                                            equivalenceGroup: string;
                                            representation: string | null;
                                            decisionLoss: {
                                                unit: string;
                                                lower: number | null;
                                                upper: number | null;
                                                /** @enum {string} */
                                                kind: "OWNER_FINITE_ACCEPTED_OUTPUT_INTERVAL" | "UNAVAILABLE";
                                                provenance: {
                                                    owner: string;
                                                    id: string;
                                                    version: string;
                                                    contentDigest: string;
                                                } | null;
                                                /** @constant */
                                                fieldValueQualified: false;
                                            };
                                            independentChecks: {
                                                id: string;
                                                /** @constant */
                                                method: "POSTGRES_NUMERIC_ACCEPTED_EXPRESSION";
                                                /** @enum {string} */
                                                status: "PASS" | "FAIL";
                                                expected: string;
                                                actual: string | null;
                                                unit: string;
                                                currencyCode: string | null;
                                                /** @constant */
                                                qualification: "FINITE_ACCEPTED_EXPRESSION_NOT_BUSINESS_PREMISE_OR_SEALED_EVALUATION";
                                            }[];
                                            unresolvedPremises: string[];
                                            remainingCosts: {
                                                nativeAttemptsLower: number;
                                                costUSD: null;
                                                delayLoss: number | null;
                                                /** @constant */
                                                priceStatus: "UNKNOWN_UNRECONCILED";
                                            };
                                        }[];
                                        incumbent: {
                                            moduleId: string;
                                            /** Format: uuid */
                                            unitId: string;
                                            values: {
                                                [key: string]: {
                                                    value: string;
                                                    semantics: {
                                                        entityType: string;
                                                        /** Format: uuid */
                                                        entityId: string;
                                                        /** Format: date-time */
                                                        periodStart: string;
                                                        /** Format: date-time */
                                                        periodEnd: string;
                                                        /** @enum {string} */
                                                        unit: "currency" | "count" | "ratio" | "multiple" | "rate";
                                                        currencyCode: string | null;
                                                        /** @enum {string} */
                                                        frequency: "annual" | "quarterly" | "monthly" | "instant" | "daily" | "weekly" | "event";
                                                        /** @enum {string} */
                                                        calendar: "OWNER_RECORDED" | "GREGORIAN";
                                                        /** @enum {string} */
                                                        consolidation: "OWNER_SUBJECT_ONLY" | "CONSOLIDATED" | "STANDALONE";
                                                        instrument: string;
                                                        /** @enum {string} */
                                                        scale: "1" | "1000" | "1000000";
                                                        /** @enum {string} */
                                                        sign: "AS_RECORDED" | "NEGATE";
                                                    };
                                                    /** @constant */
                                                    truthClass: "DERIVED_VALUE";
                                                    witnessIds: string[];
                                                };
                                            };
                                            checks: {
                                                id: string;
                                                /** @constant */
                                                method: "POSTGRES_NUMERIC_ACCEPTED_EXPRESSION";
                                                /** @enum {string} */
                                                status: "PASS" | "FAIL";
                                                expected: string;
                                                actual: string | null;
                                                unit: string;
                                                currencyCode: string | null;
                                                /** @constant */
                                                qualification: "FINITE_ACCEPTED_EXPRESSION_NOT_BUSINESS_PREMISE_OR_SEALED_EVALUATION";
                                            }[];
                                            sourceResultDigest: string;
                                            inputDigest: string;
                                            acceptanceDigest: string;
                                        } | null;
                                        stop: {
                                            heuristic: boolean;
                                            reason: string | null;
                                            /** @constant */
                                            technicalOnly: true;
                                            /** @constant */
                                            businessSelectionOwner: "S4";
                                            bound: {
                                                upper: number;
                                                unit: string;
                                                /** @constant */
                                                scope: "PUBLIC_FINITE_ACCEPTED_OUTPUT_MECHANICS";
                                                allAvailableChainsEnumerated: boolean;
                                                evidenceRef: {
                                                    owner: string;
                                                    id: string;
                                                    version: string;
                                                    contentDigest: string;
                                                };
                                            } | null;
                                            remainingPredicates: string[];
                                        };
                                        outstandingCosts: {
                                            /** @constant */
                                            owner: "P2";
                                            /** Format: uuid */
                                            ledgerSearchId: string;
                                            /** @constant */
                                            retained: true;
                                            usd: null;
                                            /** @constant */
                                            status: "UNKNOWN_UNRECONCILED";
                                            physicalAttempts: number;
                                            controllerRuns: number;
                                            controllerElapsedMs: number;
                                            controllerCpuMicros: number;
                                            sunkUtilityCost: number | null;
                                            /** @constant */
                                            sunkChargedAgain: false;
                                            attempts: {
                                                /** Format: uuid */
                                                attemptId: string;
                                                /** Format: uuid */
                                                unitId: string;
                                                status: string;
                                                disposition: string;
                                                /** @constant */
                                                liabilityRetained: true;
                                                /** @constant */
                                                mayRetry: false;
                                                submittedAt: string | null;
                                                endpointKey: string | null;
                                            }[];
                                            history: {
                                                /** Format: uuid */
                                                attemptId: string;
                                                /** Format: uuid */
                                                unitId: string;
                                                status: string;
                                                receiptDigest: string;
                                                chargedNativeAttempts: number;
                                                steps: number;
                                                requestedRoute: string;
                                                requestedModel: string | null;
                                                actualProvider: string | null;
                                                actualModel: string | null;
                                                usage: {
                                                    inputTokens: number;
                                                    outputTokens: number;
                                                } | null;
                                                elapsedMs: number | null;
                                                submittedAt: string | null;
                                                physicalOutcome: string | null;
                                                /** @enum {string} */
                                                responsibility: "AWAIT_RETURN" | "RECONCILE_UNKNOWN" | "RETAIN_USAGE_AND_RECONCILE_BILLING";
                                                /** @constant */
                                                liabilityRetained: true;
                                                /** @constant */
                                                refundGranted: false;
                                                costUSD: null;
                                                invoiceRef: null;
                                                corrections: {
                                                    owner: string;
                                                    id: string;
                                                    version: string;
                                                    contentDigest: string;
                                                }[];
                                            }[];
                                            preparation: {
                                                ref: {
                                                    owner: string;
                                                    id: string;
                                                    version: string;
                                                    contentDigest: string;
                                                };
                                                /** @enum {string} */
                                                kind: "M2_REGISTERED_SEMANTIC_COMPILATION" | "BOUNDED_PUBLIC_DEVELOPMENT_FIT_CALIBRATION_AND_EVALUATION";
                                                elapsedMs: number;
                                                cpuMicros: number;
                                                costUSD: null;
                                                /** @constant */
                                                chargedAsEpisodeAttempt: false;
                                                /** @constant */
                                                accounting: "SHARED_OR_DEVELOPMENT_PREPARATION_NONADDITIVE_NOT_S5_FUNDING";
                                            }[];
                                            originalParentCostWitness: {
                                                digest: string;
                                                attempts: number;
                                                steps: number;
                                                wallMs: number;
                                                nativeInvocationCount: number;
                                                modelInvocationCount: number;
                                            };
                                            /** @constant */
                                            accountingScope: "P2_ATTEMPTS_OVERLAP_P1_PARENT_NOT_SUMMED_PREPARATION_NONADDITIVE";
                                            unknownCosts: string[];
                                            /** @constant */
                                            externalEffectOwner: "S6";
                                        };
                                    };
                                };
                                planRef: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                /** @constant */
                                protectedAdmission: false;
                            }[];
                            eligiblePrograms: {
                                /** Format: uuid */
                                programId: string;
                                /** @enum {string} */
                                status: "QUEUED" | "WAITING";
                                /** Format: uuid */
                                workRevision: string;
                                policyRequest: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                computeGrant: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                            }[];
                        };
                    };
                };
                /** @description Original owner-bound ordinary work accepted without protected authority */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict bounded contract or deadline rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Indistinguishable absent or unauthorized private resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole deadline exhausted; underlying SQL/body IO cancelled where supported */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Current source, owner, module, grant, or supported-domain predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/deliberation-cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description Whole transport time attenuation; never a new compute or funding grant */
                    "x-deliberation-deadline-ms"?: number;
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        searchId: string;
                    };
                };
            };
            responses: {
                /** @description Exact authenticated current M2 artifact or bounded development receipt */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @constant */
                            schema: "finnor.m2.current-reader.v1";
                            /** Format: uuid */
                            searchId: string;
                            /** Format: uuid */
                            programId: string;
                            /** @enum {string} */
                            status: "ACCEPTED" | "RUNNING" | "WAITING" | "STOPPED" | "FAILED" | "CANCELLED" | "INVALIDATED";
                            reason: string | null;
                            policy: {
                                /** @constant */
                                schema: "finnor.deliberation-policy.v1";
                                ref: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                /** @constant */
                                version: "m2-bounded-deliberation-v1";
                                status: string;
                                envelope: {
                                    /** @constant */
                                    schema: "finnor.m2.producer-envelope.v1";
                                    /** Format: uuid */
                                    id: string;
                                    revision: number;
                                    /** Format: uuid */
                                    tenantId: string;
                                    /** Format: uuid */
                                    principalId: string;
                                    work: {
                                        /** Format: uuid */
                                        id: string;
                                        /** Format: uuid */
                                        revision: string;
                                        inputDigest: string;
                                        /** Format: uuid */
                                        planRevisionId: string;
                                    };
                                    mandateRef: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    };
                                    parents: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    }[];
                                    inputs: {
                                        kind: string;
                                        digest: string;
                                        /** Format: date-time */
                                        knownAt: string;
                                    }[];
                                    rightsRef: string;
                                    ownerRevisionVector: {
                                        owner: string;
                                        ref: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        };
                                    }[];
                                    producerAdmission: null;
                                    /** @constant */
                                    executionAuthorityGranted: false;
                                    codeDigest: string;
                                    runtime: {
                                        node: string;
                                        binaryDigest: string;
                                        imageDigest: null;
                                        /** @constant */
                                        kind: "REGISTERED_BOUNDED_VM_NO_PROTECTED_ISOLATION";
                                    };
                                    actualInvocations: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    }[];
                                    domain: string;
                                    invalidationKeys: string[];
                                    currentGrant: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    };
                                    costLedger: {
                                        /** @constant */
                                        owner: "P2";
                                        /** Format: uuid */
                                        searchId: string;
                                        physicalAttempts: number;
                                        controllerRuns: number;
                                        usd: null;
                                    };
                                    /** @enum {string} */
                                    state: "PROPOSED" | "TESTED" | "ADMITTED" | "INVALIDATED" | "FAILED";
                                };
                                policyRequest: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                computeGrant: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                metacontroller: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                nextWork: {
                                    /** Format: uuid */
                                    unitId: string;
                                    /** @enum {string} */
                                    kind: "CONTROL_M2" | "EXECUTE_P1" | "VERIFY_P1" | "MODEL_REFINE" | "INSPECT_SOURCE";
                                    meaning: string;
                                    prerequisites: string[];
                                    /** @constant */
                                    owner: "P2";
                                    routeIds: string[];
                                    target: {
                                        programmeRef: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        };
                                        root: {
                                            /** @enum {string} */
                                            entityType: "pe_strategy" | "pe_opportunity" | "pe_deal" | "pe_fund" | "pe_vehicle" | "external_organization" | "pe_portfolio_holding";
                                            /** Format: uuid */
                                            entityId: string;
                                        };
                                        sourceInspectionRef: {
                                            /** Format: uuid */
                                            sourceId: string;
                                            /** Format: uuid */
                                            versionId: string;
                                            contentDigest: string;
                                        } | null;
                                    };
                                    inputs: {
                                        /** Format: uuid */
                                        workRevision: string;
                                        inputDigest: string;
                                        sourceResultDigest: string;
                                        acceptanceDigest: string;
                                        utilityRef: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        };
                                        valueEvidenceRef: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        } | null;
                                        moduleRef: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        } | null;
                                    };
                                    expectedResult: {
                                        /** @enum {string} */
                                        kind: "MODULE_PROPOSAL" | "NUMERICAL_VALUES" | "INDEPENDENT_ACCEPTANCE_CHECKS" | "NATIVE_MODULE_PROPOSAL" | "SOURCE_OBJECT_INSPECTION";
                                        outputKeys: string[];
                                        qualification: string;
                                    };
                                    checker: {
                                        /** @enum {string} */
                                        owner: "P1" | "M2";
                                        /** @enum {string} */
                                        method: "POSTGRES_NUMERIC_ACCEPTED_EXPRESSION" | "BOUNDED_TYPED_MODULE_PROPOSAL" | "EXACT_SOURCE_ENTITY_PERIOD_UNIT_DIGEST";
                                        acceptanceDigest: string;
                                        /** @constant */
                                        independentlyAcceptedRequired: true;
                                    };
                                    resources: {
                                        /** Format: uuid */
                                        episodeId: string;
                                        /** Format: date-time */
                                        deadlineAt: string;
                                        maxAttempts: number;
                                        maxSteps: number;
                                        maxCandidates: number;
                                        maxUnits: number;
                                        maxParallel: number;
                                        selectedUnitSteps: number;
                                        currentGrant: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        };
                                        sourcePermissionsRef: string;
                                    };
                                    admission: {
                                        /** @enum {string} */
                                        logicalState: "QUEUED" | "RUNNING";
                                        physicalState: string;
                                        attemptId: string | null;
                                        producerAdmission: null;
                                        /** @constant */
                                        executionAuthorityGranted: false;
                                    };
                                    estimate: {
                                        lossUnit: string;
                                        expectedGain: number | null;
                                        conditionalGain: number | null;
                                        completionProbability: number | null;
                                        acceptanceProbability: number | null;
                                        knownNativeCost: number | null;
                                        delayLoss: number | null;
                                        completionDelayMs: number | null;
                                        costUSD: null;
                                        /** @enum {string} */
                                        support: "PUBLIC_MODEL_RELATIVE_DIAGNOSTIC" | "FINITE_CONDITIONAL_ONLY" | "UNAVAILABLE";
                                        evidenceRef: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        } | null;
                                        /** @constant */
                                        nonadditiveChain: true;
                                    };
                                    correlation: {
                                        premiseDigest: string;
                                        equivalenceGroup: string;
                                        /** @constant */
                                        independentPremises: 1;
                                        /** @enum {string} */
                                        novelty: "INDEPENDENT_NUMERICAL_CHECK" | "MATERIAL_SOURCE_QUERY" | "PROCEDURAL_ALTERNATIVE" | "UNVERIFIED_PROPOSAL" | "CONTROLLER_ONLY";
                                    };
                                    lifecycle: {
                                        /** @constant */
                                        cancelPath: "/api/company-brain/deliberation-cancel";
                                        /** @constant */
                                        reconcilePath: "/api/company-brain/deliberation-reconcile";
                                        /** @constant */
                                        retry: "ORIGINAL_EPISODE_ONLY_RECONCILE_UNKNOWN_BEFORE_ANY_RETRY";
                                        /** @constant */
                                        latePublication: "FENCED_COST_ONLY";
                                        /** @constant */
                                        newBudgetGranted: false;
                                    };
                                }[];
                                marginalValueEvidence: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                }[];
                                utilityConversion: {
                                    ref: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    };
                                    unit: string;
                                    /** @constant */
                                    scope: "PUBLIC_FINITE_ACCEPTED_OUTPUT_MECHANICS";
                                    lossWithoutQualifiedResult: number;
                                    lossWithQualifiedResult: number;
                                    nativeAttemptCost: number;
                                    controllerMsCost: number;
                                    delayMsCost: number;
                                    /** @constant */
                                    qualification: "SUPPLIED_MODEL_RELATIVE_UTILITY_NOT_BILLING_OR_FIELD_WEALTH";
                                } | null;
                                qualifications: string[];
                                frontier: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                incumbent: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                } | null;
                                stop: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                outstandingCosts: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                ownerRequests: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                }[];
                                projection: {
                                    frontier: {
                                        candidateId: string;
                                        /** Format: uuid */
                                        unitId: string;
                                        kind: string;
                                        status: string;
                                        premiseDigest: string;
                                        moduleId: string | null;
                                        prerequisites: string[];
                                        accepted: boolean;
                                        /** @enum {string} */
                                        support: "INDEPENDENT_CURRENT_SQL_CHECK" | "UNVERIFIED" | "COST_ONLY";
                                        completion: boolean;
                                        resultDigest: string | null;
                                        programmeRef: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        };
                                        businessProgramRef: null;
                                        challengeRef: null;
                                        /** @enum {string} */
                                        candidateRole: "P1_PROCEDURE" | "M2_CONTROLLER" | "SOURCE_OBLIGATION";
                                        equivalenceGroup: string;
                                        representation: string | null;
                                        decisionLoss: {
                                            unit: string;
                                            lower: number | null;
                                            upper: number | null;
                                            /** @enum {string} */
                                            kind: "OWNER_FINITE_ACCEPTED_OUTPUT_INTERVAL" | "UNAVAILABLE";
                                            provenance: {
                                                owner: string;
                                                id: string;
                                                version: string;
                                                contentDigest: string;
                                            } | null;
                                            /** @constant */
                                            fieldValueQualified: false;
                                        };
                                        independentChecks: {
                                            id: string;
                                            /** @constant */
                                            method: "POSTGRES_NUMERIC_ACCEPTED_EXPRESSION";
                                            /** @enum {string} */
                                            status: "PASS" | "FAIL";
                                            expected: string;
                                            actual: string | null;
                                            unit: string;
                                            currencyCode: string | null;
                                            /** @constant */
                                            qualification: "FINITE_ACCEPTED_EXPRESSION_NOT_BUSINESS_PREMISE_OR_SEALED_EVALUATION";
                                        }[];
                                        unresolvedPremises: string[];
                                        remainingCosts: {
                                            nativeAttemptsLower: number;
                                            costUSD: null;
                                            delayLoss: number | null;
                                            /** @constant */
                                            priceStatus: "UNKNOWN_UNRECONCILED";
                                        };
                                    }[];
                                    incumbent: {
                                        moduleId: string;
                                        /** Format: uuid */
                                        unitId: string;
                                        values: {
                                            [key: string]: {
                                                value: string;
                                                semantics: {
                                                    entityType: string;
                                                    /** Format: uuid */
                                                    entityId: string;
                                                    /** Format: date-time */
                                                    periodStart: string;
                                                    /** Format: date-time */
                                                    periodEnd: string;
                                                    /** @enum {string} */
                                                    unit: "currency" | "count" | "ratio" | "multiple" | "rate";
                                                    currencyCode: string | null;
                                                    /** @enum {string} */
                                                    frequency: "annual" | "quarterly" | "monthly" | "instant" | "daily" | "weekly" | "event";
                                                    /** @enum {string} */
                                                    calendar: "OWNER_RECORDED" | "GREGORIAN";
                                                    /** @enum {string} */
                                                    consolidation: "OWNER_SUBJECT_ONLY" | "CONSOLIDATED" | "STANDALONE";
                                                    instrument: string;
                                                    /** @enum {string} */
                                                    scale: "1" | "1000" | "1000000";
                                                    /** @enum {string} */
                                                    sign: "AS_RECORDED" | "NEGATE";
                                                };
                                                /** @constant */
                                                truthClass: "DERIVED_VALUE";
                                                witnessIds: string[];
                                            };
                                        };
                                        checks: {
                                            id: string;
                                            /** @constant */
                                            method: "POSTGRES_NUMERIC_ACCEPTED_EXPRESSION";
                                            /** @enum {string} */
                                            status: "PASS" | "FAIL";
                                            expected: string;
                                            actual: string | null;
                                            unit: string;
                                            currencyCode: string | null;
                                            /** @constant */
                                            qualification: "FINITE_ACCEPTED_EXPRESSION_NOT_BUSINESS_PREMISE_OR_SEALED_EVALUATION";
                                        }[];
                                        sourceResultDigest: string;
                                        inputDigest: string;
                                        acceptanceDigest: string;
                                    } | null;
                                    stop: {
                                        heuristic: boolean;
                                        reason: string | null;
                                        /** @constant */
                                        technicalOnly: true;
                                        /** @constant */
                                        businessSelectionOwner: "S4";
                                        bound: {
                                            upper: number;
                                            unit: string;
                                            /** @constant */
                                            scope: "PUBLIC_FINITE_ACCEPTED_OUTPUT_MECHANICS";
                                            allAvailableChainsEnumerated: boolean;
                                            evidenceRef: {
                                                owner: string;
                                                id: string;
                                                version: string;
                                                contentDigest: string;
                                            };
                                        } | null;
                                        remainingPredicates: string[];
                                    };
                                    outstandingCosts: {
                                        /** @constant */
                                        owner: "P2";
                                        /** Format: uuid */
                                        ledgerSearchId: string;
                                        /** @constant */
                                        retained: true;
                                        usd: null;
                                        /** @constant */
                                        status: "UNKNOWN_UNRECONCILED";
                                        physicalAttempts: number;
                                        controllerRuns: number;
                                        controllerElapsedMs: number;
                                        controllerCpuMicros: number;
                                        sunkUtilityCost: number | null;
                                        /** @constant */
                                        sunkChargedAgain: false;
                                        attempts: {
                                            /** Format: uuid */
                                            attemptId: string;
                                            /** Format: uuid */
                                            unitId: string;
                                            status: string;
                                            disposition: string;
                                            /** @constant */
                                            liabilityRetained: true;
                                            /** @constant */
                                            mayRetry: false;
                                            submittedAt: string | null;
                                            endpointKey: string | null;
                                        }[];
                                        history: {
                                            /** Format: uuid */
                                            attemptId: string;
                                            /** Format: uuid */
                                            unitId: string;
                                            status: string;
                                            receiptDigest: string;
                                            chargedNativeAttempts: number;
                                            steps: number;
                                            requestedRoute: string;
                                            requestedModel: string | null;
                                            actualProvider: string | null;
                                            actualModel: string | null;
                                            usage: {
                                                inputTokens: number;
                                                outputTokens: number;
                                            } | null;
                                            elapsedMs: number | null;
                                            submittedAt: string | null;
                                            physicalOutcome: string | null;
                                            /** @enum {string} */
                                            responsibility: "AWAIT_RETURN" | "RECONCILE_UNKNOWN" | "RETAIN_USAGE_AND_RECONCILE_BILLING";
                                            /** @constant */
                                            liabilityRetained: true;
                                            /** @constant */
                                            refundGranted: false;
                                            costUSD: null;
                                            invoiceRef: null;
                                            corrections: {
                                                owner: string;
                                                id: string;
                                                version: string;
                                                contentDigest: string;
                                            }[];
                                        }[];
                                        preparation: {
                                            ref: {
                                                owner: string;
                                                id: string;
                                                version: string;
                                                contentDigest: string;
                                            };
                                            /** @enum {string} */
                                            kind: "M2_REGISTERED_SEMANTIC_COMPILATION" | "BOUNDED_PUBLIC_DEVELOPMENT_FIT_CALIBRATION_AND_EVALUATION";
                                            elapsedMs: number;
                                            cpuMicros: number;
                                            costUSD: null;
                                            /** @constant */
                                            chargedAsEpisodeAttempt: false;
                                            /** @constant */
                                            accounting: "SHARED_OR_DEVELOPMENT_PREPARATION_NONADDITIVE_NOT_S5_FUNDING";
                                        }[];
                                        originalParentCostWitness: {
                                            digest: string;
                                            attempts: number;
                                            steps: number;
                                            wallMs: number;
                                            nativeInvocationCount: number;
                                            modelInvocationCount: number;
                                        };
                                        /** @constant */
                                        accountingScope: "P2_ATTEMPTS_OVERLAP_P1_PARENT_NOT_SUMMED_PREPARATION_NONADDITIVE";
                                        unknownCosts: string[];
                                        /** @constant */
                                        externalEffectOwner: "S6";
                                    };
                                };
                            };
                            planRef: {
                                owner: string;
                                id: string;
                                version: string;
                                contentDigest: string;
                            };
                            /** @constant */
                            protectedAdmission: false;
                        };
                    };
                };
                /** @description Original owner-bound ordinary work accepted without protected authority */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict bounded contract or deadline rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Indistinguishable absent or unauthorized private resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole deadline exhausted; underlying SQL/body IO cancelled where supported */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Current source, owner, module, grant, or supported-domain predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/deliberation-resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description Whole transport time attenuation; never a new compute or funding grant */
                    "x-deliberation-deadline-ms"?: number;
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        searchId: string;
                    };
                };
            };
            responses: {
                /** @description Exact authenticated current M2 artifact or bounded development receipt */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @constant */
                            schema: "finnor.m2.current-reader.v1";
                            /** Format: uuid */
                            searchId: string;
                            /** Format: uuid */
                            programId: string;
                            /** @enum {string} */
                            status: "ACCEPTED" | "RUNNING" | "WAITING" | "STOPPED" | "FAILED" | "CANCELLED" | "INVALIDATED";
                            reason: string | null;
                            policy: {
                                /** @constant */
                                schema: "finnor.deliberation-policy.v1";
                                ref: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                /** @constant */
                                version: "m2-bounded-deliberation-v1";
                                status: string;
                                envelope: {
                                    /** @constant */
                                    schema: "finnor.m2.producer-envelope.v1";
                                    /** Format: uuid */
                                    id: string;
                                    revision: number;
                                    /** Format: uuid */
                                    tenantId: string;
                                    /** Format: uuid */
                                    principalId: string;
                                    work: {
                                        /** Format: uuid */
                                        id: string;
                                        /** Format: uuid */
                                        revision: string;
                                        inputDigest: string;
                                        /** Format: uuid */
                                        planRevisionId: string;
                                    };
                                    mandateRef: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    };
                                    parents: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    }[];
                                    inputs: {
                                        kind: string;
                                        digest: string;
                                        /** Format: date-time */
                                        knownAt: string;
                                    }[];
                                    rightsRef: string;
                                    ownerRevisionVector: {
                                        owner: string;
                                        ref: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        };
                                    }[];
                                    producerAdmission: null;
                                    /** @constant */
                                    executionAuthorityGranted: false;
                                    codeDigest: string;
                                    runtime: {
                                        node: string;
                                        binaryDigest: string;
                                        imageDigest: null;
                                        /** @constant */
                                        kind: "REGISTERED_BOUNDED_VM_NO_PROTECTED_ISOLATION";
                                    };
                                    actualInvocations: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    }[];
                                    domain: string;
                                    invalidationKeys: string[];
                                    currentGrant: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    };
                                    costLedger: {
                                        /** @constant */
                                        owner: "P2";
                                        /** Format: uuid */
                                        searchId: string;
                                        physicalAttempts: number;
                                        controllerRuns: number;
                                        usd: null;
                                    };
                                    /** @enum {string} */
                                    state: "PROPOSED" | "TESTED" | "ADMITTED" | "INVALIDATED" | "FAILED";
                                };
                                policyRequest: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                computeGrant: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                metacontroller: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                nextWork: {
                                    /** Format: uuid */
                                    unitId: string;
                                    /** @enum {string} */
                                    kind: "CONTROL_M2" | "EXECUTE_P1" | "VERIFY_P1" | "MODEL_REFINE" | "INSPECT_SOURCE";
                                    meaning: string;
                                    prerequisites: string[];
                                    /** @constant */
                                    owner: "P2";
                                    routeIds: string[];
                                    target: {
                                        programmeRef: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        };
                                        root: {
                                            /** @enum {string} */
                                            entityType: "pe_strategy" | "pe_opportunity" | "pe_deal" | "pe_fund" | "pe_vehicle" | "external_organization" | "pe_portfolio_holding";
                                            /** Format: uuid */
                                            entityId: string;
                                        };
                                        sourceInspectionRef: {
                                            /** Format: uuid */
                                            sourceId: string;
                                            /** Format: uuid */
                                            versionId: string;
                                            contentDigest: string;
                                        } | null;
                                    };
                                    inputs: {
                                        /** Format: uuid */
                                        workRevision: string;
                                        inputDigest: string;
                                        sourceResultDigest: string;
                                        acceptanceDigest: string;
                                        utilityRef: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        };
                                        valueEvidenceRef: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        } | null;
                                        moduleRef: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        } | null;
                                    };
                                    expectedResult: {
                                        /** @enum {string} */
                                        kind: "MODULE_PROPOSAL" | "NUMERICAL_VALUES" | "INDEPENDENT_ACCEPTANCE_CHECKS" | "NATIVE_MODULE_PROPOSAL" | "SOURCE_OBJECT_INSPECTION";
                                        outputKeys: string[];
                                        qualification: string;
                                    };
                                    checker: {
                                        /** @enum {string} */
                                        owner: "P1" | "M2";
                                        /** @enum {string} */
                                        method: "POSTGRES_NUMERIC_ACCEPTED_EXPRESSION" | "BOUNDED_TYPED_MODULE_PROPOSAL" | "EXACT_SOURCE_ENTITY_PERIOD_UNIT_DIGEST";
                                        acceptanceDigest: string;
                                        /** @constant */
                                        independentlyAcceptedRequired: true;
                                    };
                                    resources: {
                                        /** Format: uuid */
                                        episodeId: string;
                                        /** Format: date-time */
                                        deadlineAt: string;
                                        maxAttempts: number;
                                        maxSteps: number;
                                        maxCandidates: number;
                                        maxUnits: number;
                                        maxParallel: number;
                                        selectedUnitSteps: number;
                                        currentGrant: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        };
                                        sourcePermissionsRef: string;
                                    };
                                    admission: {
                                        /** @enum {string} */
                                        logicalState: "QUEUED" | "RUNNING";
                                        physicalState: string;
                                        attemptId: string | null;
                                        producerAdmission: null;
                                        /** @constant */
                                        executionAuthorityGranted: false;
                                    };
                                    estimate: {
                                        lossUnit: string;
                                        expectedGain: number | null;
                                        conditionalGain: number | null;
                                        completionProbability: number | null;
                                        acceptanceProbability: number | null;
                                        knownNativeCost: number | null;
                                        delayLoss: number | null;
                                        completionDelayMs: number | null;
                                        costUSD: null;
                                        /** @enum {string} */
                                        support: "PUBLIC_MODEL_RELATIVE_DIAGNOSTIC" | "FINITE_CONDITIONAL_ONLY" | "UNAVAILABLE";
                                        evidenceRef: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        } | null;
                                        /** @constant */
                                        nonadditiveChain: true;
                                    };
                                    correlation: {
                                        premiseDigest: string;
                                        equivalenceGroup: string;
                                        /** @constant */
                                        independentPremises: 1;
                                        /** @enum {string} */
                                        novelty: "INDEPENDENT_NUMERICAL_CHECK" | "MATERIAL_SOURCE_QUERY" | "PROCEDURAL_ALTERNATIVE" | "UNVERIFIED_PROPOSAL" | "CONTROLLER_ONLY";
                                    };
                                    lifecycle: {
                                        /** @constant */
                                        cancelPath: "/api/company-brain/deliberation-cancel";
                                        /** @constant */
                                        reconcilePath: "/api/company-brain/deliberation-reconcile";
                                        /** @constant */
                                        retry: "ORIGINAL_EPISODE_ONLY_RECONCILE_UNKNOWN_BEFORE_ANY_RETRY";
                                        /** @constant */
                                        latePublication: "FENCED_COST_ONLY";
                                        /** @constant */
                                        newBudgetGranted: false;
                                    };
                                }[];
                                marginalValueEvidence: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                }[];
                                utilityConversion: {
                                    ref: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    };
                                    unit: string;
                                    /** @constant */
                                    scope: "PUBLIC_FINITE_ACCEPTED_OUTPUT_MECHANICS";
                                    lossWithoutQualifiedResult: number;
                                    lossWithQualifiedResult: number;
                                    nativeAttemptCost: number;
                                    controllerMsCost: number;
                                    delayMsCost: number;
                                    /** @constant */
                                    qualification: "SUPPLIED_MODEL_RELATIVE_UTILITY_NOT_BILLING_OR_FIELD_WEALTH";
                                } | null;
                                qualifications: string[];
                                frontier: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                incumbent: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                } | null;
                                stop: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                outstandingCosts: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                ownerRequests: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                }[];
                                projection: {
                                    frontier: {
                                        candidateId: string;
                                        /** Format: uuid */
                                        unitId: string;
                                        kind: string;
                                        status: string;
                                        premiseDigest: string;
                                        moduleId: string | null;
                                        prerequisites: string[];
                                        accepted: boolean;
                                        /** @enum {string} */
                                        support: "INDEPENDENT_CURRENT_SQL_CHECK" | "UNVERIFIED" | "COST_ONLY";
                                        completion: boolean;
                                        resultDigest: string | null;
                                        programmeRef: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        };
                                        businessProgramRef: null;
                                        challengeRef: null;
                                        /** @enum {string} */
                                        candidateRole: "P1_PROCEDURE" | "M2_CONTROLLER" | "SOURCE_OBLIGATION";
                                        equivalenceGroup: string;
                                        representation: string | null;
                                        decisionLoss: {
                                            unit: string;
                                            lower: number | null;
                                            upper: number | null;
                                            /** @enum {string} */
                                            kind: "OWNER_FINITE_ACCEPTED_OUTPUT_INTERVAL" | "UNAVAILABLE";
                                            provenance: {
                                                owner: string;
                                                id: string;
                                                version: string;
                                                contentDigest: string;
                                            } | null;
                                            /** @constant */
                                            fieldValueQualified: false;
                                        };
                                        independentChecks: {
                                            id: string;
                                            /** @constant */
                                            method: "POSTGRES_NUMERIC_ACCEPTED_EXPRESSION";
                                            /** @enum {string} */
                                            status: "PASS" | "FAIL";
                                            expected: string;
                                            actual: string | null;
                                            unit: string;
                                            currencyCode: string | null;
                                            /** @constant */
                                            qualification: "FINITE_ACCEPTED_EXPRESSION_NOT_BUSINESS_PREMISE_OR_SEALED_EVALUATION";
                                        }[];
                                        unresolvedPremises: string[];
                                        remainingCosts: {
                                            nativeAttemptsLower: number;
                                            costUSD: null;
                                            delayLoss: number | null;
                                            /** @constant */
                                            priceStatus: "UNKNOWN_UNRECONCILED";
                                        };
                                    }[];
                                    incumbent: {
                                        moduleId: string;
                                        /** Format: uuid */
                                        unitId: string;
                                        values: {
                                            [key: string]: {
                                                value: string;
                                                semantics: {
                                                    entityType: string;
                                                    /** Format: uuid */
                                                    entityId: string;
                                                    /** Format: date-time */
                                                    periodStart: string;
                                                    /** Format: date-time */
                                                    periodEnd: string;
                                                    /** @enum {string} */
                                                    unit: "currency" | "count" | "ratio" | "multiple" | "rate";
                                                    currencyCode: string | null;
                                                    /** @enum {string} */
                                                    frequency: "annual" | "quarterly" | "monthly" | "instant" | "daily" | "weekly" | "event";
                                                    /** @enum {string} */
                                                    calendar: "OWNER_RECORDED" | "GREGORIAN";
                                                    /** @enum {string} */
                                                    consolidation: "OWNER_SUBJECT_ONLY" | "CONSOLIDATED" | "STANDALONE";
                                                    instrument: string;
                                                    /** @enum {string} */
                                                    scale: "1" | "1000" | "1000000";
                                                    /** @enum {string} */
                                                    sign: "AS_RECORDED" | "NEGATE";
                                                };
                                                /** @constant */
                                                truthClass: "DERIVED_VALUE";
                                                witnessIds: string[];
                                            };
                                        };
                                        checks: {
                                            id: string;
                                            /** @constant */
                                            method: "POSTGRES_NUMERIC_ACCEPTED_EXPRESSION";
                                            /** @enum {string} */
                                            status: "PASS" | "FAIL";
                                            expected: string;
                                            actual: string | null;
                                            unit: string;
                                            currencyCode: string | null;
                                            /** @constant */
                                            qualification: "FINITE_ACCEPTED_EXPRESSION_NOT_BUSINESS_PREMISE_OR_SEALED_EVALUATION";
                                        }[];
                                        sourceResultDigest: string;
                                        inputDigest: string;
                                        acceptanceDigest: string;
                                    } | null;
                                    stop: {
                                        heuristic: boolean;
                                        reason: string | null;
                                        /** @constant */
                                        technicalOnly: true;
                                        /** @constant */
                                        businessSelectionOwner: "S4";
                                        bound: {
                                            upper: number;
                                            unit: string;
                                            /** @constant */
                                            scope: "PUBLIC_FINITE_ACCEPTED_OUTPUT_MECHANICS";
                                            allAvailableChainsEnumerated: boolean;
                                            evidenceRef: {
                                                owner: string;
                                                id: string;
                                                version: string;
                                                contentDigest: string;
                                            };
                                        } | null;
                                        remainingPredicates: string[];
                                    };
                                    outstandingCosts: {
                                        /** @constant */
                                        owner: "P2";
                                        /** Format: uuid */
                                        ledgerSearchId: string;
                                        /** @constant */
                                        retained: true;
                                        usd: null;
                                        /** @constant */
                                        status: "UNKNOWN_UNRECONCILED";
                                        physicalAttempts: number;
                                        controllerRuns: number;
                                        controllerElapsedMs: number;
                                        controllerCpuMicros: number;
                                        sunkUtilityCost: number | null;
                                        /** @constant */
                                        sunkChargedAgain: false;
                                        attempts: {
                                            /** Format: uuid */
                                            attemptId: string;
                                            /** Format: uuid */
                                            unitId: string;
                                            status: string;
                                            disposition: string;
                                            /** @constant */
                                            liabilityRetained: true;
                                            /** @constant */
                                            mayRetry: false;
                                            submittedAt: string | null;
                                            endpointKey: string | null;
                                        }[];
                                        history: {
                                            /** Format: uuid */
                                            attemptId: string;
                                            /** Format: uuid */
                                            unitId: string;
                                            status: string;
                                            receiptDigest: string;
                                            chargedNativeAttempts: number;
                                            steps: number;
                                            requestedRoute: string;
                                            requestedModel: string | null;
                                            actualProvider: string | null;
                                            actualModel: string | null;
                                            usage: {
                                                inputTokens: number;
                                                outputTokens: number;
                                            } | null;
                                            elapsedMs: number | null;
                                            submittedAt: string | null;
                                            physicalOutcome: string | null;
                                            /** @enum {string} */
                                            responsibility: "AWAIT_RETURN" | "RECONCILE_UNKNOWN" | "RETAIN_USAGE_AND_RECONCILE_BILLING";
                                            /** @constant */
                                            liabilityRetained: true;
                                            /** @constant */
                                            refundGranted: false;
                                            costUSD: null;
                                            invoiceRef: null;
                                            corrections: {
                                                owner: string;
                                                id: string;
                                                version: string;
                                                contentDigest: string;
                                            }[];
                                        }[];
                                        preparation: {
                                            ref: {
                                                owner: string;
                                                id: string;
                                                version: string;
                                                contentDigest: string;
                                            };
                                            /** @enum {string} */
                                            kind: "M2_REGISTERED_SEMANTIC_COMPILATION" | "BOUNDED_PUBLIC_DEVELOPMENT_FIT_CALIBRATION_AND_EVALUATION";
                                            elapsedMs: number;
                                            cpuMicros: number;
                                            costUSD: null;
                                            /** @constant */
                                            chargedAsEpisodeAttempt: false;
                                            /** @constant */
                                            accounting: "SHARED_OR_DEVELOPMENT_PREPARATION_NONADDITIVE_NOT_S5_FUNDING";
                                        }[];
                                        originalParentCostWitness: {
                                            digest: string;
                                            attempts: number;
                                            steps: number;
                                            wallMs: number;
                                            nativeInvocationCount: number;
                                            modelInvocationCount: number;
                                        };
                                        /** @constant */
                                        accountingScope: "P2_ATTEMPTS_OVERLAP_P1_PARENT_NOT_SUMMED_PREPARATION_NONADDITIVE";
                                        unknownCosts: string[];
                                        /** @constant */
                                        externalEffectOwner: "S6";
                                    };
                                };
                            };
                            planRef: {
                                owner: string;
                                id: string;
                                version: string;
                                contentDigest: string;
                            };
                            /** @constant */
                            protectedAdmission: false;
                        };
                    };
                };
                /** @description Original owner-bound ordinary work accepted without protected authority */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict bounded contract or deadline rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Indistinguishable absent or unauthorized private resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole deadline exhausted; underlying SQL/body IO cancelled where supported */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Current source, owner, module, grant, or supported-domain predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/deliberation-reconcile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description Whole transport time attenuation; never a new compute or funding grant */
                    "x-deliberation-deadline-ms"?: number;
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        searchId: string;
                    };
                };
            };
            responses: {
                /** @description Exact authenticated current M2 artifact or bounded development receipt */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            /** @constant */
                            schema: "finnor.m2.current-reader.v1";
                            /** Format: uuid */
                            searchId: string;
                            /** Format: uuid */
                            programId: string;
                            /** @enum {string} */
                            status: "ACCEPTED" | "RUNNING" | "WAITING" | "STOPPED" | "FAILED" | "CANCELLED" | "INVALIDATED";
                            reason: string | null;
                            policy: {
                                /** @constant */
                                schema: "finnor.deliberation-policy.v1";
                                ref: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                /** @constant */
                                version: "m2-bounded-deliberation-v1";
                                status: string;
                                envelope: {
                                    /** @constant */
                                    schema: "finnor.m2.producer-envelope.v1";
                                    /** Format: uuid */
                                    id: string;
                                    revision: number;
                                    /** Format: uuid */
                                    tenantId: string;
                                    /** Format: uuid */
                                    principalId: string;
                                    work: {
                                        /** Format: uuid */
                                        id: string;
                                        /** Format: uuid */
                                        revision: string;
                                        inputDigest: string;
                                        /** Format: uuid */
                                        planRevisionId: string;
                                    };
                                    mandateRef: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    };
                                    parents: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    }[];
                                    inputs: {
                                        kind: string;
                                        digest: string;
                                        /** Format: date-time */
                                        knownAt: string;
                                    }[];
                                    rightsRef: string;
                                    ownerRevisionVector: {
                                        owner: string;
                                        ref: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        };
                                    }[];
                                    producerAdmission: null;
                                    /** @constant */
                                    executionAuthorityGranted: false;
                                    codeDigest: string;
                                    runtime: {
                                        node: string;
                                        binaryDigest: string;
                                        imageDigest: null;
                                        /** @constant */
                                        kind: "REGISTERED_BOUNDED_VM_NO_PROTECTED_ISOLATION";
                                    };
                                    actualInvocations: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    }[];
                                    domain: string;
                                    invalidationKeys: string[];
                                    currentGrant: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    };
                                    costLedger: {
                                        /** @constant */
                                        owner: "P2";
                                        /** Format: uuid */
                                        searchId: string;
                                        physicalAttempts: number;
                                        controllerRuns: number;
                                        usd: null;
                                    };
                                    /** @enum {string} */
                                    state: "PROPOSED" | "TESTED" | "ADMITTED" | "INVALIDATED" | "FAILED";
                                };
                                policyRequest: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                computeGrant: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                metacontroller: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                nextWork: {
                                    /** Format: uuid */
                                    unitId: string;
                                    /** @enum {string} */
                                    kind: "CONTROL_M2" | "EXECUTE_P1" | "VERIFY_P1" | "MODEL_REFINE" | "INSPECT_SOURCE";
                                    meaning: string;
                                    prerequisites: string[];
                                    /** @constant */
                                    owner: "P2";
                                    routeIds: string[];
                                    target: {
                                        programmeRef: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        };
                                        root: {
                                            /** @enum {string} */
                                            entityType: "pe_strategy" | "pe_opportunity" | "pe_deal" | "pe_fund" | "pe_vehicle" | "external_organization" | "pe_portfolio_holding";
                                            /** Format: uuid */
                                            entityId: string;
                                        };
                                        sourceInspectionRef: {
                                            /** Format: uuid */
                                            sourceId: string;
                                            /** Format: uuid */
                                            versionId: string;
                                            contentDigest: string;
                                        } | null;
                                    };
                                    inputs: {
                                        /** Format: uuid */
                                        workRevision: string;
                                        inputDigest: string;
                                        sourceResultDigest: string;
                                        acceptanceDigest: string;
                                        utilityRef: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        };
                                        valueEvidenceRef: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        } | null;
                                        moduleRef: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        } | null;
                                    };
                                    expectedResult: {
                                        /** @enum {string} */
                                        kind: "MODULE_PROPOSAL" | "NUMERICAL_VALUES" | "INDEPENDENT_ACCEPTANCE_CHECKS" | "NATIVE_MODULE_PROPOSAL" | "SOURCE_OBJECT_INSPECTION";
                                        outputKeys: string[];
                                        qualification: string;
                                    };
                                    checker: {
                                        /** @enum {string} */
                                        owner: "P1" | "M2";
                                        /** @enum {string} */
                                        method: "POSTGRES_NUMERIC_ACCEPTED_EXPRESSION" | "BOUNDED_TYPED_MODULE_PROPOSAL" | "EXACT_SOURCE_ENTITY_PERIOD_UNIT_DIGEST";
                                        acceptanceDigest: string;
                                        /** @constant */
                                        independentlyAcceptedRequired: true;
                                    };
                                    resources: {
                                        /** Format: uuid */
                                        episodeId: string;
                                        /** Format: date-time */
                                        deadlineAt: string;
                                        maxAttempts: number;
                                        maxSteps: number;
                                        maxCandidates: number;
                                        maxUnits: number;
                                        maxParallel: number;
                                        selectedUnitSteps: number;
                                        currentGrant: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        };
                                        sourcePermissionsRef: string;
                                    };
                                    admission: {
                                        /** @enum {string} */
                                        logicalState: "QUEUED" | "RUNNING";
                                        physicalState: string;
                                        attemptId: string | null;
                                        producerAdmission: null;
                                        /** @constant */
                                        executionAuthorityGranted: false;
                                    };
                                    estimate: {
                                        lossUnit: string;
                                        expectedGain: number | null;
                                        conditionalGain: number | null;
                                        completionProbability: number | null;
                                        acceptanceProbability: number | null;
                                        knownNativeCost: number | null;
                                        delayLoss: number | null;
                                        completionDelayMs: number | null;
                                        costUSD: null;
                                        /** @enum {string} */
                                        support: "PUBLIC_MODEL_RELATIVE_DIAGNOSTIC" | "FINITE_CONDITIONAL_ONLY" | "UNAVAILABLE";
                                        evidenceRef: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        } | null;
                                        /** @constant */
                                        nonadditiveChain: true;
                                    };
                                    correlation: {
                                        premiseDigest: string;
                                        equivalenceGroup: string;
                                        /** @constant */
                                        independentPremises: 1;
                                        /** @enum {string} */
                                        novelty: "INDEPENDENT_NUMERICAL_CHECK" | "MATERIAL_SOURCE_QUERY" | "PROCEDURAL_ALTERNATIVE" | "UNVERIFIED_PROPOSAL" | "CONTROLLER_ONLY";
                                    };
                                    lifecycle: {
                                        /** @constant */
                                        cancelPath: "/api/company-brain/deliberation-cancel";
                                        /** @constant */
                                        reconcilePath: "/api/company-brain/deliberation-reconcile";
                                        /** @constant */
                                        retry: "ORIGINAL_EPISODE_ONLY_RECONCILE_UNKNOWN_BEFORE_ANY_RETRY";
                                        /** @constant */
                                        latePublication: "FENCED_COST_ONLY";
                                        /** @constant */
                                        newBudgetGranted: false;
                                    };
                                }[];
                                marginalValueEvidence: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                }[];
                                utilityConversion: {
                                    ref: {
                                        owner: string;
                                        id: string;
                                        version: string;
                                        contentDigest: string;
                                    };
                                    unit: string;
                                    /** @constant */
                                    scope: "PUBLIC_FINITE_ACCEPTED_OUTPUT_MECHANICS";
                                    lossWithoutQualifiedResult: number;
                                    lossWithQualifiedResult: number;
                                    nativeAttemptCost: number;
                                    controllerMsCost: number;
                                    delayMsCost: number;
                                    /** @constant */
                                    qualification: "SUPPLIED_MODEL_RELATIVE_UTILITY_NOT_BILLING_OR_FIELD_WEALTH";
                                } | null;
                                qualifications: string[];
                                frontier: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                incumbent: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                } | null;
                                stop: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                outstandingCosts: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                                ownerRequests: {
                                    owner: string;
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                }[];
                                projection: {
                                    frontier: {
                                        candidateId: string;
                                        /** Format: uuid */
                                        unitId: string;
                                        kind: string;
                                        status: string;
                                        premiseDigest: string;
                                        moduleId: string | null;
                                        prerequisites: string[];
                                        accepted: boolean;
                                        /** @enum {string} */
                                        support: "INDEPENDENT_CURRENT_SQL_CHECK" | "UNVERIFIED" | "COST_ONLY";
                                        completion: boolean;
                                        resultDigest: string | null;
                                        programmeRef: {
                                            owner: string;
                                            id: string;
                                            version: string;
                                            contentDigest: string;
                                        };
                                        businessProgramRef: null;
                                        challengeRef: null;
                                        /** @enum {string} */
                                        candidateRole: "P1_PROCEDURE" | "M2_CONTROLLER" | "SOURCE_OBLIGATION";
                                        equivalenceGroup: string;
                                        representation: string | null;
                                        decisionLoss: {
                                            unit: string;
                                            lower: number | null;
                                            upper: number | null;
                                            /** @enum {string} */
                                            kind: "OWNER_FINITE_ACCEPTED_OUTPUT_INTERVAL" | "UNAVAILABLE";
                                            provenance: {
                                                owner: string;
                                                id: string;
                                                version: string;
                                                contentDigest: string;
                                            } | null;
                                            /** @constant */
                                            fieldValueQualified: false;
                                        };
                                        independentChecks: {
                                            id: string;
                                            /** @constant */
                                            method: "POSTGRES_NUMERIC_ACCEPTED_EXPRESSION";
                                            /** @enum {string} */
                                            status: "PASS" | "FAIL";
                                            expected: string;
                                            actual: string | null;
                                            unit: string;
                                            currencyCode: string | null;
                                            /** @constant */
                                            qualification: "FINITE_ACCEPTED_EXPRESSION_NOT_BUSINESS_PREMISE_OR_SEALED_EVALUATION";
                                        }[];
                                        unresolvedPremises: string[];
                                        remainingCosts: {
                                            nativeAttemptsLower: number;
                                            costUSD: null;
                                            delayLoss: number | null;
                                            /** @constant */
                                            priceStatus: "UNKNOWN_UNRECONCILED";
                                        };
                                    }[];
                                    incumbent: {
                                        moduleId: string;
                                        /** Format: uuid */
                                        unitId: string;
                                        values: {
                                            [key: string]: {
                                                value: string;
                                                semantics: {
                                                    entityType: string;
                                                    /** Format: uuid */
                                                    entityId: string;
                                                    /** Format: date-time */
                                                    periodStart: string;
                                                    /** Format: date-time */
                                                    periodEnd: string;
                                                    /** @enum {string} */
                                                    unit: "currency" | "count" | "ratio" | "multiple" | "rate";
                                                    currencyCode: string | null;
                                                    /** @enum {string} */
                                                    frequency: "annual" | "quarterly" | "monthly" | "instant" | "daily" | "weekly" | "event";
                                                    /** @enum {string} */
                                                    calendar: "OWNER_RECORDED" | "GREGORIAN";
                                                    /** @enum {string} */
                                                    consolidation: "OWNER_SUBJECT_ONLY" | "CONSOLIDATED" | "STANDALONE";
                                                    instrument: string;
                                                    /** @enum {string} */
                                                    scale: "1" | "1000" | "1000000";
                                                    /** @enum {string} */
                                                    sign: "AS_RECORDED" | "NEGATE";
                                                };
                                                /** @constant */
                                                truthClass: "DERIVED_VALUE";
                                                witnessIds: string[];
                                            };
                                        };
                                        checks: {
                                            id: string;
                                            /** @constant */
                                            method: "POSTGRES_NUMERIC_ACCEPTED_EXPRESSION";
                                            /** @enum {string} */
                                            status: "PASS" | "FAIL";
                                            expected: string;
                                            actual: string | null;
                                            unit: string;
                                            currencyCode: string | null;
                                            /** @constant */
                                            qualification: "FINITE_ACCEPTED_EXPRESSION_NOT_BUSINESS_PREMISE_OR_SEALED_EVALUATION";
                                        }[];
                                        sourceResultDigest: string;
                                        inputDigest: string;
                                        acceptanceDigest: string;
                                    } | null;
                                    stop: {
                                        heuristic: boolean;
                                        reason: string | null;
                                        /** @constant */
                                        technicalOnly: true;
                                        /** @constant */
                                        businessSelectionOwner: "S4";
                                        bound: {
                                            upper: number;
                                            unit: string;
                                            /** @constant */
                                            scope: "PUBLIC_FINITE_ACCEPTED_OUTPUT_MECHANICS";
                                            allAvailableChainsEnumerated: boolean;
                                            evidenceRef: {
                                                owner: string;
                                                id: string;
                                                version: string;
                                                contentDigest: string;
                                            };
                                        } | null;
                                        remainingPredicates: string[];
                                    };
                                    outstandingCosts: {
                                        /** @constant */
                                        owner: "P2";
                                        /** Format: uuid */
                                        ledgerSearchId: string;
                                        /** @constant */
                                        retained: true;
                                        usd: null;
                                        /** @constant */
                                        status: "UNKNOWN_UNRECONCILED";
                                        physicalAttempts: number;
                                        controllerRuns: number;
                                        controllerElapsedMs: number;
                                        controllerCpuMicros: number;
                                        sunkUtilityCost: number | null;
                                        /** @constant */
                                        sunkChargedAgain: false;
                                        attempts: {
                                            /** Format: uuid */
                                            attemptId: string;
                                            /** Format: uuid */
                                            unitId: string;
                                            status: string;
                                            disposition: string;
                                            /** @constant */
                                            liabilityRetained: true;
                                            /** @constant */
                                            mayRetry: false;
                                            submittedAt: string | null;
                                            endpointKey: string | null;
                                        }[];
                                        history: {
                                            /** Format: uuid */
                                            attemptId: string;
                                            /** Format: uuid */
                                            unitId: string;
                                            status: string;
                                            receiptDigest: string;
                                            chargedNativeAttempts: number;
                                            steps: number;
                                            requestedRoute: string;
                                            requestedModel: string | null;
                                            actualProvider: string | null;
                                            actualModel: string | null;
                                            usage: {
                                                inputTokens: number;
                                                outputTokens: number;
                                            } | null;
                                            elapsedMs: number | null;
                                            submittedAt: string | null;
                                            physicalOutcome: string | null;
                                            /** @enum {string} */
                                            responsibility: "AWAIT_RETURN" | "RECONCILE_UNKNOWN" | "RETAIN_USAGE_AND_RECONCILE_BILLING";
                                            /** @constant */
                                            liabilityRetained: true;
                                            /** @constant */
                                            refundGranted: false;
                                            costUSD: null;
                                            invoiceRef: null;
                                            corrections: {
                                                owner: string;
                                                id: string;
                                                version: string;
                                                contentDigest: string;
                                            }[];
                                        }[];
                                        preparation: {
                                            ref: {
                                                owner: string;
                                                id: string;
                                                version: string;
                                                contentDigest: string;
                                            };
                                            /** @enum {string} */
                                            kind: "M2_REGISTERED_SEMANTIC_COMPILATION" | "BOUNDED_PUBLIC_DEVELOPMENT_FIT_CALIBRATION_AND_EVALUATION";
                                            elapsedMs: number;
                                            cpuMicros: number;
                                            costUSD: null;
                                            /** @constant */
                                            chargedAsEpisodeAttempt: false;
                                            /** @constant */
                                            accounting: "SHARED_OR_DEVELOPMENT_PREPARATION_NONADDITIVE_NOT_S5_FUNDING";
                                        }[];
                                        originalParentCostWitness: {
                                            digest: string;
                                            attempts: number;
                                            steps: number;
                                            wallMs: number;
                                            nativeInvocationCount: number;
                                            modelInvocationCount: number;
                                        };
                                        /** @constant */
                                        accountingScope: "P2_ATTEMPTS_OVERLAP_P1_PARENT_NOT_SUMMED_PREPARATION_NONADDITIVE";
                                        unknownCosts: string[];
                                        /** @constant */
                                        externalEffectOwner: "S6";
                                    };
                                };
                            };
                            planRef: {
                                owner: string;
                                id: string;
                                version: string;
                                contentDigest: string;
                            };
                            /** @constant */
                            protectedAdmission: false;
                        };
                    };
                };
                /** @description Original owner-bound ordinary work accepted without protected authority */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict bounded contract or deadline rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Indistinguishable absent or unauthorized private resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole deadline exhausted; underlying SQL/body IO cancelled where supported */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Current source, owner, module, grant, or supported-domain predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/deliberation-calibrate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description Whole transport time attenuation; never a new compute or funding grant */
                    "x-deliberation-deadline-ms"?: number;
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        root: {
                            /** @enum {string} */
                            entityType: "pe_strategy" | "pe_opportunity" | "pe_deal" | "pe_fund" | "pe_vehicle" | "external_organization" | "pe_portfolio_holding";
                            /** Format: uuid */
                            entityId: string;
                        };
                        /** Format: uuid */
                        workId: string;
                        policyRequest: {
                            owner: string;
                            id: string;
                            version: string;
                            contentDigest: string;
                        };
                        /** Format: uuid */
                        sourceId: string;
                        /** Format: uuid */
                        versionId: string;
                        datasetDigest: string;
                    };
                };
            };
            responses: {
                /** @description Exact authenticated current M2 artifact or bounded development receipt */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Original owner-bound ordinary work accepted without protected authority */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict bounded contract or deadline rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Indistinguishable absent or unauthorized private resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole deadline exhausted; underlying SQL/body IO cancelled where supported */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Current source, owner, module, grant, or supported-domain predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/deliberation-evidence-read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description Whole transport time attenuation; never a new compute or funding grant */
                    "x-deliberation-deadline-ms"?: number;
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        searchId: string;
                        ref: {
                            owner: string;
                            id: string;
                            version: string;
                            contentDigest: string;
                        };
                    };
                };
            };
            responses: {
                /** @description Exact authenticated current M2 artifact or bounded development receipt */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Original owner-bound ordinary work accepted without protected authority */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict bounded contract or deadline rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Indistinguishable absent or unauthorized private resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole deadline exhausted; underlying SQL/body IO cancelled where supported */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Current source, owner, module, grant, or supported-domain predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/deliberation-module-read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: {
                    /** @description Whole transport time attenuation; never a new compute or funding grant */
                    "x-deliberation-deadline-ms"?: number;
                };
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        searchId: string;
                    };
                };
            };
            responses: {
                /** @description Exact authenticated current M2 artifact or bounded development receipt */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            ref: {
                                owner: string;
                                id: string;
                                version: string;
                                contentDigest: string;
                            };
                            body: {
                                /** @constant */
                                schema: "finnor.m2.executable-module.v1";
                                source: string;
                                sourceDigest: string;
                                emitted: string;
                                emittedDigest: string;
                                /** @constant */
                                entrypoint: "deliberate";
                                producerCodeDigest: string;
                                compiler: {
                                    /** @constant */
                                    name: "typescript";
                                    version: string;
                                    implementationDigest: string;
                                    optionsDigest: string;
                                    libraries: {
                                        file: string;
                                        digest: string;
                                    }[];
                                    librariesDigest: string;
                                    diagnostics: string[];
                                };
                                runtime: {
                                    node: string;
                                    binaryDigest: string;
                                    imageDigest: null;
                                    /** @constant */
                                    kind: "REGISTERED_BOUNDED_VM_NO_PROTECTED_ISOLATION";
                                };
                                config: {
                                    /** @constant */
                                    maxUnits: 8;
                                    /** @constant */
                                    maxParallel: 2;
                                    /** @constant */
                                    maxChains: 256;
                                    /** @constant */
                                    executionTimeoutMs: 25;
                                    /** @constant */
                                    maxRuns: 32;
                                    /** @constant */
                                    maxInputBytes: 65536;
                                    /** @constant */
                                    maxOutputBytes: 131072;
                                };
                                /** @constant */
                                featureSchema: "finnor.m2.module-snapshot.v2";
                                /** @constant */
                                estimatorVersion: "m2-stratified-eventual-loss-v1";
                                estimatorConfigDigest: string;
                                hostSourceDigests: {
                                    file: string;
                                    digest: string;
                                }[];
                                producerAdmission: null;
                            } | {
                                /** @constant */
                                schema: "finnor.m2.executable-module.v2";
                                source: string;
                                sourceDigest: string;
                                emitted: string;
                                emittedDigest: string;
                                /** @constant */
                                entrypoint: "deliberate";
                                producerCodeDigest: string;
                                compiler: {
                                    /** @constant */
                                    name: "typescript";
                                    version: string;
                                    implementationDigest: string;
                                    optionsDigest: string;
                                    libraries: {
                                        file: string;
                                        digest: string;
                                    }[];
                                    librariesDigest: string;
                                    diagnostics: string[];
                                };
                                runtime: {
                                    node: string;
                                    binaryDigest: string;
                                    imageDigest: null;
                                    /** @constant */
                                    kind: "REGISTERED_BOUNDED_VM_NO_PROTECTED_ISOLATION";
                                };
                                config: {
                                    /** @constant */
                                    maxUnits: 8;
                                    /** @constant */
                                    maxParallel: 2;
                                    /** @constant */
                                    maxChains: 256;
                                    /** @constant */
                                    executionTimeoutMs: 25;
                                    /** @constant */
                                    maxRuns: 32;
                                    /** @constant */
                                    maxInputBytes: 65536;
                                    /** @constant */
                                    maxOutputBytes: 131072;
                                    /** @constant */
                                    controlUnitLifecycle: "BOUNDED_EPISODE_CONTINUATION";
                                };
                                /** @constant */
                                featureSchema: "finnor.m2.module-snapshot.v2";
                                /** @constant */
                                estimatorVersion: "m2-stratified-eventual-loss-v1";
                                estimatorConfigDigest: string;
                                hostSourceDigests: {
                                    file: string;
                                    digest: string;
                                }[];
                                producerAdmission: null;
                            };
                        };
                    };
                };
                /** @description Original owner-bound ordinary work accepted without protected authority */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict bounded contract or deadline rejected */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Indistinguishable absent or unauthorized private resource */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole deadline exhausted; underlying SQL/body IO cancelled where supported */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Current source, owner, module, grant, or supported-domain predicate unpassed */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/decision-slice-compile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @constant */
                        schema: "finnor.decision-slice-request.v1";
                        /** Format: uuid */
                        workId: string;
                        source: {
                            /** @constant */
                            kind: "UNDERWRITING";
                            /** Format: uuid */
                            investmentCaseId: string;
                            /** Format: uuid */
                            modelVersionId: string;
                            scenarioIds?: string[];
                            /** Format: date-time */
                            worldAt?: string;
                            evidenceDerivationInputs?: {
                                [key: string]: {
                                    /** Format: uuid */
                                    derivationId: string;
                                    output: string;
                                };
                            };
                        } | {
                            /** @constant */
                            kind: "POLICY";
                            policyRefs: {
                                owner: string;
                                id: string;
                                version: string;
                                contentDigest: string;
                            }[];
                            incumbentRef?: {
                                owner: string;
                                id: string;
                                version: string;
                                contentDigest: string;
                            } | null;
                            allocationRef?: {
                                owner: string;
                                id: string;
                                version: string;
                                contentDigest: string;
                            } | null;
                            underwriting?: {
                                /** Format: uuid */
                                investmentCaseId: string;
                                /** Format: uuid */
                                modelVersionId: string;
                                scenarioIds?: string[];
                                /** Format: date-time */
                                worldAt?: string;
                                evidenceDerivationInputs?: {
                                    [key: string]: {
                                        /** Format: uuid */
                                        derivationId: string;
                                        output: string;
                                    };
                                };
                            };
                        } | {
                            /** @constant */
                            kind: "ALLOCATION";
                            allocationRef: {
                                owner: string;
                                id: string;
                                version: string;
                                contentDigest: string;
                            };
                        };
                        /** @enum {string} */
                        purpose: "MODEL_EVIDENCE" | "ACQUISITION" | "FINANCING";
                        financingChange?: boolean;
                        /** Format: date-time */
                        validAt?: string;
                        /** Format: date-time */
                        knowledgeAt?: string;
                        resource: {
                            deadlineMs: number;
                            maxNodes: number;
                            maxBytes: number;
                            maxDemands: number;
                        };
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/decision-slice-read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        sliceRef: {
                            owner: string;
                            id: string;
                            version: string;
                            contentDigest: string;
                        };
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/decision-slice-view": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        sliceRef: {
                            owner: string;
                            id: string;
                            version: string;
                            contentDigest: string;
                        };
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/decision-slice-context": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        sliceRef: {
                            owner: string;
                            id: string;
                            version: string;
                            contentDigest: string;
                        };
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/decision-slice-patch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        sliceRef: {
                            owner: string;
                            id: string;
                            version: string;
                            contentDigest: string;
                        };
                        expectedContextRef: {
                            owner: string;
                            id: string;
                            version: string;
                            contentDigest: string;
                        };
                        patch?: unknown;
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/decision-slice-witness": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        sliceRef: {
                            owner: string;
                            id: string;
                            version: string;
                            contentDigest: string;
                        };
                        variableId: string;
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/decision-slice-consume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        sliceRef: {
                            owner: string;
                            id: string;
                            version: string;
                            contentDigest: string;
                        };
                        /** @enum {string} */
                        use: "DECISION" | "NUMERICAL_ONLY";
                        decision?: unknown;
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/decision-slice-cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        sliceRef: {
                            owner: string;
                            id: string;
                            version: string;
                            contentDigest: string;
                        };
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/decision-slice-recompile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        sliceRef: {
                            owner: string;
                            id: string;
                            version: string;
                            contentDigest: string;
                        };
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/decision-slice-changes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        sliceRef: {
                            owner: string;
                            id: string;
                            version: string;
                            contentDigest: string;
                        };
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/evidence-handles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        root: {
                            /** @enum {string} */
                            entityType: "pe_strategy" | "pe_opportunity" | "pe_deal" | "pe_fund" | "pe_vehicle" | "external_organization" | "pe_portfolio_holding";
                            /** Format: uuid */
                            entityId: string;
                        };
                        /** Format: date-time */
                        validAt?: string;
                        /** Format: date-time */
                        knowledgeAt?: string;
                        inputs: {
                            inputId: string;
                            source: {
                                /** Format: date-time */
                                periodStart: string;
                                /** Format: date-time */
                                periodEnd: string;
                                /** @enum {string} */
                                unit: "currency" | "count" | "ratio" | "multiple" | "rate";
                                currencyCode: string | null;
                                /** @enum {string} */
                                frequency: "annual" | "quarterly" | "monthly" | "instant" | "daily" | "weekly" | "event";
                                /** @enum {string} */
                                calendar: "OWNER_RECORDED" | "GREGORIAN";
                                /** @enum {string} */
                                consolidation: "OWNER_SUBJECT_ONLY" | "CONSOLIDATED" | "STANDALONE";
                                instrument: string;
                                /** @enum {string} */
                                scale: "1" | "1000" | "1000000";
                                /** @enum {string} */
                                sign: "AS_RECORDED" | "NEGATE";
                                /** @constant */
                                kind: "metric";
                                subject: {
                                    /** @enum {string} */
                                    entityType: "pe_strategy" | "pe_opportunity" | "pe_deal" | "pe_fund" | "pe_vehicle" | "external_organization" | "pe_portfolio_holding";
                                    /** Format: uuid */
                                    entityId: string;
                                };
                                metricKey: string;
                            } | {
                                /** Format: date-time */
                                periodStart: string;
                                /** Format: date-time */
                                periodEnd: string;
                                /** @enum {string} */
                                unit: "currency" | "count" | "ratio" | "multiple" | "rate";
                                currencyCode: string | null;
                                /** @enum {string} */
                                frequency: "annual" | "quarterly" | "monthly" | "instant" | "daily" | "weekly" | "event";
                                /** @enum {string} */
                                calendar: "OWNER_RECORDED" | "GREGORIAN";
                                /** @enum {string} */
                                consolidation: "OWNER_SUBJECT_ONLY" | "CONSOLIDATED" | "STANDALONE";
                                instrument: string;
                                /** @enum {string} */
                                scale: "1" | "1000" | "1000000";
                                /** @enum {string} */
                                sign: "AS_RECORDED" | "NEGATE";
                                /** @constant */
                                kind: "artifact";
                                subject: {
                                    /** @enum {string} */
                                    entityType: "pe_strategy" | "pe_opportunity" | "pe_deal" | "pe_fund" | "pe_vehicle" | "external_organization" | "pe_portfolio_holding";
                                    /** Format: uuid */
                                    entityId: string;
                                };
                                /** Format: uuid */
                                documentId: string;
                                /** Format: uuid */
                                documentVersionId: string;
                                metricKey: string;
                                layout: {
                                    /** @enum {string} */
                                    format: "xlsx" | "pdf" | "image";
                                    sheet?: string;
                                    /** @default 1 */
                                    headerRow?: number;
                                    columns?: {
                                        entityId: string;
                                        metricKey: string;
                                        value: string;
                                        periodStart: string;
                                        periodEnd: string;
                                        currencyCode: string;
                                        frequency: string;
                                        unit: string;
                                        calendar: string;
                                        consolidation: string;
                                        instrument: string;
                                        scale: string;
                                        sign: string;
                                    };
                                    /** @constant */
                                    delimiter?: "|";
                                };
                            } | {
                                /** @constant */
                                kind: "derivation";
                                /** Format: uuid */
                                derivationId: string;
                                output: string;
                            } | {
                                /** @constant */
                                kind: "model";
                                subject: {
                                    /** @enum {string} */
                                    entityType: "pe_strategy" | "pe_opportunity" | "pe_deal" | "pe_fund" | "pe_vehicle" | "external_organization" | "pe_portfolio_holding";
                                    /** Format: uuid */
                                    entityId: string;
                                };
                                /** Format: uuid */
                                modelVersionId: string;
                                /** Format: uuid */
                                runId: string;
                                output: string;
                            };
                        }[];
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/evidence-submit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @constant */
                        schema: "finnor.evidence-request.v1";
                        question: string;
                        root: {
                            /** @enum {string} */
                            entityType: "pe_strategy" | "pe_opportunity" | "pe_deal" | "pe_fund" | "pe_vehicle" | "external_organization" | "pe_portfolio_holding";
                            /** Format: uuid */
                            entityId: string;
                        };
                        /** Format: uuid */
                        workId?: string;
                        /** Format: date-time */
                        validAt?: string;
                        /** Format: date-time */
                        knowledgeAt?: string;
                        idempotencyKey: string;
                        /** @enum {string} */
                        mode: "ordinary_disposable" | "protected";
                        inputs: {
                            inputId: string;
                            /** Format: uuid */
                            handleId: string;
                        }[];
                        program: {
                            /** @constant */
                            schema: "finnor.derivation-ir.v1";
                            nodes: ({
                                id: string;
                                /** @constant */
                                op: "source";
                                inputId: string;
                            } | {
                                id: string;
                                /** @constant */
                                op: "unique";
                                input: string;
                            } | {
                                id: string;
                                /** @constant */
                                op: "reconcile";
                                input: string;
                            } | {
                                id: string;
                                /** @constant */
                                op: "filter";
                                input: string;
                                /** @enum {string} */
                                field: "entityId" | "entityType" | "metricKey" | "periodStart" | "periodEnd" | "frequency" | "unit" | "currencyCode" | "calendar" | "consolidation" | "instrument" | "value" | "recordId";
                                /** @enum {string} */
                                predicate: "eq" | "neq" | "lt" | "lte" | "gt" | "gte";
                                value: string;
                            } | {
                                id: string;
                                /** @constant */
                                op: "project";
                                input: string;
                                fields: ("entityId" | "entityType" | "metricKey" | "periodStart" | "periodEnd" | "frequency" | "unit" | "currencyCode" | "calendar" | "consolidation" | "instrument" | "value" | "recordId")[];
                            } | {
                                id: string;
                                /** @constant */
                                op: "join";
                                left: string;
                                right: string;
                                on: ("entityId" | "entityType" | "metricKey" | "periodStart" | "periodEnd" | "frequency" | "unit" | "currencyCode" | "calendar" | "consolidation" | "instrument" | "value" | "recordId")[];
                            } | {
                                id: string;
                                /** @constant */
                                op: "aggregate";
                                input: string;
                                /** @default [] */
                                groupBy?: ("entityId" | "entityType" | "metricKey" | "periodStart" | "periodEnd" | "frequency" | "unit" | "currencyCode" | "calendar" | "consolidation" | "instrument" | "value" | "recordId")[];
                                /** @enum {string} */
                                method: "sum" | "count" | "min" | "max";
                            } | {
                                id: string;
                                /** @constant */
                                op: "add";
                                left: string;
                                right: string;
                                /** @default 18 */
                                decimalPlaces?: number;
                            } | {
                                id: string;
                                /** @constant */
                                op: "subtract";
                                left: string;
                                right: string;
                                /** @default 18 */
                                decimalPlaces?: number;
                            } | {
                                id: string;
                                /** @constant */
                                op: "multiply";
                                left: string;
                                right: string;
                                /** @default 18 */
                                decimalPlaces?: number;
                            } | {
                                id: string;
                                /** @constant */
                                op: "ratio";
                                left: string;
                                right: string;
                                /** @default 18 */
                                decimalPlaces?: number;
                            } | {
                                id: string;
                                /** @constant */
                                op: "growth";
                                left: string;
                                right: string;
                                /** @default 18 */
                                decimalPlaces?: number;
                            })[];
                            outputs: string[];
                        };
                        acceptance: {
                            /** @constant */
                            selectedUniverse: "COMPLETE";
                            /** @constant */
                            absoluteTolerance: "0";
                            materialOutputs: string[];
                        };
                        limits?: {
                            /** @default 1000 */
                            maxRows?: number;
                            /** @default 8388608 */
                            maxBytes?: number;
                            /** @default 30000 */
                            deadlineMs?: number;
                        };
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/evidence-read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        queryId: string;
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/evidence-witness": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        queryId: string;
                        output: string;
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/evidence-replay": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        queryId: string;
                        idempotencyKey: string;
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/evidence-cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        queryId: string;
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/evidence-consume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        investmentCaseId: string;
                        /** Format: uuid */
                        modelVersionId: string;
                        /** Format: date-time */
                        worldAt: string;
                        idempotencyKey: string;
                        /** Format: uuid */
                        workId?: string;
                        bindings: {
                            [key: string]: {
                                /** Format: uuid */
                                derivationId: string;
                                output: string;
                            };
                        };
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/capital-program-submit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @constant */
                        schema: "finnor.capital-program-request.v2";
                        /** Format: uuid */
                        workId: string;
                        idempotencyKey: string;
                        incumbentPolicyRef: {
                            owner: string;
                            id: string;
                            version: string;
                            contentDigest: string;
                        };
                        /** @enum {string} */
                        purpose: "COMMERCIAL" | "ACQUISITION" | "FINANCING";
                        permitted: {
                            actionId: string;
                            exposureId: string;
                            unit: string;
                            terms: string[];
                            startPeriods: number[];
                            structures: ("IMMEDIATE" | "STAGED" | "OBSERVABLE_STAGE" | "INQUIRY_OPTION" | "WAIT_STOP")[];
                            stageFractions: string[];
                            /** @constant */
                            resourceRule: "SCALE_REGISTERED_ACTION_LINEAR";
                            /** @enum {string} */
                            agreement: "UNILATERAL_PROPOSAL" | "COUNTERPARTY_REQUIRED";
                            milestone?: {
                                instrumentId: string;
                                tokens: string[];
                            };
                            inquiryActionId?: string;
                        };
                        financial?: {
                            /** Format: uuid */
                            investmentCaseId: string;
                            /** Format: uuid */
                            modelVersionId: string;
                            nodeId: string;
                            semantics: {
                                entityType: string;
                                /** Format: uuid */
                                entityId: string;
                                /** Format: date-time */
                                periodStart: string;
                                /** Format: date-time */
                                periodEnd: string;
                                /** @enum {string} */
                                unit: "currency" | "count" | "ratio" | "multiple" | "rate";
                                currencyCode: string | null;
                                /** @enum {string} */
                                frequency: "annual" | "quarterly" | "monthly" | "instant" | "daily" | "weekly" | "event";
                                /** @enum {string} */
                                calendar: "OWNER_RECORDED" | "GREGORIAN";
                                /** @enum {string} */
                                consolidation: "OWNER_SUBJECT_ONLY" | "CONSOLIDATED" | "STANDALONE";
                                instrument: string;
                                /** @enum {string} */
                                scale: "1" | "1000" | "1000000";
                                /** @enum {string} */
                                sign: "AS_RECORDED" | "NEGATE";
                            };
                            evidenceDerivationInputs?: {
                                [key: string]: {
                                    /** Format: uuid */
                                    derivationId: string;
                                    output: string;
                                };
                            };
                        };
                        challengeEvidence?: {
                            /** Format: uuid */
                            searchId: string;
                            resultRef: {
                                /** @constant */
                                owner: "M4";
                                id: string;
                                version: string;
                                contentDigest: string;
                            };
                        }[];
                        resource: {
                            deadlineMs: number;
                            maxAttempts: number;
                            maxGenerated: number;
                            maxExpansions: number;
                            maxRefinementSteps: number;
                            maxRefinementDepth: number;
                            maxModuleBytes: number;
                            maxResultBytes: number;
                        };
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/capital-program-read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        queryId: string;
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/capital-program-list": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        workId: string;
                        limit?: number;
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/capital-program-context": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        workId: string;
                        root: {
                            entityType: string;
                            /** Format: uuid */
                            entityId: string;
                        };
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/capital-program-ports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        workId: string;
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/capital-program-witness": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        queryId: string;
                        candidateDigest: string;
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/capital-program-module": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        queryId: string;
                        moduleDigest: string;
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/capital-program-cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        queryId: string;
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/capital-program-resume": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        queryId: string;
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/capital-program-recompile": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        queryId: string;
                        idempotencyKey: string;
                        replacement?: {
                            /** @constant */
                            schema: "finnor.capital-program-request.v2";
                            /** Format: uuid */
                            workId: string;
                            idempotencyKey: string;
                            incumbentPolicyRef: {
                                owner: string;
                                id: string;
                                version: string;
                                contentDigest: string;
                            };
                            /** @enum {string} */
                            purpose: "COMMERCIAL" | "ACQUISITION" | "FINANCING";
                            permitted: {
                                actionId: string;
                                exposureId: string;
                                unit: string;
                                terms: string[];
                                startPeriods: number[];
                                structures: ("IMMEDIATE" | "STAGED" | "OBSERVABLE_STAGE" | "INQUIRY_OPTION" | "WAIT_STOP")[];
                                stageFractions: string[];
                                /** @constant */
                                resourceRule: "SCALE_REGISTERED_ACTION_LINEAR";
                                /** @enum {string} */
                                agreement: "UNILATERAL_PROPOSAL" | "COUNTERPARTY_REQUIRED";
                                milestone?: {
                                    instrumentId: string;
                                    tokens: string[];
                                };
                                inquiryActionId?: string;
                            };
                            financial?: {
                                /** Format: uuid */
                                investmentCaseId: string;
                                /** Format: uuid */
                                modelVersionId: string;
                                nodeId: string;
                                semantics: {
                                    entityType: string;
                                    /** Format: uuid */
                                    entityId: string;
                                    /** Format: date-time */
                                    periodStart: string;
                                    /** Format: date-time */
                                    periodEnd: string;
                                    /** @enum {string} */
                                    unit: "currency" | "count" | "ratio" | "multiple" | "rate";
                                    currencyCode: string | null;
                                    /** @enum {string} */
                                    frequency: "annual" | "quarterly" | "monthly" | "instant" | "daily" | "weekly" | "event";
                                    /** @enum {string} */
                                    calendar: "OWNER_RECORDED" | "GREGORIAN";
                                    /** @enum {string} */
                                    consolidation: "OWNER_SUBJECT_ONLY" | "CONSOLIDATED" | "STANDALONE";
                                    instrument: string;
                                    /** @enum {string} */
                                    scale: "1" | "1000" | "1000000";
                                    /** @enum {string} */
                                    sign: "AS_RECORDED" | "NEGATE";
                                };
                                evidenceDerivationInputs?: {
                                    [key: string]: {
                                        /** Format: uuid */
                                        derivationId: string;
                                        output: string;
                                    };
                                };
                            };
                            challengeEvidence?: {
                                /** Format: uuid */
                                searchId: string;
                                resultRef: {
                                    /** @constant */
                                    owner: "M4";
                                    id: string;
                                    version: string;
                                    contentDigest: string;
                                };
                            }[];
                            resource: {
                                deadlineMs: number;
                                maxAttempts: number;
                                maxGenerated: number;
                                maxExpansions: number;
                                maxRefinementSteps: number;
                                maxRefinementDepth: number;
                                maxModuleBytes: number;
                                maxResultBytes: number;
                            };
                        };
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/capital-program-select": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        queryId: string;
                        candidateDigest: string;
                        idempotencyKey: string;
                        /**
                         * @default OWNER_HANDOFF
                         * @enum {string}
                         */
                        intent?: "MODEL_BRANCH_REVIEW" | "OWNER_HANDOFF";
                    };
                };
            };
            responses: {
                /** @description Authenticated current owner result; model evidence is not execution authority. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded durable Work computation, not admission, reservation or consent. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict owner request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted owner reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Currentness, idempotency or handoff prerequisite changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Whole-request byte or resource bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required owner port, verified evidence or protected authority unavailable. */
                422: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/challenge-submit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @constant */
                        schema: "finnor.m4.challenge-request.v1";
                        /** Format: uuid */
                        workId: string;
                        candidate: {
                            /** @constant */
                            owner: "M3";
                            id: string;
                            version: string;
                            contentDigest: string;
                        };
                        idempotencyKey: string;
                        limits: {
                            deadlineMs: number;
                            maxTargets: number;
                            maxCells: number;
                            maxTrials: number;
                            maxReductions: number;
                            maxWitnesses: number;
                            maxBytes: number;
                        };
                    };
                };
            };
            responses: {
                /** @description Authenticated challenge result, issued history or read-only witness replay; not SAFE or admission. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded challenge or new economic repair request; no renewed parent resources or admission. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict challenge request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted search, owner result or custody reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Current owner, rights, custody, lease or cancellation predicate changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Inherited request resource or byte bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required authentic owner reader unavailable. */
                424: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/counterexample-diagnostic-submit": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** @constant */
                        schema: "finnor.m4.diagnostic-request.v1";
                        /** Format: uuid */
                        workId: string;
                        sliceRef: {
                            owner: string;
                            id: string;
                            version: string;
                            contentDigest: string;
                        };
                        idempotencyKey: string;
                        evaluations: ({
                            /** @constant */
                            kind: "MECHANICAL_BOUND";
                            candidateId: string;
                            nodeId: string;
                            /** @enum {string} */
                            relation: "LTE" | "GTE" | "EQ";
                            value: string;
                            unit: string;
                            currency?: string | null;
                            /** @enum {string} */
                            claimKind: "UNIVERSAL_DETERMINISTIC" | "MODEL_WORST_CASE" | "EXACT_SOURCE" | "EXACT_EFFECT" | "PROBABILITY" | "EXPECTATION" | "CAUSAL" | "EX_ANTE_QUALITY" | "AGREEMENT";
                        } | {
                            /** @constant */
                            kind: "NATIVE_CHECK";
                            candidateId: string;
                            nodeId: string;
                            /** @enum {string} */
                            claimKind: "UNIVERSAL_DETERMINISTIC" | "MODEL_WORST_CASE" | "EXACT_SOURCE" | "EXACT_EFFECT" | "PROBABILITY" | "EXPECTATION" | "CAUSAL" | "EX_ANTE_QUALITY" | "AGREEMENT";
                        } | {
                            /** @constant */
                            kind: "SOURCE_LITERAL";
                            entityType: string;
                            entityId: string;
                            field: string;
                            expected: string | boolean | null;
                            /** @enum {string} */
                            claimKind: "UNIVERSAL_DETERMINISTIC" | "MODEL_WORST_CASE" | "EXACT_SOURCE" | "EXACT_EFFECT" | "PROBABILITY" | "EXPECTATION" | "CAUSAL" | "EX_ANTE_QUALITY" | "AGREEMENT";
                            /** @enum {string} */
                            interpretation: "EXACT_RECORDED_LITERAL" | "LEGAL_MEANING";
                        } | {
                            /** @constant */
                            kind: "P4_TERM";
                            /** Format: uuid */
                            derivationId: string;
                            output: string;
                            expected: string;
                            unit: string;
                            entityType: string;
                            /** Format: uuid */
                            entityId: string;
                            /** @enum {string} */
                            claimKind: "UNIVERSAL_DETERMINISTIC" | "MODEL_WORST_CASE" | "EXACT_SOURCE" | "EXACT_EFFECT" | "PROBABILITY" | "EXPECTATION" | "CAUSAL" | "EX_ANTE_QUALITY" | "AGREEMENT";
                        } | {
                            /** @constant */
                            kind: "ALLOCATION_SELECTION";
                            selectedPolicyIds: string[];
                            /** @enum {string} */
                            claimKind: "UNIVERSAL_DETERMINISTIC" | "MODEL_WORST_CASE" | "EXACT_SOURCE" | "EXACT_EFFECT" | "PROBABILITY" | "EXPECTATION" | "CAUSAL" | "EX_ANTE_QUALITY" | "AGREEMENT";
                        } | {
                            /** @constant */
                            kind: "ALLOCATION_BOUND";
                            bound: string;
                            /** @enum {string} */
                            claimKind: "UNIVERSAL_DETERMINISTIC" | "MODEL_WORST_CASE" | "EXACT_SOURCE" | "EXACT_EFFECT" | "PROBABILITY" | "EXPECTATION" | "CAUSAL" | "EX_ANTE_QUALITY" | "AGREEMENT";
                        } | {
                            /** @constant */
                            kind: "POLICY_BOUND";
                            policyId: string;
                            minimum: string;
                            unit: string;
                            /** @enum {string} */
                            claimKind: "UNIVERSAL_DETERMINISTIC" | "MODEL_WORST_CASE" | "EXACT_SOURCE" | "EXACT_EFFECT" | "PROBABILITY" | "EXPECTATION" | "CAUSAL" | "EX_ANTE_QUALITY" | "AGREEMENT";
                        } | {
                            /** @constant */
                            kind: "EFFECT_FIXTURE";
                            /** @enum {string} */
                            fixture: "CORRECT" | "WRONG_TARGET" | "WRONG_AMOUNT" | "CLEAR" | "UNKNOWN";
                            request: {
                                /** @enum {string} */
                                entityId: "C_01" | "C_010";
                                /** @enum {string} */
                                field: "credit_limit" | "note";
                                /** @enum {string} */
                                operation: "SET" | "CLEAR";
                                value: string | null;
                                /** @enum {string} */
                                unit: "USD" | "TEXT";
                                currency: "USD" | null;
                                idempotencyKey: string;
                            };
                            /** @enum {string} */
                            claimKind: "UNIVERSAL_DETERMINISTIC" | "MODEL_WORST_CASE" | "EXACT_SOURCE" | "EXACT_EFFECT" | "PROBABILITY" | "EXPECTATION" | "CAUSAL" | "EX_ANTE_QUALITY" | "AGREEMENT";
                        })[];
                        domain: {
                            parameters: {
                                candidateId: string;
                                nodeId: string;
                                values: string[];
                            }[];
                            maxCombination: number;
                        };
                        limits: {
                            deadlineMs: number;
                            maxTargets: number;
                            maxCells: number;
                            maxTrials: number;
                            maxReductions: number;
                            maxWitnesses: number;
                            maxBytes: number;
                        };
                    };
                };
            };
            responses: {
                /** @description Authenticated challenge result, issued history or read-only witness replay; not SAFE or admission. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded challenge or new economic repair request; no renewed parent resources or admission. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict challenge request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted search, owner result or custody reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Current owner, rights, custody, lease or cancellation predicate changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Inherited request resource or byte bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required authentic owner reader unavailable. */
                424: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/counterexample-read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        searchId: string;
                        /**
                         * @default CURRENT
                         * @enum {string}
                         */
                        readMode?: "CURRENT" | "ISSUED_HISTORY";
                    };
                };
            };
            responses: {
                /** @description Authenticated challenge result, issued history or read-only witness replay; not SAFE or admission. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded challenge or new economic repair request; no renewed parent resources or admission. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict challenge request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted search, owner result or custody reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Current owner, rights, custody, lease or cancellation predicate changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Inherited request resource or byte bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required authentic owner reader unavailable. */
                424: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/counterexample-currentness": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        searchId: string;
                    };
                };
            };
            responses: {
                /** @description Authenticated challenge result, issued history or read-only witness replay; not SAFE or admission. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded challenge or new economic repair request; no renewed parent resources or admission. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict challenge request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted search, owner result or custody reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Current owner, rights, custody, lease or cancellation predicate changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Inherited request resource or byte bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required authentic owner reader unavailable. */
                424: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/counterexample-view": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        searchId: string;
                        /**
                         * @default CURRENT
                         * @enum {string}
                         */
                        readMode?: "CURRENT" | "ISSUED_HISTORY";
                    };
                };
            };
            responses: {
                /** @description Authenticated challenge result, issued history or read-only witness replay; not SAFE or admission. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded challenge or new economic repair request; no renewed parent resources or admission. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict challenge request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted search, owner result or custody reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Current owner, rights, custody, lease or cancellation predicate changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Inherited request resource or byte bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required authentic owner reader unavailable. */
                424: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/counterexample-ledger": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        searchId: string;
                        /**
                         * @default CURRENT
                         * @enum {string}
                         */
                        readMode?: "CURRENT" | "ISSUED_HISTORY";
                    };
                };
            };
            responses: {
                /** @description Authenticated challenge result, issued history or read-only witness replay; not SAFE or admission. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded challenge or new economic repair request; no renewed parent resources or admission. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict challenge request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted search, owner result or custody reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Current owner, rights, custody, lease or cancellation predicate changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Inherited request resource or byte bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required authentic owner reader unavailable. */
                424: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/counterexample-witness-replay": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        searchId: string;
                        witnessRef: {
                            /** @constant */
                            owner: "M4";
                            id: string;
                            /** @constant */
                            version: "m4-bounded-original-input-v1";
                            contentDigest: string;
                        };
                    };
                };
            };
            responses: {
                /** @description Authenticated challenge result, issued history or read-only witness replay; not SAFE or admission. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded challenge or new economic repair request; no renewed parent resources or admission. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict challenge request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted search, owner result or custody reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Current owner, rights, custody, lease or cancellation predicate changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Inherited request resource or byte bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required authentic owner reader unavailable. */
                424: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/counterexample-cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        searchId: string;
                    };
                };
            };
            responses: {
                /** @description Authenticated challenge result, issued history or read-only witness replay; not SAFE or admission. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded challenge or new economic repair request; no renewed parent resources or admission. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict challenge request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted search, owner result or custody reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Current owner, rights, custody, lease or cancellation predicate changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Inherited request resource or byte bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required authentic owner reader unavailable. */
                424: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/counterexample-repair-request": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        searchId: string;
                        replacement: {
                            /** @constant */
                            schema: "finnor.m4.diagnostic-request.v1";
                            /** Format: uuid */
                            workId: string;
                            sliceRef: {
                                owner: string;
                                id: string;
                                version: string;
                                contentDigest: string;
                            };
                            idempotencyKey: string;
                            evaluations: ({
                                /** @constant */
                                kind: "MECHANICAL_BOUND";
                                candidateId: string;
                                nodeId: string;
                                /** @enum {string} */
                                relation: "LTE" | "GTE" | "EQ";
                                value: string;
                                unit: string;
                                currency?: string | null;
                                /** @enum {string} */
                                claimKind: "UNIVERSAL_DETERMINISTIC" | "MODEL_WORST_CASE" | "EXACT_SOURCE" | "EXACT_EFFECT" | "PROBABILITY" | "EXPECTATION" | "CAUSAL" | "EX_ANTE_QUALITY" | "AGREEMENT";
                            } | {
                                /** @constant */
                                kind: "NATIVE_CHECK";
                                candidateId: string;
                                nodeId: string;
                                /** @enum {string} */
                                claimKind: "UNIVERSAL_DETERMINISTIC" | "MODEL_WORST_CASE" | "EXACT_SOURCE" | "EXACT_EFFECT" | "PROBABILITY" | "EXPECTATION" | "CAUSAL" | "EX_ANTE_QUALITY" | "AGREEMENT";
                            } | {
                                /** @constant */
                                kind: "SOURCE_LITERAL";
                                entityType: string;
                                entityId: string;
                                field: string;
                                expected: string | boolean | null;
                                /** @enum {string} */
                                claimKind: "UNIVERSAL_DETERMINISTIC" | "MODEL_WORST_CASE" | "EXACT_SOURCE" | "EXACT_EFFECT" | "PROBABILITY" | "EXPECTATION" | "CAUSAL" | "EX_ANTE_QUALITY" | "AGREEMENT";
                                /** @enum {string} */
                                interpretation: "EXACT_RECORDED_LITERAL" | "LEGAL_MEANING";
                            } | {
                                /** @constant */
                                kind: "P4_TERM";
                                /** Format: uuid */
                                derivationId: string;
                                output: string;
                                expected: string;
                                unit: string;
                                entityType: string;
                                /** Format: uuid */
                                entityId: string;
                                /** @enum {string} */
                                claimKind: "UNIVERSAL_DETERMINISTIC" | "MODEL_WORST_CASE" | "EXACT_SOURCE" | "EXACT_EFFECT" | "PROBABILITY" | "EXPECTATION" | "CAUSAL" | "EX_ANTE_QUALITY" | "AGREEMENT";
                            } | {
                                /** @constant */
                                kind: "ALLOCATION_SELECTION";
                                selectedPolicyIds: string[];
                                /** @enum {string} */
                                claimKind: "UNIVERSAL_DETERMINISTIC" | "MODEL_WORST_CASE" | "EXACT_SOURCE" | "EXACT_EFFECT" | "PROBABILITY" | "EXPECTATION" | "CAUSAL" | "EX_ANTE_QUALITY" | "AGREEMENT";
                            } | {
                                /** @constant */
                                kind: "ALLOCATION_BOUND";
                                bound: string;
                                /** @enum {string} */
                                claimKind: "UNIVERSAL_DETERMINISTIC" | "MODEL_WORST_CASE" | "EXACT_SOURCE" | "EXACT_EFFECT" | "PROBABILITY" | "EXPECTATION" | "CAUSAL" | "EX_ANTE_QUALITY" | "AGREEMENT";
                            } | {
                                /** @constant */
                                kind: "POLICY_BOUND";
                                policyId: string;
                                minimum: string;
                                unit: string;
                                /** @enum {string} */
                                claimKind: "UNIVERSAL_DETERMINISTIC" | "MODEL_WORST_CASE" | "EXACT_SOURCE" | "EXACT_EFFECT" | "PROBABILITY" | "EXPECTATION" | "CAUSAL" | "EX_ANTE_QUALITY" | "AGREEMENT";
                            } | {
                                /** @constant */
                                kind: "EFFECT_FIXTURE";
                                /** @enum {string} */
                                fixture: "CORRECT" | "WRONG_TARGET" | "WRONG_AMOUNT" | "CLEAR" | "UNKNOWN";
                                request: {
                                    /** @enum {string} */
                                    entityId: "C_01" | "C_010";
                                    /** @enum {string} */
                                    field: "credit_limit" | "note";
                                    /** @enum {string} */
                                    operation: "SET" | "CLEAR";
                                    value: string | null;
                                    /** @enum {string} */
                                    unit: "USD" | "TEXT";
                                    currency: "USD" | null;
                                    idempotencyKey: string;
                                };
                                /** @enum {string} */
                                claimKind: "UNIVERSAL_DETERMINISTIC" | "MODEL_WORST_CASE" | "EXACT_SOURCE" | "EXACT_EFFECT" | "PROBABILITY" | "EXPECTATION" | "CAUSAL" | "EX_ANTE_QUALITY" | "AGREEMENT";
                            })[];
                            domain: {
                                parameters: {
                                    candidateId: string;
                                    nodeId: string;
                                    values: string[];
                                }[];
                                maxCombination: number;
                            };
                            limits: {
                                deadlineMs: number;
                                maxTargets: number;
                                maxCells: number;
                                maxTrials: number;
                                maxReductions: number;
                                maxWitnesses: number;
                                maxBytes: number;
                            };
                        } | {
                            /** @constant */
                            schema: "finnor.m4.challenge-request.v1";
                            /** Format: uuid */
                            workId: string;
                            candidate: {
                                /** @constant */
                                owner: "M3";
                                id: string;
                                version: string;
                                contentDigest: string;
                            };
                            idempotencyKey: string;
                            limits: {
                                deadlineMs: number;
                                maxTargets: number;
                                maxCells: number;
                                maxTrials: number;
                                maxReductions: number;
                                maxWitnesses: number;
                                maxBytes: number;
                            };
                        };
                    };
                };
            };
            responses: {
                /** @description Authenticated challenge result, issued history or read-only witness replay; not SAFE or admission. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded challenge or new economic repair request; no renewed parent resources or admission. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict challenge request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted search, owner result or custody reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Current owner, rights, custody, lease or cancellation predicate changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Inherited request resource or byte bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required authentic owner reader unavailable. */
                424: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/company-brain/counterexample-retention-purge": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: {
                content: {
                    "application/json": {
                        /** Format: uuid */
                        searchId: string;
                    };
                };
            };
            responses: {
                /** @description Authenticated challenge result, issued history or read-only witness replay; not SAFE or admission. */
                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Accepted bounded challenge or new economic repair request; no renewed parent resources or admission. */
                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Strict challenge request schema rejected invalid or unknown input. */
                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Exact permitted search, owner result or custody reference unavailable. */
                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Current owner, rights, custody, lease or cancellation predicate changed. */
                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Inherited request resource or byte bound exhausted. */
                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
                /** @description Required authentic owner reader unavailable. */
                424: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content?: never;
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: never;
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
