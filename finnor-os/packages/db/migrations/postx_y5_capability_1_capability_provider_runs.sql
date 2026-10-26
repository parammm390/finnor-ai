-- Derived provider computations use the canonical jobs queue. These records do
-- not grant business effect, source-truth, causal or native capability admission.
CREATE TABLE finnor_os.capability_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
 principal_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('duckdb_query','docling_extract','pageindex_index','pageindex_retrieve','pywhy_assess','gepa_optimize','shinka_evolve','modal_execute','modal_control','nango_sync','parallel_task','parallel_find','parallel_monitor','parallel_monitor_control')),
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','RUNNING','WAITING_PROVIDER','SUCCEEDED','FAILED','UNKNOWN','CANCELLED')),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object' AND octet_length(request::text)<=1048576),
 sources jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(sources)='array'),
 authority_decision_id uuid NOT NULL REFERENCES finnor_os.authority_decisions(id),
 job_id uuid REFERENCES finnor_os.jobs(id),
 worker_claim_token uuid,
 remote_state jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(remote_state)='object' AND octet_length(remote_state::text)<=65536),
 result jsonb CHECK(result IS NULL OR jsonb_typeof(result)='object' AND octet_length(result::text)<=8388608),
 result_digest text CHECK(result_digest IS NULL OR result_digest ~ '^[a-f0-9]{64}$'),
 failure_code text CHECK(failure_code IS NULL OR length(failure_code)<=256),
 correlation_id text NOT NULL CHECK(length(correlation_id) BETWEEN 1 AND 256),
 deadline_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 started_at timestamptz,
 completed_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),
 UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 CHECK((status='SUCCEEDED')=(result IS NOT NULL AND result_digest IS NOT NULL))
);
CREATE INDEX capability_runs_tenant_history ON finnor_os.capability_runs(tenant_id,principal_id,created_at DESC,id);
CREATE INDEX capability_runs_pending ON finnor_os.capability_runs(tenant_id,status,updated_at) WHERE status IN ('QUEUED','RUNNING','WAITING_PROVIDER');

CREATE TABLE finnor_os.capability_run_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id uuid NOT NULL,
 run_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('ACCEPTED','CLAIMED','PROVIDER_DISPATCH','PROVIDER_ACCEPTED','PROVIDER_OBSERVED','COMPLETED','FAILED','UNKNOWN','CANCELLED')),
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object' AND octet_length(body::text)<=65536),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,run_id) REFERENCES finnor_os.capability_runs(tenant_id,id)
);
CREATE INDEX capability_run_events_history ON finnor_os.capability_run_events(tenant_id,run_id,id);
CREATE FUNCTION finnor_os.capability_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Capability execution evidence is append-only'; END $$;
CREATE TRIGGER capability_run_events_immutable BEFORE UPDATE OR DELETE ON finnor_os.capability_run_events
 FOR EACH ROW EXECUTE FUNCTION finnor_os.capability_event_immutable();

CREATE FUNCTION finnor_os.capability_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Capability run history cannot be removed'; END IF;
 IF (NEW.tenant_id,NEW.principal_id,NEW.kind,NEW.idempotency_key,NEW.request_digest,NEW.request,NEW.sources,NEW.authority_decision_id,NEW.deadline_at,NEW.correlation_id)
 IS DISTINCT FROM (OLD.tenant_id,OLD.principal_id,OLD.kind,OLD.idempotency_key,OLD.request_digest,OLD.request,OLD.sources,OLD.authority_decision_id,OLD.deadline_at,OLD.correlation_id)
 THEN RAISE EXCEPTION 'Accepted capability request and source cut are immutable'; END IF;
 IF OLD.status IN ('SUCCEEDED','FAILED','CANCELLED') AND NEW IS DISTINCT FROM OLD
 THEN RAISE EXCEPTION 'Terminal capability results are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER capability_runs_guard BEFORE UPDATE OR DELETE ON finnor_os.capability_runs
 FOR EACH ROW EXECUTE FUNCTION finnor_os.capability_run_guard();

ALTER TABLE finnor_os.capability_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.capability_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY capability_runs_tenant ON finnor_os.capability_runs
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid);
ALTER TABLE finnor_os.capability_run_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.capability_run_events FORCE ROW LEVEL SECURITY;
CREATE POLICY capability_run_events_tenant ON finnor_os.capability_run_events
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND EXISTS(SELECT 1 FROM finnor_os.capability_runs r WHERE r.tenant_id=capability_run_events.tenant_id AND r.id=capability_run_events.run_id))
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND EXISTS(SELECT 1 FROM finnor_os.capability_runs r WHERE r.tenant_id=capability_run_events.tenant_id AND r.id=capability_run_events.run_id));
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
  GRANT SELECT,INSERT,UPDATE ON finnor_os.capability_runs TO finnor_app;
  GRANT SELECT,INSERT ON finnor_os.capability_run_events TO finnor_app;
  GRANT USAGE,SELECT ON SEQUENCE finnor_os.capability_run_events_id_seq TO finnor_app;
 END IF;
END $$;

INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_capability_provider_v1','HEAVY',ARRAY['HEAVY'],'fixed','tenant','required',1,'Bounded versioned provider computation; authoritative business owners remain unchanged.');

-- Match the existing owner bootstrap without restoring a deliberately revoked
-- grant every time ensure_legacy_authority is called. Other roles gain nothing.
CREATE FUNCTION finnor_os.capability_owner_role_defaults() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF NEW.key='owner' AND NEW.legacy_role='owner' THEN
  INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk)
   VALUES(NEW.tenant_id,NEW.id,'capability:*','*','allow','high') ON CONFLICT(role_id,capability,resource_type) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER capability_owner_role_defaults AFTER INSERT ON finnor_os.employee_roles
 FOR EACH ROW EXECUTE FUNCTION finnor_os.capability_owner_role_defaults();
INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk)
 SELECT tenant_id,id,'capability:*','*','allow','high' FROM finnor_os.employee_roles WHERE key='owner' AND legacy_role='owner' AND active
 ON CONFLICT(role_id,capability,resource_type) DO NOTHING;
