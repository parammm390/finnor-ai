"""Install only pinned official components into an exclusively owned prefix."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request

VERSION = "1.92.0"
TARGET = "x86_64-unknown-linux-gnu"
BASE = "https://static.rust-lang.org/dist/"


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--prefix", type=Path, required=True)
    a = p.parse_args()
    prefix = a.prefix
    if not prefix.is_absolute() or prefix.exists():
        raise ValueError("A new absolute owned prefix is required")
    prefix.mkdir(mode=0o700, parents=True)
    pins = json.loads((Path(__file__).resolve().parent/"toolchain-pins.json").read_text())["rust"]
    if pins["version"] != VERSION or pins["target"] != TARGET:
        raise ValueError("declared Rust toolchain pin mismatch")
    pinned = {item["component"]: item for item in pins["components"]}
    receipt = []
    for component in ("rustc", "rust-std", "cargo"):
        name = f"{component}-{VERSION}-{TARGET}"
        archive = prefix / f"{name}.tar.xz"
        url = BASE + archive.name
        with urllib.request.urlopen(url + ".sha256", timeout=60) as r:
            expected = r.read(4096).decode().split()[0]
        if pinned[component]["url"] != url or pinned[component]["sha256"] != expected:
            raise ValueError("official checksum does not match the sealed component pin")
        with urllib.request.urlopen(url, timeout=180) as r, archive.open("xb") as w:
            count = 0
            while chunk := r.read(1024*1024):
                count += len(chunk)
                if count > 256*1024*1024: raise ValueError("component byte bound")
                w.write(chunk)
        actual = hashlib.sha256(archive.read_bytes()).hexdigest()
        if actual != expected: raise ValueError("official component hash mismatch")
        with tarfile.open(archive) as t:
            t.extractall(prefix, filter="data")
        subprocess.run([str(prefix/name/"install.sh"), "--disable-ldconfig",
                        "--prefix="+str(prefix/"installed")], check=True,
                       cwd=prefix, timeout=180)
        receipt.append({"component": component, "url": url, "sha256": actual, "bytes": count})
        shutil.rmtree(prefix/name)
    body = {"version": VERSION, "target": TARGET, "components": receipt}
    (prefix/"receipt.json").write_text(json.dumps(body, indent=2)+"\n")
    print(json.dumps(body))


if __name__ == "__main__": main()
