-- Scope 5: durable epistemic graph and change inbox. Source Truth and PE remain
-- the owners of evidence and canonical values. These rows contain identities,
-- version fences, and redacted belief/impact facts only.

CREATE TABLE finnor_os.epistemic_graph_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  graph_hash text NOT NULL CHECK (graph_hash ~ '^sha256:[0-9a-f]{64}$'),
  graph_schema_version integer NOT NULL DEFAULT 2 CHECK (graph_schema_version=2),
  rule_version text NOT NULL CHECK (length(btrim(rule_version)) BETWEEN 1 AND 120),
  heuristic_version text NOT NULL CHECK (length(btrim(heuristic_version)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  frozen_at timestamptz,
  baseline_at timestamptz,
  retired_at timestamptz,
  UNIQUE (tenant_id,id),
  CHECK (baseline_at IS NULL OR (frozen_at IS NOT NULL AND baseline_at>=frozen_at)),
  CHECK (retired_at IS NULL OR (frozen_at IS NOT NULL AND retired_at>=frozen_at))
);

CREATE TABLE finnor_os.epistemic_propositions (
  tenant_id uuid NOT NULL,
  graph_version_id uuid NOT NULL,
  proposition_id text NOT NULL CHECK (length(btrim(proposition_id)) BETWEEN 1 AND 240),
  subject jsonb NOT NULL CHECK (jsonb_typeof(subject)='object' AND octet_length(subject::text)<=4096),
  predicate jsonb NOT NULL CHECK (jsonb_typeof(predicate)='object' AND octet_length(predicate::text)<=4096),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,graph_version_id,proposition_id),
  FOREIGN KEY (tenant_id,graph_version_id) REFERENCES finnor_os.epistemic_graph_versions(tenant_id,id)
);

CREATE TABLE finnor_os.epistemic_proposition_dependencies (
  tenant_id uuid NOT NULL,
  graph_version_id uuid NOT NULL,
  proposition_id text NOT NULL,
  depends_on_proposition_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('DERIVED_FROM','DECISION_REQUIRES','P2_REQUIRES')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,graph_version_id,proposition_id,depends_on_proposition_id,kind),
  FOREIGN KEY (tenant_id,graph_version_id,proposition_id)
    REFERENCES finnor_os.epistemic_propositions(tenant_id,graph_version_id,proposition_id),
  FOREIGN KEY (tenant_id,graph_version_id,depends_on_proposition_id)
    REFERENCES finnor_os.epistemic_propositions(tenant_id,graph_version_id,proposition_id),
  CHECK (proposition_id<>depends_on_proposition_id)
);
CREATE INDEX epistemic_dependencies_reverse_idx ON finnor_os.epistemic_proposition_dependencies
  (tenant_id,graph_version_id,depends_on_proposition_id,proposition_id);

CREATE TABLE finnor_os.epistemic_source_bindings (
  tenant_id uuid NOT NULL,
  graph_version_id uuid NOT NULL,
  proposition_id text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('canonical_entity','evidence_source')),
  source_type text NOT NULL CHECK (length(btrim(source_type)) BETWEEN 1 AND 120),
  source_id uuid NOT NULL,
  value_path text NOT NULL CHECK (value_path ~ '^[A-Za-z0-9_.-]{1,240}$'),
  selector jsonb NOT NULL DEFAULT '{"op":"path"}'::jsonb CHECK (
    jsonb_typeof(selector)='object' AND selector->>'op' IN ('path','constant','boolean','claim','business_hash')
    AND octet_length(selector::text)<=8192
  ),
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('CANONICAL_DB','DOCUMENT','PROVIDER_OBSERVATION')),
  max_age_ms bigint CHECK (max_age_ms IS NULL OR max_age_ms BETWEEN 0 AND 315360000000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,graph_version_id,proposition_id,source_kind,source_type,source_id,value_path),
  FOREIGN KEY (tenant_id,graph_version_id,proposition_id)
    REFERENCES finnor_os.epistemic_propositions(tenant_id,graph_version_id,proposition_id),
  CHECK ((source_kind='canonical_entity')=(evidence_kind='CANONICAL_DB'))
);
CREATE INDEX epistemic_source_lookup_idx ON finnor_os.epistemic_source_bindings
  (tenant_id,graph_version_id,source_kind,source_type,source_id,proposition_id);

CREATE TABLE finnor_os.epistemic_runtime_controls (
  tenant_id uuid PRIMARY KEY REFERENCES finnor_os.tenants(id),
  graph_version_id uuid NOT NULL,
  mode text NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow','active','refreshing','disabled')),
  kill_switch boolean NOT NULL DEFAULT false,
  graph_structure_epoch bigint NOT NULL DEFAULT 0 CHECK (graph_structure_epoch>=0),
  staged_structure_epoch bigint NOT NULL DEFAULT 0 CHECK (staged_structure_epoch>=0),
  baseline_started_at timestamptz,
  baseline_completed_at timestamptz,
  shadow_verified_at timestamptz,
  shadow_verified_change_order bigint,
  activated_at timestamptz,
  activated_release_sha text CHECK (activated_release_sha IS NULL OR activated_release_sha ~ '^[0-9a-f]{40}$'),
  minimum_worker_protocol integer NOT NULL DEFAULT 2 CHECK (minimum_worker_protocol=2),
  processing_change_id uuid,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,graph_version_id) REFERENCES finnor_os.epistemic_graph_versions(tenant_id,id),
  CHECK (baseline_completed_at IS NULL OR baseline_started_at IS NOT NULL),
  CHECK ((shadow_verified_at IS NULL)=(shadow_verified_change_order IS NULL)),
  CHECK (mode<>'active' OR (baseline_completed_at IS NOT NULL AND shadow_verified_at IS NOT NULL
    AND activated_at IS NOT NULL AND activated_release_sha IS NOT NULL))
);

CREATE TABLE finnor_os.epistemic_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ingestion_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  graph_version_id uuid NOT NULL,
  semantic_key text NOT NULL CHECK (length(btrim(semantic_key)) BETWEEN 1 AND 360),
  source_kind text NOT NULL CHECK (source_kind IN ('canonical_entity_version','evidence_source_version','freshness','graph_revision')),
  source_version_id uuid,
  source_type text,
  source_entity_id uuid,
  target_proposition_id text,
  source_owner text NOT NULL CHECK (length(btrim(source_owner)) BETWEEN 1 AND 160),
  observed_at timestamptz,
  valid_at timestamptz,
  known_at timestamptz NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','processed')),
  processed_at timestamptz,
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,semantic_key),
  FOREIGN KEY (tenant_id,graph_version_id) REFERENCES finnor_os.epistemic_graph_versions(tenant_id,id),
  FOREIGN KEY (tenant_id,graph_version_id,target_proposition_id)
    REFERENCES finnor_os.epistemic_propositions(tenant_id,graph_version_id,proposition_id),
  CHECK ((source_kind IN ('canonical_entity_version','evidence_source_version'))=(source_version_id IS NOT NULL)),
  CHECK ((source_kind='freshness')=(target_proposition_id IS NOT NULL)),
  CHECK ((status='processed')=(processed_at IS NOT NULL))
);
CREATE INDEX epistemic_changes_pending_idx ON finnor_os.epistemic_changes
  (tenant_id,ingestion_order) WHERE status<>'processed';
CREATE INDEX epistemic_changes_source_idx ON finnor_os.epistemic_changes
  (tenant_id,source_kind,source_version_id) WHERE source_version_id IS NOT NULL;
ALTER TABLE finnor_os.epistemic_runtime_controls
  ADD CONSTRAINT epistemic_runtime_processing_change_fkey FOREIGN KEY (tenant_id,processing_change_id)
  REFERENCES finnor_os.epistemic_changes(tenant_id,id);

CREATE TABLE finnor_os.epistemic_current (
  tenant_id uuid NOT NULL,
  graph_version_id uuid NOT NULL,
  proposition_id text NOT NULL,
  belief jsonb NOT NULL CHECK (jsonb_typeof(belief)='object' AND octet_length(belief::text)<=16384),
  semantic_hash text NOT NULL CHECK (semantic_hash ~ '^sha256:[0-9a-f]{64}$'),
  known_at timestamptz NOT NULL,
  next_freshness_at timestamptz,
  updated_change_id uuid,
  PRIMARY KEY (tenant_id,graph_version_id,proposition_id),
  FOREIGN KEY (tenant_id,graph_version_id,proposition_id)
    REFERENCES finnor_os.epistemic_propositions(tenant_id,graph_version_id,proposition_id),
  FOREIGN KEY (tenant_id,updated_change_id) REFERENCES finnor_os.epistemic_changes(tenant_id,id),
  CHECK (NOT (belief ? 'value') AND NOT (belief ? 'rawEvidence'))
);
CREATE INDEX epistemic_freshness_due_idx ON finnor_os.epistemic_current
  (tenant_id,next_freshness_at,proposition_id) WHERE next_freshness_at IS NOT NULL;

CREATE TABLE finnor_os.epistemic_frontier (
  tenant_id uuid NOT NULL,
  change_id uuid NOT NULL,
  proposition_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','evaluated')),
  cause_proposition_id text,
  cause_dependency_kind text,
  before_belief jsonb,
  after_belief jsonb,
  after_semantic_hash text CHECK (after_semantic_hash IS NULL OR after_semantic_hash ~ '^sha256:[0-9a-f]{64}$'),
  next_freshness_at timestamptz,
  evaluated_at timestamptz,
  PRIMARY KEY (tenant_id,change_id,proposition_id),
  FOREIGN KEY (tenant_id,change_id) REFERENCES finnor_os.epistemic_changes(tenant_id,id),
  CHECK ((status='evaluated')=(after_belief IS NOT NULL AND after_semantic_hash IS NOT NULL AND evaluated_at IS NOT NULL)),
  CHECK ((cause_proposition_id IS NULL)=(cause_dependency_kind IS NULL))
);
CREATE INDEX epistemic_frontier_pending_idx ON finnor_os.epistemic_frontier
  (tenant_id,change_id,proposition_id) WHERE status='pending';
CREATE TABLE finnor_os.epistemic_frontier_causes (
  tenant_id uuid NOT NULL,
  change_id uuid NOT NULL,
  proposition_id text NOT NULL,
  cause_proposition_id text NOT NULL,
  dependency_kind text NOT NULL CHECK (dependency_kind IN ('DERIVED_FROM','DECISION_REQUIRES','P2_REQUIRES')),
  PRIMARY KEY (tenant_id,change_id,proposition_id,cause_proposition_id,dependency_kind),
  FOREIGN KEY (tenant_id,change_id,proposition_id)
    REFERENCES finnor_os.epistemic_frontier(tenant_id,change_id,proposition_id)
);

CREATE TABLE finnor_os.epistemic_changesets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  change_id uuid NOT NULL,
  graph_version_id uuid NOT NULL,
  rule_version text NOT NULL,
  heuristic_version text NOT NULL,
  semantic_deltas jsonb NOT NULL CHECK (jsonb_typeof(semantic_deltas)='array' AND octet_length(semantic_deltas::text)<=1048576),
  materiality jsonb NOT NULL CHECK (jsonb_typeof(materiality)='object' AND octet_length(materiality::text)<=262144),
  operational_enabled boolean NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,change_id),
  FOREIGN KEY (tenant_id,change_id) REFERENCES finnor_os.epistemic_changes(tenant_id,id),
  FOREIGN KEY (tenant_id,graph_version_id) REFERENCES finnor_os.epistemic_graph_versions(tenant_id,id)
);

CREATE TABLE finnor_os.epistemic_impact_paths (
  tenant_id uuid NOT NULL,
  changeset_id uuid NOT NULL,
  proposition_id text NOT NULL,
  object_kind text NOT NULL CHECK (object_kind IN ('pe_assumption','underwriting_model_input','underwriting_model_node','underwriting_run','pe_finding','pe_deal_risk','pe_ic_question','pe_ic_condition','pe_ic_decision','pe_decision','work_plan_node')),
  object_id text NOT NULL CHECK (length(btrim(object_id)) BETWEEN 1 AND 240),
  edge_kind text NOT NULL CHECK (length(btrim(edge_kind)) BETWEEN 1 AND 120),
  path jsonb NOT NULL CHECK (jsonb_typeof(path)='array' AND octet_length(path::text)<=16384),
  materiality text NOT NULL CHECK (materiality IN ('informational','review','blocking')),
  consequence text NOT NULL CHECK (consequence IN ('none','review_required','rerun_required','replan_required','block_consequential')),
  rule_version text NOT NULL,
  PRIMARY KEY (tenant_id,changeset_id,proposition_id,object_kind,object_id,edge_kind),
  FOREIGN KEY (tenant_id,changeset_id) REFERENCES finnor_os.epistemic_changesets(tenant_id,id)
);
CREATE INDEX epistemic_impact_object_idx ON finnor_os.epistemic_impact_paths
  (tenant_id,object_kind,object_id,changeset_id);

-- Planning owns the immutable pin. Only explicit PlanGraph preconditions with a
-- verified proposition identity can be recorded here; a Deal association alone
-- never constitutes a node dependency.
CREATE TABLE finnor_os.epistemic_plan_pins (
  tenant_id uuid NOT NULL,
  graph_version_id uuid NOT NULL,
  plan_revision_id uuid NOT NULL,
  plan_node_id text NOT NULL,
  proposition_id text NOT NULL,
  pinned_semantic_hash text NOT NULL CHECK (pinned_semantic_hash ~ '^sha256:[0-9a-f]{64}$'),
  mandatory boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,plan_revision_id,plan_node_id,proposition_id),
  FOREIGN KEY (tenant_id,graph_version_id,proposition_id)
    REFERENCES finnor_os.epistemic_propositions(tenant_id,graph_version_id,proposition_id),
  FOREIGN KEY (tenant_id,plan_revision_id) REFERENCES finnor_os.work_plan_revisions(tenant_id,id)
);
CREATE INDEX epistemic_plan_pins_reverse_idx ON finnor_os.epistemic_plan_pins
  (tenant_id,graph_version_id,proposition_id,plan_revision_id,plan_node_id);

CREATE TABLE finnor_os.epistemic_calibration_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  graph_version_id uuid NOT NULL,
  proposition_id text NOT NULL,
  decision_id uuid NOT NULL,
  assessed_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('KNOWN','UNKNOWN','STALE','CONFLICTING','UNCERTAIN')),
  confidence_level text NOT NULL CHECK (confidence_level IN ('VERIFIED','HIGH','MEDIUM','LOW','UNSUPPORTED')),
  belief_value_hash text NOT NULL CHECK (belief_value_hash ~ '^sha256:[0-9a-f]{64}$'),
  source_authority text,
  heuristic_version text NOT NULL,
  evidence_refs jsonb NOT NULL CHECK (jsonb_typeof(evidence_refs)='array' AND octet_length(evidence_refs::text)<=16384),
  assessment_hash text NOT NULL CHECK (assessment_hash ~ '^sha256:[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,decision_id,proposition_id),
  FOREIGN KEY (tenant_id,graph_version_id,proposition_id)
    REFERENCES finnor_os.epistemic_propositions(tenant_id,graph_version_id,proposition_id),
  FOREIGN KEY (tenant_id,decision_id) REFERENCES finnor_os.pe_decisions(tenant_id,id)
);
CREATE TABLE finnor_os.epistemic_calibration_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  assessment_id uuid NOT NULL,
  outcome_id uuid NOT NULL,
  comparison text NOT NULL CHECK (comparison IN ('SUPPORTED','CONTRADICTED','INCONCLUSIVE')),
  comparison_rule_version text NOT NULL,
  comparison_facts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(comparison_facts)='object' AND octet_length(comparison_facts::text)<=16384
    AND NOT (comparison_facts ? 'observedValue') AND NOT (comparison_facts ? 'assessmentValue')
  ),
  compared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,assessment_id,outcome_id),
  FOREIGN KEY (tenant_id,assessment_id) REFERENCES finnor_os.epistemic_calibration_assessments(tenant_id,id),
  FOREIGN KEY (tenant_id,outcome_id) REFERENCES finnor_os.pe_outcomes(tenant_id,id)
);

-- Graph definitions are frozen before baseline. A dependency cycle is rejected
-- under a graph-scoped advisory lock, so concurrent edge inserts cannot race.
CREATE OR REPLACE FUNCTION finnor_os.guard_epistemic_graph_definition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE graph_id uuid; tenant uuid; frozen timestamptz; has_cycle boolean;
BEGIN
  graph_id:=CASE WHEN TG_OP='DELETE' THEN OLD.graph_version_id ELSE NEW.graph_version_id END;
  tenant:=CASE WHEN TG_OP='DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text||':'||graph_id::text,5140));
  SELECT frozen_at INTO frozen FROM finnor_os.epistemic_graph_versions
   WHERE tenant_id=tenant AND id=graph_id FOR SHARE;
  IF frozen IS NOT NULL THEN RAISE EXCEPTION 'frozen epistemic graph definition cannot be edited'; END IF;
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'epistemic graph definitions are insert-only; create a new graph version'; END IF;
  IF TG_TABLE_NAME='epistemic_proposition_dependencies' AND TG_OP='INSERT' THEN
    WITH RECURSIVE ancestors(id) AS (
      SELECT NEW.depends_on_proposition_id
      UNION
      SELECT d.depends_on_proposition_id FROM finnor_os.epistemic_proposition_dependencies d
       JOIN ancestors a ON d.proposition_id=a.id
       WHERE d.tenant_id=tenant AND d.graph_version_id=graph_id
    ) SELECT EXISTS(SELECT 1 FROM ancestors WHERE id=NEW.proposition_id) INTO has_cycle;
    IF has_cycle THEN RAISE EXCEPTION 'epistemic proposition dependency cycle'; END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.guard_epistemic_graph_version() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'epistemic graph versions are immutable'; END IF;
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.graph_hash IS DISTINCT FROM NEW.graph_hash
    OR OLD.graph_schema_version IS DISTINCT FROM NEW.graph_schema_version
    OR OLD.rule_version IS DISTINCT FROM NEW.rule_version
    OR OLD.heuristic_version IS DISTINCT FROM NEW.heuristic_version
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR (OLD.frozen_at IS NOT NULL AND OLD.frozen_at IS DISTINCT FROM NEW.frozen_at)
    OR (OLD.baseline_at IS NOT NULL AND OLD.baseline_at IS DISTINCT FROM NEW.baseline_at)
    OR (OLD.retired_at IS NOT NULL AND OLD.retired_at IS DISTINCT FROM NEW.retired_at) THEN
    RAISE EXCEPTION 'epistemic graph version identity and rule fences are immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.verify_epistemic_source_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE source_row record;
BEGIN
  IF NEW.source_kind='canonical_entity' THEN
    IF NOT EXISTS (SELECT 1 FROM finnor_os.canonical_entity_versions v
      JOIN finnor_os.canonical_truth_registry r ON r.entity_type=v.entity_type AND r.active
      WHERE v.tenant_id=NEW.tenant_id AND v.entity_type=NEW.source_type AND v.entity_id=NEW.source_id) THEN
      RAISE EXCEPTION 'epistemic canonical source is missing, inactive, owner-unregistered, or crosses tenant boundary';
    END IF;
  ELSE
    SELECT scope,tenant_id,source_type INTO source_row FROM finnor_os.evidence_sources WHERE id=NEW.source_id;
    -- Durable public-source fanout would need an atomic change for every staged
    -- tenant. Scope 5 deliberately binds only tenant-owned evidence so a source
    -- commit and its one logical change remain in the same transaction.
    IF source_row.scope IS DISTINCT FROM 'tenant'
       OR source_row.source_type IS DISTINCT FROM NEW.source_type
       OR source_row.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'epistemic evidence source must be tenant-owned, correctly typed, and tenant-consistent';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER epistemic_propositions_graph_guard BEFORE INSERT OR UPDATE OR DELETE
  ON finnor_os.epistemic_propositions FOR EACH ROW EXECUTE FUNCTION finnor_os.guard_epistemic_graph_definition();
CREATE TRIGGER epistemic_dependencies_graph_guard BEFORE INSERT OR UPDATE OR DELETE
  ON finnor_os.epistemic_proposition_dependencies FOR EACH ROW EXECUTE FUNCTION finnor_os.guard_epistemic_graph_definition();
CREATE TRIGGER epistemic_bindings_graph_guard BEFORE INSERT OR UPDATE OR DELETE
  ON finnor_os.epistemic_source_bindings FOR EACH ROW EXECUTE FUNCTION finnor_os.guard_epistemic_graph_definition();
CREATE TRIGGER epistemic_bindings_owner_guard BEFORE INSERT OR UPDATE OF source_kind,source_type,source_id,tenant_id
  ON finnor_os.epistemic_source_bindings FOR EACH ROW EXECUTE FUNCTION finnor_os.verify_epistemic_source_binding();
CREATE TRIGGER epistemic_graph_version_guard BEFORE UPDATE OR DELETE
  ON finnor_os.epistemic_graph_versions FOR EACH ROW EXECUTE FUNCTION finnor_os.guard_epistemic_graph_version();

-- The existing Scope-3 queue is the only worker engine. A new physical job type
-- plus protocol 2 makes pre-Scope-5 workers unable to claim these obligations.
INSERT INTO finnor_os.compute_job_type_policies
  (job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
VALUES
  ('process_epistemic_change_v2','BACKGROUND',ARRAY['BACKGROUND'],'fixed','tenant','required',1,'Durable Scope-5 change processing with graph and schema fences.'),
  ('scan_epistemic_freshness_v2','BACKGROUND',ARRAY['BACKGROUND'],'fixed','tenant','coalescible',1,'Indexed bounded due-freshness discovery.'),
  ('recover_epistemic_changes_v2','BACKGROUND',ARRAY['BACKGROUND'],'fixed','tenant','coalescible',1,'Repair missing or terminal physical queue delivery for accepted epistemic changes.');
INSERT INTO finnor_os.compute_job_type_policies
  (job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
VALUES
  ('refresh_epistemic_graph_v2','BACKGROUND',ARRAY['BACKGROUND'],'fixed','tenant','coalescible',1,'Rebuild a graph after a newly relevant PE entity or evidence link; active execution remains fenced until reverified.');

CREATE OR REPLACE FUNCTION finnor_os.capture_epistemic_source_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
DECLARE tenant uuid; graph_id uuid; change_id uuid; semantic text; kind text; owner_name text; owner_vertical text; runtime_mode text;
  structure_epoch bigint; relevant_unbound boolean;
  source_type_name text; source_entity uuid; source_observed timestamptz; source_valid timestamptz; source_known timestamptz;
BEGIN
  IF TG_TABLE_NAME='canonical_entity_versions' THEN
    IF NEW.origin='baseline' THEN RETURN NEW; END IF;
    tenant:=NEW.tenant_id; kind:='canonical_entity_version'; semantic:='canonical:'||NEW.id::text;
    SELECT writable_owner,vertical_key INTO owner_name,owner_vertical FROM finnor_os.canonical_truth_registry
      WHERE entity_type=NEW.entity_type AND active;
    IF owner_name IS NULL THEN RAISE EXCEPTION 'canonical source type % has no active writable owner',NEW.entity_type; END IF;
    source_type_name:=NEW.entity_type; source_entity:=NEW.entity_id;
    source_observed:=NEW.observed_at; source_valid:=coalesce(nullif(NEW.snapshot->>'valid_from','')::timestamptz,
      nullif(NEW.snapshot->>'period_start','')::timestamptz,NEW.recorded_at); source_known:=NEW.recorded_at;
  ELSIF TG_TABLE_NAME='evidence_source_versions' THEN
    IF NEW.scope<>'tenant' THEN RETURN NEW; END IF;
    tenant:=NEW.tenant_id; kind:='evidence_source_version'; semantic:='evidence:'||NEW.id::text;
    owner_name:='@finnor/evidence-corpus';
    SELECT source_type INTO source_type_name FROM finnor_os.evidence_sources WHERE id=NEW.source_id;
    source_entity:=NEW.source_id; source_observed:=NEW.as_of; source_valid:=NEW.as_of; source_known:=NEW.retrieved_at;
  ELSE
    RAISE EXCEPTION 'unsupported epistemic capture source %',TG_TABLE_NAME;
  END IF;
  -- Baseline and source commits serialize at the tenant seam. A source mutation
  -- either appears in the baseline snapshot or commits with a durable change/job.
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text,5141));
  SELECT graph_version_id,mode INTO graph_id,runtime_mode
    FROM finnor_os.epistemic_runtime_controls WHERE tenant_id=tenant FOR UPDATE;
  IF graph_id IS NULL THEN RETURN NEW; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM finnor_os.epistemic_source_bindings b
    WHERE b.tenant_id=tenant AND b.graph_version_id=graph_id
      AND b.source_kind=CASE WHEN kind='canonical_entity_version' THEN 'canonical_entity' ELSE 'evidence_source' END
      AND b.source_type=source_type_name AND b.source_id=source_entity
  ) THEN
    relevant_unbound := (kind='canonical_entity_version' AND owner_vertical='private_equity')
      OR (kind='evidence_source_version' AND EXISTS (
        SELECT 1 FROM finnor_os.pe_evidence_links l
        WHERE l.tenant_id=tenant AND l.evidence_source_id=source_entity AND l.archived_at IS NULL));
    IF relevant_unbound THEN
      UPDATE finnor_os.epistemic_runtime_controls
        SET graph_structure_epoch=graph_structure_epoch+1,
          shadow_verified_at=CASE WHEN mode IN ('shadow','refreshing') THEN NULL ELSE shadow_verified_at END,
          shadow_verified_change_order=CASE WHEN mode IN ('shadow','refreshing') THEN NULL ELSE shadow_verified_change_order END,
          updated_at=clock_timestamp()
        WHERE tenant_id=tenant RETURNING graph_structure_epoch INTO structure_epoch;
      INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,protocol_version,lane,max_attempts)
      VALUES(tenant,'refresh_epistemic_graph_v2',
        jsonb_build_object('tenantId',tenant,'structureEpoch',structure_epoch,'schemaVersion',2),
        'epistemic-graph-refresh:'||tenant::text||':'||structure_epoch::text,2,'batch',100);
    ELSE
      RETURN NEW;
    END IF;
  END IF;
  INSERT INTO finnor_os.epistemic_changes(
    tenant_id,graph_version_id,semantic_key,source_kind,source_version_id,source_type,
    source_entity_id,source_owner,observed_at,valid_at,known_at)
  VALUES (tenant,graph_id,semantic,kind,NEW.id,source_type_name,source_entity,owner_name,
    source_observed,source_valid,source_known)
  ON CONFLICT (tenant_id,semantic_key) DO NOTHING RETURNING id INTO change_id;
  IF change_id IS NOT NULL THEN
    IF runtime_mode='shadow' THEN
      UPDATE finnor_os.epistemic_runtime_controls
        SET shadow_verified_at=NULL,shadow_verified_change_order=NULL,updated_at=clock_timestamp()
        WHERE tenant_id=tenant;
    END IF;
    INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,protocol_version,lane,max_attempts)
    VALUES (tenant,'process_epistemic_change_v2',jsonb_build_object('tenantId',tenant,'changeId',change_id,'schemaVersion',2),
      'epistemic-change:'||change_id::text,2,'batch',10);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION finnor_os.capture_epistemic_source_change() FROM PUBLIC;
CREATE TRIGGER canonical_entity_epistemic_change AFTER INSERT ON finnor_os.canonical_entity_versions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.capture_epistemic_source_change();
CREATE TRIGGER evidence_version_epistemic_change AFTER INSERT ON finnor_os.evidence_source_versions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.capture_epistemic_source_change();

-- Logical history is append-only. Current state, frontiers and controls are the
-- bounded mutable projections; source changes and completed institutional facts
-- retain stable identities across retries and restarts.
CREATE OR REPLACE FUNCTION finnor_os.guard_epistemic_change_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'epistemic changes are immutable'; END IF;
  IF OLD.id IS DISTINCT FROM NEW.id OR OLD.ingestion_order IS DISTINCT FROM NEW.ingestion_order
    OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.graph_version_id IS DISTINCT FROM NEW.graph_version_id
    OR OLD.semantic_key IS DISTINCT FROM NEW.semantic_key OR OLD.source_kind IS DISTINCT FROM NEW.source_kind
    OR OLD.source_version_id IS DISTINCT FROM NEW.source_version_id OR OLD.source_type IS DISTINCT FROM NEW.source_type
    OR OLD.source_entity_id IS DISTINCT FROM NEW.source_entity_id
    OR OLD.target_proposition_id IS DISTINCT FROM NEW.target_proposition_id
    OR OLD.source_owner IS DISTINCT FROM NEW.source_owner OR OLD.observed_at IS DISTINCT FROM NEW.observed_at
    OR OLD.valid_at IS DISTINCT FROM NEW.valid_at OR OLD.known_at IS DISTINCT FROM NEW.known_at
    OR OLD.accepted_at IS DISTINCT FROM NEW.accepted_at THEN
    RAISE EXCEPTION 'epistemic change identity and source facts are immutable';
  END IF;
  IF NOT ((OLD.status='pending' AND NEW.status IN ('pending','processing'))
       OR (OLD.status='processing' AND NEW.status IN ('processing','processed'))
       OR (OLD.status='processed' AND NEW.status='processed')) THEN
    RAISE EXCEPTION 'invalid epistemic change status transition % -> %',OLD.status,NEW.status;
  END IF;
  IF NEW.status='processed' AND NEW.processed_at IS NULL THEN
    RAISE EXCEPTION 'processed epistemic change requires processed_at';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION finnor_os.reject_epistemic_fact_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  RAISE EXCEPTION '% is immutable',TG_TABLE_NAME;
END $$;

CREATE TRIGGER epistemic_changes_history_guard BEFORE UPDATE OR DELETE ON finnor_os.epistemic_changes
  FOR EACH ROW EXECUTE FUNCTION finnor_os.guard_epistemic_change_history();
CREATE TRIGGER epistemic_changesets_immutable BEFORE UPDATE OR DELETE ON finnor_os.epistemic_changesets
  FOR EACH ROW EXECUTE FUNCTION finnor_os.reject_epistemic_fact_mutation();
CREATE TRIGGER epistemic_impact_paths_immutable BEFORE UPDATE OR DELETE ON finnor_os.epistemic_impact_paths
  FOR EACH ROW EXECUTE FUNCTION finnor_os.reject_epistemic_fact_mutation();
CREATE TRIGGER epistemic_plan_pins_immutable BEFORE UPDATE OR DELETE ON finnor_os.epistemic_plan_pins
  FOR EACH ROW EXECUTE FUNCTION finnor_os.reject_epistemic_fact_mutation();
CREATE TRIGGER epistemic_calibration_assessments_immutable BEFORE UPDATE OR DELETE ON finnor_os.epistemic_calibration_assessments
  FOR EACH ROW EXECUTE FUNCTION finnor_os.reject_epistemic_fact_mutation();
CREATE TRIGGER epistemic_calibration_outcomes_immutable BEFORE UPDATE OR DELETE ON finnor_os.epistemic_calibration_outcomes
  FOR EACH ROW EXECUTE FUNCTION finnor_os.reject_epistemic_fact_mutation();
REVOKE ALL ON FUNCTION finnor_os.guard_epistemic_change_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION finnor_os.reject_epistemic_fact_mutation() FROM PUBLIC;

-- A final PE Decision captures only the exact proposition pins of its owning
-- PlanNode. Decisions without an explicit Plan pin receive no fabricated
-- assessment. The PE decision mutation remains the transaction owner.
CREATE OR REPLACE FUNCTION finnor_os.capture_epistemic_decision_assessments() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF NEW.state<>'final' OR OLD.state='final' OR NEW.external_id IS NULL
     OR NEW.external_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RETURN NEW;
  END IF;
  INSERT INTO finnor_os.epistemic_calibration_assessments(
    tenant_id,graph_version_id,proposition_id,decision_id,assessed_at,status,confidence_level,
    belief_value_hash,source_authority,heuristic_version,evidence_refs,assessment_hash)
  SELECT NEW.tenant_id,p.graph_version_id,p.proposition_id,NEW.id,coalesce(NEW.decided_at,clock_timestamp()),
    c.belief->>'status',c.belief->'confidence'->>'level',c.belief->>'valueHash',c.belief->>'sourceAuthority',
    g.heuristic_version,
    coalesce((SELECT jsonb_agg(DISTINCT refs.value ORDER BY refs.value) FROM jsonb_array_elements_text(
      coalesce(c.belief->'selectedEvidenceRefs','[]'::jsonb)||coalesce(c.belief->'contradictingEvidenceRefs','[]'::jsonb)
    ) AS refs(value)),'[]'::jsonb),
    'sha256:'||encode(public.digest(convert_to(jsonb_build_object(
      'decisionId',NEW.id,'graphVersionId',p.graph_version_id,'propositionId',p.proposition_id,
      'semanticHash',c.semantic_hash,'heuristicVersion',g.heuristic_version
    )::text,'UTF8'),'sha256'),'hex')
  FROM finnor_os.domain_actions a
  JOIN finnor_os.epistemic_plan_pins p ON p.tenant_id=a.tenant_id
    AND p.plan_revision_id=a.plan_revision_id AND p.plan_node_id=a.plan_node_id
  JOIN finnor_os.epistemic_current c ON c.tenant_id=p.tenant_id AND c.graph_version_id=p.graph_version_id
    AND c.proposition_id=p.proposition_id
    AND c.semantic_hash=p.pinned_semantic_hash AND c.known_at<=NEW.decided_at
  JOIN finnor_os.epistemic_graph_versions g ON g.tenant_id=p.tenant_id AND g.id=p.graph_version_id
  JOIN finnor_os.epistemic_runtime_controls rc ON rc.tenant_id=p.tenant_id
    AND rc.graph_version_id=p.graph_version_id AND rc.mode IN ('shadow','active')
    AND rc.baseline_completed_at IS NOT NULL
    AND rc.graph_structure_epoch=rc.staged_structure_epoch
    AND rc.processing_change_id IS NULL
  WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.external_id::uuid
    AND NOT EXISTS (SELECT 1 FROM finnor_os.epistemic_changes pending
      WHERE pending.tenant_id=NEW.tenant_id AND pending.status<>'processed')
  ON CONFLICT(tenant_id,decision_id,proposition_id) DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION finnor_os.capture_epistemic_decision_assessments() FROM PUBLIC;
CREATE TRIGGER pe_decision_epistemic_assessment BEFORE UPDATE OF state ON finnor_os.pe_decisions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.capture_epistemic_decision_assessments();

-- Existing execution owners call this inside their own final mutation
-- transaction while holding advisory namespace 5141. It returns dependency-local
-- reasons; it never grants Authority or performs a business effect.
CREATE OR REPLACE FUNCTION finnor_os.epistemic_execution_block_reasons(
  p_tenant_id uuid,
  p_plan_revision_id uuid,
  p_plan_node_id text,
  p_require_pins boolean DEFAULT true
) RETURNS text[]
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE control_row record; reasons text[]:=ARRAY[]::text[]; pin_count integer;
BEGIN
  SELECT * INTO control_row FROM finnor_os.epistemic_runtime_controls WHERE tenant_id=p_tenant_id;
  IF control_row.tenant_id IS NULL OR control_row.mode NOT IN ('active','refreshing') OR control_row.kill_switch THEN
    RETURN reasons;
  END IF;
  IF control_row.mode='refreshing' OR control_row.graph_structure_epoch<>control_row.staged_structure_epoch THEN
    RETURN ARRAY['EPISTEMIC_GRAPH_REFRESH_REQUIRED']::text[];
  END IF;
  IF p_plan_revision_id IS NULL OR p_plan_node_id IS NULL OR btrim(p_plan_node_id)='' THEN
    IF p_require_pins THEN reasons:=array_append(reasons,'EPISTEMIC_PLAN_PIN_REQUIRED'); END IF;
    RETURN reasons;
  END IF;
  SELECT count(*) INTO pin_count FROM finnor_os.epistemic_plan_pins
    WHERE tenant_id=p_tenant_id AND plan_revision_id=p_plan_revision_id AND plan_node_id=p_plan_node_id;
  IF pin_count=0 THEN
    IF p_require_pins THEN reasons:=array_append(reasons,'EPISTEMIC_PLAN_PIN_REQUIRED'); END IF;
    RETURN reasons;
  END IF;
  IF control_row.processing_change_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM finnor_os.epistemic_changes WHERE tenant_id=p_tenant_id AND status<>'processed'
  ) THEN reasons:=array_append(reasons,'EPISTEMIC_CHANGE_PENDING'); END IF;
  IF EXISTS (
    SELECT 1 FROM finnor_os.epistemic_plan_pins p
    WHERE p.tenant_id=p_tenant_id AND p.plan_revision_id=p_plan_revision_id AND p.plan_node_id=p_plan_node_id
      AND p.graph_version_id<>control_row.graph_version_id
  ) THEN reasons:=array_append(reasons,'EPISTEMIC_GRAPH_VERSION_STALE'); END IF;
  IF EXISTS (
    SELECT 1 FROM finnor_os.epistemic_plan_pins p
    LEFT JOIN finnor_os.epistemic_current c
      ON c.tenant_id=p.tenant_id AND c.graph_version_id=p.graph_version_id AND c.proposition_id=p.proposition_id
    WHERE p.tenant_id=p_tenant_id AND p.plan_revision_id=p_plan_revision_id AND p.plan_node_id=p_plan_node_id
      AND (c.proposition_id IS NULL OR c.semantic_hash<>p.pinned_semantic_hash)
  ) THEN reasons:=array_append(reasons,'EPISTEMIC_PIN_STALE'); END IF;
  IF EXISTS (
    SELECT 1 FROM finnor_os.epistemic_plan_pins p
    LEFT JOIN finnor_os.epistemic_current c
      ON c.tenant_id=p.tenant_id AND c.graph_version_id=p.graph_version_id AND c.proposition_id=p.proposition_id
    WHERE p.tenant_id=p_tenant_id AND p.plan_revision_id=p_plan_revision_id AND p.plan_node_id=p_plan_node_id
      AND p.mandatory AND coalesce(c.belief->>'status','UNKNOWN')<>'KNOWN'
  ) THEN reasons:=array_append(reasons,'MANDATORY_EPISTEMIC_UNRESOLVED'); END IF;
  IF EXISTS (
    SELECT 1 FROM finnor_os.epistemic_plan_pins p JOIN finnor_os.epistemic_current c
      ON c.tenant_id=p.tenant_id AND c.graph_version_id=p.graph_version_id AND c.proposition_id=p.proposition_id
    WHERE p.tenant_id=p_tenant_id AND p.plan_revision_id=p_plan_revision_id AND p.plan_node_id=p_plan_node_id
      AND c.next_freshness_at<=clock_timestamp()
  ) THEN reasons:=array_append(reasons,'EPISTEMIC_FRESHNESS_DUE'); END IF;
  RETURN ARRAY(SELECT DISTINCT reason FROM unnest(reasons) reason ORDER BY reason);
END $$;
REVOKE ALL ON FUNCTION finnor_os.epistemic_execution_block_reasons(uuid,uuid,text,boolean) FROM PUBLIC;

-- No pre-0140 epistemic history is invented. Existing evidence/canonical history
-- remains with its owners; a graph baseline is established explicitly afterward.
DO $rls$
DECLARE name text;
BEGIN
  FOREACH name IN ARRAY ARRAY[
    'epistemic_graph_versions','epistemic_propositions','epistemic_proposition_dependencies',
    'epistemic_source_bindings','epistemic_runtime_controls','epistemic_changes',
    'epistemic_current','epistemic_frontier','epistemic_frontier_causes','epistemic_changesets',
    'epistemic_impact_paths','epistemic_plan_pins','epistemic_calibration_assessments','epistemic_calibration_outcomes'
  ] LOOP
    EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',name);
    EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',name);
    EXECUTE format('CREATE POLICY tenant_isolation ON finnor_os.%I USING (tenant_id=finnor_os.request_tenant_id()) WITH CHECK (tenant_id=finnor_os.request_tenant_id())',name);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
      EXECUTE format('GRANT SELECT,INSERT,UPDATE ON finnor_os.%I TO finnor_app',name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
    GRANT EXECUTE ON FUNCTION finnor_os.epistemic_execution_block_reasons(uuid,uuid,text,boolean) TO finnor_app;
  END IF;
END $rls$;
