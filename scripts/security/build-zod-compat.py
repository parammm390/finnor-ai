"""Rebuild the integrity-pinned, locally patched Zod v3 compatibility archive."""
import base64
import difflib
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
UPSTREAM = "4.6.7"
INTEGRITY = "sha512-g8W2D2kU6a8untc053fX1uVBKzM7yqAxW/3zwk83+6RyF2+SKOuV+c0wBDhUwzV1PaGapmZH+rmcUzPf+3CGwg=="
VENDOR = ROOT / "vendor/zod"
ARCHIVE = ROOT / "vendor/finnor-zod-3.25.76-finnor.1.tgz"


def patch_parser(text):
    start = re.search(r"\bclass ZodArray\b", text).start()
    end = text.index("get element()", start)
    section = text[start:end]
    invalid = re.search(r"return ([\w.]*INVALID);", section).group(1)
    changes = list(re.finditer(r"(?m)^([ \t]*)status\.dirty\(\);", section))
    assert len(changes) == 3, "UPSTREAM_ARRAY_IMPLEMENTATION_CHANGED"
    for index in [2, 0]:
        match = changes[index]
        replacement = match[1] + "return " + invalid + ";" if index == 2 else (
            match[1] + "if (tooBig) return " + invalid + ";\n" + match[0])
        section = section[:match.start()] + replacement + section[match.end():]
    text = text[:start] + section + text[end:]
    start = re.search(r"\bclass ZodSet\b", text).start()
    end = text.index("const valueType =", start)
    section = text[start:end]
    changes = list(re.finditer(r"(?m)^([ \t]*)status\.dirty\(\);", section))
    assert len(changes) == 2, "UPSTREAM_SET_IMPLEMENTATION_CHANGED"
    match = changes[-1]
    invalid = re.search(r"return ([\w.]*INVALID);", section).group(1)
    section = section[:match.start()] + match[1] + "return " + invalid + ";" + section[match.end():]
    return text[:start] + section + text[end:]


with tempfile.TemporaryDirectory(prefix="finnor-zod-backport-") as temporary:
    directory = Path(temporary)
    env = {**os.environ, "npm_config_cache": str(directory / "npm-cache")}
    subprocess.run(["npm", "pack", "zod@" + UPSTREAM, "--ignore-scripts",
                    "--pack-destination", str(directory), "--json"],
                   env=env, stdout=subprocess.DEVNULL, check=True)
    upstream = (directory / ("zod-" + UPSTREAM + ".tgz")).read_bytes()
    actual = "sha512-" + base64.b64encode(hashlib.sha512(upstream).digest()).decode()
    assert actual == INTEGRITY, "UPSTREAM_ARCHIVE_INTEGRITY_MISMATCH"
    contents = {}
    with tarfile.open(fileobj=io.BytesIO(upstream), mode="r:gz") as source:
        for member in source.getmembers():
            path = PurePosixPath(member.name)
            assert path.parts[0] == "package" and ".." not in path.parts and not path.is_absolute()
            assert member.isfile() or member.isdir(), "REGULAR_UPSTREAM_FILES_REQUIRED"
            if member.isfile():
                contents[str(path)] = source.extractfile(member).read()
    original = dict(contents)
    for path in ["package/v3/types.js", "package/v3/types.cjs", "package/src/v3/types.ts"]:
        contents[path] = patch_parser(contents[path].decode()).encode()
    metadata = json.loads(contents["package/package.json"])
    assert metadata["version"] == UPSTREAM
    metadata.update({"name": "@finnor/zod", "version": "3.25.76+finnor.1",
                     "main": "./v3/index.cjs", "module": "./v3/index.js", "types": "./v3/index.d.cts"})
    metadata["exports"]["."] = {
        "types": "./v3/index.d.cts", "import": "./v3/index.js",
        "require": "./v3/index.cjs", "@zod/source": "./src/v3/index.ts"}
    metadata.pop("scripts", None)
    metadata["finnorProvenance"] = {
        "upstreamVersion": UPSTREAM, "upstreamIntegrity": INTEGRITY,
        "upstreamFix": "https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd",
        "advisory": "GHSA-mrhx-c7xc-m3w5",
        "qualification": "LOCAL_PATCHED_V3_COMPATIBILITY_FORK; NOT_PUBLISHED_UPSTREAM_V3_FIX"}
    contents["package/package.json"] = (json.dumps(metadata, indent=2) + "\n").encode()
    patch = "".join("".join(difflib.unified_diff(original[name].decode().splitlines(True),
                     contents[name].decode().splitlines(True), fromfile="upstream/" + name,
                     tofile="patched/" + name, n=0)) for name in sorted(contents) if contents[name] != original[name])
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb", filename="", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as output:
            for name, body in sorted(contents.items()):
                info = tarfile.TarInfo(name)
                info.size, info.mode, info.mtime, info.uid, info.gid = len(body), 0o644, 0, 0, 0
                info.uname = info.gname = ""
                output.addfile(info, io.BytesIO(body))
    VENDOR.mkdir(parents=True, exist_ok=True)
    (VENDOR / "collection-size.patch").write_text(patch)
    archive = buffer.getvalue()
    if ARCHIVE.exists():
        assert ARCHIVE.read_bytes() == archive, "REBUILD_DIFFERS_FROM_REVIEWED_ARCHIVE"
    else:
        ARCHIVE.write_bytes(archive)
    print(json.dumps({"archive": str(ARCHIVE.relative_to(ROOT)), "sha256": hashlib.sha256(archive).hexdigest(),
                      "files": len(contents), "upstream": UPSTREAM, "patchedParserFiles": 3}))
