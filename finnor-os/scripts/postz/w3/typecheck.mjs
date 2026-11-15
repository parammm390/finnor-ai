/** Complete-program diagnostics with bounded semantic cache lifetime.
 * Each partition sees the same full project, not declarations or changed files.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync } from "node:fs";
import { join, isAbsolute } from "node:path";

const sha = value => createHash("sha256").update(value).digest("hex");
const json = path => JSON.parse(readFileSync(path, "utf8"));
const save = (path, body) => writeFileSync(path, JSON.stringify(body, null, 2) + "\n",
  { flag: "wx", mode: 0o600 });
const args = process.argv.slice(2);
const partitions = 12;

if (args[0] === "--worker") {
  assert.equal(args.length, 4);
  const [, project, output, part] = args;
  const require = createRequire(project), ts = require("typescript"), compiler = require.resolve("typescript");
  const configuration = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(project, {}, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => configuration.push(diagnostic),
  });
  assert(parsed && configuration.length === 0, "W3_TYPECHECK_CONFIGURATION_REQUIRED");
  assert.equal(parsed.options.noEmit, true, "W3_DIAGNOSTIC_ONLY_PROJECT_REQUIRED");
  assert(!parsed.options.noCheck, "W3_NO_CHECK_MUST_NOT_BE_ENABLED");
  assert.equal(parsed.options.skipLibCheck, true, "W3_DECLARED_PROJECT_SKIP_LIB_CHECK_REQUIRED");
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options,
    projectReferences: parsed.projectReferences });
  const all = [...program.getSourceFiles()].sort((a, b) => a.fileName.localeCompare(b.fileName));
  const graph = all.map(source => ({
    path: source.fileName, sha256: sha(source.text), declaration: source.isDeclarationFile, bytes: Buffer.byteLength(source.text),
  }));
  const identity = {
    compiler, compilerSha256: sha(readFileSync(compiler)), version: ts.version,
    configurationSha256: sha(JSON.stringify({ options: parsed.options, roots: parsed.fileNames,
      references: parsed.projectReferences ?? [] })), graphSha256: sha(JSON.stringify(graph)),
  };
  let diagnostics = [...parsed.errors, ...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()];
  let checked = [];
  if (part === "discover") {
    diagnostics.push(...program.getSyntacticDiagnostics());
    const buckets = Array.from({ length: partitions }, (_, id) => ({ id, bytes: 0, files: [] }));
    for (const source of graph.filter(source => !source.declaration)
      .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))) {
      const bucket = [...buckets].sort((a, b) => a.bytes - b.bytes || a.id - b.id)[0];
      bucket.files.push(source.path); bucket.bytes += source.bytes;
    }
    save(join(output, "graph.json"), { identity, files: graph, buckets });
  } else {
    const manifest = json(join(output, "graph.json")), ordinal = Number(part);
    assert(Number.isSafeInteger(ordinal) && ordinal >= 0 && ordinal < partitions);
    assert.deepEqual(identity, manifest.identity, "W3_TYPECHECK_COMPLETE_GRAPH_CHANGED");
    checked = manifest.buckets[ordinal].files;
    const lookup = new Map(all.map(source => [source.fileName, source]));
    for (const path of checked) {
      assert(lookup.has(path), "W3_TYPECHECK_SEMANTIC_SOURCE_MISSING");
      console.log(JSON.stringify({ semanticFile: path, status: "STARTED" }));
      diagnostics.push(...program.getSemanticDiagnostics(lookup.get(path)));
      console.log(JSON.stringify({ semanticFile: path, status: "COMPLETED", heapUsed: process.memoryUsage().heapUsed }));
    }
  }
  const errors = diagnostics.map(diagnostic => {
    const at = diagnostic.file && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : null;
    return { category: ts.DiagnosticCategory[diagnostic.category], code: diagnostic.code,
      file: diagnostic.file?.fileName ?? null, line: at ? at.line + 1 : null, column: at ? at.character + 1 : null,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n") };
  });
  save(join(output, part + ".json"), { identity, checked, diagnostics: errors });
  console.log(JSON.stringify({ part, checked: checked.length, diagnosticCount: errors.length, diagnostics: errors }));
  process.exitCode = errors.length ? 1 : 0;
} else {
  assert(args.length === 4 && args[0] === "--project" && args[2] === "--output"
    && isAbsolute(args[1]) && isAbsolute(args[3]), "W3_TYPECHECK_ABSOLUTE_PROJECT_AND_NEW_OUTPUT_REQUIRED");
  const project = args[1], output = args[3];
  assert(!existsSync(output), "W3_TYPECHECK_NEW_OUTPUT_REQUIRED");
  mkdirSync(output, { mode: 0o700 });
  const started = performance.now(), steps = [];
  let passed = false, graph = null, failure = null;
  const run = part => {
    assert(process.memoryUsage().heapUsed < 128 * 1024 ** 2, "W3_TYPECHECK_PARENT_HEAP_BOUND");
    const remaining = Math.floor(300000 - (performance.now() - started));
    assert(remaining > 0, "W3_TYPECHECK_ORIGINAL_TOTAL_TIME_BOUND");
    const log = join(output, part + ".log"), fd = openSync(log, "wx");
    const at = performance.now();
    let child;
    try {
      child = spawnSync(process.execPath, ["--max-old-space-size=1408", import.meta.filename,
        "--worker", project, output, part], { stdio: ["ignore", fd, fd], timeout: remaining });
    } finally { closeSync(fd) }
    const step = { part, exitCode: child.status, signal: child.signal, elapsedMs: performance.now() - at,
      log, sha256: sha(readFileSync(log)), heapMiB: 1408 };
    steps.push(step); console.log(JSON.stringify(step));
    assert.equal(child.status, 0, "W3_FULL_CONTEXT_TYPECHECK_PART_FAILED:" + part);
  };
  try {
    run("discover"); graph = json(join(output, "graph.json"));
    for (let part = 0; part < partitions; part++) run(String(part));
    const expected = graph.files.filter(file => !file.declaration).map(file => file.path).sort();
    const checked = Array.from({ length: partitions }, (_, part) => json(join(output, part + ".json")).checked).flat().sort();
    assert.deepEqual(checked, expected, "W3_COMPLETE_SEMANTIC_COVERAGE_REQUIRED");
    assert.equal(new Set(checked).size, checked.length, "W3_DUPLICATE_SEMANTIC_COVERAGE");
    assert(performance.now() - started < 300000, "W3_TYPECHECK_ORIGINAL_TOTAL_TIME_BOUND");
    passed = true;
  } catch (error) {
    failure = error.message; process.exitCode = 1;
  } finally {
    save(join(output, "report.json"), {
      schema: "finnor.w3.bounded-full-context-typecheck.v1", project,
      status: passed ? "PASS_COMPLETE_PROGRAM_DIAGNOSTICS" : "FAILED_RETAINED", failure,
      identity: graph?.identity ?? null, completeGraphFiles: graph?.files.length ?? null,
      semanticFiles: graph?.files.filter(file => !file.declaration).length ?? null,
      everyPartitionUsesCompleteProgram: true, changedOnly: false, substituteDeclarations: false,
      wallBoundMs: 300000, serialPartitions: partitions, childHeapMiB: 1408, parentHeapBoundMiB: 128,
      elapsedMs: performance.now() - started, steps, originalProjectSkipLibCheckUnchanged: true,
    });
    console.log(JSON.stringify({ status: passed ? "PASS_COMPLETE_PROGRAM_DIAGNOSTICS" : "FAILED_RETAINED", failure }));
  }
}
