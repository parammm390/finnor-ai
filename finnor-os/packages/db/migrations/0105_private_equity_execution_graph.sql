-- Private Equity Phase 2: canonical signed-LOI -> verified-close execution graph.
-- PE owns these tables and mutations. Existing Core owns identity, Work, Task,
-- Document, Evidence, authority/approval, DecisionReceipt, and BusinessEvent.

DO $parent_keys$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE connamespace='finnor_os'::regnamespace AND conname='documents_tenant_id_id_key') THEN
    ALTER TABLE finnor_os.documents ADD CONSTRAINT documents_tenant_id_id_key UNIQUE (tenant_id,id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE connamespace='finnor_os'::regnamespace AND conname='decision_receipts_tenant_id_id_key') THEN
    ALTER TABLE finnor_os.decision_receipts ADD CONSTRAINT decision_receipts_tenant_id_id_key UNIQUE (tenant_id,id);
  END IF;
END $parent_keys$;

CREATE TABLE finnor_os.pe_deals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  target_organization_id uuid NOT NULL,
  name text NOT NULL CHECK (btrim(name)<>''),
  code_name text CHECK (code_name IS NULL OR btrim(code_name)<>''),
  deal_lead_employee_id uuid NOT NULL,
  signed_loi_at timestamptz NOT NULL,
  signed_loi_document_id uuid,
  target_closing_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed','terminated')),
  actual_close_at timestamptz,
  close_authority_decision_id uuid,
  close_decision_receipt_id uuid,
  terminated_at timestamptz,
  termination_reason text,
  termination_authority_decision_id uuid,
  termination_decision_receipt_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  graph_version integer NOT NULL DEFAULT 1 CHECK (graph_version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_deals_tenant_id_id_key UNIQUE (tenant_id,id),
  CONSTRAINT pe_deals_source_identity_key UNIQUE (tenant_id,source_system,external_id),
  CONSTRAINT pe_deals_target_tenant_fkey FOREIGN KEY (tenant_id,target_organization_id)
    REFERENCES finnor_os.external_organizations(tenant_id,id),
  CONSTRAINT pe_deals_lead_tenant_fkey FOREIGN KEY (tenant_id,deal_lead_employee_id)
    REFERENCES finnor_os.users(tenant_id,id),
  CONSTRAINT pe_deals_loi_document_tenant_fkey FOREIGN KEY (tenant_id,signed_loi_document_id)
    REFERENCES finnor_os.documents(tenant_id,id),
  CONSTRAINT pe_deals_close_authority_tenant_fkey FOREIGN KEY (tenant_id,close_authority_decision_id)
    REFERENCES finnor_os.authority_decisions(tenant_id,id),
  CONSTRAINT pe_deals_close_receipt_tenant_fkey FOREIGN KEY (tenant_id,close_decision_receipt_id)
    REFERENCES finnor_os.decision_receipts(tenant_id,id),
  CONSTRAINT pe_deals_termination_authority_tenant_fkey FOREIGN KEY (tenant_id,termination_authority_decision_id)
    REFERENCES finnor_os.authority_decisions(tenant_id,id),
  CONSTRAINT pe_deals_termination_receipt_tenant_fkey FOREIGN KEY (tenant_id,termination_decision_receipt_id)
    REFERENCES finnor_os.decision_receipts(tenant_id,id),
  CONSTRAINT pe_deals_terminal_truth_check CHECK (
    (status='active' AND actual_close_at IS NULL AND terminated_at IS NULL AND termination_reason IS NULL)
    OR (status='closed' AND actual_close_at IS NOT NULL AND terminated_at IS NULL AND termination_reason IS NULL)
    OR (status='terminated' AND actual_close_at IS NULL AND terminated_at IS NOT NULL AND btrim(termination_reason)<>'')
  )
);
CREATE INDEX pe_deals_tenant_status_target_idx ON finnor_os.pe_deals(tenant_id,status,target_closing_at,id);
CREATE INDEX pe_deals_tenant_target_idx ON finnor_os.pe_deals(tenant_id,target_organization_id,id);

CREATE TABLE finnor_os.pe_deal_parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  party_type text NOT NULL CHECK (party_type IN ('employee','team','external_organization','external_contact')),
  party_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN (
    'buyer_sponsor','target_management','seller','sell_side_banker','lender',
    'buyer_legal_counsel','seller_legal_counsel','qoe_advisor','tax_advisor',
    'commercial_advisor','technology_advisor','insurance_advisor','other'
  )),
  role_label text,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','removed')),
  removed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_deal_parties_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_deal_parties_deal_tenant_fkey FOREIGN KEY (tenant_id,deal_id)
    REFERENCES finnor_os.pe_deals(tenant_id,id),
  CONSTRAINT pe_deal_parties_other_role_check CHECK ((role='other')=(role_label IS NOT NULL AND btrim(role_label)<>'')),
  CONSTRAINT pe_deal_parties_removed_check CHECK ((state='active' AND removed_at IS NULL) OR (state='removed' AND removed_at IS NOT NULL))
);
CREATE UNIQUE INDEX pe_deal_parties_active_identity_idx
  ON finnor_os.pe_deal_parties(deal_id,party_type,party_id,role) WHERE state='active';
CREATE INDEX pe_deal_parties_tenant_deal_role_idx ON finnor_os.pe_deal_parties(tenant_id,deal_id,role,state,id);

CREATE TABLE finnor_os.pe_workstreams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('financial_diligence','legal','tax','commercial','technology','financing','insurance','regulatory','closing','custom')),
  name text NOT NULL CHECK (btrim(name)<>''),
  owner_party_type text NOT NULL CHECK (owner_party_type IN ('employee','team')),
  owner_party_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'not_started' CHECK (state IN ('not_started','active','complete','cancelled')),
  completed_at timestamptz,
  cancelled_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_workstreams_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_workstreams_deal_tenant_fkey FOREIGN KEY (tenant_id,deal_id)
    REFERENCES finnor_os.pe_deals(tenant_id,id),
  CONSTRAINT pe_workstreams_terminal_check CHECK (
    (state IN ('not_started','active') AND completed_at IS NULL AND cancelled_at IS NULL)
    OR (state='complete' AND completed_at IS NOT NULL AND cancelled_at IS NULL)
    OR (state='cancelled' AND completed_at IS NULL AND cancelled_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX pe_workstreams_active_identity_idx ON finnor_os.pe_workstreams(deal_id,kind,lower(name)) WHERE archived_at IS NULL;
CREATE INDEX pe_workstreams_tenant_deal_state_idx ON finnor_os.pe_workstreams(tenant_id,deal_id,state,id);

CREATE TABLE finnor_os.pe_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  workstream_id uuid NOT NULL,
  requested_from_deal_party_id uuid NOT NULL,
  owner_party_type text NOT NULL CHECK (owner_party_type IN ('employee','team')),
  owner_party_id uuid NOT NULL,
  request_text text NOT NULL CHECK (btrim(request_text)<>''),
  requested_at timestamptz NOT NULL,
  due_at timestamptz,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','acknowledged','fulfilled','cancelled')),
  requires_accepted_deliverable boolean NOT NULL DEFAULT false,
  acknowledged_at timestamptz,
  fulfilled_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_requests_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_requests_workstream_fkey FOREIGN KEY (tenant_id,deal_id,workstream_id)
    REFERENCES finnor_os.pe_workstreams(tenant_id,deal_id,id),
  CONSTRAINT pe_requests_party_fkey FOREIGN KEY (tenant_id,deal_id,requested_from_deal_party_id)
    REFERENCES finnor_os.pe_deal_parties(tenant_id,deal_id,id),
  CONSTRAINT pe_requests_state_timestamps_check CHECK (
    (state='open' AND acknowledged_at IS NULL AND fulfilled_at IS NULL AND cancelled_at IS NULL)
    OR (state='acknowledged' AND acknowledged_at IS NOT NULL AND fulfilled_at IS NULL AND cancelled_at IS NULL)
    OR (state='fulfilled' AND fulfilled_at IS NOT NULL AND cancelled_at IS NULL)
    OR (state='cancelled' AND fulfilled_at IS NULL AND cancelled_at IS NOT NULL AND btrim(cancellation_reason)<>'')
  )
);
CREATE INDEX pe_requests_tenant_deal_state_due_idx ON finnor_os.pe_requests(tenant_id,deal_id,state,due_at,id);
CREATE INDEX pe_requests_tenant_workstream_state_idx ON finnor_os.pe_requests(tenant_id,workstream_id,state,id);

CREATE TABLE finnor_os.pe_deliverables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  workstream_id uuid NOT NULL,
  request_id uuid,
  responsible_deal_party_id uuid NOT NULL,
  description text NOT NULL CHECK (btrim(description)<>''),
  kind text NOT NULL CHECK (btrim(kind)<>''),
  due_at timestamptz,
  state text NOT NULL DEFAULT 'expected' CHECK (state IN ('expected','received','accepted','rejected','superseded','cancelled')),
  requires_document boolean NOT NULL DEFAULT true,
  required_for_workstream_completion boolean NOT NULL DEFAULT true,
  received_at timestamptz,
  accepted_at timestamptz,
  rejected_at timestamptz,
  rejection_reason text,
  superseded_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_deliverables_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_deliverables_workstream_fkey FOREIGN KEY (tenant_id,deal_id,workstream_id)
    REFERENCES finnor_os.pe_workstreams(tenant_id,deal_id,id),
  CONSTRAINT pe_deliverables_request_fkey FOREIGN KEY (tenant_id,deal_id,request_id)
    REFERENCES finnor_os.pe_requests(tenant_id,deal_id,id),
  CONSTRAINT pe_deliverables_party_fkey FOREIGN KEY (tenant_id,deal_id,responsible_deal_party_id)
    REFERENCES finnor_os.pe_deal_parties(tenant_id,deal_id,id),
  CONSTRAINT pe_deliverables_state_timestamps_check CHECK (
    (state='expected' AND received_at IS NULL AND accepted_at IS NULL AND rejected_at IS NULL AND superseded_at IS NULL AND cancelled_at IS NULL)
    OR (state='received' AND received_at IS NOT NULL AND accepted_at IS NULL AND rejected_at IS NULL AND superseded_at IS NULL AND cancelled_at IS NULL)
    OR (state='accepted' AND received_at IS NOT NULL AND accepted_at IS NOT NULL AND superseded_at IS NULL AND cancelled_at IS NULL)
    OR (state='rejected' AND received_at IS NOT NULL AND rejected_at IS NOT NULL AND btrim(rejection_reason)<>'' AND superseded_at IS NULL AND cancelled_at IS NULL)
    OR (state='superseded' AND superseded_at IS NOT NULL AND cancelled_at IS NULL)
    OR (state='cancelled' AND cancelled_at IS NOT NULL AND btrim(cancellation_reason)<>'')
  )
);
CREATE INDEX pe_deliverables_tenant_deal_state_due_idx ON finnor_os.pe_deliverables(tenant_id,deal_id,state,due_at,id);
CREATE INDEX pe_deliverables_tenant_request_idx ON finnor_os.pe_deliverables(tenant_id,request_id,state,id);

CREATE TABLE finnor_os.pe_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  workstream_id uuid NOT NULL,
  related_request_id uuid,
  related_deliverable_id uuid,
  statement text NOT NULL CHECK (btrim(statement)<>''),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  materiality text NOT NULL CHECK (materiality IN ('immaterial','non_material','material','critical')),
  owner_party_type text NOT NULL CHECK (owner_party_type IN ('employee','team')),
  owner_party_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved','accepted','superseded')),
  required_for_workstream_completion boolean NOT NULL DEFAULT false,
  disposition text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  accepted_at timestamptz,
  superseded_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_findings_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_findings_workstream_fkey FOREIGN KEY (tenant_id,deal_id,workstream_id)
    REFERENCES finnor_os.pe_workstreams(tenant_id,deal_id,id),
  CONSTRAINT pe_findings_request_fkey FOREIGN KEY (tenant_id,deal_id,related_request_id)
    REFERENCES finnor_os.pe_requests(tenant_id,deal_id,id),
  CONSTRAINT pe_findings_deliverable_fkey FOREIGN KEY (tenant_id,deal_id,related_deliverable_id)
    REFERENCES finnor_os.pe_deliverables(tenant_id,deal_id,id),
  CONSTRAINT pe_findings_state_timestamps_check CHECK (
    (state='open' AND resolved_at IS NULL AND accepted_at IS NULL AND superseded_at IS NULL)
    OR (state='resolved' AND resolved_at IS NOT NULL AND btrim(disposition)<>'')
    OR (state='accepted' AND accepted_at IS NOT NULL AND btrim(disposition)<>'')
    OR (state='superseded' AND superseded_at IS NOT NULL AND btrim(disposition)<>'')
  )
);
CREATE INDEX pe_findings_tenant_deal_state_idx ON finnor_os.pe_findings(tenant_id,deal_id,state,severity,id);

CREATE TABLE finnor_os.pe_deal_risks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  workstream_id uuid NOT NULL,
  statement text NOT NULL CHECK (btrim(statement)<>''),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  owner_party_type text NOT NULL CHECK (owner_party_type IN ('employee','team')),
  owner_party_id uuid NOT NULL,
  response text,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','mitigating','resolved','accepted')),
  required_for_workstream_completion boolean NOT NULL DEFAULT false,
  mitigating_at timestamptz,
  resolved_at timestamptz,
  accepted_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_deal_risks_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_deal_risks_workstream_fkey FOREIGN KEY (tenant_id,deal_id,workstream_id)
    REFERENCES finnor_os.pe_workstreams(tenant_id,deal_id,id),
  CONSTRAINT pe_deal_risks_state_timestamps_check CHECK (
    (state='open' AND mitigating_at IS NULL AND resolved_at IS NULL AND accepted_at IS NULL)
    OR (state='mitigating' AND mitigating_at IS NOT NULL AND resolved_at IS NULL AND accepted_at IS NULL)
    OR (state='resolved' AND resolved_at IS NOT NULL AND btrim(response)<>'')
    OR (state='accepted' AND accepted_at IS NOT NULL AND btrim(response)<>'')
  )
);
CREATE INDEX pe_deal_risks_tenant_deal_state_idx ON finnor_os.pe_deal_risks(tenant_id,deal_id,state,severity,id);

CREATE TABLE finnor_os.pe_finding_risk_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  finding_id uuid NOT NULL,
  deal_risk_id uuid NOT NULL,
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT pe_finding_risk_links_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_finding_risk_links_finding_fkey FOREIGN KEY (tenant_id,deal_id,finding_id)
    REFERENCES finnor_os.pe_findings(tenant_id,deal_id,id),
  CONSTRAINT pe_finding_risk_links_risk_fkey FOREIGN KEY (tenant_id,deal_id,deal_risk_id)
    REFERENCES finnor_os.pe_deal_risks(tenant_id,deal_id,id),
  CONSTRAINT pe_finding_risk_links_identity_key UNIQUE (finding_id,deal_risk_id)
);

CREATE TABLE finnor_os.pe_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  name text NOT NULL CHECK (btrim(name)<>''),
  kind text NOT NULL CHECK (btrim(kind)<>''),
  owner_party_type text NOT NULL CHECK (owner_party_type IN ('employee','team')),
  owner_party_id uuid NOT NULL,
  target_at timestamptz NOT NULL,
  achieved_at timestamptz,
  cancelled_at timestamptz,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','achieved','cancelled')),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_milestones_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_milestones_deal_fkey FOREIGN KEY (tenant_id,deal_id)
    REFERENCES finnor_os.pe_deals(tenant_id,id),
  CONSTRAINT pe_milestones_state_timestamps_check CHECK (
    (state='pending' AND achieved_at IS NULL AND cancelled_at IS NULL)
    OR (state='achieved' AND achieved_at IS NOT NULL AND cancelled_at IS NULL)
    OR (state='cancelled' AND achieved_at IS NULL AND cancelled_at IS NOT NULL)
  )
);
CREATE INDEX pe_milestones_tenant_deal_state_target_idx ON finnor_os.pe_milestones(tenant_id,deal_id,state,target_at,id);

CREATE TABLE finnor_os.pe_closing_conditions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  workstream_id uuid NOT NULL,
  condition_text text NOT NULL CHECK (btrim(condition_text)<>''),
  category text NOT NULL CHECK (btrim(category)<>''),
  required_for_close boolean NOT NULL DEFAULT true,
  evidence_required boolean NOT NULL DEFAULT true,
  waiver_requires_approval boolean NOT NULL DEFAULT true,
  owner_party_type text NOT NULL CHECK (owner_party_type IN ('employee','team')),
  owner_party_id uuid NOT NULL,
  responsible_deal_party_id uuid,
  due_at timestamptz,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','evidence_pending','satisfied','waived','failed')),
  satisfied_at timestamptz,
  waived_at timestamptz,
  waiver_reason text,
  waiver_authority_decision_id uuid,
  waiver_decision_receipt_id uuid,
  failed_at timestamptz,
  failure_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_closing_conditions_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_closing_conditions_workstream_fkey FOREIGN KEY (tenant_id,deal_id,workstream_id)
    REFERENCES finnor_os.pe_workstreams(tenant_id,deal_id,id),
  CONSTRAINT pe_closing_conditions_party_fkey FOREIGN KEY (tenant_id,deal_id,responsible_deal_party_id)
    REFERENCES finnor_os.pe_deal_parties(tenant_id,deal_id,id),
  CONSTRAINT pe_closing_conditions_authority_tenant_fkey FOREIGN KEY (tenant_id,waiver_authority_decision_id)
    REFERENCES finnor_os.authority_decisions(tenant_id,id),
  CONSTRAINT pe_closing_conditions_receipt_tenant_fkey FOREIGN KEY (tenant_id,waiver_decision_receipt_id)
    REFERENCES finnor_os.decision_receipts(tenant_id,id),
  CONSTRAINT pe_closing_conditions_state_timestamps_check CHECK (
    (state IN ('open','evidence_pending') AND satisfied_at IS NULL AND waived_at IS NULL AND failed_at IS NULL)
    OR (state='satisfied' AND satisfied_at IS NOT NULL AND waived_at IS NULL AND failed_at IS NULL)
    OR (state='waived' AND waived_at IS NOT NULL AND btrim(waiver_reason)<>'' AND satisfied_at IS NULL AND failed_at IS NULL)
    OR (state='failed' AND failed_at IS NOT NULL AND btrim(failure_reason)<>'' AND satisfied_at IS NULL AND waived_at IS NULL)
  )
);
CREATE INDEX pe_closing_conditions_tenant_deal_required_state_idx ON finnor_os.pe_closing_conditions(tenant_id,deal_id,required_for_close,state,id);

CREATE TABLE finnor_os.pe_closing_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  workstream_id uuid NOT NULL,
  item_text text NOT NULL CHECK (btrim(item_text)<>''),
  category text NOT NULL CHECK (btrim(category)<>''),
  required_for_close boolean NOT NULL DEFAULT true,
  verification_evidence_required boolean NOT NULL DEFAULT true,
  owner_party_type text NOT NULL CHECK (owner_party_type IN ('employee','team')),
  owner_party_id uuid NOT NULL,
  responsible_deal_party_id uuid,
  due_at timestamptz,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','ready','verified','cancelled')),
  ready_at timestamptz,
  verified_at timestamptz,
  verified_by_employee_id uuid,
  verification_source text,
  cancelled_at timestamptz,
  cancellation_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_closing_items_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_closing_items_workstream_fkey FOREIGN KEY (tenant_id,deal_id,workstream_id)
    REFERENCES finnor_os.pe_workstreams(tenant_id,deal_id,id),
  CONSTRAINT pe_closing_items_party_fkey FOREIGN KEY (tenant_id,deal_id,responsible_deal_party_id)
    REFERENCES finnor_os.pe_deal_parties(tenant_id,deal_id,id),
  CONSTRAINT pe_closing_items_verifier_fkey FOREIGN KEY (tenant_id,verified_by_employee_id)
    REFERENCES finnor_os.users(tenant_id,id),
  CONSTRAINT pe_closing_items_state_timestamps_check CHECK (
    (state='open' AND ready_at IS NULL AND verified_at IS NULL AND cancelled_at IS NULL)
    OR (state='ready' AND ready_at IS NOT NULL AND verified_at IS NULL AND cancelled_at IS NULL)
    OR (state='verified' AND ready_at IS NOT NULL AND verified_at IS NOT NULL AND cancelled_at IS NULL
      AND (verified_by_employee_id IS NOT NULL OR btrim(verification_source)<>''))
    OR (state='cancelled' AND verified_at IS NULL AND cancelled_at IS NOT NULL AND btrim(cancellation_reason)<>'')
  )
);
CREATE INDEX pe_closing_items_tenant_deal_required_state_idx ON finnor_os.pe_closing_items(tenant_id,deal_id,required_for_close,state,id);

CREATE TABLE finnor_os.pe_dependencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  blocker_type text NOT NULL CHECK (blocker_type IN ('pe_workstream','pe_request','pe_deliverable','pe_finding','pe_deal_risk','pe_milestone','pe_closing_condition','pe_closing_item')),
  blocker_id uuid NOT NULL,
  blocked_type text NOT NULL CHECK (blocked_type IN ('pe_workstream','pe_request','pe_deliverable','pe_finding','pe_deal_risk','pe_milestone','pe_closing_condition','pe_closing_item')),
  blocked_id uuid NOT NULL,
  relation text NOT NULL DEFAULT 'blocks' CHECK (relation='blocks'),
  removed_at timestamptz,
  removed_by text,
  removal_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_dependencies_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_dependencies_deal_fkey FOREIGN KEY (tenant_id,deal_id)
    REFERENCES finnor_os.pe_deals(tenant_id,id),
  CONSTRAINT pe_dependencies_not_self_check CHECK ((blocker_type,blocker_id)<>(blocked_type,blocked_id)),
  CONSTRAINT pe_dependencies_removed_check CHECK (
    (removed_at IS NULL AND removed_by IS NULL AND removal_reason IS NULL)
    OR (removed_at IS NOT NULL AND btrim(removed_by)<>'' AND btrim(removal_reason)<>'')
  )
);
CREATE UNIQUE INDEX pe_dependencies_active_identity_idx
  ON finnor_os.pe_dependencies(deal_id,blocker_type,blocker_id,blocked_type,blocked_id) WHERE removed_at IS NULL;
CREATE INDEX pe_dependencies_tenant_deal_blocked_idx ON finnor_os.pe_dependencies(tenant_id,deal_id,blocked_type,blocked_id) WHERE removed_at IS NULL;

CREATE TABLE finnor_os.pe_document_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('pe_deal','pe_request','pe_deliverable','pe_finding','pe_closing_condition','pe_closing_item')),
  entity_id uuid NOT NULL,
  document_id uuid NOT NULL,
  link_role text NOT NULL CHECK (link_role IN ('source','submission','accepted','rejected','superseded','governing','verification')),
  supersedes_link_id uuid REFERENCES finnor_os.pe_document_links(id),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_document_links_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_document_links_deal_fkey FOREIGN KEY (tenant_id,deal_id)
    REFERENCES finnor_os.pe_deals(tenant_id,id),
  CONSTRAINT pe_document_links_document_fkey FOREIGN KEY (tenant_id,document_id)
    REFERENCES finnor_os.documents(tenant_id,id),
  CONSTRAINT pe_document_links_identity_key UNIQUE (entity_type,entity_id,document_id,link_role)
);
CREATE INDEX pe_document_links_tenant_deal_entity_idx ON finnor_os.pe_document_links(tenant_id,deal_id,entity_type,entity_id,created_at,id);

CREATE TABLE finnor_os.pe_evidence_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('pe_finding','pe_deal_risk','pe_closing_condition','pe_closing_item')),
  entity_id uuid NOT NULL,
  evidence_source_id uuid NOT NULL REFERENCES finnor_os.evidence_sources(id),
  evidence_version_id uuid REFERENCES finnor_os.evidence_source_versions(id),
  relationship text NOT NULL CHECK (relationship IN ('supports','verifies','authorizes')),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_evidence_links_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_evidence_links_deal_fkey FOREIGN KEY (tenant_id,deal_id)
    REFERENCES finnor_os.pe_deals(tenant_id,id),
  CONSTRAINT pe_evidence_links_identity_key UNIQUE (entity_type,entity_id,evidence_source_id,evidence_version_id,relationship)
);
CREATE INDEX pe_evidence_links_tenant_deal_entity_idx ON finnor_os.pe_evidence_links(tenant_id,deal_id,entity_type,entity_id,created_at,id);

CREATE OR REPLACE FUNCTION finnor_os.pe_party_tenant(p_type text,p_id uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,finnor_os AS $$
DECLARE resolved uuid;
BEGIN
  CASE p_type
    WHEN 'employee' THEN SELECT tenant_id INTO resolved FROM finnor_os.users WHERE id=p_id AND status='active';
    WHEN 'team' THEN SELECT tenant_id INTO resolved FROM finnor_os.org_units WHERE id=p_id AND active;
    WHEN 'external_organization' THEN SELECT tenant_id INTO resolved FROM finnor_os.external_organizations WHERE id=p_id AND active;
    WHEN 'external_contact' THEN SELECT tenant_id INTO resolved FROM finnor_os.external_contacts WHERE id=p_id AND active;
    ELSE RAISE EXCEPTION 'unsupported PE PartyRef type: %',p_type;
  END CASE;
  RETURN resolved;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.pe_entity_deal(p_type text,p_id uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,finnor_os AS $$
DECLARE resolved uuid;
BEGIN
  CASE p_type
    WHEN 'pe_deal' THEN SELECT id INTO resolved FROM finnor_os.pe_deals WHERE id=p_id;
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
    ELSE RETURN NULL;
  END CASE;
  RETURN resolved;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.pe_endpoint_resolved(p_type text,p_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,finnor_os AS $$
DECLARE resolved boolean;
BEGIN
  CASE p_type
    WHEN 'pe_workstream' THEN SELECT state IN ('complete','cancelled') INTO resolved FROM finnor_os.pe_workstreams WHERE id=p_id;
    WHEN 'pe_request' THEN SELECT state IN ('fulfilled','cancelled') INTO resolved FROM finnor_os.pe_requests WHERE id=p_id;
    WHEN 'pe_deliverable' THEN SELECT state IN ('accepted','superseded','cancelled') INTO resolved FROM finnor_os.pe_deliverables WHERE id=p_id;
    WHEN 'pe_finding' THEN SELECT state IN ('resolved','accepted','superseded') INTO resolved FROM finnor_os.pe_findings WHERE id=p_id;
    WHEN 'pe_deal_risk' THEN SELECT state IN ('resolved','accepted') INTO resolved FROM finnor_os.pe_deal_risks WHERE id=p_id;
    WHEN 'pe_milestone' THEN SELECT state IN ('achieved','cancelled') INTO resolved FROM finnor_os.pe_milestones WHERE id=p_id;
    WHEN 'pe_closing_condition' THEN SELECT state IN ('satisfied','waived') INTO resolved FROM finnor_os.pe_closing_conditions WHERE id=p_id;
    WHEN 'pe_closing_item' THEN SELECT state IN ('verified','cancelled') INTO resolved FROM finnor_os.pe_closing_items WHERE id=p_id;
    ELSE RAISE EXCEPTION 'unsupported PE dependency endpoint type: %',p_type;
  END CASE;
  RETURN coalesce(resolved,false);
END $$;

CREATE OR REPLACE FUNCTION finnor_os.pe_governance_proof_valid(
  p_tenant uuid,p_resource_type text,p_resource_id uuid,p_capability text,
  p_authority_decision uuid,p_decision_receipt uuid,p_require_current_revision boolean DEFAULT false,
  p_require_approval boolean DEFAULT false
) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,finnor_os AS $$
DECLARE decision_row finnor_os.authority_decisions%ROWTYPE;
DECLARE current_revision integer;
BEGIN
  IF p_authority_decision IS NULL THEN RETURN false; END IF;
  SELECT * INTO decision_row FROM finnor_os.authority_decisions
  WHERE id=p_authority_decision AND tenant_id=p_tenant
    AND capability=p_capability AND resource_type=p_resource_type AND resource_id=p_resource_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_require_current_revision THEN
    SELECT coalesce((SELECT revision FROM finnor_os.authority_states WHERE tenant_id=p_tenant),1) INTO current_revision;
    IF decision_row.authority_revision<>current_revision THEN RETURN false; END IF;
  END IF;
  IF p_require_approval AND decision_row.outcome<>'approval_required' THEN RETURN false; END IF;
  IF decision_row.outcome='allowed' THEN
    IF p_decision_receipt IS NULL THEN RETURN true; END IF;
    RETURN EXISTS (
      SELECT 1 FROM finnor_os.decision_receipts r
      WHERE r.id=p_decision_receipt AND r.tenant_id=p_tenant
        AND decision_row.domain_action_id IS NOT NULL
        AND r.domain_action_id=decision_row.domain_action_id
        AND r.finalized_at IS NOT NULL AND r.failure IS NULL
    );
  END IF;
  IF decision_row.outcome<>'approval_required' OR p_decision_receipt IS NULL THEN RETURN false; END IF;
  RETURN EXISTS (
    SELECT 1
    FROM finnor_os.authority_approval_requests ar
    JOIN finnor_os.domain_actions da ON da.id=ar.domain_action_id AND da.tenant_id=ar.tenant_id
    JOIN finnor_os.decision_receipts r ON r.domain_action_id=da.id AND r.tenant_id=da.tenant_id
    WHERE ar.tenant_id=p_tenant AND ar.authority_decision_id=p_authority_decision AND ar.status='approved'
      AND r.id=p_decision_receipt AND r.finalized_at IS NOT NULL AND r.failure IS NULL
      AND coalesce((r.approval->>'required')::boolean,false)
      AND coalesce(btrim(r.approval->>'approvedBy'),'')<>''
  );
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_deal_root_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF TG_OP='INSERT' AND (
    NEW.status<>'active' OR NEW.version<>1 OR NEW.graph_version<>1
    OR NEW.actual_close_at IS NOT NULL OR NEW.close_authority_decision_id IS NOT NULL
    OR NEW.close_decision_receipt_id IS NOT NULL OR NEW.terminated_at IS NOT NULL
    OR NEW.termination_reason IS NOT NULL OR NEW.termination_authority_decision_id IS NOT NULL
    OR NEW.termination_decision_receipt_id IS NOT NULL OR NEW.archived_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PE Deal must be created as an unarchived active canonical root at version 1';
  END IF;
  IF finnor_os.active_tenant_vertical(NEW.tenant_id)<>'private_equity' THEN
    RAISE EXCEPTION 'PE Deal is unsupported for the tenant active vertical';
  END IF;
  IF finnor_os.pe_party_tenant('external_organization',NEW.target_organization_id) IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'PE Deal target crosses tenant boundary, is missing, or is inactive';
  END IF;
  IF finnor_os.pe_party_tenant('employee',NEW.deal_lead_employee_id) IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'PE Deal lead crosses tenant boundary, is missing, or is inactive';
  END IF;
  IF NEW.signed_loi_document_id IS NOT NULL
     AND finnor_os.canonical_entity_tenant('document',NEW.signed_loi_document_id) IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'PE Deal signed LOI Document crosses tenant boundary or is missing';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_child_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE body jsonb:=to_jsonb(NEW); deal uuid; owner_tenant uuid; deal_row record; required_initial_state text;
BEGIN
  deal := (body->>'deal_id')::uuid;
  -- The Deal row is the serialization root for every graph mutation. A close
  -- cannot race a newly required condition/item into existence after its
  -- eligibility snapshot, even for a caller bypassing the TypeScript package.
  SELECT tenant_id,status INTO deal_row FROM finnor_os.pe_deals WHERE id=deal FOR UPDATE;
  IF deal_row.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'PE graph child crosses tenant/deal boundary or Deal is missing';
  END IF;
  IF deal_row.status<>'active' THEN RAISE EXCEPTION 'terminal PE Deal graph is immutable'; END IF;
  IF finnor_os.active_tenant_vertical(NEW.tenant_id)<>'private_equity' THEN
    RAISE EXCEPTION 'PE graph entity is unsupported for the tenant active vertical';
  END IF;
  IF TG_OP='INSERT' THEN
    IF (body->>'version')::integer<>1 THEN
      RAISE EXCEPTION 'PE graph entity must be created at version 1';
    END IF;
    required_initial_state:=CASE TG_TABLE_NAME
      WHEN 'pe_deal_parties' THEN 'active'
      WHEN 'pe_workstreams' THEN 'not_started'
      WHEN 'pe_requests' THEN 'open'
      WHEN 'pe_deliverables' THEN 'expected'
      WHEN 'pe_findings' THEN 'open'
      WHEN 'pe_deal_risks' THEN 'open'
      WHEN 'pe_milestones' THEN 'pending'
      WHEN 'pe_closing_conditions' THEN 'open'
      WHEN 'pe_closing_items' THEN 'open'
      ELSE NULL
    END;
    IF required_initial_state IS NOT NULL AND body->>'state' IS DISTINCT FROM required_initial_state THEN
      RAISE EXCEPTION 'PE % must be created in initial state %',TG_TABLE_NAME,required_initial_state;
    END IF;
    IF body ? 'archived_at' AND body->>'archived_at' IS NOT NULL THEN
      RAISE EXCEPTION 'PE graph entity cannot be created archived';
    END IF;
    IF TG_TABLE_NAME='pe_dependencies' AND (
      body->>'removed_at' IS NOT NULL OR body->>'removed_by' IS NOT NULL OR body->>'removal_reason' IS NOT NULL
    ) THEN RAISE EXCEPTION 'PE Dependency must be created active'; END IF;
    IF TG_TABLE_NAME='pe_closing_conditions' AND (
      body->>'waiver_authority_decision_id' IS NOT NULL OR body->>'waiver_decision_receipt_id' IS NOT NULL
    ) THEN RAISE EXCEPTION 'PE ClosingCondition cannot be created with waiver proof'; END IF;
    IF TG_TABLE_NAME='pe_closing_items' AND (
      body->>'verified_by_employee_id' IS NOT NULL OR body->>'verification_source' IS NOT NULL
    ) THEN RAISE EXCEPTION 'PE ClosingItem cannot be created with verification truth'; END IF;
  END IF;
  IF body ? 'owner_party_type' THEN
    IF (body->>'owner_party_type') NOT IN ('employee','team') THEN RAISE EXCEPTION 'PE owner must be an employee or team PartyRef'; END IF;
    owner_tenant := finnor_os.pe_party_tenant(body->>'owner_party_type',(body->>'owner_party_id')::uuid);
    IF owner_tenant IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'PE owner PartyRef crosses tenant boundary, is missing, or is inactive'; END IF;
  END IF;
  IF TG_OP='INSERT' AND body ? 'workstream_id' THEN
    IF NOT EXISTS (
      SELECT 1 FROM finnor_os.pe_workstreams w
      WHERE w.tenant_id=NEW.tenant_id AND w.deal_id=deal
        AND w.id=(body->>'workstream_id')::uuid AND w.state IN ('not_started','active')
      ) THEN RAISE EXCEPTION 'new PE execution truth requires an open Workstream'; END IF;
  END IF;
  IF TG_OP='INSERT' AND body ? 'requested_from_deal_party_id' THEN
    IF NOT EXISTS (
      SELECT 1 FROM finnor_os.pe_deal_parties p
      WHERE p.tenant_id=NEW.tenant_id AND p.deal_id=deal
        AND p.id=(body->>'requested_from_deal_party_id')::uuid AND p.state='active'
    ) THEN RAISE EXCEPTION 'new PE Request requires an active requested-from DealParty'; END IF;
  END IF;
  IF TG_OP='INSERT' AND body ? 'responsible_deal_party_id' AND body->>'responsible_deal_party_id' IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM finnor_os.pe_deal_parties p
      WHERE p.tenant_id=NEW.tenant_id AND p.deal_id=deal
        AND p.id=(body->>'responsible_deal_party_id')::uuid AND p.state='active'
    ) THEN RAISE EXCEPTION 'new PE execution truth requires an active responsible DealParty'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_deal_party_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF finnor_os.pe_party_tenant(NEW.party_type,NEW.party_id) IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'PE DealParty PartyRef crosses tenant boundary, is missing, or is inactive';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_document_link_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE superseded record;
BEGIN
  IF finnor_os.pe_entity_deal(NEW.entity_type,NEW.entity_id) IS DISTINCT FROM NEW.deal_id THEN
    RAISE EXCEPTION 'PE Document link endpoint crosses Deal boundary or is missing';
  END IF;
  IF finnor_os.canonical_entity_tenant('document',NEW.document_id) IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'PE Document link crosses tenant boundary or Document is missing';
  END IF;
  IF NEW.supersedes_link_id IS NOT NULL THEN
    SELECT tenant_id,deal_id,entity_type,entity_id INTO superseded FROM finnor_os.pe_document_links WHERE id=NEW.supersedes_link_id;
    IF superseded.tenant_id IS DISTINCT FROM NEW.tenant_id OR superseded.deal_id IS DISTINCT FROM NEW.deal_id
       OR superseded.entity_type IS DISTINCT FROM NEW.entity_type OR superseded.entity_id IS DISTINCT FROM NEW.entity_id THEN
      RAISE EXCEPTION 'superseded PE Document link crosses tenant, Deal, or endpoint boundary';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_evidence_link_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE source_row record; version_row record;
BEGIN
  IF finnor_os.pe_entity_deal(NEW.entity_type,NEW.entity_id) IS DISTINCT FROM NEW.deal_id THEN
    RAISE EXCEPTION 'PE Evidence link endpoint crosses Deal boundary or is missing';
  END IF;
  SELECT scope,tenant_id INTO source_row FROM finnor_os.evidence_sources WHERE id=NEW.evidence_source_id;
  IF NOT FOUND OR (source_row.scope='tenant' AND source_row.tenant_id IS DISTINCT FROM NEW.tenant_id) THEN
    RAISE EXCEPTION 'PE Evidence link crosses tenant boundary or Evidence source is missing';
  END IF;
  IF NEW.evidence_version_id IS NOT NULL THEN
    SELECT source_id,scope,tenant_id INTO version_row FROM finnor_os.evidence_source_versions WHERE id=NEW.evidence_version_id;
    IF NOT FOUND OR version_row.source_id IS DISTINCT FROM NEW.evidence_source_id
       OR version_row.scope IS DISTINCT FROM source_row.scope
       OR (version_row.scope='tenant' AND version_row.tenant_id IS DISTINCT FROM NEW.tenant_id) THEN
      RAISE EXCEPTION 'PE Evidence version crosses tenant/source boundary or is missing';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_dependency() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE endpoint_tenant uuid; endpoint_deal uuid; creates_cycle boolean;
BEGIN
  IF TG_OP='UPDATE' AND OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'removed PE Dependency is immutable';
  END IF;
  IF TG_OP='UPDATE' AND (
    NEW.tenant_id<>OLD.tenant_id OR NEW.deal_id<>OLD.deal_id OR
    NEW.blocker_type<>OLD.blocker_type OR NEW.blocker_id<>OLD.blocker_id OR
    NEW.blocked_type<>OLD.blocked_type OR NEW.blocked_id<>OLD.blocked_id OR NEW.relation<>OLD.relation
  ) THEN RAISE EXCEPTION 'PE Dependency endpoints and identity are immutable'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pe_dependency:'||NEW.deal_id::text,0));
  endpoint_tenant := finnor_os.canonical_entity_tenant(NEW.blocker_type,NEW.blocker_id);
  endpoint_deal := finnor_os.pe_entity_deal(NEW.blocker_type,NEW.blocker_id);
  IF endpoint_tenant IS DISTINCT FROM NEW.tenant_id OR endpoint_deal IS DISTINCT FROM NEW.deal_id THEN
    RAISE EXCEPTION 'PE Dependency blocker crosses tenant/Deal boundary or is missing';
  END IF;
  endpoint_tenant := finnor_os.canonical_entity_tenant(NEW.blocked_type,NEW.blocked_id);
  endpoint_deal := finnor_os.pe_entity_deal(NEW.blocked_type,NEW.blocked_id);
  IF endpoint_tenant IS DISTINCT FROM NEW.tenant_id OR endpoint_deal IS DISTINCT FROM NEW.deal_id THEN
    RAISE EXCEPTION 'PE Dependency blocked endpoint crosses tenant/Deal boundary or is missing';
  END IF;
  IF TG_OP='UPDATE' AND OLD.removed_at IS DISTINCT FROM NEW.removed_at THEN
    IF OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL THEN RAISE EXCEPTION 'removed PE Dependency cannot be restored'; END IF;
    IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'stale PE Dependency version'; END IF;
  END IF;
  IF NEW.removed_at IS NOT NULL THEN RETURN NEW; END IF;
  IF finnor_os.pe_endpoint_resolved(NEW.blocked_type,NEW.blocked_id)
     AND NOT finnor_os.pe_endpoint_resolved(NEW.blocker_type,NEW.blocker_id) THEN
    RAISE EXCEPTION 'unresolved blocker cannot be added to an already resolved PE endpoint';
  END IF;
  WITH RECURSIVE reachable(entity_type,entity_id) AS (
    SELECT NEW.blocked_type,NEW.blocked_id
    UNION
    SELECT d.blocked_type,d.blocked_id
    FROM finnor_os.pe_dependencies d
    JOIN reachable r ON r.entity_type=d.blocker_type AND r.entity_id=d.blocker_id
    WHERE d.tenant_id=NEW.tenant_id AND d.deal_id=NEW.deal_id AND d.removed_at IS NULL
      AND (TG_OP='INSERT' OR d.id<>NEW.id)
  )
  SELECT EXISTS (SELECT 1 FROM reachable WHERE entity_type=NEW.blocker_type AND entity_id=NEW.blocker_id)
  INTO creates_cycle;
  IF creates_cycle THEN RAISE EXCEPTION 'PE blocking Dependency would create a cycle'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.pe_evaluate_deal_close_eligibility(p_tenant uuid,p_deal uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,finnor_os AS $$
DECLARE deal_row record;
DECLARE blocking_conditions jsonb; failed_conditions jsonb; invalid_waivers jsonb;
DECLARE unverified_items jsonb; blocking_dependencies jsonb; result jsonb;
BEGIN
  SELECT id,status,signed_loi_at,version,graph_version INTO deal_row
  FROM finnor_os.pe_deals WHERE tenant_id=p_tenant AND id=p_deal;
  IF NOT FOUND THEN RAISE EXCEPTION 'PE Deal not found in authenticated tenant'; END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'condition',condition_text,'state',state) ORDER BY condition_text,id),'[]'::jsonb)
  INTO blocking_conditions FROM finnor_os.pe_closing_conditions
  WHERE tenant_id=p_tenant AND deal_id=p_deal AND required_for_close AND state IN ('open','evidence_pending');

  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'condition',condition_text,'state',state,'reason',failure_reason) ORDER BY condition_text,id),'[]'::jsonb)
  INTO failed_conditions FROM finnor_os.pe_closing_conditions
  WHERE tenant_id=p_tenant AND deal_id=p_deal AND required_for_close AND state='failed';

  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'condition',condition_text,'authorityDecisionId',waiver_authority_decision_id,'decisionReceiptId',waiver_decision_receipt_id) ORDER BY condition_text,id),'[]'::jsonb)
  INTO invalid_waivers FROM finnor_os.pe_closing_conditions
  WHERE tenant_id=p_tenant AND deal_id=p_deal AND required_for_close AND state='waived'
    AND NOT finnor_os.pe_governance_proof_valid(
      p_tenant,'pe_closing_condition',id,'private_equity:waive_closing_condition',
      waiver_authority_decision_id,waiver_decision_receipt_id,false,waiver_requires_approval
    );

  SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'item',item_text,'state',state) ORDER BY item_text,id),'[]'::jsonb)
  INTO unverified_items FROM finnor_os.pe_closing_items
  WHERE tenant_id=p_tenant AND deal_id=p_deal AND required_for_close AND state<>'verified';

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'dependencyId',d.id,
    'blocker',jsonb_build_object('entityType',d.blocker_type,'entityId',d.blocker_id),
    'blocked',jsonb_build_object('entityType',d.blocked_type,'entityId',d.blocked_id),
    'relation',d.relation
  ) ORDER BY d.created_at,d.id),'[]'::jsonb)
  INTO blocking_dependencies
  FROM finnor_os.pe_dependencies d
  WHERE d.tenant_id=p_tenant AND d.deal_id=p_deal AND d.removed_at IS NULL
    AND NOT finnor_os.pe_endpoint_resolved(d.blocker_type,d.blocker_id)
    AND (
      (d.blocked_type='pe_closing_condition' AND EXISTS (
        SELECT 1 FROM finnor_os.pe_closing_conditions c WHERE c.id=d.blocked_id AND c.tenant_id=p_tenant AND c.deal_id=p_deal AND c.required_for_close
      ))
      OR (d.blocked_type='pe_closing_item' AND EXISTS (
        SELECT 1 FROM finnor_os.pe_closing_items i WHERE i.id=d.blocked_id AND i.tenant_id=p_tenant AND i.deal_id=p_deal AND i.required_for_close
      ))
    );

  result := jsonb_build_object(
    'dealId',p_deal,
    'dealState',deal_row.status,
    'dealVersion',deal_row.version,
    'graphVersion',deal_row.graph_version,
    'signedLoiPresent',deal_row.signed_loi_at IS NOT NULL,
    'blockingConditions',blocking_conditions,
    'failedConditions',failed_conditions,
    'unverifiedClosingItems',unverified_items,
    'blockingDependencies',blocking_dependencies,
    'invalidWaivers',invalid_waivers,
    'integrityErrors','[]'::jsonb,
    'eligible',deal_row.status='active' AND deal_row.signed_loi_at IS NOT NULL
      AND jsonb_array_length(blocking_conditions)=0
      AND jsonb_array_length(failed_conditions)=0
      AND jsonb_array_length(unverified_items)=0
      AND jsonb_array_length(blocking_dependencies)=0
      AND jsonb_array_length(invalid_waivers)=0
  );
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_state_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE old_body jsonb:=to_jsonb(OLD); new_body jsonb:=to_jsonb(NEW);
DECLARE old_state text; new_state text; eligibility jsonb;
BEGIN
  IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id THEN RAISE EXCEPTION 'PE canonical identity is immutable'; END IF;
  IF old_body ? 'deal_id' AND new_body->>'deal_id' IS DISTINCT FROM old_body->>'deal_id' THEN
    RAISE EXCEPTION 'PE Deal ownership is immutable';
  END IF;
  old_state := coalesce(old_body->>'state',old_body->>'status');
  new_state := coalesce(new_body->>'state',new_body->>'status');
  NEW.updated_at := now();
  IF new_state IS NOT DISTINCT FROM old_state THEN
    IF old_state IN ('closed','terminated','removed','complete','cancelled','fulfilled','accepted','rejected','superseded','resolved','achieved','satisfied','waived','failed','verified')
       AND (old_body-ARRAY['updated_at']) IS DISTINCT FROM (new_body-ARRAY['updated_at']) THEN
      RAISE EXCEPTION 'terminal PE entity state is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'stale PE entity version'; END IF;

  CASE TG_TABLE_NAME
    WHEN 'pe_deals' THEN
      IF old_state<>'active' THEN RAISE EXCEPTION 'terminal PE Deal state is immutable'; END IF;
      IF new_state='closed' THEN
        IF current_setting('app.pe_deal_transition',true) IS DISTINCT FROM 'declare_closed' THEN
          RAISE EXCEPTION 'PE Deal may become closed only through declareDealClosed';
        END IF;
        IF NOT finnor_os.pe_governance_proof_valid(
          NEW.tenant_id,'pe_deal',NEW.id,'private_equity:close_deal',
          NEW.close_authority_decision_id,NEW.close_decision_receipt_id,true,false
        ) THEN RAISE EXCEPTION 'PE Deal close lacks current canonical authority/approval proof'; END IF;
        eligibility := finnor_os.pe_evaluate_deal_close_eligibility(NEW.tenant_id,NEW.id);
        IF NOT (eligibility->>'eligible')::boolean THEN RAISE EXCEPTION 'PE Deal is not close eligible: %',eligibility; END IF;
      ELSIF new_state='terminated' THEN
        IF current_setting('app.pe_deal_transition',true) IS DISTINCT FROM 'terminate' THEN
          RAISE EXCEPTION 'PE Deal may become terminated only through terminateDeal';
        END IF;
        IF NOT finnor_os.pe_governance_proof_valid(
          NEW.tenant_id,'pe_deal',NEW.id,'private_equity:terminate_deal',
          NEW.termination_authority_decision_id,NEW.termination_decision_receipt_id,true,false
        ) THEN RAISE EXCEPTION 'PE Deal termination lacks current canonical authority/approval proof'; END IF;
      ELSE RAISE EXCEPTION 'invalid PE Deal transition % -> %',old_state,new_state;
      END IF;
    WHEN 'pe_deal_parties' THEN
      IF NOT (old_state='active' AND new_state='removed') THEN RAISE EXCEPTION 'invalid DealParty transition % -> %',old_state,new_state; END IF;
    WHEN 'pe_workstreams' THEN
      IF NOT ((old_state='not_started' AND new_state IN ('active','cancelled')) OR (old_state='active' AND new_state IN ('complete','cancelled'))) THEN
        RAISE EXCEPTION 'invalid Workstream transition % -> %',old_state,new_state;
      END IF;
      IF new_state='complete' AND (
        EXISTS (SELECT 1 FROM finnor_os.pe_requests r WHERE r.workstream_id=NEW.id AND r.state NOT IN ('fulfilled','cancelled'))
        OR EXISTS (SELECT 1 FROM finnor_os.pe_deliverables d WHERE d.workstream_id=NEW.id AND d.required_for_workstream_completion AND d.state NOT IN ('accepted','superseded','cancelled'))
        OR EXISTS (SELECT 1 FROM finnor_os.pe_findings f WHERE f.workstream_id=NEW.id AND f.required_for_workstream_completion AND f.state='open')
        OR EXISTS (SELECT 1 FROM finnor_os.pe_deal_risks r WHERE r.workstream_id=NEW.id AND r.required_for_workstream_completion AND r.state IN ('open','mitigating'))
        OR EXISTS (SELECT 1 FROM finnor_os.pe_dependencies d WHERE d.deal_id=NEW.deal_id AND d.removed_at IS NULL
          AND d.blocked_type='pe_workstream' AND d.blocked_id=NEW.id AND NOT finnor_os.pe_endpoint_resolved(d.blocker_type,d.blocker_id))
      ) THEN RAISE EXCEPTION 'Workstream has unresolved mandatory requirements or blockers'; END IF;
    WHEN 'pe_requests' THEN
      IF NOT ((old_state='open' AND new_state IN ('acknowledged','fulfilled','cancelled')) OR (old_state='acknowledged' AND new_state IN ('fulfilled','cancelled'))) THEN
        RAISE EXCEPTION 'invalid Request transition % -> %',old_state,new_state;
      END IF;
      IF new_state='fulfilled' AND NEW.requires_accepted_deliverable
         AND NOT EXISTS (SELECT 1 FROM finnor_os.pe_deliverables d WHERE d.request_id=NEW.id AND d.state='accepted') THEN
        RAISE EXCEPTION 'Request fulfillment requires an accepted Deliverable';
      END IF;
    WHEN 'pe_deliverables' THEN
      IF NOT (
        (old_state='expected' AND new_state IN ('received','superseded','cancelled'))
        OR (old_state='received' AND new_state IN ('accepted','rejected','superseded','cancelled'))
        OR (old_state='rejected' AND new_state IN ('received','superseded','cancelled'))
        OR (old_state='accepted' AND new_state='superseded')
      ) THEN RAISE EXCEPTION 'invalid Deliverable transition % -> %',old_state,new_state; END IF;
      IF new_state='accepted' AND NEW.requires_document
         AND NOT EXISTS (SELECT 1 FROM finnor_os.pe_document_links l WHERE l.entity_type='pe_deliverable' AND l.entity_id=NEW.id AND l.link_role='accepted' AND l.archived_at IS NULL) THEN
        RAISE EXCEPTION 'Deliverable acceptance requires an explicitly accepted canonical Document link';
      END IF;
    WHEN 'pe_findings' THEN
      IF NOT ((old_state='open' AND new_state IN ('resolved','accepted','superseded')) OR (old_state IN ('resolved','accepted') AND new_state='superseded')) THEN
        RAISE EXCEPTION 'invalid Finding transition % -> %',old_state,new_state;
      END IF;
    WHEN 'pe_deal_risks' THEN
      IF NOT ((old_state='open' AND new_state IN ('mitigating','resolved','accepted')) OR (old_state='mitigating' AND new_state IN ('resolved','accepted'))) THEN
        RAISE EXCEPTION 'invalid DealRisk transition % -> %',old_state,new_state;
      END IF;
    WHEN 'pe_milestones' THEN
      IF NOT (old_state='pending' AND new_state IN ('achieved','cancelled')) THEN RAISE EXCEPTION 'invalid Milestone transition % -> %',old_state,new_state; END IF;
    WHEN 'pe_closing_conditions' THEN
      IF NOT (
        (old_state='open' AND new_state IN ('evidence_pending','satisfied','waived','failed'))
        OR (old_state='evidence_pending' AND new_state IN ('satisfied','waived','failed'))
      ) THEN RAISE EXCEPTION 'invalid ClosingCondition transition % -> %',old_state,new_state; END IF;
      IF new_state='satisfied' AND NEW.evidence_required
         AND NOT EXISTS (SELECT 1 FROM finnor_os.pe_document_links l WHERE l.entity_type='pe_closing_condition' AND l.entity_id=NEW.id AND l.archived_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM finnor_os.pe_evidence_links l WHERE l.entity_type='pe_closing_condition' AND l.entity_id=NEW.id AND l.archived_at IS NULL) THEN
        RAISE EXCEPTION 'ClosingCondition satisfaction requires canonical evidence or Document support';
      END IF;
      IF new_state='waived' AND NOT finnor_os.pe_governance_proof_valid(
        NEW.tenant_id,'pe_closing_condition',NEW.id,'private_equity:waive_closing_condition',
        NEW.waiver_authority_decision_id,NEW.waiver_decision_receipt_id,true,NEW.waiver_requires_approval
      ) THEN RAISE EXCEPTION 'ClosingCondition waiver lacks current canonical authority/approval proof'; END IF;
    WHEN 'pe_closing_items' THEN
      IF NOT ((old_state='open' AND new_state IN ('ready','cancelled')) OR (old_state='ready' AND new_state IN ('verified','cancelled'))) THEN
        RAISE EXCEPTION 'invalid ClosingItem transition % -> %',old_state,new_state;
      END IF;
      IF new_state='cancelled' AND NEW.required_for_close THEN RAISE EXCEPTION 'required ClosingItem cannot be cancelled'; END IF;
      IF new_state='verified' AND NEW.verification_evidence_required
         AND NOT EXISTS (SELECT 1 FROM finnor_os.pe_document_links l WHERE l.entity_type='pe_closing_item' AND l.entity_id=NEW.id AND l.archived_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM finnor_os.pe_evidence_links l WHERE l.entity_type='pe_closing_item' AND l.entity_id=NEW.id AND l.archived_at IS NULL) THEN
        RAISE EXCEPTION 'ClosingItem verification requires canonical evidence or Document support';
      END IF;
    ELSE RAISE EXCEPTION 'unrecognized PE lifecycle table: %',TG_TABLE_NAME;
  END CASE;

  -- A hard blocker has business meaning at the write boundary: downstream truth
  -- cannot be transitioned to a positively completed state while it remains.
  IF (
    (TG_TABLE_NAME='pe_workstreams' AND new_state='complete') OR
    (TG_TABLE_NAME='pe_requests' AND new_state='fulfilled') OR
    (TG_TABLE_NAME='pe_deliverables' AND new_state='accepted') OR
    (TG_TABLE_NAME='pe_findings' AND new_state IN ('resolved','accepted','superseded')) OR
    (TG_TABLE_NAME='pe_deal_risks' AND new_state IN ('resolved','accepted')) OR
    (TG_TABLE_NAME='pe_milestones' AND new_state='achieved') OR
    (TG_TABLE_NAME='pe_closing_conditions' AND new_state IN ('satisfied','waived')) OR
    (TG_TABLE_NAME='pe_closing_items' AND new_state='verified')
  ) AND EXISTS (
    SELECT 1 FROM finnor_os.pe_dependencies d
    WHERE d.tenant_id=NEW.tenant_id AND d.deal_id=(new_body->>'deal_id')::uuid
      AND d.blocked_type=CASE TG_TABLE_NAME
        WHEN 'pe_workstreams' THEN 'pe_workstream' WHEN 'pe_requests' THEN 'pe_request'
        WHEN 'pe_deliverables' THEN 'pe_deliverable' WHEN 'pe_findings' THEN 'pe_finding'
        WHEN 'pe_deal_risks' THEN 'pe_deal_risk' WHEN 'pe_milestones' THEN 'pe_milestone'
        WHEN 'pe_closing_conditions' THEN 'pe_closing_condition' WHEN 'pe_closing_items' THEN 'pe_closing_item'
      END
      AND d.blocked_id=NEW.id AND d.removed_at IS NULL
      AND NOT finnor_os.pe_endpoint_resolved(d.blocker_type,d.blocker_id)
  ) THEN RAISE EXCEPTION 'PE endpoint cannot complete while an unresolved hard blocker exists'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_versioned_update() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE old_body jsonb:=to_jsonb(OLD); new_body jsonb:=to_jsonb(NEW); mutable_columns text[];
BEGIN
  -- Graph maintenance changes only graph_version/updated_at and does not pretend
  -- the transaction-root business version changed.
  IF TG_TABLE_NAME='pe_deals'
     AND (new_body-'graph_version'-'updated_at')=(old_body-'graph_version'-'updated_at')
     AND (new_body->>'graph_version')::integer=(old_body->>'graph_version')::integer+1 THEN RETURN NEW; END IF;
  mutable_columns:=CASE TG_TABLE_NAME
    WHEN 'pe_deals' THEN ARRAY[
      'status','actual_close_at','close_authority_decision_id','close_decision_receipt_id',
      'terminated_at','termination_reason','termination_authority_decision_id','termination_decision_receipt_id',
      'version','graph_version','updated_at'
    ]
    WHEN 'pe_deal_parties' THEN ARRAY['state','removed_at','version','updated_at']
    WHEN 'pe_workstreams' THEN ARRAY['state','completed_at','cancelled_at','version','updated_at']
    WHEN 'pe_requests' THEN ARRAY[
      'state','acknowledged_at','fulfilled_at','cancelled_at','cancellation_reason','version','updated_at'
    ]
    WHEN 'pe_deliverables' THEN ARRAY[
      'state','received_at','accepted_at','rejected_at','rejection_reason','superseded_at',
      'cancelled_at','cancellation_reason','version','updated_at'
    ]
    WHEN 'pe_findings' THEN ARRAY['state','disposition','resolved_at','accepted_at','superseded_at','version','updated_at']
    WHEN 'pe_deal_risks' THEN ARRAY['state','response','mitigating_at','resolved_at','accepted_at','version','updated_at']
    WHEN 'pe_milestones' THEN ARRAY['state','achieved_at','cancelled_at','version','updated_at']
    WHEN 'pe_closing_conditions' THEN ARRAY[
      'state','satisfied_at','waived_at','waiver_reason','waiver_authority_decision_id',
      'waiver_decision_receipt_id','failed_at','failure_reason','version','updated_at'
    ]
    WHEN 'pe_closing_items' THEN ARRAY[
      'state','ready_at','verified_at','verified_by_employee_id','verification_source',
      'cancelled_at','cancellation_reason','version','updated_at'
    ]
    WHEN 'pe_dependencies' THEN ARRAY['removed_at','removed_by','removal_reason','version','updated_at']
    WHEN 'pe_finding_risk_links' THEN ARRAY['archived_at','version','updated_at']
    WHEN 'pe_document_links' THEN ARRAY['archived_at','version','updated_at']
    WHEN 'pe_evidence_links' THEN ARRAY['archived_at','version','updated_at']
    ELSE ARRAY['version','updated_at']
  END;
  IF (old_body-mutable_columns) IS DISTINCT FROM (new_body-mutable_columns) THEN
    RAISE EXCEPTION 'immutable PE business truth cannot be patched on %',TG_TABLE_NAME;
  END IF;
  IF TG_TABLE_NAME='pe_deals' AND old_body->>'status' IN ('closed','terminated')
     AND (old_body-ARRAY['updated_at']) IS DISTINCT FROM (new_body-ARRAY['updated_at']) THEN
    RAISE EXCEPTION 'terminal PE Deal state is immutable';
  END IF;
  IF TG_TABLE_NAME IN ('pe_dependencies','pe_document_links','pe_evidence_links','pe_finding_risk_links')
     AND (coalesce(old_body->>'removed_at',old_body->>'archived_at') IS NOT NULL)
     AND (old_body-ARRAY['updated_at']) IS DISTINCT FROM (new_body-ARRAY['updated_at']) THEN
    RAISE EXCEPTION 'archived or removed PE relationship is immutable';
  END IF;
  IF (old_body-ARRAY['version','updated_at']) IS NOT DISTINCT FROM (new_body-ARRAY['version','updated_at']) THEN
    RAISE EXCEPTION 'PE update must change canonical business truth on %',TG_TABLE_NAME;
  END IF;
  IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'stale PE entity version'; END IF;
  NEW.updated_at:=now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.touch_pe_deal_graph() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE deal uuid; row_tenant uuid;
BEGIN
  deal := CASE WHEN TG_OP='DELETE' THEN (to_jsonb(OLD)->>'deal_id')::uuid ELSE (to_jsonb(NEW)->>'deal_id')::uuid END;
  row_tenant := CASE WHEN TG_OP='DELETE' THEN (to_jsonb(OLD)->>'tenant_id')::uuid ELSE (to_jsonb(NEW)->>'tenant_id')::uuid END;
  IF finnor_os.request_tenant_id() IS DISTINCT FROM row_tenant THEN
    RAISE EXCEPTION 'PE graph mutation crosses authenticated tenant';
  END IF;
  UPDATE finnor_os.pe_deals SET graph_version=graph_version+1,updated_at=now() WHERE id=deal;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

DROP TRIGGER IF EXISTS pe_deals_scope ON finnor_os.pe_deals;
CREATE TRIGGER pe_deals_scope BEFORE INSERT OR UPDATE ON finnor_os.pe_deals
FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_deal_root_scope();
DROP TRIGGER IF EXISTS pe_deals_state ON finnor_os.pe_deals;
CREATE TRIGGER pe_deals_state BEFORE UPDATE OF status ON finnor_os.pe_deals
FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_state_transition();

DROP TRIGGER IF EXISTS pe_version_guard ON finnor_os.pe_deals;
CREATE TRIGGER pe_version_guard BEFORE UPDATE ON finnor_os.pe_deals
FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_versioned_update();

DO $child_triggers$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'pe_deal_parties','pe_workstreams','pe_requests','pe_deliverables','pe_findings','pe_deal_risks',
    'pe_finding_risk_links','pe_milestones','pe_closing_conditions','pe_closing_items',
    'pe_dependencies','pe_document_links','pe_evidence_links'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS pe_child_scope ON finnor_os.%I',table_name);
    EXECUTE format('CREATE TRIGGER pe_child_scope BEFORE INSERT OR UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_child_scope()',table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS pe_graph_touch ON finnor_os.%I',table_name);
    EXECUTE format('CREATE TRIGGER pe_graph_touch AFTER INSERT OR UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.touch_pe_deal_graph()',table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS pe_version_guard ON finnor_os.%I',table_name);
    EXECUTE format('CREATE TRIGGER pe_version_guard BEFORE UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_versioned_update()',table_name);
  END LOOP;
END $child_triggers$;

DROP TRIGGER IF EXISTS pe_deal_parties_party_scope ON finnor_os.pe_deal_parties;
CREATE TRIGGER pe_deal_parties_party_scope BEFORE INSERT OR UPDATE OF party_type,party_id,tenant_id
ON finnor_os.pe_deal_parties FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_deal_party_scope();

DROP TRIGGER IF EXISTS pe_document_links_scope ON finnor_os.pe_document_links;
CREATE TRIGGER pe_document_links_scope BEFORE INSERT OR UPDATE ON finnor_os.pe_document_links
FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_document_link_scope();

DROP TRIGGER IF EXISTS pe_evidence_links_scope ON finnor_os.pe_evidence_links;
CREATE TRIGGER pe_evidence_links_scope BEFORE INSERT OR UPDATE ON finnor_os.pe_evidence_links
FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_evidence_link_scope();

DROP TRIGGER IF EXISTS pe_dependencies_cycle_scope ON finnor_os.pe_dependencies;
CREATE TRIGGER pe_dependencies_cycle_scope BEFORE INSERT OR UPDATE ON finnor_os.pe_dependencies
FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_dependency();

DO $state_triggers$
DECLARE table_name text; state_column text;
BEGIN
  FOR table_name,state_column IN
    SELECT * FROM (VALUES
      ('pe_deal_parties','state'),('pe_workstreams','state'),('pe_requests','state'),
      ('pe_deliverables','state'),('pe_findings','state'),('pe_deal_risks','state'),
      ('pe_milestones','state'),('pe_closing_conditions','state'),('pe_closing_items','state')
    ) AS lifecycle(table_name,state_column)
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS pe_state_transition ON finnor_os.%I',table_name);
    EXECUTE format('CREATE TRIGGER pe_state_transition BEFORE UPDATE OF %I ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_state_transition()',state_column,table_name);
  END LOOP;
END $state_triggers$;

-- Every canonical PE creation and consequential transition appends to the
-- existing BusinessEvent timeline in the same transaction. This trigger is the
-- durable backstop beneath the package API; rejected mutations never emit.
CREATE OR REPLACE FUNCTION finnor_os.append_pe_business_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE old_body jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
DECLARE new_body jsonb:=to_jsonb(NEW); from_state text; to_state text;
DECLARE event_name text; entity_kind text; actor text; event_source text; evidence_refs jsonb:='[]'::jsonb;
BEGIN
  from_state:=coalesce(old_body->>'state',old_body->>'status');
  to_state:=coalesce(new_body->>'state',new_body->>'status');
  actor:=coalesce(nullif(current_setting('app.pe_actor',true),''),nullif(current_setting('app.user_id',true),''),new_body->>'created_by');
  event_source:=coalesce(nullif(current_setting('app.pe_source',true),''),new_body->>'source_system','@finnor/private-equity');
  entity_kind:=CASE TG_TABLE_NAME
    WHEN 'pe_deals' THEN 'pe_deal' WHEN 'pe_deal_parties' THEN 'pe_deal_party'
    WHEN 'pe_workstreams' THEN 'pe_workstream' WHEN 'pe_requests' THEN 'pe_request'
    WHEN 'pe_deliverables' THEN 'pe_deliverable' WHEN 'pe_findings' THEN 'pe_finding'
    WHEN 'pe_deal_risks' THEN 'pe_deal_risk' WHEN 'pe_finding_risk_links' THEN 'pe_finding_risk_link'
    WHEN 'pe_milestones' THEN 'pe_milestone' WHEN 'pe_closing_conditions' THEN 'pe_closing_condition'
    WHEN 'pe_closing_items' THEN 'pe_closing_item' WHEN 'pe_dependencies' THEN 'pe_dependency'
    WHEN 'pe_document_links' THEN 'pe_document_link' WHEN 'pe_evidence_links' THEN 'pe_evidence_link'
  END;

  IF TG_OP='INSERT' THEN
    event_name:=CASE TG_TABLE_NAME
      WHEN 'pe_deals' THEN 'pe_deal_created' WHEN 'pe_deal_parties' THEN 'pe_deal_party_added'
      WHEN 'pe_workstreams' THEN 'pe_workstream_created' WHEN 'pe_requests' THEN 'pe_request_created'
      WHEN 'pe_deliverables' THEN 'pe_deliverable_expected' WHEN 'pe_findings' THEN 'pe_finding_opened'
      WHEN 'pe_deal_risks' THEN 'pe_deal_risk_opened' WHEN 'pe_finding_risk_links' THEN 'pe_finding_risk_linked'
      WHEN 'pe_milestones' THEN 'pe_milestone_created' WHEN 'pe_closing_conditions' THEN 'pe_closing_condition_created'
      WHEN 'pe_closing_items' THEN 'pe_closing_item_created' WHEN 'pe_dependencies' THEN 'pe_dependency_created'
      WHEN 'pe_document_links' THEN 'pe_document_linked' WHEN 'pe_evidence_links' THEN 'pe_evidence_linked'
    END;
  ELSIF to_state IS DISTINCT FROM from_state THEN
    event_name:=CASE TG_TABLE_NAME
      WHEN 'pe_deals' THEN CASE to_state WHEN 'closed' THEN 'pe_deal_closed' WHEN 'terminated' THEN 'pe_deal_terminated' END
      WHEN 'pe_deal_parties' THEN 'pe_deal_party_'||to_state
      WHEN 'pe_workstreams' THEN 'pe_workstream_'||to_state
      WHEN 'pe_requests' THEN 'pe_request_'||to_state
      WHEN 'pe_deliverables' THEN 'pe_deliverable_'||to_state
      WHEN 'pe_findings' THEN 'pe_finding_'||to_state
      WHEN 'pe_deal_risks' THEN 'pe_deal_risk_'||to_state
      WHEN 'pe_milestones' THEN 'pe_milestone_'||to_state
      WHEN 'pe_closing_conditions' THEN 'pe_closing_condition_'||to_state
      WHEN 'pe_closing_items' THEN 'pe_closing_item_'||to_state
    END;
  ELSIF TG_TABLE_NAME='pe_dependencies' AND old_body->>'removed_at' IS NULL AND new_body->>'removed_at' IS NOT NULL THEN
    event_name:='pe_dependency_removed';
  ELSE
    RETURN NEW;
  END IF;

  IF event_name IS NULL THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME IN ('pe_findings','pe_deal_risks','pe_closing_conditions','pe_closing_items') THEN
    SELECT coalesce(jsonb_agg(ref ORDER BY ref->>'type',ref->>'id'),'[]'::jsonb) INTO evidence_refs
    FROM (
      SELECT jsonb_build_object('type','document','id',document_id,'role',link_role) ref
      FROM finnor_os.pe_document_links
      WHERE tenant_id=NEW.tenant_id AND entity_type=entity_kind AND entity_id=NEW.id AND archived_at IS NULL
      UNION ALL
      SELECT jsonb_build_object('type','evidence_source','id',evidence_source_id,'versionId',evidence_version_id,'role',relationship)
      FROM finnor_os.pe_evidence_links
      WHERE tenant_id=NEW.tenant_id AND entity_type=entity_kind AND entity_id=NEW.id AND archived_at IS NULL
    ) refs;
  END IF;

  INSERT INTO finnor_os.business_events(tenant_id,entity_type,entity_id,event_type,payload,source)
  VALUES (
    NEW.tenant_id,entity_kind,NEW.id,event_name,
    jsonb_strip_nulls(jsonb_build_object(
      'dealId',new_body->>'deal_id','from',from_state,'to',to_state,'actor',actor,
      'version',(new_body->>'version')::integer,'sourceRef',new_body->>'external_id',
      'authorityDecisionId',coalesce(new_body->>'waiver_authority_decision_id',new_body->>'close_authority_decision_id',new_body->>'termination_authority_decision_id'),
      'decisionReceiptId',coalesce(new_body->>'waiver_decision_receipt_id',new_body->>'close_decision_receipt_id',new_body->>'termination_decision_receipt_id'),
      'targetOrganizationId',new_body->>'target_organization_id','signedLoiAt',new_body->>'signed_loi_at',
      'actualCloseAt',new_body->>'actual_close_at','graphVersion',new_body->>'graph_version','evidence',evidence_refs,
      'blocker',CASE WHEN TG_TABLE_NAME='pe_dependencies' THEN jsonb_build_object('entityType',new_body->>'blocker_type','entityId',new_body->>'blocker_id') END,
      'blocked',CASE WHEN TG_TABLE_NAME='pe_dependencies' THEN jsonb_build_object('entityType',new_body->>'blocked_type','entityId',new_body->>'blocked_id') END,
      'reason',coalesce(new_body->>'termination_reason',new_body->>'waiver_reason',new_body->>'failure_reason',new_body->>'cancellation_reason',new_body->>'removal_reason')
    )),event_source
  );
  IF TG_OP='INSERT' AND TG_TABLE_NAME='pe_deals' THEN
    INSERT INTO finnor_os.business_events(tenant_id,entity_type,entity_id,event_type,payload,source)
    VALUES (
      NEW.tenant_id,'pe_deal',NEW.id,'pe_deal_target_linked',
      jsonb_build_object(
        'dealId',NEW.id,'targetOrganizationId',NEW.target_organization_id,
        'actor',actor,'sourceRef',NEW.external_id
      ),event_source
    );
  END IF;
  RETURN NEW;
END $$;

DO $history_triggers$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'pe_deals','pe_deal_parties','pe_workstreams','pe_requests','pe_deliverables','pe_findings',
    'pe_deal_risks','pe_finding_risk_links','pe_dependencies','pe_milestones',
    'pe_closing_conditions','pe_closing_items','pe_document_links','pe_evidence_links'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS pe_business_history ON finnor_os.%I',table_name);
    EXECUTE format('CREATE TRIGGER pe_business_history AFTER INSERT OR UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.append_pe_business_event()',table_name);
  END LOOP;
END $history_triggers$;

CREATE OR REPLACE FUNCTION finnor_os.prevent_pe_business_event_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF OLD.entity_type LIKE 'pe\_%' ESCAPE '\' THEN RAISE EXCEPTION 'PE BusinessEvent history is append-only'; END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS pe_business_events_append_only ON finnor_os.business_events;
CREATE TRIGGER pe_business_events_append_only BEFORE UPDATE OR DELETE ON finnor_os.business_events
FOR EACH ROW EXECUTE FUNCTION finnor_os.prevent_pe_business_event_mutation();

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_business_event_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF NEW.entity_type LIKE 'pe\_%' ESCAPE '\' THEN
    -- PE history is emitted only from the canonical table-history trigger. A
    -- direct BusinessEvent insert cannot manufacture transaction truth.
    IF pg_trigger_depth()<2 THEN RAISE EXCEPTION 'PE BusinessEvent must be emitted by canonical PE history'; END IF;
    IF finnor_os.canonical_entity_tenant(NEW.entity_type,NEW.entity_id) IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'PE BusinessEvent crosses tenant boundary or references missing truth';
    END IF;
    IF NEW.event_type='pe_deal_closed' AND NOT EXISTS (
      SELECT 1 FROM finnor_os.pe_deals d WHERE d.id=NEW.entity_id AND d.tenant_id=NEW.tenant_id AND d.status='closed'
    ) THEN RAISE EXCEPTION 'PE close history requires a canonically closed Deal'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pe_business_events_canonical_insert ON finnor_os.business_events;
CREATE TRIGGER pe_business_events_canonical_insert BEFORE INSERT ON finnor_os.business_events
FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_business_event_insert();

-- Existing Task remains the sole task system. A PE subject must be a registered,
-- active-vertical canonical reference owned by the same authenticated tenant.
CREATE OR REPLACE FUNCTION finnor_os.assert_p2_task_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE resolved uuid; deal_id uuid; registered boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM finnor_os.canonical_truth_registry WHERE entity_type=NEW.subject_type)
    INTO registered;
  IF registered THEN
    IF NOT finnor_os.canonical_entity_available(NEW.tenant_id,NEW.subject_type) THEN
      RAISE EXCEPTION 'Task subject type is unsupported for tenant active vertical';
    END IF;
    resolved:=finnor_os.canonical_entity_tenant(NEW.subject_type,NEW.subject_id);
    IF resolved IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Task subject crosses tenant boundary or is missing';
    END IF;
    IF NEW.subject_type LIKE 'pe\_%' ESCAPE '\' THEN
      deal_id:=finnor_os.pe_entity_deal(NEW.subject_type,NEW.subject_id);
      IF deal_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM finnor_os.pe_deals d
        WHERE d.tenant_id=NEW.tenant_id AND d.id=deal_id AND d.status='active'
      ) THEN
        RAISE EXCEPTION 'Task cannot be added to a closed or terminated PE Deal graph';
      END IF;
    END IF;
  ELSIF NEW.subject_type LIKE 'pe\_%' ESCAPE '\' OR NEW.source_domain_action_id IS NOT NULL THEN
    RAISE EXCEPTION 'Task subject is not a registered canonical entity';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.pe_declare_deal_closed(
  p_tenant uuid,p_deal uuid,p_expected_version integer,p_expected_graph_version integer,
  p_authority_decision uuid,p_decision_receipt uuid,p_source text,p_actor text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE deal_row finnor_os.pe_deals%ROWTYPE; eligibility jsonb; closed_row finnor_os.pe_deals%ROWTYPE;
BEGIN
  IF finnor_os.request_tenant_id() IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'PE close crosses authenticated tenant boundary';
  END IF;
  IF coalesce(btrim(p_source),'')='' OR coalesce(btrim(p_actor),'')='' THEN
    RAISE EXCEPTION 'PE close provenance is required';
  END IF;
  SELECT * INTO deal_row FROM finnor_os.pe_deals WHERE tenant_id=p_tenant AND id=p_deal FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PE Deal not found in authenticated tenant'; END IF;
  IF deal_row.status='closed' THEN
    RETURN jsonb_build_object('changed',false,'idempotent',true,'row',to_jsonb(deal_row),
      'eligibility',finnor_os.pe_evaluate_deal_close_eligibility(p_tenant,p_deal));
  END IF;
  IF deal_row.status<>'active' THEN RAISE EXCEPTION 'terminated PE Deal cannot close'; END IF;
  IF p_expected_version IS NULL OR p_expected_graph_version IS NULL
     OR deal_row.version<>p_expected_version OR deal_row.graph_version<>p_expected_graph_version THEN
    RAISE EXCEPTION 'stale PE Deal close version';
  END IF;
  eligibility:=finnor_os.pe_evaluate_deal_close_eligibility(p_tenant,p_deal);
  IF NOT (eligibility->>'eligible')::boolean THEN
    RETURN jsonb_build_object('changed',false,'idempotent',false,'rejected',true,'row',to_jsonb(deal_row),'eligibility',eligibility);
  END IF;
  PERFORM set_config('app.pe_actor',p_actor,true);
  PERFORM set_config('app.pe_source',p_source,true);
  PERFORM set_config('app.pe_deal_transition','declare_closed',true);
  UPDATE finnor_os.pe_deals
  SET status='closed',actual_close_at=now(),close_authority_decision_id=p_authority_decision,
      close_decision_receipt_id=p_decision_receipt,version=version+1,updated_at=now()
  WHERE tenant_id=p_tenant AND id=p_deal
  RETURNING * INTO closed_row;
  RETURN jsonb_build_object('changed',true,'idempotent',false,'row',to_jsonb(closed_row),'eligibility',eligibility);
END $$;

CREATE OR REPLACE FUNCTION finnor_os.pe_terminate_deal(
  p_tenant uuid,p_deal uuid,p_expected_version integer,p_reason text,
  p_authority_decision uuid,p_decision_receipt uuid,p_source text,p_actor text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE deal_row finnor_os.pe_deals%ROWTYPE; terminated_row finnor_os.pe_deals%ROWTYPE;
BEGIN
  IF finnor_os.request_tenant_id() IS DISTINCT FROM p_tenant THEN
    RAISE EXCEPTION 'PE termination crosses authenticated tenant boundary';
  END IF;
  IF coalesce(btrim(p_reason),'')='' OR coalesce(btrim(p_source),'')='' OR coalesce(btrim(p_actor),'')='' THEN
    RAISE EXCEPTION 'PE termination reason and provenance are required';
  END IF;
  SELECT * INTO deal_row FROM finnor_os.pe_deals WHERE tenant_id=p_tenant AND id=p_deal FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PE Deal not found in authenticated tenant'; END IF;
  IF deal_row.status='terminated' THEN
    RETURN jsonb_build_object('changed',false,'idempotent',true,'row',to_jsonb(deal_row));
  END IF;
  IF deal_row.status<>'active' THEN RAISE EXCEPTION 'closed PE Deal cannot terminate'; END IF;
  IF p_expected_version IS NULL OR deal_row.version<>p_expected_version THEN
    RAISE EXCEPTION 'stale PE Deal termination version';
  END IF;
  PERFORM set_config('app.pe_actor',p_actor,true);
  PERFORM set_config('app.pe_source',p_source,true);
  PERFORM set_config('app.pe_deal_transition','terminate',true);
  UPDATE finnor_os.pe_deals
  SET status='terminated',terminated_at=now(),termination_reason=p_reason,
      termination_authority_decision_id=p_authority_decision,
      termination_decision_receipt_id=p_decision_receipt,version=version+1,updated_at=now()
  WHERE tenant_id=p_tenant AND id=p_deal
  RETURNING * INTO terminated_row;
  RETURN jsonb_build_object('changed',true,'idempotent',false,'row',to_jsonb(terminated_row));
END $$;

DROP TRIGGER IF EXISTS tasks_p2_subject_scope ON finnor_os.tasks;
CREATE TRIGGER tasks_p2_subject_scope BEFORE INSERT OR UPDATE ON finnor_os.tasks
FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_p2_task_scope();

-- PE-owned runtime registration. Relationship rows are registered for provenance
-- and graph reconstruction but only consequential business objects are Work targets.
INSERT INTO finnor_os.canonical_truth_registry
  (entity_type,vertical_key,source_table,writable_owner,mutation_boundary,work_attachable)
VALUES
  ('pe_deal','private_equity','pe_deals','@finnor/private-equity','createDeal / declareDealClosed / terminateDeal',true),
  ('pe_deal_party','private_equity','pe_deal_parties','@finnor/private-equity','addDealParty / removeDealParty',false),
  ('pe_workstream','private_equity','pe_workstreams','@finnor/private-equity','explicit Workstream transitions',true),
  ('pe_request','private_equity','pe_requests','@finnor/private-equity','explicit Request transitions',true),
  ('pe_deliverable','private_equity','pe_deliverables','@finnor/private-equity','explicit Deliverable transitions',true),
  ('pe_finding','private_equity','pe_findings','@finnor/private-equity','explicit Finding transitions',true),
  ('pe_deal_risk','private_equity','pe_deal_risks','@finnor/private-equity','explicit DealRisk transitions',true),
  ('pe_dependency','private_equity','pe_dependencies','@finnor/private-equity','createDependency / removeDependency',false),
  ('pe_milestone','private_equity','pe_milestones','@finnor/private-equity','explicit Milestone transitions',true),
  ('pe_closing_condition','private_equity','pe_closing_conditions','@finnor/private-equity','guarded ClosingCondition transitions',true),
  ('pe_closing_item','private_equity','pe_closing_items','@finnor/private-equity','guarded ClosingItem transitions',true),
  ('pe_document_link','private_equity','pe_document_links','@finnor/private-equity','attachCanonicalDocument',false),
  ('pe_evidence_link','private_equity','pe_evidence_links','@finnor/private-equity','attachCanonicalEvidence',false),
  ('pe_finding_risk_link','private_equity','pe_finding_risk_links','@finnor/private-equity','linkFindingToDealRisk',false)
ON CONFLICT (entity_type) DO UPDATE SET
  vertical_key=EXCLUDED.vertical_key,source_table=EXCLUDED.source_table,writable_owner=EXCLUDED.writable_owner,
  mutation_boundary=EXCLUDED.mutation_boundary,work_attachable=EXCLUDED.work_attachable,updated_at=now();

-- PE graph projection lives with the vertical; the existing Core company graph
-- remains free of Deal-specific imports and Water retains its own edges.
CREATE OR REPLACE VIEW finnor_os.pe_deal_graph_nodes WITH (security_invoker=true) AS
SELECT tenant_id,id deal_id,'pe_deal'::text entity_type,id entity_id,name label,status state,created_at,updated_at FROM finnor_os.pe_deals
UNION ALL SELECT tenant_id,deal_id,'pe_deal_party',id,role,state,created_at,updated_at FROM finnor_os.pe_deal_parties
UNION ALL SELECT tenant_id,deal_id,'pe_workstream',id,name,state,created_at,updated_at FROM finnor_os.pe_workstreams
UNION ALL SELECT tenant_id,deal_id,'pe_request',id,request_text,state,created_at,updated_at FROM finnor_os.pe_requests
UNION ALL SELECT tenant_id,deal_id,'pe_deliverable',id,description,state,created_at,updated_at FROM finnor_os.pe_deliverables
UNION ALL SELECT tenant_id,deal_id,'pe_finding',id,statement,state,created_at,updated_at FROM finnor_os.pe_findings
UNION ALL SELECT tenant_id,deal_id,'pe_deal_risk',id,statement,state,created_at,updated_at FROM finnor_os.pe_deal_risks
UNION ALL SELECT tenant_id,deal_id,'pe_dependency',id,relation,CASE WHEN removed_at IS NULL THEN 'active' ELSE 'removed' END,created_at,updated_at FROM finnor_os.pe_dependencies
UNION ALL SELECT tenant_id,deal_id,'pe_milestone',id,name,state,created_at,updated_at FROM finnor_os.pe_milestones
UNION ALL SELECT tenant_id,deal_id,'pe_closing_condition',id,condition_text,state,created_at,updated_at FROM finnor_os.pe_closing_conditions
UNION ALL SELECT tenant_id,deal_id,'pe_closing_item',id,item_text,state,created_at,updated_at FROM finnor_os.pe_closing_items
UNION ALL SELECT e.tenant_id,finnor_os.pe_entity_deal(e.entity_type,e.entity_id),'business_event',e.id,e.event_type,'recorded',e.occurred_at,e.occurred_at
  FROM finnor_os.business_events e
  WHERE e.entity_type LIKE 'pe\_%' ESCAPE '\' AND finnor_os.pe_entity_deal(e.entity_type,e.entity_id) IS NOT NULL
UNION ALL SELECT ad.tenant_id,d.id,'authority_decision',ad.id,ad.capability,ad.outcome,ad.created_at,ad.created_at
  FROM finnor_os.authority_decisions ad
  JOIN finnor_os.pe_deals d ON d.tenant_id=ad.tenant_id AND ad.resource_type='pe_deal' AND ad.resource_id=d.id
UNION ALL SELECT ad.tenant_id,c.deal_id,'authority_decision',ad.id,ad.capability,ad.outcome,ad.created_at,ad.created_at
  FROM finnor_os.authority_decisions ad
  JOIN finnor_os.pe_closing_conditions c
    ON c.tenant_id=ad.tenant_id AND ad.resource_type='pe_closing_condition' AND ad.resource_id=c.id
UNION ALL SELECT r.tenant_id,d.id,'decision_receipt',r.id,r.objective,
    CASE WHEN r.finalized_at IS NULL THEN 'open' ELSE 'finalized' END,r.created_at,r.created_at
  FROM finnor_os.pe_deals d
  JOIN finnor_os.decision_receipts r ON r.tenant_id=d.tenant_id
    AND r.id IN (d.close_decision_receipt_id,d.termination_decision_receipt_id)
UNION ALL SELECT r.tenant_id,c.deal_id,'decision_receipt',r.id,r.objective,
    CASE WHEN r.finalized_at IS NULL THEN 'open' ELSE 'finalized' END,r.created_at,r.created_at
  FROM finnor_os.pe_closing_conditions c
  JOIN finnor_os.decision_receipts r ON r.tenant_id=c.tenant_id AND r.id=c.waiver_decision_receipt_id
UNION ALL SELECT ar.tenant_id,CASE WHEN ad.resource_type='pe_deal' THEN ad.resource_id ELSE c.deal_id END,
    'authority_approval_request',ar.id,'Approval request',ar.status,ar.created_at,coalesce(ar.resolved_at,ar.created_at)
  FROM finnor_os.authority_approval_requests ar
  JOIN finnor_os.authority_decisions ad ON ad.tenant_id=ar.tenant_id AND ad.id=ar.authority_decision_id
  LEFT JOIN finnor_os.pe_closing_conditions c
    ON c.tenant_id=ad.tenant_id AND ad.resource_type='pe_closing_condition' AND c.id=ad.resource_id
  WHERE ad.resource_type='pe_deal' OR c.id IS NOT NULL;

CREATE OR REPLACE VIEW finnor_os.pe_deal_graph_edges WITH (security_invoker=true) AS
SELECT tenant_id,id deal_id,'pe_deal'::text from_type,id from_id,'targets'::text relation,'external_organization'::text to_type,target_organization_id to_id,'pe_deals'::text source_table,'target_organization_id'::text source_column FROM finnor_os.pe_deals
UNION ALL SELECT tenant_id,id,'pe_deal',id,'led_by','user',deal_lead_employee_id,'pe_deals','deal_lead_employee_id' FROM finnor_os.pe_deals
UNION ALL SELECT tenant_id,deal_id,'pe_deal',deal_id,'has_party','pe_deal_party',id,'pe_deal_parties','deal_id' FROM finnor_os.pe_deal_parties
UNION ALL SELECT tenant_id,deal_id,'pe_deal',deal_id,'has_workstream','pe_workstream',id,'pe_workstreams','deal_id' FROM finnor_os.pe_workstreams
UNION ALL SELECT tenant_id,deal_id,'pe_workstream',workstream_id,'has_request','pe_request',id,'pe_requests','workstream_id' FROM finnor_os.pe_requests
UNION ALL SELECT tenant_id,deal_id,'pe_workstream',workstream_id,'has_deliverable','pe_deliverable',id,'pe_deliverables','workstream_id' FROM finnor_os.pe_deliverables
UNION ALL SELECT tenant_id,deal_id,'pe_request',request_id,'expects','pe_deliverable',id,'pe_deliverables','request_id' FROM finnor_os.pe_deliverables WHERE request_id IS NOT NULL
UNION ALL SELECT tenant_id,deal_id,'pe_workstream',workstream_id,'has_finding','pe_finding',id,'pe_findings','workstream_id' FROM finnor_os.pe_findings
UNION ALL SELECT tenant_id,deal_id,'pe_workstream',workstream_id,'has_risk','pe_deal_risk',id,'pe_deal_risks','workstream_id' FROM finnor_os.pe_deal_risks
UNION ALL SELECT tenant_id,deal_id,'pe_finding',finding_id,'creates_risk','pe_deal_risk',deal_risk_id,'pe_finding_risk_links','deal_risk_id' FROM finnor_os.pe_finding_risk_links WHERE archived_at IS NULL
UNION ALL SELECT tenant_id,deal_id,blocker_type,blocker_id,'blocks',blocked_type,blocked_id,'pe_dependencies','blocked_id' FROM finnor_os.pe_dependencies WHERE removed_at IS NULL
UNION ALL SELECT tenant_id,deal_id,'pe_deal',deal_id,'has_milestone','pe_milestone',id,'pe_milestones','deal_id' FROM finnor_os.pe_milestones
UNION ALL SELECT tenant_id,deal_id,'pe_deal',deal_id,'has_closing_condition','pe_closing_condition',id,'pe_closing_conditions','deal_id' FROM finnor_os.pe_closing_conditions
UNION ALL SELECT tenant_id,deal_id,'pe_deal',deal_id,'has_closing_item','pe_closing_item',id,'pe_closing_items','deal_id' FROM finnor_os.pe_closing_items
UNION ALL SELECT tenant_id,deal_id,entity_type,entity_id,'linked_document','document',document_id,'pe_document_links','document_id' FROM finnor_os.pe_document_links WHERE archived_at IS NULL
UNION ALL SELECT tenant_id,deal_id,entity_type,entity_id,'linked_evidence','evidence_source',evidence_source_id,'pe_evidence_links','evidence_source_id' FROM finnor_os.pe_evidence_links WHERE archived_at IS NULL
UNION ALL SELECT tenant_id,deal_id,'pe_deal_party',id,'participates_as',party_type,party_id,'pe_deal_parties','party_id' FROM finnor_os.pe_deal_parties WHERE state='active'
UNION ALL SELECT e.tenant_id,finnor_os.pe_entity_deal(e.entity_type,e.entity_id),e.entity_type,e.entity_id,'history','business_event',e.id,'business_events','entity_id'
  FROM finnor_os.business_events e
  WHERE e.entity_type LIKE 'pe\_%' ESCAPE '\' AND finnor_os.pe_entity_deal(e.entity_type,e.entity_id) IS NOT NULL
UNION ALL SELECT d.tenant_id,d.id,'pe_deal',d.id,'governed_by','authority_decision',d.close_authority_decision_id,'pe_deals','close_authority_decision_id'
  FROM finnor_os.pe_deals d WHERE d.close_authority_decision_id IS NOT NULL
UNION ALL SELECT d.tenant_id,d.id,'pe_deal',d.id,'governed_by','authority_decision',d.termination_authority_decision_id,'pe_deals','termination_authority_decision_id'
  FROM finnor_os.pe_deals d WHERE d.termination_authority_decision_id IS NOT NULL
UNION ALL SELECT c.tenant_id,c.deal_id,'pe_closing_condition',c.id,'governed_by','authority_decision',c.waiver_authority_decision_id,'pe_closing_conditions','waiver_authority_decision_id'
  FROM finnor_os.pe_closing_conditions c WHERE c.waiver_authority_decision_id IS NOT NULL
UNION ALL SELECT d.tenant_id,d.id,'pe_deal',d.id,'receipt','decision_receipt',d.close_decision_receipt_id,'pe_deals','close_decision_receipt_id'
  FROM finnor_os.pe_deals d WHERE d.close_decision_receipt_id IS NOT NULL
UNION ALL SELECT d.tenant_id,d.id,'pe_deal',d.id,'receipt','decision_receipt',d.termination_decision_receipt_id,'pe_deals','termination_decision_receipt_id'
  FROM finnor_os.pe_deals d WHERE d.termination_decision_receipt_id IS NOT NULL
UNION ALL SELECT c.tenant_id,c.deal_id,'pe_closing_condition',c.id,'receipt','decision_receipt',c.waiver_decision_receipt_id,'pe_closing_conditions','waiver_decision_receipt_id'
  FROM finnor_os.pe_closing_conditions c WHERE c.waiver_decision_receipt_id IS NOT NULL
UNION ALL SELECT ar.tenant_id,CASE WHEN ad.resource_type='pe_deal' THEN ad.resource_id ELSE c.deal_id END,
    ad.resource_type,ad.resource_id,'approval','authority_approval_request',ar.id,'authority_approval_requests','authority_decision_id'
  FROM finnor_os.authority_approval_requests ar
  JOIN finnor_os.authority_decisions ad ON ad.tenant_id=ar.tenant_id AND ad.id=ar.authority_decision_id
  LEFT JOIN finnor_os.pe_closing_conditions c
    ON c.tenant_id=ad.tenant_id AND ad.resource_type='pe_closing_condition' AND c.id=ad.resource_id
  WHERE ad.resource_type='pe_deal' OR c.id IS NOT NULL
UNION ALL SELECT t.tenant_id,finnor_os.pe_entity_deal(t.subject_type,t.subject_id),'task',t.id,'about',t.subject_type,t.subject_id,'tasks','subject_id'
  FROM finnor_os.tasks t
  JOIN finnor_os.canonical_truth_registry r ON r.entity_type=t.subject_type AND r.vertical_key='private_equity'
UNION ALL SELECT l.tenant_id,finnor_os.pe_entity_deal(l.entity_type,l.entity_id),'work',l.work_id,l.relationship,l.entity_type,l.entity_id,'work_entity_links','entity_id'
  FROM finnor_os.work_entity_links l WHERE l.entity_type LIKE 'pe\_%' ESCAPE '\';

DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'pe_deals','pe_deal_parties','pe_workstreams','pe_requests','pe_deliverables','pe_findings',
    'pe_deal_risks','pe_finding_risk_links','pe_dependencies','pe_milestones',
    'pe_closing_conditions','pe_closing_items','pe_document_links','pe_evidence_links'
  ] LOOP
    EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON finnor_os.%I',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON finnor_os.%I USING (tenant_id=finnor_os.request_tenant_id()) WITH CHECK (tenant_id=finnor_os.request_tenant_id())',table_name);
  END LOOP;
END $rls$;

CREATE UNIQUE INDEX pe_deal_closed_event_once_idx
  ON finnor_os.business_events(tenant_id,entity_type,entity_id,event_type)
  WHERE entity_type='pe_deal' AND event_type='pe_deal_closed';

REVOKE ALL ON FUNCTION finnor_os.pe_party_tenant(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.pe_entity_deal(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.pe_endpoint_resolved(text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.pe_governance_proof_valid(uuid,text,uuid,text,uuid,uuid,boolean,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.pe_evaluate_deal_close_eligibility(uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.pe_declare_deal_closed(uuid,uuid,integer,integer,uuid,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.pe_terminate_deal(uuid,uuid,integer,text,uuid,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.touch_pe_deal_graph() FROM PUBLIC;

DO $grants$
DECLARE table_name text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
    FOREACH table_name IN ARRAY ARRAY[
      'pe_deals','pe_deal_parties','pe_workstreams','pe_requests','pe_deliverables','pe_findings',
      'pe_deal_risks','pe_finding_risk_links','pe_dependencies','pe_milestones',
      'pe_closing_conditions','pe_closing_items','pe_document_links','pe_evidence_links'
    ] LOOP
      EXECUTE format('GRANT SELECT,INSERT,UPDATE ON finnor_os.%I TO finnor_app',table_name);
      EXECUTE format('REVOKE DELETE ON finnor_os.%I FROM finnor_app',table_name);
    END LOOP;
    GRANT SELECT ON finnor_os.pe_deal_graph_nodes,finnor_os.pe_deal_graph_edges TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.pe_party_tenant(text,uuid) TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.pe_entity_deal(text,uuid) TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.pe_endpoint_resolved(text,uuid) TO finnor_app;
    -- No application caller can directly update the transaction root. The two
    -- SECURITY DEFINER functions below are the only terminal-state writers.
    REVOKE UPDATE ON finnor_os.pe_deals FROM finnor_app;
    GRANT SELECT,INSERT ON finnor_os.pe_deals TO finnor_app;
    -- PostgreSQL requires some UPDATE privilege for SELECT ... FOR UPDATE. Only
    -- updated_at is exposed, and the Deal version trigger makes a direct write to
    -- that column fail; terminal/business columns remain function-owned.
    GRANT UPDATE (updated_at) ON finnor_os.pe_deals TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.pe_governance_proof_valid(uuid,text,uuid,text,uuid,uuid,boolean,boolean) TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.pe_evaluate_deal_close_eligibility(uuid,uuid) TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.pe_declare_deal_closed(uuid,uuid,integer,integer,uuid,uuid,text,text) TO finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.pe_terminate_deal(uuid,uuid,integer,text,uuid,uuid,text,text) TO finnor_app;
  END IF;
END $grants$;

COMMENT ON TABLE finnor_os.pe_deals IS 'Private Equity transaction root. closed is writable only through @finnor/private-equity declareDealClosed.';
COMMENT ON TABLE finnor_os.pe_workstreams IS 'Concurrent transaction structure; deliberately distinct from durable Core Work.';
COMMENT ON TABLE finnor_os.pe_requests IS 'Something required from another deal party; deliberately distinct from Core Task.';
COMMENT ON TABLE finnor_os.pe_deliverables IS 'Expected business artifact/result; canonical content remains in Core Document.';
COMMENT ON TABLE finnor_os.pe_findings IS 'Discovered transaction fact; deliberately distinct from PE DealRisk and Core policy risk.';
COMMENT ON TABLE finnor_os.pe_dependencies IS 'Typed same-Deal acyclic business blockers; not planner/workflow dependencies.';
