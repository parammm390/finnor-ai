ALTER TABLE finnor_os.capability_nango_bindings ADD COLUMN connection_epoch bigint NOT NULL DEFAULT 1 CHECK(connection_epoch>0);
ALTER TABLE finnor_os.capability_nango_bindings ADD COLUMN health_checked_at timestamptz;
CREATE TABLE finnor_os.capability_nango_health_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 tenant_id uuid NOT NULL,
 source_scope_id uuid NOT NULL,
 principal_id uuid NOT NULL,
 trigger_digest text NOT NULL CHECK(trigger_digest ~ '^[a-f0-9]{64}$'),
 status text NOT NULL CHECK(status IN ('ACTIVE','DISABLED')),
 connection_epoch bigint NOT NULL CHECK(connection_epoch>0),
 observed_state text NOT NULL CHECK(observed_state IN ('HEALTHY','AUTH_ERROR','MISSING','INACTIVE_OWNER')),
 checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,source_scope_id) REFERENCES finnor_os.capability_nango_bindings(tenant_id,source_scope_id)
);
ALTER TABLE finnor_os.capability_nango_health_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.capability_nango_health_events FORCE ROW LEVEL SECURITY;
CREATE POLICY capability_nango_health_events_tenant ON finnor_os.capability_nango_health_events
 USING(tenant_id=finnor_os.request_tenant_id()) WITH CHECK(tenant_id=finnor_os.request_tenant_id());
CREATE TRIGGER capability_nango_health_events_immutable BEFORE UPDATE OR DELETE ON finnor_os.capability_nango_health_events
 FOR EACH ROW EXECUTE FUNCTION finnor_os.capability_event_immutable();
CREATE FUNCTION finnor_os.capability_nango_connection_owner(p_provider text,p_connection text)
 RETURNS TABLE(tenant_id uuid,principal_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT tenant_id,principal_id FROM finnor_os.capability_nango_bindings WHERE provider_config_key=p_provider AND connection_id=p_connection ORDER BY source_scope_id LIMIT 1
$$;
REVOKE ALL ON FUNCTION finnor_os.capability_nango_connection_owner(text,text) FROM PUBLIC;
CREATE POLICY capability_nango_current_connection ON finnor_os.evidence_sources AS RESTRICTIVE FOR SELECT USING(
 source_type<>'nango_record' OR EXISTS(SELECT 1 FROM finnor_os.capability_nango_bindings b JOIN finnor_os.integration_source_scopes s
 ON s.tenant_id=b.tenant_id AND s.id=b.source_scope_id WHERE b.tenant_id=evidence_sources.tenant_id AND b.source_scope_id::text=evidence_sources.metadata->>'sourceScopeId'
 AND b.status='ACTIVE' AND s.enabled AND b.connection_epoch::text=evidence_sources.metadata->>'connectionEpoch'));
CREATE POLICY capability_nango_observation_privacy ON finnor_os.external_ref_observations AS RESTRICTIVE FOR SELECT USING(
 provider IS DISTINCT FROM 'nango' OR EXISTS(SELECT 1 FROM finnor_os.evidence_source_versions v WHERE v.id=external_ref_observations.evidence_version_id));
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
 GRANT SELECT,INSERT ON finnor_os.capability_nango_health_events TO finnor_app;
 GRANT USAGE,SELECT ON SEQUENCE finnor_os.capability_nango_health_events_id_seq TO finnor_app;
 GRANT EXECUTE ON FUNCTION finnor_os.capability_nango_connection_owner(text,text) TO finnor_app;
END IF; END $$;
