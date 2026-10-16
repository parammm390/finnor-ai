-- Primary raw custody is not a tenant-wide research corpus. Normal/public
-- Evidence remains unchanged; private rows require a current exact purpose scope.
CREATE FUNCTION finnor_os.primary_evidence_scope_allowed(profile_id text, request_id text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 RETURN EXISTS(
  SELECT 1 FROM finnor_os.v2_programmes p
  JOIN finnor_os.s6_primary_requests r ON r.tenant_id=p.tenant_id AND r.principal_id=p.principal_id AND r.programme_id=p.id
  JOIN finnor_os.users u ON u.tenant_id=p.tenant_id AND u.id=p.principal_id
  JOIN finnor_os.primary_governance_versions consent ON consent.tenant_id=r.tenant_id AND consent.id=r.consent_id AND consent.revision=r.consent_version
  WHERE p.tenant_id=finnor_os.request_tenant_id()
   AND p.principal_id::text=nullif(current_setting('app.user_id',true),'')
   AND p.id::text=nullif(current_setting('app.primary_programme_id',true),'')
   AND u.role='owner' AND u.status='active'
   AND NOT p.invalidated AND p.cancellation_requested_at IS NULL
   AND r.source_profile_id::text=profile_id AND (request_id IS NULL OR r.id::text=request_id)
   AND r.body->>'purpose'=nullif(current_setting('app.primary_data_purpose',true),'')
   AND consent.body->>'authorizedActorId'=p.principal_id::text
   AND consent.body->'purposes' ? (r.body->>'purpose')
   AND (consent.body->'retention'->>'rawUntil')::timestamptz>statement_timestamp()
   AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(jsonb_build_array(
     r.body->'sourceProfileRef',r.body->'consentRef',r.body->'authorityRef',
     r.body->'mandateRef',r.body->'grantRef',r.body->'semanticsRef')) ref
    LEFT JOIN finnor_os.primary_governance_versions v ON v.tenant_id=p.tenant_id AND v.id::text=ref->>'id' AND v.revision::text=ref->>'revision'
    LEFT JOIN finnor_os.primary_governance_heads h ON h.tenant_id=v.tenant_id AND h.id=v.id AND h.revision=v.revision
    WHERE v.id IS NULL OR h.state IS DISTINCT FROM 'CURRENT' OR v.digest IS DISTINCT FROM ref->>'contentDigest'
     OR (v.body->>'expiresAt')::timestamptz<=statement_timestamp()
     OR (v.body ? 'validFrom' AND (v.body->>'validFrom')::timestamptz>statement_timestamp())
   )
   AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(p.starting_manifest->'dependencies') d
    LEFT JOIN finnor_os.p4_source_revisions rev ON rev.tenant_id=p.tenant_id AND rev.key=d->>'key'
    WHERE COALESCE(rev.revision,0)::text IS DISTINCT FROM d->>'revision'
   )
   AND p.work_input_id=(SELECT w.id FROM finnor_os.work_inputs w
    WHERE w.tenant_id=p.tenant_id AND w.work_id=p.work_id ORDER BY w.created_at DESC,w.id DESC LIMIT 1)
 );
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION finnor_os.primary_evidence_scope_allowed(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finnor_os.primary_evidence_scope_allowed(text,text) TO finnor_app,finnor_worker;

CREATE POLICY primary_custody_sources ON finnor_os.evidence_sources AS RESTRICTIVE
 USING(source_type<>'primary_record' OR finnor_os.primary_evidence_scope_allowed(metadata->'sourceProfileRef'->>'id'))
 WITH CHECK(source_type<>'primary_record' OR finnor_os.primary_evidence_scope_allowed(metadata->'sourceProfileRef'->>'id'));
CREATE POLICY primary_custody_versions ON finnor_os.evidence_source_versions AS RESTRICTIVE
 USING(EXISTS(SELECT 1 FROM finnor_os.evidence_sources s WHERE s.id=evidence_source_versions.source_id
  AND (s.source_type<>'primary_record' OR (snapshot->>'requestId' IS NOT NULL AND finnor_os.primary_evidence_scope_allowed(s.metadata->'sourceProfileRef'->>'id',snapshot->>'requestId')))))
 WITH CHECK(EXISTS(SELECT 1 FROM finnor_os.evidence_sources s WHERE s.id=evidence_source_versions.source_id
  AND (s.source_type<>'primary_record' OR (snapshot->>'requestId' IS NOT NULL AND finnor_os.primary_evidence_scope_allowed(s.metadata->'sourceProfileRef'->>'id',snapshot->>'requestId')))));
CREATE POLICY primary_custody_chunks ON finnor_os.evidence_chunks AS RESTRICTIVE
 USING(EXISTS(SELECT 1 FROM finnor_os.evidence_source_versions v WHERE v.id=evidence_chunks.version_id AND v.source_id=evidence_chunks.source_id))
 WITH CHECK(EXISTS(SELECT 1 FROM finnor_os.evidence_source_versions v WHERE v.id=evidence_chunks.version_id AND v.source_id=evidence_chunks.source_id));
-- Historical research excerpts are a second copy of the private payload. V2
-- never creates one; existing private hits remain immutable but not exportable.
CREATE POLICY primary_custody_research_hits ON finnor_os.research_run_hits AS RESTRICTIVE
 USING(EXISTS(SELECT 1 FROM finnor_os.evidence_sources s WHERE s.id=research_run_hits.source_id AND s.source_type<>'primary_record'))
 WITH CHECK(EXISTS(SELECT 1 FROM finnor_os.evidence_sources s WHERE s.id=research_run_hits.source_id AND s.source_type<>'primary_record'));

CREATE FUNCTION finnor_os.freeze_primary_evidence_source() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF OLD.source_type='primary_record' AND
  (NEW.source_type IS DISTINCT FROM OLD.source_type OR NEW.source_key IS DISTINCT FROM OLD.source_key
   OR NEW.metadata IS DISTINCT FROM OLD.metadata OR NEW.canonical_url IS DISTINCT FROM OLD.canonical_url
   OR NEW.title IS DISTINCT FROM OLD.title OR NEW.publisher IS DISTINCT FROM OLD.publisher) THEN
  RAISE EXCEPTION 'PRIMARY_EVIDENCE_CUSTODY_IDENTITY_IMMUTABLE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER primary_evidence_source_immutable BEFORE UPDATE ON finnor_os.evidence_sources
 FOR EACH ROW EXECUTE FUNCTION finnor_os.freeze_primary_evidence_source();
CREATE FUNCTION finnor_os.assert_primary_evidence_namespace() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF NEW.source_key LIKE 'primary:%' AND NEW.source_type<>'primary_record' THEN
  RAISE EXCEPTION 'PRIMARY_EVIDENCE_NAMESPACE_RESERVED';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER primary_evidence_namespace BEFORE INSERT OR UPDATE ON finnor_os.evidence_sources
 FOR EACH ROW EXECUTE FUNCTION finnor_os.assert_primary_evidence_namespace();
