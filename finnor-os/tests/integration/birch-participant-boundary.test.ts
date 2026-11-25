import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("allows Birch participant Work and standalone artifact editing, but denies deal-memo intake", async () => {
  const root = process.env.FINNOR_BIRCH_EVIDENCE_DIR ?? join(homedir(), "birch-evidence");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "participant-boundary-"));
  console.log(`Birch participant boundary receipt: ${directory}`);
  await promisify(execFile)(process.execPath, [
    "--import=tsx", "scripts/pe-acceptance/run.mts", directory, "participant-boundary",
  ], { cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 90_000 });
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  const report = JSON.parse(await readFile(join(directory, files[0]!), "utf8"));
  expect(report.status).toBe("PARTICIPANT_BOUNDARY_OBSERVED");
  expect(report.attempts).toHaveLength(1);
  const [attempt] = report.attempts;
  const proof = attempt.boundaryProof;
  expect(attempt.actorRole).toBe("participant");
  expect(attempt.transport.signatureRefusals).toBe(0);
  expect(attempt.transport.userRequests).toBeGreaterThan(0);

  const id = expect.stringMatching(/^[a-f0-9-]{36}$/);
  expect(attempt.intake).toStrictEqual({
    status: 403,
    body: {
      error: "The business root or selected subject is unavailable in the current scope",
      recoverable: true,
      workId: id,
      workInputId: id,
      instructionId: id,
    },
  });
  expect(attempt.work.status).toBe(200);
  expect(attempt.work.body.work.work).toMatchObject({
    id: attempt.intake.body.workId,
    createdBy: attempt.requestedPrincipal,
  });
  expect(attempt.loop).toBeUndefined();
  expect(attempt.jobs).toStrictEqual([]);
  expect(proof.domainActionCount).toBe(0);
  expect(attempt.effects).toStrictEqual([]);

  const hidden = { status: 404, body: { error: "Work not found" } };
  expect(proof.custodianWorkStatus).toBe(200);
  expect(proof.missingWork).toStrictEqual(hidden);
  expect(proof.foreignWork).toStrictEqual(hidden);
  expect(proof.custodianEvidence).toStrictEqual({ status: 201, workId: id, includesB2: true });
  expect(proof.participantEvidenceAuthorization).toStrictEqual({
    code: "PE_ENTITY_NOT_FOUND",
    message: "PE world root was not found in the authenticated tenant",
  });
  expect(proof.foreignEvidence).toStrictEqual(hidden);

  const { created, drafted, patched, patchRequest, readback, currentStatus, currentVersionId } = proof.standaloneArtifactDraft;
  expect(created.status).toBe(201);
  expect(drafted.status).toBe(201);
  expect(drafted.body.draftKey).toMatch(new RegExp(`^${attempt.requestedPrincipal}:`));
  expect(drafted.body.versionId).toBe(created.body.version.id);
  expect(patched.status).toBe(201);
  expect(patched.body.version).toMatchObject({
    id,
    parent_version_id: created.body.version.id,
    created_by: attempt.requestedPrincipal,
  });
  expect(patched.body.version.id).not.toBe(created.body.version.id);
  expect(readback.status).toBe(200);
  expect(readback.body.nodes).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "paragraph", data: expect.objectContaining({ text: patchRequest.operations[0].text }) }),
  ]));
  expect(currentStatus).toBe(200);
  expect(currentVersionId).toBe(created.body.version.id);
  expect(attempt.modelCalls).toStrictEqual([]);
}, 100_000);
