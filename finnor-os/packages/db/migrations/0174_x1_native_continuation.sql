-- An independent canonical observation, not analytical TESTED, finishes a P1
-- institution duty. Older analytical rows and old physical jobs remain valid.
ALTER TABLE finnor_os.p1_requests DROP CONSTRAINT p1_requests_status_check;
ALTER TABLE finnor_os.p1_requests ADD CONSTRAINT p1_requests_status_check
  CHECK(status IN('QUEUED','RUNNING','WAITING_EVIDENCE','WAITING','TESTED',
                  'OBSERVED','PARTIAL','FAILED','INVALIDATED','CANCELLED'));

-- Keep checker output alongside its admitted candidate under the existing
-- admission identity. These are immutable historical inputs, not new grants.
ALTER TABLE finnor_os.x1_mapping_admissions
  ADD CONSTRAINT x1_mapping_admissions_tenant_id_key UNIQUE(tenant_id,id);
CREATE TABLE finnor_os.x1_checked_artifacts (
 tenant_id uuid NOT NULL, principal_id uuid NOT NULL, work_id uuid NOT NULL,
 admission_id uuid NOT NULL, candidate jsonb NOT NULL, candidate_digest text NOT NULL,
 check_result jsonb NOT NULL, check_digest text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,admission_id),
 FOREIGN KEY(tenant_id,admission_id) REFERENCES finnor_os.x1_mapping_admissions(tenant_id,id),
 FOREIGN KEY(tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 CHECK(octet_length(candidate::text)<=8388608 AND octet_length(check_result::text)<=262144),
 CHECK(candidate_digest ~ '^[a-f0-9]{64}$' AND check_digest ~ '^[a-f0-9]{64}$')
);
ALTER TABLE finnor_os.x1_checked_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.x1_checked_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY x1_checked_artifacts_principal ON finnor_os.x1_checked_artifacts
 USING(tenant_id=finnor_os.request_tenant_id()
   AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=finnor_os.request_tenant_id()
   AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid);
CREATE TRIGGER x1_checked_artifacts_immutable BEFORE UPDATE OR DELETE ON finnor_os.x1_checked_artifacts
 FOR EACH ROW EXECUTE FUNCTION finnor_os.p1_immutable();
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
 GRANT SELECT,INSERT ON finnor_os.x1_checked_artifacts TO finnor_app;
END IF; END $$;

INSERT INTO finnor_os.compute_job_type_policies
 (job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_x1_institution_continuation_v1','INTERACTIVE',ARRAY['INTERACTIVE'],
   'fixed','tenant','required',1,
   'X1 owner-bound ordinary duty continuation; separate type excludes old P1 binaries and cannot carry governed S6 obligations.');
