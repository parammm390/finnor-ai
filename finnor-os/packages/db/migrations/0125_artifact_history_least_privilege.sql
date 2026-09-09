-- Earlier Core migrations intentionally grant finnor_app CRUD on future tables by
-- default. P3 history is append-only, so make its table privileges match the
-- immutable database guards instead of relying on triggers as the first boundary.
DO $$
DECLARE immutable_table text;
BEGIN
  FOREACH immutable_table IN ARRAY ARRAY[
    'document_versions',
    'document_version_contents',
    'artifact_ir_snapshots',
    'artifact_lineage_edges',
    'artifact_operations',
    'artifact_bindings',
    'artifact_anchor_remaps',
    'artifact_comments',
    'artifact_reviews',
    'artifact_templates'
  ] LOOP
    EXECUTE format('REVOKE UPDATE, DELETE ON finnor_os.%I FROM finnor_app', immutable_table);
  END LOOP;

  -- Heads and provider-effect state machines are deliberately mutable through
  -- guarded compare-and-swap/state-transition code, but no P3 row is deletable.
  REVOKE DELETE ON finnor_os.document_version_heads FROM finnor_app;
  REVOKE DELETE ON finnor_os.artifact_publications FROM finnor_app;
  REVOKE DELETE ON finnor_os.artifact_provider_creations FROM finnor_app;
END $$;
