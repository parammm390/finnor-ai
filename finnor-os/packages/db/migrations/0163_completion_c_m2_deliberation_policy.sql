-- M2 extends the P2 unit scheduler. No second queue, grant or authority owner.
ALTER TABLE finnor_os.p2_units DROP CONSTRAINT p2_units_kind_check;
ALTER TABLE finnor_os.p2_units ADD CONSTRAINT p2_units_kind_check
 CHECK(kind IN('EXECUTE_P1','VERIFY_P1','MODEL_REFINE','INSPECT_SOURCE','CONTROL_M2'));

CREATE TABLE finnor_os.m2_modules(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,digest text NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=262144),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,digest)
);
CREATE TABLE finnor_os.m2_module_runs(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,search_id uuid NOT NULL,unit_id uuid NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=262144),digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,principal_id,search_id) REFERENCES finnor_os.p2_requests(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,unit_id) REFERENCES finnor_os.p2_units(tenant_id,principal_id,id),
 UNIQUE(tenant_id,principal_id,unit_id)
);
CREATE INDEX m2_run_current ON finnor_os.m2_module_runs(tenant_id,principal_id,search_id,created_at DESC,id DESC);
CREATE TABLE finnor_os.m2_values(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,search_id uuid NOT NULL,digest text NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=262144),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,search_id,digest),
 FOREIGN KEY(tenant_id,principal_id,search_id) REFERENCES finnor_os.p2_requests(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.m2_policies(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,search_id uuid NOT NULL,revision integer NOT NULL,
 plan_id uuid NOT NULL,plan_digest text NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576),digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,search_id,revision),
 FOREIGN KEY(tenant_id,principal_id,search_id) REFERENCES finnor_os.p2_requests(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.m2_components(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,search_id uuid NOT NULL,digest text NOT NULL,kind text NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,search_id,digest),
 FOREIGN KEY(tenant_id,principal_id,search_id) REFERENCES finnor_os.p2_requests(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.m2_calibration_reports(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,digest text NOT NULL,source_id uuid NOT NULL,version_id uuid NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=1048576),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,digest)
);
CREATE TABLE finnor_os.m2_preparations(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,digest text NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=65536),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,digest)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['m2_modules','m2_module_runs','m2_values','m2_policies','m2_components','m2_calibration_reports','m2_preparations'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY m2_principal_isolation ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  EXECUTE format('CREATE TRIGGER m2_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.p1_immutable()',t);
 END LOOP;
END $$;
