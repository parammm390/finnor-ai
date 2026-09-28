-- The intake claim precedes tenant validation of browser context. Permit one
-- bounded fill of its provenance triplet before planning starts, then keep the
-- same immutable guard. Existing terminal or old inputs cannot be backfilled.
CREATE OR REPLACE FUNCTION finnor_os.guard_work_input_context_provenance() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF (
    NEW.context_snapshot IS NOT DISTINCT FROM OLD.context_snapshot
    AND NEW.context_snapshot_hash IS NOT DISTINCT FROM OLD.context_snapshot_hash
    AND NEW.context_captured_at IS NOT DISTINCT FROM OLD.context_captured_at
  ) THEN
    RETURN NEW;
  END IF;

  IF OLD.context_snapshot IS NULL
    AND OLD.context_snapshot_hash IS NULL
    AND OLD.context_captured_at IS NULL
    AND NEW.context_snapshot IS NOT NULL
    AND NEW.context_snapshot_hash IS NOT NULL
    AND NEW.context_captured_at IS NOT NULL
    AND OLD.created_at >= clock_timestamp() - INTERVAL '10 minutes'
    AND EXISTS (
      SELECT 1 FROM finnor_os.works AS w
      WHERE w.tenant_id = OLD.tenant_id AND w.id = OLD.work_id
        AND w.status NOT IN ('completed', 'failed', 'cancelled')
    )
    AND NOT EXISTS (
      SELECT 1 FROM finnor_os.work_planner_attempts AS p
      WHERE p.tenant_id = OLD.tenant_id AND p.work_input_id = OLD.id
    )
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Work input context provenance is immutable';
END $$;

COMMENT ON COLUMN finnor_os.work_inputs.context_snapshot IS
  'Write-once bounded Operating Interaction Context: inserted at intake when already validated, or filled once after tenant validation before planning; null means no validated snapshot was stored.';
