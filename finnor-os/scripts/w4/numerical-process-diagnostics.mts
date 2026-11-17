/** Private ordinary-fixture observation, never a model or authority receipt. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function captureNumericalProcesses(output: string) {
  const directory = join(output, "private-diagnostics");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid!()
    && (stat.mode & 0o077) === 0, "W4_PRIVATE_NUMERICAL_DIRECTORY_REQUIRED");
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const save = (name: string, bytes: Buffer | string) => {
    const fd = openSync(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    const parent = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(parent) } finally { closeSync(parent) }
  };
  const records = new Map<string, { number: number; prefix: string; inputSha256: string; inputBytes: number; outcome: boolean; diagnosticPassed: boolean }>();
  let invalid = 0, failures = 0;
  const topic = channel("finnor.s3.private-process-diagnostic.v1");
  const observe = (raw: unknown) => {
    try {
      assert(raw && typeof raw === "object" && !Array.isArray(raw));
      const value = raw as Record<string, any>;
      assert.equal(value.schema, "finnor.s3.private-process-diagnostic.v1");
      assert.equal(value.publisherPid, process.pid);
      assert(typeof value.id === "string" && /^[a-f0-9]{64}$/.test(value.id));
      assert(typeof value.confirmPersisted === "function");
      assert(value.header && typeof value.header === "object" && !Array.isArray(value.header));
      const headerText = JSON.stringify(value.header);
      assert(Buffer.byteLength(headerText) <= 65536, "W4_NUMERICAL_DIAGNOSTIC_METADATA_BOUND");
      if (value.stage === "INPUT") {
        assert(records.size < 64 && !records.has(value.id));
        assert(Buffer.isBuffer(value.rawInput) && value.rawInput.length <= 8 * 1024 ** 2);
        assert.equal(sha(value.rawInput), value.header.inputSha256);
        assert.equal(value.rawInput.length, value.header.inputBytes);
        const number = records.size + 1, prefix = "numerical-" + String(number).padStart(3, "0");
        save(prefix + "-stdin.json", value.rawInput);
        save(prefix + "-input-binding.json", headerText + "\n");
        records.set(value.id, { number, prefix, inputSha256: value.header.inputSha256,
          inputBytes: value.rawInput.length, outcome: false, diagnosticPassed: false });
      } else if (value.stage === "OUTCOME") {
        const record = records.get(value.id); assert(record && !record.outcome);
        assert(Buffer.isBuffer(value.rawStdout) && value.rawStdout.length <= 8 * 1024 ** 2);
        assert(Buffer.isBuffer(value.rawStderr) && value.rawStderr.length <= 2048);
        assert.equal(value.header.inputSha256, record.inputSha256);
        const phases: Record<string, any>[] = [];
        let pending = "";
        for (const chunk of value.header.childTraceChunks ?? []) {
          assert(typeof chunk.data === "string" && Number.isFinite(chunk.receivedAtParentElapsedMs));
          pending += chunk.data;
          assert(Buffer.byteLength(pending) <= 16384);
          let at: number;
          while ((at = pending.indexOf("\n")) >= 0) {
            const frame = JSON.parse(pending.slice(0, at)); pending = pending.slice(at + 1);
            assert(frame && typeof frame.phase === "string" && Number.isFinite(frame.elapsedMs));
            phases.push({ ...frame, receivedAtParentElapsedMs: chunk.receivedAtParentElapsedMs });
            assert(phases.length <= 32);
          }
        }
        assert.equal(pending, "", "W4_NUMERICAL_DIAGNOSTIC_PARTIAL_FRAME");
        const eof = phases.find(frame => frame.phase === "STDIN_EOF");
        const required = ["IMPORTS_BEGIN", "NUMPY_READY", "SCIPY_READY", "STATSMODELS_READY", "IMPORTS_READY",
          "VERSIONS_BEGIN", "VERSIONS_READY", "STDIN_BEGIN", "STDIN_EOF", "COMPUTE_BEGIN", "COMPUTE_READY", "REPORT_BEGIN", "REPORT_WRITTEN"];
        record.diagnosticPassed = value.header.reason === null && value.header.child?.exitCode === 0
          && value.header.child?.signal === null && value.header.childTraceOverflow === false
          && value.header.timeoutMs === 20000 && value.header.inputRef === value.header.computeInputRef
          && required.every(phase => phases.some(frame => frame.phase === phase))
          && eof?.inputSha256 === record.inputSha256 && eof?.inputBytes === record.inputBytes;
        save(record.prefix + "-stdout.bin", value.rawStdout);
        save(record.prefix + "-stderr.bin", value.rawStderr);
        save(record.prefix + "-outcome.json", JSON.stringify({ ...value.header, phases,
          rawStdoutSha256: sha(value.rawStdout), rawStdoutCapturedBytes: value.rawStdout.length,
          rawStderrSha256: sha(value.rawStderr), rawStderrCapturedBytes: value.rawStderr.length,
          diagnosticPassed: record.diagnosticPassed, qualificationCredit: false }) + "\n");
        record.outcome = true;
      } else throw Error("W4_UNKNOWN_NUMERICAL_DIAGNOSTIC_STAGE");
      value.confirmPersisted();
    } catch { invalid++; failures++ }
  };
  topic.subscribe(observe);
  return {
    close: () => topic.unsubscribe(observe),
    summary: () => ({ schema: "finnor.w4.private-numerical-process-observations.v1", observerPid: process.pid,
      captures: [...records.values()], invalid, failures,
      complete: records.size > 0 && invalid === 0 && failures === 0
        && [...records.values()].every(record => record.outcome && record.diagnosticPassed),
      original006Cause: "UNKNOWN", qualificationCredit: false,
      scope: "ACTUAL_ADAPTER_INPUT_AND_CHILD_OUTCOME_NOT_COLD_INSTALL_OR_FIELD_QUALIFICATION" }),
    assertComplete: () => assert(records.size > 0 && invalid === 0 && failures === 0
      && [...records.values()].every(record => record.outcome && record.diagnosticPassed),
    "W4_ACTUAL_NUMERICAL_PROCESS_DIAGNOSTIC_INCOMPLETE"),
  };
}
