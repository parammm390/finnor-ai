-- P1: transactionally complete canonical temporal truth.
--
-- Owner tables remain canonical.  This migration adds only append-only read
-- projections and installs narrowly-scoped triggers on the audited PE owners.

CREATE TABLE finnor_os.canonical_history_coverage (
  entity_type text PRIMARY KEY,
  source_table text NOT NULL,
  vertical_key text NOT NULL,
  coverage_started_at timestamptz NOT NULL,
  baseline_completed_at timestamptz NOT NULL,
  CONSTRAINT canonical_history_coverage_pe_check CHECK (vertical_key='private_equity')
);

CREATE TABLE finnor_os.canonical_entity_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  entity_version integer NOT NULL CHECK (entity_version>=1),
  snapshot jsonb NOT NULL,
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL,
  observed_at timestamptz,
  source_system text,
  external_id text,
  actor text,
  origin text NOT NULL CHECK (origin IN ('mutation','baseline')),
  previous_version_id uuid REFERENCES finnor_os.canonical_entity_versions(id),
  CONSTRAINT canonical_entity_versions_identity_key
    UNIQUE (tenant_id,entity_type,entity_id,entity_version),
  CONSTRAINT canonical_entity_versions_snapshot_bound
    CHECK (octet_length(snapshot::text)<=262144)
);
CREATE INDEX canonical_entity_versions_entity_recorded_idx
  ON finnor_os.canonical_entity_versions(tenant_id,entity_type,entity_id,recorded_at DESC,entity_version DESC);
CREATE INDEX canonical_entity_versions_tenant_recorded_idx
  ON finnor_os.canonical_entity_versions(tenant_id,recorded_at DESC,id);
CREATE INDEX canonical_entity_versions_deal_snapshot_idx
  ON finnor_os.canonical_entity_versions(tenant_id,(snapshot->>'deal_id'),recorded_at DESC)
  WHERE snapshot ? 'deal_id';

CREATE OR REPLACE FUNCTION finnor_os.forbid_canonical_history_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  RAISE EXCEPTION 'canonical history is append-only';
END $$;

CREATE TRIGGER canonical_entity_versions_immutable
  BEFORE UPDATE OR DELETE ON finnor_os.canonical_entity_versions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.forbid_canonical_history_mutation();

CREATE OR REPLACE FUNCTION finnor_os.append_canonical_entity_version() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE
  body jsonb := to_jsonb(NEW);
  kind text := TG_ARGV[0];
  prior record;
  next_version integer;
  recorded timestamptz := clock_timestamp();
  requested_origin text := coalesce(nullif(current_setting('app.canonical_history_origin',true),''),'mutation');
  origin_value text;
BEGIN
  IF kind IS NULL OR btrim(kind)='' THEN
    RAISE EXCEPTION 'canonical history trigger requires an entity type';
  END IF;
  IF body->>'tenant_id' IS NULL OR body->>'id' IS NULL THEN
    RAISE EXCEPTION 'canonical history source row lacks tenant/id';
  END IF;
  IF octet_length(body::text)>262144 THEN
    RAISE EXCEPTION 'canonical history snapshot exceeds 262144 bytes';
  END IF;
  IF requested_origin NOT IN ('mutation','baseline') THEN
    RAISE EXCEPTION 'unsupported canonical history origin';
  END IF;
  -- A normal application session cannot relabel a mutation as a migration
  -- baseline merely by setting a custom GUC.  Only a principal that itself has
  -- INSERT privilege on the protected history table may request baseline.
  origin_value := CASE
    WHEN requested_origin='baseline'
      AND has_table_privilege(session_user,'finnor_os.canonical_entity_versions','INSERT')
      THEN 'baseline'
    ELSE 'mutation'
  END;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    (body->>'tenant_id')||':'||kind||':'||(body->>'id'), 5110
  ));
  SELECT id,entity_version INTO prior
    FROM finnor_os.canonical_entity_versions
   WHERE tenant_id=(body->>'tenant_id')::uuid
     AND entity_type=kind
     AND entity_id=(body->>'id')::uuid
   ORDER BY entity_version DESC
   LIMIT 1;
  next_version := coalesce(prior.entity_version,0)+1;
  INSERT INTO finnor_os.canonical_entity_versions(
    tenant_id,entity_type,entity_id,entity_version,snapshot,snapshot_hash,
    recorded_at,observed_at,source_system,external_id,actor,origin,previous_version_id
  ) VALUES (
    (body->>'tenant_id')::uuid,kind,(body->>'id')::uuid,next_version,body,
    encode(public.digest(convert_to(body::text,'UTF8'),'sha256'),'hex'),recorded,
    CASE WHEN body->>'observed_at' IS NULL THEN NULL ELSE (body->>'observed_at')::timestamptz END,
    body->>'source_system',body->>'external_id',
    coalesce(nullif(current_setting('app.pe_actor',true),''),body->>'created_by'),
    origin_value,prior.id
  );
  RETURN NEW;
END $$;

-- Preserve each meaningful Source Truth observation.  external_refs remains the
-- converged current projection and reconciliation_cases remains the workflow owner.
CREATE TABLE finnor_os.external_ref_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  integration_id uuid NOT NULL REFERENCES finnor_os.tenant_integrations(id),
  source_link_id uuid REFERENCES finnor_os.external_refs(id),
  provider text NOT NULL CHECK (btrim(provider)<>''),
  external_object_type text NOT NULL CHECK (btrim(external_object_type)<>''),
  external_id text NOT NULL CHECK (btrim(external_id)<>''),
  canonical_entity_type text NOT NULL CHECK (btrim(canonical_entity_type)<>''),
  canonical_entity_id uuid,
  source_version text,
  source_sequence bigint CHECK (source_sequence IS NULL OR source_sequence>=0),
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  observed_hash text NOT NULL CHECK (observed_hash ~ '^[0-9a-f]{64}$'),
  observed_state jsonb NOT NULL,
  materialization_status text NOT NULL CHECK (materialization_status IN (
    'acknowledged','observed','mapped','created','updated','unchanged','duplicate',
    'out_of_order','ambiguous','unresolved','conflict','tombstoned','ignored','rejected'
  )),
  mapping_status text CHECK (mapping_status IS NULL OR mapping_status IN ('mapped','unresolved','ambiguous','tombstoned')),
  conflict_state text CHECK (conflict_state IS NULL OR conflict_state IN (
    'none','canonical_newer','external_newer','divergent','ambiguous','manual_resolution_required'
  )),
  provider_deleted boolean NOT NULL DEFAULT false,
  reason text,
  business_effect_id uuid,
  provenance jsonb NOT NULL DEFAULT '{}',
  CONSTRAINT external_ref_observations_state_bound CHECK (octet_length(observed_state::text)<=262144),
  CONSTRAINT external_ref_observations_provenance_bound CHECK (octet_length(provenance::text)<=32768)
);
CREATE INDEX external_ref_observations_external_time_idx
  ON finnor_os.external_ref_observations(
    tenant_id,integration_id,external_object_type,external_id,received_at,id
  );
CREATE INDEX external_ref_observations_canonical_time_idx
  ON finnor_os.external_ref_observations(
    tenant_id,canonical_entity_type,canonical_entity_id,received_at,id
  ) WHERE canonical_entity_id IS NOT NULL;

CREATE TRIGGER external_ref_observations_immutable
  BEFORE UPDATE OR DELETE ON finnor_os.external_ref_observations
  FOR EACH ROW EXECUTE FUNCTION finnor_os.forbid_canonical_history_mutation();

-- One migration instant is shared by all existing PE baselines.  The row's
-- current owner version remains inside snapshot; entity_version is the temporal
-- projection sequence and starts at one without inventing prior states.
DO $baseline$
DECLARE
  baseline_at timestamptz := clock_timestamp();
  owner record;
BEGIN
  FOR owner IN SELECT * FROM (VALUES
    ('pe_deal','pe_deals'),
    ('pe_deal_party','pe_deal_parties'),
    ('pe_workstream','pe_workstreams'),
    ('pe_request','pe_requests'),
    ('pe_deliverable','pe_deliverables'),
    ('pe_finding','pe_findings'),
    ('pe_deal_risk','pe_deal_risks'),
    ('pe_finding_risk_link','pe_finding_risk_links'),
    ('pe_dependency','pe_dependencies'),
    ('pe_milestone','pe_milestones'),
    ('pe_closing_condition','pe_closing_conditions'),
    ('pe_closing_item','pe_closing_items'),
    ('pe_document_link','pe_document_links'),
    ('pe_evidence_link','pe_evidence_links')
  ) AS owners(entity_type,source_table)
  LOOP
    INSERT INTO finnor_os.canonical_history_coverage(
      entity_type,source_table,vertical_key,coverage_started_at,baseline_completed_at
    ) VALUES (owner.entity_type,owner.source_table,'private_equity',baseline_at,baseline_at);
    EXECUTE format(
      'INSERT INTO finnor_os.canonical_entity_versions('
      'tenant_id,entity_type,entity_id,entity_version,snapshot,snapshot_hash,recorded_at,'
      'observed_at,source_system,external_id,actor,origin) '
      'SELECT tenant_id,$1,id,1,to_jsonb(t),'
      'encode(public.digest(convert_to(to_jsonb(t)::text,''UTF8''),''sha256''),''hex''),$2,'
      'observed_at,source_system,external_id,created_by,''baseline'' '
      'FROM finnor_os.%I t',
      owner.source_table
    ) USING owner.entity_type,baseline_at;
    EXECUTE format(
      'CREATE TRIGGER canonical_history AFTER INSERT OR UPDATE ON finnor_os.%I '
      'FOR EACH ROW EXECUTE FUNCTION finnor_os.append_canonical_entity_version(%L)',
      owner.source_table,owner.entity_type
    );
  END LOOP;
END $baseline$;

ALTER TABLE finnor_os.canonical_entity_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.canonical_entity_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finnor_os.canonical_entity_versions
  USING (tenant_id=finnor_os.request_tenant_id());

ALTER TABLE finnor_os.external_ref_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.external_ref_observations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finnor_os.external_ref_observations
  USING (tenant_id=finnor_os.request_tenant_id())
  WITH CHECK (tenant_id=finnor_os.request_tenant_id());

REVOKE ALL ON finnor_os.canonical_entity_versions,finnor_os.canonical_history_coverage,
  finnor_os.external_ref_observations FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.append_canonical_entity_version() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.forbid_canonical_history_mutation() FROM PUBLIC;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
    REVOKE ALL ON finnor_os.canonical_entity_versions,finnor_os.canonical_history_coverage,
      finnor_os.external_ref_observations FROM finnor_app;
    GRANT SELECT ON finnor_os.canonical_entity_versions,finnor_os.canonical_history_coverage,
      finnor_os.external_ref_observations TO finnor_app;
    GRANT INSERT ON finnor_os.external_ref_observations TO finnor_app;
  END IF;
END $grants$;

COMMENT ON TABLE finnor_os.canonical_entity_versions IS
  'Append-only temporal projection. Canonical writes remain exclusively owned by registered owner tables.';
COMMENT ON TABLE finnor_os.canonical_history_coverage IS
  'Explicit first-known instant per historically supported canonical PE type; no pre-baseline state is inferred.';
COMMENT ON TABLE finnor_os.external_ref_observations IS
  'Immutable Source Truth processing ledger; external_refs and reconciliation_cases keep their existing responsibilities.';
