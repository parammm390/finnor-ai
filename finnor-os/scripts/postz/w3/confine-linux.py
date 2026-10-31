#!/usr/bin/env python3
"""Process-local development custody. Not protected evaluation or admission.

Rules are a complement of explicit donor subtrees, never a broad parent allow
that would reopen a donor. All available ABI-2 filesystem rights are handled.
Stat/chdir and other unmediated ABI-2 operations are not confidentiality claims.
The ruleset and NO_NEW_PRIVS survive exec and every descendant.
"""
import ctypes
import errno
import hashlib
import json
import os
import pathlib
import platform
import resource
import stat
import subprocess
import sys
import time


def require(condition, predicate):
    if not condition:
        raise RuntimeError(predicate)


require(sys.platform == "linux" and platform.machine() in ("x86_64", "aarch64"),
        "W3_LINUX_LANDLOCK_PLATFORM_REQUIRED")
require(len(sys.argv) == 2 and os.path.isabs(sys.argv[1]), "W3_ABSOLUTE_CONFINEMENT_CONFIG_REQUIRED")
with open(sys.argv[1], encoding="utf8") as stream:
    config = json.load(stream)
require(config["schema"] == "finnor.w3.linux-confinement.v1", "W3_CONFINEMENT_CONFIG_SCHEMA")
require(config["kind"] in ("CONTROLS_ONLY", "INSTALLED_NATIVE", "SCIENTIFIC_CLOSURE"),
        "W3_CONFINEMENT_KIND_REQUIRED")
output = pathlib.Path(config["output"])
require(output.is_absolute() and not output.exists(), "W3_NEW_CONFINEMENT_OUTPUT_REQUIRED")
output.mkdir(mode=0o700)
node = pathlib.Path(config["node"]).resolve(strict=True)
require(node.is_file(), "W3_CONFINEMENT_NODE_REQUIRED")
denied = []
probes = []
for entry in config["denied"]:
    root = pathlib.Path(entry["root"]).resolve(strict=True)
    probe = pathlib.Path(entry["probe"]).absolute()
    require(root != pathlib.Path("/") and len(root.parts) >= 4, "W3_SCOPED_DONOR_PREFIX_REQUIRED")
    require(probe.resolve(strict=True).is_relative_to(root), "W3_PROBE_INSIDE_DENIED_DONOR_REQUIRED")
    with open(probe, "rb") as stream:
        require(len(stream.read(1)) == 1, "W3_NONEMPTY_READABLE_DONOR_CONTROL_REQUIRED")
    denied.append(root)
    probes.append(probe)
require(1 <= len(denied) <= 32 and len(set(denied)) == len(denied), "W3_DONOR_PREFIX_BOUND")
require(not any(output.resolve().is_relative_to(root) or node.is_relative_to(root) for root in denied),
        "W3_CONFINEMENT_CONTROL_MUST_BE_OUTSIDE_DONOR")
descriptor = None
installation = None
if config["kind"] != "CONTROLS_ONLY":
    installation = pathlib.Path(config["installation"]).resolve(strict=True)
    require(not any(installation.is_relative_to(root) for root in denied), "W3_INSTALLATION_OUTSIDE_DONOR_REQUIRED")
    descriptor = installation / "finnor-os/w3-development-installation.json"
    descriptor_digest = hashlib.sha256(descriptor.read_bytes()).hexdigest()
    require(descriptor_digest == config["descriptorSha256"], "W3_CONFINEMENT_DESCRIPTOR_PIN_CHANGED")
    body = json.loads(descriptor.read_bytes())
    require(body["schema"] == "finnor.w3.development-installation.v1" and body["productionActive"] is False,
            "W3_DEVELOPMENT_ONLY_INSTALLATION_REQUIRED")
    command = config["command"]
    require(command[0] == str(node) and os.path.isabs(config["cwd"])
            and pathlib.Path(config["cwd"]).resolve().is_relative_to(installation),
            "W3_INSTALLED_COMMAND_AND_CWD_REQUIRED")
else:
    command = [str(node), "--eval", 'console.log(JSON.stringify({event:"W3_CONFINEMENT_CONTROLS_ONLY_COMPLETE",pid:process.pid}))']

libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
libc.prctl.restype = ctypes.c_int


def syscall(number, *args):
    result = libc.syscall(ctypes.c_long(number), *args)
    if result < 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))
    return result


abi = syscall(444, ctypes.c_void_p(), ctypes.c_size_t(0), ctypes.c_uint(1))
require(abi >= 2, "W3_LANDLOCK_ABI_2_REQUIRED_NO_UNCONFINED_FALLBACK")
handled = (1 << 14) - 1


class Ruleset(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


class Beneath(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]


attr = Ruleset(handled)
ruleset = syscall(444, ctypes.byref(attr), ctypes.c_size_t(ctypes.sizeof(attr)), ctypes.c_uint(0))
allow = set()


def complement(path):
    actual = path.resolve(strict=True)
    if any(actual.is_relative_to(root) for root in denied):
        return
    if any(root.is_relative_to(actual) for root in denied):
        require(actual.is_dir(), "W3_DONOR_ANCESTOR_DIRECTORY_REQUIRED")
        for entry in actual.iterdir():
            # Never grant through a symlink to a denied path or its ancestor.
            # Its real target is independently handled by the same recursion.
            if not entry.is_symlink():
                complement(entry)
        return
    allow.add(actual)


complement(pathlib.Path("/"))
require(1 <= len(allow) <= 4096, "W3_CONFINEMENT_RULE_BOUND")
for path in sorted(allow):
    fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
    try:
        rights = handled if stat.S_ISDIR(os.fstat(fd).st_mode) else (1 << 0) | (1 << 1) | (1 << 2)
        rule = Beneath(rights, fd)
        syscall(445, ctypes.c_int(ruleset), ctypes.c_int(1), ctypes.byref(rule), ctypes.c_uint(0))
    finally:
        os.close(fd)

control = output / "read-control"
control.write_bytes(b"owned-positive-control\n")
aliases = []
for index, probe in enumerate(probes):
    alias = output / ("donor-alias-" + str(index))
    alias.symlink_to(probe)
    aliases.append(alias)
os.chdir(config.get("cwd", str(output)))
require(libc.prctl(38, 1, 0, 0, 0) == 0, "W3_NO_NEW_PRIVS_FAILED")
syscall(446, ctypes.c_int(ruleset), ctypes.c_uint(0))
os.close(ruleset)
# No pre-open donor fd can cross the exec boundary, including arbitrary fds
# inherited by this launcher. Standard streams are the supervised pipes only.
fd_limit = resource.getrlimit(resource.RLIMIT_NOFILE)[0]
require(0 < fd_limit <= 2 ** 24, "W3_FINITE_DESCRIPTOR_CLOSE_BOUND_REQUIRED")
os.closerange(3, fd_limit)
require(control.read_bytes() == b"owned-positive-control\n", "W3_CONFINED_READ_POSITIVE_CONTROL_FAILED")
denials = []
for probe, alias in zip(probes, aliases):
    for kind, path in (("direct", probe), ("symlink", alias),
                       ("procfs", pathlib.Path("/proc/self/root") / str(probe).lstrip("/"))):
        try:
            fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
        except OSError as error:
            require(error.errno in (errno.EACCES, errno.EPERM), "W3_DONOR_REFUSED_FOR_UNRELATED_REASON")
            denials.append({"kind": kind, "path": str(path), "errno": error.errno})
        else:
            os.close(fd)
            raise RuntimeError("W3_DONOR_READ_NOT_CONFINED:" + str(path))

# A new Node process must inherit the same denial, not just the Python process.
child_code = r"""
const fs=require("node:fs"),a=JSON.parse(process.argv[1]);
for(const path of a.probes) {
  try { fs.readFileSync(path); throw Error("W3_CHILD_DONOR_READ_NOT_CONFINED"); }
  catch(e) { if(!["EACCES","EPERM"].includes(e.code)) throw e; }
}
if(fs.readFileSync(a.control,"utf8")!=="owned-positive-control\n") throw Error("W3_CHILD_READ_CONTROL_FAILED");
console.log(JSON.stringify({pid:process.pid,ppid:process.ppid,denied:a.probes.length,positiveRead:true}));
"""
child = subprocess.run([str(node), "--eval", child_code,
                        json.dumps({"probes": [str(p) for p in probes + aliases], "control": str(control)})],
                       cwd=output, check=True, capture_output=True, text=True, timeout=10)
child_receipt = json.loads(child.stdout)
require(child_receipt["denied"] == len(probes) * 2 and child_receipt["positiveRead"] is True,
        "W3_INHERITED_CONFINEMENT_CONTROL_FAILED")
if descriptor:
    require(hashlib.sha256(descriptor.read_bytes()).hexdigest() == descriptor_digest,
            "W3_CONFINED_DESCRIPTOR_UNREADABLE_OR_CHANGED")
receipt = {"schema": "finnor.w3.linux-confinement-receipt.v1", "kind": config["kind"],
           "pid": os.getpid(), "at": time.time(), "landlockAbi": abi, "handledFilesystemRights": handled,
           "deniedRoots": [str(p) for p in denied], "allowedRoots": [str(p) for p in sorted(allow)],
           "denials": denials, "inheritedChild": child_receipt, "nonstandardInheritedFdsClosed": True,
           "positiveRead": True, "positiveExec": True, "unconfinedFallback": False,
           "descriptorSha256": config.get("descriptorSha256"), "protectedQualification": False,
           "productionActive": False, "limits": ["ABI2 does not mediate stat/chdir/chmod or network.",
                                               "Declared host executable/shared libraries remain available."]}
(output / "confinement.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf8")
for alias in aliases:
    alias.unlink()
control.unlink()
print(json.dumps({"event": "W3_LINUX_CONFINEMENT_READY", "kind": config["kind"], "pid": os.getpid(),
                  "abi": abi, "deniedOpenControls": len(denials), "inheritedChild": child_receipt}), flush=True)
environment = os.environ.copy()
for key in ("PYTHONHOME", "PYTHONPATH", "NODE_PATH"):
    environment.pop(key, None)
os.execve(str(node), command, environment)
