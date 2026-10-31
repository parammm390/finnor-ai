-- Keep private connection tables outside independent closing-reader authority.
CREATE FUNCTION finnor_os.capability_nango_source_current(p_tenant uuid,p_type text,p_metadata jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF p_type IS DISTINCT FROM 'nango_record' THEN RETURN true; END IF;
 IF p_tenant IS DISTINCT FROM finnor_os.request_tenant_id()
  OR current_user IN ('finnor_closing_checker','finnor_closing_broker') THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM finnor_os.capability_nango_bindings b
  JOIN finnor_os.integration_source_scopes s ON s.tenant_id=b.tenant_id AND s.id=b.source_scope_id
  WHERE b.tenant_id=p_tenant AND b.source_scope_id::text=p_metadata->>'sourceScopeId'
   AND b.status='ACTIVE' AND s.enabled AND b.connection_epoch::text=p_metadata->>'connectionEpoch');
END $$;
ALTER POLICY capability_nango_current_connection ON finnor_os.evidence_sources
 USING(finnor_os.capability_nango_source_current(tenant_id,source_type,metadata));

-- These original expressions restrict only finnor_app; other roles returned true.
ALTER POLICY s5_institution_reservation_privacy ON finnor_os.s5_reservations TO finnor_app;
ALTER POLICY s5_institution_state_privacy ON finnor_os.s5_consumption_states TO finnor_app;
ALTER POLICY s5_institution_history_privacy ON finnor_os.s5_history TO finnor_app;
