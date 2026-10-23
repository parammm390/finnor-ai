-- Textual system actors cannot own private Y2 rows. Reuse the authenticated-user
-- parser so evidence ingestion denies private scope instead of failing a UUID cast.
-- ALTER existing policies to retain roles, commands, tenant isolation and RLS.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['y2_episodes','y2_models','y2_uses','y2_events','s8_strategic_response_admissions'] LOOP
  EXECUTE format('ALTER POLICY y2_scope ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=finnor_os.request_authenticated_user_uuid()) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=finnor_os.request_authenticated_user_uuid())',t);
 END LOOP;
END $$;
