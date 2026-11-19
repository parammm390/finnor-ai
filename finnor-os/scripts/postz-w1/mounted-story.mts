/** Actual W1 mounted Work fixture. The browser remains the submitter of scored computation. */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { receiveWork, createEmployeeConversationThread } from "@finnor/db";
import { nativeHttpFixture } from "../p7/native-http-fixture.mjs";
import { browserFixture } from "../p2/browser-fixture.mjs";
import { prepareNativeOwnerFixture } from "./native-stories.mjs";
import { driveNativeProgram } from "./native-drive.mjs";

export async function mountedOwnerStory(e: any) {
  const started = performance.now(), foreign = randomUUID();
  const url = (thread: any, root: unknown) =>
    `http://127.0.0.1:4690/centropy/investigations/${thread.id}?root=${encodeURIComponent(JSON.stringify(root))}`;
  const f = await prepareNativeOwnerFixture(e, { beforeFit: async owner => {
    await e.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",
      [foreign, owner.tenant, foreign + "@w1.example.test"]);
    const otherRoot = { entityType: "external_organization", entityId: randomUUID() };
    await e.admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,'W1 other company','other')",
      [otherRoot.entityId, owner.tenant, randomUUID()]);
    const otherWork = await receiveWork({ tenantId: owner.tenant, userId: owner.principal,
      instruction: "Separate Work with no requested computation.", channel: "console", idempotencyKey: randomUUID(), activeContext: owner.root });
    const otherCompanyWork = await receiveWork({ tenantId: owner.tenant, userId: owner.principal,
      instruction: "Separate company with no requested computation.", channel: "console", idempotencyKey: randomUUID(), activeContext: otherRoot });
    const thread = await createEmployeeConversationThread({ tenantId: owner.tenant, ownerEmployeeId: owner.principal, title: "W1 original allocated Work" });
    const otherThread = await createEmployeeConversationThread({ tenantId: owner.tenant, ownerEmployeeId: owner.principal, title: "W1 empty thread" });
    const workThread = await createEmployeeConversationThread({ tenantId: owner.tenant, ownerEmployeeId: owner.principal,
      title: "W1 separate Work", workId: otherWork.workId });
    const companyThread = await createEmployeeConversationThread({ tenantId: owner.tenant, ownerEmployeeId: owner.principal,
      title: "W1 separate company", workId: otherCompanyWork.workId });
    const foreignThread = await createEmployeeConversationThread({ tenantId: owner.tenant, ownerEmployeeId: foreign, title: "W1 other principal" });
    owner.browser = { thread, otherThread, canvasRoot: owner.root,
      otherWork: { workId: otherWork.workId, url: url(workThread, owner.root) },
      otherCompany: { workId: otherCompanyWork.workId, url: url(companyThread, otherRoot) },
      otherPrincipal: { principalId: foreign, url: url(foreignThread, otherRoot) } };
  } });
  const destination = join(e.evidence, "w1-scored-native");
  await mkdir(destination, { recursive: false });
  const http = await nativeHttpFixture(e.admin, f.f.tenant, f.f.principal, foreign);
  const options = { schema: "finnor.economic-orchestration-options.v1", purposeRef: "work:" + f.p.workId,
    populationRef: "work:" + f.p.workId, domainRef: f.f.root.entityType + ":" + f.f.root.entityId,
    responseRef: null, observationSplit: "TRAIN" };
  const originalProgramId = f.p.programId, originalInputId = f.request.workInputId;
  let before: any;
  try {
    assert.equal(process.env.AUTH_DEV_BYPASS, "0");
    const warm = await http.call("economic-orchestration-submit", { ...f.search,
      schema: "finnor.economic-orchestration-request.v1", limits: { maxUnits: 8, maxParallel: 1 }, orchestration: options });
    assert.equal(warm.status, 202, JSON.stringify(warm));
    assert.equal(await driveNativeProgram(e.admin, e.queue, f.p.programId, performance.now()), "TESTED");
    before = (await e.admin.query("SELECT e.* FROM finnor_os.p1_episodes e JOIN finnor_os.p1_requests p ON p.episode_id=e.id WHERE p.id=$1", [f.p.programId])).rows[0];
    const input = await receiveWork({ tenantId: f.f.tenant, userId: f.f.principal, workId: f.p.workId,
      instruction: f.request.instruction, channel: "console", idempotencyKey: randomUUID() });
    assert.equal(input.workId, f.p.workId); assert.notEqual(input.workInputId, originalInputId);
    const request = { ...f.request, workInputId: input.workInputId, idempotencyKey: randomUUID() };
    const next = await http.call("program-submit", request);
    assert.equal(next.status, 202, JSON.stringify(next));
    await writeFile(join(destination, "mounted-warm-prefix.json"), JSON.stringify({ originalProgramId, originalInputId,
      before, warm, followUpInput: input, next, options, qualification: "TRAINING_NOT_INDEPENDENT_HELDOUT_OR_CAUSAL_GAIN" }, null, 2) + "\n");
    f.p = next.body; f.request = request;
  } finally { await http.close(); }
  await browserFixture({ ...e, f, delayedOperation: "economic-orchestration-projection", authExpiresSeconds: 100 });
  const mounted = JSON.parse(await readFile(join(e.evidence, "browser/run/results.json"), "utf8"));
  assert.equal(mounted.status, "PASS_LOCAL", JSON.stringify(mounted.steps));
  assert.equal(mounted.steps.length, 12);
  const independent = JSON.parse(await readFile(join(destination, "independent-oracle.json"), "utf8"));
  assert.equal(independent.status, "PASS");
  const after = (await e.admin.query("SELECT e.* FROM finnor_os.p1_episodes e JOIN finnor_os.p1_requests p ON p.episode_id=e.id WHERE p.id=$1", [f.p.programId])).rows[0];
  assert.equal(after.id, before.id); assert.equal(String(after.deadline_at), String(before.deadline_at));
  for (const key of ["max_attempts", "max_steps", "max_candidates", "max_depth"]) assert.equal(after[key], before[key]);
  assert(after.attempts_used > before.attempts_used && after.attempts_used <= after.max_attempts);
  const receipt = { schema: "finnor.w1.mounted-native-story.v1", status: "PASS_MOUNTED_AND_CONTROLLED_NATIVE",
    originalEpisode: after.id, before, after, originalGrant: f.search.computeGrant, originalProgramId, originalInputId,
    programId: f.p.programId, workId: f.p.workId, intervalMs: performance.now() - started,
    independent, mountedSteps: mounted.steps.map((step: any) => ({ id: step.id, status: step.status })),
    auth: "LOCAL_SIGNED_PASSWORD_REFRESH_LOGOUT_TWO_PRINCIPALS_BYPASS_0",
    protectedAdmission: false, fieldValidated: false, economicGainQualified: false, interruption: "NOT_RUN", coldRuntime: "NOT_RUN" };
  await writeFile(join(destination, "native-story.json"), JSON.stringify(receipt, null, 2) + "\n");
  return { evidence: destination, receipt };
}
