"""Offline PostgreSQL grammar check, not migration application or role/RLS proof."""
import hashlib
import json
from pathlib import Path
import re
import sys
import pglast
from pglast import parser

source_path = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).with_name("shared-schema.sql")
if not source_path.is_absolute():
    raise ValueError("ABSOLUTE_SQL_SOURCE_REQUIRED")
source = source_path.read_text()
report = {"schema": "finnor.z1.offline-sql-grammar.v1", "status": "IN_PROGRESS",
          "sourcePath": str(source_path),
          "sqlSha256": hashlib.sha256(source.encode()).hexdigest(),
          "pglast": pglast.__version__, "parserPostgresqlVersion": parser.get_postgresql_version(),
          "databaseActions": 0, "sqlExecuted": False, "databaseSemantics": "NOT_RUN",
          "statements": [], "scope": "Grammar only. Catalog names, runtime execution, RLS, roles and transaction behavior are not verified."}
statement = ""
try:
    for statement in parser.split(source):
        record = {"sha256": hashlib.sha256(statement.encode()).hexdigest(),
                  "head": statement.splitlines()[0][:120], "sqlGrammar": "PASSED"}
        parser.parse_sql(statement)
        if re.search(r"\bLANGUAGE\s+plpgsql\b", statement, re.I) or re.match(r"\s*DO\s+\$\$", statement, re.I):
            # libpg_query does not have this proposal's catalog composite types.
            # Replace only the local variable type declaration for grammar, not
            # statements, queries, bodies, expressions or the stored proposal.
            grammar = re.sub(r"\b(v_episode)\s+finnor_os\.z1_requests\b", r"\1 record", statement)
            parser.parse_plpgsql_json(grammar)
            record["plpgsqlGrammar"] = "PASSED_WITH_DECLARED_CATALOG_COMPOSITE_VARIABLE_AS_RECORD"
        report["statements"].append(record)
    if len(sys.argv) > 3 and sys.argv[3] == "z1-data-path":
        base = Path(__file__).resolve().parents[3]
        owned = base / "packages/private-equity/src/project-z/z1-shared-work"
        bindings = [
            ("native-store.ts", r"`(WITH expected AS .*?)`"),
            ("resources.ts", r"`(SELECT count\(\*\)::integer parents .*?)`"),
            ("resources.ts", r"`(SELECT o\.reservation_id,CASE WHEN octet_length.*?FOR UPDATE OF s)`"),
            ("portfolio-store.ts", r"`(SELECT r\.body FROM finnor_os\.s5_resources r.*?FOR SHARE OF h)`"),
            ("portfolio-store.ts", r"`(SELECT finnor_os\.request_tenant_id\(\).*?FOR SHARE)`"),
            ("portfolio-store.ts", r"`(SELECT p\.\*,\(SELECT count\(\*\)::integer .*?FROM finnor_os\.z1_s5_portfolio_population\(\) p)`"),
            ("native.ts", r"`(UPDATE finnor_os\.z1_deliveries SET status='CONSUMED'.*?)`"),
        ]
        bindings = [(owned / name, pattern) for name, pattern in bindings]
        driver = base / "scripts/project-z/z1/native-e2e-run.mjs"
        bindings.extend((driver, pattern) for pattern in [
            r"`(SELECT 'CONSTRAINT' kind,c\.conname name,.*?ORDER BY kind,name)`",
            r"`(SELECT s\.reservation_id,s\.status,o\.body#>>.*?ORDER BY s\.reservation_id LIMIT \$4)`",
            r"`(SELECT publication_id,work_id,semantic_owner,reference,.*?ORDER BY publication_id,work_id LIMIT \$4)`",
            r"`(SELECT id,delivery_id,status,costs_unknown,reserved_wall_ms,.*?ORDER BY created_at,id LIMIT 17)`",
            r"`(SELECT reference,\s*CASE WHEN octet_length\(body::text\)<=150994944.*?LIMIT 2)`",
        ])
        report["inlineSQL"] = []
        for path, pattern in bindings:
            body = path.read_text()
            queries = re.findall(pattern, body, re.S)
            if len(queries) != 1 or "${" in queries[0]:
                raise ValueError("EXACT_STATIC_DATA_PATH_SQL_REQUIRED:" + path.name)
            statement = queries[0]
            parser.parse_sql(statement)
            report["inlineSQL"].append({"path": str(path), "sourceSha256": hashlib.sha256(body.encode()).hexdigest(),
                                       "querySha256": hashlib.sha256(queries[0].encode()).hexdigest(), "grammar": "PASSED"})
    report["status"] = "PASSED"
except Exception as error:
    report["status"] = "FAILED"
    report["failure"] = {"type": type(error).__name__, "message": str(error)}
    report["failedStatement"] = statement
destination = Path(sys.argv[1])
if not destination.is_absolute():
    raise ValueError("ABSOLUTE_NEW_REPORT_REQUIRED")
with destination.open("x") as output:
    json.dump(report, output, indent=2)
    output.write("\n")
print(json.dumps({"status": report["status"], "statementsParsed": len(report["statements"]),
                  "inlineQueriesParsed": len(report.get("inlineSQL", [])), "databaseActions": 0}))
sys.exit(0 if report["status"] == "PASSED" else 1)
