-- New global RLS predicates must remain executable by existing native readers.
-- Restore only boolean policy execution; retain every row predicate and table
-- privilege. These grants confer no source-recipient or business authority.
GRANT EXECUTE ON FUNCTION
 finnor_os.z1_s5_visible(text),
 finnor_os.s5_institution_visible(text)
 TO finnor_closing_checker,finnor_closing_broker;

-- A restricted checker is not a confidential recipient, even when it supplies
-- the human owner's app.user_id. Preserve ordinary owner/worker behavior.
CREATE OR REPLACE FUNCTION finnor_os.y4_s5_visible(p_tenant uuid,p_digest text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,finnor_os AS $$
 SELECT p_tenant=finnor_os.request_tenant_id() AND
  (NOT finnor_os.y4_s5_private(p_tenant,p_digest) OR (
   coalesce(nullif(current_setting('role',true),'none'),session_user::text)
    NOT IN ('finnor_closing_checker','finnor_closing_broker','finnor_v1_checker')
   AND EXISTS(SELECT 1 FROM finnor_os.s5_proposals p
    WHERE p.tenant_id=p_tenant AND p.content_digest=p_digest
      AND p.principal_id=nullif(current_setting('app.user_id',true),'')::uuid)))
$$;

GRANT EXECUTE ON FUNCTION finnor_os.y4_s6_effect_visible(uuid,uuid)
 TO finnor_v1_checker;
