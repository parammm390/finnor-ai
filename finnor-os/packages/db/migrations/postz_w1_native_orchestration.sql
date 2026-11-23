-- Reserved namespaced proposal only. Sole coordinator owns canonical ordering/numbering/application.
-- W1 reuses P2 custody, original P1/S5 accounting and existing physical leases.
ALTER TABLE finnor_os.p2_units DROP CONSTRAINT p2_units_kind_check;
ALTER TABLE finnor_os.p2_units ADD CONSTRAINT p2_units_kind_check
 CHECK(kind IN('EXECUTE_P1','VERIFY_P1','MODEL_REFINE','INSPECT_SOURCE','CONTROL_M2','CONTROL_W1'));
ALTER TABLE finnor_os.p2_units DROP CONSTRAINT p2_units_attempts_check;
ALTER TABLE finnor_os.p2_units ADD CONSTRAINT p2_units_attempts_check
 CHECK(attempts>=0 AND attempts<=CASE WHEN kind='CONTROL_M2' THEN 32 WHEN kind='CONTROL_W1' THEN 1 ELSE 2 END);

CREATE TABLE finnor_os.w1_capsules(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,search_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),unit_id uuid NOT NULL,attempt_id uuid NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=4194304),digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,search_id,revision),UNIQUE(tenant_id,principal_id,search_id,digest),
 UNIQUE(tenant_id,principal_id,attempt_id),
 FOREIGN KEY(tenant_id,principal_id,search_id) REFERENCES finnor_os.p2_requests(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,unit_id) REFERENCES finnor_os.p2_units(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,attempt_id) REFERENCES finnor_os.p2_attempts(tenant_id,principal_id,id),
 CHECK(coalesce(body->>'schema'='finnor.orchestration-policy-capsule.v1'
  AND body->>'id'=id::text AND body->>'searchId'=search_id::text
  AND body->'execution'->>'unitId'=unit_id::text AND body->'execution'->>'attemptId'=attempt_id::text
  AND body->'authorityGranted'='false'::jsonb,false))
);
CREATE TABLE finnor_os.w1_native_observations(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,id text NOT NULL,search_id uuid NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=262144),digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,search_id) REFERENCES finnor_os.p2_requests(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.w1_response_states(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 dataset_digest text NOT NULL CHECK(dataset_digest~'^[a-f0-9]{64}$'),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=2097152),
 dataset jsonb NOT NULL CHECK(octet_length(dataset::text)<=4194304),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,principal_id,digest),
 CHECK(coalesce(body->>'schema'='finnor.orchestration-response-state.v1'
  AND body->>'tenantId'=tenant_id::text AND body->>'principalId'=principal_id::text
  AND body->>'sourceClass'='CONTROLLED_NATIVE' AND dataset->>'sourceClass'='CONTROLLED_NATIVE',false))
);
CREATE INDEX w1_response_current ON finnor_os.w1_response_states(tenant_id,principal_id,created_at DESC,digest DESC);
CREATE TABLE finnor_os.w1_development_checks(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,search_id uuid NOT NULL,candidate_digest text NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=65536),digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,principal_id,search_id,candidate_digest),
 FOREIGN KEY(tenant_id,principal_id,search_id,candidate_digest) REFERENCES finnor_os.w1_capsules(tenant_id,principal_id,search_id,digest),
 CHECK(coalesce(body->>'schema'='finnor.w1.s8-development-check.v1'
  AND body->>'domain'='ECONOMIC_ORCHESTRATION' AND body->>'protectionDomain'='DISPOSABLE_LOCAL_DEVELOPMENT'
  AND body->>'tenantId'=tenant_id::text AND body->>'principalId'=principal_id::text
  AND body->>'searchId'=search_id::text AND body->>'candidateDigest'=candidate_digest AND body->>'status'='CHECKED'
  AND body->'protectedAdmission'='false'::jsonb AND body->'productionActivated'='false'::jsonb
  AND body->'executionAuthorityGranted'='false'::jsonb,false))
);
CREATE TABLE finnor_os.w1_dependencies(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,search_id uuid NOT NULL,capsule_digest text NOT NULL,
 dependency_key text NOT NULL,revision bigint NOT NULL CHECK(revision>=0),facet text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,search_id,capsule_digest,dependency_key),
 FOREIGN KEY(tenant_id,principal_id,search_id,capsule_digest) REFERENCES finnor_os.w1_capsules(tenant_id,principal_id,search_id,digest)
);
CREATE TABLE finnor_os.w1_invalidations(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,search_id uuid NOT NULL,capsule_digest text NOT NULL,
 dependency_key text NOT NULL,observed_revision bigint NOT NULL CHECK(observed_revision>=0),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=65536),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,search_id,capsule_digest,dependency_key,observed_revision),
 FOREIGN KEY(tenant_id,principal_id,search_id,capsule_digest) REFERENCES finnor_os.w1_capsules(tenant_id,principal_id,search_id,digest)
);
CREATE TABLE finnor_os.w1_stage_observations(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,search_id uuid NOT NULL,id text NOT NULL CHECK(length(id)<=1024),
 context_key text NOT NULL CHECK(length(context_key)<=1024),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=262144),digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,search_id) REFERENCES finnor_os.p2_requests(tenant_id,principal_id,id),
 CHECK(coalesce(body->>'schema'='finnor.w1.native-stage-observation.v1' AND body->>'id'=id
  AND jsonb_typeof(body->'before'->'history')='array' AND jsonb_typeof(body->'after'->'history')='array',false))
);
CREATE INDEX w1_stage_history ON finnor_os.w1_stage_observations(tenant_id,principal_id,search_id,created_at,id);
CREATE TABLE finnor_os.w1_continuation_states(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,context_key text NOT NULL CHECK(length(context_key)<=1024),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=2097152),digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,principal_id,digest),
 CHECK(coalesce(body->>'schema'='finnor.w1.native-continuation-response.v1'
  AND body->>'version'='postz-w1-empirical-continuation-v2'
  AND body->'context'->>'tenantId'=tenant_id::text AND body->'context'->>'principalId'=principal_id::text
  AND body->'context'->>'sourceClass'='CONTROLLED_NATIVE' AND jsonb_array_length(body->'samples')<=128,false))
);
CREATE UNIQUE INDEX w1_continuation_ref ON finnor_os.w1_continuation_states(tenant_id,principal_id,(body->>'ref'));
CREATE INDEX w1_continuation_current ON finnor_os.w1_continuation_states(tenant_id,principal_id,context_key,created_at DESC,digest DESC);
CREATE TABLE finnor_os.w1_measurement_gaps(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,search_id uuid NOT NULL,id text NOT NULL CHECK(length(id)<=1024),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=65536),digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,principal_id,search_id,id),
 FOREIGN KEY(tenant_id,principal_id,search_id) REFERENCES finnor_os.p2_requests(tenant_id,principal_id,id),
 CHECK(coalesce(body->>'schema'='finnor.w1.native-measurement-gap.v1' AND body->>'id'=id
  AND body->>'kind'~'^[A-Z][A-Z0-9_]{0,127}$' AND body->'value'='null'::jsonb
  AND body->'authorityGranted'='false'::jsonb,false))
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['w1_capsules','w1_native_observations','w1_response_states','w1_development_checks','w1_dependencies','w1_invalidations',
  'w1_stage_observations','w1_continuation_states','w1_measurement_gaps'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY w1_principal_isolation ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  EXECUTE format('CREATE TRIGGER w1_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.p1_immutable()',t);
 END LOOP;
END $$;
-- No historical P2/M2 row is rewritten, no grant/ledger/authority/job kind added.
