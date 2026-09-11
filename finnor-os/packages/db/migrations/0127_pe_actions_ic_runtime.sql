-- P5: Private Equity Action Fabric + governed Investment Committee runtime.
-- P1 remains the sole owner of pe_decisions; Core remains the owner of Work,
-- Evidence, Authority, BusinessEffect/Event and DecisionReceipt; P3 owns artifact
-- versions and P4 owns underwriting runs. These tables preserve IC process truth.

CREATE TABLE finnor_os.pe_ic_committee_config_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  committee_org_unit_id uuid NOT NULL,
  config_version integer NOT NULL CHECK (config_version BETWEEN 1 AND 1000000),
  policy_id uuid NOT NULL,
  policy_version integer NOT NULL CHECK (policy_version BETWEEN 1 AND 1000000),
  policy_revision_id uuid NOT NULL REFERENCES finnor_os.domain_policy_revisions(id),
  policy_snapshot jsonb NOT NULL CHECK (
    jsonb_typeof(policy_snapshot)='object'
    AND policy_snapshot->>'schemaVersion'='pe-ic-policy.v1'
    AND octet_length(policy_snapshot::text)<=32768
  ),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_by uuid NOT NULL,
  authority_decision_id uuid NOT NULL REFERENCES finnor_os.authority_decisions(id),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 240),
  source_system text NOT NULL DEFAULT '@finnor/private-equity' CHECK (length(btrim(source_system)) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,committee_org_unit_id,id),
  UNIQUE (tenant_id,committee_org_unit_id,config_version),
  UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,committee_org_unit_id) REFERENCES finnor_os.org_units(tenant_id,id),
  FOREIGN KEY (tenant_id,policy_id) REFERENCES finnor_os.domain_policies(tenant_id,id),
  FOREIGN KEY (tenant_id,created_by) REFERENCES finnor_os.users(tenant_id,id)
);

CREATE TABLE finnor_os.pe_ic_committee_membership_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  committee_config_version_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  member_role text NOT NULL CHECK (length(btrim(member_role)) BETWEEN 1 AND 80),
  voting_eligible boolean NOT NULL DEFAULT true,
  chair boolean NOT NULL DEFAULT false,
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,committee_config_version_id,employee_id),
  FOREIGN KEY (tenant_id,committee_config_version_id) REFERENCES finnor_os.pe_ic_committee_config_versions(tenant_id,id),
  FOREIGN KEY (tenant_id,employee_id) REFERENCES finnor_os.users(tenant_id,id),
  FOREIGN KEY (tenant_id,created_by) REFERENCES finnor_os.users(tenant_id,id),
  CHECK (effective_until IS NULL OR effective_until>effective_from)
);

CREATE TABLE finnor_os.pe_ic_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  investment_case_id uuid NOT NULL,
  committee_config_version_id uuid NOT NULL,
  scheduled_internal_event_id uuid REFERENCES finnor_os.internal_events(id),
  primary_underwriting_run_id uuid,
  current_memo_id uuid,
  current_deck_id uuid,
  current_recommendation_id uuid,
  reconsiders_decision_id uuid,
  final_decision_id uuid,
  state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN (
    'DRAFT','PREPARING','READY_FOR_REVIEW','QUESTIONS_OPEN','READY_FOR_VOTE','VOTING',
    'CONDITIONS_PENDING','DECIDED','WITHDRAWN','SUPERSEDED','BLOCKED'
  )),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  vote_set_version integer NOT NULL DEFAULT 0 CHECK (vote_set_version>=0),
  voting_basis_version integer CHECK (voting_basis_version IS NULL OR voting_basis_version>=1),
  opened_by uuid NOT NULL,
  opened_authority_decision_id uuid NOT NULL REFERENCES finnor_os.authority_decisions(id),
  voting_opened_by uuid,
  voting_open_authority_decision_id uuid REFERENCES finnor_os.authority_decisions(id),
  voting_open_receipt_id uuid REFERENCES finnor_os.decision_receipts(id),
  voting_open_idempotency_key text CHECK (voting_open_idempotency_key IS NULL OR length(btrim(voting_open_idempotency_key)) BETWEEN 1 AND 240),
  voting_opened_at timestamptz,
  voting_closed_by uuid,
  voting_close_authority_decision_id uuid REFERENCES finnor_os.authority_decisions(id),
  voting_close_receipt_id uuid REFERENCES finnor_os.decision_receipts(id),
  voting_close_idempotency_key text CHECK (voting_close_idempotency_key IS NULL OR length(btrim(voting_close_idempotency_key)) BETWEEN 1 AND 240),
  voting_closed_at timestamptz,
  closed_at timestamptz,
  source_system text NOT NULL DEFAULT '@finnor/private-equity' CHECK (length(btrim(source_system)) BETWEEN 1 AND 160),
  external_id text,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 240),
  observed_at timestamptz,
  created_by text NOT NULL CHECK (length(btrim(created_by)) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,deal_id,investment_case_id,id),
  UNIQUE (tenant_id,idempotency_key),
  UNIQUE (tenant_id,voting_open_idempotency_key),
  UNIQUE (tenant_id,voting_close_idempotency_key),
  FOREIGN KEY (tenant_id,deal_id,investment_case_id) REFERENCES finnor_os.pe_investment_cases(tenant_id,deal_id,id),
  FOREIGN KEY (tenant_id,committee_config_version_id) REFERENCES finnor_os.pe_ic_committee_config_versions(tenant_id,id),
  FOREIGN KEY (tenant_id,investment_case_id,primary_underwriting_run_id) REFERENCES finnor_os.underwriting_runs(tenant_id,investment_case_id,id),
  FOREIGN KEY (tenant_id,deal_id,reconsiders_decision_id) REFERENCES finnor_os.pe_decisions(tenant_id,deal_id,id),
  FOREIGN KEY (tenant_id,deal_id,final_decision_id) REFERENCES finnor_os.pe_decisions(tenant_id,deal_id,id),
  FOREIGN KEY (tenant_id,opened_by) REFERENCES finnor_os.users(tenant_id,id),
  FOREIGN KEY (tenant_id,voting_opened_by) REFERENCES finnor_os.users(tenant_id,id),
  FOREIGN KEY (tenant_id,voting_closed_by) REFERENCES finnor_os.users(tenant_id,id),
  CHECK ((state IN ('DECIDED','SUPERSEDED'))=(final_decision_id IS NOT NULL)),
  CHECK ((voting_opened_by IS NULL)=(voting_open_authority_decision_id IS NULL)),
  CHECK ((voting_opened_by IS NULL)=(voting_basis_version IS NULL)),
  CHECK ((voting_opened_by IS NULL)=(voting_open_receipt_id IS NULL)),
  CHECK ((voting_opened_by IS NULL)=(voting_open_idempotency_key IS NULL)),
  CHECK ((voting_opened_by IS NULL)=(voting_opened_at IS NULL)),
  CHECK ((voting_closed_by IS NULL)=(voting_close_authority_decision_id IS NULL)),
  CHECK ((voting_closed_by IS NULL)=(voting_close_receipt_id IS NULL)),
  CHECK ((voting_closed_by IS NULL)=(voting_close_idempotency_key IS NULL)),
  CHECK ((voting_closed_by IS NULL)=(voting_closed_at IS NULL)),
  CHECK ((state IN ('DECIDED','WITHDRAWN','SUPERSEDED'))=(closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX pe_ic_cases_one_live_process_idx
  ON finnor_os.pe_ic_cases(tenant_id,investment_case_id)
  WHERE state NOT IN ('DECIDED','WITHDRAWN','SUPERSEDED');

CREATE TABLE finnor_os.pe_ic_memos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  investment_case_id uuid NOT NULL,
  ic_case_id uuid NOT NULL,
  artifact_role text NOT NULL CHECK (artifact_role IN ('MEMO','DECK')),
  document_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  underwriting_run_id uuid,
  evidence_cutoff_at timestamptz NOT NULL,
  source_completeness text NOT NULL CHECK (source_completeness IN ('COMPLETE','INCOMPLETE','CONFLICTING','UNKNOWN')),
  change_classification text NOT NULL CHECK (change_classification IN ('INITIAL','MATERIAL','NON_MATERIAL','MANUAL_REVIEW_REQUIRED')),
  semantic_checks jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(semantic_checks)='object' AND octet_length(semantic_checks::text)<=32768),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 20),
  supersedes_memo_id uuid,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 240),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,ic_case_id,id),
  UNIQUE (tenant_id,ic_case_id,artifact_role,revision),
  UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,deal_id,investment_case_id,ic_case_id) REFERENCES finnor_os.pe_ic_cases(tenant_id,deal_id,investment_case_id,id),
  FOREIGN KEY (tenant_id,document_id,document_version_id) REFERENCES finnor_os.document_versions(tenant_id,document_id,id),
  FOREIGN KEY (tenant_id,investment_case_id,underwriting_run_id) REFERENCES finnor_os.underwriting_runs(tenant_id,investment_case_id,id),
  FOREIGN KEY (tenant_id,ic_case_id,supersedes_memo_id) REFERENCES finnor_os.pe_ic_memos(tenant_id,ic_case_id,id),
  FOREIGN KEY (tenant_id,created_by) REFERENCES finnor_os.users(tenant_id,id),
  CHECK ((revision=1)=(supersedes_memo_id IS NULL)),
  CHECK (evidence_cutoff_at<=created_at)
);

CREATE TABLE finnor_os.pe_ic_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  investment_case_id uuid NOT NULL,
  ic_case_id uuid NOT NULL,
  question text NOT NULL CHECK (length(btrim(question)) BETWEEN 1 AND 10000),
  priority text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH','CRITICAL')),
  required_before_vote boolean NOT NULL DEFAULT false,
  required_before_decision boolean NOT NULL DEFAULT false,
  work_id uuid,
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','ANSWERED','RESOLVED','WAIVED','SUPERSEDED')),
  substantiation_status text NOT NULL DEFAULT 'MISSING' CHECK (substantiation_status IN ('ATTACHED','MISSING','CONFLICTING','STALE','UNKNOWN')),
  answer text CHECK (answer IS NULL OR length(answer) BETWEEN 1 AND 20000),
  raised_by uuid NOT NULL,
  answered_by uuid,
  resolved_by uuid,
  waived_by uuid,
  waiver_reason text CHECK (waiver_reason IS NULL OR length(btrim(waiver_reason)) BETWEEN 1 AND 10000),
  waiver_authority_decision_id uuid REFERENCES finnor_os.authority_decisions(id),
  waiver_decision_receipt_id uuid REFERENCES finnor_os.decision_receipts(id),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  answered_at timestamptz,
  resolved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,ic_case_id,id),
  UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,deal_id,investment_case_id,ic_case_id) REFERENCES finnor_os.pe_ic_cases(tenant_id,deal_id,investment_case_id,id),
  FOREIGN KEY (tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
  FOREIGN KEY (tenant_id,raised_by) REFERENCES finnor_os.users(tenant_id,id),
  FOREIGN KEY (tenant_id,answered_by) REFERENCES finnor_os.users(tenant_id,id),
  FOREIGN KEY (tenant_id,resolved_by) REFERENCES finnor_os.users(tenant_id,id),
  FOREIGN KEY (tenant_id,waived_by) REFERENCES finnor_os.users(tenant_id,id),
  CHECK ((state='OPEN') OR answer IS NOT NULL OR state IN ('WAIVED','SUPERSEDED')),
  CHECK ((state='ANSWERED')=(answered_at IS NOT NULL) OR state IN ('RESOLVED','WAIVED','SUPERSEDED')),
  CHECK ((state IN ('RESOLVED','WAIVED'))=(resolved_at IS NOT NULL)),
  CHECK ((state='WAIVED')=(waived_by IS NOT NULL AND waiver_reason IS NOT NULL AND waiver_authority_decision_id IS NOT NULL AND waiver_decision_receipt_id IS NOT NULL))
);
CREATE INDEX pe_ic_questions_case_state_idx ON finnor_os.pe_ic_questions(tenant_id,ic_case_id,state,priority,created_at,id);

CREATE TABLE finnor_os.pe_ic_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  investment_case_id uuid NOT NULL,
  ic_case_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 20),
  supersedes_recommendation_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('INVEST','DECLINE','DEFER','INVEST_WITH_CONDITIONS','CONTINUE_DILIGENCE')),
  memo_id uuid NOT NULL,
  underwriting_run_id uuid NOT NULL,
  scenario_id uuid,
  rationale text NOT NULL CHECK (length(btrim(rationale)) BETWEEN 1 AND 20000),
  authored_by uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 240),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,ic_case_id,id),
  UNIQUE (tenant_id,ic_case_id,revision),
  UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,deal_id,investment_case_id,ic_case_id) REFERENCES finnor_os.pe_ic_cases(tenant_id,deal_id,investment_case_id,id),
  FOREIGN KEY (tenant_id,ic_case_id,memo_id) REFERENCES finnor_os.pe_ic_memos(tenant_id,ic_case_id,id),
  FOREIGN KEY (tenant_id,investment_case_id,underwriting_run_id) REFERENCES finnor_os.underwriting_runs(tenant_id,investment_case_id,id),
  FOREIGN KEY (tenant_id,ic_case_id,supersedes_recommendation_id) REFERENCES finnor_os.pe_ic_recommendations(tenant_id,ic_case_id,id),
  FOREIGN KEY (tenant_id,authored_by) REFERENCES finnor_os.users(tenant_id,id),
  CHECK ((revision=1)=(supersedes_recommendation_id IS NULL))
);

CREATE TABLE finnor_os.pe_ic_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  investment_case_id uuid NOT NULL,
  ic_case_id uuid NOT NULL,
  recommendation_id uuid NOT NULL,
  memo_id uuid NOT NULL,
  underwriting_run_id uuid NOT NULL,
  voting_basis_version integer NOT NULL CHECK (voting_basis_version>=1),
  employee_id uuid NOT NULL,
  choice text NOT NULL CHECK (choice IN ('APPROVE','REJECT','ABSTAIN','DEFER')),
  rationale text CHECK (rationale IS NULL OR length(btrim(rationale)) BETWEEN 1 AND 10000),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 240),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,ic_case_id,id),
  UNIQUE (tenant_id,recommendation_id,employee_id),
  UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,deal_id,investment_case_id,ic_case_id) REFERENCES finnor_os.pe_ic_cases(tenant_id,deal_id,investment_case_id,id),
  FOREIGN KEY (tenant_id,ic_case_id,recommendation_id) REFERENCES finnor_os.pe_ic_recommendations(tenant_id,ic_case_id,id),
  FOREIGN KEY (tenant_id,ic_case_id,memo_id) REFERENCES finnor_os.pe_ic_memos(tenant_id,ic_case_id,id),
  FOREIGN KEY (tenant_id,investment_case_id,underwriting_run_id) REFERENCES finnor_os.underwriting_runs(tenant_id,investment_case_id,id),
  FOREIGN KEY (tenant_id,employee_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE INDEX pe_ic_votes_case_recommendation_idx ON finnor_os.pe_ic_votes(tenant_id,ic_case_id,recommendation_id,employee_id);

CREATE TABLE finnor_os.pe_ic_dissents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  investment_case_id uuid NOT NULL,
  ic_case_id uuid NOT NULL,
  vote_id uuid NOT NULL,
  recommendation_id uuid NOT NULL,
  memo_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  rationale text NOT NULL CHECK (length(btrim(rationale)) BETWEEN 1 AND 20000),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 240),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,ic_case_id,id),
  UNIQUE (tenant_id,vote_id),
  UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,deal_id,investment_case_id,ic_case_id) REFERENCES finnor_os.pe_ic_cases(tenant_id,deal_id,investment_case_id,id),
  FOREIGN KEY (tenant_id,ic_case_id,vote_id) REFERENCES finnor_os.pe_ic_votes(tenant_id,ic_case_id,id),
  FOREIGN KEY (tenant_id,ic_case_id,recommendation_id) REFERENCES finnor_os.pe_ic_recommendations(tenant_id,ic_case_id,id),
  FOREIGN KEY (tenant_id,ic_case_id,memo_id) REFERENCES finnor_os.pe_ic_memos(tenant_id,ic_case_id,id),
  FOREIGN KEY (tenant_id,employee_id) REFERENCES finnor_os.users(tenant_id,id)
);

CREATE TABLE finnor_os.pe_ic_conditions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  investment_case_id uuid NOT NULL,
  ic_case_id uuid NOT NULL,
  source_recommendation_id uuid NOT NULL,
  source_decision_id uuid,
  condition_type text NOT NULL CHECK (condition_type IN ('PRE_DECISION','POST_DECISION_PRE_SIGNING','PRE_CLOSING','MONITORING')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 500),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 10000),
  owner_employee_id uuid NOT NULL,
  work_id uuid,
  due_at timestamptz,
  required boolean NOT NULL DEFAULT true,
  evidence_required boolean NOT NULL DEFAULT true,
  state text NOT NULL DEFAULT 'PROPOSED' CHECK (state IN ('PROPOSED','ACTIVE','SATISFIED','WAIVED','FAILED','SUPERSEDED')),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  verified_by uuid,
  waiver_reason text CHECK (waiver_reason IS NULL OR length(btrim(waiver_reason)) BETWEEN 1 AND 10000),
  waiver_authority_decision_id uuid REFERENCES finnor_os.authority_decisions(id),
  waiver_decision_receipt_id uuid REFERENCES finnor_os.decision_receipts(id),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 240),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,ic_case_id,id),
  UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,deal_id,investment_case_id,ic_case_id) REFERENCES finnor_os.pe_ic_cases(tenant_id,deal_id,investment_case_id,id),
  FOREIGN KEY (tenant_id,ic_case_id,source_recommendation_id) REFERENCES finnor_os.pe_ic_recommendations(tenant_id,ic_case_id,id),
  FOREIGN KEY (tenant_id,deal_id,source_decision_id) REFERENCES finnor_os.pe_decisions(tenant_id,deal_id,id),
  FOREIGN KEY (tenant_id,owner_employee_id) REFERENCES finnor_os.users(tenant_id,id),
  FOREIGN KEY (tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
  FOREIGN KEY (tenant_id,verified_by) REFERENCES finnor_os.users(tenant_id,id),
  FOREIGN KEY (tenant_id,created_by) REFERENCES finnor_os.users(tenant_id,id),
  CHECK ((state IN ('SATISFIED','WAIVED','FAILED'))=(resolved_at IS NOT NULL)),
  CHECK ((state='WAIVED')=(waiver_reason IS NOT NULL AND waiver_authority_decision_id IS NOT NULL AND waiver_decision_receipt_id IS NOT NULL))
);
CREATE INDEX pe_ic_conditions_case_state_idx ON finnor_os.pe_ic_conditions(tenant_id,ic_case_id,state,condition_type,created_at,id);

-- One bounded semantic link table references existing Core/P1/P3/P4 truth. It
-- contains no copied evidence, artifact bytes, financial values or business facts.
CREATE TABLE finnor_os.pe_ic_source_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  investment_case_id uuid NOT NULL,
  ic_case_id uuid NOT NULL,
  owner_kind text NOT NULL CHECK (owner_kind IN ('QUESTION','RECOMMENDATION','DISSENT','CONDITION')),
  owner_id uuid NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('EVIDENCE_VERSION','ARTIFACT_ANCHOR','UNDERWRITING_RUN','P1_WORLD','IC_QUESTION','PE_RISK','IC_CONDITION')),
  evidence_version_id uuid,
  document_id uuid,
  document_version_id uuid,
  anchor_id text CHECK (anchor_id IS NULL OR length(anchor_id) BETWEEN 1 AND 2048),
  anchor_hash text CHECK (anchor_hash IS NULL OR anchor_hash ~ '^[0-9a-f]{64}$'),
  underwriting_run_id uuid,
  world_entity_type text,
  world_entity_id uuid,
  question_id uuid,
  pe_risk_id uuid,
  condition_id uuid,
  relationship text NOT NULL CHECK (relationship IN ('SUPPORTS','CONTRADICTS','ANSWERS','VERIFIES','REQUIRES','REFERENCES')),
  truth_status text NOT NULL DEFAULT 'ATTACHED' CHECK (truth_status IN ('ATTACHED','CONFLICTING','STALE','UNKNOWN')),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 240),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,deal_id,investment_case_id,ic_case_id) REFERENCES finnor_os.pe_ic_cases(tenant_id,deal_id,investment_case_id,id),
  FOREIGN KEY (tenant_id,document_id,document_version_id) REFERENCES finnor_os.document_versions(tenant_id,document_id,id),
  FOREIGN KEY (tenant_id,investment_case_id,underwriting_run_id) REFERENCES finnor_os.underwriting_runs(tenant_id,investment_case_id,id),
  FOREIGN KEY (tenant_id,ic_case_id,question_id) REFERENCES finnor_os.pe_ic_questions(tenant_id,ic_case_id,id),
  FOREIGN KEY (tenant_id,ic_case_id,condition_id) REFERENCES finnor_os.pe_ic_conditions(tenant_id,ic_case_id,id),
  FOREIGN KEY (tenant_id,created_by) REFERENCES finnor_os.users(tenant_id,id),
  CHECK (
    (source_kind='EVIDENCE_VERSION' AND evidence_version_id IS NOT NULL AND document_id IS NULL AND document_version_id IS NULL AND anchor_id IS NULL AND anchor_hash IS NULL AND underwriting_run_id IS NULL AND world_entity_type IS NULL AND world_entity_id IS NULL AND question_id IS NULL AND pe_risk_id IS NULL AND condition_id IS NULL)
    OR (source_kind='ARTIFACT_ANCHOR' AND evidence_version_id IS NULL AND document_id IS NOT NULL AND document_version_id IS NOT NULL AND anchor_id IS NOT NULL AND anchor_hash IS NOT NULL AND underwriting_run_id IS NULL AND world_entity_type IS NULL AND world_entity_id IS NULL AND question_id IS NULL AND pe_risk_id IS NULL AND condition_id IS NULL)
    OR (source_kind='UNDERWRITING_RUN' AND evidence_version_id IS NULL AND document_id IS NULL AND document_version_id IS NULL AND anchor_id IS NULL AND anchor_hash IS NULL AND underwriting_run_id IS NOT NULL AND world_entity_type IS NULL AND world_entity_id IS NULL AND question_id IS NULL AND pe_risk_id IS NULL AND condition_id IS NULL)
    OR (source_kind='P1_WORLD' AND evidence_version_id IS NULL AND document_id IS NULL AND document_version_id IS NULL AND anchor_id IS NULL AND anchor_hash IS NULL AND underwriting_run_id IS NULL AND world_entity_type IS NOT NULL AND world_entity_id IS NOT NULL AND question_id IS NULL AND pe_risk_id IS NULL AND condition_id IS NULL)
    OR (source_kind='IC_QUESTION' AND evidence_version_id IS NULL AND document_id IS NULL AND document_version_id IS NULL AND anchor_id IS NULL AND anchor_hash IS NULL AND underwriting_run_id IS NULL AND world_entity_type IS NULL AND world_entity_id IS NULL AND question_id IS NOT NULL AND pe_risk_id IS NULL AND condition_id IS NULL)
    OR (source_kind='PE_RISK' AND evidence_version_id IS NULL AND document_id IS NULL AND document_version_id IS NULL AND anchor_id IS NULL AND anchor_hash IS NULL AND underwriting_run_id IS NULL AND world_entity_type IS NULL AND world_entity_id IS NULL AND question_id IS NULL AND pe_risk_id IS NOT NULL AND condition_id IS NULL)
    OR (source_kind='IC_CONDITION' AND evidence_version_id IS NULL AND document_id IS NULL AND document_version_id IS NULL AND anchor_id IS NULL AND anchor_hash IS NULL AND underwriting_run_id IS NULL AND world_entity_type IS NULL AND world_entity_id IS NULL AND question_id IS NULL AND pe_risk_id IS NULL AND condition_id IS NOT NULL)
  )
);
CREATE INDEX pe_ic_source_links_owner_idx ON finnor_os.pe_ic_source_links(tenant_id,owner_kind,owner_id,created_at,id);
CREATE UNIQUE INDEX pe_ic_source_links_semantic_identity_idx ON finnor_os.pe_ic_source_links(
  tenant_id,owner_kind,owner_id,source_kind,evidence_version_id,document_id,document_version_id,
  anchor_id,anchor_hash,underwriting_run_id,world_entity_type,world_entity_id,question_id,pe_risk_id,
  condition_id,relationship
) NULLS NOT DISTINCT;

CREATE TABLE finnor_os.pe_ic_decision_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  investment_case_id uuid NOT NULL,
  ic_case_id uuid NOT NULL,
  case_version integer NOT NULL CHECK (case_version>=1),
  vote_set_version integer NOT NULL CHECK (vote_set_version>=0),
  committee_config_version_id uuid NOT NULL,
  recommendation_id uuid NOT NULL,
  memo_id uuid NOT NULL,
  underwriting_run_id uuid NOT NULL,
  aggregation jsonb NOT NULL CHECK (aggregation->>'schemaVersion'='pe-ic-aggregation.v1' AND octet_length(aggregation::text)<=262144),
  vote_snapshot jsonb NOT NULL CHECK (jsonb_typeof(vote_snapshot)='array' AND jsonb_array_length(vote_snapshot)<=50 AND octet_length(vote_snapshot::text)<=131072),
  dissent_snapshot jsonb NOT NULL CHECK (jsonb_typeof(dissent_snapshot)='array' AND jsonb_array_length(dissent_snapshot)<=50 AND octet_length(dissent_snapshot::text)<=262144),
  question_snapshot jsonb NOT NULL CHECK (jsonb_typeof(question_snapshot)='array' AND jsonb_array_length(question_snapshot)<=100 AND octet_length(question_snapshot::text)<=262144),
  condition_snapshot jsonb NOT NULL CHECK (jsonb_typeof(condition_snapshot)='array' AND jsonb_array_length(condition_snapshot)<=50 AND octet_length(condition_snapshot::text)<=131072),
  process_status text NOT NULL CHECK (process_status IN ('PROCESS_ELIGIBLE','BLOCKED')),
  proposed_outcome text CHECK (proposed_outcome IS NULL OR proposed_outcome IN ('INVEST','DECLINE','DEFER','INVEST_WITH_CONDITIONS','CONTINUE_DILIGENCE')),
  proposed_decision jsonb NOT NULL CHECK (jsonb_typeof(proposed_decision)='object' AND octet_length(proposed_decision::text)<=32768),
  input_hash text NOT NULL CHECK (input_hash ~ '^sha256:[0-9a-f]{64}$'),
  provenance_hash text NOT NULL CHECK (provenance_hash ~ '^sha256:[0-9a-f]{64}$'),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 240),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,ic_case_id,id),
  UNIQUE (tenant_id,ic_case_id,input_hash),
  UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,deal_id,investment_case_id,ic_case_id) REFERENCES finnor_os.pe_ic_cases(tenant_id,deal_id,investment_case_id,id),
  FOREIGN KEY (tenant_id,committee_config_version_id) REFERENCES finnor_os.pe_ic_committee_config_versions(tenant_id,id),
  FOREIGN KEY (tenant_id,ic_case_id,recommendation_id) REFERENCES finnor_os.pe_ic_recommendations(tenant_id,ic_case_id,id),
  FOREIGN KEY (tenant_id,ic_case_id,memo_id) REFERENCES finnor_os.pe_ic_memos(tenant_id,ic_case_id,id),
  FOREIGN KEY (tenant_id,investment_case_id,underwriting_run_id) REFERENCES finnor_os.underwriting_runs(tenant_id,investment_case_id,id),
  FOREIGN KEY (tenant_id,created_by) REFERENCES finnor_os.users(tenant_id,id),
  CHECK ((process_status='PROCESS_ELIGIBLE')=(proposed_outcome IS NOT NULL))
);

CREATE TABLE finnor_os.pe_ic_decision_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  investment_case_id uuid NOT NULL,
  ic_case_id uuid NOT NULL,
  decision_proposal_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  authority_decision_id uuid NOT NULL REFERENCES finnor_os.authority_decisions(id),
  decision_receipt_id uuid NOT NULL REFERENCES finnor_os.decision_receipts(id),
  finalized_by uuid NOT NULL,
  finalized_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,ic_case_id,id),
  UNIQUE (tenant_id,ic_case_id),
  UNIQUE (tenant_id,decision_proposal_id),
  UNIQUE (tenant_id,decision_id),
  UNIQUE (tenant_id,decision_receipt_id),
  FOREIGN KEY (tenant_id,deal_id,investment_case_id,ic_case_id) REFERENCES finnor_os.pe_ic_cases(tenant_id,deal_id,investment_case_id,id),
  FOREIGN KEY (tenant_id,ic_case_id,decision_proposal_id) REFERENCES finnor_os.pe_ic_decision_proposals(tenant_id,ic_case_id,id),
  FOREIGN KEY (tenant_id,deal_id,decision_id) REFERENCES finnor_os.pe_decisions(tenant_id,deal_id,id),
  FOREIGN KEY (tenant_id,finalized_by) REFERENCES finnor_os.users(tenant_id,id)
);

CREATE TABLE finnor_os.pe_ic_decision_condition_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  ic_case_id uuid NOT NULL,
  decision_link_id uuid NOT NULL,
  condition_id uuid NOT NULL,
  relationship text NOT NULL CHECK (relationship IN (
    'PROPOSED_AT_DECISION','ACTIVE_AT_DECISION','SATISFIED_BEFORE_DECISION',
    'WAIVED_BEFORE_DECISION','FAILED_BEFORE_DECISION','SUPERSEDED_BEFORE_DECISION'
  )),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,decision_link_id,condition_id),
  FOREIGN KEY (tenant_id,ic_case_id,decision_link_id) REFERENCES finnor_os.pe_ic_decision_links(tenant_id,ic_case_id,id),
  FOREIGN KEY (tenant_id,ic_case_id,condition_id) REFERENCES finnor_os.pe_ic_conditions(tenant_id,ic_case_id,id)
);

ALTER TABLE finnor_os.pe_ic_cases
  ADD CONSTRAINT pe_ic_cases_current_memo_fkey FOREIGN KEY (tenant_id,id,current_memo_id)
    REFERENCES finnor_os.pe_ic_memos(tenant_id,ic_case_id,id),
  ADD CONSTRAINT pe_ic_cases_current_deck_fkey FOREIGN KEY (tenant_id,id,current_deck_id)
    REFERENCES finnor_os.pe_ic_memos(tenant_id,ic_case_id,id),
  ADD CONSTRAINT pe_ic_cases_current_recommendation_fkey FOREIGN KEY (tenant_id,id,current_recommendation_id)
    REFERENCES finnor_os.pe_ic_recommendations(tenant_id,ic_case_id,id);

CREATE OR REPLACE FUNCTION finnor_os.reject_ic_history_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  RAISE EXCEPTION 'IC history is immutable; append a revision or use a typed transition';
END $$;

CREATE OR REPLACE FUNCTION finnor_os.ic_authority_allows(p_tenant uuid,p_decision uuid,p_employee uuid,p_capabilities text[])
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,finnor_os AS $$
  SELECT EXISTS (
    SELECT 1 FROM finnor_os.authority_decisions d
     WHERE d.id=p_decision AND d.tenant_id=p_tenant AND d.employee_id=p_employee
       AND d.outcome='allowed' AND d.capability=ANY(p_capabilities)
  )
$$;

CREATE OR REPLACE FUNCTION finnor_os.assert_ic_committee_configuration() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE unit_row record; revision_row record; prior_version integer;
BEGIN
  IF finnor_os.active_tenant_vertical(NEW.tenant_id)<>'private_equity' THEN RAISE EXCEPTION 'IC configuration requires the Private Equity vertical'; END IF;
  SELECT kind,active INTO unit_row FROM finnor_os.org_units WHERE tenant_id=NEW.tenant_id AND id=NEW.committee_org_unit_id;
  IF NOT FOUND OR unit_row.kind<>'team' OR NOT unit_row.active THEN RAISE EXCEPTION 'IC committee identity must be an active canonical team'; END IF;
  SELECT tenant_id,policy_id,action_type,version,policy INTO revision_row FROM finnor_os.domain_policy_revisions WHERE id=NEW.policy_revision_id;
  IF NOT FOUND OR revision_row.tenant_id<>NEW.tenant_id OR revision_row.policy_id<>NEW.policy_id
     OR revision_row.version<>NEW.policy_version OR revision_row.action_type<>'private_equity:ic_process'
     OR revision_row.policy IS DISTINCT FROM NEW.policy_snapshot THEN
    RAISE EXCEPTION 'IC configuration must pin the exact Core DomainPolicy revision';
  END IF;
  IF NEW.policy_hash IS DISTINCT FROM 'sha256:'||encode(public.digest(convert_to(NEW.policy_snapshot::text,'UTF8'),'sha256'),'hex') THEN
    RAISE EXCEPTION 'IC policy snapshot hash mismatch';
  END IF;
  IF NOT finnor_os.ic_authority_allows(NEW.tenant_id,NEW.authority_decision_id,NEW.created_by,ARRAY['ic:configure_committee']) THEN
    RAISE EXCEPTION 'IC committee configuration requires exact Core Authority';
  END IF;
  IF (NEW.policy_snapshot#>>'{quorum,kind}') NOT IN ('MIN_COUNT','PERCENTAGE')
     OR (NEW.policy_snapshot#>>'{threshold,kind}') NOT IN ('SIMPLE_MAJORITY','SUPERMAJORITY','UNANIMOUS','NAMED_ROLE_CONCURRENCE','BLOCKED_CONFIG') THEN
    RAISE EXCEPTION 'IC policy rule form is unsupported';
  END IF;
  SELECT max(config_version) INTO prior_version FROM finnor_os.pe_ic_committee_config_versions
   WHERE tenant_id=NEW.tenant_id AND committee_org_unit_id=NEW.committee_org_unit_id;
  IF NEW.config_version<>coalesce(prior_version,0)+1 THEN RAISE EXCEPTION 'IC committee config version must increment exactly once'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pe_ic_committee_config_guard BEFORE INSERT ON finnor_os.pe_ic_committee_config_versions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_ic_committee_configuration();

CREATE OR REPLACE FUNCTION finnor_os.assert_ic_committee_member() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF (SELECT count(*) FROM finnor_os.pe_ic_committee_membership_versions
       WHERE tenant_id=NEW.tenant_id AND committee_config_version_id=NEW.committee_config_version_id)>=50 THEN
    RAISE EXCEPTION 'IC committee member limit exceeded (50)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM finnor_os.users WHERE tenant_id=NEW.tenant_id AND id=NEW.employee_id AND status='active') THEN
    RAISE EXCEPTION 'IC committee member must be an active canonical employee';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pe_ic_committee_member_guard BEFORE INSERT ON finnor_os.pe_ic_committee_membership_versions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_ic_committee_member();

CREATE OR REPLACE FUNCTION finnor_os.assert_ic_config_has_voters() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM finnor_os.pe_ic_committee_membership_versions
    WHERE tenant_id=NEW.tenant_id AND committee_config_version_id=NEW.id AND voting_eligible) THEN
    RAISE EXCEPTION 'IC committee configuration requires at least one eligible voter';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER pe_ic_config_voter_required
  AFTER INSERT ON finnor_os.pe_ic_committee_config_versions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_ic_config_has_voters();

CREATE OR REPLACE FUNCTION finnor_os.assert_ic_case_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE prior jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
DECLARE body jsonb:=to_jsonb(NEW); investment record; configured jsonb; run_row record; recommendation record;
DECLARE permitted text[]:=ARRAY['state','version','vote_set_version','voting_basis_version','primary_underwriting_run_id','current_memo_id','current_deck_id','current_recommendation_id','final_decision_id','voting_opened_by','voting_open_authority_decision_id','voting_open_receipt_id','voting_open_idempotency_key','voting_opened_at','voting_closed_by','voting_close_authority_decision_id','voting_close_receipt_id','voting_close_idempotency_key','voting_closed_at','closed_at','updated_at'];
BEGIN
  SELECT c.tenant_id,c.deal_id,c.state,d.status INTO investment
    FROM finnor_os.pe_investment_cases c JOIN finnor_os.pe_deals d ON d.id=c.deal_id AND d.tenant_id=c.tenant_id
   WHERE c.id=NEW.investment_case_id;
  IF NOT FOUND OR investment.tenant_id<>NEW.tenant_id OR investment.deal_id<>NEW.deal_id OR investment.status<>'active' OR investment.state<>'active' THEN
    RAISE EXCEPTION 'ICCase must reference one active tenant-owned InvestmentCase and Deal';
  END IF;
  SELECT policy_snapshot INTO configured FROM finnor_os.pe_ic_committee_config_versions
   WHERE tenant_id=NEW.tenant_id AND id=NEW.committee_config_version_id;
  IF configured IS NULL THEN RAISE EXCEPTION 'ICCase committee configuration is missing or crosses tenant'; END IF;
  IF NEW.scheduled_internal_event_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM finnor_os.internal_events WHERE id=NEW.scheduled_internal_event_id AND tenant_id=NEW.tenant_id
  ) THEN RAISE EXCEPTION 'ICCase scheduled event crosses tenant or is missing'; END IF;
  IF NEW.reconsiders_decision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM finnor_os.pe_decisions WHERE tenant_id=NEW.tenant_id AND deal_id=NEW.deal_id
      AND investment_case_id=NEW.investment_case_id AND id=NEW.reconsiders_decision_id
      AND state IN ('final','superseded')
      AND (TG_OP='UPDATE' OR state='final')
  ) THEN RAISE EXCEPTION 'ICCase reconsideration must reference a final P1 Decision in the same InvestmentCase'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'DRAFT' OR NEW.version<>1 OR NEW.vote_set_version<>0 THEN RAISE EXCEPTION 'ICCase must start DRAFT at version 1 with an empty vote set'; END IF;
    IF NOT finnor_os.ic_authority_allows(NEW.tenant_id,NEW.opened_authority_decision_id,NEW.opened_by,ARRAY['ic:open_case','action:open_ic_case']) THEN
      RAISE EXCEPTION 'ICCase opening requires exact Core Authority';
    END IF;
  ELSE
    IF (prior-permitted) IS DISTINCT FROM (body-permitted) THEN RAISE EXCEPTION 'ICCase identity/process history cannot be patched'; END IF;
    IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'stale ICCase version'; END IF;
    IF NEW.state=OLD.state AND NEW.vote_set_version=OLD.vote_set_version
       AND NEW.primary_underwriting_run_id IS NOT DISTINCT FROM OLD.primary_underwriting_run_id
       AND NEW.current_memo_id IS NOT DISTINCT FROM OLD.current_memo_id
       AND NEW.current_deck_id IS NOT DISTINCT FROM OLD.current_deck_id
       AND NEW.current_recommendation_id IS NOT DISTINCT FROM OLD.current_recommendation_id
       AND NEW.final_decision_id IS NOT DISTINCT FROM OLD.final_decision_id
       AND NEW.voting_opened_at IS NOT DISTINCT FROM OLD.voting_opened_at
       AND NEW.voting_closed_at IS NOT DISTINCT FROM OLD.voting_closed_at
       AND current_setting('app.ic_child_mutation',true)<>'1' THEN
      RAISE EXCEPTION 'ICCase update must change governed process truth';
    END IF;
    IF NEW.vote_set_version<>OLD.vote_set_version AND (
      NEW.vote_set_version<>OLD.vote_set_version+1 OR current_setting('app.ic_vote_append',true)<>'1'
    ) THEN RAISE EXCEPTION 'ICCase vote-set version may advance only with an immutable Vote'; END IF;
    IF NEW.state<>OLD.state AND NOT (
      (OLD.state='DRAFT' AND NEW.state IN ('PREPARING','WITHDRAWN')) OR
      (OLD.state='PREPARING' AND NEW.state IN ('READY_FOR_REVIEW','BLOCKED','WITHDRAWN')) OR
      (OLD.state='READY_FOR_REVIEW' AND NEW.state IN ('QUESTIONS_OPEN','READY_FOR_VOTE','BLOCKED','WITHDRAWN')) OR
      (OLD.state='QUESTIONS_OPEN' AND NEW.state IN ('READY_FOR_VOTE','READY_FOR_REVIEW','BLOCKED','WITHDRAWN')) OR
      (OLD.state='READY_FOR_VOTE' AND NEW.state IN ('VOTING','QUESTIONS_OPEN','READY_FOR_REVIEW','BLOCKED','WITHDRAWN')) OR
      (OLD.state='VOTING' AND NEW.state IN ('CONDITIONS_PENDING','READY_FOR_REVIEW','BLOCKED','WITHDRAWN')) OR
      (OLD.state='CONDITIONS_PENDING' AND NEW.state IN ('DECIDED','READY_FOR_REVIEW','BLOCKED','WITHDRAWN')) OR
      (OLD.state='DECIDED' AND NEW.state='SUPERSEDED') OR
      (OLD.state='BLOCKED' AND NEW.state IN ('PREPARING','READY_FOR_REVIEW','QUESTIONS_OPEN','READY_FOR_VOTE','CONDITIONS_PENDING','WITHDRAWN'))
    ) THEN RAISE EXCEPTION 'invalid ICCase transition % -> %',OLD.state,NEW.state; END IF;
    IF OLD.state IN ('VOTING','CONDITIONS_PENDING') AND (
      NEW.current_memo_id IS DISTINCT FROM OLD.current_memo_id OR NEW.primary_underwriting_run_id IS DISTINCT FROM OLD.primary_underwriting_run_id
      OR NEW.current_recommendation_id IS DISTINCT FROM OLD.current_recommendation_id
    ) AND NEW.state<>'READY_FOR_REVIEW' THEN
      RAISE EXCEPTION 'material IC basis change requires explicit review/revote transition';
    END IF;
  END IF;
  IF NEW.primary_underwriting_run_id IS NOT NULL THEN
    SELECT status,validity INTO run_row FROM finnor_os.underwriting_runs
      WHERE tenant_id=NEW.tenant_id AND investment_case_id=NEW.investment_case_id AND id=NEW.primary_underwriting_run_id;
    IF NOT FOUND OR run_row.status<>'SUCCEEDED' OR NOT (configured->'allowedPrimaryRunValidities' ? run_row.validity) THEN
      RAISE EXCEPTION 'IC primary UnderwritingRun is missing, failed, invalid for policy, or crosses InvestmentCase';
    END IF;
  END IF;
  IF NEW.current_memo_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM finnor_os.pe_ic_memos WHERE tenant_id=NEW.tenant_id AND ic_case_id=NEW.id AND id=NEW.current_memo_id AND artifact_role='MEMO'
  ) THEN RAISE EXCEPTION 'ICCase current Memo must reference an exact same-case MEMO selection'; END IF;
  IF NEW.current_deck_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM finnor_os.pe_ic_memos WHERE tenant_id=NEW.tenant_id AND ic_case_id=NEW.id AND id=NEW.current_deck_id AND artifact_role='DECK'
  ) THEN RAISE EXCEPTION 'ICCase current Deck must reference an exact same-case DECK selection'; END IF;
  IF NEW.state IN ('READY_FOR_VOTE','VOTING') THEN
    IF NEW.current_memo_id IS NULL OR NEW.current_recommendation_id IS NULL OR NEW.primary_underwriting_run_id IS NULL THEN
      RAISE EXCEPTION 'IC voting requires exact Memo, Recommendation and primary UnderwritingRun';
    END IF;
    SELECT memo_id,underwriting_run_id INTO recommendation FROM finnor_os.pe_ic_recommendations
      WHERE tenant_id=NEW.tenant_id AND ic_case_id=NEW.id AND id=NEW.current_recommendation_id;
    IF NOT FOUND OR recommendation.memo_id<>NEW.current_memo_id OR recommendation.underwriting_run_id<>NEW.primary_underwriting_run_id THEN
      RAISE EXCEPTION 'IC Recommendation basis does not match selected Memo/UnderwritingRun';
    END IF;
    IF EXISTS (SELECT 1 FROM finnor_os.pe_ic_questions WHERE tenant_id=NEW.tenant_id AND ic_case_id=NEW.id
      AND required_before_vote AND state NOT IN ('RESOLVED','WAIVED','SUPERSEDED')) THEN
      RAISE EXCEPTION 'required IC Question blocks voting';
    END IF;
  END IF;
  IF NEW.state='VOTING' AND (
    NOT finnor_os.ic_authority_allows(NEW.tenant_id,NEW.voting_open_authority_decision_id,NEW.voting_opened_by,ARRAY['ic:open_voting'])
    OR NOT EXISTS (SELECT 1 FROM finnor_os.decision_receipts WHERE tenant_id=NEW.tenant_id AND id=NEW.voting_open_receipt_id AND finalized_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'opening IC voting requires exact Core Authority and finalized DecisionReceipt';
  END IF;
  IF NEW.state='CONDITIONS_PENDING' AND (
    NOT finnor_os.ic_authority_allows(NEW.tenant_id,NEW.voting_close_authority_decision_id,NEW.voting_closed_by,ARRAY['ic:close_voting'])
    OR NOT EXISTS (SELECT 1 FROM finnor_os.decision_receipts WHERE tenant_id=NEW.tenant_id AND id=NEW.voting_close_receipt_id AND finalized_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'closing IC voting requires exact Core Authority and finalized DecisionReceipt';
  END IF;
  IF NEW.state='DECIDED' AND NOT EXISTS (
    SELECT 1 FROM finnor_os.pe_ic_decision_links relation
     WHERE relation.tenant_id=NEW.tenant_id AND relation.ic_case_id=NEW.id
       AND relation.decision_id=NEW.final_decision_id
  ) THEN
    RAISE EXCEPTION 'DECIDED ICCase requires the exact final P1 Decision linkage';
  END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER pe_ic_case_guard BEFORE INSERT OR UPDATE ON finnor_os.pe_ic_cases
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_ic_case_mutation();

CREATE OR REPLACE FUNCTION finnor_os.assert_ic_memo() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE prior record; version_time timestamptz; run_time timestamptz;
BEGIN
  IF (SELECT count(*) FROM finnor_os.pe_ic_memos WHERE tenant_id=NEW.tenant_id AND ic_case_id=NEW.ic_case_id AND artifact_role=NEW.artifact_role)>=20 THEN
    RAISE EXCEPTION 'IC tracked Memo/Deck revision limit exceeded (20)';
  END IF;
  SELECT created_at INTO version_time FROM finnor_os.document_versions
    WHERE tenant_id=NEW.tenant_id AND document_id=NEW.document_id AND id=NEW.document_version_id;
  IF version_time IS NULL OR version_time>NEW.created_at THEN RAISE EXCEPTION 'IC Memo must pin an existing no-hindsight P3 DocumentVersion'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM finnor_os.pe_document_links link
     WHERE link.tenant_id=NEW.tenant_id AND link.document_id=NEW.document_id
       AND link.world_root_type='pe_deal' AND link.world_root_id=NEW.deal_id
       AND link.deal_id=NEW.deal_id AND link.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'IC Memo Document must have an active PE Document link on the same Deal root';
  END IF;
  IF NEW.underwriting_run_id IS NOT NULL THEN
    SELECT computed_at INTO run_time FROM finnor_os.underwriting_runs WHERE tenant_id=NEW.tenant_id AND investment_case_id=NEW.investment_case_id AND id=NEW.underwriting_run_id;
    IF run_time IS NULL OR run_time>NEW.created_at THEN RAISE EXCEPTION 'IC Memo UnderwritingRun is missing, later, or crosses InvestmentCase'; END IF;
  END IF;
  IF NEW.supersedes_memo_id IS NOT NULL THEN
    SELECT revision,artifact_role INTO prior FROM finnor_os.pe_ic_memos
      WHERE tenant_id=NEW.tenant_id AND ic_case_id=NEW.ic_case_id AND id=NEW.supersedes_memo_id;
    IF NOT FOUND OR prior.artifact_role<>NEW.artifact_role OR NEW.revision<>prior.revision+1 THEN
      RAISE EXCEPTION 'IC Memo revision must supersede the immediately prior same-role version';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pe_ic_memo_guard BEFORE INSERT ON finnor_os.pe_ic_memos FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_ic_memo();

CREATE OR REPLACE FUNCTION finnor_os.assert_ic_question_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE prior jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END; body jsonb:=to_jsonb(NEW);
DECLARE immutable text[]:=ARRAY['id','tenant_id','deal_id','investment_case_id','ic_case_id','question','priority','required_before_vote','required_before_decision','work_id','raised_by','idempotency_key','created_at'];
DECLARE process_state text;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT state INTO process_state FROM finnor_os.pe_ic_cases WHERE tenant_id=NEW.tenant_id AND id=NEW.ic_case_id;
    IF process_state NOT IN ('PREPARING','READY_FOR_REVIEW','QUESTIONS_OPEN') THEN
      RAISE EXCEPTION 'IC Question may be opened only during preparation or review';
    END IF;
    IF NEW.state<>'OPEN' OR NEW.version<>1 THEN RAISE EXCEPTION 'IC Question must start OPEN at version 1'; END IF;
    IF (SELECT count(*) FROM finnor_os.pe_ic_questions WHERE tenant_id=NEW.tenant_id AND ic_case_id=NEW.ic_case_id AND state IN ('OPEN','ANSWERED'))>=100 THEN
      RAISE EXCEPTION 'IC open Question limit exceeded (100)';
    END IF;
  ELSE
    IF (prior-ARRAY['state','substantiation_status','answer','answered_by','resolved_by','waived_by','waiver_reason','waiver_authority_decision_id','waiver_decision_receipt_id','version','answered_at','resolved_at','updated_at'])
      IS DISTINCT FROM (body-ARRAY['state','substantiation_status','answer','answered_by','resolved_by','waived_by','waiver_reason','waiver_authority_decision_id','waiver_decision_receipt_id','version','answered_at','resolved_at','updated_at']) THEN
      RAISE EXCEPTION 'IC Question identity/text cannot be patched';
    END IF;
    IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'stale IC Question version'; END IF;
    IF NEW.state=OLD.state THEN
      IF current_setting('app.ic_source_attach',true)<>'1'
         OR NOT EXISTS (
           SELECT 1 FROM finnor_os.pe_ic_source_links source
            WHERE source.tenant_id=NEW.tenant_id AND source.owner_kind='QUESTION'
              AND source.owner_id=NEW.id AND source.created_at>OLD.updated_at
         )
         OR (prior-ARRAY['substantiation_status','version','updated_at']) IS DISTINCT FROM (body-ARRAY['substantiation_status','version','updated_at']) THEN
        RAISE EXCEPTION 'IC Question same-state update requires an exact newly-attached source';
      END IF;
    ELSIF NOT (
      (OLD.state='OPEN' AND NEW.state IN ('ANSWERED','WAIVED','SUPERSEDED')) OR
      (OLD.state='ANSWERED' AND NEW.state IN ('RESOLVED','WAIVED','SUPERSEDED')) OR
      (OLD.state IN ('RESOLVED','WAIVED') AND NEW.state='SUPERSEDED')
    ) THEN RAISE EXCEPTION 'invalid IC Question transition % -> %',OLD.state,NEW.state; END IF;
  END IF;
  IF NEW.state='RESOLVED' AND NOT EXISTS (
    SELECT 1 FROM finnor_os.pe_ic_source_links WHERE tenant_id=NEW.tenant_id AND owner_kind='QUESTION' AND owner_id=NEW.id
  ) THEN RAISE EXCEPTION 'IC Question resolution requires an exact source link'; END IF;
  IF NEW.state='WAIVED' AND (
    NOT finnor_os.ic_authority_allows(NEW.tenant_id,NEW.waiver_authority_decision_id,NEW.waived_by,ARRAY['ic:waive_question'])
    OR NOT EXISTS (SELECT 1 FROM finnor_os.decision_receipts WHERE tenant_id=NEW.tenant_id AND id=NEW.waiver_decision_receipt_id AND finalized_at IS NOT NULL)
  ) THEN RAISE EXCEPTION 'IC Question waiver requires exact Core Authority and finalized DecisionReceipt'; END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_ic_recommendation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE prior record; memo_row record; run_row record;
BEGIN
  IF (SELECT count(*) FROM finnor_os.pe_ic_recommendations WHERE tenant_id=NEW.tenant_id AND ic_case_id=NEW.ic_case_id)>=20 THEN
    RAISE EXCEPTION 'IC Recommendation revision limit exceeded (20)';
  END IF;
  SELECT underwriting_run_id,created_at INTO memo_row FROM finnor_os.pe_ic_memos
    WHERE tenant_id=NEW.tenant_id AND ic_case_id=NEW.ic_case_id AND id=NEW.memo_id AND artifact_role='MEMO';
  SELECT scenario_id,computed_at,status INTO run_row FROM finnor_os.underwriting_runs
    WHERE tenant_id=NEW.tenant_id AND investment_case_id=NEW.investment_case_id AND id=NEW.underwriting_run_id;
  IF memo_row IS NULL OR run_row IS NULL OR run_row.status<>'SUCCEEDED' OR run_row.computed_at>NEW.created_at
     OR (memo_row.underwriting_run_id IS NOT NULL AND memo_row.underwriting_run_id<>NEW.underwriting_run_id)
     OR NEW.scenario_id IS DISTINCT FROM run_row.scenario_id THEN
    RAISE EXCEPTION 'IC Recommendation basis is missing, stale, failed or crosses Memo/Run/Scenario';
  END IF;
  IF NEW.supersedes_recommendation_id IS NOT NULL THEN
    SELECT revision INTO prior FROM finnor_os.pe_ic_recommendations
      WHERE tenant_id=NEW.tenant_id AND ic_case_id=NEW.ic_case_id AND id=NEW.supersedes_recommendation_id;
    IF NOT FOUND OR NEW.revision<>prior.revision+1 THEN RAISE EXCEPTION 'IC Recommendation revision must supersede the immediately prior revision'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pe_ic_recommendation_guard BEFORE INSERT ON finnor_os.pe_ic_recommendations
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_ic_recommendation();

CREATE OR REPLACE FUNCTION finnor_os.assert_ic_vote() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE process record; member record;
BEGIN
  SELECT state,current_recommendation_id,current_memo_id,primary_underwriting_run_id,committee_config_version_id,voting_opened_at,voting_basis_version
    INTO process FROM finnor_os.pe_ic_cases WHERE tenant_id=NEW.tenant_id AND id=NEW.ic_case_id FOR UPDATE;
  IF NOT FOUND OR process.state<>'VOTING' OR process.current_recommendation_id<>NEW.recommendation_id
     OR process.current_memo_id<>NEW.memo_id OR process.primary_underwriting_run_id<>NEW.underwriting_run_id
     OR process.voting_basis_version<>NEW.voting_basis_version THEN
    RAISE EXCEPTION 'Vote basis is not the exact currently-open IC voting basis';
  END IF;
  SELECT voting_eligible,effective_from,effective_until INTO member
    FROM finnor_os.pe_ic_committee_membership_versions
   WHERE tenant_id=NEW.tenant_id AND committee_config_version_id=process.committee_config_version_id AND employee_id=NEW.employee_id;
  IF NOT FOUND OR NOT member.voting_eligible OR member.effective_from>NEW.recorded_at
     OR (member.effective_until IS NOT NULL AND member.effective_until<=NEW.recorded_at) THEN
    RAISE EXCEPTION 'Vote actor is not an eligible member of the pinned committee configuration';
  END IF;
  IF current_setting('app.pe_actor',true) IS DISTINCT FROM NEW.employee_id::text
     OR current_setting('app.user_id',true) IS DISTINCT FROM NEW.employee_id::text THEN
    RAISE EXCEPTION 'Vote actor must derive from the authenticated canonical employee';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pe_ic_vote_guard BEFORE INSERT ON finnor_os.pe_ic_votes FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_ic_vote();

CREATE OR REPLACE FUNCTION finnor_os.bump_ic_vote_set() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  PERFORM set_config('app.ic_vote_append','1',true);
  UPDATE finnor_os.pe_ic_cases SET vote_set_version=vote_set_version+1,version=version+1,updated_at=clock_timestamp()
   WHERE tenant_id=NEW.tenant_id AND id=NEW.ic_case_id;
  RETURN NEW;
END $$;
CREATE TRIGGER pe_ic_vote_set AFTER INSERT ON finnor_os.pe_ic_votes FOR EACH ROW EXECUTE FUNCTION finnor_os.bump_ic_vote_set();

CREATE OR REPLACE FUNCTION finnor_os.assert_ic_dissent() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE vote_row record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM finnor_os.pe_ic_cases WHERE tenant_id=NEW.tenant_id AND id=NEW.ic_case_id AND state='VOTING') THEN
    RAISE EXCEPTION 'Dissent may be recorded only while exact IC voting is open';
  END IF;
  SELECT employee_id,recommendation_id,memo_id INTO vote_row FROM finnor_os.pe_ic_votes
    WHERE tenant_id=NEW.tenant_id AND ic_case_id=NEW.ic_case_id AND id=NEW.vote_id;
  IF NOT FOUND OR vote_row.employee_id<>NEW.employee_id OR vote_row.recommendation_id<>NEW.recommendation_id OR vote_row.memo_id<>NEW.memo_id THEN
    RAISE EXCEPTION 'Dissent must belong to the authenticated member exact Vote basis';
  END IF;
  IF current_setting('app.pe_actor',true) IS DISTINCT FROM NEW.employee_id::text
     OR current_setting('app.user_id',true) IS DISTINCT FROM NEW.employee_id::text THEN
    RAISE EXCEPTION 'Dissent actor must derive from the authenticated canonical employee';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pe_ic_dissent_guard BEFORE INSERT ON finnor_os.pe_ic_dissents FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_ic_dissent();

CREATE OR REPLACE FUNCTION finnor_os.assert_ic_condition_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE prior jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END; body jsonb:=to_jsonb(NEW);
DECLARE process_state text;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT state INTO process_state FROM finnor_os.pe_ic_cases WHERE tenant_id=NEW.tenant_id AND id=NEW.ic_case_id;
    IF process_state IN ('DECIDED','WITHDRAWN','SUPERSEDED') OR process_state IS NULL THEN
      RAISE EXCEPTION 'terminal or missing ICCase cannot receive a new IC Condition';
    END IF;
    IF NEW.state<>'PROPOSED' OR NEW.version<>1 THEN RAISE EXCEPTION 'IC Condition must start PROPOSED at version 1'; END IF;
    IF (SELECT count(*) FROM finnor_os.pe_ic_conditions WHERE tenant_id=NEW.tenant_id AND ic_case_id=NEW.ic_case_id AND state IN ('PROPOSED','ACTIVE'))>=50 THEN
      RAISE EXCEPTION 'IC active Condition limit exceeded (50)';
    END IF;
  ELSE
    IF (prior-ARRAY['state','version','verified_by','waiver_reason','waiver_authority_decision_id','waiver_decision_receipt_id','source_decision_id','resolved_at','updated_at'])
      IS DISTINCT FROM (body-ARRAY['state','version','verified_by','waiver_reason','waiver_authority_decision_id','waiver_decision_receipt_id','source_decision_id','resolved_at','updated_at']) THEN
      RAISE EXCEPTION 'IC Condition identity/meaning cannot be patched';
    END IF;
    IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'stale IC Condition version'; END IF;
    IF NOT (
      (OLD.state='PROPOSED' AND NEW.state IN ('ACTIVE','SUPERSEDED')) OR
      (OLD.state='ACTIVE' AND NEW.state IN ('SATISFIED','WAIVED','FAILED','SUPERSEDED')) OR
      (OLD.state IN ('SATISFIED','WAIVED','FAILED') AND NEW.state='SUPERSEDED')
    ) THEN RAISE EXCEPTION 'invalid IC Condition transition % -> %',OLD.state,NEW.state; END IF;
  END IF;
  IF NEW.state='SATISFIED' AND NEW.evidence_required AND NOT EXISTS (
    SELECT 1 FROM finnor_os.pe_ic_source_links WHERE tenant_id=NEW.tenant_id AND owner_kind='CONDITION' AND owner_id=NEW.id AND relationship='VERIFIES'
  ) THEN RAISE EXCEPTION 'IC Condition satisfaction requires exact verification source'; END IF;
  IF NEW.state='WAIVED' AND (
    NOT finnor_os.ic_authority_allows(NEW.tenant_id,NEW.waiver_authority_decision_id,NEW.verified_by,ARRAY['ic:waive_condition'])
    OR NOT EXISTS (SELECT 1 FROM finnor_os.decision_receipts WHERE tenant_id=NEW.tenant_id AND id=NEW.waiver_decision_receipt_id AND finalized_at IS NOT NULL)
  ) THEN RAISE EXCEPTION 'IC Condition waiver requires exact Core Authority and finalized DecisionReceipt'; END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_ic_source_link() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE owner_case uuid; owner_state text; source_row record; anchor_found boolean; process_state text;
BEGIN
  IF NEW.owner_kind='QUESTION' THEN SELECT ic_case_id,state INTO owner_case,owner_state FROM finnor_os.pe_ic_questions WHERE tenant_id=NEW.tenant_id AND id=NEW.owner_id;
  ELSIF NEW.owner_kind='RECOMMENDATION' THEN SELECT ic_case_id INTO owner_case FROM finnor_os.pe_ic_recommendations WHERE tenant_id=NEW.tenant_id AND id=NEW.owner_id;
  ELSIF NEW.owner_kind='DISSENT' THEN SELECT ic_case_id INTO owner_case FROM finnor_os.pe_ic_dissents WHERE tenant_id=NEW.tenant_id AND id=NEW.owner_id;
  ELSE SELECT ic_case_id INTO owner_case FROM finnor_os.pe_ic_conditions WHERE tenant_id=NEW.tenant_id AND id=NEW.owner_id; END IF;
  IF owner_case IS DISTINCT FROM NEW.ic_case_id THEN RAISE EXCEPTION 'IC source-link owner is missing or crosses process root'; END IF;
  IF NEW.owner_kind='QUESTION' AND owner_state NOT IN ('OPEN','ANSWERED') THEN
    RAISE EXCEPTION 'resolved, waived or superseded IC Question evidence is immutable';
  END IF;
  SELECT state INTO process_state FROM finnor_os.pe_ic_cases WHERE tenant_id=NEW.tenant_id AND id=NEW.ic_case_id;
  IF NEW.owner_kind='RECOMMENDATION' AND EXISTS (
    SELECT 1 FROM finnor_os.pe_ic_votes WHERE tenant_id=NEW.tenant_id AND recommendation_id=NEW.owner_id
  ) THEN RAISE EXCEPTION 'IC Recommendation support cannot change after an official Vote; append a new Recommendation revision'; END IF;
  IF NEW.owner_kind='DISSENT' AND process_state<>'VOTING' THEN
    RAISE EXCEPTION 'IC Dissent support may be attached only while voting is open';
  END IF;
  IF (SELECT count(*) FROM finnor_os.pe_ic_source_links
       WHERE tenant_id=NEW.tenant_id AND owner_kind=NEW.owner_kind AND owner_id=NEW.owner_id)>=100 THEN
    RAISE EXCEPTION 'IC owner source-link limit exceeded (100)';
  END IF;
  IF NEW.source_kind='EVIDENCE_VERSION' THEN
    SELECT scope,tenant_id,retrieved_at INTO source_row FROM finnor_os.evidence_source_versions WHERE id=NEW.evidence_version_id;
    IF NOT FOUND OR (source_row.scope='tenant' AND source_row.tenant_id<>NEW.tenant_id) THEN RAISE EXCEPTION 'IC EvidenceVersion crosses tenant or is missing'; END IF;
  ELSIF NEW.source_kind='ARTIFACT_ANCHOR' THEN
    SELECT EXISTS (SELECT 1 FROM finnor_os.artifact_ir_snapshots snapshot,
      LATERAL jsonb_array_elements(snapshot.ir->'nodes') node
      WHERE snapshot.tenant_id=NEW.tenant_id AND snapshot.version_id=NEW.document_version_id
        AND node->>'id'=NEW.anchor_id AND node->>'hash'=NEW.anchor_hash) INTO anchor_found;
    IF NOT anchor_found THEN RAISE EXCEPTION 'IC ArtifactAnchor is stale, missing or crosses tenant'; END IF;
  ELSIF NEW.source_kind='P1_WORLD' THEN
    IF finnor_os.canonical_entity_tenant(NEW.world_entity_type,NEW.world_entity_id) IS DISTINCT FROM NEW.tenant_id
       OR finnor_os.pe_entity_deal(NEW.world_entity_type,NEW.world_entity_id) IS DISTINCT FROM NEW.deal_id THEN
      RAISE EXCEPTION 'IC P1 world reference crosses tenant/Deal or is missing';
    END IF;
  ELSIF NEW.source_kind='PE_RISK' THEN
    IF finnor_os.canonical_entity_tenant('pe_deal_risk',NEW.pe_risk_id) IS DISTINCT FROM NEW.tenant_id
       OR finnor_os.pe_entity_deal('pe_deal_risk',NEW.pe_risk_id) IS DISTINCT FROM NEW.deal_id THEN
      RAISE EXCEPTION 'IC Risk reference crosses tenant/Deal or is missing';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_ic_decision_proposal() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE process record; rec record; expected_provenance_hash text;
BEGIN
  SELECT version,vote_set_version,committee_config_version_id,current_recommendation_id,current_memo_id,primary_underwriting_run_id,state
    INTO process FROM finnor_os.pe_ic_cases WHERE tenant_id=NEW.tenant_id AND id=NEW.ic_case_id FOR UPDATE;
  SELECT outcome,memo_id,underwriting_run_id INTO rec FROM finnor_os.pe_ic_recommendations
    WHERE tenant_id=NEW.tenant_id AND ic_case_id=NEW.ic_case_id AND id=NEW.recommendation_id;
  IF NOT FOUND OR process.state NOT IN ('VOTING','CONDITIONS_PENDING') OR process.version<>NEW.case_version
     OR process.vote_set_version<>NEW.vote_set_version OR process.committee_config_version_id<>NEW.committee_config_version_id
     OR process.current_recommendation_id<>NEW.recommendation_id OR process.current_memo_id<>NEW.memo_id
     OR process.primary_underwriting_run_id<>NEW.underwriting_run_id OR rec.memo_id<>NEW.memo_id OR rec.underwriting_run_id<>NEW.underwriting_run_id THEN
    RAISE EXCEPTION 'IC DecisionProposal input snapshot is stale or crosses process basis';
  END IF;
  IF NEW.input_hash IS DISTINCT FROM NEW.aggregation->>'inputHash' THEN RAISE EXCEPTION 'IC DecisionProposal aggregation input hash mismatch'; END IF;
  IF NEW.process_status IS DISTINCT FROM NEW.aggregation#>>'{process,status}' OR NEW.proposed_outcome IS DISTINCT FROM NEW.aggregation->>'proposedOutcome' THEN
    RAISE EXCEPTION 'IC DecisionProposal scalars do not match deterministic aggregation';
  END IF;
  IF EXISTS (
    (SELECT id FROM finnor_os.pe_ic_votes WHERE tenant_id=NEW.tenant_id AND ic_case_id=NEW.ic_case_id AND recommendation_id=NEW.recommendation_id
     EXCEPT SELECT (item->>'id')::uuid FROM jsonb_array_elements(NEW.vote_snapshot) item)
    UNION ALL
    (SELECT (item->>'id')::uuid FROM jsonb_array_elements(NEW.vote_snapshot) item
     EXCEPT SELECT id FROM finnor_os.pe_ic_votes WHERE tenant_id=NEW.tenant_id AND ic_case_id=NEW.ic_case_id AND recommendation_id=NEW.recommendation_id)
  ) THEN RAISE EXCEPTION 'IC DecisionProposal Vote snapshot is incomplete or contains foreign Vote truth'; END IF;
  IF EXISTS (
    (SELECT id FROM finnor_os.pe_ic_dissents WHERE tenant_id=NEW.tenant_id AND ic_case_id=NEW.ic_case_id AND recommendation_id=NEW.recommendation_id
     EXCEPT SELECT (item->>'id')::uuid FROM jsonb_array_elements(NEW.dissent_snapshot) item)
    UNION ALL
    (SELECT (item->>'id')::uuid FROM jsonb_array_elements(NEW.dissent_snapshot) item
     EXCEPT SELECT id FROM finnor_os.pe_ic_dissents WHERE tenant_id=NEW.tenant_id AND ic_case_id=NEW.ic_case_id AND recommendation_id=NEW.recommendation_id)
  ) THEN RAISE EXCEPTION 'IC DecisionProposal Dissent snapshot is incomplete or contains foreign Dissent truth'; END IF;
  IF EXISTS (
    (SELECT id FROM finnor_os.pe_ic_questions WHERE tenant_id=NEW.tenant_id AND ic_case_id=NEW.ic_case_id
     EXCEPT SELECT (item->>'id')::uuid FROM jsonb_array_elements(NEW.question_snapshot) item)
    UNION ALL
    (SELECT (item->>'id')::uuid FROM jsonb_array_elements(NEW.question_snapshot) item
     EXCEPT SELECT id FROM finnor_os.pe_ic_questions WHERE tenant_id=NEW.tenant_id AND ic_case_id=NEW.ic_case_id)
  ) THEN RAISE EXCEPTION 'IC DecisionProposal Question snapshot is incomplete or contains foreign Question truth'; END IF;
  IF EXISTS (
    (SELECT id FROM finnor_os.pe_ic_conditions WHERE tenant_id=NEW.tenant_id AND ic_case_id=NEW.ic_case_id
     EXCEPT SELECT (item->>'id')::uuid FROM jsonb_array_elements(NEW.condition_snapshot) item)
    UNION ALL
    (SELECT (item->>'id')::uuid FROM jsonb_array_elements(NEW.condition_snapshot) item
     EXCEPT SELECT id FROM finnor_os.pe_ic_conditions WHERE tenant_id=NEW.tenant_id AND ic_case_id=NEW.ic_case_id)
  ) THEN RAISE EXCEPTION 'IC DecisionProposal Condition snapshot is incomplete or contains foreign Condition truth'; END IF;
  expected_provenance_hash:='sha256:'||encode(public.digest(convert_to(jsonb_build_object(
    'aggregation',NEW.aggregation,'votes',NEW.vote_snapshot,'dissents',NEW.dissent_snapshot,
    'questions',NEW.question_snapshot,'conditions',NEW.condition_snapshot,'proposedDecision',NEW.proposed_decision
  )::text,'UTF8'),'sha256'),'hex');
  IF NEW.provenance_hash IS DISTINCT FROM expected_provenance_hash THEN
    RAISE EXCEPTION 'IC DecisionProposal provenance hash does not match its immutable snapshots';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pe_ic_decision_proposal_guard BEFORE INSERT ON finnor_os.pe_ic_decision_proposals
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_ic_decision_proposal();

CREATE OR REPLACE FUNCTION finnor_os.assert_ic_decision_link() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE proposal record; decision_row record; receipt_row record; process record;
BEGIN
  SELECT process_status,provenance_hash,case_version,vote_set_version,committee_config_version_id,
         recommendation_id,memo_id,underwriting_run_id,proposed_outcome
    INTO proposal FROM finnor_os.pe_ic_decision_proposals
    WHERE tenant_id=NEW.tenant_id AND ic_case_id=NEW.ic_case_id AND id=NEW.decision_proposal_id;
  SELECT state,version,vote_set_version,committee_config_version_id,current_recommendation_id,current_memo_id,
         primary_underwriting_run_id,reconsiders_decision_id
    INTO process FROM finnor_os.pe_ic_cases WHERE tenant_id=NEW.tenant_id AND id=NEW.ic_case_id FOR UPDATE;
  SELECT state,decision_type,investment_case_id,decision,supersedes_decision_id INTO decision_row FROM finnor_os.pe_decisions
    WHERE tenant_id=NEW.tenant_id AND deal_id=NEW.deal_id AND id=NEW.decision_id;
  SELECT finalized_at,actual_result INTO receipt_row FROM finnor_os.decision_receipts
    WHERE tenant_id=NEW.tenant_id AND id=NEW.decision_receipt_id;
  IF proposal.process_status<>'PROCESS_ELIGIBLE' OR process.state<>'CONDITIONS_PENDING'
     OR process.version<>proposal.case_version OR process.vote_set_version<>proposal.vote_set_version
     OR process.committee_config_version_id<>proposal.committee_config_version_id
     OR process.current_recommendation_id<>proposal.recommendation_id OR process.current_memo_id<>proposal.memo_id
     OR process.primary_underwriting_run_id<>proposal.underwriting_run_id
     OR decision_row.state<>'final' OR decision_row.decision_type<>'investment_committee'
     OR decision_row.investment_case_id<>NEW.investment_case_id OR receipt_row.finalized_at IS NULL
     OR decision_row.decision IS DISTINCT FROM proposal.proposed_outcome
     OR decision_row.supersedes_decision_id IS DISTINCT FROM process.reconsiders_decision_id
     OR receipt_row.actual_result->>'decisionId' IS DISTINCT FROM NEW.decision_id::text
     OR NOT finnor_os.ic_authority_allows(NEW.tenant_id,NEW.authority_decision_id,NEW.finalized_by,ARRAY['ic:finalize_decision']) THEN
    RAISE EXCEPTION 'IC Decision link requires eligible proposal, final P1 Decision, exact Authority and finalized Core Receipt';
  END IF;
  IF EXISTS (SELECT 1 FROM finnor_os.pe_ic_questions WHERE tenant_id=NEW.tenant_id AND ic_case_id=NEW.ic_case_id
    AND required_before_decision AND state NOT IN ('RESOLVED','WAIVED','SUPERSEDED')) THEN
    RAISE EXCEPTION 'required IC Question blocks final Decision';
  END IF;
  IF EXISTS (SELECT 1 FROM finnor_os.pe_ic_conditions WHERE tenant_id=NEW.tenant_id AND ic_case_id=NEW.ic_case_id
    AND required AND condition_type='PRE_DECISION' AND state NOT IN ('SATISFIED','WAIVED','SUPERSEDED')) THEN
    RAISE EXCEPTION 'required PRE_DECISION IC Condition blocks final Decision';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pe_ic_decision_link_guard BEFORE INSERT ON finnor_os.pe_ic_decision_links
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_ic_decision_link();

CREATE OR REPLACE FUNCTION finnor_os.assert_ic_decision_conditions_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE link_row record;
BEGIN
  SELECT tenant_id,ic_case_id,id INTO link_row FROM finnor_os.pe_ic_decision_links
    WHERE tenant_id=NEW.tenant_id AND id=NEW.id;
  IF EXISTS (
    SELECT 1 FROM finnor_os.pe_ic_conditions condition
     WHERE condition.tenant_id=link_row.tenant_id AND condition.ic_case_id=link_row.ic_case_id
       AND NOT EXISTS (
         SELECT 1 FROM finnor_os.pe_ic_decision_condition_links relation
          WHERE relation.tenant_id=condition.tenant_id AND relation.ic_case_id=condition.ic_case_id
            AND relation.decision_link_id=link_row.id AND relation.condition_id=condition.id
            AND relation.relationship=CASE condition.state
              WHEN 'PROPOSED' THEN 'PROPOSED_AT_DECISION'
              WHEN 'ACTIVE' THEN 'ACTIVE_AT_DECISION'
              WHEN 'SATISFIED' THEN 'SATISFIED_BEFORE_DECISION'
              WHEN 'WAIVED' THEN 'WAIVED_BEFORE_DECISION'
              WHEN 'FAILED' THEN 'FAILED_BEFORE_DECISION'
              ELSE 'SUPERSEDED_BEFORE_DECISION' END
       )
  ) THEN RAISE EXCEPTION 'final IC Decision must explicitly link every IC Condition with its at-decision state'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER pe_ic_decision_conditions_complete
  AFTER INSERT ON finnor_os.pe_ic_decision_links DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_ic_decision_conditions_complete();

CREATE TRIGGER pe_ic_question_guard BEFORE INSERT OR UPDATE ON finnor_os.pe_ic_questions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_ic_question_mutation();
CREATE TRIGGER pe_ic_condition_guard BEFORE INSERT OR UPDATE ON finnor_os.pe_ic_conditions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_ic_condition_mutation();
CREATE TRIGGER pe_ic_source_link_guard BEFORE INSERT ON finnor_os.pe_ic_source_links
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_ic_source_link();

CREATE OR REPLACE FUNCTION finnor_os.refresh_ic_question_substantiation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE aggregate_status text;
BEGIN
  IF NEW.owner_kind='QUESTION' THEN
    PERFORM set_config('app.ic_source_attach','1',true);
    SELECT CASE
      WHEN bool_or(truth_status='CONFLICTING') THEN 'CONFLICTING'
      WHEN bool_or(truth_status='STALE') THEN 'STALE'
      WHEN bool_or(truth_status='UNKNOWN') THEN 'UNKNOWN'
      ELSE 'ATTACHED'
    END INTO aggregate_status
      FROM finnor_os.pe_ic_source_links
     WHERE tenant_id=NEW.tenant_id AND owner_kind='QUESTION' AND owner_id=NEW.owner_id;
    UPDATE finnor_os.pe_ic_questions
       SET substantiation_status=aggregate_status,
           version=version+1,updated_at=clock_timestamp()
     WHERE tenant_id=NEW.tenant_id AND id=NEW.owner_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pe_ic_source_question_refresh AFTER INSERT ON finnor_os.pe_ic_source_links
  FOR EACH ROW EXECUTE FUNCTION finnor_os.refresh_ic_question_substantiation();

CREATE OR REPLACE FUNCTION finnor_os.bump_ic_case_for_child() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE body jsonb:=to_jsonb(NEW);
BEGIN
  PERFORM set_config('app.ic_child_mutation','1',true);
  UPDATE finnor_os.pe_ic_cases SET version=version+1,updated_at=clock_timestamp()
   WHERE tenant_id=NEW.tenant_id AND id=(body->>'ic_case_id')::uuid;
  RETURN NEW;
END $$;
CREATE TRIGGER pe_ic_question_case_version AFTER INSERT OR UPDATE ON finnor_os.pe_ic_questions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.bump_ic_case_for_child();
CREATE TRIGGER pe_ic_condition_case_version AFTER INSERT OR UPDATE ON finnor_os.pe_ic_conditions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.bump_ic_case_for_child();
CREATE TRIGGER pe_ic_dissent_case_version AFTER INSERT ON finnor_os.pe_ic_dissents
  FOR EACH ROW EXECUTE FUNCTION finnor_os.bump_ic_case_for_child();
CREATE TRIGGER pe_ic_source_case_version AFTER INSERT ON finnor_os.pe_ic_source_links
  FOR EACH ROW WHEN (NEW.owner_kind IN ('RECOMMENDATION','DISSENT','CONDITION'))
  EXECUTE FUNCTION finnor_os.bump_ic_case_for_child();

-- P5 process entities participate in the existing P1 canonical history engine.
INSERT INTO finnor_os.canonical_truth_registry
  (entity_type,vertical_key,source_table,writable_owner,mutation_boundary,work_attachable)
VALUES
  ('pe_ic_case','private_equity','pe_ic_cases','@finnor/private-equity','createIcCase / transitionIcCase / selectIcBasis / finalizeIcDecision',true),
  ('pe_ic_memo','private_equity','pe_ic_memos','@finnor/private-equity','selectIcMemoVersion',false),
  ('pe_ic_question','private_equity','pe_ic_questions','@finnor/private-equity','createIcQuestion / answerIcQuestion / resolveIcQuestion / waiveIcQuestion',true),
  ('pe_ic_recommendation','private_equity','pe_ic_recommendations','@finnor/private-equity','createIcRecommendation revision append',false),
  ('pe_ic_vote','private_equity','pe_ic_votes','@finnor/private-equity','recordIcVote authenticated member only',false),
  ('pe_ic_dissent','private_equity','pe_ic_dissents','@finnor/private-equity','recordIcDissent authenticated member only',false),
  ('pe_ic_condition','private_equity','pe_ic_conditions','@finnor/private-equity','createIcCondition / transitionIcCondition / waiveIcCondition',true),
  ('pe_ic_decision_proposal','private_equity','pe_ic_decision_proposals','@finnor/private-equity','prepareIcDecisionProposal; final Decision remains P1',false);

DO $ic_history$ DECLARE captured timestamptz:=clock_timestamp(); row record; BEGIN
  FOR row IN SELECT * FROM (VALUES
    ('pe_ic_cases','pe_ic_case'),('pe_ic_memos','pe_ic_memo'),('pe_ic_questions','pe_ic_question'),
    ('pe_ic_recommendations','pe_ic_recommendation'),('pe_ic_votes','pe_ic_vote'),('pe_ic_dissents','pe_ic_dissent'),
    ('pe_ic_conditions','pe_ic_condition'),('pe_ic_decision_proposals','pe_ic_decision_proposal')
  ) AS owners(table_name,entity_type) LOOP
    EXECUTE format('CREATE TRIGGER canonical_history AFTER INSERT OR UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.append_canonical_entity_version(%L)',row.table_name,row.entity_type);
    INSERT INTO finnor_os.canonical_history_coverage(entity_type,source_table,vertical_key,coverage_started_at,baseline_completed_at)
      VALUES(row.entity_type,row.table_name,'private_equity',captured,captured);
  END LOOP;
END $ic_history$;

-- Extend P1 world-root resolution; no second temporal or entity registry exists.
CREATE OR REPLACE FUNCTION finnor_os.pe_entity_world_root(p_type text,p_id uuid)
RETURNS TABLE(root_type text,root_id uuid,deal_id uuid)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  CASE p_type
    WHEN 'pe_strategy' THEN RETURN QUERY SELECT 'pe_strategy'::text,s.id,NULL::uuid FROM finnor_os.pe_strategies s WHERE s.id=p_id;
    WHEN 'pe_opportunity' THEN RETURN QUERY SELECT 'pe_opportunity'::text,o.id,d.id FROM finnor_os.pe_opportunities o LEFT JOIN finnor_os.pe_deals d ON d.opportunity_id=o.id WHERE o.id=p_id;
    WHEN 'pe_deal' THEN RETURN QUERY SELECT 'pe_deal'::text,d.id,d.id FROM finnor_os.pe_deals d WHERE d.id=p_id;
    WHEN 'pe_investment_case' THEN RETURN QUERY SELECT 'pe_deal'::text,c.deal_id,c.deal_id FROM finnor_os.pe_investment_cases c WHERE c.id=p_id;
    WHEN 'pe_thesis' THEN RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_theses x WHERE x.id=p_id;
    WHEN 'pe_assumption' THEN RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_assumptions x WHERE x.id=p_id;
    WHEN 'pe_decision' THEN RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_decisions x WHERE x.id=p_id;
    WHEN 'pe_deal_party' THEN RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_deal_parties x WHERE x.id=p_id;
    WHEN 'pe_workstream' THEN RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_workstreams x WHERE x.id=p_id;
    WHEN 'pe_request' THEN RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_requests x WHERE x.id=p_id;
    WHEN 'pe_deliverable' THEN RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_deliverables x WHERE x.id=p_id;
    WHEN 'pe_finding' THEN RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_findings x WHERE x.id=p_id;
    WHEN 'pe_deal_risk' THEN RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_deal_risks x WHERE x.id=p_id;
    WHEN 'pe_dependency' THEN RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_dependencies x WHERE x.id=p_id;
    WHEN 'pe_milestone' THEN RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_milestones x WHERE x.id=p_id;
    WHEN 'pe_closing_condition' THEN RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_closing_conditions x WHERE x.id=p_id;
    WHEN 'pe_closing_item' THEN RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_closing_items x WHERE x.id=p_id;
    WHEN 'pe_finding_risk_link' THEN RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_finding_risk_links x WHERE x.id=p_id;
    WHEN 'pe_document_link' THEN RETURN QUERY SELECT x.world_root_type,x.world_root_id,x.deal_id FROM finnor_os.pe_document_links x WHERE x.id=p_id;
    WHEN 'pe_evidence_link' THEN RETURN QUERY SELECT x.world_root_type,x.world_root_id,x.deal_id FROM finnor_os.pe_evidence_links x WHERE x.id=p_id;
    WHEN 'pe_ic_case' THEN RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_ic_cases x WHERE x.id=p_id;
    WHEN 'pe_ic_memo' THEN RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_ic_memos x WHERE x.id=p_id;
    WHEN 'pe_ic_question' THEN RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_ic_questions x WHERE x.id=p_id;
    WHEN 'pe_ic_recommendation' THEN RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_ic_recommendations x WHERE x.id=p_id;
    WHEN 'pe_ic_vote' THEN RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_ic_votes x WHERE x.id=p_id;
    WHEN 'pe_ic_dissent' THEN RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_ic_dissents x WHERE x.id=p_id;
    WHEN 'pe_ic_condition' THEN RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_ic_conditions x WHERE x.id=p_id;
    WHEN 'pe_ic_decision_proposal' THEN RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_ic_decision_proposals x WHERE x.id=p_id;
    ELSE RETURN;
  END CASE;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.pe_entity_deal(p_type text,p_id uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,finnor_os AS $$
DECLARE resolved uuid;
BEGIN
  CASE p_type
    WHEN 'pe_strategy' THEN RETURN NULL;
    WHEN 'pe_opportunity' THEN SELECT d.id INTO resolved FROM finnor_os.pe_deals d WHERE d.opportunity_id=p_id;
    WHEN 'pe_deal' THEN SELECT id INTO resolved FROM finnor_os.pe_deals WHERE id=p_id;
    WHEN 'pe_investment_case' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_investment_cases WHERE id=p_id;
    WHEN 'pe_thesis' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_theses WHERE id=p_id;
    WHEN 'pe_assumption' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_assumptions WHERE id=p_id;
    WHEN 'pe_decision' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_decisions WHERE id=p_id;
    WHEN 'pe_deal_party' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_deal_parties WHERE id=p_id;
    WHEN 'pe_workstream' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_workstreams WHERE id=p_id;
    WHEN 'pe_request' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_requests WHERE id=p_id;
    WHEN 'pe_deliverable' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_deliverables WHERE id=p_id;
    WHEN 'pe_finding' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_findings WHERE id=p_id;
    WHEN 'pe_deal_risk' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_deal_risks WHERE id=p_id;
    WHEN 'pe_dependency' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_dependencies WHERE id=p_id;
    WHEN 'pe_milestone' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_milestones WHERE id=p_id;
    WHEN 'pe_closing_condition' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_closing_conditions WHERE id=p_id;
    WHEN 'pe_closing_item' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_closing_items WHERE id=p_id;
    WHEN 'pe_document_link' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_document_links WHERE id=p_id;
    WHEN 'pe_evidence_link' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_evidence_links WHERE id=p_id;
    WHEN 'pe_finding_risk_link' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_finding_risk_links WHERE id=p_id;
    WHEN 'pe_ic_case' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_ic_cases WHERE id=p_id;
    WHEN 'pe_ic_memo' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_ic_memos WHERE id=p_id;
    WHEN 'pe_ic_question' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_ic_questions WHERE id=p_id;
    WHEN 'pe_ic_recommendation' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_ic_recommendations WHERE id=p_id;
    WHEN 'pe_ic_vote' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_ic_votes WHERE id=p_id;
    WHEN 'pe_ic_dissent' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_ic_dissents WHERE id=p_id;
    WHEN 'pe_ic_condition' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_ic_conditions WHERE id=p_id;
    WHEN 'pe_ic_decision_proposal' THEN SELECT deal_id INTO resolved FROM finnor_os.pe_ic_decision_proposals WHERE id=p_id;
    ELSE RETURN NULL;
  END CASE;
  RETURN resolved;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.append_ic_business_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE body jsonb:=to_jsonb(NEW); old_body jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
DECLARE kind text:=TG_ARGV[0]; event_name text; actor text;
BEGIN
  event_name:=CASE
    WHEN kind='pe_ic_case' AND TG_OP='INSERT' THEN 'ic_case_opened'
    WHEN kind='pe_ic_case' AND body->>'state' IS DISTINCT FROM old_body->>'state' THEN 'ic_case_'||lower(body->>'state')
    WHEN kind='pe_ic_memo' THEN 'ic_memo_version_selected'
    WHEN kind='pe_ic_question' AND TG_OP='INSERT' THEN 'ic_question_opened'
    WHEN kind='pe_ic_question' THEN 'ic_question_'||lower(body->>'state')
    WHEN kind='pe_ic_recommendation' THEN 'ic_recommendation_created'
    WHEN kind='pe_ic_vote' THEN 'ic_vote_recorded'
    WHEN kind='pe_ic_dissent' THEN 'ic_dissent_recorded'
    WHEN kind='pe_ic_condition' AND TG_OP='INSERT' THEN 'ic_condition_created'
    WHEN kind='pe_ic_condition' THEN 'ic_condition_'||lower(body->>'state')
    WHEN kind='pe_ic_decision_proposal' THEN 'ic_decision_proposal_prepared'
    WHEN kind='pe_ic_decision_link' THEN 'ic_decision_finalized'
    ELSE NULL END;
  IF event_name IS NULL THEN RETURN NEW; END IF;
  actor:=coalesce(nullif(current_setting('app.pe_actor',true),''),body->>'created_by',body->>'employee_id',body->>'finalized_by');
  INSERT INTO finnor_os.business_events(tenant_id,entity_type,entity_id,event_type,payload,source)
  VALUES(NEW.tenant_id,
    CASE WHEN kind='pe_ic_decision_link' THEN 'pe_ic_case' ELSE kind END,
    CASE WHEN kind='pe_ic_decision_link' THEN (body->>'ic_case_id')::uuid ELSE NEW.id END,
    event_name,jsonb_strip_nulls(jsonb_build_object(
    'icCaseId',body->>'ic_case_id','investmentCaseId',body->>'investment_case_id','dealId',body->>'deal_id',
    'recommendationId',body->>'recommendation_id','questionId',CASE WHEN kind='pe_ic_question' THEN body->>'id' END,
    'voteId',CASE WHEN kind='pe_ic_vote' THEN body->>'id' END,'conditionId',CASE WHEN kind='pe_ic_condition' THEN body->>'id' END,
    'decisionId',body->>'decision_id','documentVersionId',body->>'document_version_id','underwritingRunId',body->>'underwriting_run_id',
    'state',body->>'state','result',coalesce(body->>'process_status',body->>'choice'),'actor',actor,'version',body->>'version'
  )),coalesce(nullif(current_setting('app.pe_source',true),''),'@finnor/private-equity'));
  RETURN NEW;
END $$;

DO $ic_events$ DECLARE row record; BEGIN
  FOR row IN SELECT * FROM (VALUES
    ('pe_ic_cases','pe_ic_case'),('pe_ic_memos','pe_ic_memo'),('pe_ic_questions','pe_ic_question'),
    ('pe_ic_recommendations','pe_ic_recommendation'),('pe_ic_votes','pe_ic_vote'),('pe_ic_dissents','pe_ic_dissent'),
    ('pe_ic_conditions','pe_ic_condition'),('pe_ic_decision_proposals','pe_ic_decision_proposal'),('pe_ic_decision_links','pe_ic_decision_link')
  ) AS events(table_name,entity_type) LOOP
    EXECUTE format('CREATE TRIGGER pe_ic_business_event AFTER INSERT OR UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.append_ic_business_event(%L)',row.table_name,row.entity_type);
  END LOOP;
END $ic_events$;

DO $ic_security$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'pe_ic_committee_config_versions','pe_ic_committee_membership_versions','pe_ic_cases','pe_ic_memos','pe_ic_questions',
    'pe_ic_recommendations','pe_ic_votes','pe_ic_dissents','pe_ic_conditions','pe_ic_source_links','pe_ic_decision_proposals','pe_ic_decision_links','pe_ic_decision_condition_links'
  ] LOOP
    EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON finnor_os.%I USING (tenant_id=(SELECT finnor_os.request_tenant_id())) WITH CHECK (tenant_id=(SELECT finnor_os.request_tenant_id()))',table_name);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
      EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',table_name);
      EXECUTE format('REVOKE DELETE ON finnor_os.%I FROM finnor_app',table_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
    GRANT UPDATE ON finnor_os.pe_ic_cases,finnor_os.pe_ic_questions,finnor_os.pe_ic_conditions TO finnor_app;
    REVOKE UPDATE ON finnor_os.pe_ic_committee_config_versions,finnor_os.pe_ic_committee_membership_versions,
      finnor_os.pe_ic_memos,finnor_os.pe_ic_recommendations,finnor_os.pe_ic_votes,finnor_os.pe_ic_dissents,
      finnor_os.pe_ic_source_links,finnor_os.pe_ic_decision_proposals,finnor_os.pe_ic_decision_links,
      finnor_os.pe_ic_decision_condition_links FROM finnor_app;
  END IF;
END $ic_security$;

DO $ic_immutability$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'pe_ic_committee_config_versions','pe_ic_committee_membership_versions','pe_ic_memos','pe_ic_recommendations',
    'pe_ic_votes','pe_ic_dissents','pe_ic_source_links','pe_ic_decision_proposals','pe_ic_decision_links','pe_ic_decision_condition_links'
  ] LOOP
    EXECUTE format('CREATE TRIGGER immutable_ic_history BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.reject_ic_history_mutation()',table_name);
  END LOOP;
  CREATE TRIGGER immutable_ic_case_delete BEFORE DELETE ON finnor_os.pe_ic_cases FOR EACH ROW EXECUTE FUNCTION finnor_os.reject_ic_history_mutation();
  CREATE TRIGGER immutable_ic_question_delete BEFORE DELETE ON finnor_os.pe_ic_questions FOR EACH ROW EXECUTE FUNCTION finnor_os.reject_ic_history_mutation();
  CREATE TRIGGER immutable_ic_condition_delete BEFORE DELETE ON finnor_os.pe_ic_conditions FOR EACH ROW EXECUTE FUNCTION finnor_os.reject_ic_history_mutation();
END $ic_immutability$;

CREATE INDEX pe_ic_cases_deal_state_idx ON finnor_os.pe_ic_cases(tenant_id,deal_id,state,created_at DESC,id);
CREATE INDEX pe_ic_memos_case_role_idx ON finnor_os.pe_ic_memos(tenant_id,ic_case_id,artifact_role,revision DESC);
CREATE INDEX pe_ic_recommendations_case_revision_idx ON finnor_os.pe_ic_recommendations(tenant_id,ic_case_id,revision DESC);
CREATE INDEX pe_ic_proposals_case_created_idx ON finnor_os.pe_ic_decision_proposals(tenant_id,ic_case_id,created_at DESC,id);

-- Existing owner roles receive only bounded IC governance capabilities. Custom
-- roles are untouched and may be configured through the existing Authority owner.
CREATE OR REPLACE FUNCTION finnor_os.sync_ic_owner_authority() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF NEW.legacy_role='owner' THEN
    INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk,approval_required)
    SELECT NEW.tenant_id,NEW.id,capability,'pe_ic_case','allow','high',false
      FROM unnest(ARRAY['ic:configure_committee','ic:open_case','ic:open_voting','ic:close_voting','ic:waive_question','ic:waive_condition','ic:finalize_decision']) capability
    ON CONFLICT(role_id,capability,resource_type) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER employee_roles_ic_owner_authority AFTER INSERT OR UPDATE OF legacy_role ON finnor_os.employee_roles
  FOR EACH ROW EXECUTE FUNCTION finnor_os.sync_ic_owner_authority();
INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk,approval_required)
SELECT role.tenant_id,role.id,capability,'pe_ic_case','allow','high',false
FROM finnor_os.employee_roles role
CROSS JOIN unnest(ARRAY['ic:configure_committee','ic:open_case','ic:open_voting','ic:close_voting','ic:waive_question','ic:waive_condition','ic:finalize_decision']) capability
WHERE role.legacy_role='owner'
ON CONFLICT(role_id,capability,resource_type) DO NOTHING;

REVOKE EXECUTE ON FUNCTION finnor_os.reject_ic_history_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.ic_authority_allows(uuid,uuid,uuid,text[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.assert_ic_committee_configuration() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.assert_ic_committee_member() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.assert_ic_config_has_voters() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.assert_ic_case_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.assert_ic_memo() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.assert_ic_question_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.assert_ic_recommendation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.assert_ic_vote() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.bump_ic_vote_set() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.assert_ic_dissent() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.assert_ic_condition_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.assert_ic_source_link() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.assert_ic_decision_proposal() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.assert_ic_decision_link() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.assert_ic_decision_conditions_complete() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.append_ic_business_event() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.bump_ic_case_for_child() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.refresh_ic_question_substantiation() FROM PUBLIC;

COMMENT ON TABLE finnor_os.pe_ic_cases IS 'P5 governed IC process for one exact P1 InvestmentCase; never a duplicate InvestmentCase or Decision.';
COMMENT ON TABLE finnor_os.pe_ic_memos IS 'Thin immutable IC selection of an exact P3 DocumentVersion; document content remains P3-owned.';
COMMENT ON TABLE finnor_os.pe_ic_votes IS 'Authenticated immutable committee-member attestation; distinct from Authority approval and P1 Decision.';
COMMENT ON TABLE finnor_os.pe_ic_decision_proposals IS 'Deterministic immutable process aggregate; not the canonical investment Decision.';
COMMENT ON TABLE finnor_os.pe_ic_conditions IS 'Investment-approval condition; deliberately distinct from transaction pe_closing_conditions.';
