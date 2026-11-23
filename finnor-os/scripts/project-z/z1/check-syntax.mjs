import ts from "typescript";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

const destination = process.argv[2];
if (!destination || !isAbsolute(destination)) throw Error("ABSOLUTE_NEW_SYNTAX_REPORT_REQUIRED");
const files = [
  "epistemic-runtime/src/project-z/z1-shared-work/contracts.ts",
  "epistemic-runtime/src/project-z/z1-shared-work/relational.ts",
  "epistemic-runtime/src/project-z/z1-shared-work/engine.ts",
  "epistemic-runtime/src/project-z/z1-shared-work/producer-child.ts",
  "private-equity/src/project-z/z1-shared-work/processes.ts",
  "private-equity/src/project-z/z1-shared-work/owner.ts",
  "orchestration/src/project-z/z1-shared-work/worker.ts",
];
const records = [];
for (const file of files) {
  const source = await readFile(new URL("../../../packages/" + file, import.meta.url), "utf8");
  const result = ts.transpileModule(source, {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, strict: true, isolatedModules: true },
  });
  records.push({
    file, sha256: createHash("sha256").update(source).digest("hex"),
    errors: (result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error)
      .map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
  });
}
const report = {
  scope: "Isolated syntax/translation only. NOT native adapter type checking.",
  status: records.every(r => !r.errors.length) ? "PASSED" : "FAILED", records,
};
await writeFile(destination, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ scope: report.scope, status: report.status, files: records.length }));
if (report.status !== "PASSED") process.exitCode = 1;
