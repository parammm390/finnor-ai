// Chaos-testing hook — reads FINNOR_CHAOS_KILL_POINT (never set in production; test-only,
// same "env var gated, off by default" convention as AUTH_DEV_BYPASS). When the current
// kill point matches, the process sends itself an unmaskable SIGKILL — a real crash, not
// a graceful exit, so no finally/cleanup code runs. The Scope-2 release corpus invokes
// these hooks from a separate process and proves durable recovery from PostgreSQL.

export type ChaosKillPoint = "command_pre_commit" | "pre_commit" | "post_commit_pre_ack" | "mid_multi_step";

export function maybeChaosKill(point: ChaosKillPoint): void {
  if (process.env.FINNOR_CHAOS_KILL_POINT === point) {
    process.kill(process.pid, "SIGKILL");
  }
}
