-- Preserve published V migrations. Both observation owners must bind the exact
-- version to its actual source, not merely to an independently valid tenant ID.
DO $$
DECLARE primary_mismatches bigint; bilateral_mismatches bigint;
BEGIN
  SELECT count(*) INTO primary_mismatches
    FROM finnor_os.s1_primary_observations o
    JOIN finnor_os.evidence_source_versions v ON v.tenant_id=o.tenant_id AND v.id=o.evidence_version_id
    WHERE v.source_id IS DISTINCT FROM o.evidence_source_id;
  SELECT count(*) INTO bilateral_mismatches
    FROM finnor_os.s1_bilateral_observations o
    JOIN finnor_os.evidence_source_versions v ON v.tenant_id=o.tenant_id AND v.id=o.evidence_version_id
    WHERE v.source_id IS DISTINCT FROM o.evidence_source_id;
  IF primary_mismatches<>0 OR bilateral_mismatches<>0 THEN
    RAISE EXCEPTION 'OBSERVATION_SOURCE_VERSION_RECONCILIATION_REQUIRED primary=% bilateral=%', primary_mismatches,bilateral_mismatches;
  END IF;
END $$;

CREATE UNIQUE INDEX evidence_source_versions_tenant_source_version_idx
  ON finnor_os.evidence_source_versions(tenant_id,source_id,id);

ALTER TABLE finnor_os.s1_primary_observations
  ADD CONSTRAINT s1_primary_observation_source_version_fk
  FOREIGN KEY(tenant_id,evidence_source_id,evidence_version_id)
  REFERENCES finnor_os.evidence_source_versions(tenant_id,source_id,id);

ALTER TABLE finnor_os.s1_bilateral_observations
  ADD CONSTRAINT s1_bilateral_observation_source_version_fk
  FOREIGN KEY(tenant_id,evidence_source_id,evidence_version_id)
  REFERENCES finnor_os.evidence_source_versions(tenant_id,source_id,id);
