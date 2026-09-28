-- Underwriting Runs keep their P4 owner. Artifact citations can point directly
-- to its immutable Run without pretending it is a Company Brain entity.
CREATE OR REPLACE FUNCTION finnor_os.assert_artifact_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE known_at timestamptz; artifact_at timestamptz; target_tenant uuid;
BEGIN
  SELECT created_at INTO artifact_at FROM finnor_os.document_versions
    WHERE tenant_id=NEW.tenant_id AND id=NEW.version_id;
  IF NEW.target_kind='evidence_version' THEN
    SELECT tenant_id,retrieved_at INTO target_tenant,known_at
      FROM finnor_os.evidence_source_versions WHERE id=NEW.target_id AND scope='tenant';
    IF known_at IS NULL OR known_at>artifact_at THEN RAISE EXCEPTION 'artifact citation violates no-hindsight evidence'; END IF;
  ELSIF NEW.target_kind='document_version' THEN
    SELECT tenant_id,created_at INTO target_tenant,known_at FROM finnor_os.document_versions WHERE id=NEW.target_id;
    IF known_at>artifact_at THEN RAISE EXCEPTION 'artifact source version postdates artifact'; END IF;
  ELSIF NEW.target_kind='canonical_entity' AND NEW.target_entity_type='underwriting_run' THEN
    SELECT tenant_id,computed_at INTO target_tenant,known_at FROM finnor_os.underwriting_runs WHERE id=NEW.target_id;
    IF known_at IS NULL OR known_at>artifact_at THEN RAISE EXCEPTION 'artifact Underwriting Run source postdates artifact'; END IF;
  ELSE
    target_tenant:=finnor_os.canonical_entity_tenant(NEW.target_entity_type,NEW.target_id);
  END IF;
  IF target_tenant IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'artifact binding target missing or crosses tenant'; END IF;
  RETURN NEW;
END $$;
