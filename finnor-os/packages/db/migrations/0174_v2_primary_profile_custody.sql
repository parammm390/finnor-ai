-- A revised source profile is a new immutable custody identity, not permission
-- to relabel or expose its predecessor through a new programme.
CREATE FUNCTION finnor_os.primary_evidence_profile_ref_allowed(profile_ref jsonb)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path=pg_catalog,finnor_os AS $$
 SELECT EXISTS(
  SELECT 1 FROM finnor_os.s6_primary_requests r
  WHERE r.tenant_id=finnor_os.request_tenant_id()
   AND r.principal_id::text=nullif(current_setting('app.user_id',true),'')
   AND r.programme_id::text=nullif(current_setting('app.primary_programme_id',true),'')
   AND r.body->'sourceProfileRef'=profile_ref
   AND finnor_os.primary_evidence_scope_allowed(profile_ref->>'id',r.id::text)
 )
$$;
REVOKE ALL ON FUNCTION finnor_os.primary_evidence_profile_ref_allowed(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.primary_evidence_profile_ref_allowed(jsonb) TO finnor_app,finnor_worker;
DROP POLICY primary_custody_sources ON finnor_os.evidence_sources;
CREATE POLICY primary_custody_sources ON finnor_os.evidence_sources AS RESTRICTIVE
 USING(source_type<>'primary_record' OR finnor_os.primary_evidence_profile_ref_allowed(metadata->'sourceProfileRef'))
 WITH CHECK(source_type<>'primary_record' OR finnor_os.primary_evidence_profile_ref_allowed(metadata->'sourceProfileRef'));
