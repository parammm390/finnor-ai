/**
 * SQL-side read ceilings for production paths.
 *
 * These are intentionally shared so a new caller cannot quietly invent an
 * unbounded read of an append-only table. Callers must apply the value to the
 * Drizzle query itself; trimming an already-fetched array is not a bound.
 */
export const MAX_HIGH_EGRESS_ROWS = 1_000;
export const MAX_INSTRUCTION_EVENT_PAGE = 100;
export const MAX_WORK_AGGREGATE_ROWS = 1_000;
export const MAX_BACKGROUND_SCAN_BATCH = 250;
