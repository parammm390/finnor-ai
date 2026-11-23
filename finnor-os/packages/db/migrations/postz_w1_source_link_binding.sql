-- 0025 created a standalone index, not a constraint. 0099's DROP CONSTRAINT
-- left it active beside the canonical per-integration binding unique indexes.
-- Retire only that obsolete restriction; preserve both replacement indexes,
-- source identity, tenant foreign keys, permissions and RLS.
DROP INDEX IF EXISTS finnor_os.external_refs_internal_provider_idx;
