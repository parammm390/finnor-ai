-- Reader roles evaluate RLS without becoming confidential recipients.
CREATE OR REPLACE FUNCTION finnor_os.y4_s5_visible(p_tenant uuid,p_digest text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
 SELECT p_tenant=finnor_os.request_tenant_id() AND
  (NOT finnor_os.y4_s5_private(p_tenant,p_digest) OR (
   coalesce(nullif(current_setting('role',true),'none'),session_user::text)
    NOT IN ('finnor_closing_checker','finnor_closing_broker')
   AND EXISTS(SELECT 1 FROM finnor_os.s5_proposals p WHERE p.tenant_id=p_tenant
    AND p.content_digest=p_digest
    AND p.principal_id=nullif(current_setting('app.user_id',true),'')::uuid)))
$$;

GRANT EXECUTE ON FUNCTION
 finnor_os.y4_s5_visible(uuid,text),
 finnor_os.y4_s5_subject_visible(uuid,text),
 finnor_os.y4_s6_effect_visible(uuid,uuid)
 TO finnor_closing_checker,finnor_closing_broker;
