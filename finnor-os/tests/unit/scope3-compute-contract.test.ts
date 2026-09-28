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
});
