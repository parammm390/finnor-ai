/**
 * Schema version required by every API/worker process in this release.
 *
 * Keep this beside the migrations so readiness and worker heartbeats cannot drift
 * by carrying independent literals.
 */
export const CURRENT_MIGRATION_HEAD = "0148_artifact_underwriting_bindings.sql";
