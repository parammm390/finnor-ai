"""Trusted snapshot loader; query execution has no filesystem/network access."""
import base64
import datetime
import decimal
import hashlib
import importlib.metadata
import json
import math
import os
import re
import sys
import tempfile
import uuid


def serial(value):
    if isinstance(value, (decimal.Decimal, datetime.date, datetime.time, datetime.datetime, datetime.timedelta, uuid.UUID)):
        return str(value)
    if isinstance(value, bytes):
        return {"base64": base64.b64encode(value).decode("ascii")}
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("NONFINITE_QUERY_RESULT")
    if isinstance(value, (list, tuple)):
        return [serial(v) for v in value]
    if isinstance(value, dict):
        return {str(k): serial(v) for k, v in value.items()}
    return value


def run(payload):
    import duckdb
    tables = payload.get("tables", [])
    if not 1 <= len(tables) <= 8:
        raise ValueError("DATASET_COUNT_OUT_OF_BOUNDS")
    query = payload.get("query", "")
    if not isinstance(query, str) or not 1 <= len(query) <= 50000:
        raise ValueError("INVALID_ANALYTICAL_QUERY")
    max_rows = payload.get("maxRows", 1000)
    if not isinstance(max_rows, int) or not 1 <= max_rows <= 10000:
        raise ValueError("QUERY_ROW_LIMIT_OUT_OF_BOUNDS")
    con = duckdb.connect(":memory:", config={"threads": "1", "memory_limit": "128MB", "max_temp_directory_size": "0B",
        "allow_unsigned_extensions": "false", "allow_community_extensions": "false", "autoinstall_known_extensions": "false",
        "autoload_known_extensions": "false", "enable_external_access": "true", "allow_persistent_secrets": "false"})
    provenance, names, total_bytes = [], set(), 0
    try:
        with tempfile.TemporaryDirectory(prefix="finnor-duckdb-") as directory:
            for index, table in enumerate(tables):
                name = table.get("name", "")
                if not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", name) or name in names:
                    raise ValueError("INVALID_OR_DUPLICATE_DATASET_NAME")
                names.add(name)
                fmt = table.get("format")
                if fmt not in ("csv", "json", "parquet"):
                    raise ValueError("UNSUPPORTED_DATASET_FORMAT")
                data = base64.b64decode(table.get("bytesBase64", ""), validate=True)
                total_bytes += len(data)
                digest = hashlib.sha256(data).hexdigest()
                if digest != table.get("sha256"):
                    raise ValueError("DATASET_DIGEST_MISMATCH")
                if total_bytes > 10485760:
                    raise ValueError("DATASET_INPUT_TOO_LARGE")
                path = os.path.join(directory, str(index) + "." + fmt)
                with open(path, "wb") as output:
                    output.write(data)
                reader = {"csv": "read_csv_auto", "json": "read_json_auto", "parquet": "read_parquet"}[fmt]
                # File path is generated here. The table name is validated, and
                # caller SQL is not executed until these source files are removed.
                con.execute('CREATE TABLE "' + name + '" AS SELECT * FROM ' + reader + '(?)', [path])
                provenance.append({"name": name, "sha256": digest, "format": fmt, "bytes": len(data), "source": table.get("source")})
            con.execute("SET enable_external_access=false")
            con.execute("SET lock_configuration=true")
        statements = con.extract_statements(query)
        if len(statements) != 1 or statements[0].type != duckdb.StatementType.SELECT:
            raise ValueError("ONLY_ONE_READ_ONLY_SELECT_ALLOWED")
        result = con.execute(query)
        columns = [{"name": c[0], "type": str(c[1])} for c in result.description]
        rows = result.fetchmany(max_rows + 1)
        return {"schema": "finnor.duckdb-analysis.v1", "columns": columns, "rows": serial(rows[:max_rows]),
            "truncated": len(rows) > max_rows, "rowLimit": max_rows, "querySha256": hashlib.sha256(query.encode()).hexdigest(),
            "sources": provenance, "backend": {"name": "duckdb", "version": importlib.metadata.version("duckdb"), "python": sys.version.split()[0]},
            "security": {"externalAccess": False, "configurationLocked": True, "threads": 1, "memoryLimit": "128MB"},
            "qualification": "DERIVED_ANALYSIS_NOT_CANONICAL_UNDERWRITING", "executionAuthorityGranted": False}
    finally:
        con.close()


if __name__ == "__main__":
    source = hashlib.sha256(open(__file__, "rb").read()).hexdigest()
    try:
        payload = json.loads(sys.stdin.buffer.read(16777217))
        result = run(payload)
        print(json.dumps({"ok": True, "sourceSha256": source, "result": result}, allow_nan=False, separators=(",", ":")))
    except ModuleNotFoundError:
        print(json.dumps({"ok": False, "code": "DUCKDB_DEPENDENCY_UNAVAILABLE"}))
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r"[A-Z_]+", str(error)) else "DUCKDB_QUERY_REJECTED"
        print(json.dumps({"ok": False, "code": code}))
