-- The original P1 immutable event stream owns remote attempt custody. Only the
-- background deletion protocol is new; no duplicate Work or execution tables.
INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
VALUES('reconcile_analytical_executor_v1','BACKGROUND',ARRAY['BACKGROUND'],'fixed','tenant','required',1,
 'Deletion-only reconciliation of an existing analytical sandbox; no new creation, inputs, execution or result publication.');
