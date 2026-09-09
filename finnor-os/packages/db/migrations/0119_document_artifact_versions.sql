-- Immutable work-product children of Core Document; no second canonical entity.
-- documents(tenant_id,id) already exists from 0105 and remains the ownership key.
CREATE TABLE finnor_os.document_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, document_id uuid NOT NULL,
 version_ordinal integer NOT NULL CHECK(version_ordinal>0), parent_version_id uuid,
 origin text NOT NULL CHECK(origin IN ('baseline','legacy_write','provider_observation','manual_upload','finnor_edit','finnor_generated','template_instantiation','merge','readback')),
 format text NOT NULL CHECK(format IN ('xlsx','xlsm','docx','pptx','pdf','unknown')),
 media_type text NOT NULL CHECK(length(media_type) BETWEEN 1 AND 255),
 source_system text, source_ref text, provider_version_id text, provider_etag text, provider_ctag text,
 byte_sha256 text NOT NULL CHECK(byte_sha256 ~ '^[0-9a-f]{64}$'),
 size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 0 AND 10485760),
 created_by text NOT NULL CHECK(length(created_by) BETWEEN 1 AND 160), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,document_id,id), UNIQUE(tenant_id,document_id,version_ordinal),
 FOREIGN KEY(tenant_id,document_id) REFERENCES finnor_os.documents(tenant_id,id),
 FOREIGN KEY(tenant_id,document_id,parent_version_id) REFERENCES finnor_os.document_versions(tenant_id,document_id,id)
);
CREATE TABLE finnor_os.document_version_contents (
 tenant_id uuid NOT NULL, version_id uuid PRIMARY KEY,
 storage_backend text NOT NULL DEFAULT 'postgres' CHECK(storage_backend IN ('postgres','external')),
 storage_ref text, bytes bytea, media_type text NOT NULL, size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 0 AND 10485760),
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,version_id) REFERENCES finnor_os.document_versions(tenant_id,id),
 CHECK(
   (storage_backend='postgres' AND storage_ref IS NULL AND bytes IS NOT NULL
     AND octet_length(bytes)=size_bytes AND encode(sha256(bytes),'hex')=sha256)
   OR
   (storage_backend='external' AND storage_ref IS NOT NULL AND bytes IS NULL)
 )
);
CREATE TABLE finnor_os.document_version_heads (
 tenant_id uuid NOT NULL, document_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('current','provider','draft','published')),
 head_key text NOT NULL CHECK(length(head_key) BETWEEN 1 AND 256), version_id uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,document_id,kind,head_key),
 FOREIGN KEY(tenant_id,document_id,version_id) REFERENCES finnor_os.document_versions(tenant_id,document_id,id)
);
CREATE TABLE finnor_os.artifact_ir_snapshots (
 tenant_id uuid NOT NULL, version_id uuid NOT NULL, parser_schema text NOT NULL CHECK(length(parser_schema) BETWEEN 1 AND 80),
 kind text NOT NULL, semantic_hash text NOT NULL CHECK(semantic_hash ~ '^[0-9a-f]{64}$'),
 parse_status text NOT NULL CHECK(parse_status IN ('parsed','unsupported','failed')),
 fidelity_status text NOT NULL CHECK(fidelity_status IN ('preserved','read_only','unsupported')),
 calculation_status text NOT NULL DEFAULT 'not_applicable' CHECK(calculation_status IN ('not_applicable','unknown','stale','verified')),
 ir jsonb NOT NULL CHECK(octet_length(ir::text)<=16777216), warnings jsonb NOT NULL DEFAULT '[]', unsupported_features jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(jsonb_typeof(warnings)='array' AND jsonb_typeof(unsupported_features)='array'),
 PRIMARY KEY(tenant_id,version_id,parser_schema), FOREIGN KEY(tenant_id,version_id) REFERENCES finnor_os.document_versions(tenant_id,id)
);
CREATE TABLE finnor_os.artifact_lineage_edges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, source_version_id uuid NOT NULL, target_version_id uuid NOT NULL,
 relation text NOT NULL CHECK(relation IN ('supersedes','derived_from','copied_from','template_instantiation','rendered_from','merged_from')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), CHECK(source_version_id<>target_version_id),
 FOREIGN KEY(tenant_id,source_version_id) REFERENCES finnor_os.document_versions(tenant_id,id),
 FOREIGN KEY(tenant_id,target_version_id) REFERENCES finnor_os.document_versions(tenant_id,id),
 UNIQUE(tenant_id,source_version_id,target_version_id,relation)
);
CREATE OR REPLACE FUNCTION finnor_os.reject_artifact_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'artifact history is immutable; append a new version'; END $$;
CREATE OR REPLACE FUNCTION finnor_os.assert_version_content() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v finnor_os.document_versions;
BEGIN
 SELECT * INTO v FROM finnor_os.document_versions WHERE id=NEW.version_id AND tenant_id=NEW.tenant_id;
 IF NOT FOUND OR v.byte_sha256<>NEW.sha256 OR v.size_bytes<>NEW.size_bytes OR v.media_type<>NEW.media_type THEN
  RAISE EXCEPTION 'version content identity mismatch';
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER version_content_identity BEFORE INSERT ON finnor_os.document_version_contents FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_version_content();
-- Current compatibility bytes are a projection. Every legacy write captures history
-- in the same transaction. Baseline is recorded now, never at a fabricated old date.
CREATE OR REPLACE FUNCTION finnor_os.capture_legacy_document_content() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_head uuid; current_hash text; version_id uuid; ordinal integer; format text; byte_hash text;
BEGIN
 IF octet_length(NEW.bytes)>10485760 OR NEW.size_bytes<>octet_length(NEW.bytes) THEN RAISE EXCEPTION 'artifact byte bound exceeded or invalid size'; END IF;
 PERFORM 1 FROM finnor_os.documents WHERE tenant_id=NEW.tenant_id AND id=NEW.document_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'document content crosses tenant or missing document'; END IF;
 byte_hash:=encode(sha256(NEW.bytes),'hex');
 SELECT h.version_id,v.byte_sha256 INTO old_head,current_hash FROM finnor_os.document_version_heads h
 JOIN finnor_os.document_versions v ON v.id=h.version_id AND v.tenant_id=h.tenant_id
 WHERE h.tenant_id=NEW.tenant_id AND h.document_id=NEW.document_id AND h.kind='current' AND h.head_key='default' AND v.media_type=NEW.content_type;
 IF current_hash=byte_hash THEN RETURN NEW; END IF;
 SELECT COALESCE(max(version_ordinal),0)+1 INTO ordinal FROM finnor_os.document_versions WHERE tenant_id=NEW.tenant_id AND document_id=NEW.document_id;
 format:=CASE NEW.content_type WHEN 'application/pdf' THEN 'pdf'
 WHEN 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' THEN 'xlsx'
 WHEN 'application/vnd.ms-excel.sheet.macroEnabled.12' THEN 'xlsm'
 WHEN 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' THEN 'docx'
 WHEN 'application/vnd.openxmlformats-officedocument.presentationml.presentation' THEN 'pptx' ELSE 'unknown' END;
 INSERT INTO finnor_os.document_versions(tenant_id,document_id,version_ordinal,parent_version_id,origin,format,media_type,byte_sha256,size_bytes,created_by)
 VALUES(NEW.tenant_id,NEW.document_id,ordinal,old_head,'legacy_write',format,NEW.content_type,byte_hash,NEW.size_bytes,'legacy_document_content') RETURNING id INTO version_id;
 INSERT INTO finnor_os.document_version_contents(tenant_id,version_id,bytes,media_type,size_bytes,sha256) VALUES(NEW.tenant_id,version_id,NEW.bytes,NEW.content_type,NEW.size_bytes,byte_hash);
 INSERT INTO finnor_os.document_version_heads(tenant_id,document_id,kind,head_key,version_id) VALUES(NEW.tenant_id,NEW.document_id,'current','default',version_id)
 ON CONFLICT(tenant_id,document_id,kind,head_key) DO UPDATE SET version_id=EXCLUDED.version_id,updated_at=clock_timestamp();
 IF old_head IS NOT NULL THEN INSERT INTO finnor_os.artifact_lineage_edges(tenant_id,source_version_id,target_version_id,relation) VALUES(NEW.tenant_id,old_head,version_id,'supersedes'); END IF;
 RETURN NEW;
END $$;
-- Oversized legacy content blocks upgrade explicitly; it is not silently truncated.
INSERT INTO finnor_os.document_versions(tenant_id,document_id,version_ordinal,origin,format,media_type,byte_sha256,size_bytes,created_by)
SELECT tenant_id,document_id,1,'baseline',CASE content_type
 WHEN 'application/pdf' THEN 'pdf'
 WHEN 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' THEN 'xlsx'
 WHEN 'application/vnd.ms-excel.sheet.macroEnabled.12' THEN 'xlsm'
 WHEN 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' THEN 'docx'
 WHEN 'application/vnd.openxmlformats-officedocument.presentationml.presentation' THEN 'pptx'
 ELSE 'unknown' END,content_type,encode(sha256(bytes),'hex'),octet_length(bytes),'migration:0119'
FROM finnor_os.document_contents;
INSERT INTO finnor_os.document_version_contents(tenant_id,version_id,bytes,media_type,size_bytes,sha256)
SELECT v.tenant_id,v.id,c.bytes,v.media_type,v.size_bytes,v.byte_sha256 FROM finnor_os.document_versions v JOIN finnor_os.document_contents c ON c.tenant_id=v.tenant_id AND c.document_id=v.document_id;
INSERT INTO finnor_os.document_version_heads(tenant_id,document_id,kind,head_key,version_id) SELECT tenant_id,document_id,'current','default',id FROM finnor_os.document_versions;
CREATE TRIGGER capture_document_content BEFORE INSERT OR UPDATE ON finnor_os.document_contents FOR EACH ROW EXECUTE FUNCTION finnor_os.capture_legacy_document_content();
ALTER TABLE finnor_os.embeddings ADD COLUMN document_version_id uuid;
ALTER TABLE finnor_os.embeddings ADD CONSTRAINT embeddings_version_document_tenant FOREIGN KEY(tenant_id,document_id,document_version_id) REFERENCES finnor_os.document_versions(tenant_id,document_id,id);
ALTER TABLE finnor_os.embeddings ADD CONSTRAINT embeddings_version_needs_document CHECK(document_version_id IS NULL OR document_id IS NOT NULL);
DROP INDEX finnor_os.embeddings_active_source_hash_idx;
CREATE UNIQUE INDEX embeddings_active_unversioned_source_hash_idx
  ON finnor_os.embeddings(tenant_id,source_doc_id,content_hash)
  WHERE superseded_at IS NULL AND document_version_id IS NULL;
CREATE UNIQUE INDEX embeddings_active_versioned_source_hash_idx
  ON finnor_os.embeddings(tenant_id,source_doc_id,document_version_id,content_hash)
  WHERE superseded_at IS NULL AND document_version_id IS NOT NULL;
CREATE INDEX document_versions_document_history_idx ON finnor_os.document_versions(tenant_id,document_id,version_ordinal DESC);
CREATE INDEX document_versions_parent_idx ON finnor_os.document_versions(tenant_id,document_id,parent_version_id) WHERE parent_version_id IS NOT NULL;
CREATE INDEX document_versions_provider_identity_idx ON finnor_os.document_versions(tenant_id,source_system,source_ref,provider_version_id) WHERE source_ref IS NOT NULL;
CREATE UNIQUE INDEX document_versions_provider_observation_identity_key
  ON finnor_os.document_versions(tenant_id,document_id,source_system,source_ref,provider_etag,byte_sha256)
  WHERE origin='provider_observation' AND source_ref IS NOT NULL AND provider_etag IS NOT NULL;
CREATE INDEX document_version_contents_tenant_idx ON finnor_os.document_version_contents(tenant_id,version_id);
CREATE INDEX document_version_heads_version_idx ON finnor_os.document_version_heads(tenant_id,version_id);
CREATE INDEX artifact_ir_snapshots_hash_idx ON finnor_os.artifact_ir_snapshots(tenant_id,semantic_hash);
CREATE INDEX artifact_lineage_source_idx ON finnor_os.artifact_lineage_edges(tenant_id,source_version_id);
CREATE INDEX artifact_lineage_target_idx ON finnor_os.artifact_lineage_edges(tenant_id,target_version_id);
CREATE INDEX embeddings_document_version_idx ON finnor_os.embeddings(tenant_id,document_id,document_version_id) WHERE document_version_id IS NOT NULL;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['document_versions','document_version_contents','document_version_heads','artifact_ir_snapshots','artifact_lineage_edges'] LOOP
 EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_isolation ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id()) WITH CHECK(tenant_id=finnor_os.request_tenant_id())',t);
 EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
 IF t<>'document_version_heads' THEN EXECUTE format('CREATE TRIGGER immutable_artifact_history BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.reject_artifact_history_mutation()',t); END IF;
 END LOOP;
 GRANT UPDATE ON finnor_os.document_version_heads TO finnor_app;
END $$;
