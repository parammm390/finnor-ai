ALTER TABLE finnor_os.acquisition_decisions
 ADD COLUMN parent_action_id uuid,
 ADD COLUMN parent_plan_revision_id uuid,
 ADD COLUMN analysis_program_id uuid,
 ADD COLUMN analysis_base_run_id uuid,
 ADD COLUMN analysis_result_digest text,
 ADD CONSTRAINT acquisition_analysis_parent_action_fk FOREIGN KEY(tenant_id,parent_action_id) REFERENCES finnor_os.domain_actions(tenant_id,id),
 ADD CONSTRAINT acquisition_analysis_parent_plan_fk FOREIGN KEY(tenant_id,parent_plan_revision_id) REFERENCES finnor_os.work_plan_revisions(tenant_id,id),
 ADD CONSTRAINT acquisition_analysis_binding_pairs CHECK((parent_action_id IS NULL)=(parent_plan_revision_id IS NULL) AND (analysis_base_run_id IS NULL)=(analysis_result_digest IS NULL));
ALTER TABLE finnor_os.acquisition_decisions DROP CONSTRAINT acquisition_decisions_status_check;
ALTER TABLE finnor_os.acquisition_decisions ADD CONSTRAINT acquisition_decisions_status_check
 CHECK(status IN('QUEUED','RUNNING','WAITING_ANALYSIS','TESTED','PARTIAL','FAILED','INVALIDATED'));
GRANT UPDATE(analysis_program_id,analysis_base_run_id,analysis_result_digest) ON finnor_os.acquisition_decisions TO finnor_app;
CREATE FUNCTION finnor_os.guard_acquisition_analysis_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.parent_action_id IS DISTINCT FROM OLD.parent_action_id OR NEW.parent_plan_revision_id IS DISTINCT FROM OLD.parent_plan_revision_id
  OR OLD.analysis_program_id IS NOT NULL AND NEW.analysis_program_id IS DISTINCT FROM OLD.analysis_program_id
  OR OLD.analysis_base_run_id IS NOT NULL AND (NEW.analysis_base_run_id IS DISTINCT FROM OLD.analysis_base_run_id OR NEW.analysis_result_digest IS DISTINCT FROM OLD.analysis_result_digest)
 THEN RAISE EXCEPTION 'Acquisition analysis custody is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER acquisition_analysis_binding_immutable BEFORE UPDATE ON finnor_os.acquisition_decisions
 FOR EACH ROW EXECUTE FUNCTION finnor_os.guard_acquisition_analysis_binding();
