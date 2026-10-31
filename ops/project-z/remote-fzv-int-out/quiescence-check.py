#!/usr/bin/env python3
"""Exit 0 when no process of this uid holds a stack port, a connection to the shared database, or is a stock worker.

Exit 76 with a JSON report otherwise. Used by run.sh before a job that holds the stack lock, because a worker left behind by
an earlier run reconnects to the next run's database (fixed port) and claims its jobs. The platform's root-owned socat
mirrors have no visible owner for a non-root user and are ignored.

With --reap, an orphaned stock worker (parent pid 1, this uid, working directory under the pipeline's repositories) and its
children are terminated after an audit record is written. By lock discipline no stack run can be live when this runs, so such
a worker can only be a leak from an earlier run. Nothing else is ever signalled; any other holder only produces the refusal."""
import json, os, re, signal, subprocess, sys, time

PORTS = {int(x) for x in os.environ.get("QUIESCENCE_PORTS", "3001,3101,54321,54322,55441").split(",")}
uid = os.getuid()
ancestors, pid = set(), os.getpid()
while pid > 1:
    ancestors.add(pid)
    try:
        pid = int(open(f"/proc/{pid}/stat").read().rsplit(") ", 1)[1].split()[1])
    except Exception:
        break

def describe(p):
    try:
        cmd = open(f"/proc/{p}/cmdline", "rb").read().replace(b"\0", b" ").decode(errors="replace").strip()[:200]
        return {"pid": p, "ppid": int(open(f"/proc/{p}/stat").read().rsplit(") ", 1)[1].split()[1]),
                "cwd": os.readlink(f"/proc/{p}/cwd"), "cmd": cmd}
    except Exception:
        return {"pid": p}

def scan():
    hits = {}
    rows = subprocess.run(["ss", "-H", "-tanp"], capture_output=True, text=True).stdout.splitlines()
    for row in rows:
        parts = row.split()
        if len(parts) < 5:
            continue
        state, local, peer = parts[0], parts[3], parts[4]
        owners = [int(x) for x in re.findall(r"pid=(\d+)", row)]
        if not owners:
            continue
        lport, pport = local.rsplit(":", 1)[1], peer.rsplit(":", 1)[1]
        ports = {int(x) for x in (lport, pport) if x.isdigit()} & PORTS
        if not ports:
            continue
        for owner in owners:
            if owner in ancestors:
                continue
            item = hits.setdefault(owner, {**describe(owner), "why": []})
            item["why"].append(f"{state} {local} -> {peer}")
    for d in os.listdir("/proc"):
        if not d.isdigit() or int(d) in ancestors:
            continue
        try:
            if os.stat(f"/proc/{d}").st_uid != uid:
                continue
            argv = open(f"/proc/{d}/cmdline", "rb").read().decode(errors="replace").split("\0")
        except Exception:
            continue
        # A node process whose own argument is the worker entry, not a shell or editor that merely mentions the path.
        if argv and os.path.basename(argv[0]) == "node" and any(a.endswith("apps/worker/src/index.ts") and not a.startswith("-") for a in argv[1:]):
            item = hits.setdefault(int(d), {**describe(int(d)), "why": []})
            item["why"].append("stock worker process")

    return hits

AUDIT = "/home/factory-user/repos/fzv-int-out/coordinator/audit"
REPOS = "/home/factory-user/repos"

def reap(hits):
    reaped = []
    for pid, item in list(hits.items()):
        if "stock worker process" not in item.get("why", []) or item.get("ppid") != 1 or not str(item.get("cwd", "")).startswith(REPOS + "/"):
            continue
        children = [int(d) for d in os.listdir("/proc") if d.isdigit() and describe(int(d)).get("ppid") == pid]
        os.makedirs(AUDIT, exist_ok=True)
        record = {"schema": "finnor.queue.reaped-orphan-worker.v1", "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                  "holder": item, "children": [describe(c) for c in children]}
        with open(f"{AUDIT}/reaped-{int(time.time())}-{pid}.json", "w") as handle:
            json.dump(record, handle)
        for target in [pid] + children:
            try:
                os.kill(target, signal.SIGTERM)
            except ProcessLookupError:
                pass
        for _ in range(10):
            time.sleep(1)
            if not any(os.path.exists(f"/proc/{t}") for t in [pid] + children):
                break
        for target in [pid] + children:
            if os.path.exists(f"/proc/{target}"):
                try:
                    os.kill(target, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        reaped.append(pid)
    return reaped

hits = scan()
reaped = reap(hits) if hits and "--reap" in sys.argv else []
if reaped:
    time.sleep(1)
    hits = scan()
print(json.dumps({"schema": "finnor.queue.quiescence-check.v1", "uid": uid, "reapedOrphanStockWorkers": reaped, "holders": list(hits.values())}))
sys.exit(76 if hits else 0)
