-- X1 source and subject authority is distinct from source content and mandate.
-- No provider credential, inferred role or supplied consent string is a grant.
CREATE TABLE finnor_os.x1_source_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  work_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  institution_id text NOT NULL CHECK (btrim(institution_id)<>''),
  source_id text NOT NULL CHECK (btrim(source_id)<>''),
  source_class text NOT NULL CHECK (source_class IN (
    'financial_ledger','document_dms','crm_deals','email','calendar',
    'work_tracking','approval_records','lender_portal','personnel_benefits','expense_administration')),
  purpose text NOT NULL CHECK (btrim(purpose)<>''),
  acquisition_kind text NOT NULL CHECK (acquisition_kind IN ('core_export','installed_adapter')),
  document_id uuid,
  document_version_id uuid,
  integration_id uuid,
  provider text,
  adapter_scope text,
  external_object_type text,
  external_id text,
  protocol text NOT NULL CHECK (btrim(protocol)<>''),
  revision text NOT NULL CHECK (btrim(revision)<>''),
  original_sha256 text CHECK (original_sha256 IS NULL OR original_sha256 ~ '^[0-9a-f]{64}$'),
  expected_object_ids jsonb NOT NULL CHECK (jsonb_typeof(expected_object_ids)='array'
    AND octet_length(expected_object_ids::text)<=65536),
  version integer NOT NULL DEFAULT 1 CHECK (version>0),
  valid_from timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,work_id,principal_id,source_id,version),
  FOREIGN KEY (tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
  FOREIGN KEY (tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
  FOREIGN KEY (tenant_id,document_id) REFERENCES finnor_os.documents(tenant_id,id),
  FOREIGN KEY (tenant_id,document_version_id) REFERENCES finnor_os.document_versions(tenant_id,id),
  FOREIGN KEY (tenant_id,integration_id) REFERENCES finnor_os.tenant_integrations(tenant_id,id),
  CHECK (expires_at>valid_from),
  CHECK ((acquisition_kind='core_export' AND document_id IS NOT NULL AND document_version_id IS NOT NULL
    AND original_sha256 IS NOT NULL AND integration_id IS NULL AND provider IS NULL
    AND adapter_scope IS NULL AND external_object_type IS NULL AND external_id IS NULL)
    OR (acquisition_kind='installed_adapter' AND document_id IS NULL AND document_version_id IS NULL
    AND original_sha256 IS NOT NULL AND integration_id IS NOT NULL AND provider IS NOT NULL AND adapter_scope IS NOT NULL
    AND external_object_type IS NOT NULL AND external_id IS NOT NULL))
);
CREATE INDEX x1_source_grants_current_idx
 ON finnor_os.x1_source_grants(tenant_id,work_id,principal_id,source_id,version DESC);

CREATE TABLE finnor_os.x1_source_acquisitions (
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  grant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  document_version_id uuid NOT NULL,
  byte_sha256 text NOT NULL CHECK (byte_sha256 ~ '^[0-9a-f]{64}$'),
  provider_revision text NOT NULL CHECK (btrim(provider_revision)<>''),
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,grant_id),
  FOREIGN KEY (tenant_id,grant_id) REFERENCES finnor_os.x1_source_grants(tenant_id,id),
  FOREIGN KEY (tenant_id,document_id) REFERENCES finnor_os.documents(tenant_id,id),
  FOREIGN KEY (tenant_id,document_id,document_version_id)
    REFERENCES finnor_os.document_versions(tenant_id,document_id,id)
);
CREATE FUNCTION finnor_os.x1_source_acquisitions_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  RAISE EXCEPTION 'X1 original acquisition is immutable';
END $$;
CREATE TRIGGER x1_source_acquisitions_immutable BEFORE UPDATE OR DELETE
 ON finnor_os.x1_source_acquisitions FOR EACH ROW
 EXECUTE FUNCTION finnor_os.x1_source_acquisitions_immutable();

CREATE TABLE finnor_os.x1_work_mandates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  work_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  institution_id text NOT NULL CHECK (btrim(institution_id)<>''),
  revision text NOT NULL CHECK (btrim(revision)<>''),
  rules jsonb NOT NULL CHECK (jsonb_typeof(rules)='array' AND octet_length(rules::text)<=131072),
  valid_from timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,work_id,revision),
  FOREIGN KEY (tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
  FOREIGN KEY (tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
  CHECK (expires_at>valid_from)
);

-- Identity owner binds a source-scoped subject identifier to a real employee.
-- It is not inferred by X1 from matching names, email bodies or job titles.
CREATE TABLE finnor_os.x1_subject_identity_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  institution_id text NOT NULL,
  source_id text NOT NULL,
  registration_id text NOT NULL,
  subject_user_id uuid NOT NULL,
  evidence_source_id uuid NOT NULL,
  evidence_version_id uuid NOT NULL,
  valid_from timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  UNIQUE (tenant_id,institution_id,source_id,registration_id),
  FOREIGN KEY (tenant_id,subject_user_id) REFERENCES finnor_os.users(tenant_id,id),
  FOREIGN KEY (evidence_source_id) REFERENCES finnor_os.evidence_sources(id),
  FOREIGN KEY (evidence_version_id) REFERENCES finnor_os.evidence_source_versions(id),
  CHECK (expires_at>valid_from)
);
CREATE FUNCTION finnor_os.x1_check_subject_identity_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  PERFORM finnor_os.assert_pe_twin_evidence(NEW.tenant_id,NEW.evidence_source_id,
    NEW.evidence_version_id,'X1 subject identity binding');
  RETURN NEW;
END $$;
CREATE TRIGGER x1_subject_identity_evidence BEFORE INSERT OR UPDATE
 ON finnor_os.x1_subject_identity_bindings FOR EACH ROW
 EXECUTE FUNCTION finnor_os.x1_check_subject_identity_evidence();

CREATE TABLE finnor_os.x1_subject_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  subject_user_id uuid NOT NULL,
  institution_id text NOT NULL,
  source_class text NOT NULL CHECK (source_class IN ('personnel_benefits','expense_administration')),
  purpose text NOT NULL CHECK (btrim(purpose)<>''),
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  UNIQUE (tenant_id,subject_user_id,institution_id,source_class,purpose),
  FOREIGN KEY (tenant_id,subject_user_id) REFERENCES finnor_os.users(tenant_id,id),
  CHECK (expires_at>granted_at)
);

-- Publication joins existing canonical owner receipts, not another truth store.
-- A missing row means a partial/failed transaction was never admitted.
CREATE TABLE finnor_os.x1_mapping_admissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),
  work_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  original_digest text NOT NULL CHECK (original_digest ~ '^[0-9a-f]{64}$'),
  candidate_digest text NOT NULL CHECK (candidate_digest ~ '^[0-9a-f]{64}$'),
  checker_digest text NOT NULL CHECK (checker_digest ~ '^[0-9a-f]{64}$'),
  receipts jsonb NOT NULL CHECK (jsonb_typeof(receipts)='array' AND octet_length(receipts::text)<=262144),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,work_id,original_digest,candidate_digest),
  FOREIGN KEY (tenant_id,work_id) REFERENCES finnor_os.works(tenant_id,id),
  FOREIGN KEY (tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id)
);
CREATE FUNCTION finnor_os.x1_mapping_admissions_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  RAISE EXCEPTION 'X1 admission publication is immutable';
END $$;
CREATE TRIGGER x1_mapping_admissions_immutable BEFORE UPDATE OR DELETE
 ON finnor_os.x1_mapping_admissions FOR EACH ROW
 EXECUTE FUNCTION finnor_os.x1_mapping_admissions_immutable();

DO $x1_rls$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['x1_source_grants','x1_source_acquisitions','x1_work_mandates','x1_subject_identity_bindings','x1_subject_consents','x1_mapping_admissions'] LOOP
    EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY x1_tenant_scope ON finnor_os.%I USING (tenant_id=finnor_os.request_tenant_id()) WITH CHECK (tenant_id=finnor_os.request_tenant_id())',t);
  END LOOP;
END $x1_rls$;

-- Consent may be inserted/renewed/revoked only by its subject. Source grants
-- and identity bindings are provisioned by existing restricted owner authority.
CREATE POLICY x1_consent_subject_write ON finnor_os.x1_subject_consents
 FOR ALL USING (tenant_id=finnor_os.request_tenant_id()
   AND subject_user_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK (tenant_id=finnor_os.request_tenant_id()
   AND subject_user_id=nullif(current_setting('app.user_id',true),'')::uuid);
DROP POLICY x1_tenant_scope ON finnor_os.x1_subject_consents;
CREATE POLICY x1_consent_tenant_read ON finnor_os.x1_subject_consents
 FOR SELECT USING (tenant_id=finnor_os.request_tenant_id());

DO $x1_grants$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
    GRANT SELECT ON finnor_os.x1_source_grants,finnor_os.x1_work_mandates,
      finnor_os.x1_subject_identity_bindings TO finnor_app;
    GRANT SELECT,INSERT ON finnor_os.x1_source_acquisitions TO finnor_app;
    GRANT SELECT,INSERT,UPDATE (expires_at,revoked_at,revision)
      ON finnor_os.x1_subject_consents TO finnor_app;
    GRANT SELECT,INSERT ON finnor_os.x1_mapping_admissions TO finnor_app;
  END IF;
END $x1_grants$;
