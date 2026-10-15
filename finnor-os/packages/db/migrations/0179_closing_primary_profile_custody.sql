-- The immutable-profile policy also wraps primary custody at source level.
CREATE OR REPLACE FUNCTION finnor_os.primary_evidence_profile_ref_allowed(profile_ref jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF nullif(current_setting('app.user_id',true),'') IS NULL
  OR nullif(current_setting('app.primary_programme_id',true),'') IS NULL
  OR NOT has_table_privilege(current_user,'finnor_os.s6_primary_requests','SELECT') THEN
  RETURN false;
 END IF;
 RETURN EXISTS(
  SELECT 1 FROM finnor_os.s6_primary_requests r
  WHERE r.tenant_id=finnor_os.request_tenant_id()
   AND r.principal_id::text=nullif(current_setting('app.user_id',true),'')
   AND r.programme_id::text=nullif(current_setting('app.primary_programme_id',true),'')
   AND r.body->'sourceProfileRef'=profile_ref
   AND finnor_os.primary_evidence_scope_allowed(profile_ref->>'id',r.id::text)
 );
END $$;
GRANT EXECUTE ON FUNCTION finnor_os.primary_evidence_profile_ref_allowed(jsonb)
 TO finnor_closing_checker,finnor_closing_broker;
