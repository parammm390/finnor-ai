-- S7's immutable semantic records and S2's assignment records are ordinary
-- storage. Actual S6 receipts authenticate delivery, never economic truth.
CREATE TABLE finnor_os.s7_economic_records (
 tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
 principal_id uuid NOT NULL REFERENCES finnor_os.users(id),
 record_id text NOT NULL CHECK(length(record_id) BETWEEN 1 AND 4096),
 kind text NOT NULL CHECK(kind IN ('PREREGISTRATION','SOURCE','ASSIGNMENT','EXPOSURE','MEASUREMENT','VALUATION','COST','ASSESSMENT','AGGREGATION','CORRECTION','INVALIDATION','COMPUTE','BENCHMARK_REGISTRATION','BENCHMARK_ASSESSMENT')),
 estimand_id text,
 revision_of text,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
 valid_at timestamptz NOT NULL,
 knowledge_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object' AND octet_length(body::text)<=8388608),
 event jsonb NOT NULL CHECK(jsonb_typeof(event)='object' AND octet_length(event::text)<=8388608),
 PRIMARY KEY(tenant_id,principal_id,record_id),
 UNIQUE(tenant_id,principal_id,kind,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id,estimand_id) REFERENCES finnor_os.s7_economic_records(tenant_id,principal_id,record_id),
 FOREIGN KEY(tenant_id,principal_id,revision_of) REFERENCES finnor_os.s7_economic_records(tenant_id,principal_id,record_id)
);
CREATE INDEX s7_economic_estimand_history_idx ON finnor_os.s7_economic_records
 (tenant_id,principal_id,estimand_id,knowledge_at,record_id);
CREATE FUNCTION finnor_os.economic_record_immutable() RETURNS trigger
 LANGUAGE plpgsql SET search_path=finnor_os,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Economic commitments are append-only; append a linked correction'; END $$;
CREATE TRIGGER s7_economic_records_immutable BEFORE UPDATE OR DELETE
 ON finnor_os.s7_economic_records FOR EACH ROW EXECUTE FUNCTION finnor_os.economic_record_immutable();

CREATE TABLE finnor_os.s2_economic_assignment_records (
 tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
 principal_id uuid NOT NULL REFERENCES finnor_os.users(id),
 record_id text NOT NULL CHECK(length(record_id) BETWEEN 1 AND 4096),
 kind text NOT NULL CHECK(kind IN ('PROTOCOL','ASSIGNMENT')),
 protocol_id text,
 estimand_id text,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
 knowledge_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object' AND octet_length(body::text)<=8388608),
 PRIMARY KEY(tenant_id,principal_id,record_id),
 UNIQUE(tenant_id,principal_id,kind,idempotency_key),
 FOREIGN KEY(tenant_id,principal_id,protocol_id) REFERENCES finnor_os.s2_economic_assignment_records(tenant_id,principal_id,record_id),
 FOREIGN KEY(tenant_id,principal_id,estimand_id) REFERENCES finnor_os.s7_economic_records(tenant_id,principal_id,record_id)
);
CREATE UNIQUE INDEX s2_economic_one_assignment_group_idx ON finnor_os.s2_economic_assignment_records(tenant_id,principal_id,estimand_id) WHERE kind='ASSIGNMENT';
CREATE TRIGGER s2_economic_assignment_records_immutable BEFORE UPDATE OR DELETE
 ON finnor_os.s2_economic_assignment_records FOR EACH ROW EXECUTE FUNCTION finnor_os.economic_record_immutable();
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['s7_economic_records','s2_economic_assignment_records'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',table_name);
  EXECUTE format('CREATE POLICY economic_records_tenant ON finnor_os.%I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',table_name);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
   EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',table_name);
  END IF;
 END LOOP;
END $$;
