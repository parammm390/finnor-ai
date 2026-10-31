-- New child criteria stay outside the immutable original outcome. Access uses
-- only the independently published canonical checker binding, never a caller's
-- proposed identity or another producer's private programme.
ALTER TABLE finnor_os.w2_assignment_heads ADD COLUMN checker_principal_id uuid;
ALTER TABLE finnor_os.w2_assignment_heads ADD CONSTRAINT w2_checker_principal
 FOREIGN KEY(tenant_id,checker_principal_id) REFERENCES finnor_os.users(tenant_id,id);
UPDATE finnor_os.w2_assignment_heads h SET checker_principal_id=(criterion->>'checkerActorId')::uuid
 FROM finnor_os.w2_programs p,jsonb_array_elements(p.original->'outcome'->'criteria') criterion
 WHERE p.tenant_id=h.tenant_id AND p.id=h.program_id AND criterion->>'id'=h.task->>'criterionId'
  AND EXISTS(SELECT 1 FROM finnor_os.users u WHERE u.tenant_id=h.tenant_id AND u.id=(criterion->>'checkerActorId')::uuid);

-- Fail on legacy duplicate roots, rather than deleting or silently resetting
-- any accepted episode. New attempts/refinements belong to the original row.
CREATE UNIQUE INDEX w2_one_original_programme_per_work ON finnor_os.w2_programs(tenant_id,work_id);

CREATE OR REPLACE FUNCTION finnor_os.w2_participant_access(p_program uuid,p_assignment text) RETURNS uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT p.principal_id FROM finnor_os.w2_programs p
 JOIN finnor_os.w2_assignment_heads h ON h.tenant_id=p.tenant_id AND h.program_id=p.id
 JOIN finnor_os.users u ON u.tenant_id=p.tenant_id
  AND u.id=nullif(current_setting('app.user_id',true),'')::uuid AND u.status='active'
 WHERE p.tenant_id=finnor_os.request_tenant_id() AND p.id=p_program
  AND (p_assignment IS NULL OR h.assignment_id=p_assignment)
  AND (h.recipient_principal_id=u.id OR h.checker_principal_id=u.id)
 LIMIT 1
$$;
CREATE OR REPLACE FUNCTION finnor_os.w2_participant_programs(p_work uuid) RETURNS TABLE(id uuid,work_id uuid)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT DISTINCT p.id,p.work_id FROM finnor_os.w2_programs p
 JOIN finnor_os.w2_assignment_heads h ON h.tenant_id=p.tenant_id AND h.program_id=p.id
 JOIN finnor_os.users u ON u.tenant_id=p.tenant_id
  AND u.id=nullif(current_setting('app.user_id',true),'')::uuid AND u.status='active'
 WHERE p.tenant_id=finnor_os.request_tenant_id() AND p.work_id=p_work
  AND (h.recipient_principal_id=u.id OR h.checker_principal_id=u.id)
 ORDER BY p.id LIMIT 129
$$;
-- CREATE OR REPLACE retains the existing, restricted function privileges.
