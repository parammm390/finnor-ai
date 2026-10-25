-- The admitted analytical programme, including its executor binding, cannot be rewritten
-- by an ordinary app/worker update. Runtime heads and claim/status fields remain
-- appendable/mutable through their existing owners. Do not backfill an invented
-- execution choice into legacy programmes. Institution continuations retain
-- their existing owner-controlled plan revision advancement.
CREATE FUNCTION finnor_os.guard_p1_admission_custody() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.principal_id,NEW.work_id,NEW.work_input_id,
        NEW.work_input_digest,NEW.episode_id,NEW.plan_revision_id,NEW.idempotency_key,
        NEW.request_digest,NEW.request,NEW.proposed,NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.id,OLD.tenant_id,OLD.principal_id,OLD.work_id,OLD.work_input_id,
        OLD.work_input_digest,OLD.episode_id,OLD.plan_revision_id,OLD.idempotency_key,
        OLD.request_digest,OLD.request,OLD.proposed,OLD.created_at)
 THEN RAISE EXCEPTION 'P1 admitted programme custody is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER p1_admission_custody_immutable BEFORE UPDATE ON finnor_os.p1_requests
 FOR EACH ROW WHEN (OLD.proposed->>'schema'='finnor.harness-program.v1')
 EXECUTE FUNCTION finnor_os.guard_p1_admission_custody();
