"""Bounded pinned native rebuild and source/binary identity, no DB or listeners."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import uuid

BACKEND = "nova-01b1e2d662a847ed7029770ecbaf6687398899dd-0.76.0"
PROFILE = "Z4_I32_I64_PALLAS_VESTA_IPA_V1"


def digest(b): return hashlib.sha256(b).hexdigest()
def canonical(v): return json.dumps(v, sort_keys=True, separators=(",", ":")).encode()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--native", type=Path, required=True)
    p.add_argument("--rust-prefix", type=Path, required=True)
    p.add_argument("--evidence", type=Path, required=True)
    p.add_argument("--initialize-lock", action="store_true")
    a = p.parse_args()
    if not all(x.is_absolute() for x in (a.native, a.rust_prefix, a.evidence)):
        raise ValueError("absolute paths required")
    a.evidence.mkdir(parents=True, exist_ok=False)
    env = {"PATH": str(a.rust_prefix/"bin")+":/usr/bin:/bin", "HOME": str(a.native/".cargo-home"),
           "CARGO_HOME": str(a.native/".cargo-home"), "CARGO_BUILD_JOBS": "2",
           "CARGO_NET_RETRY": "1", "RAYON_NUM_THREADS": "2",
           "RUSTFLAGS": "--remap-path-prefix="+str(a.native)+"=/finnor-z4-native"}
    steps = []
    def run(name, args):
        start = time.monotonic()
        with (a.evidence/(name+".log")).open("xb") as f:
            r = subprocess.run(args, cwd=a.native, env=env, stdout=f,
                               stderr=subprocess.STDOUT, timeout=1200)
        steps.append({"step": name, "exit": r.returncode, "wallMs": round((time.monotonic()-start)*1000)})
        (a.evidence/"steps.json").write_text(json.dumps(steps, indent=2)+"\n")
        if r.returncode: raise RuntimeError(name+" failed; original log retained")
    run("rustc-version", ["rustc", "--version", "--verbose"])
    run("cargo-version", ["cargo", "--version"])
    if a.initialize_lock:
        if (a.native/"Cargo.lock").exists(): raise ValueError("lock already exists")
        run("resolve-lock", ["cargo", "generate-lockfile"])
    run("build-locked", ["cargo", "build", "--locked", "--release", "--bin", "finnor-z4-execution-proof", "--manifest-path", str(a.native/"Cargo.toml")])
    run("build-field-falsifier", ["cargo", "build", "--locked", "--release", "--bin", "z4-field-falsifier", "--manifest-path", str(a.native/"Cargo.toml")])
    source = []
    for rel in sorted(["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "supervise.py"] +
                      [str(x.relative_to(a.native)) for x in (a.native/"src").glob("*.rs")]):
        source.append({"path": rel, "sha256": digest((a.native/rel).read_bytes())})
    destination = a.native/"bin"/"z4-proof"
    destination.parent.mkdir(mode=0o700, exist_ok=True)
    def install(source, target):
        temporary = target.with_name("."+target.name+"."+uuid.uuid4().hex)
        try:
            with temporary.open("xb") as output:
                output.write(source.read_bytes())
                output.flush()
                os.fsync(output.fileno())
                os.fchmod(output.fileno(), 0o500)
            temporary.replace(target)
        finally:
            if temporary.exists(): temporary.unlink()
    install(a.native/"target"/"release"/"finnor-z4-execution-proof", destination)
    diagnostic = a.native/"bin"/"z4-field-falsifier"
    install(a.native/"target"/"release"/"z4-field-falsifier", diagnostic)
    rust = subprocess.run(["rustc", "--version"], env=env, capture_output=True, text=True, check=True).stdout.strip()
    binary = destination.read_bytes()
    identity = {"schema": "finnor.z4.native-build.v1", "profile": PROFILE, "backend": BACKEND,
                "binarySha256": digest(binary), "binaryBytes": len(binary), "sourceFiles": source,
                "sourceDigest": digest(canonical(source)), "cargoLockSha256": digest((a.native/"Cargo.lock").read_bytes()),
                "rustc": rust, "target": "x86_64-unknown-linux-gnu",
                "diagnosticBinarySha256": digest(diagnostic.read_bytes())}
    (a.native/"build-identity.json").write_text(json.dumps(identity, indent=2)+"\n")
    (a.evidence/"identity.json").write_text(json.dumps(identity, indent=2)+"\n")
    print(json.dumps({"status": "BUILT", "identity": identity, "steps": steps}))


if __name__ == "__main__": main()
