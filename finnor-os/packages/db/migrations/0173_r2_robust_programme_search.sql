-- New semantic job name: protocol 2 transport does not reinterpret v2 jobs.
ALTER TABLE finnor_os.m3_events DROP CONSTRAINT m3_events_kind_check;
ALTER TABLE finnor_os.m3_events ADD CONSTRAINT m3_events_kind_check CHECK(kind IN(
 'STARTED','CANDIDATE','MODULE_PREPARED','CHECK','FINISHED','FAILED','FENCED','CANCELLED','INVALIDATED','RESUMED','SELECTION',
 'R2_PHYSICAL_CHILD','R2_ENCODING_ACCEPTED','R2_FULL_WORLD_CHECKED','R2_ORIGINAL_TIE_CHECKED','R2_REJECTED_CLAIM'));

INSERT INTO finnor_os.compute_job_type_policies(job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('run_capital_program_r2_v1','INTERACTIVE',ARRAY['INTERACTIVE'],'fixed','tenant','required',1,
 'R2 complete exact finite programme search; original deadline, shared serial native grant, no effect or admission authority.');

-- One serial <=2 GiB owner/native family across worker/tenant processes. The 120s
-- permit outlives the original <=30s episode and physical kill/reap reserve.
-- Financial funding and project-wide 16GB economic qualification are separate.
INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source)
 VALUES('native:r2',1,1,1,120,'R2 engineering physical serial grant; not financial funding');
