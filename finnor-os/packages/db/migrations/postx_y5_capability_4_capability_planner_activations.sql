CREATE TABLE finnor_os.capability_planner_activations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 principal_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 operation text NOT NULL CHECK(operation IN ('activate','disable')),
 run_id uuid,
 result_digest text CHECK(result_digest IS NULL OR result_digest ~ '^[a-f0-9]{64}$'),
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),
 authority_revision bigint NOT NULL,
 review_note text NOT NULL CHECK(length(btrim(review_note)) BETWEEN 16 AND 4000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,revision),
 UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,run_id) REFERENCES finnor_os.capability_runs(tenant_id,id),
 CHECK((operation='activate')=(run_id IS NOT NULL AND result_digest IS NOT NULL))
);
ALTER TABLE finnor_os.capability_planner_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.capability_planner_activations FORCE ROW LEVEL SECURITY;
CREATE POLICY capability_planner_activations_owner ON finnor_os.capability_planner_activations
 USING(tenant_id=finnor_os.request_tenant_id() AND principal_id::text=nullif(current_setting('app.user_id',true),''))
 WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id::text=nullif(current_setting('app.user_id',true),''));
CREATE TRIGGER capability_planner_activations_immutable BEFORE UPDATE OR DELETE ON finnor_os.capability_planner_activations
 FOR EACH ROW EXECUTE FUNCTION finnor_os.capability_event_immutable();
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
 GRANT SELECT,INSERT ON finnor_os.capability_planner_activations TO finnor_app;
END IF; END $$;
