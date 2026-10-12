-- Earlier default privileges survive a later GRANT SELECT. Remove raw writes
-- explicitly; the existing scoped SECURITY DEFINER owner functions retain their
-- ACLs and validate the actual authenticated Work/source/subject preimages.
REVOKE INSERT,UPDATE,DELETE ON finnor_os.x1_source_grants,
 finnor_os.x1_work_mandates,finnor_os.x1_subject_identity_bindings,
 finnor_os.x1_source_acquisitions,finnor_os.x1_mapping_admissions
 FROM finnor_app,finnor_worker;
GRANT SELECT ON finnor_os.x1_source_grants,
 finnor_os.x1_work_mandates,finnor_os.x1_subject_identity_bindings,
 finnor_os.x1_source_acquisitions,finnor_os.x1_mapping_admissions
 TO finnor_app,finnor_worker;
