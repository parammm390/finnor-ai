-- A Work has many inputs; a private transport reply belongs to exactly one.
-- The input remains the canonical principal/Work owner, avoiding a second copy.
CREATE TABLE finnor_os.work_input_responses (
  tenant_id uuid NOT NULL,
  work_input_id uuid NOT NULL,
  response jsonb NOT NULL CHECK (jsonb_typeof(response)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,work_input_id),
  FOREIGN KEY (tenant_id,work_input_id) REFERENCES finnor_os.work_inputs(tenant_id,id)
);

ALTER TABLE finnor_os.work_input_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.work_input_responses FORCE ROW LEVEL SECURITY;
CREATE POLICY input_principal_only ON finnor_os.work_input_responses
  USING (tenant_id=finnor_os.request_tenant_id() AND EXISTS (
    SELECT 1 FROM finnor_os.work_inputs i
    WHERE i.tenant_id=work_input_responses.tenant_id AND i.id=work_input_responses.work_input_id
      AND i.created_by IS NOT DISTINCT FROM NULLIF(current_setting('app.user_id',true),'')::uuid
  ))
  WITH CHECK (tenant_id=finnor_os.request_tenant_id() AND EXISTS (
    SELECT 1 FROM finnor_os.work_inputs i
    WHERE i.tenant_id=work_input_responses.tenant_id AND i.id=work_input_responses.work_input_id
      AND i.created_by IS NOT DISTINCT FROM NULLIF(current_setting('app.user_id',true),'')::uuid
  ));

-- 0032 grants future tables CRUD by default. Explicitly remove mutation rights;
-- retries may insert or read the first reply, never replace or erase it.
REVOKE ALL ON finnor_os.work_input_responses FROM PUBLIC;
REVOKE UPDATE,DELETE,TRUNCATE ON finnor_os.work_input_responses FROM finnor_app;
GRANT SELECT,INSERT ON finnor_os.work_input_responses TO finnor_app;
