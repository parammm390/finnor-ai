import { meterSchema, type NativeMeter } from "./contracts";

/** These are actual supervisor measurements, never billed or child/container totals. */
export function beginNativeMeter(): () => NativeMeter {
  const started = performance.now(), startedAt = new Date().toISOString(), cpu = process.cpuUsage();
  return () => {
    const used = process.cpuUsage(cpu);
    return meterSchema.parse({
      schema: "finnor.w1.native-meter.v1", elapsedMs: performance.now() - started,
      startedAt, endedAt: new Date().toISOString(),
      cpuMs: (used.user + used.system) / 1000, peakMemoryBytes: process.resourceUsage().maxRSS * 1024,
      scope: "ROOT_PROCESS_INTERVAL_NONADDITIVE_CHILDREN_UNMETERED",
      peakMemoryScope: "ROOT_PROCESS_LIFETIME_MAX_RSS_NOT_INTERVAL_PEAK",
      humanSeconds: 0, costUSD: null, costStatus: "UNKNOWN", childCpuMs: null, childPeakMemoryBytes: null,
    });
  };
}
