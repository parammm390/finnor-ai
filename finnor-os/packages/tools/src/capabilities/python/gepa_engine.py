"""Actual GEPA optimizer. FINNOR owns evaluation/model calls in a scoped broker."""
import contextlib
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import sys
import time
import urllib.request
import urllib.parse


def run(payload):
    from gepa import optimize
    from gepa.core.adapter import EvaluationBatch
    url = urllib.parse.urlparse(payload["brokerUrl"])
    if url.scheme != "http" or url.hostname != "127.0.0.1" or url.username or url.password:
        raise ValueError("GEPA_BROKER_ENDPOINT_INVALID")
    token, deadline = payload["brokerToken"], payload["deadlineAt"]
    calls = 0
    def broker(operation, body):
        nonlocal calls
        calls += 1
        if calls > payload["maxMetricCalls"] * 4 + 16:
            raise ValueError("GEPA_BROKER_CALL_LIMIT")
        remaining = (deadline - time.time() * 1000) / 1000
        if remaining <= 0:
            raise ValueError("GEPA_DEADLINE_EXCEEDED")
        request = urllib.request.Request(payload["brokerUrl"] + "/" + operation, data=json.dumps(body, allow_nan=False).encode(),
            headers={"authorization": "Bearer " + token, "content-type": "application/json"}, method="POST")
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=min(120, remaining)) as response:
            raw = response.read(1048577)
            if len(raw) > 1048576:
                raise ValueError("GEPA_BROKER_RESPONSE_TOO_LARGE")
            return json.loads(raw)

    class Adapter:
        def evaluate(self, batch, candidate, capture_traces=False):
            observed = broker("evaluate", {"candidate": candidate, "taskIds": batch})
            if len(observed["scores"]) != len(batch) or not all(isinstance(score, (float, int)) and math.isfinite(score) and 0 <= score <= 1 for score in observed["scores"]):
                raise ValueError("GEPA_EVALUATION_CONTRACT_INVALID")
            return EvaluationBatch(outputs=observed["outputs"], scores=observed["scores"], trajectories=observed["trajectories"] if capture_traces else None)
        def make_reflective_dataset(self, candidate, eval_batch, components_to_update):
            return {component: eval_batch.trajectories for component in components_to_update}
        def propose_new_texts(self, candidate, reflective_dataset, components_to_update):
            return broker("propose", {"candidate": candidate, "feedback": reflective_dataset, "components": components_to_update})["candidate"]

    result = optimize(seed_candidate={"instruction": payload["seedInstruction"]}, trainset=payload["trainIds"], valset=payload["validationIds"], adapter=Adapter(),
        max_metric_calls=payload["maxMetricCalls"], reflection_minibatch_size=min(3, len(payload["trainIds"])),
        candidate_selection_strategy="current_best", use_merge=False, max_merge_invocations=0, skip_perfect_score=True, seed=payload["seed"],
        stop_callbacks=lambda _: time.time() * 1000 >= deadline - 2000, display_progress_bar=False, use_wandb=False, use_mlflow=False,
        track_best_outputs=False, use_cloudpickle=False, raise_on_exception=True)
    return {"schema": "finnor.gepa-optimizer-result.v1", "bestCandidate": result.best_candidate, "bestIndex": result.best_idx,
        "candidates": result.candidates, "parents": result.parents, "validationScores": result.val_aggregate_scores,
        "totalMetricCalls": result.total_metric_calls, "brokerCalls": calls, "backend": {"name": "gepa", "version": importlib.metadata.version("gepa")},
        "qualification": "OPTIMIZER_CANDIDATE_ONLY_FINNOR_MUST_REPLAY_HOLDOUT"}


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.buffer.read(16_777_217))
        with contextlib.redirect_stdout(sys.stderr):
            result = run(request)
        print(json.dumps({"ok": True, "sourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "result": result}, allow_nan=False, separators=(",", ":")))
    except ModuleNotFoundError:
        print(json.dumps({"ok": False, "code": "GEPA_DEPENDENCY_UNAVAILABLE"}))
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and str(error).startswith("GEPA_") else "GEPA_OPTIMIZATION_FAILED"
        print(json.dumps({"ok": False, "code": code}))
