-- P1: canonical PE world ontology from Strategy through semantic Decision.
-- Core Work, Task, Document, Evidence, BusinessEvent, Authority,
-- DecisionReceipt, Source Truth, and reconciliation owners are reused in place.

CREATE TABLE finnor_os.pe_strategies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  name text NOT NULL CHECK (btrim(name)<>''),
  description text,
  investment_criteria jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','active','retired')),
  activated_at timestamptz,
  retired_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_strategies_tenant_id_id_key UNIQUE (tenant_id,id),
  CONSTRAINT pe_strategies_source_identity_key UNIQUE (tenant_id,source_system,external_id),
  CONSTRAINT pe_strategies_criteria_bound CHECK (octet_length(investment_criteria::text)<=32768),
  CONSTRAINT pe_strategies_state_time_check CHECK (
    (state='draft' AND activated_at IS NULL AND retired_at IS NULL)
    OR (state='active' AND activated_at IS NOT NULL AND retired_at IS NULL)
    OR (state='retired' AND retired_at IS NOT NULL)
  )
);
CREATE INDEX pe_strategies_tenant_state_idx
  ON finnor_os.pe_strategies(tenant_id,state,created_at,id);

CREATE TABLE finnor_os.pe_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  strategy_id uuid NOT NULL,
  target_organization_id uuid NOT NULL,
  name text NOT NULL CHECK (btrim(name)<>''),
  summary text,
  state text NOT NULL DEFAULT 'identified' CHECK (state IN ('identified','screening','qualified','promoted','rejected')),
  screening_started_at timestamptz,
  qualified_at timestamptz,
  promoted_at timestamptz,
  rejected_at timestamptz,
  rejection_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_opportunities_tenant_id_id_key UNIQUE (tenant_id,id),
  CONSTRAINT pe_opportunities_strategy_fkey FOREIGN KEY (tenant_id,strategy_id)
    REFERENCES finnor_os.pe_strategies(tenant_id,id),
  CONSTRAINT pe_opportunities_target_fkey FOREIGN KEY (tenant_id,target_organization_id)
    REFERENCES finnor_os.external_organizations(tenant_id,id),
  CONSTRAINT pe_opportunities_source_identity_key UNIQUE (tenant_id,source_system,external_id),
  CONSTRAINT pe_opportunities_state_time_check CHECK (
    (state='identified' AND screening_started_at IS NULL AND qualified_at IS NULL AND promoted_at IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL)
    OR (state='screening' AND screening_started_at IS NOT NULL AND qualified_at IS NULL AND promoted_at IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL)
    OR (state='qualified' AND screening_started_at IS NOT NULL AND qualified_at IS NOT NULL AND promoted_at IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL)
    OR (state='promoted' AND qualified_at IS NOT NULL AND promoted_at IS NOT NULL AND rejected_at IS NULL AND rejection_reason IS NULL)
    OR (state='rejected' AND rejected_at IS NOT NULL AND btrim(rejection_reason)<>'' AND promoted_at IS NULL)
  )
);
CREATE INDEX pe_opportunities_tenant_strategy_state_idx
  ON finnor_os.pe_opportunities(tenant_id,strategy_id,state,created_at,id);
CREATE INDEX pe_opportunities_tenant_target_idx
  ON finnor_os.pe_opportunities(tenant_id,target_organization_id,id);

ALTER TABLE finnor_os.pe_deals ADD COLUMN opportunity_id uuid;
ALTER TABLE finnor_os.pe_deals
  ADD CONSTRAINT pe_deals_opportunity_fkey FOREIGN KEY (tenant_id,opportunity_id)
    REFERENCES finnor_os.pe_opportunities(tenant_id,id);
CREATE UNIQUE INDEX pe_deals_opportunity_once_idx
  ON finnor_os.pe_deals(opportunity_id) WHERE opportunity_id IS NOT NULL;

CREATE TABLE finnor_os.pe_investment_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  title text NOT NULL CHECK (btrim(title)<>''),
  summary text,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','active','superseded','archived')),
  activated_at timestamptz,
  superseded_at timestamptz,
  archived_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_investment_cases_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_investment_cases_deal_fkey FOREIGN KEY (tenant_id,deal_id)
    REFERENCES finnor_os.pe_deals(tenant_id,id),
  CONSTRAINT pe_investment_cases_source_identity_key UNIQUE (tenant_id,source_system,external_id),
  CONSTRAINT pe_investment_cases_state_time_check CHECK (
    (state='draft' AND activated_at IS NULL AND superseded_at IS NULL AND archived_at IS NULL)
    OR (state='active' AND activated_at IS NOT NULL AND superseded_at IS NULL AND archived_at IS NULL)
    OR (state='superseded' AND activated_at IS NOT NULL AND superseded_at IS NOT NULL AND archived_at IS NULL)
    OR (state='archived' AND archived_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX pe_investment_cases_one_active_idx
  ON finnor_os.pe_investment_cases(deal_id) WHERE state='active';
CREATE INDEX pe_investment_cases_tenant_deal_state_idx
  ON finnor_os.pe_investment_cases(tenant_id,deal_id,state,created_at,id);

CREATE TABLE finnor_os.pe_theses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  investment_case_id uuid NOT NULL,
  thesis_type text NOT NULL CHECK (btrim(thesis_type)<>''),
  title text NOT NULL CHECK (btrim(title)<>''),
  statement text NOT NULL CHECK (btrim(statement)<>''),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','active','superseded','retired')),
  activated_at timestamptz,
  superseded_at timestamptz,
  retired_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_theses_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_theses_case_fkey FOREIGN KEY (tenant_id,deal_id,investment_case_id)
    REFERENCES finnor_os.pe_investment_cases(tenant_id,deal_id,id),
  CONSTRAINT pe_theses_source_identity_key UNIQUE (tenant_id,source_system,external_id),
  CONSTRAINT pe_theses_state_time_check CHECK (
    (state='draft' AND activated_at IS NULL AND superseded_at IS NULL AND retired_at IS NULL)
    OR (state='active' AND activated_at IS NOT NULL AND superseded_at IS NULL AND retired_at IS NULL)
    OR (state='superseded' AND activated_at IS NOT NULL AND superseded_at IS NOT NULL AND retired_at IS NULL)
    OR (state='retired' AND retired_at IS NOT NULL)
  )
);
CREATE INDEX pe_theses_tenant_case_state_idx
  ON finnor_os.pe_theses(tenant_id,investment_case_id,state,created_at,id);

CREATE TABLE finnor_os.pe_assumptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  investment_case_id uuid NOT NULL,
  assumption_key text NOT NULL CHECK (btrim(assumption_key)<>''),
  statement text NOT NULL CHECK (btrim(statement)<>''),
  value_type text NOT NULL CHECK (value_type IN ('number','currency','percent','boolean','date','text','json')),
  value jsonb NOT NULL,
  currency_code text,
  unit text,
  materiality text NOT NULL DEFAULT 'medium' CHECK (materiality IN ('low','medium','high','critical')),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','superseded','invalidated')),
  supersedes_assumption_id uuid REFERENCES finnor_os.pe_assumptions(id),
  superseded_at timestamptz,
  invalidated_at timestamptz,
  invalidation_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_assumptions_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_assumptions_case_fkey FOREIGN KEY (tenant_id,deal_id,investment_case_id)
    REFERENCES finnor_os.pe_investment_cases(tenant_id,deal_id,id),
  CONSTRAINT pe_assumptions_revision_once_key UNIQUE (supersedes_assumption_id),
  CONSTRAINT pe_assumptions_source_identity_key UNIQUE (tenant_id,source_system,external_id),
  CONSTRAINT pe_assumptions_value_shape_check CHECK (
    (value_type IN ('number','currency','percent') AND jsonb_typeof(value)='number')
    OR (value_type='boolean' AND jsonb_typeof(value)='boolean')
    OR (value_type='date' AND jsonb_typeof(value)='string' AND value#>>'{}' ~ '^\d{4}-\d{2}-\d{2}$')
    OR (value_type='text' AND jsonb_typeof(value)='string')
    OR (value_type='json' AND jsonb_typeof(value) IN ('object','array'))
  ),
  CONSTRAINT pe_assumptions_currency_check CHECK (
    (value_type='currency' AND currency_code ~ '^[A-Z]{3}$')
    OR (value_type<>'currency' AND currency_code IS NULL)
  ),
  CONSTRAINT pe_assumptions_state_time_check CHECK (
    (state='active' AND superseded_at IS NULL AND invalidated_at IS NULL AND invalidation_reason IS NULL)
    OR (state='superseded' AND superseded_at IS NOT NULL AND invalidated_at IS NULL AND invalidation_reason IS NULL)
    OR (state='invalidated' AND superseded_at IS NULL AND invalidated_at IS NOT NULL AND btrim(invalidation_reason)<>'')
  )
);
CREATE UNIQUE INDEX pe_assumptions_one_current_key_idx
  ON finnor_os.pe_assumptions(investment_case_id,lower(assumption_key)) WHERE state='active';
CREATE INDEX pe_assumptions_tenant_case_state_idx
  ON finnor_os.pe_assumptions(tenant_id,investment_case_id,state,created_at,id);

CREATE TABLE finnor_os.pe_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  deal_id uuid NOT NULL,
  investment_case_id uuid NOT NULL,
  decision_type text NOT NULL CHECK (btrim(decision_type)<>''),
  title text NOT NULL CHECK (btrim(title)<>''),
  decision text NOT NULL CHECK (btrim(decision)<>''),
  rationale text,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','final','superseded')),
  decided_by_party_type text CHECK (decided_by_party_type IS NULL OR decided_by_party_type IN ('employee','team','external_organization','external_contact')),
  decided_by_party_id uuid,
  decided_at timestamptz,
  supersedes_decision_id uuid REFERENCES finnor_os.pe_decisions(id),
  superseded_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''),
  external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_decisions_tenant_id_id_key UNIQUE (tenant_id,id),
  CONSTRAINT pe_decisions_tenant_deal_id_key UNIQUE (tenant_id,deal_id,id),
  CONSTRAINT pe_decisions_case_fkey FOREIGN KEY (tenant_id,deal_id,investment_case_id)
    REFERENCES finnor_os.pe_investment_cases(tenant_id,deal_id,id),
  CONSTRAINT pe_decisions_supersession_once_key UNIQUE (supersedes_decision_id),
  CONSTRAINT pe_decisions_source_identity_key UNIQUE (tenant_id,source_system,external_id),
  CONSTRAINT pe_decisions_party_pair_check CHECK ((decided_by_party_type IS NULL)=(decided_by_party_id IS NULL)),
  CONSTRAINT pe_decisions_state_time_check CHECK (
    (state='draft' AND decided_by_party_id IS NULL AND decided_at IS NULL AND superseded_at IS NULL)
    OR (state='final' AND decided_by_party_id IS NOT NULL AND decided_at IS NOT NULL AND superseded_at IS NULL)
    OR (state='superseded' AND decided_by_party_id IS NOT NULL AND decided_at IS NOT NULL AND superseded_at IS NOT NULL)
  )
);
CREATE INDEX pe_decisions_tenant_case_state_idx
  ON finnor_os.pe_decisions(tenant_id,investment_case_id,state,created_at,id);

-- Small typed join only; this does not duplicate Work, Action, or Receipt truth.
CREATE TABLE finnor_os.pe_decision_effect_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  decision_id uuid NOT NULL,
  effect_type text NOT NULL CHECK (effect_type IN ('work','domain_action','decision_receipt')),
  effect_id uuid NOT NULL,
  relationship text NOT NULL DEFAULT 'implements' CHECK (relationship IN ('implements','records','governs')),
  created_by text NOT NULL CHECK (btrim(created_by)<>''),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_decision_effect_links_decision_fkey FOREIGN KEY (tenant_id,decision_id)
    REFERENCES finnor_os.pe_decisions(tenant_id,id),
  CONSTRAINT pe_decision_effect_links_identity_key UNIQUE (decision_id,effect_type,effect_id,relationship)
);
CREATE INDEX pe_decision_effect_links_tenant_decision_idx
  ON finnor_os.pe_decision_effect_links(tenant_id,decision_id,created_at,id);

-- Root identity is explicit and does not invent fake Deal ids for pre-Deal truth.
CREATE OR REPLACE FUNCTION finnor_os.pe_entity_world_root(p_type text,p_id uuid)
RETURNS TABLE(root_type text,root_id uuid,deal_id uuid)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  CASE p_type
    WHEN 'pe_strategy' THEN
      RETURN QUERY SELECT 'pe_strategy'::text,s.id,NULL::uuid FROM finnor_os.pe_strategies s WHERE s.id=p_id;
    WHEN 'pe_opportunity' THEN
      RETURN QUERY SELECT 'pe_opportunity'::text,o.id,d.id
        FROM finnor_os.pe_opportunities o LEFT JOIN finnor_os.pe_deals d ON d.opportunity_id=o.id
       WHERE o.id=p_id;
    WHEN 'pe_deal' THEN
      RETURN QUERY SELECT 'pe_deal'::text,d.id,d.id FROM finnor_os.pe_deals d WHERE d.id=p_id;
    WHEN 'pe_investment_case' THEN
      RETURN QUERY SELECT 'pe_deal'::text,c.deal_id,c.deal_id FROM finnor_os.pe_investment_cases c WHERE c.id=p_id;
    WHEN 'pe_thesis' THEN
      RETURN QUERY SELECT 'pe_deal'::text,t.deal_id,t.deal_id FROM finnor_os.pe_theses t WHERE t.id=p_id;
    WHEN 'pe_assumption' THEN
      RETURN QUERY SELECT 'pe_deal'::text,a.deal_id,a.deal_id FROM finnor_os.pe_assumptions a WHERE a.id=p_id;
    WHEN 'pe_decision' THEN
      RETURN QUERY SELECT 'pe_deal'::text,d.deal_id,d.deal_id FROM finnor_os.pe_decisions d WHERE d.id=p_id;
    WHEN 'pe_deal_party' THEN
      RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_deal_parties x WHERE x.id=p_id;
    WHEN 'pe_workstream' THEN
      RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_workstreams x WHERE x.id=p_id;
    WHEN 'pe_request' THEN
      RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_requests x WHERE x.id=p_id;
    WHEN 'pe_deliverable' THEN
      RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_deliverables x WHERE x.id=p_id;
    WHEN 'pe_finding' THEN
      RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_findings x WHERE x.id=p_id;
    WHEN 'pe_deal_risk' THEN
      RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_deal_risks x WHERE x.id=p_id;
    WHEN 'pe_dependency' THEN
      RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_dependencies x WHERE x.id=p_id;
    WHEN 'pe_milestone' THEN
      RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_milestones x WHERE x.id=p_id;
    WHEN 'pe_closing_condition' THEN
      RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_closing_conditions x WHERE x.id=p_id;
    WHEN 'pe_closing_item' THEN
      RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_closing_items x WHERE x.id=p_id;
    WHEN 'pe_finding_risk_link' THEN
      RETURN QUERY SELECT 'pe_deal'::text,x.deal_id,x.deal_id FROM finnor_os.pe_finding_risk_links x WHERE x.id=p_id;
    WHEN 'pe_document_link' THEN
      RETURN QUERY SELECT x.world_root_type,x.world_root_id,x.deal_id FROM finnor_os.pe_document_links x WHERE x.id=p_id;
    WHEN 'pe_evidence_link' THEN
      RETURN QUERY SELECT x.world_root_type,x.world_root_id,x.deal_id FROM finnor_os.pe_evidence_links x WHERE x.id=p_id;
    ELSE RETURN;
  END CASE;
END $$;

-- Generalize existing PE links without replacing or destructively moving a row.
DROP TRIGGER IF EXISTS pe_child_scope ON finnor_os.pe_document_links;
DROP TRIGGER IF EXISTS pe_graph_touch ON finnor_os.pe_document_links;
DROP TRIGGER IF EXISTS pe_version_guard ON finnor_os.pe_document_links;
DROP TRIGGER IF EXISTS pe_document_links_scope ON finnor_os.pe_document_links;
DROP TRIGGER IF EXISTS pe_child_scope ON finnor_os.pe_evidence_links;
DROP TRIGGER IF EXISTS pe_graph_touch ON finnor_os.pe_evidence_links;
DROP TRIGGER IF EXISTS pe_version_guard ON finnor_os.pe_evidence_links;
DROP TRIGGER IF EXISTS pe_evidence_links_scope ON finnor_os.pe_evidence_links;

ALTER TABLE finnor_os.pe_document_links ADD COLUMN world_root_type text;
ALTER TABLE finnor_os.pe_document_links ADD COLUMN world_root_id uuid;
ALTER TABLE finnor_os.pe_evidence_links ADD COLUMN world_root_type text;
ALTER TABLE finnor_os.pe_evidence_links ADD COLUMN world_root_id uuid;
SET LOCAL app.canonical_history_origin='baseline';
UPDATE finnor_os.pe_document_links
   SET world_root_type='pe_deal',world_root_id=deal_id,version=version+1,updated_at=now();
UPDATE finnor_os.pe_evidence_links
   SET world_root_type='pe_deal',world_root_id=deal_id,version=version+1,updated_at=now();
RESET app.canonical_history_origin;
-- The 0110 snapshots for these two link types predate their world-root fields.
-- Narrow their advertised coverage to the first instant after the truthful,
-- root-aware baseline exists instead of fabricating roots for the small upgrade
-- interval between migrations.
DO $link_history_coverage$
DECLARE captured timestamptz:=clock_timestamp();
BEGIN
  UPDATE finnor_os.canonical_history_coverage
     SET coverage_started_at=captured,baseline_completed_at=captured
   WHERE entity_type IN ('pe_document_link','pe_evidence_link');
END $link_history_coverage$;
ALTER TABLE finnor_os.pe_document_links ALTER COLUMN world_root_type SET NOT NULL;
ALTER TABLE finnor_os.pe_document_links ALTER COLUMN world_root_id SET NOT NULL;
ALTER TABLE finnor_os.pe_document_links ALTER COLUMN deal_id DROP NOT NULL;
ALTER TABLE finnor_os.pe_evidence_links ALTER COLUMN world_root_type SET NOT NULL;
ALTER TABLE finnor_os.pe_evidence_links ALTER COLUMN world_root_id SET NOT NULL;
ALTER TABLE finnor_os.pe_evidence_links ALTER COLUMN deal_id DROP NOT NULL;
ALTER TABLE finnor_os.pe_document_links DROP CONSTRAINT pe_document_links_entity_type_check;
ALTER TABLE finnor_os.pe_document_links ADD CONSTRAINT pe_document_links_entity_type_check CHECK (entity_type IN (
  'pe_deal','pe_request','pe_deliverable','pe_finding','pe_closing_condition','pe_closing_item',
  'pe_strategy','pe_opportunity','pe_investment_case','pe_thesis','pe_assumption','pe_decision'
));
ALTER TABLE finnor_os.pe_evidence_links DROP CONSTRAINT pe_evidence_links_entity_type_check;
ALTER TABLE finnor_os.pe_evidence_links ADD CONSTRAINT pe_evidence_links_entity_type_check CHECK (entity_type IN (
  'pe_finding','pe_deal_risk','pe_closing_condition','pe_closing_item',
  'pe_strategy','pe_opportunity','pe_investment_case','pe_thesis','pe_assumption','pe_decision'
));
ALTER TABLE finnor_os.pe_document_links ADD CONSTRAINT pe_document_links_world_root_type_check
  CHECK (world_root_type IN ('pe_strategy','pe_opportunity','pe_deal'));
ALTER TABLE finnor_os.pe_evidence_links ADD CONSTRAINT pe_evidence_links_world_root_type_check
  CHECK (world_root_type IN ('pe_strategy','pe_opportunity','pe_deal'));
CREATE INDEX pe_document_links_tenant_world_root_idx
  ON finnor_os.pe_document_links(tenant_id,world_root_type,world_root_id,created_at,id);
CREATE INDEX pe_evidence_links_tenant_world_root_idx
  ON finnor_os.pe_evidence_links(tenant_id,world_root_type,world_root_id,created_at,id);

-- Epistemic precedence depends on source_type. Evidence versions are already
-- append-only, so changing the parent classification would reinterpret old
-- evidence with hindsight. Descriptive source metadata remains Core-owned.
CREATE OR REPLACE FUNCTION finnor_os.forbid_evidence_source_type_change() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF NEW.source_type IS DISTINCT FROM OLD.source_type THEN
    RAISE EXCEPTION 'evidence source type is immutable after P1 temporal baseline';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evidence_source_type_immutable
  BEFORE UPDATE OF source_type ON finnor_os.evidence_sources
  FOR EACH ROW EXECUTE FUNCTION finnor_os.forbid_evidence_source_type_change();
REVOKE EXECUTE ON FUNCTION finnor_os.forbid_evidence_source_type_change() FROM PUBLIC;

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
    ELSE RETURN NULL;
  END CASE;
  RETURN resolved;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_deal_opportunity_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE opportunity record;
BEGIN
  IF NEW.opportunity_id IS NULL THEN RETURN NEW; END IF;
  SELECT tenant_id,target_organization_id,state INTO opportunity
    FROM finnor_os.pe_opportunities WHERE id=NEW.opportunity_id FOR UPDATE;
  IF opportunity.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR opportunity.target_organization_id IS DISTINCT FROM NEW.target_organization_id THEN
    RAISE EXCEPTION 'PE Deal promotion crosses tenant/opportunity target boundary';
  END IF;
  IF TG_OP='INSERT' AND opportunity.state<>'qualified' THEN
    RAISE EXCEPTION 'PE Deal may be created from only a qualified Opportunity';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pe_deals_opportunity_scope
  BEFORE INSERT OR UPDATE OF opportunity_id,target_organization_id,tenant_id ON finnor_os.pe_deals
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_deal_opportunity_scope();

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_world_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE
  old_body jsonb := CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  new_body jsonb := to_jsonb(NEW);
  initial_state text;
  old_state text;
  new_state text;
  mutable_columns text[];
  owner_tenant uuid;
  related record;
BEGIN
  IF finnor_os.active_tenant_vertical(NEW.tenant_id)<>'private_equity' THEN
    RAISE EXCEPTION 'PE world entity is unsupported for the tenant active vertical';
  END IF;
  IF TG_OP='INSERT' THEN
    initial_state:=CASE TG_TABLE_NAME
      WHEN 'pe_strategies' THEN 'draft'
      WHEN 'pe_opportunities' THEN 'identified'
      WHEN 'pe_investment_cases' THEN 'draft'
      WHEN 'pe_theses' THEN 'draft'
      WHEN 'pe_assumptions' THEN 'active'
      WHEN 'pe_decisions' THEN 'draft'
    END;
    IF NEW.version<>1 OR new_body->>'state' IS DISTINCT FROM initial_state THEN
      RAISE EXCEPTION 'PE % must be created in initial state % at version 1',TG_TABLE_NAME,initial_state;
    END IF;
  ELSE
    IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id THEN RAISE EXCEPTION 'PE canonical identity is immutable'; END IF;
    IF new_body->>'deal_id' IS DISTINCT FROM old_body->>'deal_id'
       OR new_body->>'investment_case_id' IS DISTINCT FROM old_body->>'investment_case_id'
       OR new_body->>'strategy_id' IS DISTINCT FROM old_body->>'strategy_id' THEN
      RAISE EXCEPTION 'PE world ownership is immutable';
    END IF;
    mutable_columns:=CASE TG_TABLE_NAME
      WHEN 'pe_strategies' THEN ARRAY['state','activated_at','retired_at','version','updated_at']
      WHEN 'pe_opportunities' THEN ARRAY['state','screening_started_at','qualified_at','promoted_at','rejected_at','rejection_reason','version','updated_at']
      WHEN 'pe_investment_cases' THEN ARRAY['state','activated_at','superseded_at','archived_at','version','updated_at']
      WHEN 'pe_theses' THEN ARRAY['state','activated_at','superseded_at','retired_at','version','updated_at']
      WHEN 'pe_assumptions' THEN ARRAY['state','superseded_at','invalidated_at','invalidation_reason','version','updated_at']
      WHEN 'pe_decisions' THEN ARRAY['state','decided_by_party_type','decided_by_party_id','decided_at','superseded_at','version','updated_at']
    END;
    IF (old_body-mutable_columns) IS DISTINCT FROM (new_body-mutable_columns) THEN
      RAISE EXCEPTION 'immutable PE world truth cannot be patched on %',TG_TABLE_NAME;
    END IF;
    IF (old_body-ARRAY['version','updated_at']) IS NOT DISTINCT FROM (new_body-ARRAY['version','updated_at']) THEN
      RAISE EXCEPTION 'PE update must change canonical business truth on %',TG_TABLE_NAME;
    END IF;
    IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'stale PE entity version'; END IF;
    NEW.updated_at:=now();
    old_state:=old_body->>'state';
    new_state:=new_body->>'state';
    IF new_state IS NOT DISTINCT FROM old_state THEN
      RAISE EXCEPTION 'PE canonical updates must perform an allowed lifecycle transition on %',TG_TABLE_NAME;
    END IF;
    IF new_state IS DISTINCT FROM old_state THEN
      CASE TG_TABLE_NAME
        WHEN 'pe_strategies' THEN
          IF NOT ((old_state='draft' AND new_state='active') OR (old_state='active' AND new_state='retired')) THEN
            RAISE EXCEPTION 'invalid Strategy transition % -> %',old_state,new_state;
          END IF;
        WHEN 'pe_opportunities' THEN
          IF NOT (
            (old_state='identified' AND new_state IN ('screening','rejected'))
            OR (old_state='screening' AND new_state IN ('qualified','rejected'))
            OR (old_state='qualified' AND new_state IN ('promoted','rejected'))
          ) THEN RAISE EXCEPTION 'invalid Opportunity transition % -> %',old_state,new_state; END IF;
          IF new_state='promoted' THEN
            IF current_setting('app.pe_opportunity_transition',true) IS DISTINCT FROM 'promote' OR NOT EXISTS (
              SELECT 1 FROM finnor_os.pe_deals d
               WHERE d.tenant_id=NEW.tenant_id AND d.opportunity_id=NEW.id
                 AND d.target_organization_id=NEW.target_organization_id
            ) THEN RAISE EXCEPTION 'Opportunity promotion requires its atomically-created signed-LOI Deal'; END IF;
          END IF;
        WHEN 'pe_investment_cases' THEN
          IF NOT (
            (old_state='draft' AND new_state IN ('active','archived'))
            OR (old_state='active' AND new_state IN ('superseded','archived'))
            OR (old_state='superseded' AND new_state='archived')
          ) THEN RAISE EXCEPTION 'invalid InvestmentCase transition % -> %',old_state,new_state; END IF;
        WHEN 'pe_theses' THEN
          IF NOT (
            (old_state='draft' AND new_state IN ('active','retired'))
            OR (old_state='active' AND new_state IN ('superseded','retired'))
            OR (old_state='superseded' AND new_state='retired')
          ) THEN RAISE EXCEPTION 'invalid Thesis transition % -> %',old_state,new_state; END IF;
        WHEN 'pe_assumptions' THEN
          IF NOT (old_state='active' AND new_state IN ('superseded','invalidated')) THEN
            RAISE EXCEPTION 'invalid Assumption transition % -> %',old_state,new_state;
          END IF;
        WHEN 'pe_decisions' THEN
          IF old_state='draft' AND new_state='final' THEN NULL;
          ELSIF old_state='final' AND new_state='superseded'
            AND current_setting('app.pe_decision_transition',true)='supersede'
            AND EXISTS (SELECT 1 FROM finnor_os.pe_decisions replacement
              WHERE replacement.tenant_id=NEW.tenant_id
                AND replacement.supersedes_decision_id=NEW.id
                AND replacement.state='final') THEN NULL;
          ELSE RAISE EXCEPTION 'invalid or unauthorized Decision transition % -> %',old_state,new_state;
          END IF;
      END CASE;
    END IF;
  END IF;

  IF TG_TABLE_NAME='pe_strategies' THEN NULL;
  ELSIF TG_TABLE_NAME='pe_opportunities' THEN
    SELECT tenant_id,state INTO related FROM finnor_os.pe_strategies WHERE id=NEW.strategy_id;
    IF related.tenant_id IS DISTINCT FROM NEW.tenant_id OR related.state='retired' THEN
      RAISE EXCEPTION 'Opportunity Strategy crosses tenant boundary, is missing, or retired';
    END IF;
    IF finnor_os.pe_party_tenant('external_organization',NEW.target_organization_id) IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Opportunity target crosses tenant boundary, is missing, or inactive';
    END IF;
  ELSE
    SELECT tenant_id,status INTO related FROM finnor_os.pe_deals WHERE id=NEW.deal_id FOR UPDATE;
    IF related.tenant_id IS DISTINCT FROM NEW.tenant_id OR related.status<>'active' THEN
      RAISE EXCEPTION 'PE world child crosses tenant/Deal boundary or Deal is terminal';
    END IF;
    IF TG_TABLE_NAME<>'pe_investment_cases' THEN
      SELECT tenant_id,deal_id INTO related FROM finnor_os.pe_investment_cases WHERE id=NEW.investment_case_id;
      IF related.tenant_id IS DISTINCT FROM NEW.tenant_id OR related.deal_id IS DISTINCT FROM NEW.deal_id THEN
        RAISE EXCEPTION 'PE world child crosses InvestmentCase boundary or case is missing';
      END IF;
    END IF;
  END IF;

  IF TG_TABLE_NAME='pe_assumptions' AND new_body->>'supersedes_assumption_id' IS NOT NULL THEN
    SELECT tenant_id,deal_id,investment_case_id,state INTO related
      FROM finnor_os.pe_assumptions WHERE id=(new_body->>'supersedes_assumption_id')::uuid;
    IF related.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR related.deal_id::text IS DISTINCT FROM new_body->>'deal_id'
       OR related.investment_case_id::text IS DISTINCT FROM new_body->>'investment_case_id'
       OR related.state<>'superseded' THEN
      RAISE EXCEPTION 'Assumption revision crosses world boundary or prior revision is not superseded';
    END IF;
  END IF;
  IF TG_TABLE_NAME='pe_decisions' THEN
    IF NEW.supersedes_decision_id IS NOT NULL THEN
      SELECT tenant_id,deal_id,investment_case_id,state INTO related
        FROM finnor_os.pe_decisions WHERE id=NEW.supersedes_decision_id;
      IF related.tenant_id IS DISTINCT FROM NEW.tenant_id OR related.deal_id IS DISTINCT FROM NEW.deal_id
         OR related.investment_case_id IS DISTINCT FROM NEW.investment_case_id OR related.state<>'final' THEN
        RAISE EXCEPTION 'Decision supersession crosses world boundary or source Decision is not final';
      END IF;
    END IF;
    IF NEW.state IN ('final','superseded') THEN
      owner_tenant:=finnor_os.pe_party_tenant(NEW.decided_by_party_type,NEW.decided_by_party_id);
      IF owner_tenant IS DISTINCT FROM NEW.tenant_id THEN
        RAISE EXCEPTION 'Decision finalization party crosses tenant boundary, is missing, or inactive';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DO $world_triggers$
DECLARE table_name text; entity_type text;
BEGIN
  FOR table_name,entity_type IN SELECT * FROM (VALUES
    ('pe_strategies','pe_strategy'),
    ('pe_opportunities','pe_opportunity'),
    ('pe_investment_cases','pe_investment_case'),
    ('pe_theses','pe_thesis'),
    ('pe_assumptions','pe_assumption'),
    ('pe_decisions','pe_decision')
  ) AS owners(table_name,entity_type)
  LOOP
    EXECUTE format('CREATE TRIGGER pe_world_mutation BEFORE INSERT OR UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_world_mutation()',table_name);
    EXECUTE format('CREATE TRIGGER canonical_history AFTER INSERT OR UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.append_canonical_entity_version(%L)',table_name,entity_type);
  END LOOP;
END $world_triggers$;

-- An Assumption marked superseded is truthful only when the same transaction
-- commits its replacement row. Deferred evaluation permits the old-row update
-- to precede the replacement insert while rejecting orphan supersession.
CREATE OR REPLACE FUNCTION finnor_os.assert_superseded_assumption_has_replacement() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF NEW.state='superseded' AND NOT EXISTS (
    SELECT 1 FROM finnor_os.pe_assumptions replacement
     WHERE replacement.tenant_id=NEW.tenant_id
       AND replacement.supersedes_assumption_id=NEW.id
  ) THEN
    RAISE EXCEPTION 'superseded Assumption requires a committed replacement revision';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER pe_assumption_replacement_required
  AFTER INSERT OR UPDATE ON finnor_os.pe_assumptions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_superseded_assumption_has_replacement();
REVOKE EXECUTE ON FUNCTION finnor_os.assert_superseded_assumption_has_replacement() FROM PUBLIC;

DO $coverage$
DECLARE captured timestamptz:=clock_timestamp();
BEGIN
  INSERT INTO finnor_os.canonical_history_coverage(entity_type,source_table,vertical_key,coverage_started_at,baseline_completed_at)
  VALUES
    ('pe_strategy','pe_strategies','private_equity',captured,captured),
    ('pe_opportunity','pe_opportunities','private_equity',captured,captured),
    ('pe_investment_case','pe_investment_cases','private_equity',captured,captured),
    ('pe_thesis','pe_theses','private_equity',captured,captured),
    ('pe_assumption','pe_assumptions','private_equity',captured,captured),
    ('pe_decision','pe_decisions','private_equity',captured,captured);
END $coverage$;

CREATE TRIGGER pe_graph_touch AFTER INSERT OR UPDATE ON finnor_os.pe_investment_cases
  FOR EACH ROW EXECUTE FUNCTION finnor_os.touch_pe_deal_graph();
CREATE TRIGGER pe_graph_touch AFTER INSERT OR UPDATE ON finnor_os.pe_theses
  FOR EACH ROW EXECUTE FUNCTION finnor_os.touch_pe_deal_graph();
CREATE TRIGGER pe_graph_touch AFTER INSERT OR UPDATE ON finnor_os.pe_assumptions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.touch_pe_deal_graph();
CREATE TRIGGER pe_graph_touch AFTER INSERT OR UPDATE ON finnor_os.pe_decisions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.touch_pe_deal_graph();

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_world_link_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE resolved record; superseded record; root_tenant uuid; source_row record; version_row record;
BEGIN
  SELECT * INTO resolved FROM finnor_os.pe_entity_world_root(NEW.entity_type,NEW.entity_id);
  IF NOT FOUND OR resolved.root_type IS DISTINCT FROM NEW.world_root_type
     OR resolved.root_id IS DISTINCT FROM NEW.world_root_id THEN
    RAISE EXCEPTION 'PE link endpoint crosses world-root boundary or is missing';
  END IF;
  root_tenant:=finnor_os.canonical_entity_tenant(NEW.world_root_type,NEW.world_root_id);
  IF root_tenant IS DISTINCT FROM NEW.tenant_id
     OR finnor_os.canonical_entity_tenant(NEW.entity_type,NEW.entity_id) IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'PE link endpoint/root crosses tenant boundary or is missing';
  END IF;
  IF (NEW.world_root_type='pe_deal' AND NEW.deal_id IS DISTINCT FROM resolved.deal_id)
     OR (NEW.world_root_type<>'pe_deal' AND NEW.deal_id IS NOT NULL) THEN
    RAISE EXCEPTION 'PE link Deal scope does not match its world root';
  END IF;
  IF TG_TABLE_NAME='pe_document_links' THEN
    IF finnor_os.canonical_entity_tenant('document',NEW.document_id) IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'PE Document link crosses tenant boundary or Document is missing';
    END IF;
    IF NEW.supersedes_link_id IS NOT NULL THEN
      SELECT tenant_id,world_root_type,world_root_id,entity_type,entity_id INTO superseded
        FROM finnor_os.pe_document_links WHERE id=NEW.supersedes_link_id;
      IF superseded.tenant_id IS DISTINCT FROM NEW.tenant_id
         OR superseded.world_root_type IS DISTINCT FROM NEW.world_root_type
         OR superseded.world_root_id IS DISTINCT FROM NEW.world_root_id
         OR superseded.entity_type IS DISTINCT FROM NEW.entity_type
         OR superseded.entity_id IS DISTINCT FROM NEW.entity_id THEN
        RAISE EXCEPTION 'superseded PE Document link crosses tenant, root, or endpoint boundary';
      END IF;
    END IF;
  ELSE
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
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER pe_document_links_scope BEFORE INSERT OR UPDATE ON finnor_os.pe_document_links
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_world_link_scope();
CREATE TRIGGER pe_evidence_links_scope BEFORE INSERT OR UPDATE ON finnor_os.pe_evidence_links
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_world_link_scope();
CREATE TRIGGER pe_version_guard BEFORE UPDATE ON finnor_os.pe_document_links
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_versioned_update();
CREATE TRIGGER pe_version_guard BEFORE UPDATE ON finnor_os.pe_evidence_links
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_versioned_update();
CREATE TRIGGER pe_graph_touch AFTER INSERT OR UPDATE ON finnor_os.pe_document_links
  FOR EACH ROW EXECUTE FUNCTION finnor_os.touch_pe_deal_graph();
CREATE TRIGGER pe_graph_touch AFTER INSERT OR UPDATE ON finnor_os.pe_evidence_links
  FOR EACH ROW EXECUTE FUNCTION finnor_os.touch_pe_deal_graph();

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_decision_effect_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE decision_row record; effect_tenant uuid;
BEGIN
  SELECT tenant_id,state INTO decision_row FROM finnor_os.pe_decisions WHERE id=NEW.decision_id;
  IF decision_row.tenant_id IS DISTINCT FROM NEW.tenant_id OR decision_row.state='draft' THEN
    RAISE EXCEPTION 'Decision effect requires a final tenant-owned semantic Decision';
  END IF;
  effect_tenant:=finnor_os.canonical_entity_tenant(NEW.effect_type,NEW.effect_id);
  IF effect_tenant IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'Decision effect crosses tenant boundary or is missing';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pe_decision_effect_scope BEFORE INSERT ON finnor_os.pe_decision_effect_links
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_decision_effect_scope();

-- New entities use the same existing Core BusinessEvent timeline and trigger
-- coupling as the signed-LOI execution graph.
CREATE OR REPLACE FUNCTION finnor_os.append_pe_world_business_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE old_body jsonb:=CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
DECLARE new_body jsonb:=to_jsonb(NEW); from_state text; to_state text;
DECLARE entity_kind text:=TG_ARGV[0]; event_name text; actor text; event_source text;
BEGIN
  from_state:=old_body->>'state';
  to_state:=new_body->>'state';
  IF TG_OP='INSERT' THEN event_name:=entity_kind||'_created';
  ELSIF to_state IS DISTINCT FROM from_state THEN event_name:=entity_kind||'_'||to_state;
  ELSE RETURN NEW;
  END IF;
  actor:=coalesce(nullif(current_setting('app.pe_actor',true),''),nullif(current_setting('app.user_id',true),''),new_body->>'created_by');
  event_source:=coalesce(nullif(current_setting('app.pe_source',true),''),new_body->>'source_system','@finnor/private-equity');
  INSERT INTO finnor_os.business_events(tenant_id,entity_type,entity_id,event_type,payload,source)
  VALUES (NEW.tenant_id,entity_kind,NEW.id,event_name,
    jsonb_strip_nulls(jsonb_build_object(
      'dealId',new_body->>'deal_id','strategyId',new_body->>'strategy_id',
      'investmentCaseId',new_body->>'investment_case_id','from',from_state,'to',to_state,
      'actor',actor,'version',(new_body->>'version')::integer,'sourceRef',new_body->>'external_id',
      'supersedesId',coalesce(new_body->>'supersedes_assumption_id',new_body->>'supersedes_decision_id')
    )),event_source);
  RETURN NEW;
END $$;

DO $world_events$
DECLARE table_name text; entity_type text;
BEGIN
  FOR table_name,entity_type IN SELECT * FROM (VALUES
    ('pe_strategies','pe_strategy'),('pe_opportunities','pe_opportunity'),
    ('pe_investment_cases','pe_investment_case'),('pe_theses','pe_thesis'),
    ('pe_assumptions','pe_assumption'),('pe_decisions','pe_decision')
  ) AS owners(table_name,entity_type)
  LOOP
    EXECUTE format('CREATE TRIGGER pe_business_history AFTER INSERT OR UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.append_pe_world_business_event(%L)',table_name,entity_type);
  END LOOP;
END $world_events$;

INSERT INTO finnor_os.canonical_truth_registry
  (entity_type,vertical_key,source_table,writable_owner,mutation_boundary,work_attachable)
VALUES
  ('pe_strategy','private_equity','pe_strategies','@finnor/private-equity','createStrategy / transitionStrategy',false),
  ('pe_opportunity','private_equity','pe_opportunities','@finnor/private-equity','createOpportunity / transitionOpportunity / promoteOpportunityToDeal',true),
  ('pe_investment_case','private_equity','pe_investment_cases','@finnor/private-equity','createInvestmentCase / activateInvestmentCase / supersedeInvestmentCase / archiveInvestmentCase',true),
  ('pe_thesis','private_equity','pe_theses','@finnor/private-equity','createThesis / transitionThesis',true),
  ('pe_assumption','private_equity','pe_assumptions','@finnor/private-equity','createAssumption / reviseAssumption / invalidateAssumption',true),
  ('pe_decision','private_equity','pe_decisions','@finnor/private-equity','recordDecision / finalizeDecision / supersedeDecision',true);

CREATE OR REPLACE FUNCTION finnor_os.assert_p2_task_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE resolved uuid; world record; registered boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM finnor_os.canonical_truth_registry WHERE entity_type=NEW.subject_type) INTO registered;
  IF registered THEN
    IF NOT finnor_os.canonical_entity_available(NEW.tenant_id,NEW.subject_type) THEN
      RAISE EXCEPTION 'Task subject type is unsupported for tenant active vertical';
    END IF;
    resolved:=finnor_os.canonical_entity_tenant(NEW.subject_type,NEW.subject_id);
    IF resolved IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Task subject crosses tenant boundary or is missing'; END IF;
    IF NEW.subject_type LIKE 'pe\_%' ESCAPE '\' THEN
      SELECT * INTO world FROM finnor_os.pe_entity_world_root(NEW.subject_type,NEW.subject_id);
      IF NOT FOUND THEN RAISE EXCEPTION 'Task PE subject has no canonical world root'; END IF;
      IF world.root_type='pe_deal' AND NOT EXISTS (
        SELECT 1 FROM finnor_os.pe_deals d WHERE d.tenant_id=NEW.tenant_id AND d.id=world.deal_id AND d.status='active'
      ) THEN RAISE EXCEPTION 'Task cannot be added to a closed or terminated PE Deal graph'; END IF;
      IF world.root_type='pe_strategy' AND NOT EXISTS (
        SELECT 1 FROM finnor_os.pe_strategies s WHERE s.tenant_id=NEW.tenant_id AND s.id=world.root_id AND s.state<>'retired'
      ) THEN RAISE EXCEPTION 'Task cannot be added to a retired PE Strategy'; END IF;
      IF world.root_type='pe_opportunity' AND NOT EXISTS (
        SELECT 1 FROM finnor_os.pe_opportunities o WHERE o.tenant_id=NEW.tenant_id AND o.id=world.root_id AND o.state NOT IN ('promoted','rejected')
      ) THEN RAISE EXCEPTION 'Task cannot be added to a terminal PE Opportunity'; END IF;
    END IF;
  ELSIF NEW.subject_type LIKE 'pe\_%' ESCAPE '\' OR NEW.source_domain_action_id IS NOT NULL THEN
    RAISE EXCEPTION 'Task subject is not a registered canonical entity';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE finnor_os.work_query_executions DROP CONSTRAINT work_query_executions_intent_check;
ALTER TABLE finnor_os.work_query_executions ADD CONSTRAINT work_query_executions_intent_check CHECK (intent IN (
  'customer_lookup','customer_cohort','schedule_range','money_summary','work_list',
  'inventory_status','agent_activity','business_state','company_context',
  'party_lookup','party_context','team_roster','party_availability',
  'deal_context','deal_workstreams','open_requests','open_findings','open_deal_risks',
  'critical_dependencies','closing_readiness','pe_world_state'
));

DO $rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'pe_strategies','pe_opportunities','pe_investment_cases','pe_theses','pe_assumptions',
    'pe_decisions','pe_decision_effect_links'
  ] LOOP
    EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON finnor_os.%I USING (tenant_id=finnor_os.request_tenant_id()) WITH CHECK (tenant_id=finnor_os.request_tenant_id())',table_name);
  END LOOP;
END $rls$;

REVOKE EXECUTE ON FUNCTION finnor_os.pe_entity_world_root(text,uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.assert_pe_world_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.assert_pe_deal_opportunity_scope() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.assert_pe_world_link_scope() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.assert_pe_decision_effect_scope() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.append_pe_world_business_event() FROM PUBLIC;

DO $grants$
DECLARE table_name text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
    FOREACH table_name IN ARRAY ARRAY[
      'pe_strategies','pe_opportunities','pe_investment_cases','pe_theses','pe_assumptions','pe_decisions'
    ] LOOP
      EXECUTE format('GRANT SELECT,INSERT,UPDATE ON finnor_os.%I TO finnor_app',table_name);
      EXECUTE format('REVOKE DELETE ON finnor_os.%I FROM finnor_app',table_name);
    END LOOP;
    GRANT SELECT,INSERT ON finnor_os.pe_decision_effect_links TO finnor_app;
    REVOKE UPDATE,DELETE ON finnor_os.pe_decision_effect_links FROM finnor_app;
    GRANT EXECUTE ON FUNCTION finnor_os.pe_entity_world_root(text,uuid) TO finnor_app;
  END IF;
END $grants$;

COMMENT ON TABLE finnor_os.pe_strategies IS 'PE-owned investment mandate/criteria; no duplicated Core owner.';
COMMENT ON TABLE finnor_os.pe_opportunities IS 'Pre-LOI PE target truth; promotion atomically creates exactly one signed-LOI Deal.';
COMMENT ON TABLE finnor_os.pe_investment_cases IS 'PE investment reasoning container; partial unique index permits one active case per Deal.';
COMMENT ON TABLE finnor_os.pe_theses IS 'Structural PE thesis lifecycle; epistemic support remains exclusively in the Core Epistemic Runtime.';
COMMENT ON TABLE finnor_os.pe_assumptions IS 'Typed, revision-preserving InvestmentCase assumption; no mandatory Thesis ownership.';
COMMENT ON TABLE finnor_os.pe_decisions IS 'Semantic PE decision, distinct from authority decisions and execution DecisionReceipts.';
