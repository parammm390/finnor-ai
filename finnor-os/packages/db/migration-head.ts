/**
 * Schema version required by every API/worker process in this release.
 *
 * Keep this beside the migrations so readiness and worker heartbeats cannot drift
 * by carrying independent literals.
 */
export const CURRENT_MIGRATION_HEAD = "0197_postx_y3_interaction_protocol.sql";
