-- Scope 4: institutional Private Equity Digital Twin.
--
-- Canonical company/person identity remains Core-owned in external_organizations /
-- external_contacts.  Company Brain remains a read projection.  These tables own
-- only PE-specific identities, observed business facts, and exact typed relations.
-- Underwriting continues to own hypothetical calculations.

-- Exact tenant/evidence pairs are used by every consequential fact below.  Public
-- evidence is permitted, but a tenant row may never cite another tenant's source.
CREATE OR REPLACE FUNCTION finnor_os.assert_pe_twin_evidence(
  p_tenant uuid,p_source uuid,p_version uuid,p_label text
) RETURNS void
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,finnor_os AS $$
DECLARE source_row record; version_row record;
BEGIN
  IF p_source IS NULL OR p_version IS NULL THEN
    RAISE EXCEPTION '% requires an exact EvidenceVersion',p_label;
  END IF;
  SELECT id,scope,tenant_id INTO source_row FROM finnor_os.evidence_sources WHERE id=p_source;
  SELECT id,source_id,scope,tenant_id INTO version_row FROM finnor_os.evidence_source_versions WHERE id=p_version;
  IF source_row.id IS NULL OR version_row.id IS NULL OR version_row.source_id<>p_source THEN
    RAISE EXCEPTION '% evidence source/version pair is missing or inconsistent',p_label;
  END IF;
  IF source_row.scope='tenant' AND (source_row.tenant_id IS DISTINCT FROM p_tenant OR version_row.tenant_id IS DISTINCT FROM p_tenant) THEN
    RAISE EXCEPTION '% evidence crosses tenant boundary',p_label;
  END IF;
  IF source_row.scope='public' AND (source_row.tenant_id IS NOT NULL OR version_row.tenant_id IS NOT NULL) THEN
    RAISE EXCEPTION '% public evidence has an invalid tenant binding',p_label;
  END IF;
END $$;

CREATE TABLE finnor_os.pe_funds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  name text NOT NULL CHECK (btrim(name)<>''),
  legal_name text,
  vintage_year integer CHECK (vintage_year IS NULL OR vintage_year BETWEEN 1900 AND 2200),
  base_currency text CHECK (base_currency IS NULL OR base_currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('forming','active','harvesting','liquidated')),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''), external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''), observed_at timestamptz,
  valid_from timestamptz, valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_funds_tenant_id_id_key UNIQUE (tenant_id,id),
  CONSTRAINT pe_funds_source_identity_key UNIQUE (tenant_id,source_system,external_id),
  CONSTRAINT pe_funds_valid_range_check CHECK (valid_to IS NULL OR (valid_from IS NOT NULL AND valid_to>valid_from))
);
CREATE INDEX pe_funds_tenant_status_name_idx ON finnor_os.pe_funds(tenant_id,status,lower(name),id);

CREATE TABLE finnor_os.pe_vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  name text NOT NULL CHECK (btrim(name)<>''), legal_name text,
  vehicle_type text NOT NULL CHECK (vehicle_type IN ('main','feeder','parallel','co_invest','blocker','continuation','other')),
  jurisdiction text, status text NOT NULL DEFAULT 'active' CHECK (status IN ('forming','active','harvesting','liquidated')),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  source_system text NOT NULL CHECK (btrim(source_system)<>''), external_id text,
  created_by text NOT NULL CHECK (btrim(created_by)<>''), observed_at timestamptz,
  valid_from timestamptz, valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_vehicles_tenant_id_id_key UNIQUE (tenant_id,id),
  CONSTRAINT pe_vehicles_source_identity_key UNIQUE (tenant_id,source_system,external_id),
  CONSTRAINT pe_vehicles_valid_range_check CHECK (valid_to IS NULL OR (valid_from IS NOT NULL AND valid_to>valid_from))
);
CREATE INDEX pe_vehicles_tenant_status_name_idx ON finnor_os.pe_vehicles(tenant_id,status,lower(name),id);

CREATE TABLE finnor_os.pe_fund_vehicle_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  fund_id uuid NOT NULL, vehicle_id uuid NOT NULL,
  relationship_kind text NOT NULL CHECK (relationship_kind IN ('master','feeder','parallel','co_invest','blocker','continuation','other')),
  valid_from timestamptz NOT NULL, valid_to timestamptz,
  completeness text NOT NULL DEFAULT 'partial' CHECK (completeness IN ('complete','partial','unknown','conflicting','unavailable_before_history_baseline')),
  evidence_source_id uuid NOT NULL REFERENCES finnor_os.evidence_sources(id),
  evidence_version_id uuid NOT NULL REFERENCES finnor_os.evidence_source_versions(id),
  version integer NOT NULL DEFAULT 1 CHECK(version>=1), superseded_at timestamptz,
  source_system text NOT NULL CHECK(btrim(source_system)<>''), external_id text, created_by text NOT NULL CHECK(btrim(created_by)<>''), observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_fund_vehicle_links_tenant_id_id_key UNIQUE(tenant_id,id),
  CONSTRAINT pe_fund_vehicle_links_fund_fkey FOREIGN KEY(tenant_id,fund_id) REFERENCES finnor_os.pe_funds(tenant_id,id),
  CONSTRAINT pe_fund_vehicle_links_vehicle_fkey FOREIGN KEY(tenant_id,vehicle_id) REFERENCES finnor_os.pe_vehicles(tenant_id,id),
  CONSTRAINT pe_fund_vehicle_links_valid_check CHECK(valid_to IS NULL OR valid_to>valid_from)
);
CREATE UNIQUE INDEX pe_fund_vehicle_links_current_idx ON finnor_os.pe_fund_vehicle_links(fund_id,vehicle_id,relationship_kind) WHERE superseded_at IS NULL AND valid_to IS NULL;
CREATE INDEX pe_fund_vehicle_links_fund_time_idx ON finnor_os.pe_fund_vehicle_links(tenant_id,fund_id,valid_from,valid_to,id);
CREATE INDEX pe_fund_vehicle_links_vehicle_time_idx ON finnor_os.pe_fund_vehicle_links(tenant_id,vehicle_id,valid_from,valid_to,id);

-- A mandate links a Fund or Vehicle to an existing Strategy.  It is one semantic
-- relation with an explicit principal discriminator, not a generic graph edge.
CREATE TABLE finnor_os.pe_strategy_mandates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  principal_type text NOT NULL CHECK(principal_type IN ('pe_fund','pe_vehicle')), principal_id uuid NOT NULL,
  strategy_id uuid NOT NULL, valid_from timestamptz NOT NULL, valid_to timestamptz,
  completeness text NOT NULL DEFAULT 'partial' CHECK (completeness IN ('complete','partial','unknown','conflicting','unavailable_before_history_baseline')),
  evidence_source_id uuid NOT NULL REFERENCES finnor_os.evidence_sources(id), evidence_version_id uuid NOT NULL REFERENCES finnor_os.evidence_source_versions(id),
  version integer NOT NULL DEFAULT 1 CHECK(version>=1), superseded_at timestamptz,
  source_system text NOT NULL CHECK(btrim(source_system)<>''), external_id text, created_by text NOT NULL CHECK(btrim(created_by)<>''), observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_strategy_mandates_tenant_id_id_key UNIQUE(tenant_id,id),
  CONSTRAINT pe_strategy_mandates_strategy_fkey FOREIGN KEY(tenant_id,strategy_id) REFERENCES finnor_os.pe_strategies(tenant_id,id),
  CONSTRAINT pe_strategy_mandates_valid_check CHECK(valid_to IS NULL OR valid_to>valid_from)
);
CREATE UNIQUE INDEX pe_strategy_mandates_current_idx ON finnor_os.pe_strategy_mandates(principal_type,principal_id,strategy_id) WHERE superseded_at IS NULL AND valid_to IS NULL;
CREATE INDEX pe_strategy_mandates_principal_time_idx ON finnor_os.pe_strategy_mandates(tenant_id,principal_type,principal_id,valid_from,valid_to,id);

CREATE TABLE finnor_os.pe_portfolio_holdings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  fund_id uuid, vehicle_id uuid, company_id uuid NOT NULL, origin_deal_id uuid NOT NULL,
  holding_status text NOT NULL DEFAULT 'active' CHECK(holding_status IN ('active','partially_realized','exited')),
  entry_date date NOT NULL, exit_date date,
  completeness text NOT NULL DEFAULT 'partial' CHECK (completeness IN ('complete','partial','unknown','conflicting','unavailable_before_history_baseline')),
  evidence_source_id uuid NOT NULL REFERENCES finnor_os.evidence_sources(id), evidence_version_id uuid NOT NULL REFERENCES finnor_os.evidence_source_versions(id),
  version integer NOT NULL DEFAULT 1 CHECK(version>=1),
  source_system text NOT NULL CHECK(btrim(source_system)<>''), external_id text, created_by text NOT NULL CHECK(btrim(created_by)<>''), observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_portfolio_holdings_tenant_id_id_key UNIQUE(tenant_id,id),
  CONSTRAINT pe_portfolio_holdings_investor_check CHECK((fund_id IS NULL)<>(vehicle_id IS NULL)),
  CONSTRAINT pe_portfolio_holdings_fund_fkey FOREIGN KEY(tenant_id,fund_id) REFERENCES finnor_os.pe_funds(tenant_id,id),
  CONSTRAINT pe_portfolio_holdings_vehicle_fkey FOREIGN KEY(tenant_id,vehicle_id) REFERENCES finnor_os.pe_vehicles(tenant_id,id),
  CONSTRAINT pe_portfolio_holdings_company_fkey FOREIGN KEY(tenant_id,company_id) REFERENCES finnor_os.external_organizations(tenant_id,id),
  CONSTRAINT pe_portfolio_holdings_deal_fkey FOREIGN KEY(tenant_id,origin_deal_id) REFERENCES finnor_os.pe_deals(tenant_id,id),
  CONSTRAINT pe_portfolio_holdings_dates_check CHECK(exit_date IS NULL OR exit_date>=entry_date),
  CONSTRAINT pe_portfolio_holdings_state_check CHECK((holding_status='exited')=(exit_date IS NOT NULL))
);
CREATE UNIQUE INDEX pe_portfolio_holdings_lineage_idx ON finnor_os.pe_portfolio_holdings(origin_deal_id,coalesce(fund_id,vehicle_id));
CREATE INDEX pe_portfolio_holdings_company_idx ON finnor_os.pe_portfolio_holdings(tenant_id,company_id,holding_status,entry_date,id);
CREATE INDEX pe_portfolio_holdings_fund_idx ON finnor_os.pe_portfolio_holdings(tenant_id,fund_id,holding_status,id) WHERE fund_id IS NOT NULL;
CREATE INDEX pe_portfolio_holdings_vehicle_idx ON finnor_os.pe_portfolio_holdings(tenant_id,vehicle_id,holding_status,id) WHERE vehicle_id IS NOT NULL;

CREATE TABLE finnor_os.pe_company_hierarchy_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  parent_company_id uuid NOT NULL, child_company_id uuid NOT NULL,
  relationship_kind text NOT NULL CHECK(relationship_kind IN ('parent_subsidiary','holding_operating')),
  valid_from timestamptz NOT NULL, valid_to timestamptz,
  completeness text NOT NULL DEFAULT 'partial' CHECK (completeness IN ('complete','partial','unknown','conflicting','unavailable_before_history_baseline')),
  evidence_source_id uuid NOT NULL REFERENCES finnor_os.evidence_sources(id), evidence_version_id uuid NOT NULL REFERENCES finnor_os.evidence_source_versions(id),
  version integer NOT NULL DEFAULT 1 CHECK(version>=1), superseded_at timestamptz,
  source_system text NOT NULL CHECK(btrim(source_system)<>''), external_id text, created_by text NOT NULL CHECK(btrim(created_by)<>''), observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_company_hierarchy_tenant_id_id_key UNIQUE(tenant_id,id),
  CONSTRAINT pe_company_hierarchy_parent_fkey FOREIGN KEY(tenant_id,parent_company_id) REFERENCES finnor_os.external_organizations(tenant_id,id),
  CONSTRAINT pe_company_hierarchy_child_fkey FOREIGN KEY(tenant_id,child_company_id) REFERENCES finnor_os.external_organizations(tenant_id,id),
  CONSTRAINT pe_company_hierarchy_distinct_check CHECK(parent_company_id<>child_company_id),
  CONSTRAINT pe_company_hierarchy_valid_check CHECK(valid_to IS NULL OR valid_to>valid_from)
);
CREATE UNIQUE INDEX pe_company_hierarchy_current_idx ON finnor_os.pe_company_hierarchy_relationships(parent_company_id,child_company_id,relationship_kind) WHERE superseded_at IS NULL AND valid_to IS NULL;
CREATE INDEX pe_company_hierarchy_parent_time_idx ON finnor_os.pe_company_hierarchy_relationships(tenant_id,parent_company_id,valid_from,valid_to,id);
CREATE INDEX pe_company_hierarchy_child_time_idx ON finnor_os.pe_company_hierarchy_relationships(tenant_id,child_company_id,valid_from,valid_to,id);

CREATE TABLE finnor_os.pe_company_party_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  company_id uuid NOT NULL, party_type text NOT NULL CHECK(party_type IN ('external_organization','external_contact')), party_id uuid NOT NULL,
  role text NOT NULL CHECK(role IN ('sponsor','advisor')), role_detail text,
  valid_from timestamptz NOT NULL, valid_to timestamptz,
  completeness text NOT NULL DEFAULT 'partial' CHECK (completeness IN ('complete','partial','unknown','conflicting','unavailable_before_history_baseline')),
  evidence_source_id uuid NOT NULL REFERENCES finnor_os.evidence_sources(id), evidence_version_id uuid NOT NULL REFERENCES finnor_os.evidence_source_versions(id),
  version integer NOT NULL DEFAULT 1 CHECK(version>=1), superseded_at timestamptz,
  source_system text NOT NULL CHECK(btrim(source_system)<>''), external_id text, created_by text NOT NULL CHECK(btrim(created_by)<>''), observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_company_party_roles_tenant_id_id_key UNIQUE(tenant_id,id),
  CONSTRAINT pe_company_party_roles_company_fkey FOREIGN KEY(tenant_id,company_id) REFERENCES finnor_os.external_organizations(tenant_id,id),
  CONSTRAINT pe_company_party_roles_valid_check CHECK(valid_to IS NULL OR valid_to>valid_from)
);
CREATE UNIQUE INDEX pe_company_party_roles_current_idx ON finnor_os.pe_company_party_roles(company_id,party_type,party_id,role,coalesce(role_detail,'')) WHERE superseded_at IS NULL AND valid_to IS NULL;
CREATE INDEX pe_company_party_roles_company_time_idx ON finnor_os.pe_company_party_roles(tenant_id,company_id,role,valid_from,valid_to,id);

CREATE TABLE finnor_os.pe_securities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  issuer_company_id uuid NOT NULL, security_key text NOT NULL CHECK(btrim(security_key)<>''),
  security_type text NOT NULL CHECK(security_type IN ('common_equity','preferred_equity','convertible','option','warrant','other')),
  name text NOT NULL CHECK(btrim(name)<>''), currency_code text CHECK(currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  seniority integer CHECK(seniority IS NULL OR seniority>=0), valid_from timestamptz NOT NULL, valid_to timestamptz,
  completeness text NOT NULL DEFAULT 'partial' CHECK (completeness IN ('complete','partial','unknown','conflicting','unavailable_before_history_baseline')),
  evidence_source_id uuid NOT NULL REFERENCES finnor_os.evidence_sources(id), evidence_version_id uuid NOT NULL REFERENCES finnor_os.evidence_source_versions(id),
  version integer NOT NULL DEFAULT 1 CHECK(version>=1), superseded_at timestamptz,
  source_system text NOT NULL CHECK(btrim(source_system)<>''), external_id text, created_by text NOT NULL CHECK(btrim(created_by)<>''), observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_securities_tenant_id_id_key UNIQUE(tenant_id,id),
  CONSTRAINT pe_securities_issuer_fkey FOREIGN KEY(tenant_id,issuer_company_id) REFERENCES finnor_os.external_organizations(tenant_id,id),
  CONSTRAINT pe_securities_valid_check CHECK(valid_to IS NULL OR valid_to>valid_from)
);
CREATE UNIQUE INDEX pe_securities_current_key_idx ON finnor_os.pe_securities(issuer_company_id,lower(security_key)) WHERE superseded_at IS NULL AND valid_to IS NULL;
CREATE INDEX pe_securities_issuer_time_idx ON finnor_os.pe_securities(tenant_id,issuer_company_id,valid_from,valid_to,id);

CREATE TABLE finnor_os.pe_debt_facilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  borrower_company_id uuid NOT NULL, facility_key text NOT NULL CHECK(btrim(facility_key)<>''), name text NOT NULL CHECK(btrim(name)<>''),
  facility_type text NOT NULL CHECK(facility_type IN ('revolver','term_loan','delayed_draw','mezzanine','unitranche','notes','other')),
  committed_amount numeric(38,12) CHECK(committed_amount IS NULL OR committed_amount>=0), currency_code text CHECK(currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  maturity_date date, status text NOT NULL DEFAULT 'active' CHECK(status IN ('committed','active','repaid','cancelled','defaulted')),
  valid_from timestamptz NOT NULL, valid_to timestamptz,
  completeness text NOT NULL DEFAULT 'partial' CHECK (completeness IN ('complete','partial','unknown','conflicting','unavailable_before_history_baseline')),
  evidence_source_id uuid NOT NULL REFERENCES finnor_os.evidence_sources(id), evidence_version_id uuid NOT NULL REFERENCES finnor_os.evidence_source_versions(id),
  version integer NOT NULL DEFAULT 1 CHECK(version>=1), superseded_at timestamptz,
  source_system text NOT NULL CHECK(btrim(source_system)<>''), external_id text, created_by text NOT NULL CHECK(btrim(created_by)<>''), observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_debt_facilities_tenant_id_id_key UNIQUE(tenant_id,id),
  CONSTRAINT pe_debt_facilities_borrower_fkey FOREIGN KEY(tenant_id,borrower_company_id) REFERENCES finnor_os.external_organizations(tenant_id,id),
  CONSTRAINT pe_debt_facilities_amount_currency_check CHECK((committed_amount IS NULL)=(currency_code IS NULL)),
  CONSTRAINT pe_debt_facilities_valid_check CHECK(valid_to IS NULL OR valid_to>valid_from)
);
CREATE UNIQUE INDEX pe_debt_facilities_current_key_idx ON finnor_os.pe_debt_facilities(borrower_company_id,lower(facility_key)) WHERE superseded_at IS NULL AND valid_to IS NULL;
CREATE INDEX pe_debt_facilities_borrower_time_idx ON finnor_os.pe_debt_facilities(tenant_id,borrower_company_id,valid_from,valid_to,id);

CREATE TABLE finnor_os.pe_debt_facility_lenders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  debt_facility_id uuid NOT NULL, lender_party_type text NOT NULL CHECK(lender_party_type IN ('external_organization','external_contact')), lender_party_id uuid NOT NULL,
  lender_role text NOT NULL CHECK(lender_role IN ('agent','arranger','lender','administrative_agent','other')),
  commitment_amount numeric(38,12) CHECK(commitment_amount IS NULL OR commitment_amount>=0), currency_code text CHECK(currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  valid_from timestamptz NOT NULL, valid_to timestamptz,
  completeness text NOT NULL DEFAULT 'partial' CHECK (completeness IN ('complete','partial','unknown','conflicting','unavailable_before_history_baseline')),
  evidence_source_id uuid NOT NULL REFERENCES finnor_os.evidence_sources(id), evidence_version_id uuid NOT NULL REFERENCES finnor_os.evidence_source_versions(id),
  version integer NOT NULL DEFAULT 1 CHECK(version>=1), superseded_at timestamptz,
  source_system text NOT NULL CHECK(btrim(source_system)<>''), external_id text, created_by text NOT NULL CHECK(btrim(created_by)<>''), observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_facility_lenders_tenant_id_id_key UNIQUE(tenant_id,id),
  CONSTRAINT pe_facility_lenders_facility_fkey FOREIGN KEY(tenant_id,debt_facility_id) REFERENCES finnor_os.pe_debt_facilities(tenant_id,id),
  CONSTRAINT pe_facility_lenders_amount_currency_check CHECK((commitment_amount IS NULL)=(currency_code IS NULL)),
  CONSTRAINT pe_facility_lenders_valid_check CHECK(valid_to IS NULL OR valid_to>valid_from)
);
CREATE UNIQUE INDEX pe_facility_lenders_current_idx ON finnor_os.pe_debt_facility_lenders(debt_facility_id,lender_party_type,lender_party_id,lender_role) WHERE superseded_at IS NULL AND valid_to IS NULL;
CREATE INDEX pe_facility_lenders_facility_time_idx ON finnor_os.pe_debt_facility_lenders(tenant_id,debt_facility_id,valid_from,valid_to,id);

CREATE TABLE finnor_os.pe_ownership_interests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  owner_type text NOT NULL CHECK(owner_type IN ('pe_fund','pe_vehicle','external_organization')), owner_id uuid NOT NULL,
  subject_type text NOT NULL CHECK(subject_type IN ('external_organization','pe_security')), subject_id uuid NOT NULL,
  economic_percentage numeric(20,18) CHECK(economic_percentage IS NULL OR (economic_percentage>=0 AND economic_percentage<=1)),
  voting_percentage numeric(20,18) CHECK(voting_percentage IS NULL OR (voting_percentage>=0 AND voting_percentage<=1)),
  amount numeric(38,12) CHECK(amount IS NULL OR amount>=0), currency_code text CHECK(currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  ownership_class text, valid_from timestamptz NOT NULL, valid_to timestamptz,
  completeness text NOT NULL DEFAULT 'partial' CHECK (completeness IN ('complete','partial','unknown','conflicting','unavailable_before_history_baseline')),
  evidence_source_id uuid NOT NULL REFERENCES finnor_os.evidence_sources(id), evidence_version_id uuid NOT NULL REFERENCES finnor_os.evidence_source_versions(id),
  version integer NOT NULL DEFAULT 1 CHECK(version>=1), supersedes_interest_id uuid, superseded_at timestamptz,
  source_system text NOT NULL CHECK(btrim(source_system)<>''), external_id text, created_by text NOT NULL CHECK(btrim(created_by)<>''), observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_ownership_interests_tenant_id_id_key UNIQUE(tenant_id,id),
  CONSTRAINT pe_ownership_interests_measure_check CHECK(economic_percentage IS NOT NULL OR voting_percentage IS NOT NULL OR amount IS NOT NULL),
  CONSTRAINT pe_ownership_interests_amount_currency_check CHECK((amount IS NULL)=(currency_code IS NULL)),
  CONSTRAINT pe_ownership_interests_supersedes_fkey FOREIGN KEY(tenant_id,supersedes_interest_id) REFERENCES finnor_os.pe_ownership_interests(tenant_id,id),
  CONSTRAINT pe_ownership_interests_no_self_company_check CHECK(NOT(owner_type='external_organization' AND subject_type='external_organization' AND owner_id=subject_id)),
  CONSTRAINT pe_ownership_interests_valid_check CHECK(valid_to IS NULL OR valid_to>valid_from)
);
CREATE UNIQUE INDEX pe_ownership_interests_superseded_once_idx ON finnor_os.pe_ownership_interests(supersedes_interest_id) WHERE supersedes_interest_id IS NOT NULL;
CREATE INDEX pe_ownership_subject_time_idx ON finnor_os.pe_ownership_interests(tenant_id,subject_type,subject_id,valid_from,valid_to,id);
CREATE INDEX pe_ownership_owner_time_idx ON finnor_os.pe_ownership_interests(tenant_id,owner_type,owner_id,valid_from,valid_to,id);

CREATE TABLE finnor_os.pe_benchmarks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  benchmark_key text NOT NULL CHECK(btrim(benchmark_key)<>''), name text NOT NULL CHECK(btrim(name)<>''),
  metric_key text NOT NULL CHECK(btrim(metric_key)<>''), unit text NOT NULL CHECK(btrim(unit)<>''), currency_code text CHECK(currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  cohort_definition jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 1 CHECK(version>=1),
  source_system text NOT NULL CHECK(btrim(source_system)<>''), external_id text, created_by text NOT NULL CHECK(btrim(created_by)<>''), observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_benchmarks_tenant_id_id_key UNIQUE(tenant_id,id),
  CONSTRAINT pe_benchmarks_key_unique UNIQUE(tenant_id,benchmark_key),
  CONSTRAINT pe_benchmarks_cohort_bound CHECK(octet_length(cohort_definition::text)<=32768)
);

CREATE TABLE finnor_os.pe_metric_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  subject_type text NOT NULL CHECK(subject_type IN ('external_organization','pe_portfolio_holding')), subject_id uuid NOT NULL,
  metric_key text NOT NULL CHECK(btrim(metric_key)<>''), name text NOT NULL CHECK(btrim(name)<>''),
  unit text NOT NULL CHECK(btrim(unit)<>''), currency_code text CHECK(currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  frequency text NOT NULL CHECK(frequency IN ('instant','daily','weekly','monthly','quarterly','annual','event')),
  benchmark_id uuid, version integer NOT NULL DEFAULT 1 CHECK(version>=1), active boolean NOT NULL DEFAULT true,
  source_system text NOT NULL CHECK(btrim(source_system)<>''), external_id text, created_by text NOT NULL CHECK(btrim(created_by)<>''), observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_metric_series_tenant_id_id_key UNIQUE(tenant_id,id),
  CONSTRAINT pe_metric_series_benchmark_fkey FOREIGN KEY(tenant_id,benchmark_id) REFERENCES finnor_os.pe_benchmarks(tenant_id,id)
);
CREATE UNIQUE INDEX pe_metric_series_current_key_idx ON finnor_os.pe_metric_series(subject_type,subject_id,lower(metric_key)) WHERE active;
CREATE INDEX pe_metric_series_subject_idx ON finnor_os.pe_metric_series(tenant_id,subject_type,subject_id,metric_key,id);

CREATE TABLE finnor_os.pe_metric_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id), metric_series_id uuid NOT NULL,
  period_start timestamptz NOT NULL, period_end timestamptz NOT NULL,
  value_type text NOT NULL CHECK(value_type IN ('number','text','boolean')),
  value_numeric numeric(38,12), value_text text, value_boolean boolean,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>=1), supersedes_observation_id uuid, superseded_at timestamptz,
  evidence_source_id uuid NOT NULL REFERENCES finnor_os.evidence_sources(id), evidence_version_id uuid NOT NULL REFERENCES finnor_os.evidence_source_versions(id),
  version integer NOT NULL DEFAULT 1 CHECK(version>=1),
  source_system text NOT NULL CHECK(btrim(source_system)<>''), external_id text, created_by text NOT NULL CHECK(btrim(created_by)<>''), observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_metric_observations_tenant_id_id_key UNIQUE(tenant_id,id),
  CONSTRAINT pe_metric_observations_series_fkey FOREIGN KEY(tenant_id,metric_series_id) REFERENCES finnor_os.pe_metric_series(tenant_id,id),
  CONSTRAINT pe_metric_observations_supersedes_fkey FOREIGN KEY(tenant_id,supersedes_observation_id) REFERENCES finnor_os.pe_metric_observations(tenant_id,id),
  CONSTRAINT pe_metric_observations_period_check CHECK(period_end>=period_start),
  CONSTRAINT pe_metric_observations_value_check CHECK(
    (value_type='number' AND value_numeric IS NOT NULL AND value_text IS NULL AND value_boolean IS NULL) OR
    (value_type='text' AND value_numeric IS NULL AND value_text IS NOT NULL AND value_boolean IS NULL) OR
    (value_type='boolean' AND value_numeric IS NULL AND value_text IS NULL AND value_boolean IS NOT NULL)
  ),
  CONSTRAINT pe_metric_observations_supersession_pair CHECK((supersedes_observation_id IS NULL)=(revision=1))
);
CREATE UNIQUE INDEX pe_metric_observations_current_period_idx ON finnor_os.pe_metric_observations(metric_series_id,period_start,period_end) WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX pe_metric_observations_superseded_once_idx ON finnor_os.pe_metric_observations(supersedes_observation_id) WHERE supersedes_observation_id IS NOT NULL;
CREATE INDEX pe_metric_observations_series_time_idx ON finnor_os.pe_metric_observations(tenant_id,metric_series_id,period_start,period_end,revision,id);

CREATE TABLE finnor_os.pe_benchmark_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id), benchmark_id uuid NOT NULL,
  period_start timestamptz NOT NULL, period_end timestamptz NOT NULL, value numeric(38,12) NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>=1), supersedes_observation_id uuid, superseded_at timestamptz,
  evidence_source_id uuid NOT NULL REFERENCES finnor_os.evidence_sources(id), evidence_version_id uuid NOT NULL REFERENCES finnor_os.evidence_source_versions(id),
  version integer NOT NULL DEFAULT 1 CHECK(version>=1),
  source_system text NOT NULL CHECK(btrim(source_system)<>''), external_id text, created_by text NOT NULL CHECK(btrim(created_by)<>''), observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_benchmark_observations_tenant_id_id_key UNIQUE(tenant_id,id),
  CONSTRAINT pe_benchmark_observations_benchmark_fkey FOREIGN KEY(tenant_id,benchmark_id) REFERENCES finnor_os.pe_benchmarks(tenant_id,id),
  CONSTRAINT pe_benchmark_observations_supersedes_fkey FOREIGN KEY(tenant_id,supersedes_observation_id) REFERENCES finnor_os.pe_benchmark_observations(tenant_id,id),
  CONSTRAINT pe_benchmark_observations_period_check CHECK(period_end>=period_start),
  CONSTRAINT pe_benchmark_observations_supersession_pair CHECK((supersedes_observation_id IS NULL)=(revision=1))
);
CREATE UNIQUE INDEX pe_benchmark_observations_current_period_idx ON finnor_os.pe_benchmark_observations(benchmark_id,period_start,period_end) WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX pe_benchmark_observations_superseded_once_idx ON finnor_os.pe_benchmark_observations(supersedes_observation_id) WHERE supersedes_observation_id IS NOT NULL;

CREATE TABLE finnor_os.pe_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  subject_type text NOT NULL CHECK(subject_type IN ('external_organization','pe_portfolio_holding')), subject_id uuid NOT NULL,
  decision_id uuid, outcome_type text NOT NULL CHECK(btrim(outcome_type)<>''), description text NOT NULL CHECK(btrim(description)<>''),
  observed_value jsonb NOT NULL DEFAULT '{}', valid_from timestamptz NOT NULL, valid_to timestamptz,
  evidence_source_id uuid NOT NULL REFERENCES finnor_os.evidence_sources(id), evidence_version_id uuid NOT NULL REFERENCES finnor_os.evidence_source_versions(id),
  version integer NOT NULL DEFAULT 1 CHECK(version>=1), superseded_at timestamptz,
  source_system text NOT NULL CHECK(btrim(source_system)<>''), external_id text, created_by text NOT NULL CHECK(btrim(created_by)<>''), observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_outcomes_tenant_id_id_key UNIQUE(tenant_id,id),
  CONSTRAINT pe_outcomes_decision_fkey FOREIGN KEY(tenant_id,decision_id) REFERENCES finnor_os.pe_decisions(tenant_id,id),
  CONSTRAINT pe_outcomes_valid_check CHECK(valid_to IS NULL OR valid_to>valid_from),
  CONSTRAINT pe_outcomes_value_bound CHECK(octet_length(observed_value::text)<=32768)
);
CREATE INDEX pe_outcomes_subject_time_idx ON finnor_os.pe_outcomes(tenant_id,subject_type,subject_id,valid_from,valid_to,id);
CREATE INDEX pe_outcomes_decision_idx ON finnor_os.pe_outcomes(tenant_id,decision_id,id) WHERE decision_id IS NOT NULL;

CREATE TABLE finnor_os.pe_exits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  portfolio_holding_id uuid NOT NULL, exit_type text NOT NULL CHECK(exit_type IN ('strategic_sale','sponsor_sale','ipo','recapitalization','write_off','other')),
  buyer_company_id uuid, status text NOT NULL CHECK(status IN ('announced','signed','closed','cancelled')),
  announced_at timestamptz, signed_at timestamptz, closed_at timestamptz, cancelled_at timestamptz,
  gross_proceeds numeric(38,12) CHECK(gross_proceeds IS NULL OR gross_proceeds>=0), currency_code text CHECK(currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  evidence_source_id uuid NOT NULL REFERENCES finnor_os.evidence_sources(id), evidence_version_id uuid NOT NULL REFERENCES finnor_os.evidence_source_versions(id),
  version integer NOT NULL DEFAULT 1 CHECK(version>=1),
  source_system text NOT NULL CHECK(btrim(source_system)<>''), external_id text, created_by text NOT NULL CHECK(btrim(created_by)<>''), observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_exits_tenant_id_id_key UNIQUE(tenant_id,id),
  CONSTRAINT pe_exits_holding_fkey FOREIGN KEY(tenant_id,portfolio_holding_id) REFERENCES finnor_os.pe_portfolio_holdings(tenant_id,id),
  CONSTRAINT pe_exits_buyer_fkey FOREIGN KEY(tenant_id,buyer_company_id) REFERENCES finnor_os.external_organizations(tenant_id,id),
  CONSTRAINT pe_exits_amount_currency_check CHECK((gross_proceeds IS NULL)=(currency_code IS NULL)),
  CONSTRAINT pe_exits_state_time_check CHECK(
    (status='announced' AND announced_at IS NOT NULL AND signed_at IS NULL AND closed_at IS NULL AND cancelled_at IS NULL) OR
    (status='signed' AND signed_at IS NOT NULL AND closed_at IS NULL AND cancelled_at IS NULL) OR
    (status='closed' AND closed_at IS NOT NULL AND cancelled_at IS NULL) OR
    (status='cancelled' AND cancelled_at IS NOT NULL AND closed_at IS NULL)
  )
);
CREATE UNIQUE INDEX pe_exits_one_closed_holding_idx ON finnor_os.pe_exits(portfolio_holding_id) WHERE status='closed';
CREATE INDEX pe_exits_holding_status_idx ON finnor_os.pe_exits(tenant_id,portfolio_holding_id,status,id);

-- Exact closed-world coverage.  Existing provider coverage is source-scoped; it
-- cannot prove propositions such as "no debt" for one company and period.
CREATE TABLE finnor_os.pe_fact_coverage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  subject_type text NOT NULL CHECK(subject_type IN ('external_organization','pe_fund','pe_vehicle','pe_portfolio_holding')),
  subject_id uuid NOT NULL,
  proposition text NOT NULL CHECK(proposition IN ('company_ownership','company_debt','company_parent','portfolio_membership','ownership_total')),
  coverage_status text NOT NULL CHECK(coverage_status IN ('complete','partial','unknown','conflicting','unavailable_before_history_baseline')),
  valid_from timestamptz NOT NULL, valid_to timestamptz,
  evidence_source_id uuid NOT NULL REFERENCES finnor_os.evidence_sources(id), evidence_version_id uuid NOT NULL REFERENCES finnor_os.evidence_source_versions(id),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>=1), supersedes_coverage_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK(version>=1), superseded_at timestamptz,
  source_system text NOT NULL CHECK(btrim(source_system)<>''), external_id text, created_by text NOT NULL CHECK(btrim(created_by)<>''), observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pe_fact_coverage_tenant_id_id_key UNIQUE(tenant_id,id),
  CONSTRAINT pe_fact_coverage_supersedes_fkey FOREIGN KEY(tenant_id,supersedes_coverage_id) REFERENCES finnor_os.pe_fact_coverage(tenant_id,id),
  CONSTRAINT pe_fact_coverage_valid_check CHECK(valid_to IS NULL OR valid_to>valid_from)
);
CREATE UNIQUE INDEX pe_fact_coverage_current_idx ON finnor_os.pe_fact_coverage(subject_type,subject_id,proposition) WHERE superseded_at IS NULL AND valid_to IS NULL;
CREATE INDEX pe_fact_coverage_subject_time_idx ON finnor_os.pe_fact_coverage(tenant_id,subject_type,subject_id,proposition,valid_from,valid_to,id);

-- Reuse Source Truth for identity decisions.  These columns make decision
-- lineage queryable and enforceable without a parallel identity event store.
ALTER TABLE finnor_os.external_ref_observations
  ADD COLUMN resolution_kind text,
  ADD COLUMN resolution_from_refs jsonb,
  ADD COLUMN resolution_to_refs jsonb,
  ADD COLUMN resolution_decision text,
  ADD COLUMN resolution_valid_from timestamptz,
  ADD COLUMN resolution_valid_to timestamptz,
  ADD COLUMN resolution_evidence_source_id uuid REFERENCES finnor_os.evidence_sources(id),
  ADD COLUMN resolution_evidence_version_id uuid REFERENCES finnor_os.evidence_source_versions(id),
  ADD COLUMN resolution_authority jsonb;
ALTER TABLE finnor_os.external_ref_observations ADD CONSTRAINT external_ref_observations_resolution_check CHECK(
  (resolution_kind IS NULL AND resolution_from_refs IS NULL AND resolution_to_refs IS NULL AND resolution_decision IS NULL
    AND resolution_valid_from IS NULL AND resolution_valid_to IS NULL AND resolution_evidence_source_id IS NULL
    AND resolution_evidence_version_id IS NULL AND resolution_authority IS NULL)
  OR
  (resolution_kind IN ('merge','split','correction')
    AND jsonb_typeof(resolution_from_refs)='array' AND jsonb_array_length(resolution_from_refs)>0
    AND jsonb_typeof(resolution_to_refs)='array' AND jsonb_array_length(resolution_to_refs)>0
    AND btrim(resolution_decision)<>''
    AND (resolution_valid_to IS NULL OR (resolution_valid_from IS NOT NULL AND resolution_valid_to>resolution_valid_from))
    AND resolution_evidence_source_id IS NOT NULL AND resolution_evidence_version_id IS NOT NULL
    AND jsonb_typeof(resolution_authority)='object')
);
CREATE INDEX external_ref_observations_resolution_time_idx ON finnor_os.external_ref_observations(tenant_id,source_link_id,received_at,id) WHERE resolution_kind IS NOT NULL;

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_twin_reference() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE body jsonb:=to_jsonb(NEW); ref_tenant uuid; deal_row record; existing_cycle boolean;
BEGIN
  IF finnor_os.active_tenant_vertical(NEW.tenant_id)<>'private_equity' THEN
    RAISE EXCEPTION 'PE Digital Twin entity is unsupported for the tenant active vertical';
  END IF;
  IF body ? 'evidence_source_id' THEN
    PERFORM finnor_os.assert_pe_twin_evidence(NEW.tenant_id,(body->>'evidence_source_id')::uuid,(body->>'evidence_version_id')::uuid,TG_TABLE_NAME);
  END IF;
  CASE TG_TABLE_NAME
    WHEN 'pe_strategy_mandates' THEN
      ref_tenant:=finnor_os.canonical_entity_tenant(body->>'principal_type',(body->>'principal_id')::uuid);
      IF ref_tenant IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Strategy mandate principal crosses tenant boundary or is missing'; END IF;
    WHEN 'pe_portfolio_holdings' THEN
      SELECT tenant_id,target_organization_id,status,actual_close_at INTO deal_row FROM finnor_os.pe_deals WHERE id=(body->>'origin_deal_id')::uuid FOR SHARE;
      IF deal_row.tenant_id IS DISTINCT FROM NEW.tenant_id OR deal_row.target_organization_id IS DISTINCT FROM (body->>'company_id')::uuid
         OR deal_row.status<>'closed' OR deal_row.actual_close_at IS NULL THEN
        RAISE EXCEPTION 'Portfolio holding requires a verified closed Deal for the same canonical Company';
      END IF;
      IF (body->>'entry_date')::date<>deal_row.actual_close_at::date THEN RAISE EXCEPTION 'Portfolio entry date must equal verified Deal close date'; END IF;
    WHEN 'pe_company_hierarchy_relationships' THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':company-hierarchy',5144));
      WITH RECURSIVE descendants(id) AS (
        SELECT child_company_id FROM finnor_os.pe_company_hierarchy_relationships
         WHERE tenant_id=NEW.tenant_id AND parent_company_id=(body->>'child_company_id')::uuid AND superseded_at IS NULL
           AND tstzrange(valid_from,valid_to,'[)') && tstzrange((body->>'valid_from')::timestamptz,(body->>'valid_to')::timestamptz,'[)')
        UNION
        SELECT r.child_company_id FROM finnor_os.pe_company_hierarchy_relationships r JOIN descendants d ON r.parent_company_id=d.id
         WHERE r.tenant_id=NEW.tenant_id AND r.superseded_at IS NULL
           AND tstzrange(r.valid_from,r.valid_to,'[)') && tstzrange((body->>'valid_from')::timestamptz,(body->>'valid_to')::timestamptz,'[)')
      ) SELECT EXISTS(SELECT 1 FROM descendants WHERE id=(body->>'parent_company_id')::uuid) INTO existing_cycle;
      IF existing_cycle THEN RAISE EXCEPTION 'Company hierarchy cycle is illegal'; END IF;
    WHEN 'pe_company_party_roles' THEN
      ref_tenant:=finnor_os.canonical_entity_tenant(body->>'party_type',(body->>'party_id')::uuid);
      IF ref_tenant IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Company role party crosses tenant boundary or is missing'; END IF;
    WHEN 'pe_debt_facility_lenders' THEN
      ref_tenant:=finnor_os.canonical_entity_tenant(body->>'lender_party_type',(body->>'lender_party_id')::uuid);
      IF ref_tenant IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Facility lender crosses tenant boundary or is missing'; END IF;
    WHEN 'pe_ownership_interests' THEN
      IF finnor_os.canonical_entity_tenant(body->>'owner_type',(body->>'owner_id')::uuid) IS DISTINCT FROM NEW.tenant_id
         OR finnor_os.canonical_entity_tenant(body->>'subject_type',(body->>'subject_id')::uuid) IS DISTINCT FROM NEW.tenant_id THEN
        RAISE EXCEPTION 'Ownership interest crosses tenant boundary or references a missing identity';
      END IF;
    WHEN 'pe_metric_series' THEN
      IF finnor_os.canonical_entity_tenant(body->>'subject_type',(body->>'subject_id')::uuid) IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Metric subject crosses tenant boundary or is missing'; END IF;
    WHEN 'pe_outcomes' THEN
      IF finnor_os.canonical_entity_tenant(body->>'subject_type',(body->>'subject_id')::uuid) IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Outcome subject crosses tenant boundary or is missing'; END IF;
    WHEN 'pe_fact_coverage' THEN
      IF finnor_os.canonical_entity_tenant(body->>'subject_type',(body->>'subject_id')::uuid) IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'Coverage subject crosses tenant boundary or is missing'; END IF;
    WHEN 'pe_exits' THEN
      IF body->>'status'='closed' AND NOT EXISTS (
        SELECT 1 FROM finnor_os.pe_portfolio_holdings h WHERE h.tenant_id=NEW.tenant_id AND h.id=(body->>'portfolio_holding_id')::uuid AND h.holding_status='exited' AND h.exit_date=(body->>'closed_at')::timestamptz::date
      ) THEN RAISE EXCEPTION 'Closed Exit requires the same transaction to close its PortfolioHolding'; END IF;
    ELSE NULL;
  END CASE;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_twin_version() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE old_body jsonb:=to_jsonb(OLD); new_body jsonb:=to_jsonb(NEW);
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PE Digital Twin canonical rows cannot be deleted'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 THEN RAISE EXCEPTION 'PE Digital Twin entity must begin at version 1'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id THEN RAISE EXCEPTION 'PE Digital Twin canonical identity is immutable'; END IF;
  IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'stale PE Digital Twin expected version'; END IF;
  IF (old_body-ARRAY['version','updated_at','valid_to','superseded_at','status','holding_status','exit_date','announced_at','signed_at','closed_at','cancelled_at'])
     IS DISTINCT FROM
     (new_body-ARRAY['version','updated_at','valid_to','superseded_at','status','holding_status','exit_date','announced_at','signed_at','closed_at','cancelled_at']) THEN
    RAISE EXCEPTION 'PE Digital Twin facts are revision-preserving; immutable fact fields cannot be patched';
  END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_twin_temporal_overlap() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE conflict_exists boolean:=false; identity_key text; body jsonb:=to_jsonb(NEW);
BEGIN
  identity_key:=CASE TG_TABLE_NAME
    WHEN 'pe_fund_vehicle_links' THEN (body->>'fund_id')||':'||(body->>'vehicle_id')||':'||(body->>'relationship_kind')
    WHEN 'pe_strategy_mandates' THEN (body->>'principal_type')||':'||(body->>'principal_id')||':'||(body->>'strategy_id')
    WHEN 'pe_company_hierarchy_relationships' THEN (body->>'parent_company_id')||':'||(body->>'child_company_id')||':'||(body->>'relationship_kind')
    WHEN 'pe_company_party_roles' THEN (body->>'company_id')||':'||(body->>'party_type')||':'||(body->>'party_id')||':'||(body->>'role')||':'||coalesce(body->>'role_detail','')
    WHEN 'pe_debt_facility_lenders' THEN (body->>'debt_facility_id')||':'||(body->>'lender_party_type')||':'||(body->>'lender_party_id')||':'||(body->>'lender_role')
    WHEN 'pe_ownership_interests' THEN (body->>'owner_type')||':'||(body->>'owner_id')||':'||(body->>'subject_type')||':'||(body->>'subject_id')||':'||coalesce((body->>'ownership_class'),'')
    WHEN 'pe_securities' THEN (body->>'issuer_company_id')||':'||lower((body->>'security_key'))
    WHEN 'pe_debt_facilities' THEN (body->>'borrower_company_id')||':'||lower((body->>'facility_key'))
    WHEN 'pe_fact_coverage' THEN (body->>'subject_type')||':'||(body->>'subject_id')||':'||(body->>'proposition')
    ELSE NULL END;
  IF identity_key IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':'||TG_TABLE_NAME||':'||identity_key,5145));
  CASE TG_TABLE_NAME
    WHEN 'pe_fund_vehicle_links' THEN SELECT EXISTS(SELECT 1 FROM finnor_os.pe_fund_vehicle_links x WHERE x.tenant_id=NEW.tenant_id AND x.id<>NEW.id AND x.fund_id=(body->>'fund_id')::uuid AND x.vehicle_id=(body->>'vehicle_id')::uuid AND x.relationship_kind=(body->>'relationship_kind') AND x.superseded_at IS NULL AND tstzrange(x.valid_from,x.valid_to,'[)')&&tstzrange(NEW.valid_from,NEW.valid_to,'[)')) INTO conflict_exists;
    WHEN 'pe_strategy_mandates' THEN SELECT EXISTS(SELECT 1 FROM finnor_os.pe_strategy_mandates x WHERE x.tenant_id=NEW.tenant_id AND x.id<>NEW.id AND x.principal_type=(body->>'principal_type') AND x.principal_id=(body->>'principal_id')::uuid AND x.strategy_id=(body->>'strategy_id')::uuid AND x.superseded_at IS NULL AND tstzrange(x.valid_from,x.valid_to,'[)')&&tstzrange(NEW.valid_from,NEW.valid_to,'[)')) INTO conflict_exists;
    WHEN 'pe_company_hierarchy_relationships' THEN SELECT EXISTS(SELECT 1 FROM finnor_os.pe_company_hierarchy_relationships x WHERE x.tenant_id=NEW.tenant_id AND x.id<>NEW.id AND x.parent_company_id=(body->>'parent_company_id')::uuid AND x.child_company_id=(body->>'child_company_id')::uuid AND x.relationship_kind=(body->>'relationship_kind') AND x.superseded_at IS NULL AND tstzrange(x.valid_from,x.valid_to,'[)')&&tstzrange(NEW.valid_from,NEW.valid_to,'[)')) INTO conflict_exists;
    WHEN 'pe_company_party_roles' THEN SELECT EXISTS(SELECT 1 FROM finnor_os.pe_company_party_roles x WHERE x.tenant_id=NEW.tenant_id AND x.id<>NEW.id AND x.company_id=(body->>'company_id')::uuid AND x.party_type=(body->>'party_type') AND x.party_id=(body->>'party_id')::uuid AND x.role=(body->>'role') AND coalesce(x.role_detail,'')=coalesce(body->>'role_detail','') AND x.superseded_at IS NULL AND tstzrange(x.valid_from,x.valid_to,'[)')&&tstzrange(NEW.valid_from,NEW.valid_to,'[)')) INTO conflict_exists;
    WHEN 'pe_debt_facility_lenders' THEN SELECT EXISTS(SELECT 1 FROM finnor_os.pe_debt_facility_lenders x WHERE x.tenant_id=NEW.tenant_id AND x.id<>NEW.id AND x.debt_facility_id=(body->>'debt_facility_id')::uuid AND x.lender_party_type=(body->>'lender_party_type') AND x.lender_party_id=(body->>'lender_party_id')::uuid AND x.lender_role=(body->>'lender_role') AND x.superseded_at IS NULL AND tstzrange(x.valid_from,x.valid_to,'[)')&&tstzrange(NEW.valid_from,NEW.valid_to,'[)')) INTO conflict_exists;
    WHEN 'pe_ownership_interests' THEN SELECT EXISTS(SELECT 1 FROM finnor_os.pe_ownership_interests x WHERE x.tenant_id=NEW.tenant_id AND x.id<>NEW.id AND x.owner_type=(body->>'owner_type') AND x.owner_id=(body->>'owner_id')::uuid AND x.subject_type=(body->>'subject_type') AND x.subject_id=(body->>'subject_id')::uuid AND coalesce(x.ownership_class,'')=coalesce((body->>'ownership_class'),'') AND x.superseded_at IS NULL AND tstzrange(x.valid_from,x.valid_to,'[)')&&tstzrange(NEW.valid_from,NEW.valid_to,'[)')) INTO conflict_exists;
    WHEN 'pe_securities' THEN SELECT EXISTS(SELECT 1 FROM finnor_os.pe_securities x WHERE x.tenant_id=NEW.tenant_id AND x.id<>NEW.id AND x.issuer_company_id=(body->>'issuer_company_id')::uuid AND lower(x.security_key)=lower((body->>'security_key')) AND x.superseded_at IS NULL AND tstzrange(x.valid_from,x.valid_to,'[)')&&tstzrange(NEW.valid_from,NEW.valid_to,'[)')) INTO conflict_exists;
    WHEN 'pe_debt_facilities' THEN SELECT EXISTS(SELECT 1 FROM finnor_os.pe_debt_facilities x WHERE x.tenant_id=NEW.tenant_id AND x.id<>NEW.id AND x.borrower_company_id=(body->>'borrower_company_id')::uuid AND lower(x.facility_key)=lower((body->>'facility_key')) AND x.superseded_at IS NULL AND tstzrange(x.valid_from,x.valid_to,'[)')&&tstzrange(NEW.valid_from,NEW.valid_to,'[)')) INTO conflict_exists;
    WHEN 'pe_fact_coverage' THEN SELECT EXISTS(SELECT 1 FROM finnor_os.pe_fact_coverage x WHERE x.tenant_id=NEW.tenant_id AND x.id<>NEW.id AND x.subject_type=(body->>'subject_type') AND x.subject_id=(body->>'subject_id')::uuid AND x.proposition=(body->>'proposition') AND x.superseded_at IS NULL AND tstzrange(x.valid_from,x.valid_to,'[)')&&tstzrange(NEW.valid_from,NEW.valid_to,'[)')) INTO conflict_exists;
    ELSE NULL;
  END CASE;
  IF conflict_exists THEN RAISE EXCEPTION 'overlapping current % valid-time interval is illegal',TG_TABLE_NAME; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_metric_restatement() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE prior record;
BEGIN
  IF NEW.supersedes_observation_id IS NULL THEN RETURN NEW; END IF;
  SELECT tenant_id,metric_series_id,period_start,period_end,revision,superseded_at INTO prior
    FROM finnor_os.pe_metric_observations WHERE id=NEW.supersedes_observation_id FOR UPDATE;
  IF prior.tenant_id IS DISTINCT FROM NEW.tenant_id OR prior.metric_series_id IS DISTINCT FROM NEW.metric_series_id
     OR prior.period_start IS DISTINCT FROM NEW.period_start OR prior.period_end IS DISTINCT FROM NEW.period_end
     OR prior.revision+1<>NEW.revision OR prior.superseded_at IS NULL THEN
    RAISE EXCEPTION 'Metric restatement must follow an atomically superseded prior observation for the same period';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_benchmark_restatement() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE prior record;
BEGIN
  IF NEW.supersedes_observation_id IS NULL THEN RETURN NEW; END IF;
  SELECT tenant_id,benchmark_id,period_start,period_end,revision,superseded_at INTO prior
    FROM finnor_os.pe_benchmark_observations WHERE id=NEW.supersedes_observation_id FOR UPDATE;
  IF prior.tenant_id IS DISTINCT FROM NEW.tenant_id OR prior.benchmark_id IS DISTINCT FROM NEW.benchmark_id
     OR prior.period_start IS DISTINCT FROM NEW.period_start OR prior.period_end IS DISTINCT FROM NEW.period_end
     OR prior.revision+1<>NEW.revision OR prior.superseded_at IS NULL THEN
    RAISE EXCEPTION 'Benchmark restatement must follow an atomically superseded prior observation for the same period';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_pe_coverage_restatement() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE prior record;
BEGIN
  IF NEW.supersedes_coverage_id IS NULL THEN
    IF NEW.revision<>1 THEN RAISE EXCEPTION 'Initial coverage fact must begin at revision 1'; END IF;
    RETURN NEW;
  END IF;
  SELECT tenant_id,subject_type,subject_id,proposition,valid_from,valid_to,revision,superseded_at INTO prior
    FROM finnor_os.pe_fact_coverage WHERE id=NEW.supersedes_coverage_id FOR UPDATE;
  IF prior.tenant_id IS DISTINCT FROM NEW.tenant_id OR prior.subject_type IS DISTINCT FROM NEW.subject_type
     OR prior.subject_id IS DISTINCT FROM NEW.subject_id OR prior.proposition IS DISTINCT FROM NEW.proposition
     OR prior.valid_from IS DISTINCT FROM NEW.valid_from OR prior.valid_to IS DISTINCT FROM NEW.valid_to
     OR prior.revision+1<>NEW.revision OR prior.superseded_at IS NULL THEN
    RAISE EXCEPTION 'Coverage correction must follow an atomically superseded prior fact for the same proposition and valid interval';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_identity_resolution_observation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE ref jsonb;
BEGIN
  IF NEW.resolution_kind IS NULL THEN RETURN NEW; END IF;
  PERFORM finnor_os.assert_pe_twin_evidence(NEW.tenant_id,NEW.resolution_evidence_source_id,NEW.resolution_evidence_version_id,'identity resolution');
  FOR ref IN SELECT value FROM jsonb_array_elements(NEW.resolution_from_refs||NEW.resolution_to_refs) LOOP
    IF jsonb_typeof(ref)<>'object' OR coalesce(ref->>'entityType','')='' OR coalesce(ref->>'entityId','')='' THEN
      RAISE EXCEPTION 'Identity resolution references must contain entityType and entityId';
    END IF;
    IF finnor_os.canonical_entity_tenant(ref->>'entityType',(ref->>'entityId')::uuid) IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'Identity resolution reference crosses tenant boundary or is missing';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER external_ref_observations_resolution_scope BEFORE INSERT ON finnor_os.external_ref_observations
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_identity_resolution_observation();

DO $twin_triggers$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'pe_funds','pe_vehicles','pe_fund_vehicle_links','pe_strategy_mandates','pe_portfolio_holdings',
    'pe_company_hierarchy_relationships','pe_company_party_roles','pe_securities','pe_debt_facilities',
    'pe_debt_facility_lenders','pe_ownership_interests','pe_benchmarks','pe_metric_series',
    'pe_metric_observations','pe_benchmark_observations','pe_outcomes','pe_exits','pe_fact_coverage'
  ] LOOP
    EXECUTE format('CREATE TRIGGER pe_twin_version BEFORE INSERT OR UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_twin_version()',table_name);
    EXECUTE format('CREATE TRIGGER pe_twin_reference BEFORE INSERT OR UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_twin_reference()',table_name);
  END LOOP;
END $twin_triggers$;
DO $twin_overlap_triggers$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['pe_fund_vehicle_links','pe_strategy_mandates','pe_company_hierarchy_relationships','pe_company_party_roles','pe_debt_facility_lenders','pe_ownership_interests','pe_securities','pe_debt_facilities','pe_fact_coverage'] LOOP
    EXECUTE format('CREATE TRIGGER pe_twin_temporal_overlap BEFORE INSERT OR UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_twin_temporal_overlap()',table_name);
  END LOOP;
END $twin_overlap_triggers$;
CREATE TRIGGER pe_metric_observation_restatement BEFORE INSERT ON finnor_os.pe_metric_observations FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_metric_restatement();
CREATE TRIGGER pe_benchmark_observation_restatement BEFORE INSERT ON finnor_os.pe_benchmark_observations FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_benchmark_restatement();
CREATE TRIGGER pe_coverage_restatement BEFORE INSERT ON finnor_os.pe_fact_coverage FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_pe_coverage_restatement();

-- Every new identity/fact/relation joins the existing registry and append-only
-- canonical history engine.  No pre-migration rows exist in these new tables, so
-- the coverage instant is truthful and no synthetic baseline facts are inserted.
INSERT INTO finnor_os.canonical_truth_registry
  (entity_type,vertical_key,source_table,writable_owner,mutation_boundary,work_attachable)
VALUES
  ('pe_fund','private_equity','pe_funds','@finnor/private-equity','digitalTwinRepository.createFund / transitionFund',true),
  ('pe_vehicle','private_equity','pe_vehicles','@finnor/private-equity','digitalTwinRepository.createVehicle / transitionVehicle',true),
  ('pe_fund_vehicle_link','private_equity','pe_fund_vehicle_links','@finnor/private-equity','digitalTwinRepository.linkFundVehicle',false),
  ('pe_strategy_mandate','private_equity','pe_strategy_mandates','@finnor/private-equity','digitalTwinRepository.linkStrategyMandate',false),
  ('pe_portfolio_holding','private_equity','pe_portfolio_holdings','@finnor/private-equity','digitalTwinRepository.createPortfolioHolding / recordExit',true),
  ('pe_company_hierarchy','private_equity','pe_company_hierarchy_relationships','@finnor/private-equity','digitalTwinRepository.recordCompanyHierarchy',false),
  ('pe_company_party_role','private_equity','pe_company_party_roles','@finnor/private-equity','digitalTwinRepository.recordCompanyPartyRole',false),
  ('pe_security','private_equity','pe_securities','@finnor/private-equity','digitalTwinRepository.createSecurity',true),
  ('pe_debt_facility','private_equity','pe_debt_facilities','@finnor/private-equity','digitalTwinRepository.createDebtFacility',true),
  ('pe_debt_facility_lender','private_equity','pe_debt_facility_lenders','@finnor/private-equity','digitalTwinRepository.linkDebtFacilityLender',false),
  ('pe_ownership_interest','private_equity','pe_ownership_interests','@finnor/private-equity','digitalTwinRepository.recordOwnershipInterest',false),
  ('pe_benchmark','private_equity','pe_benchmarks','@finnor/private-equity','digitalTwinRepository.createBenchmark',false),
  ('pe_metric_series','private_equity','pe_metric_series','@finnor/private-equity','digitalTwinRepository.createMetricSeries',true),
  ('pe_metric_observation','private_equity','pe_metric_observations','@finnor/private-equity','digitalTwinRepository.recordMetricObservation / restateMetricObservation',false),
  ('pe_benchmark_observation','private_equity','pe_benchmark_observations','@finnor/private-equity','digitalTwinRepository.recordBenchmarkObservation',false),
  ('pe_outcome','private_equity','pe_outcomes','@finnor/private-equity','digitalTwinRepository.recordOutcome',true),
  ('pe_exit','private_equity','pe_exits','@finnor/private-equity','digitalTwinRepository.recordExit',true),
  ('pe_fact_coverage','private_equity','pe_fact_coverage','@finnor/private-equity','digitalTwinRepository.recordFactCoverage / reviseFactCoverage',false);

DO $twin_history$
DECLARE captured timestamptz:=clock_timestamp(); owner record;
BEGIN
  FOR owner IN SELECT * FROM (VALUES
    ('pe_fund','pe_funds'),('pe_vehicle','pe_vehicles'),('pe_fund_vehicle_link','pe_fund_vehicle_links'),
    ('pe_strategy_mandate','pe_strategy_mandates'),('pe_portfolio_holding','pe_portfolio_holdings'),
    ('pe_company_hierarchy','pe_company_hierarchy_relationships'),('pe_company_party_role','pe_company_party_roles'),
    ('pe_security','pe_securities'),('pe_debt_facility','pe_debt_facilities'),('pe_debt_facility_lender','pe_debt_facility_lenders'),
    ('pe_ownership_interest','pe_ownership_interests'),('pe_benchmark','pe_benchmarks'),('pe_metric_series','pe_metric_series'),
    ('pe_metric_observation','pe_metric_observations'),('pe_benchmark_observation','pe_benchmark_observations'),
    ('pe_outcome','pe_outcomes'),('pe_exit','pe_exits'),('pe_fact_coverage','pe_fact_coverage')
  ) AS owners(entity_type,source_table) LOOP
    INSERT INTO finnor_os.canonical_history_coverage(entity_type,source_table,vertical_key,coverage_started_at,baseline_completed_at)
      VALUES(owner.entity_type,owner.source_table,'private_equity',captured,captured);
    EXECUTE format('CREATE TRIGGER canonical_history AFTER INSERT OR UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.append_canonical_entity_version(%L)',owner.source_table,owner.entity_type);
  END LOOP;

  -- Core identity gains history in place. Existing identities are baselined only
  -- at this migration instant; nothing claims what they looked like beforehand.
  FOR owner IN SELECT * FROM (VALUES
    ('external_organization','external_organizations'),('external_contact','external_contacts')
  ) AS owners(entity_type,source_table) LOOP
    INSERT INTO finnor_os.canonical_history_coverage(entity_type,source_table,vertical_key,coverage_started_at,baseline_completed_at)
      VALUES(owner.entity_type,owner.source_table,'private_equity',captured,captured);
    EXECUTE format(
      'INSERT INTO finnor_os.canonical_entity_versions(tenant_id,entity_type,entity_id,entity_version,snapshot,snapshot_hash,recorded_at,actor,origin) '
      'SELECT tenant_id,$1,id,1,to_jsonb(t),encode(public.digest(convert_to(to_jsonb(t)::text,''UTF8''),''sha256''),''hex''),$2,'
      '''system:scope4-identity-baseline'',''baseline'' FROM finnor_os.%I t',owner.source_table
    ) USING owner.entity_type,captured;
    EXECUTE format('CREATE TRIGGER canonical_history AFTER INSERT OR UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.append_canonical_entity_version(%L)',owner.source_table,owner.entity_type);
  END LOOP;
END $twin_history$;

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
    WHEN 'pe_fund' THEN RETURN QUERY SELECT 'pe_fund'::text,x.id,NULL::uuid FROM finnor_os.pe_funds x WHERE x.id=p_id;
    WHEN 'pe_vehicle' THEN RETURN QUERY SELECT 'pe_vehicle'::text,x.id,NULL::uuid FROM finnor_os.pe_vehicles x WHERE x.id=p_id;
    WHEN 'pe_portfolio_holding' THEN RETURN QUERY SELECT 'pe_portfolio_holding'::text,x.id,NULL::uuid FROM finnor_os.pe_portfolio_holdings x WHERE x.id=p_id;
    WHEN 'external_organization' THEN RETURN QUERY SELECT 'external_organization'::text,x.id,NULL::uuid FROM finnor_os.external_organizations x WHERE x.id=p_id;
    WHEN 'pe_fund_vehicle_link' THEN RETURN QUERY SELECT 'pe_fund'::text,x.fund_id,NULL::uuid FROM finnor_os.pe_fund_vehicle_links x WHERE x.id=p_id;
    WHEN 'pe_strategy_mandate' THEN RETURN QUERY SELECT x.principal_type,x.principal_id,NULL::uuid FROM finnor_os.pe_strategy_mandates x WHERE x.id=p_id;
    WHEN 'pe_company_hierarchy' THEN RETURN QUERY SELECT 'external_organization'::text,x.parent_company_id,NULL::uuid FROM finnor_os.pe_company_hierarchy_relationships x WHERE x.id=p_id;
    WHEN 'pe_company_party_role' THEN RETURN QUERY SELECT 'external_organization'::text,x.company_id,NULL::uuid FROM finnor_os.pe_company_party_roles x WHERE x.id=p_id;
    WHEN 'pe_security' THEN RETURN QUERY SELECT 'external_organization'::text,x.issuer_company_id,NULL::uuid FROM finnor_os.pe_securities x WHERE x.id=p_id;
    WHEN 'pe_debt_facility' THEN RETURN QUERY SELECT 'external_organization'::text,x.borrower_company_id,NULL::uuid FROM finnor_os.pe_debt_facilities x WHERE x.id=p_id;
    WHEN 'pe_debt_facility_lender' THEN RETURN QUERY SELECT 'external_organization'::text,f.borrower_company_id,NULL::uuid FROM finnor_os.pe_debt_facility_lenders x JOIN finnor_os.pe_debt_facilities f ON f.id=x.debt_facility_id WHERE x.id=p_id;
    WHEN 'pe_ownership_interest' THEN RETURN QUERY SELECT CASE WHEN x.subject_type='external_organization' THEN 'external_organization' ELSE 'external_organization' END,
      CASE WHEN x.subject_type='external_organization' THEN x.subject_id ELSE s.issuer_company_id END,NULL::uuid FROM finnor_os.pe_ownership_interests x LEFT JOIN finnor_os.pe_securities s ON x.subject_type='pe_security' AND s.id=x.subject_id WHERE x.id=p_id;
    WHEN 'pe_metric_series' THEN RETURN QUERY SELECT x.subject_type,x.subject_id,NULL::uuid FROM finnor_os.pe_metric_series x WHERE x.id=p_id;
    WHEN 'pe_metric_observation' THEN RETURN QUERY SELECT s.subject_type,s.subject_id,NULL::uuid FROM finnor_os.pe_metric_observations x JOIN finnor_os.pe_metric_series s ON s.id=x.metric_series_id WHERE x.id=p_id;
    WHEN 'pe_benchmark' THEN RETURN QUERY SELECT 'pe_benchmark'::text,x.id,NULL::uuid FROM finnor_os.pe_benchmarks x WHERE x.id=p_id;
    WHEN 'pe_benchmark_observation' THEN RETURN QUERY SELECT 'pe_benchmark'::text,x.benchmark_id,NULL::uuid FROM finnor_os.pe_benchmark_observations x WHERE x.id=p_id;
    WHEN 'pe_outcome' THEN RETURN QUERY SELECT x.subject_type,x.subject_id,NULL::uuid FROM finnor_os.pe_outcomes x WHERE x.id=p_id;
    WHEN 'pe_exit' THEN RETURN QUERY SELECT 'pe_portfolio_holding'::text,x.portfolio_holding_id,h.origin_deal_id FROM finnor_os.pe_exits x JOIN finnor_os.pe_portfolio_holdings h ON h.id=x.portfolio_holding_id WHERE x.id=p_id;
    WHEN 'pe_fact_coverage' THEN RETURN QUERY SELECT x.subject_type,x.subject_id,NULL::uuid FROM finnor_os.pe_fact_coverage x WHERE x.id=p_id;
    ELSE RETURN;
  END CASE;
END $$;

-- Preserve Deal lineage for new objects only where it is mathematically unique.
-- Company/Fund/Vehicle facts may span several Deals, so those intentionally
-- resolve to NULL instead of selecting an arbitrary transaction.
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
    WHEN 'pe_portfolio_holding' THEN SELECT origin_deal_id INTO resolved FROM finnor_os.pe_portfolio_holdings WHERE id=p_id;
    WHEN 'pe_exit' THEN SELECT h.origin_deal_id INTO resolved FROM finnor_os.pe_exits x JOIN finnor_os.pe_portfolio_holdings h ON h.id=x.portfolio_holding_id WHERE x.id=p_id;
    WHEN 'pe_outcome' THEN SELECT h.origin_deal_id INTO resolved FROM finnor_os.pe_outcomes x JOIN finnor_os.pe_portfolio_holdings h ON x.subject_type='pe_portfolio_holding' AND h.id=x.subject_id WHERE x.id=p_id;
    WHEN 'pe_metric_series' THEN SELECT h.origin_deal_id INTO resolved FROM finnor_os.pe_metric_series x JOIN finnor_os.pe_portfolio_holdings h ON x.subject_type='pe_portfolio_holding' AND h.id=x.subject_id WHERE x.id=p_id;
    WHEN 'pe_metric_observation' THEN SELECT h.origin_deal_id INTO resolved FROM finnor_os.pe_metric_observations x JOIN finnor_os.pe_metric_series s ON s.id=x.metric_series_id JOIN finnor_os.pe_portfolio_holdings h ON s.subject_type='pe_portfolio_holding' AND h.id=s.subject_id WHERE x.id=p_id;
    ELSE RETURN NULL;
  END CASE;
  RETURN resolved;
END $$;

-- The original P1 link guard is retained as the single enforcement point, with
-- its root vocabulary widened and Deal scope compared to the resolver for every
-- root kind. Company-rooted PE facts remain PE-owned endpoints while Company
-- identity itself remains Core-owned.
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
  IF NEW.deal_id IS DISTINCT FROM resolved.deal_id THEN
    RAISE EXCEPTION 'PE link Deal scope does not match its resolved world root';
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

-- Company is a Core external_organization root; no duplicate Company row exists.
-- Work/task attachment for Core identity already resolves through the registry.
ALTER TABLE finnor_os.pe_document_links DROP CONSTRAINT IF EXISTS pe_document_links_world_root_type_check;
ALTER TABLE finnor_os.pe_document_links ADD CONSTRAINT pe_document_links_world_root_type_check
  CHECK(world_root_type IN ('pe_strategy','pe_opportunity','pe_deal','pe_fund','pe_vehicle','external_organization','pe_portfolio_holding'));
ALTER TABLE finnor_os.pe_evidence_links DROP CONSTRAINT IF EXISTS pe_evidence_links_world_root_type_check;
ALTER TABLE finnor_os.pe_evidence_links ADD CONSTRAINT pe_evidence_links_world_root_type_check
  CHECK(world_root_type IN ('pe_strategy','pe_opportunity','pe_deal','pe_fund','pe_vehicle','external_organization','pe_portfolio_holding'));
ALTER TABLE finnor_os.pe_document_links DROP CONSTRAINT IF EXISTS pe_document_links_entity_type_check;
ALTER TABLE finnor_os.pe_document_links ADD CONSTRAINT pe_document_links_entity_type_check CHECK(entity_type IN (
  'pe_deal','pe_request','pe_deliverable','pe_finding','pe_closing_condition','pe_closing_item','pe_strategy','pe_opportunity',
  'pe_investment_case','pe_thesis','pe_assumption','pe_decision','pe_fund','pe_vehicle','pe_portfolio_holding','pe_security',
  'pe_debt_facility','pe_metric_series','pe_outcome','pe_exit'
));
ALTER TABLE finnor_os.pe_evidence_links DROP CONSTRAINT IF EXISTS pe_evidence_links_entity_type_check;
ALTER TABLE finnor_os.pe_evidence_links ADD CONSTRAINT pe_evidence_links_entity_type_check CHECK(entity_type IN (
  'pe_deal','pe_finding','pe_deal_risk','pe_closing_condition','pe_closing_item','pe_strategy','pe_opportunity','pe_investment_case',
  'pe_thesis','pe_assumption','pe_decision','pe_fund','pe_vehicle','pe_portfolio_holding','pe_security','pe_debt_facility',
  'pe_metric_series','pe_metric_observation','pe_benchmark','pe_outcome','pe_exit'
));

ALTER TABLE finnor_os.integration_source_scopes DROP CONSTRAINT IF EXISTS integration_source_scopes_root_binding_type_check;
ALTER TABLE finnor_os.integration_source_scopes ADD CONSTRAINT integration_source_scopes_root_binding_type_check
  CHECK(root_binding_type IS NULL OR root_binding_type IN ('pe_strategy','pe_opportunity','pe_deal','pe_fund','pe_vehicle','external_organization','pe_portfolio_holding'));
ALTER TABLE finnor_os.provider_object_root_bindings DROP CONSTRAINT IF EXISTS provider_object_root_bindings_world_root_type_check;
ALTER TABLE finnor_os.provider_object_root_bindings ADD CONSTRAINT provider_object_root_bindings_world_root_type_check
  CHECK(world_root_type IN ('pe_strategy','pe_opportunity','pe_deal','pe_fund','pe_vehicle','external_organization','pe_portfolio_holding'));

CREATE OR REPLACE FUNCTION finnor_os.assert_provider_world_root() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE root_type text; root_id uuid; root_tenant uuid; scope_row record;
BEGIN
  IF TG_TABLE_NAME='integration_source_scopes' THEN
    root_type:=NEW.root_binding_type; root_id:=NEW.root_binding_id;
  ELSE
    root_type:=NEW.world_root_type; root_id:=NEW.world_root_id;
    IF NEW.source_scope_id IS NOT NULL THEN
      SELECT tenant_id,integration_id,provider INTO scope_row FROM finnor_os.integration_source_scopes WHERE id=NEW.source_scope_id;
      IF NOT FOUND OR scope_row.tenant_id IS DISTINCT FROM NEW.tenant_id
         OR scope_row.integration_id IS DISTINCT FROM NEW.integration_id OR scope_row.provider IS DISTINCT FROM NEW.provider THEN
        RAISE EXCEPTION 'provider root binding source scope crosses tenant/integration/provider boundary';
      END IF;
    END IF;
  END IF;
  IF root_type IS NULL AND root_id IS NULL THEN RETURN NEW; END IF;
  IF root_type NOT IN ('pe_strategy','pe_opportunity','pe_deal','pe_fund','pe_vehicle','external_organization','pe_portfolio_holding') OR root_id IS NULL THEN
    RAISE EXCEPTION 'provider root binding has an unsupported or incomplete PE root';
  END IF;
  root_tenant:=finnor_os.canonical_entity_tenant(root_type,root_id);
  IF root_tenant IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'provider root binding crosses tenant boundary or root is missing'; END IF;
  RETURN NEW;
END $$;

DO $twin_security$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'pe_funds','pe_vehicles','pe_fund_vehicle_links','pe_strategy_mandates','pe_portfolio_holdings',
    'pe_company_hierarchy_relationships','pe_company_party_roles','pe_securities','pe_debt_facilities',
    'pe_debt_facility_lenders','pe_ownership_interests','pe_benchmarks','pe_metric_series',
    'pe_metric_observations','pe_benchmark_observations','pe_outcomes','pe_exits','pe_fact_coverage'
  ] LOOP
    EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON finnor_os.%I USING (tenant_id=(SELECT finnor_os.request_tenant_id())) WITH CHECK (tenant_id=(SELECT finnor_os.request_tenant_id()))',table_name);
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE ON finnor_os.%I TO finnor_app',table_name);
      EXECUTE format('REVOKE DELETE ON finnor_os.%I FROM finnor_app',table_name);
    END IF;
  END LOOP;
END $twin_security$;

REVOKE ALL ON FUNCTION finnor_os.assert_pe_twin_evidence(uuid,uuid,uuid,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.assert_pe_twin_reference() FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.assert_pe_twin_version() FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.assert_pe_twin_temporal_overlap() FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.assert_pe_metric_restatement() FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.assert_pe_benchmark_restatement() FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.assert_identity_resolution_observation() FROM PUBLIC;

COMMENT ON TABLE finnor_os.pe_portfolio_holdings IS 'Explicit post-close portfolio relationship retaining closed Deal and Core Company lineage; never inferred from IC intent.';
COMMENT ON TABLE finnor_os.pe_ownership_interests IS 'Observed economic/legal ownership facts. Partial rows never imply 100% ownership.';
COMMENT ON TABLE finnor_os.pe_metric_observations IS 'Revision-preserving observed company/portfolio metrics; separate from Underwriting calculations and benchmark observations.';
COMMENT ON TABLE finnor_os.pe_fact_coverage IS 'Exact proposition/subject/valid-period coverage required before any closed-world negative or exhaustive claim.';
COMMENT ON COLUMN finnor_os.external_ref_observations.resolution_kind IS 'Identity merge/split/correction decision lineage stored in the existing immutable Source Truth ledger.';
