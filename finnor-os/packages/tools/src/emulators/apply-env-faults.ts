// The Water capability emulators were retired with the vertical. This startup
// hook remains as a compatibility-safe no-op: it validates operator syntax but
// can never register or configure an executable retired capability.

import { parseEmulatorFaultsEnv } from "./fault-injection";

/** Returns the capabilities it actually applied a fault profile to, so the caller can
 *  log it (never a silent, invisible change to production emulator behavior). */
export function applyEmulatorFaultsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  parseEmulatorFaultsEnv(env.EMULATOR_FAULTS);
  return [];
}
