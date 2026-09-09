-- Durable, replay-safe creation of a new Microsoft file from an existing local
-- DocumentVersion. Core Document remains the only logical artifact identity.
CREATE TABLE finnor_os.artifact_provider_creations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  local_version_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  source_scope_id uuid NOT NULL,
  drive_id text NOT NULL CHECK(length(drive_id) BETWEEN 1 AND 1024),
  parent_item_id text NOT NULL CHECK(length(parent_item_id) BETWEEN 1 AND 1024),
  file_name text NOT NULL CHECK(length(file_name) BETWEEN 1 AND 255),
  write_mode text NOT NULL CHECK(write_mode IN ('APP_ONLY_FILE_CREATE','DELEGATED_FILE_CREATE')),
  conflict_behavior text NOT NULL DEFAULT 'fail' CHECK(conflict_behavior='fail'),
  actor_id uuid NOT NULL,
  authority_decision_id uuid NOT NULL,
  expected_semantic_hash text NOT NULL CHECK(expected_semantic_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK(status IN (
    'prepared','writing','acknowledged','verified','verified_provider_normalized',
    'conflict','verification_failed','unknown_delivery'
  )),
  provider_item_id text,
  external_ref_id uuid,
  readback_version_id uuid,
  provider_ack jsonb NOT NULL DEFAULT '{}',
  verification_diff jsonb NOT NULL DEFAULT '[]',
  failure text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  FOREIGN KEY(tenant_id,document_id,local_version_id)
    REFERENCES finnor_os.document_versions(tenant_id,document_id,id),
  FOREIGN KEY(tenant_id,integration_id)
    REFERENCES finnor_os.tenant_integrations(tenant_id,id),
  FOREIGN KEY(tenant_id,integration_id,source_scope_id)
    REFERENCES finnor_os.integration_source_scopes(tenant_id,integration_id,id),
  FOREIGN KEY(tenant_id,actor_id) REFERENCES finnor_os.users(tenant_id,id),
  FOREIGN KEY(tenant_id,external_ref_id) REFERENCES finnor_os.external_refs(tenant_id,id),
  FOREIGN KEY(tenant_id,document_id,readback_version_id)
    REFERENCES finnor_os.document_versions(tenant_id,document_id,id),
  CHECK(octet_length(provider_ack::text)<=32768 AND octet_length(verification_diff::text)<=1048576),
  CHECK((external_ref_id IS NULL)=(provider_item_id IS NULL)),
  UNIQUE(tenant_id,integration_id,drive_id,parent_item_id,file_name,local_version_id)
);

CREATE OR REPLACE FUNCTION finnor_os.assert_artifact_provider_creation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE decision record; scope record; ref record;
BEGIN
  SELECT * INTO decision FROM finnor_os.authority_decisions WHERE id=NEW.authority_decision_id;
  IF NOT FOUND OR decision.tenant_id<>NEW.tenant_id THEN
    RAISE EXCEPTION 'artifact provider creation authority tenant mismatch';
  END IF;
  SELECT * INTO scope FROM finnor_os.integration_source_scopes WHERE id=NEW.source_scope_id;
  IF NOT FOUND OR scope.tenant_id<>NEW.tenant_id OR scope.integration_id<>NEW.integration_id
     OR scope.provider<>'microsoft_graph' OR scope.source_kind<>'sharepoint_drive' THEN
    RAISE EXCEPTION 'artifact provider creation source scope mismatch';
  END IF;
  IF NEW.external_ref_id IS NOT NULL THEN
    SELECT * INTO ref FROM finnor_os.external_refs WHERE id=NEW.external_ref_id;
    IF NOT FOUND OR ref.tenant_id<>NEW.tenant_id OR ref.integration_id<>NEW.integration_id
       OR ref.internal_id IS DISTINCT FROM NEW.document_id OR ref.provider<>'microsoft_graph' THEN
      RAISE EXCEPTION 'artifact provider creation external reference mismatch';
    END IF;
  END IF;
  IF TG_OP='UPDATE' AND (
    NEW.tenant_id<>OLD.tenant_id OR NEW.document_id<>OLD.document_id
    OR NEW.local_version_id<>OLD.local_version_id OR NEW.integration_id<>OLD.integration_id
    OR NEW.source_scope_id<>OLD.source_scope_id OR NEW.drive_id<>OLD.drive_id
    OR NEW.parent_item_id<>OLD.parent_item_id OR NEW.file_name<>OLD.file_name
    OR NEW.write_mode<>OLD.write_mode OR NEW.conflict_behavior<>OLD.conflict_behavior
    OR NEW.actor_id<>OLD.actor_id OR NEW.authority_decision_id<>OLD.authority_decision_id
    OR NEW.expected_semantic_hash<>OLD.expected_semantic_hash
    OR (OLD.provider_item_id IS NOT NULL AND NEW.provider_item_id IS DISTINCT FROM OLD.provider_item_id)
    OR (OLD.external_ref_id IS NOT NULL AND NEW.external_ref_id IS DISTINCT FROM OLD.external_ref_id)
    OR (OLD.readback_version_id IS NOT NULL AND NEW.readback_version_id IS DISTINCT FROM OLD.readback_version_id)
  ) THEN RAISE EXCEPTION 'artifact provider creation identity immutable'; END IF;
  IF TG_OP='UPDATE' AND (
    (OLD.status='prepared' AND NEW.status NOT IN ('prepared','writing','conflict','verification_failed')) OR
    (OLD.status='writing' AND NEW.status NOT IN ('writing','acknowledged','conflict','unknown_delivery','verification_failed')) OR
    (OLD.status='acknowledged' AND NEW.status NOT IN ('acknowledged','verified','verified_provider_normalized','verification_failed','unknown_delivery')) OR
    (OLD.status='unknown_delivery' AND NEW.status NOT IN ('unknown_delivery','writing','acknowledged','verified','verified_provider_normalized','conflict','verification_failed')) OR
    (OLD.status NOT IN ('prepared','writing','acknowledged','unknown_delivery') AND NEW.status<>OLD.status)
  ) THEN RAISE EXCEPTION 'invalid artifact provider creation state transition'; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER artifact_provider_creation_guard
  BEFORE INSERT OR UPDATE ON finnor_os.artifact_provider_creations
  FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_artifact_provider_creation();
CREATE INDEX artifact_provider_creations_document_idx
  ON finnor_os.artifact_provider_creations(tenant_id,document_id,created_at DESC);
CREATE INDEX artifact_provider_creations_status_idx
  ON finnor_os.artifact_provider_creations(tenant_id,status,created_at);
ALTER TABLE finnor_os.artifact_provider_creations ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.artifact_provider_creations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finnor_os.artifact_provider_creations
  USING(tenant_id=finnor_os.request_tenant_id())
  WITH CHECK(tenant_id=finnor_os.request_tenant_id());
GRANT SELECT,INSERT,UPDATE ON finnor_os.artifact_provider_creations TO finnor_app;
