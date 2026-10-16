-- Preserve existing request identities and allow the connection owner to revoke
-- header credentials. Do not rewrite the previously applied X2 migrations.
CREATE OR REPLACE FUNCTION finnor_os.application_request_fence_immutable() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF (NEW.id,NEW.tenant_id,NEW.principal_id,NEW.session_id,NEW.parent_id,NEW.node_id,NEW.obligation_id,
     NEW.request_ref,NEW.binding_ref,NEW.wire_digest,NEW.body)
  IS DISTINCT FROM
    (OLD.id,OLD.tenant_id,OLD.principal_id,OLD.session_id,OLD.parent_id,OLD.node_id,OLD.obligation_id,
     OLD.request_ref,OLD.binding_ref,OLD.wire_digest,OLD.body)
    OR OLD.possible_egress AND NOT NEW.possible_egress
    OR OLD.acknowledged AND NOT NEW.acknowledged THEN
  RAISE EXCEPTION 'Application request identity and possible-egress fence are immutable';
 END IF;
 RETURN NEW;
END $$;

ALTER TABLE finnor_os.auth_profiles DROP CONSTRAINT auth_profiles_application_header_shape_check;
ALTER TABLE finnor_os.auth_profiles ADD CONSTRAINT auth_profiles_application_header_shape_check CHECK(
 auth_method<>'application_headers'
 OR credential_provider IS NOT NULL AND credential_provider IN ('aws-secrets-manager','disposable-private-file')
 OR connection_status='revoked' AND credential_provider IS NULL
  AND credential_ref IS NULL AND credential_version IS NULL
);
