"""Shinka's trusted evaluator: read candidate bytes; never import or run them."""
import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import signal
import sys
import time
import urllib.request
import urllib.parse

parser = argparse.ArgumentParser()
parser.add_argument("--program_path", required=True)
parser.add_argument("--results_dir", required=True)
args = parser.parse_args()
deadline = float(os.environ["FINNOR_SHINKA_DEADLINE"])
remaining = deadline / 1000 - time.time()
if remaining <= 0:
    raise SystemExit(124)
signal.setitimer(signal.ITIMER_REAL, remaining)
if sys.platform == "linux" and (ctypes.CDLL(None).prctl(1, signal.SIGKILL) != 0 or os.getppid() == 1):
    raise SystemExit(125)
url = os.environ["FINNOR_SHINKA_BROKER"]
parsed = urllib.parse.urlparse(url)
if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.username or parsed.password:
    raise SystemExit("SHINKA_BROKER_ENDPOINT_INVALID")
code = Path(args.program_path).read_bytes()
if len(code) > 100_000:
    raise SystemExit("SHINKA_CANDIDATE_SIZE_LIMIT")
request = urllib.request.Request(url + "/evaluate", data=json.dumps({"code": code.decode(), "sha256": hashlib.sha256(code).hexdigest()}).encode(),
    method="POST", headers={"content-type": "application/json", "authorization": "Bearer " + os.environ["FINNOR_SHINKA_BROKER_TOKEN"]})
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
    with opener.open(request, timeout=min(120, remaining)) as response:
        data = response.read(262145)
        if len(data) > 262144:
            raise ValueError("SHINKA_EVALUATION_RESPONSE_LIMIT")
        observed = json.loads(data)
except Exception:
    observed = {"correct": False, "score": 0, "feedback": "FINNOR_EVALUATION_FAILED_NO_SCORE_AUTHORITY_GRANTED"}
directory = Path(args.results_dir)
directory.mkdir(parents=True, exist_ok=True)
(directory / "correct.json").write_text(json.dumps({"correct": observed["correct"], "error": None if observed["correct"] else observed.get("feedback")}))
(directory / "metrics.json").write_text(json.dumps({"combined_score": observed["score"], "public": {"feedback": observed.get("feedback", "")}, "private": {"candidateSha256": hashlib.sha256(code).hexdigest()}}, allow_nan=False))
