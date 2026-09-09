-- P2: exact thread/series/meeting inheritance can use a shared provider parent
-- tuple carried by prior immutable observations. Index the existing JSONB ledger;
-- this adds no second relationship or truth owner.

CREATE INDEX external_ref_observations_parent_refs_gin_idx
  ON finnor_os.external_ref_observations
  USING gin (provider_parent_refs jsonb_path_ops);

COMMENT ON INDEX finnor_os.external_ref_observations_parent_refs_gin_idx IS
  'Supports exact provider parent/thread/series/meeting relationship lookup for deterministic PE root inheritance.';
