# PE Phase 4 deterministic underwriting certification

Generated: 2026-09-09T14:55:51.582Z

- Deterministic result: **PASS — 240/240**
- Live Microsoft/Excel result: **BLOCKED_EXTERNAL_OFFICE_CERTIFICATION**
- Overall result: **BLOCKED_EXTERNAL_OFFICE_CERTIFICATION**
- Migration: **124 through 0126_pe_underwriting_runtime.sql**

P1 InvestmentCase remains the canonical PE business context.

P1 Assumption remains canonical business assumption truth; scenarios do not mutate it.

P4 derived outputs are immutable deterministic calculation results, not Evidence, Assumptions, Decisions or Risks.

P4 owns Private Equity underwriting mathematics independently of Excel and independently of an LLM.

P3 SpreadsheetIR is consumed directly; P4 does not reparse XLSX or create another Artifact system.

Excel recalculation is an independent external calculation comparison, not FINNOR's P4 engine.

Every completed UnderwritingRun pins exact ModelVersion, InputSnapshot, worldAt, engine version, outputs, checks and hashes.

UNKNOWN/STALE/CONFLICTING required inputs never silently become zero or a guessed assumption.

Scenario/Sensitivity overrides never rewrite historical canonical Assumptions.

No separate Document, Evidence, Work, Event, Authority, DecisionReceipt, Source Truth or Reconciliation system was created.

No IC approval, planner action fabric, autonomous analyst workforce, fund/LP model or AWS compute expansion was smuggled into P4.

FINNOR can now deterministically underwrite a PE InvestmentCase from exact source-backed inputs through Sources & Uses, forecast, FCF, debt, exit, MOIC/IRR, scenario and sensitivity, then prove exactly how every output was produced and whether the bound Excel artifact agrees.

## Prerequisites and ownership

- P1: PASS (51/51)
- P2: deterministic PASS (179/179); external status BLOCKED-EXTERNAL-CERTIFICATION
- P3: deterministic PASS (190/190); external status BLOCKED_EXTERNAL_OFFICE_CERTIFICATION
- Historical naming collision: Historical private-equity phase4 action/governance code and tests remain intact. No current release:pe4 package command exists; underwriting uses the unambiguous release:pe-p4-underwriting command so no historical meaning is repurposed.

## Verification commands

| Gate | Result | Tests | Duration | Evidence hash |
|---|---:|---:|---:|---|
| migrationBundle | PASS | — | 233 ms | 61ff99ec1cd774f2 |
| openapi | PASS | — | 1533 ms | 8ae48595faa67518 |
| typecheck | PASS | — | 23074 ms | e3b0c44298fc1c14 |
| authzMatrix | PASS | — | 624 ms | e3b0c44298fc1c14 |
| releaseBoundary | PASS | — | 4909 ms | 7688152d9356d36c |
| p4Unit | PASS | 41 | 6547 ms | 3ac609d17e8a4084 |
| propertyFuzz | PASS | 9 | 6503 ms | 23810053299c2b62 |
| apiFrontendContract | PASS | 10 | 7349 ms | 9c84b58ba8a496a7 |
| fullUnit | PASS | 520 | 86031 ms | f92e0a46cd4baa64 |
| performance | PASS | 8 | 13329 ms | e68a9f9c5573a33e |
| freshMigration | PASS | — | 2179 ms | 3c6d28bf81847ab2 |
| p4Integration | PASS | 11 | 4455 ms | 4f168a4b47973cbf |
| p4Upgrade | PASS | 3 | 5430 ms | ca71cae612a9d3a6 |
| p3Regression | PASS | 13 | 4513 ms | 5a9797f3095f7763 |
| p2Regression | PASS | 33 | 9649 ms | ff94e7e2c2ee0785 |
| p1Regression | PASS | 17 | 7815 ms | 4fe6f170ed7bdf4d |
| historicalPeRegression | PASS | 24 | 17451 ms | 61275b59b7029db3 |
| coreRegression | PASS | 41 | 11602 ms | 1f26bca75f16aba1 |

## Standard LBO v1 capability matrix

| Capability | Status |
|---|---:|
| entry_ev_metric_multiple | SUPPORTED |
| direct_entry_ev | SUPPORTED |
| net_debt_bridge | SUPPORTED |
| transaction_fees | SUPPORTED |
| financing_fees | SUPPORTED |
| sponsor_equity_plug | SUPPORTED |
| rollover | SUPPORTED |
| seller_note | SUPPORTED |
| fixed_rate_debt | SUPPORTED |
| floating_rate_debt | SUPPORTED |
| rate_floor | SUPPORTED |
| cash_interest | SUPPORTED |
| pik | SUPPORTED |
| mandatory_amortization | SUPPORTED |
| revolver | SUPPORTED |
| minimum_cash | SUPPORTED |
| cash_sweep | SUPPORTED |
| average_balance_interest | SUPPORTED |
| circularity | SUPPORTED |
| debt_maturity_refinancing | PARTIAL |
| revenue_growth_model | SUPPORTED |
| ebitda_margin_model | SUPPORTED |
| d_and_a | SUPPORTED |
| cash_taxes | SUPPORTED |
| nol | UNSUPPORTED |
| capex | SUPPORTED |
| nwc | SUPPORTED |
| interim_distributions | SUPPORTED |
| dividend_recap | UNSUPPORTED |
| exit_multiple | SUPPORTED |
| sponsor_ownership | SUPPORTED |
| moic | SUPPORTED |
| periodic_irr | SUPPORTED |
| xirr | SUPPORTED |
| one_way_sensitivity | SUPPORTED |
| two_way_sensitivity | SUPPORTED |
| multi_currency | UNSUPPORTED |
| add_on_acquisitions | UNSUPPORTED |
| management_option_pool | UNSUPPORTED |
| preferred_equity | UNSUPPORTED |
| complex_waterfall | UNSUPPORTED |
| fund_carry | UNSUPPORTED |
| management_fees | UNSUPPORTED |
| lp_returns | UNSUPPORTED |

## Mandatory deterministic ledger

| # | Category | Case | Result | Evidence |
|---:|---|---|---:|---|
| 1 | prerequisite_ownership | P1 canonical PE world and three-root ownership remain available. | PASS | prerequisites, architecture, commands.p1Regression, commands.p2Regression, commands.p3Regression |
| 2 | prerequisite_ownership | P1 temporal state_at and no-hindsight Evidence semantics remain available. | PASS | prerequisites, architecture, commands.p1Regression, commands.p2Regression, commands.p3Regression |
| 3 | prerequisite_ownership | P2 Microsoft source identity, coverage, delta and reconciliation remain one system. | PASS | prerequisites, architecture, commands.p1Regression, commands.p2Regression, commands.p3Regression |
| 4 | prerequisite_ownership | P3 immutable DocumentVersion, SpreadsheetIR and publication truth remain available. | PASS | prerequisites, architecture, commands.p1Regression, commands.p2Regression, commands.p3Regression |
| 5 | prerequisite_ownership | P1 InvestmentCase remains the sole canonical PE business context. | PASS | prerequisites, architecture, commands.p1Regression, commands.p2Regression, commands.p3Regression |
| 6 | prerequisite_ownership | P1 Assumption remains the sole canonical PE business assumption owner. | PASS | prerequisites, architecture, commands.p1Regression, commands.p2Regression, commands.p3Regression |
| 7 | prerequisite_ownership | Core Document and P3 DocumentVersion remain the artifact owners. | PASS | prerequisites, architecture, commands.p1Regression, commands.p2Regression, commands.p3Regression |
| 8 | prerequisite_ownership | Core Evidence and EvidenceVersion remain the evidence owners. | PASS | prerequisites, architecture, commands.p1Regression, commands.p2Regression, commands.p3Regression |
| 9 | prerequisite_ownership | Core Work, BusinessEvent, Authority and DecisionReceipt remain their sole owners. | PASS | prerequisites, architecture, commands.p1Regression, commands.p2Regression, commands.p3Regression |
| 10 | prerequisite_ownership | Historical private-equity Phase 4 action/governance code is not underwriting certification. | PASS | prerequisites, architecture, commands.p1Regression, commands.p2Regression, commands.p3Regression |
| 11 | prerequisite_ownership | The pure underwriting package obeys its architectural import boundary. | PASS | prerequisites, architecture, commands.p1Regression, commands.p2Regression, commands.p3Regression |
| 12 | prerequisite_ownership | No P5 IC semantics, P6 planner actions, P7 workforce or AWS compute expansion was added. | PASS | prerequisites, architecture, commands.p1Regression, commands.p2Regression, commands.p3Regression |
| 13 | decimal_unit_serialization | Canonical financial values use exact base-10 decimal strings. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 14 | decimal_unit_serialization | Locale, currency-symbol, percent-symbol and scaled display strings are rejected by the core. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 15 | decimal_unit_serialization | The decimal runtime freezes 34 significant digits. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 16 | decimal_unit_serialization | The decimal runtime freezes ROUND_HALF_EVEN. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 17 | decimal_unit_serialization | Extreme decimal exponents are bounded and rejected. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 18 | decimal_unit_serialization | NaN and positive/negative Infinity cannot enter an InputSnapshot or result. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 19 | decimal_unit_serialization | Exact zero remains distinct from missing, null and UNKNOWN. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 20 | decimal_unit_serialization | Canonical serialization is independent of object insertion order. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 21 | decimal_unit_serialization | Canonical semantic hashing is stable across equivalent object orderings. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 22 | decimal_unit_serialization | Money nodes require explicit currency identity. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 23 | decimal_unit_serialization | Rates are exact fractions and never ambiguous percentages. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 24 | decimal_unit_serialization | Multiple, ratio, rate, money, count, date, period, boolean and text units remain distinct. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 25 | decimal_unit_serialization | Unit-incompatible arithmetic fails model compilation. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 26 | decimal_unit_serialization | Currency-incompatible arithmetic fails without silent FX conversion. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 27 | decimal_unit_serialization | Series values retain stable exact period IDs and ordering. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 28 | decimal_unit_serialization | Input and result canonical payloads persist exact decimal strings rather than JSON floats. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 29 | model_ir_compiler | UnderwritingModelIR pins schema, model, convention and minimum engine versions. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 30 | model_ir_compiler | Every model node has a stable deterministic ID. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 31 | model_ir_compiler | Input, Constant, Expression, Series, Schedule, Aggregate, Check and Output node kinds are supported. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 32 | model_ir_compiler | Duplicate model node IDs fail compilation. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 33 | model_ir_compiler | Every declared dependency must exist. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 34 | model_ir_compiler | Value-type compatibility is validated before execution. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 35 | model_ir_compiler | Unit compatibility is validated before execution. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 36 | model_ir_compiler | Currency compatibility is validated before execution. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 37 | model_ir_compiler | Period and series-shape compatibility are validated before execution. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 38 | model_ir_compiler | Compiler output has a stable deterministic execution order. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 39 | model_ir_compiler | Undeclared ordinary dependency cycles fail compilation. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 40 | model_ir_compiler | Declared circular blocks require exact membership and iteration order. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 41 | model_ir_compiler | Circular solver tolerances and iteration ceilings are compile-time validated. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 42 | model_ir_compiler | Expression AST depth and supported operations are bounded. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 43 | model_ir_compiler | Model execution cannot use eval, Function, dynamic import, shell, network or user code. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 44 | model_ir_compiler | Model node count and canonical ModelVersion byte size are enforced. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 45 | model_ir_compiler | Model semantic hash excludes database IDs, timestamps and row order. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 46 | model_ir_compiler | ModelVersion diff reports node, dependency, unit, policy, solver, check and convention changes. | PASS | commands.p4Unit, commands.propertyFuzz, architecture |
| 47 | truth_input_no_hindsight | A model input binds to an exact P1 Assumption ID rather than a fuzzy name. | PASS | commands.p4Unit, commands.p4Integration |
| 48 | truth_input_no_hindsight | The InputSnapshot pins the exact canonical Assumption history version used. | PASS | commands.p4Unit, commands.p4Integration |
| 49 | truth_input_no_hindsight | A factual input pins an exact EvidenceVersion and value path. | PASS | commands.p4Unit, commands.p4Integration |
| 50 | truth_input_no_hindsight | Evidence retrieved after worldAt is excluded even when its asOf predates worldAt. | PASS | commands.p4Unit, commands.p4Integration |
| 51 | truth_input_no_hindsight | Evidence with eligible asOf and retrievedAt is available at worldAt. | PASS | commands.p4Unit, commands.p4Integration |
| 52 | truth_input_no_hindsight | A spreadsheet input pins exact DocumentVersion, ArtifactAnchor and anchor hash. | PASS | commands.p4Unit, commands.p4Integration |
| 53 | truth_input_no_hindsight | Formula/cached spreadsheet inputs obey P3 calculation status rather than becoming facts. | PASS | commands.p4Unit, commands.p4Integration |
| 54 | truth_input_no_hindsight | Every resolved input carries an explicit financial truth class. | PASS | commands.p4Unit, commands.p4Integration |
| 55 | truth_input_no_hindsight | A required UNKNOWN input fails closed with UNKNOWN_INPUT. | PASS | commands.p4Unit, commands.p4Integration |
| 56 | truth_input_no_hindsight | A required STALE input fails closed by default. | PASS | commands.p4Unit, commands.p4Integration |
| 57 | truth_input_no_hindsight | STALE is allowed only by the exact InputNode policy and remains labeled STALE. | PASS | commands.p4Unit, commands.p4Integration |
| 58 | truth_input_no_hindsight | A required CONFLICTING input fails closed without choosing a value. | PASS | commands.p4Unit, commands.p4Integration |
| 59 | truth_input_no_hindsight | Missing input never silently coerces to exact zero. | PASS | commands.p4Unit, commands.p4Integration |
| 60 | truth_input_no_hindsight | Input policy enforces allowed truth classes. | PASS | commands.p4Unit, commands.p4Integration |
| 61 | truth_input_no_hindsight | Input policy enforces exact range bounds without inventing PE judgment. | PASS | commands.p4Unit, commands.p4Integration |
| 62 | truth_input_no_hindsight | Every Run distinguishes historical worldAt from current computedAt. | PASS | commands.p4Unit, commands.p4Integration |
| 63 | truth_input_no_hindsight | An old worldAt Run reproduces exactly after current P1 Assumptions change. | PASS | commands.p4Unit, commands.p4Integration |
| 64 | truth_input_no_hindsight | An obsolete exact Assumption binding fails rather than guessing a replacement revision. | PASS | commands.p4Unit, commands.p4Integration |
| 65 | transaction_sources_uses | Entry valuation date is an explicit typed input. | PASS | commands.p4Unit, goldenCorpus |
| 66 | transaction_sources_uses | Metric-times-entry-multiple valuation is explicit and deterministic. | PASS | commands.p4Unit, goldenCorpus |
| 67 | transaction_sources_uses | Direct enterprise-value entry is an explicit alternative method. | PASS | commands.p4Unit, goldenCorpus |
| 68 | transaction_sources_uses | Entry enterprise value and purchase equity value remain distinct. | PASS | commands.p4Unit, goldenCorpus |
| 69 | transaction_sources_uses | Cash acquired is included exactly once in the entry equity bridge. | PASS | commands.p4Unit, goldenCorpus |
| 70 | transaction_sources_uses | Existing debt refinancing is a distinct Use. | PASS | commands.p4Unit, goldenCorpus |
| 71 | transaction_sources_uses | Other debt-like items are explicit and never hidden in net debt. | PASS | commands.p4Unit, goldenCorpus |
| 72 | transaction_sources_uses | Transaction fees are explicit Uses. | PASS | commands.p4Unit, goldenCorpus |
| 73 | transaction_sources_uses | Financing fees are explicit Uses. | PASS | commands.p4Unit, goldenCorpus |
| 74 | transaction_sources_uses | Minimum-cash funding is an explicit Use. | PASS | commands.p4Unit, goldenCorpus |
| 75 | transaction_sources_uses | Rollover equity is an explicit Source and sponsor-equity reduction. | PASS | commands.p4Unit, goldenCorpus |
| 76 | transaction_sources_uses | Seller-note financing is an explicit debt Source when configured. | PASS | commands.p4Unit, goldenCorpus |
| 77 | transaction_sources_uses | Sponsor equity is a deterministic named plug. | PASS | commands.p4Unit, goldenCorpus |
| 78 | transaction_sources_uses | Total Uses is the exact sum of declared Use components. | PASS | commands.p4Unit, goldenCorpus |
| 79 | transaction_sources_uses | Total Sources is the exact sum of debt, rollover and sponsor Sources. | PASS | commands.p4Unit, goldenCorpus |
| 80 | transaction_sources_uses | Sources equals Uses within the declared exact tolerance. | PASS | commands.p4Unit, goldenCorpus |
| 81 | transaction_sources_uses | No unexplained miscellaneous Source or Use is created. | PASS | commands.p4Unit, goldenCorpus |
| 82 | transaction_sources_uses | Underfunded Sources/Uses produces a mandatory failed Check. | PASS | commands.p4Unit, goldenCorpus |
| 83 | transaction_sources_uses | Overfunded Sources/Uses produces a mandatory failed Check. | PASS | commands.p4Unit, goldenCorpus |
| 84 | transaction_sources_uses | Transaction and Sources/Uses outputs retain exact dependency lineage. | PASS | commands.p4Unit, goldenCorpus |
| 85 | operating_forecast_fcf | Annual financial periods have stable IDs, dates, ordinals and fiscal labels. | PASS | commands.p4Unit, goldenCorpus |
| 86 | operating_forecast_fcf | Quarterly financial periods have stable IDs, dates, ordinals and fiscal labels. | PASS | commands.p4Unit, goldenCorpus |
| 87 | operating_forecast_fcf | Monthly financial periods have stable IDs, dates, ordinals and fiscal labels. | PASS | commands.p4Unit, goldenCorpus |
| 88 | operating_forecast_fcf | Revenue supports an explicit forecast series. | PASS | commands.p4Unit, goldenCorpus |
| 89 | operating_forecast_fcf | Revenue supports deterministic prior-period growth. | PASS | commands.p4Unit, goldenCorpus |
| 90 | operating_forecast_fcf | Missing required future revenue fails rather than extrapolating or using zero. | PASS | commands.p4Unit, goldenCorpus |
| 91 | operating_forecast_fcf | EBITDA supports an explicit forecast series. | PASS | commands.p4Unit, goldenCorpus |
| 92 | operating_forecast_fcf | EBITDA supports deterministic Revenue-times-margin derivation. | PASS | commands.p4Unit, goldenCorpus |
| 93 | operating_forecast_fcf | ModelVersion explicitly chooses EBITDA precedence and never silently accepts both methods. | PASS | commands.p4Unit, goldenCorpus |
| 94 | operating_forecast_fcf | Explicit D&A produces EBIT equal to EBITDA less D&A. | PASS | commands.p4Unit, goldenCorpus |
| 95 | operating_forecast_fcf | The declared EBITDA-equals-EBIT convention omits D&A without fabricating it. | PASS | commands.p4Unit, goldenCorpus |
| 96 | operating_forecast_fcf | Capex supports an explicit series. | PASS | commands.p4Unit, goldenCorpus |
| 97 | operating_forecast_fcf | Capex supports a deterministic percentage-of-revenue driver. | PASS | commands.p4Unit, goldenCorpus |
| 98 | operating_forecast_fcf | Capex cash-use sign convention remains explicit. | PASS | commands.p4Unit, goldenCorpus |
| 99 | operating_forecast_fcf | Working capital supports an explicit NWC series. | PASS | commands.p4Unit, goldenCorpus |
| 100 | operating_forecast_fcf | Working capital supports a deterministic percentage-of-revenue driver. | PASS | commands.p4Unit, goldenCorpus |
| 101 | operating_forecast_fcf | Change in NWC uses an explicit cash-flow sign convention. | PASS | commands.p4Unit, goldenCorpus |
| 102 | operating_forecast_fcf | Cash tax uses positive taxable income and an exact zero floor. | PASS | commands.p4Unit, goldenCorpus |
| 103 | operating_forecast_fcf | Unsupported NOL and complex tax behavior is classified rather than approximated. | PASS | commands.p4Unit, goldenCorpus |
| 104 | operating_forecast_fcf | Unlevered FCF is a distinct deterministic bridge. | PASS | commands.p4Unit, goldenCorpus |
| 105 | operating_forecast_fcf | Levered FCF and cash available for sweep remain distinct outputs. | PASS | commands.p4Unit, goldenCorpus |
| 106 | operating_forecast_fcf | Operating forecast and FCF outputs retain exact upstream dependency lineage. | PASS | commands.p4Unit, goldenCorpus |
| 107 | debt_revolver_interest_circularity | Each DebtTranche has stable ID, name, seniority and sweep priority. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 108 | debt_revolver_interest_circularity | Fixed-rate debt uses its exact declared fixed rate. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 109 | debt_revolver_interest_circularity | Floating-rate debt consumes an exact base-rate curve plus spread. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 110 | debt_revolver_interest_circularity | Floating-rate floors are applied before adding the spread. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 111 | debt_revolver_interest_circularity | Base-rate curves require exact input provenance and are never fetched by the core. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 112 | debt_revolver_interest_circularity | Beginning-balance cash-interest basis is supported explicitly. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 113 | debt_revolver_interest_circularity | Average-balance cash-interest basis is supported explicitly. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 114 | debt_revolver_interest_circularity | Average-balance interest circularity exists only in a declared solver block. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 115 | debt_revolver_interest_circularity | Circular solver initial state is explicit and deterministic. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 116 | debt_revolver_interest_circularity | Circular solver iteration order, tolerances and maximum iterations are frozen. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 117 | debt_revolver_interest_circularity | Circular non-convergence returns NON_CONVERGENT and never the last iteration as verified. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 118 | debt_revolver_interest_circularity | Cash interest and PIK interest remain separate outputs. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 119 | debt_revolver_interest_circularity | PIK interest capitalizes into ending principal. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 120 | debt_revolver_interest_circularity | Opening plus draws plus PIK less repayments equals ending debt. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 121 | debt_revolver_interest_circularity | Mandatory amortization supports percentage of original principal. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 122 | debt_revolver_interest_circularity | Mandatory amortization supports an explicit amount series. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 123 | debt_revolver_interest_circularity | Applied amortization clamps only to outstanding principal and exposes the applied amount. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 124 | debt_revolver_interest_circularity | Ending debt principal cannot be negative. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 125 | debt_revolver_interest_circularity | Revolver opening principal and commitment are explicit. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 126 | debt_revolver_interest_circularity | Revolver draw restores the declared minimum-cash balance when capacity permits. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 127 | debt_revolver_interest_circularity | Revolver paydown is explicit and cannot exceed principal. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 128 | debt_revolver_interest_circularity | Ending revolver balance cannot exceed commitment. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 129 | debt_revolver_interest_circularity | Required draw above commitment returns LIQUIDITY_SHORTFALL. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 130 | debt_revolver_interest_circularity | Revolver overflow is surfaced as an exact typed failure/check. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 131 | debt_revolver_interest_circularity | Cash sweep uses only exact available cash above the minimum reserve. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 132 | debt_revolver_interest_circularity | Cash sweep percentage is explicit and bounded. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 133 | debt_revolver_interest_circularity | Cash sweep follows configured seniority/priority waterfall. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 134 | debt_revolver_interest_circularity | No debt paydown exceeds outstanding principal. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 135 | debt_revolver_interest_circularity | Debt at maturity follows explicit mandatory-repayment treatment. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 136 | debt_revolver_interest_circularity | Unsupported maturity/refinancing behavior fails honestly. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 137 | debt_revolver_interest_circularity | Multiple fixed/floating/cash/PIK/revolver tranches coexist deterministically. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 138 | debt_revolver_interest_circularity | Debt roll-forward, capacity, cash, sweep, rate and maturity checks are all mandatory. | PASS | commands.p4Unit, commands.propertyFuzz, commands.performance |
| 139 | exit_returns_irr | Exit period and its exact date are explicit. | PASS | commands.p4Unit, commands.propertyFuzz, goldenCorpus |
| 140 | exit_returns_irr | Exit metric value is an exact deterministic input or derived output. | PASS | commands.p4Unit, commands.propertyFuzz, goldenCorpus |
| 141 | exit_returns_irr | Exit multiple is an explicit exact input. | PASS | commands.p4Unit, commands.propertyFuzz, goldenCorpus |
| 142 | exit_returns_irr | Exit enterprise value equals exit metric times exit multiple. | PASS | commands.p4Unit, commands.propertyFuzz, goldenCorpus |
| 143 | exit_returns_irr | Exit debt uses the exact ending debt schedule. | PASS | commands.p4Unit, commands.propertyFuzz, goldenCorpus |
| 144 | exit_returns_irr | Exit cash uses the exact ending cash schedule. | PASS | commands.p4Unit, commands.propertyFuzz, goldenCorpus |
| 145 | exit_returns_irr | Exit net debt is distinct from enterprise and equity value. | PASS | commands.p4Unit, commands.propertyFuzz, goldenCorpus |
| 146 | exit_returns_irr | Exit adjustments are explicit and source-traceable. | PASS | commands.p4Unit, commands.propertyFuzz, goldenCorpus |
| 147 | exit_returns_irr | Exit equity value reconciles EV less debt plus cash and adjustments. | PASS | commands.p4Unit, commands.propertyFuzz, goldenCorpus |
| 148 | exit_returns_irr | Sponsor proceeds apply exact sponsor ownership rather than assuming 100 percent. | PASS | commands.p4Unit, commands.propertyFuzz, goldenCorpus |
| 149 | exit_returns_irr | Modeled ownership must reconcile to 100 percent where required. | PASS | commands.p4Unit, commands.propertyFuzz, goldenCorpus |
| 150 | exit_returns_irr | Sponsor cash-flow timeline pins exact amount, date, period and flow type. | PASS | commands.p4Unit, commands.propertyFuzz, goldenCorpus |
| 151 | exit_returns_irr | Interim sponsor distributions remain explicit and are not buried in exit proceeds. | PASS | commands.p4Unit, commands.propertyFuzz, goldenCorpus |
| 152 | exit_returns_irr | Gross sponsor MOIC equals positive distributions divided by absolute invested capital. | PASS | commands.p4Unit, commands.propertyFuzz, goldenCorpus |
| 153 | exit_returns_irr | Periodic IRR uses a bounded deterministic solver with undefined/ambiguous root truth. | PASS | commands.p4Unit, commands.propertyFuzz, goldenCorpus |
| 154 | exit_returns_irr | Dated XIRR uses the frozen ACT/365F convention and irregular dates. | PASS | commands.p4Unit, commands.propertyFuzz, goldenCorpus |
| 155 | scenario_sensitivity | Base execution uses zero hidden scenario overrides. | PASS | commands.p4Unit, commands.p4Integration, commands.performance |
| 156 | scenario_sensitivity | Scenario labels have no financial meaning without exact overrides. | PASS | commands.p4Unit, commands.p4Integration, commands.performance |
| 157 | scenario_sensitivity | Scenario definitions are immutable explicit override sets. | PASS | commands.p4Unit, commands.p4Integration, commands.performance |
| 158 | scenario_sensitivity | Scenario semantic hash is deterministic. | PASS | commands.p4Unit, commands.p4Integration, commands.performance |
| 159 | scenario_sensitivity | Scenario revisions preserve explicit parent identity. | PASS | commands.p4Unit, commands.p4Integration, commands.performance |
| 160 | scenario_sensitivity | Scenario targets must be eligible exact InputNodes. | PASS | commands.p4Unit, commands.p4Integration, commands.performance |
| 161 | scenario_sensitivity | Scenario application never mutates the sealed base InputSnapshot. | PASS | commands.p4Unit, commands.p4Integration, commands.performance |
| 162 | scenario_sensitivity | Scenario Run pins exact scenario and result semantic hashes. | PASS | commands.p4Unit, commands.p4Integration, commands.performance |
| 163 | scenario_sensitivity | Run diff reports exact changed inputs, outputs, checks and scenario identity. | PASS | commands.p4Unit, commands.p4Integration, commands.performance |
| 164 | scenario_sensitivity | Affected-node analysis traverses deterministic downstream dependencies without rerunning. | PASS | commands.p4Unit, commands.p4Integration, commands.performance |
| 165 | scenario_sensitivity | One-way sensitivities execute exact axis values. | PASS | commands.p4Unit, commands.p4Integration, commands.performance |
| 166 | scenario_sensitivity | Two-way sensitivities execute exact Cartesian coordinates. | PASS | commands.p4Unit, commands.p4Integration, commands.performance |
| 167 | scenario_sensitivity | Sensitivity axes are generic eligible model InputNodes, not hardcoded buttons. | PASS | commands.p4Unit, commands.p4Integration, commands.performance |
| 168 | scenario_sensitivity | Every sensitivity cell retains exact Run semantic and persisted Run identity. | PASS | commands.p4Unit, commands.p4Integration, commands.performance |
| 169 | scenario_sensitivity | Sensitivity cell row/column ordering is stable. | PASS | commands.p4Unit, commands.p4Integration, commands.performance |
| 170 | scenario_sensitivity | A failed sensitivity cell remains in place with exact failure status and no interpolation. | PASS | commands.p4Unit, commands.p4Integration, commands.performance |
| 171 | scenario_sensitivity | Sensitivity execution rejects more than 2,500 cells. | PASS | commands.p4Unit, commands.p4Integration, commands.performance |
| 172 | scenario_sensitivity | Sensitivity retries converge without duplicate parent or cell rows. | PASS | commands.p4Unit, commands.p4Integration, commands.performance |
| 173 | p3_binding_projection_reconciliation | P4 consumes P3 SpreadsheetIR directly and never reparses XLSX ZIP/XML. | PASS | commands.p4Integration, commands.p3Regression |
| 174 | p3_binding_projection_reconciliation | P4 input bindings pin exact P3 DocumentVersion, node ID and anchor hash. | PASS | commands.p4Integration, commands.p3Regression |
| 175 | p3_binding_projection_reconciliation | P4 output bindings pin exact P3 DocumentVersion, OutputNode and anchor hash. | PASS | commands.p4Integration, commands.p3Regression |
| 176 | p3_binding_projection_reconciliation | Template edits require an append-only binding version and revalidation. | PASS | commands.p4Integration, commands.p3Regression |
| 177 | p3_binding_projection_reconciliation | Stale or missing ArtifactAnchors fail closed. | PASS | commands.p4Integration, commands.p3Regression |
| 178 | p3_binding_projection_reconciliation | Projection compiles through P3 typed ArtifactPatch rather than direct workbook bytes. | PASS | commands.p4Integration, commands.p3Regression |
| 179 | p3_binding_projection_reconciliation | Projection uses an exact base DocumentVersion precondition. | PASS | commands.p4Integration, commands.p3Regression |
| 180 | p3_binding_projection_reconciliation | Successful projection creates a new immutable P3 DocumentVersion. | PASS | commands.p4Integration, commands.p3Regression |
| 181 | p3_binding_projection_reconciliation | P3-operation-before-P4-row crash replay converges to one projection. | PASS | commands.p4Integration, commands.p3Regression |
| 182 | p3_binding_projection_reconciliation | Artifact comparison supports exact-decimal policy. | PASS | commands.p4Integration, commands.p3Regression |
| 183 | p3_binding_projection_reconciliation | Artifact comparison supports declared rounded-value policy. | PASS | commands.p4Integration, commands.p3Regression |
| 184 | p3_binding_projection_reconciliation | Artifact comparison supports explicit absolute-tolerance policy. | PASS | commands.p4Integration, commands.p3Regression |
| 185 | p3_binding_projection_reconciliation | Artifact comparison supports explicit relative-tolerance policy. | PASS | commands.p4Integration, commands.p3Regression |
| 186 | p3_binding_projection_reconciliation | Stale/uncalculated Excel values are never reported as MATCH. | PASS | commands.p4Integration, commands.p3Regression |
| 187 | p3_binding_projection_reconciliation | P4-versus-Excel mismatch is retained without overwriting either truth. | PASS | commands.p4Integration, commands.p3Regression |
| 188 | p3_binding_projection_reconciliation | Microsoft publication/recalculation remains exclusively in P3 authority and read-back flow. | PASS | commands.p4Integration, commands.p3Regression |
| 189 | rls_security | Every P4 persistence relation carries tenant_id. | PASS | databaseInvariants, commands.p4Integration |
| 190 | rls_security | RLS is enabled on every P4 tenant relation. | PASS | databaseInvariants, commands.p4Integration |
| 191 | rls_security | FORCE RLS is enabled on every P4 tenant relation. | PASS | databaseInvariants, commands.p4Integration |
| 192 | rls_security | The application role receives only required SELECT/INSERT P4 privileges. | PASS | databaseInvariants, commands.p4Integration |
| 193 | rls_security | The application role cannot UPDATE immutable P4 history. | PASS | databaseInvariants, commands.p4Integration |
| 194 | rls_security | The application role cannot DELETE immutable P4 history. | PASS | databaseInvariants, commands.p4Integration |
| 195 | rls_security | UnderwritingModel and InvestmentCase references must share one tenant. | PASS | databaseInvariants, commands.p4Integration |
| 196 | rls_security | P1 Assumption bindings must share exact tenant and InvestmentCase root. | PASS | databaseInvariants, commands.p4Integration |
| 197 | rls_security | Cross-tenant EvidenceVersion bindings are rejected. | PASS | databaseInvariants, commands.p4Integration |
| 198 | rls_security | Cross-tenant DocumentVersion/ArtifactAnchor bindings are rejected. | PASS | databaseInvariants, commands.p4Integration |
| 199 | rls_security | Run, Scenario, Sensitivity and ModelVersion composite identities cannot cross tenants. | PASS | databaseInvariants, commands.p4Integration |
| 200 | rls_security | No underwriting row is registered as a duplicate canonical-world owner. | PASS | databaseInvariants, commands.p4Integration |
| 201 | durability_idempotency | UnderwritingModelVersion rows are immutable after insert. | PASS | commands.p4Integration, commands.p4Upgrade |
| 202 | durability_idempotency | Final UnderwritingRun rows are immutable after insert. | PASS | commands.p4Integration, commands.p4Upgrade |
| 203 | durability_idempotency | Run InputSnapshot, outputs, checks, engine and hashes cannot change in place. | PASS | commands.p4Integration, commands.p4Upgrade |
| 204 | durability_idempotency | UnderwritingScenario rows are immutable revisions. | PASS | commands.p4Integration, commands.p4Upgrade |
| 205 | durability_idempotency | Sensitivity parent and cell results are immutable and retain Run IDs. | PASS | commands.p4Integration, commands.p4Upgrade |
| 206 | durability_idempotency | Artifact binding corrections append an incremented binding version. | PASS | commands.p4Integration, commands.p4Upgrade |
| 207 | durability_idempotency | Artifact projection history is immutable. | PASS | commands.p4Integration, commands.p4Upgrade |
| 208 | durability_idempotency | A tampered prepared result hash is rejected before any Run row commits. | PASS | commands.p4Integration, commands.p4Upgrade |
| 209 | durability_idempotency | Failure after calculation before DB commit exposes zero partial completed Run rows. | PASS | commands.p4Integration, commands.p4Upgrade |
| 210 | durability_idempotency | Retry after Run commit returns the same Run and creates no duplicate. | PASS | commands.p4Integration, commands.p4Upgrade |
| 211 | durability_idempotency | Sensitivity retry creates no duplicate parent or completed cell. | PASS | commands.p4Integration, commands.p4Upgrade |
| 212 | durability_idempotency | Underwriting BusinessEvents are bounded metadata and use non-canonical calculation entities. | PASS | commands.p4Integration, commands.p4Upgrade |
| 213 | api_frontend_contract | API financial values use strict decimal-string contracts. | PASS | commands.apiFrontendContract, commands.openapi, architecture |
| 214 | api_frontend_contract | Model and ModelVersion APIs accept only bounded structured ModelIR. | PASS | commands.apiFrontendContract, commands.openapi, architecture |
| 215 | api_frontend_contract | Run API pins exact InvestmentCase, ModelVersion, worldAt and idempotency key. | PASS | commands.apiFrontendContract, commands.openapi, architecture |
| 216 | api_frontend_contract | Scenario API enforces explicit bounded immutable override definitions. | PASS | commands.apiFrontendContract, commands.openapi, architecture |
| 217 | api_frontend_contract | Sensitivity API enforces exact axes, outputs and 2,500-cell bound. | PASS | commands.apiFrontendContract, commands.openapi, architecture |
| 218 | api_frontend_contract | Artifact APIs require exact DocumentVersion and ArtifactAnchor identities. | PASS | commands.apiFrontendContract, commands.openapi, architecture |
| 219 | api_frontend_contract | OpenAPI publishes every typed underwriting capability route. | PASS | commands.apiFrontendContract, commands.openapi, architecture |
| 220 | api_frontend_contract | Every underwriting route authenticates and ignores payload tenant/actor spoofing. | PASS | commands.apiFrontendContract, commands.openapi, architecture |
| 221 | api_frontend_contract | Workspace renders coherent exact Run, ModelVersion, node, unit, currency and period context. | PASS | commands.apiFrontendContract, commands.openapi, architecture |
| 222 | api_frontend_contract | Workspace distinguishes canonical Assumptions, Scenario overrides, P3 projection and Excel comparison. | PASS | commands.apiFrontendContract, commands.openapi, architecture |
| 223 | migration_regression | P4 is a forward migration from the exact P3 head 0125. | PASS | databaseInvariants, commands.p4Upgrade, commands.p1Regression, commands.p2Regression, commands.p3Regression, commands.historicalPeRegression, commands.coreRegression |
| 224 | migration_regression | A fresh database applies all 124 migrations through 0126. | PASS | databaseInvariants, commands.p4Upgrade, commands.p1Regression, commands.p2Regression, commands.p3Regression, commands.historicalPeRegression, commands.coreRegression |
| 225 | migration_regression | Generated migration bundle exactly matches every disk migration byte. | PASS | databaseInvariants, commands.p4Upgrade, commands.p1Regression, commands.p2Regression, commands.p3Regression, commands.historicalPeRegression, commands.coreRegression |
| 226 | migration_regression | Populated P1 Deal, InvestmentCase, Assumption and canonical history survive P4 upgrade exactly. | PASS | databaseInvariants, commands.p4Upgrade, commands.p1Regression, commands.p2Regression, commands.p3Regression, commands.historicalPeRegression, commands.coreRegression |
| 227 | migration_regression | Populated P2 EvidenceVersion, source scope and ExternalRef survive P4 upgrade exactly. | PASS | databaseInvariants, commands.p4Upgrade, commands.p1Regression, commands.p2Regression, commands.p3Regression, commands.historicalPeRegression, commands.coreRegression |
| 228 | migration_regression | Populated P3 DocumentVersion bytes and SpreadsheetIR semantic hash survive exactly. | PASS | databaseInvariants, commands.p4Upgrade, commands.p1Regression, commands.p2Regression, commands.p3Regression, commands.historicalPeRegression, commands.coreRegression |
| 229 | migration_regression | Populated P3 binding, template and publication rows survive exactly. | PASS | databaseInvariants, commands.p4Upgrade, commands.p1Regression, commands.p2Regression, commands.p3Regression, commands.historicalPeRegression, commands.coreRegression |
| 230 | migration_regression | Existing InvestmentCases receive zero fabricated models, scenarios, sensitivities or Runs. | PASS | databaseInvariants, commands.p4Upgrade, commands.p1Regression, commands.p2Regression, commands.p3Regression, commands.historicalPeRegression, commands.coreRegression |
| 231 | migration_regression | P4 migration installs same-tenant constraints, RLS and immutable guards idempotently. | PASS | databaseInvariants, commands.p4Upgrade, commands.p1Regression, commands.p2Regression, commands.p3Regression, commands.historicalPeRegression, commands.coreRegression |
| 232 | migration_regression | P1, P2, P3, historical PE action/governance and Core regression suites remain green. | PASS | databaseInvariants, commands.p4Upgrade, commands.p1Regression, commands.p2Regression, commands.p3Regression, commands.historicalPeRegression, commands.coreRegression |
| 233 | performance_limits | Measured standard ModelIR compile latency remains within its release guardrail. | PASS | commands.performance, commands.p4Integration.benchmark |
| 234 | performance_limits | Measured single standard LBO runtime remains within its release guardrail. | PASS | commands.performance, commands.p4Integration.benchmark |
| 235 | performance_limits | Measured multi-tranche debt-schedule runtime remains within its release guardrail. | PASS | commands.performance, commands.p4Integration.benchmark |
| 236 | performance_limits | Measured average-balance circular solver remains within its release guardrail. | PASS | commands.performance, commands.p4Integration.benchmark |
| 237 | performance_limits | Measured 100-cell sensitivity remains within its release guardrail. | PASS | commands.performance, commands.p4Integration.benchmark |
| 238 | performance_limits | Measured maximum 2,500-cell sensitivity remains within its release guardrail. | PASS | commands.performance, commands.p4Integration.benchmark |
| 239 | performance_limits | Measured canonical serialization/result-hash latency remains within its release guardrail. | PASS | commands.performance, commands.p4Integration.benchmark |
| 240 | performance_limits | Model, period, debt, scenario, sensitivity, solver and payload hard limits are enforced in code. | PASS | commands.performance, commands.p4Integration.benchmark |

## Hard audit map

### EXISTS

- P1 temporal InvestmentCase/Assumption world
- P2 Microsoft Source Truth
- P3 immutable Artifact OS and SpreadsheetIR
- Core Document, Evidence, Work, Event, Authority and DecisionReceipt
- historical action/governance code named Phase 4

### PARTIAL

- Live Microsoft/Excel mapped-workbook parity requires an external configured tenant and delegated profile
- standard LBO debt maturity/refinancing is bounded to mandatory repayment

### WRONG

- fresh databases could install pgcrypto outside public under a persisted role search_path; 0000 now pins the extension to public
- same-client concurrent node-postgres queries in underwriting workspace loading were serialized

### MISSING

- real configured P4 Microsoft/Excel publish, recalculate, read-back and reconciliation evidence

### REUSE

- P1 canonical temporal roots and Assumptions
- P2 provider identities/observations/reconciliation
- P3 DocumentVersion, SpreadsheetIR, ArtifactPatch, publication and read-back
- Core Evidence, Work, BusinessEvent, Authority, DecisionReceipt and queue

### DELETE

- none; no duplicate executable P4 calculation engine was retained

## External gate and remaining blockers

- BLOCKED_EXTERNAL_OFFICE_CERTIFICATION: no complete opt-in real Microsoft tenant/database/source/delegated-profile mapped-workbook evidence was supplied. Deterministic P4 is complete; production must not claim live Excel parity until that separate gate passes.
- Git/remote freshness is not claimed because the cumulative P1-P4 implementation is an intentionally dirty working tree and no network fetch was performed during certification.

P5 handoff: P5 may consume immutable UnderwritingRun outputs, checks, lineage, ModelVersion/InputSnapshot hashes, exact P1/P3 bindings and comparison status. P5 must not recalculate finance, mutate P1 Assumptions, reinterpret UNKNOWN/STALE/CONFLICTING inputs, use Excel as authority, or auto-approve an IC decision.
