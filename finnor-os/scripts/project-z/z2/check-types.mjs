import ts from "typescript";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url)), destination = process.argv[2];
if (!destination || !isAbsolute(destination)) throw new Error("An absolute evidence JSON path is required");
const config = ts.readConfigFile(resolve(directory, "tsconfig.json"), ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, directory);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = [...parsed.errors, ...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()];
const reports = [];
for (const name of parsed.fileNames) {
  const source = program.getSourceFile(name);
  if (!source) throw new Error("Missing owned source: "+name);
  const own = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
  diagnostics.push(...own);
  reports.push({ file: name, sha256: createHash("sha256").update(readFileSync(name)).digest("hex"),
    diagnostics: own.map(d => {
      const loc = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
      return { file: d.file?.fileName, line: loc ? loc.line+1 : null, code: d.code,
        message: ts.flattenDiagnosticMessageText(d.messageText, "\n") };
    }) });
}
const errors = diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error);
const report = { typescript: ts.version, node: process.version,
  scope: "Owned Z2 files with actual imported types; dependencies are not independently typechecked",
  graphFiles: program.getSourceFiles().length, reports, errorCount: errors.length };
writeFileSync(destination, JSON.stringify(report, null, 2)+"\n", { flag: "wx" });
console.log(JSON.stringify(report));
process.exitCode = errors.length ? 1 : 0;
