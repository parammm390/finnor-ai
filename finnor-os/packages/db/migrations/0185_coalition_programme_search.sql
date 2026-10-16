-- R5 has a distinct semantic job and retains M3's original durable history.
ALTER TABLE finnor_os.m3_events DROP CONSTRAINT m3_events_kind_check;
ALTER TABLE finnor_os.m3_events ADD CONSTRAINT m3_events_kind_check CHECK(kind IN(
 'STARTED','CANDIDATE','MODULE_PREPARED','CHECK','FINISHED','FAILED','FENCED','CANCELLED','INVALIDATED','RESUMED','SELECTION',
 'R2_PHYSICAL_CHILD','R2_ENCODING_ACCEPTED','R2_FULL_WORLD_CHECKED','R2_ORIGINAL_TIE_CHECKED','R2_REJECTED_CLAIM',
 'R5_PHYSICAL_CHILD','R5_ORIGINAL_FAMILY_CHECKED'));

INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_coalition_programme_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
 'R5 complete joint coalition/programme/grant/division search under the original shared serial native permit; no effect, consent or admission authority.');

-- Ordinary proposed terms are not executable effect origins or signed consents.
CREATE TABLE finnor_os.s6_coalition_schedule_origins(
 tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
 principal_id uuid NOT NULL REFERENCES finnor_os.users(id),
 schedule_id text NOT NULL,consumption_id text NOT NULL,input_digest text NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=8388608),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,schedule_id),UNIQUE(tenant_id,consumption_id),
 FOREIGN KEY(tenant_id,consumption_id) REFERENCES finnor_os.s5_consumptions(tenant_id,consumption_id)
);
CREATE TABLE finnor_os.s6_coalition_consent_events(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL REFERENCES finnor_os.users(id),
 schedule_id text NOT NULL,event_id text NOT NULL,idempotency_key text NOT NULL,
 request_digest text NOT NULL,body jsonb NOT NULL CHECK(octet_length(body::text)<=2097152),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,event_id),UNIQUE(tenant_id,principal_id,idempotency_key),
 FOREIGN KEY(tenant_id,schedule_id) REFERENCES finnor_os.s6_coalition_schedule_origins(tenant_id,schedule_id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['s6_coalition_schedule_origins','s6_coalition_consent_events'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY s6_coalition_tenant ON finnor_os.%I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
  EXECUTE format('CREATE TRIGGER s6_coalition_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.s6_immutable_origin()',t);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
   EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  END IF;
 END LOOP;
END $$;
