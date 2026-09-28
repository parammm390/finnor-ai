-- Presentation preferences only. Canonical blocks and business facts are rebuilt
-- from their owners; this table stores an employee's order and focus per thread.
CREATE TABLE finnor_os.centropy_canvas_preferences (
  tenant_id uuid NOT NULL,
  owner_employee_id uuid NOT NULL,
  thread_id uuid NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version=1),
  ui_revision integer NOT NULL DEFAULT 1 CHECK (ui_revision>=1),
  layout jsonb NOT NULL,
  selected_block_id text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,owner_employee_id,thread_id),
  CONSTRAINT centropy_canvas_preferences_thread_owner_fkey
    FOREIGN KEY (tenant_id,thread_id,owner_employee_id)
    REFERENCES finnor_os.employee_conversation_threads(tenant_id,id,owner_employee_id)
    ON DELETE CASCADE,
  CONSTRAINT centropy_canvas_preferences_layout_check CHECK (
    jsonb_typeof(layout)='object' AND layout->>'mode'='document'
    AND jsonb_typeof(layout->'blockIds')='array'
    AND jsonb_array_length(layout->'blockIds')<=100
    AND octet_length(layout::text)<=32768
  ),
  CONSTRAINT centropy_canvas_preferences_selected_check CHECK (
    selected_block_id IS NULL OR (length(selected_block_id) BETWEEN 1 AND 240)
  )
);

ALTER TABLE finnor_os.centropy_canvas_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE finnor_os.centropy_canvas_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_self_only ON finnor_os.centropy_canvas_preferences
  USING (tenant_id=finnor_os.request_tenant_id() AND owner_employee_id=NULLIF(current_setting('app.user_id',true),'')::uuid)
  WITH CHECK (tenant_id=finnor_os.request_tenant_id() AND owner_employee_id=NULLIF(current_setting('app.user_id',true),'')::uuid);

DO $grant_canvas$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
    GRANT SELECT,INSERT,UPDATE ON finnor_os.centropy_canvas_preferences TO finnor_app;
  END IF;
END $grant_canvas$;
