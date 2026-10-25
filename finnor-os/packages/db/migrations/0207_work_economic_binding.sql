ALTER TABLE finnor_os.s7_economic_records DROP CONSTRAINT s7_economic_records_kind_check;
ALTER TABLE finnor_os.s7_economic_records ADD CONSTRAINT s7_economic_records_kind_check
 CHECK(kind IN ('PREREGISTRATION','SOURCE','ASSIGNMENT','EXPOSURE','MEASUREMENT','VALUATION','COST','ASSESSMENT','AGGREGATION','CORRECTION','INVALIDATION','COMPUTE','BENCHMARK_REGISTRATION','BENCHMARK_ASSESSMENT','WORK_BINDING'));
CREATE UNIQUE INDEX s7_work_economic_initial_binding ON finnor_os.s7_economic_records
 (tenant_id,principal_id,(body#>>'{payload,anchor,workInputId}'),(body#>>'{payload,anchor,criterionIndex}'),(body#>>'{payload,anchor,criterionHash}'))
 WHERE kind='WORK_BINDING' AND revision_of IS NULL;
CREATE UNIQUE INDEX s7_work_economic_binding_successor ON finnor_os.s7_economic_records
 (tenant_id,principal_id,revision_of) WHERE kind='WORK_BINDING' AND revision_of IS NOT NULL;
