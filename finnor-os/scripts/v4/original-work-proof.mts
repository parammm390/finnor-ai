/** Native-owner E2E of fixture continuation, not cumulative business acceptance. */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { configureTenantVertical, receiveWork } from "@finnor/db";
import { controlWorkObjective, startWorkObjective } from "@finnor/orchestration";
import { capitalDigest } from "../../packages/private-equity/src/capital-formation/contracts";
import { createCapitalFixtureBuilder } from "./owner-fixture.mts";

type BuilderContext = Parameters<typeof createCapitalFixtureBuilder>[0];
const goalFields = [
  "objective", "success_condition", "deadline_at", "revision", "max_steps", "max_actions", "max_queries",
  "max_planner_failures", "max_consecutive_no_progress", "max_parallel_nodes", "max_node_attempts",
  "max_waits", "max_estimated_cost_micros",
];

export async function originalWorkFixtureProof(context: BuilderContext, support: any) {
  async function seed(name: string) {
    const tenant = randomUUID(), principal = randomUUID();
    const root = { entityType: "external_organization" as const, entityId: randomUUID() };
    const admin = context.admin();
    await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,$3)", [tenant, randomUUID(), name]);
    await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",
      [principal, tenant, name + "@s5.example.test"]);
    await admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,$3,'other')",
      [root.entityId, tenant, name]);
    await configureTenantVertical({ tenantId: tenant, verticalKey: "private_equity", expectedVersion: 0,
      createdBy: principal, sourceSystem: "v4:original-work-fixture-proof" });
    const instruction = "Prepare financing under this original hypothetical mandate. Full transaction and economic verification remain required; fixture preparation cannot complete this Work.";
    const original = await startWorkObjective(instruction, {
      tenantId: tenant, userId: principal, employeeId: principal, role: "owner",
    }, {
      channel: "console", instructionId: randomUUID(), idempotencyKey: name,
      maxSteps: 96, maxActions: 25, maxQueries: 50,
      deadlineAt: new Date(Date.now() + context.programmeWallMs), deferInitialIteration: true,
      activeContext: { version: 1, capturedAt: new Date().toISOString(), source: "text",
        selectedEntities: [root], excludedEntities: [],
        surface: { id: "home", route: "/centropy", spatialState: "canvas" }, filters: [] },
      successCondition: { version: 1, statement: instruction, mode: "all", source: "explicit",
        criteria: [{ kind: "manual_verification", reason: "Whole transaction and actual economics are not supplied by this fixture." }] },
    });
    return { tenant, principal, root, workId: original.workId, workInputId: original.workInputId };
  }
  async function snapshot(f: Awaited<ReturnType<typeof seed>>) {
    const result = (await context.admin().query(`SELECT to_jsonb(l) loop,
      w.status work_status,(SELECT count(*)::int FROM finnor_os.work_inputs i
        WHERE i.tenant_id=w.tenant_id AND i.work_id=w.id) input_count
      FROM finnor_os.works w JOIN finnor_os.work_objective_loops l
        ON l.tenant_id=w.tenant_id AND l.work_id=w.id
      WHERE w.tenant_id=$1 AND w.id=$2`, [f.tenant, f.workId])).rows[0];
    assert(result, "Native Objective owner did not persist its original Work");
    return result;
  }
  const builder = createCapitalFixtureBuilder(context);
  const original = await seed("continuation-positive");
  const before = await snapshot(original);
  const prepared = await builder.fixture(support, "continuation-positive", false, { existing: original });
  const after = await snapshot(original);
  assert.equal(prepared.workId, original.workId);
  assert.equal(prepared.mandate.workInputId, original.workInputId);
  assert.equal(after.input_count, 1);
  const goal = (row: any) => Object.fromEntries(goalFields.map(key => [key, row.loop[key]]));
  assert.equal(capitalDigest(goal(before)), capitalDigest(goal(after)));
  for (const counter of ["step_count", "action_count", "query_count"])
    assert(after.loop[counter] >= before.loop[counter], counter + " decreased");
  assert(!["completed", "cancelled", "failed"].includes(after.work_status));
  const boundaries = { scientificEntries: 0 };
  const forbiddenSupport = { fixture: async () => {
    boundaries.scientificEntries++;
    throw Error("CONTINUATION_NEGATIVE_REACHED_SCIENTIFIC_PREPARATION");
  } };
  await assert.rejects(() => builder.fixture(forbiddenSupport, "continuation-stale-input", false, {
    existing: { ...original, workInputId: randomUUID() },
  }), /CAPITAL_CHAIN_ORIGINAL_INPUT_CHANGED/);
  const cancelled = await seed("continuation-cancelled");
  await controlWorkObjective({ tenantId: cancelled.tenant, workId: cancelled.workId,
    command: "cancel", actorId: cancelled.principal });
  await assert.rejects(() => builder.fixture(forbiddenSupport, "continuation-cancelled", false, {
    existing: cancelled,
  }), (error: any) => error.code === "STALE_INPUT");
  assert.equal(boundaries.scientificEntries, 0);

  const late = await seed("continuation-late-input");
  const lateBefore = await snapshot(late);
  let changed = false;
  const lateBuilder = createCapitalFixtureBuilder({
    ...context,
    actor: async (role, config) => {
      const actor = await context.actor(role, config);
      return { ...actor, rpc: async (command: string, value?: unknown) => {
        const result = await actor.rpc(command, value);
        if (command === "DEFINE" && !changed) {
          changed = true;
          const appended = await receiveWork({ tenantId: late.tenant, userId: late.principal,
            workId: late.workId, instruction: "A distinct material instruction arrived during preparation.",
            channel: "console", instructionId: randomUUID(), idempotencyKey: "late-" + late.workId });
          assert.equal(appended.workId, late.workId);
          assert.notEqual(appended.workInputId, late.workInputId);
        }
        return result;
      } };
    },
  });
  await assert.rejects(() => lateBuilder.fixture(support, "continuation-late-input", false, {
    existing: late,
  }), /CAPITAL_CHAIN_ORIGINAL_INPUT_CHANGED/);
  assert(changed, "Late-input fault did not reach independent provider preparation");
  const lateAfter = await snapshot(late);
  assert.equal(lateAfter.input_count, 2);
  assert.equal(capitalDigest(goal(lateBefore)), capitalDigest(goal(lateAfter)));
  const observed = { original, before, after, cancelled: await snapshot(cancelled),
    lateInput: { original: late, before: lateBefore, after: lateAfter },
    boundaries, sameWorkAndOriginalInputReused: true, wholeGoalCompleted: false,
    scope: "NATIVE_FIXTURE_CONTINUATION_NOT_V1_V5_CHAIN_OR_ADMISSION" };
  await context.artifact("original-work-continuation-proof.json", observed);
  return observed;
}
