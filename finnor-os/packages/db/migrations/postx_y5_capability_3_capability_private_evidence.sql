-- Private derived content retains the principal and exact authority cut that
-- authorized publication. Tenant-wide corpus access cannot widen that access.
CREATE POLICY capability_private_evidence_sources ON finnor_os.evidence_sources
 AS RESTRICTIVE FOR SELECT USING (
 source_type NOT IN ('document_extraction','nango_record') OR (
   scope='tenant' AND tenant_id=finnor_os.request_tenant_id()
   AND metadata->>'capabilityPrincipalId'=nullif(current_setting('app.user_id',true),'')
   AND metadata->>'capabilityAuthorityRevision'=(
     SELECT revision::text FROM finnor_os.authority_states WHERE tenant_id=finnor_os.request_tenant_id())
   AND EXISTS(SELECT 1 FROM finnor_os.users u WHERE u.tenant_id=evidence_sources.tenant_id
     AND u.id::text=nullif(current_setting('app.user_id',true),'') AND u.status='active' AND u.role='owner')
 ));
CREATE POLICY capability_private_evidence_versions ON finnor_os.evidence_source_versions
 AS RESTRICTIVE FOR SELECT USING (EXISTS(
 SELECT 1 FROM finnor_os.evidence_sources s WHERE s.id=evidence_source_versions.source_id));
CREATE POLICY capability_private_evidence_chunks ON finnor_os.evidence_chunks
 AS RESTRICTIVE FOR SELECT USING (EXISTS(
 SELECT 1 FROM finnor_os.evidence_sources s WHERE s.id=evidence_chunks.source_id));
