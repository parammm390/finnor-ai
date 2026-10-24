"""Offline PostgreSQL grammar check, not migration application or role/RLS proof."""
import hashlib
import json
from pathlib import Path
import re
import sys
import pglast
from pglast import parser

source = Path(__file__).with_name("shared-schema.sql").read_text()
report = {"schema": "finnor.z1.offline-sql-grammar.v1", "status": "IN_PROGRESS",
          "sqlSha256": hashlib.sha256(source.encode()).hexdigest(),
          "pglast": pglast.__version__, "parserPostgresqlVersion": parser.get_postgresql_version(),
          "databaseActions": 0, "sqlExecuted": False, "databaseSemantics": "NOT_RUN",
          "statements": [], "scope": "Grammar only. Catalog names, runtime SQL, RLS, roles and transaction behavior are not verified."}
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
print(json.dumps({"status": report["status"], "statementsParsed": len(report["statements"]), "databaseActions": 0}))
sys.exit(0 if report["status"] == "PASSED" else 1)
