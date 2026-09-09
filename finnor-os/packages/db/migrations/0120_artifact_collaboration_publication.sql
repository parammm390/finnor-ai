CREATE TABLE finnor_os.artifact_operations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,document_id uuid NOT NULL,base_version_id uuid NOT NULL,result_version_id uuid,
 operation_type text NOT NULL DEFAULT 'typed_patch' CHECK(operation_type IN ('typed_patch','template_instantiation','provider_readback_merge')),
 patch_hash text NOT NULL CHECK(patch_hash ~ '^[0-9a-f]{64}$'),patch jsonb NOT NULL CHECK(octet_length(patch::text)<=1048576),semantic_diff jsonb NOT NULL CHECK(octet_length(semantic_diff::text)<=1048576),
 status text NOT NULL CHECK(status IN ('succeeded','failed')),error text CHECK(error IS NULL OR length(error)<=1000),
 actor_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,document_id,base_version_id) REFERENCES finnor_os.document_versions(tenant_id,document_id,id),
 FOREIGN KEY(tenant_id,document_id,result_version_id) REFERENCES finnor_os.document_versions(tenant_id,document_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES finnor_os.users(tenant_id,id),UNIQUE(tenant_id,document_id,base_version_id,patch_hash)
);
CREATE TABLE finnor_os.artifact_bindings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,version_id uuid NOT NULL,anchor_id text NOT NULL,anchor_hash text NOT NULL CHECK(anchor_hash ~ '^[0-9a-f]{64}$'),
 target_kind text NOT NULL CHECK(target_kind IN ('evidence_version','canonical_entity','document_version')),target_id uuid NOT NULL,target_entity_type text,target_anchor text,
 actor_id uuid,created_by text NOT NULL CHECK(length(created_by) BETWEEN 1 AND 160),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,version_id) REFERENCES finnor_os.document_versions(tenant_id,id),FOREIGN KEY(tenant_id,actor_id) REFERENCES finnor_os.users(tenant_id,id),
 CHECK(length(anchor_id)<=2048 AND (target_anchor IS NULL OR length(target_anchor)<=2048)),
 CHECK((target_kind='canonical_entity')=(target_entity_type IS NOT NULL))
);
CREATE OR REPLACE FUNCTION finnor_os.assert_artifact_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE known_at timestamptz; artifact_at timestamptz; target_tenant uuid;
BEGIN
 SELECT created_at INTO artifact_at FROM finnor_os.document_versions WHERE tenant_id=NEW.tenant_id AND id=NEW.version_id;
 IF NEW.target_kind='evidence_version' THEN
  SELECT tenant_id,retrieved_at INTO target_tenant,known_at FROM finnor_os.evidence_source_versions WHERE id=NEW.target_id AND scope='tenant';
  IF known_at IS NULL OR known_at>artifact_at THEN RAISE EXCEPTION 'artifact citation violates no-hindsight evidence'; END IF;
 ELSIF NEW.target_kind='document_version' THEN SELECT tenant_id,created_at INTO target_tenant,known_at FROM finnor_os.document_versions WHERE id=NEW.target_id;
  IF known_at>artifact_at THEN RAISE EXCEPTION 'artifact source version postdates artifact'; END IF;
 ELSE target_tenant:=finnor_os.canonical_entity_tenant(NEW.target_entity_type,NEW.target_id); END IF;
 IF target_tenant IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'artifact binding target missing or crosses tenant'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER artifact_binding_guard BEFORE INSERT ON finnor_os.artifact_bindings FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_artifact_binding();
CREATE TABLE finnor_os.artifact_anchor_remaps (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,source_version_id uuid NOT NULL,target_version_id uuid NOT NULL,
 source_anchor_id text NOT NULL,source_anchor_hash text NOT NULL CHECK(source_anchor_hash ~ '^[0-9a-f]{64}$'),
 target_anchor_id text,target_anchor_hash text CHECK(target_anchor_hash IS NULL OR target_anchor_hash ~ '^[0-9a-f]{64}$'),
 status text NOT NULL CHECK(status IN ('exact','stale','ambiguous')),reason text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,source_version_id) REFERENCES finnor_os.document_versions(tenant_id,id),
 FOREIGN KEY(tenant_id,target_version_id) REFERENCES finnor_os.document_versions(tenant_id,id),
 CHECK((status='exact')=(target_anchor_id IS NOT NULL AND target_anchor_hash IS NOT NULL)),
 UNIQUE(tenant_id,source_version_id,target_version_id,source_anchor_id)
);
CREATE TABLE finnor_os.artifact_comments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,version_id uuid NOT NULL,anchor_id text NOT NULL,anchor_hash text NOT NULL,
 author_id uuid NOT NULL,body text NOT NULL CHECK(length(body) BETWEEN 1 AND 10000),parent_comment_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,version_id) REFERENCES finnor_os.document_versions(tenant_id,id),FOREIGN KEY(tenant_id,author_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,parent_comment_id) REFERENCES finnor_os.artifact_comments(tenant_id,id),CHECK(length(anchor_id)<=2048 AND anchor_hash ~ '^[0-9a-f]{64}$')
);
CREATE TABLE finnor_os.artifact_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,version_id uuid NOT NULL,actor_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('requested','approved','changes_requested','withdrawn','comment_resolved')),comment_id uuid,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,version_id) REFERENCES finnor_os.document_versions(tenant_id,id),FOREIGN KEY(tenant_id,actor_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,comment_id) REFERENCES finnor_os.artifact_comments(tenant_id,id),CHECK((state='comment_resolved')=(comment_id IS NOT NULL))
);
CREATE TABLE finnor_os.artifact_templates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,template_key text NOT NULL CHECK(length(template_key) BETWEEN 1 AND 160),version_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('xlsx','xlsm','docx','pptx')),status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired')),
 actor_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,version_id) REFERENCES finnor_os.document_versions(tenant_id,id),FOREIGN KEY(tenant_id,actor_id) REFERENCES finnor_os.users(tenant_id,id),UNIQUE(tenant_id,template_key,version_id)
);
CREATE TABLE finnor_os.artifact_publications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,document_id uuid NOT NULL,local_version_id uuid NOT NULL,base_version_id uuid NOT NULL,
 integration_id uuid NOT NULL,external_ref_id uuid NOT NULL,base_etag text NOT NULL,write_mode text NOT NULL CHECK(write_mode IN ('APP_ONLY_FILE_REPLACE','DELEGATED_FILE_REPLACE')),
 provider_binding_key text NOT NULL CHECK(length(provider_binding_key) BETWEEN 1 AND 256),
 actor_id uuid NOT NULL,authority_decision_id uuid NOT NULL,readback_version_id uuid,
 expected_semantic_hash text NOT NULL CHECK(expected_semantic_hash ~ '^[0-9a-f]{64}$'),verification_diff jsonb NOT NULL DEFAULT '[]',
 status text NOT NULL CHECK(status IN ('prepared','writing','acknowledged','verified','verified_provider_normalized','conflict','verification_failed','unknown_delivery')),
 provider_ack jsonb NOT NULL DEFAULT '{}',failure text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 FOREIGN KEY(tenant_id,document_id,local_version_id) REFERENCES finnor_os.document_versions(tenant_id,document_id,id),
 FOREIGN KEY(tenant_id,document_id,base_version_id) REFERENCES finnor_os.document_versions(tenant_id,document_id,id),
 FOREIGN KEY(tenant_id,document_id,readback_version_id) REFERENCES finnor_os.document_versions(tenant_id,document_id,id),
 FOREIGN KEY(tenant_id,integration_id) REFERENCES finnor_os.tenant_integrations(tenant_id,id),FOREIGN KEY(tenant_id,actor_id) REFERENCES finnor_os.users(tenant_id,id),
 FOREIGN KEY(tenant_id,external_ref_id) REFERENCES finnor_os.external_refs(tenant_id,id),
 CHECK(octet_length(provider_ack::text)<=32768 AND octet_length(verification_diff::text)<=1048576),
 UNIQUE(tenant_id,external_ref_id,local_version_id,base_etag)
);
CREATE OR REPLACE FUNCTION finnor_os.assert_artifact_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ref record; decision record;
BEGIN
 SELECT * INTO ref FROM finnor_os.external_refs WHERE id=NEW.external_ref_id;
 IF NOT FOUND OR ref.tenant_id<>NEW.tenant_id OR ref.internal_id IS DISTINCT FROM NEW.document_id OR ref.integration_id IS DISTINCT FROM NEW.integration_id OR ref.provider<>'microsoft_graph' THEN RAISE EXCEPTION 'artifact publication provider binding mismatch'; END IF;
 SELECT * INTO decision FROM finnor_os.authority_decisions WHERE id=NEW.authority_decision_id;
 IF NOT FOUND OR decision.tenant_id<>NEW.tenant_id THEN RAISE EXCEPTION 'artifact publication authority tenant mismatch'; END IF;
 IF TG_OP='UPDATE' AND (NEW.tenant_id<>OLD.tenant_id OR NEW.document_id<>OLD.document_id OR NEW.local_version_id<>OLD.local_version_id OR NEW.base_version_id<>OLD.base_version_id OR NEW.external_ref_id<>OLD.external_ref_id OR NEW.authority_decision_id<>OLD.authority_decision_id OR NEW.actor_id<>OLD.actor_id OR NEW.base_etag<>OLD.base_etag OR NEW.write_mode<>OLD.write_mode OR NEW.integration_id<>OLD.integration_id OR NEW.provider_binding_key<>OLD.provider_binding_key OR NEW.expected_semantic_hash<>OLD.expected_semantic_hash) THEN RAISE EXCEPTION 'artifact publication identity immutable'; END IF;
 IF TG_OP='UPDATE' AND (
   (OLD.status='prepared' AND NEW.status NOT IN ('prepared','writing','conflict','verification_failed')) OR
   (OLD.status='writing' AND NEW.status NOT IN ('writing','acknowledged','conflict','unknown_delivery','verification_failed')) OR
   (OLD.status='acknowledged' AND NEW.status NOT IN ('acknowledged','verified','verified_provider_normalized','verification_failed','unknown_delivery')) OR
   (OLD.status NOT IN ('prepared','writing','acknowledged') AND NEW.status<>OLD.status)
 ) THEN RAISE EXCEPTION 'invalid artifact publication state transition'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER artifact_publication_guard BEFORE INSERT OR UPDATE ON finnor_os.artifact_publications FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_artifact_publication();
CREATE OR REPLACE FUNCTION finnor_os.assert_artifact_comment_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE related_version uuid;
BEGIN
 IF TG_TABLE_NAME='artifact_comments' AND NEW.parent_comment_id IS NOT NULL THEN
   SELECT version_id INTO related_version FROM finnor_os.artifact_comments WHERE tenant_id=NEW.tenant_id AND id=NEW.parent_comment_id;
   IF related_version IS DISTINCT FROM NEW.version_id THEN RAISE EXCEPTION 'comment reply must stay on the same artifact version'; END IF;
 ELSIF TG_TABLE_NAME='artifact_reviews' AND NEW.comment_id IS NOT NULL THEN
   SELECT version_id INTO related_version FROM finnor_os.artifact_comments WHERE tenant_id=NEW.tenant_id AND id=NEW.comment_id;
   IF related_version IS DISTINCT FROM NEW.version_id THEN RAISE EXCEPTION 'comment resolution must stay on the same artifact version'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER artifact_comment_guard BEFORE INSERT ON finnor_os.artifact_comments FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_artifact_comment_review();
CREATE TRIGGER artifact_review_guard BEFORE INSERT ON finnor_os.artifact_reviews FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_artifact_comment_review();
CREATE INDEX artifact_operations_document_idx ON finnor_os.artifact_operations(tenant_id,document_id,created_at);
CREATE INDEX artifact_operations_result_idx ON finnor_os.artifact_operations(tenant_id,result_version_id);
CREATE INDEX artifact_bindings_version_idx ON finnor_os.artifact_bindings(tenant_id,version_id,anchor_id);
CREATE INDEX artifact_bindings_target_idx ON finnor_os.artifact_bindings(tenant_id,target_kind,target_id);
CREATE INDEX artifact_anchor_remaps_source_idx ON finnor_os.artifact_anchor_remaps(tenant_id,source_version_id,source_anchor_id);
CREATE INDEX artifact_anchor_remaps_target_idx ON finnor_os.artifact_anchor_remaps(tenant_id,target_version_id,target_anchor_id) WHERE target_anchor_id IS NOT NULL;
CREATE INDEX artifact_comments_version_idx ON finnor_os.artifact_comments(tenant_id,version_id,created_at);
CREATE INDEX artifact_comments_parent_idx ON finnor_os.artifact_comments(tenant_id,parent_comment_id) WHERE parent_comment_id IS NOT NULL;
CREATE INDEX artifact_reviews_version_idx ON finnor_os.artifact_reviews(tenant_id,version_id,created_at);
CREATE INDEX artifact_templates_key_idx ON finnor_os.artifact_templates(tenant_id,template_key,created_at DESC);
CREATE INDEX artifact_publications_document_idx ON finnor_os.artifact_publications(tenant_id,document_id,created_at DESC);
CREATE INDEX artifact_publications_status_idx ON finnor_os.artifact_publications(tenant_id,status,created_at);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['artifact_operations','artifact_bindings','artifact_anchor_remaps','artifact_comments','artifact_reviews','artifact_templates','artifact_publications'] LOOP
 EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_isolation ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id()) WITH CHECK(tenant_id=finnor_os.request_tenant_id())',t);
 EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
 IF t<>'artifact_publications' THEN EXECUTE format('CREATE TRIGGER immutable_artifact_history BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.reject_artifact_history_mutation()',t);END IF;
 END LOOP; GRANT UPDATE ON finnor_os.artifact_publications TO finnor_app;
END $$;
