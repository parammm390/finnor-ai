CREATE FUNCTION finnor_os.guard_reviewed_acquisition_contract() RETURNS trigger
LANGUAGE plpgsql SET search_path=finnor_os,pg_catalog AS $$
BEGIN
 IF TG_OP='UPDATE' AND (OLD.input ? 'acquisitionRequest' OR NEW.input ? 'acquisitionRequest') THEN
  IF ROW(NEW.tenant_id,NEW.work_id,NEW.objective_loop_id,NEW.pack_id,NEW.pack_version,NEW.mode,
   NEW.certification_fingerprint,NEW.objective,NEW.input,NEW.subject_refs,NEW.success_condition,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.tenant_id,OLD.work_id,OLD.objective_loop_id,OLD.pack_id,OLD.pack_version,OLD.mode,
   OLD.certification_fingerprint,OLD.objective,OLD.input,OLD.subject_refs,OLD.success_condition,OLD.created_at) THEN
   RAISE EXCEPTION 'reviewed acquisition contract is immutable';
  END IF;
 END IF;
 IF TG_OP='INSERT' AND NEW.input ? 'acquisitionRequest' THEN
  IF NOT EXISTS(SELECT 1 FROM finnor_os.work_objective_loops l JOIN finnor_os.work_inputs i
   ON i.tenant_id=l.tenant_id AND i.work_id=l.work_id
   WHERE l.tenant_id=NEW.tenant_id AND l.id=NEW.objective_loop_id AND l.work_id=NEW.work_id
   AND i.id=(NEW.input#>>'{acquisitionAcceptance,workInputId}')::uuid
   AND i.instruction_id=(NEW.input#>>'{acquisitionAcceptance,instructionId}')::uuid
   AND i.created_by=(NEW.input#>>'{acquisitionAcceptance,principalId}')::uuid
   AND l.created_by=i.created_by AND NEW.work_id=(NEW.input#>>'{acquisitionAcceptance,workId}')::uuid
   AND NEW.objective=l.objective AND NEW.success_condition=l.success_condition
   AND i.id=(SELECT id FROM finnor_os.work_inputs WHERE tenant_id=NEW.tenant_id AND work_id=NEW.work_id ORDER BY created_at DESC,id DESC LIMIT 1)) THEN
   RAISE EXCEPTION 'reviewed acquisition requires the original current input and principal';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reviewed_acquisition_contract_guard BEFORE INSERT OR UPDATE ON finnor_os.outcome_pack_runs
FOR EACH ROW EXECUTE FUNCTION finnor_os.guard_reviewed_acquisition_contract();

CREATE FUNCTION finnor_os.guard_reviewed_acquisition_allowance() RETURNS trigger
LANGUAGE plpgsql SET search_path=finnor_os,pg_catalog AS $$
BEGIN
 IF ROW(NEW.max_steps,NEW.max_actions,NEW.max_queries,NEW.max_planner_failures,NEW.max_consecutive_no_progress,NEW.deadline_at)
  IS DISTINCT FROM ROW(OLD.max_steps,OLD.max_actions,OLD.max_queries,OLD.max_planner_failures,OLD.max_consecutive_no_progress,OLD.deadline_at)
  AND EXISTS(SELECT 1 FROM finnor_os.outcome_pack_runs p WHERE p.tenant_id=OLD.tenant_id AND p.objective_loop_id=OLD.id AND p.input ? 'acquisitionRequest') THEN
  RAISE EXCEPTION 'reviewed acquisition retains its original finite allowance';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reviewed_acquisition_allowance_guard BEFORE UPDATE ON finnor_os.work_objective_loops
FOR EACH ROW EXECUTE FUNCTION finnor_os.guard_reviewed_acquisition_allowance();
