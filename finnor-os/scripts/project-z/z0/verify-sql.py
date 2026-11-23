"""Pinned offline SQL/PLpgSQL parser. Never connects to or initializes a DB."""
import argparse
import hashlib
import importlib
import json
import pathlib
import re
import sys

args = argparse.ArgumentParser()
args.add_argument("--tool-root", required=True)
args.add_argument("--source", required=True)
args.add_argument("--output", required=True)
args.add_argument("--expect-rejected", action="store_true")
options = args.parse_args()
tool = pathlib.Path(options.tool_root).resolve(strict=True)
source = pathlib.Path(options.source).resolve(strict=True)
output = pathlib.Path(options.output)
if not output.is_absolute() or output.exists():
    raise RuntimeError("NEW_ABSOLUTE_SQL_EVIDENCE_DIRECTORY_REQUIRED")
sys.path.insert(0, str(tool))
pglast = importlib.import_module("pglast")
parser = importlib.import_module("pglast.parser")
if not pathlib.Path(pglast.__file__).resolve().is_relative_to(tool) or pglast.__version__ != "v8.7":
    raise RuntimeError("OWN_EXACT_PGLAST_INSTALLATION_REQUIRED")
sha = lambda data: hashlib.sha256(data).hexdigest()
text = source.read_text()
functions = re.findall(r"CREATE FUNCTION\s+([^\s(]+).*?END \$\$;", text, re.S)
doctors = {}
for name, body, accepted in [
    ("sql-positive", "SELECT 1;", True),
    ("sql-negative", "SELECT FROM WHERE;", False),
    ("plpgsql-positive", "CREATE FUNCTION z0_doctor() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$;", True),
    ("plpgsql-negative", "CREATE FUNCTION z0_doctor() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN INVALID TOKEN; END $$;", False),
]:
    try:
        (pglast.parse_plpgsql if name.startswith("plpgsql") else pglast.parse_sql)(body)
        observed = True
    except pglast.Error:
        observed = False
    doctors[name] = {"expectedAccepted": accepted, "observedAccepted": observed, "pass": observed == accepted}
if not all(case["pass"] for case in doctors.values()):
    raise RuntimeError("SQL_PARSER_DOCTOR_FAILED")
output.mkdir(mode=0o700)
sql_ast = parser.parse_sql_json(text)
(output / "sql-ast.json").write_text(sql_ast + "\n")
diagnostics = []
for function in re.findall(r"(CREATE FUNCTION\s+[^\s(]+.*?END \$\$;)", text, re.S):
    name = re.match(r"CREATE FUNCTION\s+([^\s(]+)", function).group(1)
    try:
        ast = pglast.parse_plpgsql(function)
        (output / (name.rsplit(".", 1)[-1] + ".json")).write_text(json.dumps(ast, indent=2) + "\n")
        diagnostics.append({"function": name, "status": "PARSED"})
    except pglast.Error as error:
        diagnostics.append({"function": name, "status": "FAILED", "diagnostic": str(error)})
failed = sum(case["status"] == "FAILED" for case in diagnostics)
receipt = {
    "schema": "finnor.project-z.z0.offline-sql-parser.v1",
    "sourceSha256": sha(source.read_bytes()), "source": str(source),
    "checker": "pglast", "version": pglast.__version__,
    "postgresqlParserVersion": parser.get_postgresql_version(),
    "python": sys.version.split()[0], "nativeModuleSha256": sha(pathlib.Path(parser.__file__).read_bytes()),
    "doctors": doctors, "sqlStatements": len(pglast.parse_sql(text)),
    "functions": diagnostics, "expectedRejected": options.expect_rejected,
    "pass": len(functions) == 4 and (failed == 2 if options.expect_rejected else failed == 0),
    "sqlExecuted": False, "grantsExecuted": False, "catalogRolesRLS": "NOT_RUN",
    "validationToolOnlyNotProductDependency": True,
}
(output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt))
sys.exit(0 if receipt["pass"] else 1)
