ALTER TABLE finnor_os.tenant_integrations DROP CONSTRAINT tenant_integrations_capability_check;
ALTER TABLE finnor_os.tenant_integrations ADD CONSTRAINT tenant_integrations_capability_check CHECK(capability IN
 ('scheduling','documents','inventory','crm','communications','esign','accounting','payments','marketing','private_equity_source','connected_source'));
ALTER TABLE finnor_os.integration_source_scopes DROP CONSTRAINT integration_source_scopes_source_kind_check;
ALTER TABLE finnor_os.integration_source_scopes ADD CONSTRAINT integration_source_scopes_source_kind_check CHECK(source_kind IN
 ('outlook_mail_folder','outlook_calendar_view','teams_channel','teams_chat','teams_user_chat_feed','teams_transcript_organizer','sharepoint_drive','sharepoint_list','nango_records'));
ALTER TABLE finnor_os.integration_source_scopes DROP CONSTRAINT integration_source_scopes_provider_check;
ALTER TABLE finnor_os.integration_source_scopes ADD CONSTRAINT integration_source_scopes_provider_check CHECK
 ((provider='microsoft_graph' AND source_kind<>'nango_records') OR (provider='nango' AND source_kind='nango_records'));
ALTER TABLE finnor_os.integration_source_scopes DROP CONSTRAINT integration_source_scopes_strategy_check;
ALTER TABLE finnor_os.integration_source_scopes ADD CONSTRAINT integration_source_scopes_strategy_check CHECK
 ((source_kind IN ('outlook_mail_folder','outlook_calendar_view','teams_user_chat_feed','teams_transcript_organizer','sharepoint_drive','sharepoint_list') AND sync_strategy='delta' AND recovery_strategy='EXACT_DELTA')
 OR (source_kind IN ('teams_channel','teams_chat') AND sync_strategy='bounded_enumeration' AND recovery_strategy IN ('BOUNDED_RECONCILIATION','BEST_EFFORT_NOTIFICATION_RECOVERY'))
 OR (source_kind='nango_records' AND sync_strategy='bounded_enumeration' AND recovery_strategy='BOUNDED_RECONCILIATION'));

CREATE TABLE finnor_os.capability_nango_intents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES finnor_os.tenants(id),principal_id uuid NOT NULL,
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128),request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 provider_config_key text NOT NULL CHECK(length(provider_config_key) BETWEEN 1 AND 512),
 models text[] NOT NULL CHECK(cardinality(models) BETWEEN 1 AND 32 AND array_position(models,NULL) IS NULL),
 status text NOT NULL DEFAULT 'AWAITING' CHECK(status IN ('AWAITING','BOUND','FAILED')),
 connection_id text CHECK(connection_id IS NULL OR length(connection_id) BETWEEN 1 AND 512),
 binding_webhook_digest text CHECK(binding_webhook_digest IS NULL OR binding_webhook_digest ~ '^[a-f0-9]{64}$'),
 authority_decision_id uuid NOT NULL REFERENCES finnor_os.authority_decisions(id),
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,principal_id,idempotency_key),UNIQUE(provider_config_key,connection_id),FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),
 CHECK((status='BOUND')=(connection_id IS NOT NULL AND binding_webhook_digest IS NOT NULL))
);
CREATE TABLE finnor_os.capability_nango_bindings (
 tenant_id uuid NOT NULL,source_scope_id uuid NOT NULL, integration_id uuid NOT NULL,principal_id uuid NOT NULL,intent_id uuid NOT NULL,
 provider_config_key text NOT NULL CHECK(length(provider_config_key) BETWEEN 1 AND 512), connection_id text NOT NULL CHECK(length(connection_id) BETWEEN 1 AND 512),
 model text NOT NULL CHECK(length(model) BETWEEN 1 AND 128),status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','DISABLED')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,source_scope_id),UNIQUE(provider_config_key,connection_id,model),
 FOREIGN KEY(tenant_id,source_scope_id) REFERENCES finnor_os.integration_source_scopes(tenant_id,id),
 FOREIGN KEY(tenant_id,integration_id,source_scope_id) REFERENCES finnor_os.integration_source_scopes(tenant_id,integration_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES finnor_os.users(tenant_id,id),FOREIGN KEY(tenant_id,intent_id) REFERENCES finnor_os.capability_nango_intents(tenant_id,id)
);
CREATE TABLE finnor_os.capability_nango_checkpoints (
 tenant_id uuid NOT NULL,source_scope_id uuid NOT NULL,cursor text CHECK(cursor IS NULL OR length(cursor)<=4096),revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 cache_enumeration_completed boolean NOT NULL DEFAULT false,history_limited boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,source_scope_id),
 FOREIGN KEY(tenant_id,source_scope_id) REFERENCES finnor_os.capability_nango_bindings(tenant_id,source_scope_id)
);
CREATE FUNCTION finnor_os.capability_nango_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Nango binding provenance cannot be removed'; END IF;
 IF TG_TABLE_NAME='capability_nango_intents' THEN
  IF (NEW.id,NEW.tenant_id,NEW.principal_id,NEW.idempotency_key,NEW.request_digest,NEW.provider_config_key,NEW.models,NEW.authority_decision_id,NEW.expires_at)
    IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.principal_id,OLD.idempotency_key,OLD.request_digest,OLD.provider_config_key,OLD.models,OLD.authority_decision_id,OLD.expires_at)
    OR OLD.status='BOUND' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Nango intent identity is immutable'; END IF;
 ELSE
  IF (NEW.tenant_id,NEW.source_scope_id,NEW.integration_id,NEW.principal_id,NEW.intent_id,NEW.provider_config_key,NEW.connection_id,NEW.model)
   IS DISTINCT FROM (OLD.tenant_id,OLD.source_scope_id,OLD.integration_id,OLD.principal_id,OLD.intent_id,OLD.provider_config_key,OLD.connection_id,OLD.model)
   THEN RAISE EXCEPTION 'Nango source identity is immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER capability_nango_intents_guard BEFORE UPDATE OR DELETE ON finnor_os.capability_nango_intents FOR EACH ROW EXECUTE FUNCTION finnor_os.capability_nango_identity_guard();
CREATE TRIGGER capability_nango_bindings_guard BEFORE UPDATE OR DELETE ON finnor_os.capability_nango_bindings FOR EACH ROW EXECUTE FUNCTION finnor_os.capability_nango_identity_guard();
ALTER TABLE finnor_os.capability_nango_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.capability_nango_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY capability_nango_intents_owner ON finnor_os.capability_nango_intents USING
 (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND principal_id=nullif(current_setting('app.user_id',true),'')::uuid);
ALTER TABLE finnor_os.capability_nango_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.capability_nango_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY capability_nango_bindings_tenant ON finnor_os.capability_nango_bindings USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE finnor_os.capability_nango_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.capability_nango_checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY capability_nango_checkpoints_tenant ON finnor_os.capability_nango_checkpoints USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
-- Webhook routing exposes only identities for an unguessable, prepared intent.
-- The HTTP owner verifies exact-byte HMAC before invoking this lookup.
CREATE FUNCTION finnor_os.capability_nango_intent_owner(p_id uuid) RETURNS TABLE(tenant_id uuid,principal_id uuid)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT tenant_id,principal_id FROM finnor_os.capability_nango_intents WHERE id=p_id
$$;
REVOKE ALL ON FUNCTION finnor_os.capability_nango_intent_owner(uuid) FROM PUBLIC;
CREATE FUNCTION finnor_os.capability_nango_binding_owner(p_provider text,p_connection text,p_model text)
 RETURNS TABLE(tenant_id uuid,principal_id uuid,source_scope_id uuid,integration_id uuid)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT tenant_id,principal_id,source_scope_id,integration_id FROM finnor_os.capability_nango_bindings
 WHERE provider_config_key=p_provider AND connection_id=p_connection AND model=p_model AND status='ACTIVE'
$$;
REVOKE ALL ON FUNCTION finnor_os.capability_nango_binding_owner(text,text,text) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
 GRANT SELECT,INSERT,UPDATE ON finnor_os.capability_nango_intents,finnor_os.capability_nango_bindings,finnor_os.capability_nango_checkpoints TO finnor_app;
 GRANT EXECUTE ON FUNCTION finnor_os.capability_nango_intent_owner(uuid) TO finnor_app;
 GRANT EXECUTE ON FUNCTION finnor_os.capability_nango_binding_owner(text,text,text) TO finnor_app;
END IF; END $$;
