-- A governed Artifact template action uses its DomainAction ID as its one
-- durable Document identity. UI-created drafts without an action ID remain
-- independent. The Artifact service holds a tenant-scoped transaction lock and
-- verifies the pinned source version on replay before returning its first copy.
CREATE UNIQUE INDEX IF NOT EXISTS documents_template_instantiation_action_key
  ON finnor_os.documents(tenant_id,external_id)
  WHERE source_system='template_instantiation' AND external_id IS NOT NULL;
