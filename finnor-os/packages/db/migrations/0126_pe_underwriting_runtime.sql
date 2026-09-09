-- P4: deterministic Private Equity underwriting runtime.
-- P1 owns InvestmentCase/Assumption/Decision/Risk; P3 owns artifacts.
-- These immutable calculation rows are intentionally not canonical-world entities.

ALTER TABLE finnor_os.pe_investment_cases
  ADD CONSTRAINT pe_investment_cases_tenant_id_id_key UNIQUE (tenant_id,id);
ALTER TABLE finnor_os.pe_assumptions
  ADD CONSTRAINT pe_assumptions_tenant_case_id_key UNIQUE (tenant_id,investment_case_id,id);

CREATE TABLE finnor_os.underwriting_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  investment_case_id uuid NOT NULL, model_key text NOT NULL CHECK (model_key ~ '^[a-z][a-z0-9_.:-]{0,99}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 240),
  created_by text NOT NULL CHECK (length(btrim(created_by)) BETWEEN 1 AND 160), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,investment_case_id,id), UNIQUE (tenant_id,investment_case_id,model_key),
  FOREIGN KEY (tenant_id,investment_case_id) REFERENCES finnor_os.pe_investment_cases(tenant_id,id)
);

CREATE TABLE finnor_os.underwriting_model_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, investment_case_id uuid NOT NULL, model_id uuid NOT NULL,
  version_key text NOT NULL CHECK (length(btrim(version_key)) BETWEEN 1 AND 80),
  schema_version text NOT NULL CHECK (schema_version='underwriting-model-ir.v1'),
  financial_convention_version text NOT NULL CHECK (length(btrim(financial_convention_version)) BETWEEN 1 AND 120),
  minimum_engine_version text NOT NULL CHECK (length(btrim(minimum_engine_version)) BETWEEN 1 AND 120),
  semantic_hash text NOT NULL CHECK (semantic_hash ~ '^sha256:[0-9a-f]{64}$'),
  model_definition jsonb NOT NULL CHECK (jsonb_typeof(model_definition)='object' AND octet_length(model_definition::text)<=5242880),
  parent_version_id uuid, created_by text NOT NULL CHECK (length(btrim(created_by)) BETWEEN 1 AND 160),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,model_id,id), UNIQUE (tenant_id,investment_case_id,id),
  UNIQUE (tenant_id,investment_case_id,model_id,id), UNIQUE (tenant_id,model_id,version_key), UNIQUE (tenant_id,model_id,semantic_hash),
  FOREIGN KEY (tenant_id,investment_case_id,model_id) REFERENCES finnor_os.underwriting_models(tenant_id,investment_case_id,id),
  FOREIGN KEY (tenant_id,model_id,parent_version_id) REFERENCES finnor_os.underwriting_model_versions(tenant_id,model_id,id)
);

CREATE TABLE finnor_os.underwriting_model_input_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, investment_case_id uuid NOT NULL, model_version_id uuid NOT NULL,
  input_node_id text NOT NULL CHECK (length(input_node_id) BETWEEN 1 AND 200),
  source_kind text NOT NULL CHECK (source_kind IN ('p1_assumption','evidence_version','artifact_anchor','explicit','model_parameter')),
  assumption_id uuid, evidence_version_id uuid, document_id uuid, document_version_id uuid, anchor_id text,
  anchor_hash text CHECK (anchor_hash IS NULL OR anchor_hash ~ '^[0-9a-f]{64}$'),
  value_path text CHECK (value_path IS NULL OR value_path ~ '^[A-Za-z0-9_.-]{1,240}$'),
  value_selector text CHECK (value_selector IS NULL OR length(value_selector) BETWEEN 1 AND 240),
  stale_after_days integer CHECK (stale_after_days IS NULL OR stale_after_days BETWEEN 0 AND 36500),
  created_by text NOT NULL CHECK (length(btrim(created_by)) BETWEEN 1 AND 160), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,model_version_id,input_node_id),
  FOREIGN KEY (tenant_id,investment_case_id,model_version_id) REFERENCES finnor_os.underwriting_model_versions(tenant_id,investment_case_id,id),
  FOREIGN KEY (tenant_id,investment_case_id,assumption_id) REFERENCES finnor_os.pe_assumptions(tenant_id,investment_case_id,id),
  FOREIGN KEY (tenant_id,document_id,document_version_id) REFERENCES finnor_os.document_versions(tenant_id,document_id,id),
  CHECK (
    (source_kind='p1_assumption' AND assumption_id IS NOT NULL AND evidence_version_id IS NULL AND document_id IS NULL AND document_version_id IS NULL AND anchor_id IS NULL AND anchor_hash IS NULL AND value_path IS NULL AND value_selector IS NULL)
    OR (source_kind='evidence_version' AND assumption_id IS NULL AND evidence_version_id IS NOT NULL AND document_id IS NULL AND document_version_id IS NULL AND anchor_id IS NULL AND anchor_hash IS NULL AND value_path IS NOT NULL AND value_selector IS NULL)
    OR (source_kind='artifact_anchor' AND assumption_id IS NULL AND evidence_version_id IS NULL AND document_id IS NOT NULL AND document_version_id IS NOT NULL AND anchor_id IS NOT NULL AND anchor_hash IS NOT NULL AND value_path IS NULL)
    OR (source_kind IN ('explicit','model_parameter') AND assumption_id IS NULL AND evidence_version_id IS NULL AND document_id IS NULL AND document_version_id IS NULL AND anchor_id IS NULL AND anchor_hash IS NULL AND value_path IS NULL AND value_selector IS NULL)
  )
);

CREATE TABLE finnor_os.underwriting_scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, investment_case_id uuid NOT NULL, model_version_id uuid NOT NULL,
  parent_scenario_id uuid, name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 240),
  semantic_hash text NOT NULL CHECK (semantic_hash ~ '^sha256:[0-9a-f]{64}$'),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object' AND jsonb_typeof(definition->'overrides')='array' AND jsonb_array_length(definition->'overrides')<=100 AND octet_length(definition::text)<=1048576),
  created_by text NOT NULL CHECK (length(btrim(created_by)) BETWEEN 1 AND 160), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,investment_case_id,model_version_id,id), UNIQUE (tenant_id,model_version_id,semantic_hash),
  FOREIGN KEY (tenant_id,investment_case_id,model_version_id) REFERENCES finnor_os.underwriting_model_versions(tenant_id,investment_case_id,id),
  FOREIGN KEY (tenant_id,investment_case_id,model_version_id,parent_scenario_id) REFERENCES finnor_os.underwriting_scenarios(tenant_id,investment_case_id,model_version_id,id)
);

CREATE TABLE finnor_os.underwriting_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, investment_case_id uuid NOT NULL, model_version_id uuid NOT NULL,
  scenario_id uuid, work_id uuid, world_at timestamptz NOT NULL, computed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  engine_version text NOT NULL CHECK (length(btrim(engine_version)) BETWEEN 1 AND 120),
  model_semantic_hash text NOT NULL CHECK (model_semantic_hash ~ '^sha256:[0-9a-f]{64}$'),
  input_hash text NOT NULL CHECK (input_hash ~ '^sha256:[0-9a-f]{64}$'),
  input_snapshot jsonb NOT NULL CHECK (jsonb_typeof(input_snapshot)='object' AND octet_length(input_snapshot::text)<=5242880),
  result_hash text NOT NULL CHECK (result_hash ~ '^sha256:[0-9a-f]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result)='object' AND octet_length(result::text)<=10485760),
  status text NOT NULL CHECK (status IN ('SUCCEEDED','FAILED')), validity text NOT NULL CHECK (validity IN ('VALID','INVALID','INCOMPLETE','NON_CONVERGENT')),
  failure_code text, idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 240),
  created_by text NOT NULL CHECK (length(btrim(created_by)) BETWEEN 1 AND 160),
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,investment_case_id,id), UNIQUE (tenant_id,model_version_id,id),
  UNIQUE (tenant_id,investment_case_id,model_version_id,id), UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,investment_case_id,model_version_id) REFERENCES finnor_os.underwriting_model_versions(tenant_id,investment_case_id,id),
  FOREIGN KEY (tenant_id,investment_case_id,model_version_id,scenario_id) REFERENCES finnor_os.underwriting_scenarios(tenant_id,investment_case_id,model_version_id,id),
  FOREIGN KEY (tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
  CHECK ((status='FAILED')=(failure_code IS NOT NULL)), CHECK ((status='FAILED' AND validity IN ('INCOMPLETE','NON_CONVERGENT')) OR status='SUCCEEDED')
);

CREATE TABLE finnor_os.underwriting_sensitivities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, investment_case_id uuid NOT NULL, model_version_id uuid NOT NULL,
  base_run_id uuid NOT NULL, name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 240),
  definition_hash text NOT NULL CHECK (definition_hash ~ '^sha256:[0-9a-f]{64}$'),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object' AND octet_length(definition::text)<=1048576),
  status text NOT NULL CHECK (status IN ('SUCCEEDED','PARTIAL','FAILED')), cell_count integer NOT NULL CHECK (cell_count BETWEEN 1 AND 2500),
  created_by text NOT NULL CHECK (length(btrim(created_by)) BETWEEN 1 AND 160), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,investment_case_id,model_version_id,id), UNIQUE (tenant_id,base_run_id,definition_hash),
  FOREIGN KEY (tenant_id,investment_case_id,model_version_id) REFERENCES finnor_os.underwriting_model_versions(tenant_id,investment_case_id,id),
  FOREIGN KEY (tenant_id,investment_case_id,model_version_id,base_run_id) REFERENCES finnor_os.underwriting_runs(tenant_id,investment_case_id,model_version_id,id)
);

CREATE TABLE finnor_os.underwriting_sensitivity_cells (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, investment_case_id uuid NOT NULL, model_version_id uuid NOT NULL,
  sensitivity_id uuid NOT NULL, run_id uuid NOT NULL, row_index integer NOT NULL CHECK (row_index>=0), column_index integer NOT NULL CHECK (column_index>=0),
  coordinates jsonb NOT NULL CHECK (jsonb_typeof(coordinates)='object' AND octet_length(coordinates::text)<=32768), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,sensitivity_id,row_index,column_index), UNIQUE (tenant_id,sensitivity_id,run_id),
  FOREIGN KEY (tenant_id,investment_case_id,model_version_id,sensitivity_id) REFERENCES finnor_os.underwriting_sensitivities(tenant_id,investment_case_id,model_version_id,id),
  FOREIGN KEY (tenant_id,model_version_id,run_id) REFERENCES finnor_os.underwriting_runs(tenant_id,model_version_id,id)
);

CREATE TABLE finnor_os.underwriting_artifact_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, investment_case_id uuid NOT NULL, model_version_id uuid NOT NULL,
  document_id uuid NOT NULL, document_version_id uuid NOT NULL, direction text NOT NULL CHECK (direction IN ('input','output')),
  binding_mode text NOT NULL CHECK (binding_mode IN ('read_only','write_and_compare','compare_only')),
  model_node_id text NOT NULL CHECK (length(model_node_id) BETWEEN 1 AND 200), anchor_id text NOT NULL CHECK (length(anchor_id) BETWEEN 1 AND 2048),
  anchor_hash text NOT NULL CHECK (anchor_hash ~ '^[0-9a-f]{64}$'),
  value_selector text CHECK (value_selector IS NULL OR length(value_selector) BETWEEN 1 AND 240),
  comparison_policy jsonb CHECK (comparison_policy IS NULL OR (jsonb_typeof(comparison_policy)='object' AND octet_length(comparison_policy::text)<=4096)),
  binding_version integer NOT NULL CHECK (binding_version>=1), supersedes_binding_id uuid,
  created_by text NOT NULL CHECK (length(btrim(created_by)) BETWEEN 1 AND 160), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,model_version_id,document_version_id,direction,model_node_id,binding_version),
  UNIQUE (tenant_id,model_version_id,document_version_id,direction,anchor_id,binding_version),
  FOREIGN KEY (tenant_id,investment_case_id,model_version_id) REFERENCES finnor_os.underwriting_model_versions(tenant_id,investment_case_id,id),
  FOREIGN KEY (tenant_id,document_id,document_version_id) REFERENCES finnor_os.document_versions(tenant_id,document_id,id),
  FOREIGN KEY (tenant_id,supersedes_binding_id) REFERENCES finnor_os.underwriting_artifact_bindings(tenant_id,id),
  CHECK ((direction='output')=(comparison_policy IS NOT NULL)),
  CHECK ((direction='input' AND binding_mode='read_only') OR (direction='output' AND binding_mode IN ('write_and_compare','compare_only')))
);

CREATE TABLE finnor_os.underwriting_artifact_projections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, investment_case_id uuid NOT NULL, run_id uuid NOT NULL,
  document_id uuid NOT NULL, base_version_id uuid NOT NULL, result_version_id uuid, artifact_operation_id uuid,
  binding_ids jsonb NOT NULL CHECK (jsonb_typeof(binding_ids)='array' AND jsonb_array_length(binding_ids) BETWEEN 1 AND 100 AND octet_length(binding_ids::text)<=65536),
  status text NOT NULL CHECK (status IN ('SUCCEEDED','FAILED','VERSION_CONFLICT','ANCHOR_CONFLICT')),
  comparisons jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(comparisons)='array' AND octet_length(comparisons::text)<=1048576),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 240), failure_code text,
  created_by text NOT NULL CHECK (length(btrim(created_by)) BETWEEN 1 AND 160), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id), UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,investment_case_id,run_id) REFERENCES finnor_os.underwriting_runs(tenant_id,investment_case_id,id),
  FOREIGN KEY (tenant_id,document_id,base_version_id) REFERENCES finnor_os.document_versions(tenant_id,document_id,id),
  FOREIGN KEY (tenant_id,document_id,result_version_id) REFERENCES finnor_os.document_versions(tenant_id,document_id,id),
  CHECK ((status='SUCCEEDED')=(result_version_id IS NOT NULL)), CHECK ((status='SUCCEEDED')=(failure_code IS NULL))
);

CREATE OR REPLACE FUNCTION finnor_os.reject_underwriting_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$ BEGIN
  RAISE EXCEPTION 'underwriting history is immutable; append a new version, scenario, run or projection';
END $$;

CREATE OR REPLACE FUNCTION finnor_os.assert_underwriting_model_version() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$ BEGIN
  IF NEW.model_definition->>'schemaVersion' IS DISTINCT FROM NEW.schema_version
     OR NEW.model_definition->>'financialConventionVersion' IS DISTINCT FROM NEW.financial_convention_version
     OR NEW.model_definition->>'minimumEngineVersion' IS DISTINCT FROM NEW.minimum_engine_version
     OR NEW.model_definition->>'modelVersion' IS DISTINCT FROM NEW.version_key THEN
    RAISE EXCEPTION 'underwriting ModelVersion metadata does not match its immutable definition';
  END IF;
  IF jsonb_typeof(NEW.model_definition->'nodes')<>'array' OR jsonb_array_length(NEW.model_definition->'nodes') NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'underwriting ModelVersion node count is invalid';
  END IF; RETURN NEW;
END $$;
CREATE TRIGGER underwriting_model_version_guard BEFORE INSERT ON finnor_os.underwriting_model_versions
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_underwriting_model_version();

CREATE OR REPLACE FUNCTION finnor_os.assert_underwriting_scenario_run() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE version_row record; BEGIN
  IF TG_TABLE_NAME='underwriting_scenarios' THEN
    IF NEW.definition->>'semanticHash' IS NOT NULL AND NEW.definition->>'semanticHash' IS DISTINCT FROM NEW.semantic_hash THEN
      RAISE EXCEPTION 'underwriting Scenario semantic hash does not match its definition'; END IF;
  ELSE
    SELECT semantic_hash,minimum_engine_version INTO version_row FROM finnor_os.underwriting_model_versions
      WHERE tenant_id=NEW.tenant_id AND investment_case_id=NEW.investment_case_id AND id=NEW.model_version_id;
    IF NOT FOUND OR version_row.semantic_hash IS DISTINCT FROM NEW.model_semantic_hash THEN
      RAISE EXCEPTION 'underwriting Run ModelVersion hash mismatch'; END IF;
    IF NEW.input_snapshot->>'semanticHash' IS DISTINCT FROM NEW.input_hash
       OR NEW.input_snapshot->>'investmentCaseId' IS DISTINCT FROM NEW.investment_case_id::text
       OR (NEW.input_snapshot->>'worldAt')::timestamptz IS DISTINCT FROM NEW.world_at THEN
      RAISE EXCEPTION 'underwriting Run InputSnapshot identity mismatch'; END IF;
    IF NEW.result->>'resultSemanticHash' IS DISTINCT FROM NEW.result_hash
       OR NEW.result->>'modelSemanticHash' IS DISTINCT FROM NEW.model_semantic_hash
       OR NEW.result->>'inputSemanticHash' IS DISTINCT FROM NEW.input_hash
       OR NEW.result->>'engineVersion' IS DISTINCT FROM NEW.engine_version
       OR NEW.result->>'status' IS DISTINCT FROM NEW.status
       OR NEW.result->>'validity' IS DISTINCT FROM NEW.validity THEN
      RAISE EXCEPTION 'underwriting Run result identity mismatch'; END IF;
  END IF; RETURN NEW;
END $$;
CREATE TRIGGER underwriting_scenario_identity_guard BEFORE INSERT ON finnor_os.underwriting_scenarios
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_underwriting_scenario_run();
CREATE TRIGGER underwriting_run_identity_guard BEFORE INSERT ON finnor_os.underwriting_runs
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_underwriting_scenario_run();

CREATE OR REPLACE FUNCTION finnor_os.assert_underwriting_input_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE model_body jsonb; source_row record; anchor_node jsonb; BEGIN
  SELECT model_definition INTO model_body FROM finnor_os.underwriting_model_versions
   WHERE tenant_id=NEW.tenant_id AND investment_case_id=NEW.investment_case_id AND id=NEW.model_version_id;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(model_body->'nodes') node WHERE node->>'id'=NEW.input_node_id AND node->>'kind'='input') THEN
    RAISE EXCEPTION 'underwriting input binding target is not an InputNode'; END IF;
  IF NEW.source_kind='evidence_version' THEN
    SELECT scope,tenant_id INTO source_row FROM finnor_os.evidence_source_versions WHERE id=NEW.evidence_version_id;
    IF NOT FOUND OR (source_row.scope='tenant' AND source_row.tenant_id IS DISTINCT FROM NEW.tenant_id) THEN
      RAISE EXCEPTION 'underwriting EvidenceVersion binding crosses tenant or is missing'; END IF;
  ELSIF NEW.source_kind='artifact_anchor' THEN
    SELECT node INTO anchor_node FROM finnor_os.artifact_ir_snapshots snapshot,
      LATERAL jsonb_array_elements(snapshot.ir->'nodes') node
      WHERE snapshot.tenant_id=NEW.tenant_id AND snapshot.version_id=NEW.document_version_id
        AND node->>'id'=NEW.anchor_id AND node->>'hash'=NEW.anchor_hash ORDER BY snapshot.created_at DESC LIMIT 1;
    IF anchor_node IS NULL THEN RAISE EXCEPTION 'underwriting ArtifactAnchor binding is stale, missing or crosses tenant'; END IF;
  END IF; RETURN NEW;
END $$;
CREATE TRIGGER underwriting_input_binding_guard BEFORE INSERT ON finnor_os.underwriting_model_input_bindings
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_underwriting_input_binding();

CREATE OR REPLACE FUNCTION finnor_os.assert_underwriting_artifact_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE model_body jsonb; anchor_node jsonb; prior record; BEGIN
  SELECT model_definition INTO model_body FROM finnor_os.underwriting_model_versions
   WHERE tenant_id=NEW.tenant_id AND investment_case_id=NEW.investment_case_id AND id=NEW.model_version_id;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(model_body->'nodes') node WHERE node->>'id'=NEW.model_node_id
    AND ((NEW.direction='input' AND node->>'kind'='input') OR (NEW.direction='output' AND node->>'kind'='output'))) THEN
    RAISE EXCEPTION 'underwriting artifact binding direction does not match model node'; END IF;
  SELECT node INTO anchor_node FROM finnor_os.artifact_ir_snapshots snapshot,
    LATERAL jsonb_array_elements(snapshot.ir->'nodes') node
    WHERE snapshot.tenant_id=NEW.tenant_id AND snapshot.version_id=NEW.document_version_id
      AND snapshot.kind IN ('xlsx','xlsm') AND node->>'id'=NEW.anchor_id AND node->>'hash'=NEW.anchor_hash
    ORDER BY snapshot.created_at DESC LIMIT 1;
  IF anchor_node IS NULL THEN RAISE EXCEPTION 'underwriting artifact binding requires an exact current SpreadsheetIR anchor'; END IF;
  IF NEW.supersedes_binding_id IS NOT NULL THEN
    SELECT * INTO prior FROM finnor_os.underwriting_artifact_bindings WHERE tenant_id=NEW.tenant_id AND id=NEW.supersedes_binding_id;
    IF NOT FOUND OR prior.investment_case_id<>NEW.investment_case_id OR prior.model_node_id<>NEW.model_node_id OR prior.direction<>NEW.direction THEN
      RAISE EXCEPTION 'underwriting artifact binding supersession crosses identity'; END IF;
    IF NEW.binding_version<>prior.binding_version+1 THEN RAISE EXCEPTION 'underwriting artifact binding revision must increment exactly once'; END IF;
  ELSIF NEW.binding_version<>1 THEN RAISE EXCEPTION 'initial underwriting artifact binding version must be one'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER underwriting_artifact_binding_guard BEFORE INSERT ON finnor_os.underwriting_artifact_bindings
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_underwriting_artifact_binding();

CREATE OR REPLACE FUNCTION finnor_os.assert_underwriting_projection() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE run_row record; binding_count integer; operation_row record; BEGIN
  SELECT model_version_id,investment_case_id INTO run_row FROM finnor_os.underwriting_runs
    WHERE tenant_id=NEW.tenant_id AND id=NEW.run_id;
  SELECT count(*) INTO binding_count
    FROM jsonb_array_elements_text(NEW.binding_ids) raw
    JOIN finnor_os.underwriting_artifact_bindings binding
      ON binding.id=raw::uuid AND binding.tenant_id=NEW.tenant_id
      AND binding.investment_case_id=run_row.investment_case_id
      AND binding.model_version_id=run_row.model_version_id
      AND binding.document_id=NEW.document_id AND binding.document_version_id=NEW.base_version_id
      AND binding.direction='output';
  IF binding_count<>jsonb_array_length(NEW.binding_ids) THEN
    RAISE EXCEPTION 'underwriting projection binding set crosses Run, model, tenant or artifact version'; END IF;
  IF NEW.artifact_operation_id IS NOT NULL THEN
    SELECT tenant_id,document_id,base_version_id,result_version_id,status INTO operation_row
      FROM finnor_os.artifact_operations WHERE id=NEW.artifact_operation_id;
    IF NOT FOUND OR operation_row.tenant_id<>NEW.tenant_id OR operation_row.document_id<>NEW.document_id
       OR operation_row.base_version_id<>NEW.base_version_id OR operation_row.result_version_id IS DISTINCT FROM NEW.result_version_id THEN
      RAISE EXCEPTION 'underwriting projection P3 Artifact operation identity mismatch'; END IF;
  END IF; RETURN NEW;
END $$;
CREATE TRIGGER underwriting_projection_guard BEFORE INSERT ON finnor_os.underwriting_artifact_projections
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_underwriting_projection();

CREATE INDEX underwriting_models_case_idx ON finnor_os.underwriting_models(tenant_id,investment_case_id,created_at,id);
CREATE INDEX underwriting_model_versions_model_idx ON finnor_os.underwriting_model_versions(tenant_id,model_id,created_at,id);
CREATE INDEX underwriting_model_bindings_version_idx ON finnor_os.underwriting_model_input_bindings(tenant_id,model_version_id,input_node_id);
CREATE INDEX underwriting_scenarios_model_idx ON finnor_os.underwriting_scenarios(tenant_id,model_version_id,created_at,id);
CREATE INDEX underwriting_runs_case_idx ON finnor_os.underwriting_runs(tenant_id,investment_case_id,computed_at DESC,id);
CREATE INDEX underwriting_runs_model_idx ON finnor_os.underwriting_runs(tenant_id,model_version_id,computed_at DESC,id);
CREATE INDEX underwriting_sensitivities_case_idx ON finnor_os.underwriting_sensitivities(tenant_id,investment_case_id,created_at DESC,id);
CREATE INDEX underwriting_sensitivity_cells_parent_idx ON finnor_os.underwriting_sensitivity_cells(tenant_id,sensitivity_id,row_index,column_index);
CREATE INDEX underwriting_artifact_bindings_node_idx ON finnor_os.underwriting_artifact_bindings(tenant_id,model_version_id,model_node_id,binding_version DESC);
CREATE INDEX underwriting_artifact_projections_run_idx ON finnor_os.underwriting_artifact_projections(tenant_id,run_id,created_at DESC,id);

DO $underwriting_rls$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'underwriting_models','underwriting_model_versions','underwriting_model_input_bindings','underwriting_scenarios',
    'underwriting_runs','underwriting_sensitivities','underwriting_sensitivity_cells','underwriting_artifact_bindings','underwriting_artifact_projections'
  ] LOOP
    EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON finnor_os.%I USING (tenant_id=finnor_os.request_tenant_id()) WITH CHECK (tenant_id=finnor_os.request_tenant_id())',table_name);
    EXECUTE format('CREATE TRIGGER immutable_underwriting_history BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.reject_underwriting_mutation()',table_name);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
      EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',table_name);
      EXECUTE format('REVOKE UPDATE,DELETE ON finnor_os.%I FROM finnor_app',table_name);
    END IF;
  END LOOP;
END $underwriting_rls$;

REVOKE EXECUTE ON FUNCTION finnor_os.reject_underwriting_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.assert_underwriting_model_version() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.assert_underwriting_scenario_run() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.assert_underwriting_input_binding() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.assert_underwriting_artifact_binding() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finnor_os.assert_underwriting_projection() FROM PUBLIC;

COMMENT ON TABLE finnor_os.underwriting_models IS 'P4 logical deterministic model attached to the P1 InvestmentCase; not a duplicate canonical case.';
COMMENT ON TABLE finnor_os.underwriting_model_versions IS 'Immutable executable P4 ModelIR versions; absent from canonical_truth_registry by design.';
COMMENT ON TABLE finnor_os.underwriting_runs IS 'Immutable deterministic calculation proof; not a P1 Decision or Core DecisionReceipt.';
COMMENT ON TABLE finnor_os.underwriting_artifact_bindings IS 'Thin P4 model-node to exact P3 SpreadsheetIR anchor mapping; P3 retains artifact ownership.';
