"""Grammar checks only. Never a type, integration, native-family or gate proof."""
import argparse
import ast
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("destination", type=Path)
args = parser.parse_args()
root = Path(__file__).resolve().parents[3]
assert args.destination.is_absolute() and not args.destination.exists()
changed = set()
for command in (["git", "diff", "--name-only", "-z", "HEAD"],
                ["git", "ls-files", "--others", "--exclude-standard", "-z"]):
    changed.update(subprocess.check_output(command, cwd=root).decode().split("\0"))
extensions = {".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs", ".py", ".json"}
sources = sorted(root / name for name in changed if name and
    (root / name).suffix in extensions and (root / name).is_file() and
    "/evidence/" not in "/" + name and "/integration-proposals/" not in "/" + name)
assert sources, "CURRENT_DIRTY_SOURCE_CLOSURE_REQUIRED"
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
pins = {str(path.relative_to(root)): sha(path) for path in sources}
failures = []
for path in sources:
    try:
        if path.suffix == ".py":
            ast.parse(path.read_text(), filename=str(path))
        elif path.suffix == ".json":
            json.loads(path.read_text())
    except Exception as error:
        failures.append({"path": str(path.relative_to(root)), "error": str(error)})
javascript = [str(path) for path in sources if path.suffix not in (".py", ".json")]
program = """
const fs = require("node:fs");
const ts = require(process.argv[1]);
const failures = JSON.parse(process.argv[2]).flatMap(path => {
  const parsed = ts.createSourceFile(path, fs.readFileSync(path, "utf8"), ts.ScriptTarget.Latest,
    true, ts.getScriptKindFromFileName(path));
  return parsed.parseDiagnostics.map(d => ({path, start: d.start,
    error: ts.flattenDiagnosticMessageText(d.messageText, "\\n")}));
});
console.log(JSON.stringify(failures));
process.exitCode = failures.length ? 1 : 0;
"""
result = subprocess.run([os.environ["FINNOR_TEST_NODE"], "-e", program,
    str(root / "finnor-os/node_modules/typescript"), json.dumps(javascript)],
    cwd=root, capture_output=True, text=True, timeout=20)
if result.returncode not in (0, 1):
    failures.append({"nodeExitCode": result.returncode, "stderr": result.stderr})
else:
    failures.extend(json.loads(result.stdout))
after = {str(path.relative_to(root)): sha(path) for path in sources}
if after != pins:
    failures.append({"error": "SOURCE_DRIFT"})
report = {"schema": "finnor.w1.precommit-syntax.v1",
    "status": "FAIL" if failures else "PASS_SYNTAX_ONLY",
    "generatedAt": datetime.now(timezone.utc).isoformat(),
    "head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip(),
    "sourceCount": len(sources), "javascriptCount": len(javascript),
    "sourcesBefore": pins, "sourcesAfter": after, "failures": failures,
    "types": "NOT_RUN", "nativeFamilyCompletion": "NOT_RUN", "qualificationGates": "UNESTABLISHED",
    "rerun": ["python3", str(Path(__file__).resolve()), "<fresh-absolute-receipt-path>"]}
args.destination.parent.mkdir(parents=True, exist_ok=True)
with args.destination.open("x") as stream:
    json.dump(report, stream, indent=2)
    stream.write("\n")
print(json.dumps({key: report[key] for key in ("status", "sourceCount", "javascriptCount", "failures")}))
raise SystemExit(1 if failures else 0)
