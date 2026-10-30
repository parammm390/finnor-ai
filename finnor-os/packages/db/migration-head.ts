/**
 * Schema version required by every API/worker process in this release.
 *
 * Keep this beside the migrations so readiness and worker heartbeats cannot drift
 * by carrying independent literals.
 */
export const CURRENT_MIGRATION_HEAD = "postz_zi_z3_s4_executable_selection.sql";
