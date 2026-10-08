-- Forward-only proposal following the unchanged original P3 candidate.
-- Integration steward assigns the final unique registry ordinal.
ALTER TABLE finnor_os.data_retention_holds DROP CONSTRAINT data_retention_holds_resource_type_check;
ALTER TABLE finnor_os.data_retention_holds ADD CONSTRAINT data_retention_holds_resource_type_check
 CHECK(resource_type IN('call','message','job','work','m4_search','p3_checkpoint'));
ALTER TABLE finnor_os.tenant_retention_policies DROP CONSTRAINT tenant_retention_policies_data_class_check;
ALTER TABLE finnor_os.tenant_retention_policies ADD CONSTRAINT tenant_retention_policies_data_class_check
 CHECK(data_class IN('messages','job_payloads','computer_artifact_content','model_records','m4_evidence','p3_checkpoint'));
CREATE TABLE finnor_os.p3_checkpoint_payloads(
 tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),principal_id uuid NOT NULL REFERENCES finnor_os.users(id),
 work_id uuid NOT NULL REFERENCES finnor_os.works(id),checkpoint_id uuid PRIMARY KEY REFERENCES finnor_os.p3_artifacts(id),
 key_id text NOT NULL CHECK(key_id ~ '^[A-Za-z0-9_-]{1,80}$'),
 nonce bytea NOT NULL CHECK(octet_length(nonce)=12),tag bytea NOT NULL CHECK(octet_length(tag)=16),
 ciphertext bytea NOT NULL CHECK(octet_length(ciphertext)<=3145728),expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE finnor_os.p3_checkpoint_revocations(
 tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),principal_id uuid NOT NULL REFERENCES finnor_os.users(id),
 work_id uuid NOT NULL REFERENCES finnor_os.works(id),checkpoint_id uuid PRIMARY KEY REFERENCES finnor_os.p3_artifacts(id),
 reason text NOT NULL CHECK(reason='OWNER_REVOKED'),revoked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION finnor_os.p3_checkpoint_scope_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
DECLARE a finnor_os.p3_artifacts;BEGIN
 SELECT * INTO a FROM finnor_os.p3_artifacts WHERE id=NEW.checkpoint_id;
 IF a.id IS NULL OR a.category<>'CHECKPOINT' OR
    (a.tenant_id,a.principal_id,a.work_id) IS DISTINCT FROM (NEW.tenant_id,NEW.principal_id,NEW.work_id) OR
    a.body->>'schema'<>'finnor.branch-checkpoint-sealed.v2' THEN
  RAISE EXCEPTION 'P3 encrypted checkpoint identity mismatch';
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION finnor_os.p3_checkpoint_delete_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF OLD.expires_at>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM finnor_os.p3_checkpoint_revocations r
    WHERE r.checkpoint_id=OLD.checkpoint_id AND r.tenant_id=OLD.tenant_id AND r.principal_id=OLD.principal_id) OR
    EXISTS(SELECT 1 FROM finnor_os.data_retention_holds h WHERE h.tenant_id=OLD.tenant_id AND h.released_at IS NULL AND
      ((h.resource_type='work' AND h.resource_id=OLD.work_id) OR (h.resource_type='p3_checkpoint' AND h.resource_id=OLD.checkpoint_id))) OR
    EXISTS(SELECT 1 FROM finnor_os.tenant_retention_policies t WHERE t.tenant_id=OLD.tenant_id AND t.data_class='p3_checkpoint' AND t.legal_hold) THEN
  RAISE EXCEPTION 'P3 checkpoint retention hold or unexpired access prohibits erasure';
 END IF;
 RETURN OLD;
END $$;
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['p3_checkpoint_payloads','p3_checkpoint_revocations'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY p3_checkpoint_private_scope ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',t);
  EXECUTE format('CREATE TRIGGER p3_checkpoint_scope BEFORE INSERT ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.p3_checkpoint_scope_guard()',t);
  EXECUTE format('CREATE TRIGGER p3_checkpoint_immutable BEFORE UPDATE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.p3_immutable()',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
 END LOOP;
END $$;
CREATE TRIGGER p3_checkpoint_revocation_immutable BEFORE DELETE ON finnor_os.p3_checkpoint_revocations FOR EACH ROW EXECUTE FUNCTION finnor_os.p3_immutable();
CREATE TRIGGER p3_checkpoint_retention BEFORE DELETE ON finnor_os.p3_checkpoint_payloads FOR EACH ROW EXECUTE FUNCTION finnor_os.p3_checkpoint_delete_guard();
GRANT DELETE ON finnor_os.p3_checkpoint_payloads TO finnor_app;
CREATE INDEX p3_checkpoint_retention_idx ON finnor_os.p3_checkpoint_payloads(tenant_id,principal_id,expires_at,checkpoint_id);
