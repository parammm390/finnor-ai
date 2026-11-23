-- A Boolean SQL expression can acquire its subquery's relation locks even when
-- ordinary limits do not require closing authority. Keep that SQL in its branch.
CREATE OR REPLACE FUNCTION finnor_os.pe_v3_objective_grant_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.max_steps>OLD.max_steps OR NEW.max_actions>OLD.max_actions
    OR NEW.max_queries>OLD.max_queries OR NEW.deadline_at>OLD.deadline_at) AND EXISTS(
      SELECT 1 FROM finnor_os.pe_closing_programmes q WHERE q.tenant_id=NEW.tenant_id AND q.work_id=NEW.work_id) THEN
    RAISE EXCEPTION 'Closing continuation cannot increase the original episode grant';
  END IF;
  IF NEW.max_steps>96 OR NEW.max_actions>25 OR NEW.max_queries>50 THEN
    IF NOT EXISTS(
      SELECT 1 FROM finnor_os.pe_closing_programmes q WHERE q.tenant_id=NEW.tenant_id AND q.work_id=NEW.work_id
        AND NEW.max_steps<=(q.spec->'originalGrant'->>'maxSteps')::int AND NEW.max_actions<=NEW.max_steps AND NEW.max_queries<=NEW.max_steps
        AND NEW.deadline_at<=q.original_deadline_at
        AND EXISTS(SELECT 1 FROM finnor_os.pe_closing_evidence_bindings b JOIN finnor_os.evidence_source_versions v
          ON v.tenant_id=b.tenant_id AND v.source_id=b.source_id
          WHERE b.tenant_id=q.tenant_id AND b.programme_id=q.id AND v.snapshot->'closingObservation'->>'kind'='LEGAL_SPEC_ACCEPTANCE')) THEN
      RAISE EXCEPTION 'Larger finite grant requires the original accepted closing Work';
    END IF;
  END IF;
  RETURN NEW;
END $$;
