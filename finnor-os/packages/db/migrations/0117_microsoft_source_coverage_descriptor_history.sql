-- P2: preserve the exact source descriptor alongside every append-only coverage
-- fact. Mutable source-scope telemetry must never leak into historical state_at(t)
-- or make a later root assignment appear to have existed earlier.

ALTER TABLE finnor_os.integration_source_coverage_history
  ADD COLUMN source_descriptor jsonb NOT NULL DEFAULT '{}';

ALTER TABLE finnor_os.integration_source_coverage_history
  ADD CONSTRAINT integration_source_coverage_history_descriptor_bound CHECK (
    jsonb_typeof(source_descriptor)='object'
    AND octet_length(source_descriptor::text)<=131072
  ),
  ADD CONSTRAINT integration_source_coverage_history_descriptor_no_secrets CHECK (
    source_descriptor::text
      !~* '"[^"]*(secret|password|access[ _-]?token|refresh[ _-]?token|private[ _-]?key|api[ _-]?key|client[ _-]?state|cookie)[^"]*"[[:space:]]*:'
  );

COMMENT ON COLUMN finnor_os.integration_source_coverage_history.source_descriptor IS
  'Immutable safe source/root/permission/freshness descriptor captured when this coverage fact was recorded; empty only for facts predating P2 descriptor history.';
