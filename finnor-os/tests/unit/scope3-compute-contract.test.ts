import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMPUTE_CLASS_SCALE_TARGETS,
  PRODUCTION_JOB_CONTRACTS,
  WORKLOAD_CLASSES,
  classifyTrustedJobInstance,
} from "@finnor/db";
import { deriveComputeScalePressure } from "../../apps/worker/src/telemetry";
import { CLASS_CLAIM_SQL } from "../../apps/worker/src/queue";
import {
  SCOPE3_GATE_IDS,
  SCOPE3_MANDATORY_CASE_COUNT,
  SCOPE3_MANDATORY_CASES,
} from "../../scripts/release/scope3-compute-mandatory-cases";

const OS_ROOT = process.cwd();
const REPO_ROOT = resolve(OS_ROOT, "..");
const readOs = (path: string): string => readFileSync(resolve(OS_ROOT, path), "utf8");
const readRepo = (path: string): string => readFileSync(resolve(REPO_ROOT, path), "utf8");

describe("Scope-3 executable contract", () => {
  it("has exactly 75 named, ordered, mapped mandatory cases with no disguised non-gates", () => {
    expect(SCOPE3_MANDATORY_CASE_COUNT).toBe(75);
    expect(new Set(SCOPE3_MANDATORY_CASES.map((item) => item.id)).size).toBe(75);
    expect(SCOPE3_MANDATORY_CASES.every((item, index) => item.ordinal === index + 1)).toBe(true);
    expect(SCOPE3_MANDATORY_CASES.every((item) => item.gates.length > 0)).toBe(true);
    expect(SCOPE3_GATE_IDS.every((gate) => SCOPE3_MANDATORY_CASES.some((item) => item.gates.includes(gate)))).toBe(true);
    expect(SCOPE3_MANDATORY_CASES.some((item) => /\b(?:TODO|SKIP(?:PED)?|PLACEHOLDER|NOT.CONFIGURED)\b/i.test(`${item.id} ${item.statement}`))).toBe(false);
  });

  it("keeps the production handler inventory exhaustive and on one shared registry", () => {
    const worker = readOs("apps/worker/src/index.ts");
    const registered = [...worker.matchAll(/queue\.register\("([^"]+)"/g)].map((match) => match[1]).sort();
    expect(registered).toEqual(Object.keys(PRODUCTION_JOB_CONTRACTS).sort());
    expect(new Set(registered).size).toBe(registered.length);
    expect(readOs("apps/worker/src/job-contracts.ts")).toContain('from "@finnor/db"');
  });

  it("classifies from trusted type and lane only; payload-shaped promotion is inert", () => {
    for (const [type, contract] of Object.entries(PRODUCTION_JOB_CONTRACTS)) {
      const batch = classifyTrustedJobInstance({ type, lane: "batch", payload: { workloadClass: "REALTIME" } } as never);
      expect(batch.workloadClass).toBe(contract.defaultClass);
      const interactive = classifyTrustedJobInstance({ type, lane: "interactive", payload: { lane: "interactive", workloadClass: "REALTIME" } } as never);
      const expected = contract.classificationRule === "trusted_lane" && contract.allowedClasses.includes("INTERACTIVE")
        ? "INTERACTIVE"
        : contract.defaultClass;
      expect(interactive.workloadClass).toBe(expected);
    }
  });

  it("retains one canonical jobs table and no class-specific queue tables", () => {
    const migrations = readdirSync(resolve(OS_ROOT, "packages/db/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .map((name) => readOs(`packages/db/migrations/${name}`))
      .join("\n");
    expect((migrations.match(/CREATE TABLE(?: IF NOT EXISTS)? finnor_os\.jobs\b/gi) ?? [])).toHaveLength(1);
    expect(migrations).not.toMatch(/CREATE TABLE(?: IF NOT EXISTS)? finnor_os\.(?:realtime|interactive|background|heavy)_jobs\b/i);
  });

  it("filters class, protocol, due time, tenant fairness, and epoch inside the claim transaction", () => {
    const queue = readOs("apps/worker/src/queue.ts");
    const begin = queue.indexOf('await client.query("BEGIN")');
    const classInvocation = queue.indexOf("CLASS_CLAIM_SQL", begin);
    const classFilter = CLASS_CLAIM_SQL.indexOf("eligible.workload_class=$2");
    const lock = CLASS_CLAIM_SQL.indexOf("FOR UPDATE OF s SKIP LOCKED", classFilter);
    const commit = queue.indexOf('await client.query("COMMIT")', classInvocation);
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(classInvocation).toBeGreaterThan(begin);
    expect(classFilter).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(classFilter);
    expect(commit).toBeGreaterThan(classInvocation);
    expect(CLASS_CLAIM_SQL).toContain("supported.type=eligible.type AND supported.\"protocolVersion\"=eligible.protocol_version");
    expect(CLASS_CLAIM_SQL).toContain("eligible.run_at<=now()");
    expect(CLASS_CLAIM_SQL).toContain("s.last_claimed_at NULLS FIRST");
    expect(queue).toContain("finnor.compute_epoch");
  });

  it("defines four independent bounded task, slot, resource, role, and ingress envelopes", () => {
    const contract = JSON.parse(readRepo("infra/deployment/production.contract.json")) as {
      topology: { computePlane: { classes: Record<string, { cpu: number; memory: number; workerConcurrency: number; minTasks: number; maxTasks: number; ingress: string; taskRoleName: string; ageTargetSeconds: number; backlogPerTaskTarget: number }> } };
    };
    const classes = contract.topology.computePlane.classes;
    expect(Object.keys(classes)).toEqual([...WORKLOAD_CLASSES]);
    for (const workloadClass of WORKLOAD_CLASSES) {
      const profile = classes[workloadClass]!;
      expect(profile.minTasks).toBeGreaterThanOrEqual(1);
      expect(profile.maxTasks).toBeGreaterThanOrEqual(profile.minTasks);
      expect(profile.maxTasks).toBeLessThanOrEqual(3);
      expect(profile.workerConcurrency).toBeGreaterThanOrEqual(1);
      expect(profile.workerConcurrency).toBeLessThanOrEqual(8);
      expect(profile.ageTargetSeconds).toBe(COMPUTE_CLASS_SCALE_TARGETS[workloadClass].ageSeconds);
      expect(profile.backlogPerTaskTarget).toBe(COMPUTE_CLASS_SCALE_TARGETS[workloadClass].backlogPerTask);
    }
    expect(classes.HEAVY!.memory).toBeGreaterThan(classes.INTERACTIVE!.memory);
    expect(classes.HEAVY!.workerConcurrency).toBeLessThan(classes.INTERACTIVE!.workerConcurrency);
    expect(classes.REALTIME!.ingress).toBe("sse-alb");
    expect(Object.entries(classes).filter(([name, profile]) => name !== "REALTIME" && profile.ingress !== "none")).toEqual([]);
    expect(new Set(Object.values(classes).map((profile) => profile.taskRoleName)).size).toBeGreaterThanOrEqual(3);
  });

  it("proves the static ECS database-session envelope and managed pool hard cap", () => {
    const contract = JSON.parse(readRepo("infra/deployment/production.contract.json")) as {
      topology: { computePlane: { classes: Record<string, { maxTasks: number }> } };
    };
    const maxComputeTasks = Object.values(contract.topology.computePlane.classes).reduce((sum, profile) => sum + profile.maxTasks, 0);
    expect(maxComputeTasks).toBe(9);
    const db = readOs("packages/db/index.ts");
    expect(db).toMatch(/max:\s*unpooledLocal\s*\?\s*10\s*:\s*1/);
    expect(db).not.toContain("FINNOR_DB_POOL_MAX");
    const cfn = readRepo("infra/aws/finnor-production.yaml");
    expect((cfn.match(/Name: FINNOR_DB_POOL_MAX/g) ?? [])).toHaveLength(4);
    expect((cfn.match(/Value: '1'/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("treats zero healthy capacity and active work as scale pressure, never zero", () => {
    expect(deriveComputeScalePressure({
      workloadClass: "INTERACTIVE", eligibleQueued: 1, oldestEligibleAgeSeconds: 0,
      freshRunningTasks: 0, runningJobs: 0, activeSseConnections: 0,
    }).scalePressure).toBeGreaterThanOrEqual(2);
    expect(deriveComputeScalePressure({
      workloadClass: "HEAVY", eligibleQueued: 0, oldestEligibleAgeSeconds: 0,
      freshRunningTasks: 1, runningJobs: 1, activeSseConnections: 0,
    }).scalePressure).toBeGreaterThanOrEqual(1);
    expect(deriveComputeScalePressure({
      workloadClass: "REALTIME", eligibleQueued: 0, oldestEligibleAgeSeconds: 0,
      freshRunningTasks: 1, runningJobs: 0, activeSseConnections: 1,
    }).scalePressure).toBeGreaterThanOrEqual(1);
  });

  it("uses bounded metric dimensions and freshness-safe scale-in alarms", () => {
    const telemetry = readOs("apps/worker/src/telemetry.ts");
    expect(telemetry).toContain('Dimensions: [["Environment", "ServiceClass"]]');
    expect(telemetry).not.toMatch(/TenantId|tenant_id.*Dimensions/);
    const cfn = readRepo("infra/aws/finnor-production.yaml");
    for (const prefix of ["Realtime", "Interactive", "Background", "Heavy"]) {
      expect(cfn).toContain(`${prefix}ScaleOutAlarm:`);
      expect(cfn).toContain(`${prefix}ScaleInAlarm:`);
    }
    expect((cfn.match(/TreatMissingData: notBreaching/g) ?? [])).toHaveLength(8);
    expect(telemetry).toContain("TelemetryDegraded");
  });

  it("keeps scheduler and recovery leadership fenced and class-explicit", () => {
    const worker = readOs("apps/worker/src/index.ts");
    const scheduler = readOs("apps/worker/src/scheduler.ts");
    const control = readOs("packages/db/compute-control.ts");
    expect(worker).toContain('workloadClass === "BACKGROUND"');
    expect(worker).toContain("queue-recovery:${workloadClass ?? \"legacy\"}");
    expect(scheduler).toContain('startComputeControlLeadership("proactive-scheduler"');
    expect(control).toContain("lease_token=$3 AND fence=$4");
    expect(control).toContain("expires_at<=clock_timestamp()");
  });

  it("uses the staged cutover fence and exact release identity for all four services", () => {
    const deploy = readRepo("scripts/release/deploy-aws-compute-plane.mjs");
    const policy = readRepo("scripts/release/compute-plane-policy.mjs");
    expect(deploy).toContain('["preparing", "routing", "finalized", "rollout"]');
    expect(deploy).toContain("imageDigest");
    expect(deploy).toContain("activated_release_sha");
    expect(policy).toContain("assertComputeFleetConverged");
    expect(policy).toContain("heartbeat.meta?.serviceClass !== workloadClass");
    expect(policy).toContain("heartbeat.releaseSha !== expected.commitSha");
    expect(existsSync(resolve(REPO_ROOT, "scripts/release/deploy-aws-worker.mjs"))).toBe(false);
  });

  it("keeps class profiles portable across the deferred Scope-14 network and Region migration", () => {
    const contract = JSON.parse(readRepo("infra/deployment/production.contract.json")) as {
      topology: { worker: { region: string; natGateway: boolean }; computePlane: { classes: Record<string, Record<string, unknown>> } };
    };
    expect(contract.topology.worker.region).toBe("us-east-1");
    expect(contract.topology.worker.natGateway).toBe(false);
    for (const profile of Object.values(contract.topology.computePlane.classes)) {
      for (const scope14Field of ["region", "vpcId", "subnetIds", "natGateway", "privateSubnetIds"]) {
        expect(profile).not.toHaveProperty(scope14Field);
      }
    }
    const cfn = readRepo("infra/aws/finnor-production.yaml");
    expect(cfn).not.toContain("AWS::EC2::NatGateway");
    expect(cfn).not.toContain("AWS::CloudFormation::StackSet");
  });

  it("keeps Scope-3 ownership on existing jobs and ECS without introducing a future queue or orchestrator", () => {
    const computeMigration = readOs("packages/db/migrations/0138_scope3_compute_plane.sql");
    expect(computeMigration).toContain("finnor_os.jobs");
    expect(computeMigration).not.toMatch(/CREATE TABLE(?: IF NOT EXISTS)? finnor_os\.(?:realtime|interactive|background|heavy)_jobs\b/i);
    const cfn = readRepo("infra/aws/finnor-production.yaml");
    expect(cfn).not.toMatch(/AWS::(?:SQS|MSK|StepFunctions)::/);
    const worker = readOs("apps/worker/src/index.ts");
    expect(worker).toContain("startScheduler(");
    expect(worker).not.toMatch(/Temporal|Hatchet|Kafka/);
  });
});
