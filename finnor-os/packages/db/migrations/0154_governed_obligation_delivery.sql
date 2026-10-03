-- Reuse the existing queue and its trusted classification/rolling compatibility boundary.
INSERT INTO finnor_os.compute_job_type_policies
 (job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
VALUES ('run_workflow_step_v3','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
 'S6 delivers exact S4 obligations through protected dispatch and read-only recovery.');

CREATE INDEX s6_governed_delivery_effect_idx ON finnor_os.workflow_steps(tenant_id,business_effect_id)
 WHERE step_type='execute_governed_obligation';
